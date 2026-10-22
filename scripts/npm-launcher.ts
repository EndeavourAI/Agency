/**
 * The `agency` bin of the npm wrapper package, bundled to plain Node JS by npm-pack.ts: finds the platform package
 * that holds the binary and runs it. No postinstall: npm picks the platform package through os/cpu/libc.
 */
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
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
  // A package packed on Windows carries no execute bit.
  try {
    if (pkg.os !== "win32") chmodSync(binary, 0o755);
  } catch {}
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  // A terminal sends ctrl+c to the child as well; this process must outlive it to pass the exit code on.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", (e) => {
    console.error(`agency: could not start ${binary}: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (typeof require !== "undefined" && require.main === module) run();
