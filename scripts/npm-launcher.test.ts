import { describe, expect, test } from "bun:test";
import { PLATFORMS, platformPackage } from "./npm-launcher.ts";

describe("platformPackage", () => {
  test("picks the package of each supported platform", () => {
    expect(platformPackage("win32", "x64", undefined)?.name).toBe("@endeavourai/agency-win32-x64");
    expect(platformPackage("darwin", "arm64", undefined)?.name).toBe("@endeavourai/agency-darwin-arm64");
    expect(platformPackage("darwin", "x64", undefined)?.name).toBe("@endeavourai/agency-darwin-x64");
    expect(platformPackage("linux", "x64", "glibc")?.name).toBe("@endeavourai/agency-linux-x64");
    expect(platformPackage("linux", "arm64", "glibc")?.name).toBe("@endeavourai/agency-linux-arm64");
  });
  test("linux splits on libc", () => {
    expect(platformPackage("linux", "x64", "musl")?.name).toBe("@endeavourai/agency-linux-x64-musl");
    expect(platformPackage("linux", "arm64", "musl")?.target).toBe("bun-linux-arm64-musl");
  });
  test("an unsupported platform has none", () => {
    expect(platformPackage("win32", "arm64", undefined)).toBeUndefined();
    expect(platformPackage("freebsd", "x64", undefined)).toBeUndefined();
    expect(platformPackage("linux", "ia32", "glibc")).toBeUndefined();
  });
  test("every package maps to a distinct build artifact", () => {
    expect(new Set(PLATFORMS.map((p) => p.artifact)).size).toBe(PLATFORMS.length);
    expect(PLATFORMS.find((p) => p.os === "win32")?.artifact).toBe("agency-windows-x64.exe");
  });
});

// launch() signals the process it runs in, so each case runs it in a driver process.
const launcher = new URL("./npm-launcher.ts", import.meta.url).href;
const drive = (childCode: string) =>
  Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { launch } from ${JSON.stringify(launcher)}; launch(process.execPath, ["-e", ${JSON.stringify(childCode)}], { chmod: false, musl: false });`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );

describe("launch", () => {
  test("the exit code passes through", async () => {
    expect(await drive("process.exit(7)").exited).toBe(7);
  });
  describe.skipIf(process.platform === "win32")("signals", () => {
    test("a child killed by SIGTERM does not turn into exit 0", async () => {
      const p = drive(`process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000)`);
      await p.exited;
      expect(p.signalCode === "SIGTERM" || p.exitCode === 143).toBe(true);
    });
    test("a child killed by SIGINT does not turn into exit 0", async () => {
      const p = drive(`process.kill(process.pid, "SIGINT"); setInterval(() => {}, 1000)`);
      await p.exited;
      expect(p.signalCode === "SIGINT" || p.exitCode === 130).toBe(true);
    });
    test("a SIGINT sent to the wrapper alone reaches the child when stdin is not a terminal", async () => {
      const p = drive(
        `process.on("SIGINT", () => process.exit(42)); console.log("up"); setInterval(() => {}, 1000)`,
      );
      const reader = p.stdout.getReader();
      await reader.read();
      p.kill("SIGINT");
      expect(await p.exited).toBe(42);
    });
  });
});
