import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isReadOnlyCommand } from "@agency/guard";
import { t } from "@agency/i18n";
import { AgencyError, ErrorCode } from "@agency/schema";
import { asContainerExecBackend, type SandboxWithExec } from "../container-exec.ts";
import type { ToolContext, ToolDeps, ToolResult, ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import { str, summarize } from "../render.ts";
import { CWD_MARKER, EXIT_MARKER, modelCommandEnv, parseShellOutput, type ShellConfig } from "../shell.ts";
import { compactOutput, truncateWithSpill } from "../truncate.ts";
import { trackJob } from "../win-job.ts";

/**
 * Byte cap for a single bash result. The session-wide caps in
 * core/src/truncate.ts count UTF-8 bytes, so this does too: a result's
 * context cost is its byte length, not its character count. (Stated
 * explicitly, unlike the undocumented limit this mirrors.)
 */
const MAX_OUTPUT_BYTES = 30_000;

/**
 * Grace period for the in-flight output reads to settle after the abort
 * kill before the abort path gives up on them: a descendant that somehow
 * survives while holding the pipe open must not hang the tool past
 * cancellation.
 */
const ABORT_DRAIN_MS = 1_000;

/** A command with no timeout that runs longer moves to the background, so a server in the foreground cannot hold the turn. */
const DETACH_MS = 120_000;

export const BASH_SANDBOX_NOTE =
  " Commands run in a sandbox with no network. Pass network: true only for a command that needs it (an install, a fetch): the user is asked first.";
/** In place of the sandbox note under allow-all, where a command runs on the host. */
export const BASH_HOST_NOTE = " Commands run with the user's rights and have the network.";

/** How often a long-running foreground command emits a progress notice. */
const PROGRESS_TICK_MS = 2_000;

/**
 * Flush window between the graceful SIGTERM of the process tree and the
 * SIGKILL of the direct shell on POSIX. TERM'd descendants need a moment to
 * flush userspace stdio buffers into the pipe and exit so the pipes close and
 * the in-flight reads settle with the partial output; the SIGKILL that
 * follows then guarantees the wrapper tail (exit-code/cwd markers) can never
 * run to a clean exit 0.
 */
const POSIX_KILL_FLUSH_MS = 250;

/** A `pkill -f` pattern that Agency's own command line contains (a -p prompt names the task's files) ends this run. */
export function selfKillPattern(command: string, ownCmdlines: readonly string[]): string | undefined {
  for (const [, args = ""] of command.matchAll(/\bpkill\b([^;&|\n]*)/g)) {
    const words = [...args.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
    if (!words.some((w) => w === "--full" || /^-[a-zA-Z]*f/.test(w))) continue;
    const pattern = words.find((w) => !w.startsWith("-"));
    if (pattern === undefined) continue;
    let matches: (line: string) => boolean;
    try {
      const re = new RegExp(pattern);
      matches = (line) => re.test(line);
    } catch {
      matches = (line) => line.includes(pattern);
    }
    if (ownCmdlines.some(matches)) return pattern;
  }
  return undefined;
}

/** Agency's command line and its parents' (a `bash -c` wrapper repeats the prompt); argv alone off Linux. */
function ownCommandLines(): string[] {
  const lines = [process.argv.join(" ")];
  try {
    let pid = process.pid;
    for (let i = 0; i < 8 && pid > 1; i++) {
      lines.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "));
      pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[1]);
    }
  } catch {}
  return lines;
}

export interface BashState {
  cwd: string;
}

/**
 * Caps a bash result the way `truncateOutput` caps session-wide results in
 * core/src/truncate.ts: head kept, cut at a character boundary,
 * machine-readable notice appended — and the overflow spilled to a temp file
 * so nothing is silently dropped.
 */
function truncateResult(content: string): string {
  return truncateWithSpill(content, MAX_OUTPUT_BYTES, {
    truncated: (path) => t("tool.bash.truncated", { bytes: MAX_OUTPUT_BYTES, path }),
    truncatedNoSpill: t("tool.bash.truncated_no_spill", { bytes: MAX_OUTPUT_BYTES }),
  });
}

/**
 * Container branch of the bash handler. The backend owns cwd translation
 * (host paths in, mount paths on the docker CLI) and the kill; this side
 * only coerces the settled output through the shared finish so labels and
 * the cwd/error contract match the software path exactly.
 */
async function runContainerExec(
  backend: SandboxWithExec,
  argv: string[],
  cwd: string,
  ctx: ToolContext,
  timeout: number | undefined,
  finish: (
    outcome: { aborted: boolean; stdout: string; stderr: string },
    timedOut: boolean,
    normalizeCwd?: (cwd: string) => string,
  ) => ToolResult,
  network = false,
): Promise<ToolResult> {
  let abortFired = false;
  const onAbort = (): void => {
    abortFired = true;
  };
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener("abort", onAbort);

  const startedAt = Date.now();
  const progressTimer = ctx.onProgress
    ? setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        ctx.onProgress?.(`still running (${seconds}s)`);
      }, PROGRESS_TICK_MS)
    : undefined;

  try {
    // Marker paths printed inside the container live under the mount, so
    // they map back before the shared sandbox-bound check. Best-effort by
    // design: markerless output (aborts) and escapes fall through to the
    // resolvePath verdict below, which stays the containment authority.
    const toHost = (cwd: string): string => {
      try {
        return backend.toHostPath?.(cwd) ?? cwd;
      } catch {
        return cwd;
      }
    };
    let execResult: { stdout: string; stderr: string; exitCode: number };
    try {
      execResult = await backend.exec(argv, {
        cwd,
        timeoutMs: timeout,
        signal: ctx.signal,
        env: { ...modelCommandEnv(), ...ctx.env },
        ...(network ? { network } : {}),
      });
    } catch (e) {
      if (e instanceof AgencyError && e.code === ErrorCode.INTERNAL && e.context.timedOut === true) {
        const partial = (value: unknown): string => (typeof value === "string" ? value : "");
        return finish(
          { aborted: true, stdout: partial(e.context.stdout), stderr: partial(e.context.stderr) },
          true,
          toHost,
        );
      }
      throw e;
    }
    // Abort intent wins over a simultaneous clean exit, same coercion as local.
    if (abortFired) {
      return finish({ aborted: true, stdout: execResult.stdout, stderr: execResult.stderr }, false, toHost);
    }
    const completed = finish(
      { aborted: false, stdout: execResult.stdout, stderr: execResult.stderr },
      false,
      toHost,
    );
    // Docker-level failures print no shell markers, so the marker exit reads
    // 0; the exec exit is the only signal and must fail closed, never silent.
    if (
      execResult.exitCode !== 0 &&
      (!execResult.stdout.includes(EXIT_MARKER) || !execResult.stdout.includes(CWD_MARKER))
    ) {
      const note = t("tool.bash.exit_code", { code: execResult.exitCode });
      const content = completed.content ? `${completed.content}\n${note}` : note;
      return { content: truncateResult(content), isError: true as const };
    }
    return completed;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    if (progressTimer !== undefined) clearInterval(progressTimer);
  }
}

