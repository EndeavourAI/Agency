/**
 * The `agency` bin of the npm wrapper package, bundled to plain Node JS by npm-pack.ts: finds the platform package
 * that holds the binary and runs it. No postinstall: npm picks the platform package through os/cpu/libc.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PlatformPackage {
  name: string;
  os: "darwin" | "linux" | "win32";
  cpu: "arm64" | "x64";
  libc?: "musl" | "glibc";
  /** The `bun-<os>-<arch>` target of scripts/build.ts and its artifact. */
  target: string;
  artifact: string;
}

const row = (
  os: PlatformPackage["os"],
  cpu: PlatformPackage["cpu"],
  libc?: "musl" | "glibc",
): PlatformPackage => {
  const bunOs = os === "win32" ? "windows" : os;
  const suffix = libc === "musl" ? "-musl" : "";
  return {
    name: `@endeavourai/agency-${os}-${cpu}${suffix}`,
    os,
    cpu,
    ...(libc ? { libc } : {}),
    target: `bun-${bunOs}-${cpu}${suffix}`,
    artifact: `agency-${bunOs}-${cpu}${suffix}${os === "win32" ? ".exe" : ""}`,
  };
};

export const PLATFORMS: PlatformPackage[] = [
  row("darwin", "arm64"),
  row("darwin", "x64"),
  row("linux", "x64", "glibc"),
  row("linux", "arm64", "glibc"),
  row("linux", "x64", "musl"),
  row("linux", "arm64", "musl"),
  row("win32", "x64"),
];

export function platformPackage(
  platform: string,
  arch: string,
  libc: "musl" | "glibc" | undefined,
): PlatformPackage | undefined {
  return PLATFORMS.find(
    (p) => p.os === platform && p.cpu === arch && (platform !== "linux" || p.libc === (libc ?? "glibc")),
  );
}

function linuxLibc(): "musl" | "glibc" {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
    ?.header;
  return header?.glibcVersionRuntime ? "glibc" : "musl";
}

/** Runs the binary and mirrors how it ended: its exit code, or the same signal re-raised on this process. */
export function launch(binary: string, args: string[], opts: { chmod: boolean; musl: boolean }): void {
  // A package packed on Windows may carry no execute bit; the failure is kept for the spawn error.
  let chmodError = "";
  if (opts.chmod) {
    try {
      chmodSync(binary, 0o755);
    } catch (e) {
      chmodError = ` (chmod +x failed: ${(e as Error).message})`;
    }
  }
  const alpineHint = () => {
    if (opts.musl && !existsSync("/usr/lib/libstdc++.so.6"))
      console.error("agency: Alpine needs libstdc++ and libgcc. Run: apk add libstdc++ libgcc");
  };
  const child = spawn(binary, args, { stdio: "inherit" });
  // On a terminal ctrl+c reaches the child through the process group; only a lone signal needs forwarding.
  const onInt = () => {
    if (!process.stdin.isTTY) child.kill("SIGINT");
  };
  const onTerm = () => child.kill("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  child.on("error", (e) => {
    console.error(`agency: could not start ${binary}: ${e.message}${chmodError}`);
    alpineHint();
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (code === 127) alpineHint();
    if (signal) {
      // Our own handlers would swallow the re-raised signal and turn it into exit 0.
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

function run(): void {
  const libc = process.platform === "linux" ? linuxLibc() : undefined;
  const pkg = platformPackage(process.platform, process.arch, libc);
  if (!pkg) {
    console.error(`agency: no build for ${process.platform}-${process.arch}${libc ? `-${libc}` : ""}`);
    process.exit(1);
  }
  let binary: string;
  try {
    binary = join(
      dirname(require.resolve(`${pkg.name}/package.json`)),
      "bin",
      pkg.os === "win32" ? "agency.exe" : "agency",
    );
  } catch {
    console.error(
      `agency: the platform package ${pkg.name} is not installed. Reinstall without --omit=optional (or run: npm i ${pkg.name}).`,
    );
    process.exit(1);
  }
  launch(binary, process.argv.slice(2), { chmod: pkg.os !== "win32", musl: pkg.libc === "musl" });
}

if (typeof require !== "undefined" && require.main === module) run();
