import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { RequestApproval } from "./approval.ts";
import { startDomainProxy } from "./domain-proxy.ts";
import {
  type CommandPolicy,
  type ExternalDirectoryDecision,
  PROTECTED_PATHS,
  type SandboxBackend,
  SandboxBoundary,
  WORKTREES,
  worktreeProtectedPaths,
} from "./sandbox.ts";
import {
  APPCONTAINER_MODE,
  prepareScriptContainer,
  prepareWindowsSandbox,
  windowsSandboxHelper,
  windowsSandboxSid,
} from "./sandbox-win.ts";

export interface OsSandboxOptions {
  /** Commands get the network. Default: no network. */
  allowNetwork?: boolean;
  /** Commands reach only these hosts, through a proxy of the daemon. `allowNetwork` wins. Linux and macOS only. */
  allowedDomains?: string[];
  /** For tests: the platform, and the programs. */
  platform?: NodeJS.Platform;
  bwrapBin?: string;
  seatbeltBin?: string;
  /** The `windowsShell` of the config: Git Bash does not start under the restricted token of Windows. */
  windowsShell?: "powershell" | "gitbash" | "cmd";
  /**
   * Folders that a command must not read: the keys, sessions and daemon tokens of the harness. Linux and macOS only:
   * the token of Windows restricts writes, not reads.
   */
  hidden?: string[];
}

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/** The environment that sends the programs of a command to the proxy: an inherited NO_PROXY would skip it. */
function proxyEnv(url: string): Array<[string, string]> {
  return [...PROXY_VARS.map((name): [string, string] => [name, url]), ["NO_PROXY", ""], ["no_proxy", ""]];
}

const RELAY_PORT = 3128;
const RELAY_SOCKET = "/tmp/agency-proxy.sock";
/** In the network namespace of the sandbox: socat serves the Unix socket of the proxy on a port; the command waits for it. */
const RELAY_SCRIPT = `socat TCP-LISTEN:${RELAY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${RELAY_SOCKET} </dev/null >/dev/null 2>&1 &
i=0; while [ $i -lt 300 ] && ! grep -q ':${RELAY_PORT.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A' /proc/net/tcp; do sleep 0.01; i=$((i+1)); done
exec "$@"`;

/**
 * bubblewrap argv: the whole disk read-only, the workspace and a private /tmp writable, no network, and the
 * `hidden` folders empty and the `masked` sockets gone. A mount point cannot be renamed: that pins `.git`. See
 * `PROTECTED_PATHS`. With `proxySocket` the command reaches only that proxy.
 */
export function buildBwrapArgs(
  root: string,
  cwd: string,
  allowNetwork: boolean,
  bin = "bwrap",
  hidden: string[] = [],
  proxySocket?: string,
  masked: string[] = [],
  worktreeReadOnly: string[] = [],
  placeholders: Placeholder[] = [],
): string[] {
  const bind = (flag: string, paths: readonly string[]): string[] =>
    paths.flatMap((path) => [flag, `${root}/${path}`, `${root}/${path}`]);
  return [
    bin,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...hidden.flatMap((path) => ["--tmpfs", path]),
    ...masked.flatMap((path) => ["--ro-bind", "/dev/null", path]),
    "--bind",
    root,
    root,
    ...bind("--bind-try", PROTECTED_PATHS.pinned),
    ...bind("--ro-bind-try", PROTECTED_PATHS.readOnly),
    ...bind("--bind-try", PROTECTED_PATHS.writable),
    // After the worktrees are made writable: in each, the files that its own workspace runs stay read-only.
    ...bind("--ro-bind-try", worktreeReadOnly),
    ...placeholders.flatMap(({ path, source }) => ["--ro-bind", source, `${root}/${path}`]),
    ...(proxySocket === undefined
      ? []
      : [
          "--bind",
          proxySocket,
          RELAY_SOCKET,
          ...proxyEnv(`http://127.0.0.1:${RELAY_PORT}`).flatMap(([name, value]) => ["--setenv", name, value]),
        ]),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(allowNetwork ? [] : ["--unshare-net"]),
    "--die-with-parent",
    "--new-session",
    "--chdir",
    cwd,
    "--",
    ...(proxySocket === undefined ? [] : ["/bin/sh", "-c", RELAY_SCRIPT, "sh"]),
  ];
}