export function createBashTool(
  deps: ToolDeps,
  shell: ShellConfig,
  state: BashState,
  processManager: ProcessManager,
  detachMs = DETACH_MS,
): ToolSpec {
  // Under an OS sandbox with no network, a command can ask for it: the user decides each time, as the escalation
  // of Codex and the unsandboxed retry of Claude Code. Else a command that needs the network has no way on.
  const offline = (deps.sandbox as { offline?: boolean }).offline === true;
  const spec: ToolSpec<{
    command: string;
    background?: boolean;
    timeout?: number;
    network?: boolean;
    cwd?: string;
    workdir?: string;
  }> = {
    name: "bash",
    description:
      `Runs a shell command in ${shell.label}. ` +
      (shell.posixSyntax
        ? ""
        : `Despite the tool's name, write commands in ${shell.label} syntax on this platform, not bash/POSIX syntax. `) +
      "Each command starts in the project root: a cd lasts for that command only, so write `cd dir && command`; " +
      "environment variables do not persist either. Pass background: true for " +
      // Live: a model started a server that the task needed after the run with background: true, which stops it.
      "long-running processes (dev servers, watchers) instead of waiting for them to exit; they stop when the " +
      "session ends, so start one that must outlive it with `nohup ... &`. " +
      // Live (Terminal-Bench): a model stopped a long search as too slow, another waited with `sleep 110` loops.
      "To wait for long work (a build, a test suite, a big query, a search), pass timeout in milliseconds, up to " +
      "600000: the command stays in the foreground until it ends or the timeout kills it. A command with no timeout " +
      `that runs over ${Math.round(detachMs / 1000)} seconds moves to the background and keeps running; wait for ` +
      "one with process_output and wait, not with sleep loops." +
      (offline ? BASH_SANDBOX_NOTE : ""),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean" },
        timeout: { type: "number", description: "Kill the command after this many milliseconds." },
        ...(offline
          ? {
              network: {
                type: "boolean",
                description: "Run this command with the network. The user is asked each time.",
              },
            }
          : {}),
      },
      required: ["command"],
    },
    riskTier: "dangerous",
    readOnly: (input) => !input.background && isReadOnlyCommand(input.command),
    renderCall: (input) => `bash ${summarize(str(input.command))}`,
    renderResult: (result) =>
      result.isError
        ? `bash failed: ${summarize(result.content)}`
        : `bash: ${summarize(result.content) || "(no output)"}`,

    async handler(input, ctx) {
      deps.sandbox.checkCommand(input.command);
      const killer = /\bpkill\b/.test(input.command)
        ? selfKillPattern(input.command, ownCommandLines())
        : undefined;
      if (killer !== undefined)
        return { content: t("tool.bash.self_kill", { pattern: killer }), isError: true as const };
      // Models name the folder of a command unasked, as Codex has them do: it runs there, in the workspace only.
      const named = str(input.workdir) || str(input.cwd);
      const cwd = named
        ? deps.sandbox.resolvePath(isAbsolute(named) ? named : join(state.cwd, named))
        : state.cwd;
      const network = offline && input.network === true;
      if (network) {
        // Asked in every mode, as a rule or a mode allows the command and not its way out of the sandbox.
        const answer = await ctx.requestApproval?.({
          tool: "bash",
          title: t("tool.bash.network_ask", { command: input.command }),
          command: input.command,
          riskTier: "dangerous",
          source: "sandbox:network",
        });
        if (answer !== "once" && answer !== "always") {
          return { content: t("tool.bash.network_refused"), isError: true as const };
        }
      }

      // The OS sandbox wraps a command that then runs on the host: the host path gives it the detach and the kill.
      // Under allow-all it runs unwrapped, as in Claude Code's bypass mode: live, `/tmp` did not last between commands.
      const wrapHeld = (
        deps.sandbox as {
          wrapHeld?: (
            argv: string[],
            cwd?: string,
            network?: boolean,
          ) => { argv: string[]; release: () => void; explain?: (output: string) => string[] };
        }
      ).wrapHeld;

      if (input.background) {
        const argv = [shell.command, ...shell.buildArgs(input.command)];
        // A backend that runs commands elsewhere must hold this one too: on the host it has the user's rights.
        if (wrapHeld === undefined && asContainerExecBackend(deps.sandbox) !== undefined) {
          return { content: t("tool.bash.background_refused"), isError: true as const };
        }
        const held = ctx.hostShell ? undefined : wrapHeld?.call(deps.sandbox, argv, cwd, network);
        let info: ReturnType<typeof processManager.spawn>;
        try {
          info = processManager.spawn(held?.argv ?? argv, {
            cwd,
            ...(ctx.env === undefined ? {} : { env: ctx.env }),
            ...(held === undefined ? {} : { onExit: held.release }),
          });
        } catch (error) {
          held?.release();
          throw error;
        }
        return { content: t("tool.bash.background_started", { id: info.id, pid: info.pid }) };
      }

      const wrapped = shell.wrapCommand(input.command);
      const argv = [shell.command, ...shell.buildArgs(wrapped)];

      const asked =
        typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
          ? input.timeout
          : undefined;
      // A wait past the end of the turn's time would leave the run with no answer at all.
      const left =
        ctx.deadlineAt === undefined ? undefined : Math.max(1_000, ctx.deadlineAt - Date.now() - 5_000);
      const timeout = asked !== undefined && left !== undefined && asked > left ? left : asked;

      // Shared result finishing for both backends: marker parse, the
      // sandbox bound on persisted cwd, and the stderr/exit/cancel labels.
      // normalizeCwd maps container marker paths back to host paths; the
      // software path passes identity, so its behavior is untouched.
      const finish = (
        outcome: { aborted: boolean; stdout: string; stderr: string; exitCode?: number },
        timedOut: boolean,
        normalizeCwd: (cwd: string) => string = (cwd) => cwd,
      ): ToolResult => {
        const parsed = parseShellOutput(outcome.stdout, cwd);
        const { output, cwd: markerCwd } = parsed;
        // `exit 3` or `set -e` ends the shell before the wrapper prints its marker; the process exit code is then the only signal.
        const exitCode = outcome.stdout.includes(EXIT_MARKER) ? parsed.exitCode : (outcome.exitCode ?? 0);
        // Every command starts in state.cwd, as each exec of Codex names its folder: models lost track of a cd
        // that persisted. The notice is for a command with a cd only: Git Bash reports its folder in the MSYS form.
        let cwdNotice: string | undefined;
        if (!outcome.aborted && /\b(cd|pushd)\b/.test(input.command)) {
          let moved = true;
          try {
            moved = deps.sandbox.resolvePath(normalizeCwd(markerCwd)) !== deps.sandbox.resolvePath(cwd);
          } catch {}
          if (moved) cwdNotice = `\n${t("tool.bash.cwd_reset")}`;
        }

        let combined = outcome.stderr
          ? `${compactOutput(output)}\n[stderr]\n${compactOutput(outcome.stderr)}`
          : compactOutput(output);
        if (cwdNotice) combined += cwdNotice;
        if (outcome.aborted) {
          // Cancellation must not read as a silent success with exit code 0.
          const notice = timedOut ? t("tool.bash.timeout", { ms: timeout ?? 0 }) : t("tool.bash.cancelled");
          combined = combined ? `${combined}\n${notice}` : notice;
        } else if (exitCode !== 0) {
          combined += `\n${t("tool.bash.exit_code", { code: exitCode })}`;
        }

        // Abort (user cancellation or timeout kill) and non-zero exit
        // surface as errors so callers react instead of continuing;
        // partial output is retained alongside the label.
        const failed = outcome.aborted || exitCode !== 0;
        return failed
          ? { content: truncateResult(combined), isError: true as const, meta: { exitCode } }
          : { content: truncateResult(combined), meta: { exitCode } };
      };

      const container = wrapHeld === undefined ? asContainerExecBackend(deps.sandbox) : undefined;
      if (container !== undefined) {
        return runContainerExec(container, argv, cwd, ctx, timeout, finish, network);
      }

      const held = ctx.hostShell ? undefined : wrapHeld?.call(deps.sandbox, argv, cwd, network);
      const proc = Bun.spawn(held?.argv ?? argv, {
        windowsHide: true,
        cwd,
        env: { ...modelCommandEnv(), ...ctx.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      trackJob(proc.pid, proc.exited);
      if (held !== undefined) void proc.exited.then(held.release, held.release);

      // Reads start immediately and stay in flight across the race below:
      // when the kill lands the pipes close and they settle with whatever
      // the process produced before it died, so an aborted call returns its
      // partial output instead of a fabricated empty success.
      const soFar = { stdout: "", stderr: "" };
      let forward: ((text: string) => void) | undefined;
      const collect = async (
        stream: ReadableStream<Uint8Array>,
        key: keyof typeof soFar,
      ): Promise<string> => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          const text = decoder.decode(chunk, { stream: true });
          soFar[key] += text;
          forward?.(text);
        }
        return soFar[key];
      };
      const stdoutText = collect(proc.stdout, "stdout");
      const stderrText = collect(proc.stderr, "stderr");

      const killTree = (): void => {
        // The foreground one-shot subprocess is not tracked by the
        // ProcessManager (its map holds processes meant to outlive a call),
        // but its tree-wide teardown is exactly what abort needs: shell
        // wrappers (macOS CI, `sh -c` chains) leave grandchildren that a
        // direct proc.kill(9) orphans and that then hold the output pipes
        // open. killTree is private on ProcessManager, so it is reached via
        // a cast; the guarded direct kill stays as the fallback either way.
        try {
          (processManager as unknown as { killTree(pid: number): void }).killTree(proc.pid);
        } catch {
          // private helper unreachable — the direct kill below still applies
        }
      };

      const killProc = async (): Promise<void> => {
        if (process.platform === "win32") {
          // The tree goes first: taskkill /T cannot find the children of a shell that is already dead.
          killTree();
          try {
            proc.kill(9);
          } catch {
            // already exited — nothing to reap
          }
          return;
        }
        // POSIX ordering: SIGTERM the tree FIRST, while the shell is still
        // alive and parent-child links are intact. SIGKILLing the shell first
        // reparents grandchildren to init, so the pgrep -P tree walk inside
        // killTree finds nothing; the orphaned `sleep` survives holding the
        // output pipes open, the in-flight reads never settle, the
        // ABORT_DRAIN_MS fallback resolves to empty strings, and the partial
        // output already in the pipe is lost. TERM first lets descendants
        // flush stdio into the pipe and exit so the reads settle with data;
        // the short flush window below gives them that moment, and the final
        // SIGKILL of the shell guarantees the wrapper tail (exit-code/cwd
        // markers) can never run on to a clean exit 0 after a grandchild
        // was TERM'd (which would win the completion race as an empty
        // success, without the [timeout]/[cancelled] label).
        killTree();
        try {
          proc.kill(15);
        } catch {
          // already exited — nothing to reap
        }
        await new Promise((resolve) => setTimeout(resolve, POSIX_KILL_FLUSH_MS));
        try {
          proc.kill(9);
        } catch {
          // already exited — nothing to reap
        }
      };

      // One listener does both abort jobs (tree kill + settling the race),
      // so cleanup is a single removeEventListener in the finally block and
      // the shared per-turn signal accumulates nothing across bash calls.
      let settleAborted: () => void = () => {};
      const abortSettled = new Promise<void>((resolve) => {
        settleAborted = resolve;
      });
      let timedOut = false;
      let abortFired = false;
      const onAbort = (): void => {
        abortFired = true;
        // Settle only after the kill sequence finishes: on POSIX that
        // includes the flush window, so the abort-branch reads below race
        // against closing pipes rather than against a shell that has not
        // been TERM'd yet.
        void killProc().then(settleAborted, settleAborted);
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort);

      const timeoutTimer =
        timeout !== undefined
          ? setTimeout(() => {
              timedOut = true;
              abortFired = true;
              void killProc().then(settleAborted, settleAborted);
            }, timeout)
          : undefined;
      let settleDetached: () => void = () => {};
      const detachSettled = new Promise<void>((resolve) => {
        settleDetached = resolve;
      });
      const detachTimer = timeout === undefined ? setTimeout(() => settleDetached(), detachMs) : undefined;

      const startedAt = Date.now();
      const progressTimer = ctx.onProgress
        ? setInterval(() => {
            const seconds = Math.round((Date.now() - startedAt) / 1000);
            ctx.onProgress?.(`still running (${seconds}s)`);
          }, PROGRESS_TICK_MS)
        : undefined;

      try {
        const settled = await Promise.race([
          detachSettled.then(() => "detached" as const),
          Promise.all([stdoutText, stderrText, proc.exited]).then(([stdout, stderr, exitCode]) => ({
            aborted: false as const,
            stdout,
            stderr,
            exitCode,
          })),
          abortSettled.then(async () => {
            // onAbort already killed the process tree; the dying processes
            // close the pipes and the in-flight reads settle with whatever
            // was captured before the kill.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const [stdout, stderr] = await Promise.race([
              Promise.all([stdoutText, stderrText]),
              new Promise<[string, string]>((resolve) => {
                timer = setTimeout(() => resolve(["", ""]), ABORT_DRAIN_MS);
              }),
            ]);
            clearTimeout(timer);
            return { aborted: true as const, stdout, stderr };
          }),
        ]);
        if (settled === "detached") {
          const id = processManager.take(proc, input.command, soFar.stdout + soFar.stderr);
          forward = (text) => processManager.append(id, text);
          const notice = t("tool.bash.detached", { seconds: Math.round(detachMs / 1000), id });
          const output = compactOutput(soFar.stdout + soFar.stderr);
          return {
            content: truncateResult(
              output
                ? `${output}
${notice}`
                : notice,
            ),
          };
        }
        let outcome: { aborted: boolean; stdout: string; stderr: string; exitCode?: number } = settled;
        const notes = held?.explain?.(`${outcome.stdout}\n${outcome.stderr}`) ?? [];
        if (notes.length > 0)
          outcome = { ...outcome, stderr: [outcome.stderr.trimEnd(), ...notes].filter(Boolean).join("\n") };
        // Abort intent wins over a simultaneous clean exit. On Linux the
        // killed shell's wrapper tail can beat SIGKILL to a marker-printed
        // exit 0 (or the abort signal can land just as the pipes close), so
        // the normal branch may win the race above even though onAbort ran.
        // Coercing here keeps the [timeout]/[cancelled] label and the
        // Phase 6 isError contract while retaining whatever partial output
        // the completed read captured.
        if (!outcome.aborted && (timedOut || abortFired)) {
          outcome = { aborted: true as const, stdout: outcome.stdout, stderr: outcome.stderr };
        }

        return finish(outcome, timedOut);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        if (progressTimer !== undefined) clearInterval(progressTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        clearTimeout(detachTimer);
      }
    },
  };
  return spec;
}
