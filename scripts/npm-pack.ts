/**
 * Builds the npm packages of a release: the wrapper `@endeavourai/agency` (a Node launcher) and one
 * `@endeavourai/agency-<os>-<arch>` per platform that holds only that platform's binary. Writes them under
 * dist/npm and runs `npm pack --dry-run` on each. It never publishes; publishing is a separate, deliberate step.
 *
 * Usage: bun scripts/npm-pack.ts [--version 0.1.0] [--outdir dist/npm] [--only agency-win32-x64,...] [--skip-build] [--tarballs]
 * --tarballs also writes real .tgz files to <outdir>/tarballs (for a local install test).
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORMS, type PlatformPackage } from "./npm-launcher.ts";

const WRAPPER = "@endeavourai/agency";

interface Options {
  version: string;
  outdir: string;
  only: string[];
  skipBuild: boolean;
  tarballs: boolean;
}

function parseArgs(argv: string[]): Options {
  const cliVersion = (JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as { version: string })
    .version;
  const o: Options = { version: cliVersion, outdir: "dist/npm", only: [], skipBuild: false, tarballs: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") o.version = (argv[++i] ?? "").replace(/^v/, "");
    else if (arg === "--outdir") o.outdir = argv[++i] ?? o.outdir;
    else if (arg === "--only") o.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--skip-build") o.skipBuild = true;
    else if (arg === "--tarballs") o.tarballs = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return o;
}

const dirName = (name: string): string => name.replace("@endeavourai/", "");

const common = (version: string) => ({
  version,
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/EndeavourAI/Agency.git" },
  publishConfig: { access: "public" },
});

function writePackage(dir: string, manifest: object): void {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync("LICENSE", join(dir, "LICENSE"));
}

function platformPackageDir(root: string, p: PlatformPackage, version: string): string {
  const dir = join(root, dirName(p.name));
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(join("dist", p.artifact), join(dir, "bin", p.os === "win32" ? "agency.exe" : "agency"));
  writePackage(dir, {
    name: p.name,
    ...common(version),
    description: `The agency binary for ${p.os} ${p.cpu}${p.libc === "musl" ? " (musl)" : ""}`,
    os: [p.os],
    cpu: [p.cpu],
    ...(p.os === "linux" ? { libc: [p.libc] } : {}),
    files: ["bin"],
  });
  return dir;
}

async function wrapperDir(root: string, platforms: PlatformPackage[], version: string): Promise<string> {
  const dir = join(root, dirName(WRAPPER));
  mkdirSync(join(dir, "bin"), { recursive: true });
  const built = await Bun.build({
    entrypoints: ["scripts/npm-launcher.ts"],
    target: "node",
    format: "cjs",
    minify: true,
    banner: "#!/usr/bin/env node",
    outdir: join(dir, "bin"),
    naming: "agency.js",
  });
  if (!built.success) throw new Error(`launcher build failed\n${built.logs.join("\n")}`);
  writePackage(dir, {
    name: WRAPPER,
    ...common(version),
    description: "Agency, the coding agent, in your terminal",
    bin: { agency: "bin/agency.js" },
    files: ["bin"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(platforms.map((p) => [p.name, version])),
  });
  return dir;
}

async function npm(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn([Bun.which("npm") ?? "npm", ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`npm ${args.join(" ")} failed in ${cwd}`);
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const platforms = PLATFORMS.filter((p) => o.only.length === 0 || o.only.includes(dirName(p.name)));
  if (platforms.length === 0) throw new Error("no platform matches --only");
  if (!o.skipBuild) {
    const build = Bun.spawn(
      [
        process.execPath,
        "scripts/build.ts",
        "--targets",
        platforms.map((p) => p.target).join(","),
        "--version",
        o.version,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await build.exited) !== 0) throw new Error("binary build failed");
  }
  const root = o.outdir;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const dirs = [
    ...platforms.map((p) => platformPackageDir(root, p, o.version)),
    await wrapperDir(root, platforms, o.version),
  ];
  const tarballs = join(process.cwd(), root, "tarballs");
  if (o.tarballs) mkdirSync(tarballs, { recursive: true });
  for (const dir of dirs) {
    await npm(["pack", "--dry-run"], dir);
    if (o.tarballs) await npm(["pack", "--pack-destination", tarballs], dir);
  }
}

await main();