const quote = (path: string): string => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A path as a literal part of a Seatbelt regex. */
const regexOf = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Seatbelt profile with the same rules as the bubblewrap argv. The last rule that matches wins. With `proxyPort`
 * the command reaches only the proxy on that port. Without `hasGit` the `.git` rules go, as bubblewrap holds only
 * what exists: `git init` in a new folder works.
 */
export function buildSeatbeltProfile(
  root: string,
  allowNetwork: boolean,
  tmpDir = "/private/tmp",
  hidden: string[] = [],
  proxyPort?: number,
  hasGit = true,
): string {
  const rules = (kind: string, paths: readonly string[]): string =>
    paths
      .filter((path) => hasGit || (path !== ".git" && !path.startsWith(".git/")))
      .map((path) => `(${kind} ${quote(`${root}/${path}`)})`)
      .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    ...hidden.map((path) => `(deny file-read* (subpath ${quote(path)}))`),
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(root)}) (subpath ${quote(tmpDir)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (regex #"^/dev/tty"))`,
    `(deny file-write* ${rules("literal", PROTECTED_PATHS.pinned)} ${rules("subpath", PROTECTED_PATHS.readOnly)})`,
    `(allow file-write* ${rules("subpath", PROTECTED_PATHS.writable)})`,
    // A regex holds for a worktree that is made later too.
    `(deny file-write* (regex #"^${regexOf(root)}/${regexOf(WORKTREES)}/[^/]+/(${PROTECTED_PATHS.readOnly.map(regexOf).join("|")})(/|$)"))`,
    ...(allowNetwork ? [] : ["(deny network*)"]),
    ...(allowNetwork || proxyPort === undefined
      ? []
      : [`(allow network-outbound (remote ip "localhost:${proxyPort}"))`]),
  ].join("\n");
}

/**
 * The argv that runs a script process with no network, no write access and no view of the user's files: it talks
 * only on its stdin and stdout. `readPaths` are the files of the runner. On Windows, an AppContainer with no capability.
 */
export function buildScriptSandboxArgv(
  argv: string[],
  readPaths: string[],
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (platform === "linux") {
    const system = ["/usr", "/lib", "/lib64", "/bin", "/etc/ld.so.cache"];
    return [
      "bwrap",
      ...system.flatMap((path) => ["--ro-bind-try", path, path]),
      ...readPaths.flatMap((path) => ["--ro-bind", path, path]),
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--chdir",
      "/tmp",
      "--",
      ...argv,
    ];
  }
  if (platform === "darwin") {
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(deny file-write*)",
      '(allow file-write* (literal "/dev/null"))',
      '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/root") (subpath "/private/var/folders"))',
      ...readPaths.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
    ].join("\n");
    return ["/usr/bin/sandbox-exec", "-p", profile, ...argv];
  }
  if (platform === "win32") return [...windowsSandboxHelper(), APPCONTAINER_MODE, "--", ...argv];
  return undefined;
}

