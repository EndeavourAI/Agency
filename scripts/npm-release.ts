/**
 * The npm half of the release workflow.
 *   gate    decides from the root package.json version whether this run builds and publishes; writes GITHUB_OUTPUT.
 *   publish publishes the tarballs of --dir (platforms first, the wrapper last) and skips what npm already has.
 *
 * Usage: bun scripts/npm-release.ts gate | publish --dir dist/npm/tarballs
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCOPE = "@endeavourai/";
const WRAPPER = `${SCOPE}agency`;

export const npmTag = (version: string): "next" | "latest" => (version.includes("-") ? "next" : "latest");

export interface Gate {
  event: string;
  refType: string;
  refName: string;
  version: string;
  /** The wrapper is published last, so its presence means the whole set is out. */
  onNpm: boolean;
  tagExists: boolean;
}

/** A dispatch only builds; a merge without a version bump (tag or npm already there) does nothing. */
export function gate(g: Gate): { build: boolean; publish: boolean } {
  if (g.event === "workflow_dispatch") return { build: true, publish: false };
  if (g.refType === "tag") {
    if (g.refName !== `v${g.version}`)
      throw new Error(`tag ${g.refName} does not match package.json ${g.version}`);
    return { build: !g.onNpm, publish: !g.onNpm };
  }
  const publish = !g.onNpm && !g.tagExists;
  return { build: publish, publish };
}

/** Platform tarballs first, the wrapper last: nobody can install a wrapper whose binaries are missing. */
export function publishPlan(files: string[], version: string): { file: string; name: string }[] {
  const suffix = `-${version}.tgz`;
  const plan = files.map((file) => {
    if (!file.startsWith("endeavourai-") || !file.endsWith(suffix))
      throw new Error(`unexpected tarball: ${file}`);
    return { file, name: `${SCOPE}${file.slice("endeavourai-".length, -suffix.length)}` };
  });
  return plan.sort((a, b) => Number(a.name === WRAPPER) - Number(b.name === WRAPPER));
}

function onNpm(name: string, version: string): boolean {
  const r = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], { stderr: "ignore" });
  return r.exitCode === 0 && r.stdout.toString().trim() === version;
}

function run(cmd: string[]): void {
  if (Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" }).exitCode !== 0)
    throw new Error(`${cmd.join(" ")} failed`);
}

function main(argv: string[]): void {
  const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  if (argv[0] === "gate") {
    const tag = Bun.spawnSync(
      ["git", "ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${version}`],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const d = gate({
      event: process.env.GITHUB_EVENT_NAME ?? "",
      refType: process.env.GITHUB_REF_TYPE ?? "",
      refName: process.env.GITHUB_REF_NAME ?? "",
      version,
      onNpm: onNpm(WRAPPER, version),
      tagExists: tag.exitCode === 0,
    });
    const lines = `version=${version}\nbuild=${d.build}\npublish=${d.publish}\n`;
    console.log(lines);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  } else if (argv[0] === "publish") {
    const dir = argv[argv.indexOf("--dir") + 1] ?? "dist/npm/tarballs";
    for (const { file, name } of publishPlan(readdirSync(dir), version)) {
      if (onNpm(name, version)) {
        console.log(`skip ${name}@${version}: already on npm`);
        continue;
      }
      run([
        "npm",
        "publish",
        join(dir, file),
        "--access",
        "public",
        "--provenance",
        "--tag",
        npmTag(version),
      ]);
    }
  } else throw new Error("usage: npm-release.ts gate | publish --dir <tarballs>");
}

if (import.meta.main) main(process.argv.slice(2));
