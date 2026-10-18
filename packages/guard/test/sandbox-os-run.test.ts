import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OsSandboxBackend } from "../src/sandbox-os.ts";

// Real commands in the sandbox of the OS: Linux with bubblewrap, macOS with Seatbelt. Elsewhere they skip.
const posix = process.platform === "linux" || process.platform === "darwin";
const dirs: string[] = [];
const dir = (base: string): string => {
  const path = mkdtempSync(join(base, ".agency-osrun-"));
  dirs.push(path);
  return path;
};
afterAll(() => {
  for (const path of dirs) rmSync(path, { recursive: true, force: true });
});
const runs = posix && (await new OsSandboxBackend(dir(tmpdir())).isAvailable());
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("site body") });
afterAll(() => site.stop(true));

describe.skipIf(!runs)("OS sandbox: real commands", () => {
  test("a command writes in the workspace, not outside it, and has no network", async () => {
    const ws = dir(tmpdir());
    // Not in the temp folder: the sandbox lets a command write there.
    const outside = dir(homedir());
    const sandbox = new OsSandboxBackend(ws);
    expect(await sandbox.isAvailable()).toBe(true);
    const inside = await sandbox.exec(["sh", "-c", "echo hi > in.txt"], { cwd: ws });
    expect(inside.exitCode).toBe(0);
    expect(existsSync(join(ws, "in.txt"))).toBe(true);
    const out = await sandbox.exec(["sh", "-c", `echo hi > '${join(outside, "out.txt")}'`], { cwd: ws });
    expect(out.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "out.txt"))).toBe(false);
    const net = await sandbox.exec(["curl", "-s", "--max-time", "5", `http://127.0.0.1:${site.port}/`], {
      cwd: ws,
    });
    expect(net.stdout).not.toContain("site body");
  });

  test("a command cannot change a file whose hooks run outside the sandbox, nor make a new one", async () => {
    const ws = dir(tmpdir());
    const sandbox = new OsSandboxBackend(ws);
    expect(await sandbox.isAvailable()).toBe(true);
    await Bun.write(join(ws, ".claude", "settings.json"), "{}");
    const edit = await sandbox.exec(["sh", "-c", "echo x > .claude/settings.json"], { cwd: ws });
    expect(edit.exitCode).not.toBe(0);
    expect(await Bun.file(join(ws, ".claude", "settings.json")).text()).toBe("{}");
    // A missing one cannot be made: the write fails, the result says why, and nothing is left behind.
    const made = await sandbox.exec(["sh", "-c", "echo '{}' > .mcp.json"], { cwd: ws });
    expect(made.exitCode).not.toBe(0);
    expect(made.stderr).toContain("agency sandbox: this command runs in the sandbox");
    expect(existsSync(join(ws, ".mcp.json"))).toBe(false);
    expect(existsSync(join(ws, ".vscode"))).toBe(false);
  });

  test.skipIf(process.platform !== "linux")(
    "a command that outlives the call holds its placeholders while other commands start and end",
    async () => {
      const ws = dir(tmpdir());
      const sandbox = new OsSandboxBackend(ws);
      expect(await sandbox.isAvailable()).toBe(true);
      const held = sandbox.wrapHeld(["sh", "-c", "sleep 1; echo '{}' > .mcp.json; echo done"], ws);
      const long = Bun.spawn(held.argv, { cwd: ws, stdout: "pipe", stderr: "pipe" });
      // Started while the long one runs, and ended before it writes: the host folder stays until both end.
      const short = await sandbox.exec(["sh", "-c", "echo '{}' > .mcp.json"], { cwd: ws });
      expect(short.exitCode).not.toBe(0);
      expect(existsSync(join(ws, ".mcp.json"))).toBe(true);
      await long.exited;
      held.release();
      expect(await new Response(long.stdout).text()).toContain("done");
      expect(existsSync(join(ws, ".mcp.json"))).toBe(false);
    },
  );

  test.skipIf(Bun.which("git") === null)(
    "git init works in a new folder, and git status shows no placeholder",
    async () => {
      const ws = dir(tmpdir());
      const sandbox = new OsSandboxBackend(ws);
      expect(await sandbox.isAvailable()).toBe(true);
      const init = await sandbox.exec(["sh", "-c", "git init -q && git status --porcelain"], { cwd: ws });
      expect(init.exitCode).toBe(0);
      expect(existsSync(join(ws, ".git", "config"))).toBe(true);
      // Empty placeholders and the empty `.agency` that isAvailable makes are not listed: a clean tree.
      expect(init.stdout.trim()).toBe("");
    },
  );

  test("in a team worktree too, a command cannot change or make the files that its workspace runs", async () => {
    const ws = dir(tmpdir());
    const tree = join(ws, ".agency", "worktrees", "w1");
    await Bun.write(join(tree, ".claude", "settings.json"), "{}");
    await Bun.write(join(tree, "src", "a.ts"), "");
    const sandbox = new OsSandboxBackend(ws);
    expect(await sandbox.isAvailable()).toBe(true);
    const run = await sandbox.exec(
      ["sh", "-c", "echo x > src/a.ts; echo x > .claude/settings.json; echo '{}' > .mcp.json; echo done"],
      { cwd: tree },
    );
    expect(run.stdout).toContain("done");
    expect(run.stderr).toContain("agency sandbox: this command runs in the sandbox");
    expect(await Bun.file(join(tree, "src", "a.ts")).text()).toBe("x\n");
    expect(await Bun.file(join(tree, ".claude", "settings.json")).text()).toBe("{}");
    expect(existsSync(join(tree, ".mcp.json"))).toBe(false);
  });

  test.skipIf(process.platform !== "linux" || !existsSync("/run/dbus/system_bus_socket"))(
    "a command cannot reach the system bus or the runtime folder of the user, which run programs outside it",
    async () => {
      const ws = dir(tmpdir());
      const sandbox = new OsSandboxBackend(ws);
      expect(await sandbox.isAvailable()).toBe(true);
      const uid = process.getuid?.() ?? 0;
      const probe = await sandbox.exec(
        ["sh", "-c", `test -S /run/dbus/system_bus_socket && echo bus; ls -A /run/user/${uid} 2>/dev/null`],
        { cwd: ws },
      );
      expect(probe.stdout.trim()).toBe("");
    },
  );

  test("a write or network error names the rule of the sandbox that it can come from", async () => {
    const ws = dir(tmpdir());
    const outside = dir(homedir());
    const sandbox = new OsSandboxBackend(ws);
    expect(await sandbox.isAvailable()).toBe(true);
    const write = await sandbox.exec(["sh", "-c", `echo hi > '${join(outside, "x.txt")}'`], { cwd: ws });
    expect(write.stderr).toContain("agency sandbox: this command runs in the sandbox");
    const net = await sandbox.exec(
      ["sh", "-c", "echo 'curl: (6) Could not resolve host: example.com' >&2; exit 6"],
      {
        cwd: ws,
      },
    );
    expect(net.stderr).toContain("agency sandbox: this command has no network");
    const fine = await sandbox.exec(["sh", "-c", "echo ok"], { cwd: ws });
    expect(fine.stderr).toBe("");
  });

  const domainsRun =
    runs && Bun.which("curl") !== null && (process.platform !== "linux" || Bun.which("socat") !== null);
  test.skipIf(!domainsRun)(
    "with allowedDomains a command reaches a listed host through the proxy, gets 403 for another, and nothing directly",
    async () => {
      const ws = dir(tmpdir());
      const sandbox = new OsSandboxBackend(ws, {}, undefined, { allowedDomains: ["localhost"] });
      expect(await sandbox.isAvailable()).toBe(true);
      const curl = (...args: string[]) =>
        sandbox.exec(["curl", "-s", "--max-time", "5", ...args], { cwd: ws });
      expect((await curl(`http://localhost:${site.port}/`)).stdout).toBe("site body");
      const other = await curl(`http://127.0.0.1:${site.port}/`);
      expect(other.stdout).toContain("127.0.0.1 is not in sandbox.allowedDomains");
      expect(other.stdout).not.toContain("site body");
      const direct = await curl("--noproxy", "*", `http://localhost:${site.port}/`);
      expect(direct.stdout).not.toContain("site body");
      expect(direct.exitCode).not.toBe(0);
    },
  );
});