/** The environment of the script process: nothing of the user's. The Windows container finds its profile by LOCALAPPDATA. */
export function scriptSandboxEnv(platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
  if (platform !== "win32") return env;
  for (const name of ["SystemRoot", "LOCALAPPDATA"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

let scriptSandboxProbe: Promise<boolean> | undefined;

/**
 * True when the script sandbox of this platform starts a process. One probe for the life of the daemon. On Windows
 * the container first gets read access to `readPaths`, the files of the runner.
 */
export function scriptSandboxAvailable(readPaths: string[] = []): Promise<boolean> {
  scriptSandboxProbe ??= (async () => {
    const windows = process.platform === "win32";
    if (windows && !(await prepareScriptContainer(readPaths))) return false;
    const argv = buildScriptSandboxArgv(windows ? ["cmd.exe", "/d", "/c", "exit 0"] : ["/usr/bin/true"], []);
    if (argv === undefined) return false;
    try {
      return (await Bun.spawn(argv, { windowsHide: true, stdout: "ignore", stderr: "ignore" }).exited) === 0;
    } catch {
      return false;
    }
  })();
  return scriptSandboxProbe;
}

/**
 * Sockets of services that run a program on request outside any sandbox: the system bus (`systemd-run`), Docker and
 * its kin. A read-only mount does not stop a connect, and a network namespace does not hold a socket of the disk.
 */
const HOST_SOCKETS = [
  "/run/dbus/system_bus_socket",
  "/var/run/dbus/system_bus_socket",
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/run/podman/podman.sock",
  "/run/snapd.socket",
];

/** The runtime folder of the user: its bus runs `systemd-run --user`, and the SSH, GnuPG and Podman agents listen there. */
function runtimeDirs(): string[] {
  const uid = process.getuid?.();
  return [
    ...new Set([process.env.XDG_RUNTIME_DIR, uid === undefined ? undefined : `/run/user/${uid}`]),
  ].filter((path): path is string => path !== undefined && path !== "");
}

const SECCOMP_ARCH: Partial<Record<NodeJS.Architecture, { arch: number; socket: number }>> = {
  x64: { arch: 0xc000003e, socket: 41 },
  arm64: { arch: 0xc00000b7, socket: 198 },
};

/**
 * Fails `socket(AF_UNIX)`, as Claude Code's sandbox does: a host socket (Docker Desktop's, X11's) runs programs
 * outside. Also io_uring, which makes sockets past seccomp, x32 calls and those of another arch.
 */
export function unixSocketFilter(arch: NodeJS.Architecture = process.arch): Buffer | undefined {
  const calls = SECCOMP_ARCH[arch];
  if (calls === undefined) return undefined;
  const [LD, JEQ, JGE, RET] = [0x20, 0x15, 0x35, 0x06];
  const [ALLOW, EPERM, ENOSYS] = [0x7fff0000, 0x00050001, 0x00050026];
  const program: Array<[number, number, number, number]> = [
    [LD, 0, 0, 4], // arch
    [JEQ, 0, 8, calls.arch],
    [LD, 0, 0, 0], // the call
    [JGE, 6, 0, 0x40000000], // x32
    [JEQ, 5, 0, 425], // io_uring_setup
    [JEQ, 0, 2, calls.socket],
    [LD, 0, 0, 16], // its domain
    [JEQ, 1, 0, 1], // AF_UNIX
    [RET, 0, 0, ALLOW],
    [RET, 0, 0, EPERM],
    [RET, 0, 0, ENOSYS],
  ];
  const out = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], i) => {
    out.writeUInt16LE(code, i * 8);
    out.writeUInt8(jt, i * 8 + 2);
    out.writeUInt8(jf, i * 8 + 3);
    out.writeUInt32LE(k, i * 8 + 4);
  });
  return out;
}

let filterFile: string | undefined;

/** An empty read-only folder mounted where a protected path is missing, so that a command cannot make it. */
export interface Placeholder {
  path: string;
  source: string;
}

let placeholderSource: string | undefined;
/** The running commands that hold each placeholder. Its empty mount point is writable on the host until the last ends. */
const held = new Map<string, number>();

/**
 * bubblewrap holds only paths that exist: each missing protected path gets an empty read-only folder for the length
 * of the command, as Claude Code's sandbox does, so a write there fails. A folder, not a file, even for `.mcp.json`:
 * git does not list it. Only where the folder above exists, so `git init` in a new folder works; a hook that the
 * same command writes into that new `.git` is not held.
 */
function placeholdersFor(root: string): Placeholder[] {
  placeholderSource ??= mkdtempSync(join(tmpdir(), "agency-placeholder-"));
  const source = placeholderSource;
  const placed = [...PROTECTED_PATHS.readOnly, ...worktreeProtectedPaths(root)]
    .filter((path) => {
      const full = join(root, path);
      return held.has(full) || (!existsSync(full) && existsSync(dirname(full)));
    })
    .map((path) => ({ path, source }));
  for (const { path } of placed) held.set(join(root, path), (held.get(join(root, path)) ?? 0) + 1);
  return placed;
}

/** bubblewrap made the mount point of each placeholder here: one still empty goes, one filled from outside stays. */
function removePlaceholders(root: string, placed: Placeholder[]): void {
  for (const { path } of placed) {
    const full = join(root, path);
    const count = (held.get(full) ?? 1) - 1;
    if (count > 0) {
      held.set(full, count);
      continue;
    }
    held.delete(full);
    try {
      rmdirSync(full);
    } catch {}
  }
}

/** The real paths of those that exist, once each: `/var/run` is most often a link to `/run`. */
const existing = (paths: string[]): string[] => [
  ...new Set(paths.filter((path) => existsSync(path)).map((path) => realpathSync(path))),
];

/**
 * Runs each shell command in a sandbox of the operating system: bubblewrap on Linux, Seatbelt on macOS, a
 * write-restricted token on Windows. Paths and permission rules are those of the software boundary.
 */
export class OsSandboxBackend implements SandboxBackend {
  private readonly local: SandboxBoundary;
  private readonly root: string;
  private readonly platform: NodeJS.Platform;
  private readonly allowNetwork: boolean;
  private readonly sid: string;
  /** The proxy of `allowedDomains` once it runs: a Unix socket on Linux, a port on macOS. */
  private proxy?: { socket?: string; port?: number };

  constructor(
    root: string,
    commandPolicy: CommandPolicy = {},
    externalDecision: ExternalDirectoryDecision | undefined = undefined,
    private readonly options: OsSandboxOptions = {},
  ) {
    this.local = new SandboxBoundary(root, commandPolicy, externalDecision);
    // The kernel rules name real paths: on macOS /var is a link to /private/var.
    try {
      this.root = realpathSync(root);
    } catch {
      this.root = root;
    }
    this.platform = options.platform ?? process.platform;
    this.allowNetwork = options.allowNetwork ?? false;
    this.sid = windowsSandboxSid(this.root);
  }

  resolvePath(candidate: string): string {
    return this.local.resolvePath(candidate);
  }

  resolvePathGated(candidate: string, opts: { tool: string; ask?: RequestApproval }): Promise<string> {
    return this.local.resolvePathGated(candidate, opts);
  }

  checkCommand(command: string): void {
    this.local.checkCommand(command);
  }

  /** The hosts of `allowedDomains` when they limit the network: `allowNetwork` gives all of it. */
  private domains(): string[] | undefined {
    return this.allowNetwork ? undefined : this.options.allowedDomains;
  }

  /** Starts the proxy of `allowedDomains`, one time. Before it runs, a command has no network at all. */
  async startNetworkProxy(): Promise<void> {
    const domains = this.domains();
    if (domains === undefined || this.proxy !== undefined) return;
    if (this.platform === "linux") {
      // bubblewrap binds the socket into the sandbox: its own network has no route to a port of the host.
      const socket = join(mkdtempSync(join(tmpdir(), "agency-net-")), "proxy.sock");
      await startDomainProxy(domains, { path: socket });
      this.proxy = { socket };
    } else {
      const { port } = await startDomainProxy(domains, { host: "127.0.0.1", port: 0 });
      this.proxy = { port };
    }
  }

  /** The placeholders of a command: on Linux only. Seatbelt rules name paths, so they hold for a missing one. */
  private placeholders(): Placeholder[] {
    return this.platform === "linux" ? placeholdersFor(this.root) : [];
  }

  /** True when a command has no network, or only the hosts of `allowedDomains`. */
  get offline(): boolean {
    return !this.allowNetwork;
  }

  /** The argv that runs `argv` in the sandbox. `network` gives this one command the network, which the user allowed. */
  wrap(argv: string[], cwd: string = this.root, network = false, placeholders: Placeholder[] = []): string[] {
    const allowNetwork = this.allowNetwork || network;
    if (this.platform === "linux") {
      const proxySocket = allowNetwork ? undefined : this.proxy?.socket;
      const [bin = "bwrap", ...args] = buildBwrapArgs(
        this.root,
        cwd,
        allowNetwork,
        this.options.bwrapBin,
        [...this.hidden(), ...existing(runtimeDirs())],
        proxySocket,
        existing(HOST_SOCKETS),
        worktreeProtectedPaths(this.root),
        placeholders,
      );
      // socat, which relays the proxy, needs a Unix socket: with allowedDomains the network namespace holds the
      // abstract sockets, and the masks the known ones of the disk.
      const filter = proxySocket === undefined ? this.filterFile() : undefined;
      if (filter === undefined) return [bin, ...args, ...argv];
      return ["/bin/sh", "-c", 'exec "$@" 3<"$0"', filter, bin, "--seccomp", "3", ...args, ...argv];
    }
    if (this.platform === "darwin") {
      const port = allowNetwork ? undefined : this.proxy?.port;
      const profile = buildSeatbeltProfile(
        this.root,
        allowNetwork,
        process.env.TMPDIR ?? "/private/tmp",
        this.hidden(),
        port,
        existsSync(join(this.root, ".git")),
      );
      const env =
        port === undefined
          ? []
          : [
              "/usr/bin/env",
              ...proxyEnv(`http://127.0.0.1:${port}`).map(([name, value]) => `${name}=${value}`),
            ];
      return [this.options.seatbeltBin ?? "/usr/bin/sandbox-exec", "-p", profile, ...env, ...argv];
    }
    if (this.platform === "win32") return [...windowsSandboxHelper(), this.sid, "--", ...argv];
    throw new AgencyError(ErrorCode.INTERNAL, `sandbox.backend "os" has no backend for ${this.platform}`, {
      source: "sandbox-os",
    });
  }

  /** The file of `unixSocketFilter`, which bubblewrap reads on fd 3. None on an arch that it does not know. */
  private filterFile(): string | undefined {
    const filter = unixSocketFilter();
    if (filter === undefined) return undefined;
    if (filterFile === undefined) {
      const file = join(mkdtempSync(join(tmpdir(), "agency-seccomp-")), "unix.bpf");
      writeFileSync(file, filter);
      filterFile = file;
    }
    return filterFile;
  }

  /** `wrap` for a command run on the host: `release` once it exits removes its placeholders; `explain` names a denial. */
  wrapHeld(
    argv: string[],
    cwd: string = this.root,
    network = false,
  ): { argv: string[]; release: () => void; explain: (output: string) => string[] } {
    const placed = this.placeholders();
    return {
      argv: this.wrap(argv, cwd, network, placed),
      release: () => removePlaceholders(this.root, placed),
      explain: (output) => this.violations(output, network),
    };
  }

  /** The hidden folders that exist and do not hold the workspace: bubblewrap mounts only on a folder that exists. */
  private hidden(): string[] {
    return (this.options.hidden ?? []).filter(
      (path) => existsSync(path) && !`${this.root}/`.startsWith(`${path.replace(/\/+$/, "")}/`),
    );
  }

  /**
   * The rule of the sandbox that an error in the output can come from. Without it a model reads "Read-only file
   * system" or "Could not resolve host" as a fault to work around, and tries again in other ways.
   */
  private violations(output: string, network: boolean): string[] {
    const notes: string[] = [];
    // "Is a directory": a placeholder of a missing protected file.
    if (
      /Read-only file system|EROFS|Operation not permitted|Is a directory|Access to the path .* is denied/i.test(
        output,
      )
    ) {
      const sockets =
        this.platform === "linux" && (this.allowNetwork || network || this.proxy?.socket === undefined)
          ? " It cannot open a Unix socket either."
          : "";
      notes.push(
        `agency sandbox: this command runs in the sandbox of the operating system. It can write only in the workspace and the temporary folder, and not in .git/hooks, .git/config, .agency or the hook and MCP files of agents.${sockets} An error above can come from that: do not try the same thing in another way.`,
      );
    }
    const offline =
      /Could not resolve host|Temporary failure in name resolution|Name or service not known|ENOTFOUND|EAI_AGAIN|getaddrinfo|Network is unreachable|ENETUNREACH/i;
    if (!this.allowNetwork && !network && offline.test(output)) {
      const domains = this.domains();
      notes.push(
        `${
          domains?.length
            ? `agency sandbox: this command reaches only ${domains.join(", ")} (sandbox.allowedDomains), through a proxy. A network error above can come from that.`
            : "agency sandbox: this command has no network (sandbox.allowNetwork is off). A network error above comes from that."
        } Do not retry it the same way. If the task needs the network, run the command again with network: true, which asks the user, or do the work without it.`,
      );
    }
    return notes;
  }

  /** True when the sandbox program of this platform starts a command. */
  async isAvailable(): Promise<boolean> {
    if (!["linux", "darwin", "win32"].includes(this.platform)) return false;
    if (this.platform === "win32" && this.windowsRefusal() !== undefined) return false;
    if (this.platform === "linux" && this.domains() !== undefined && !Bun.which("socat")) return false;
    try {
      // A `.agency` that a command makes would not be read-only: the rules apply to the paths that exist.
      mkdirSync(join(this.root, ".agency"), { recursive: true });
      // The probe below then also starts socat in the sandbox.
      if (this.platform !== "win32") await this.startNetworkProxy();
      // Here the folders get the rules of the SID, one time for each daemon start.
      if (this.platform === "win32" && !(await prepareWindowsSandbox(this.root, this.sid))) return false;
      const probe = this.platform === "win32" ? ["cmd.exe", "/d", "/c", "exit 0"] : ["true"];
      const child = Bun.spawn(this.wrap(probe), { windowsHide: true, stdout: "ignore", stderr: "ignore" });
      return (await child.exited) === 0;
    } catch {
      return false;
    }
  }

  /** Why Windows refuses the config, before any probe. */
  private windowsRefusal(): string | undefined {
    if (this.options.windowsShell === "gitbash") {
      return 'sandbox.backend is "os", but Git Bash (MSYS) does not start under the restricted token of Windows. Remove windowsShell or set it to "powershell" or "cmd".';
    }
    if (this.domains() !== undefined) {
      return 'sandbox.backend is "os", but on Windows a command cannot be limited to sandbox.allowedDomains without administrator rights. Remove sandbox.allowedDomains and set sandbox.allowNetwork to true to accept that, or set sandbox.backend to "software".';
    }
    if (!this.allowNetwork) {
      return 'sandbox.backend is "os", but on Windows a command cannot be kept off the network without administrator rights. Set sandbox.allowNetwork to true to accept that, or set sandbox.backend to "software".';
    }
    return undefined;
  }

  unavailableReason(): string {
    if (this.platform === "linux" && this.domains() !== undefined && !Bun.which("socat")) {
      return "sandbox.allowedDomains needs socat, which relays the proxy into the sandbox. Install it (`apt install socat`), or remove sandbox.allowedDomains.";
    }
    if (this.platform === "linux") {
      return 'sandbox.backend is "os" but bubblewrap did not start a command. Install it (`apt install bubblewrap`) and allow user namespaces, or set sandbox.backend to "software".';
    }
    if (this.platform === "darwin") {
      return 'sandbox.backend is "os" but /usr/bin/sandbox-exec did not start a command. Set sandbox.backend to "software".';
    }
    if (this.platform === "win32") {
      return (
        this.windowsRefusal() ??
        'sandbox.backend is "os", but the restricted token of Windows did not start a command, or the workspace did not take its access rule. Set sandbox.backend to "software".'
      );
    }
    return `sandbox.backend "os" works on Linux, macOS and Windows only, and this is ${this.platform}. Set sandbox.backend to "software".`;
  }

  async exec(
    argv: string[],
    opts: {
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      env?: Record<string, string | undefined>;
      network?: boolean;
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.checkCommand(argv.join(" "));
    const placed = this.placeholders();
    const child = Bun.spawn(this.wrap(argv, opts.cwd, opts.network, placed), {
      windowsHide: true,
      cwd: opts.cwd ?? this.root,
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
    const stdoutText = new Response(child.stdout).text();
    const stderrText = new Response(child.stderr).text();
    // --die-with-parent and the Seatbelt child both end with the wrapper process.
    const kill = (): void => {
      try {
        child.kill(9);
      } catch {}
    };
    let timedOut = false;
    if (opts.signal?.aborted) kill();
    else opts.signal?.addEventListener("abort", kill);
    const timer =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, opts.timeoutMs)
        : undefined;
    try {
      const [stdout, output, exitCode] = await Promise.all([stdoutText, stderrText, child.exited]);
      const notes = this.violations(`${stdout}\n${output}`, opts.network === true);
      const stderr =
        notes.length === 0
          ? output
          : `${output}${output && !output.endsWith("\n") ? "\n" : ""}${notes.join("\n")}\n`;
      if (timedOut) {
        throw new AgencyError(ErrorCode.INTERNAL, "sandboxed command timed out", {
          source: "sandbox-os",
          context: { argv, timedOut: true, stdout, stderr },
        });
      }
      return { stdout, stderr, exitCode };
    } finally {
      removePlaceholders(this.root, placed);
      opts.signal?.removeEventListener("abort", kill);
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
