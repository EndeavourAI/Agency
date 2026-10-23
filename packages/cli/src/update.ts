import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getUpdatePublicKey } from "./update-public-key.ts";

const REPO = "EndeavourAI/Agency";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns a newer release version when the stamp file knows one, and asks GitHub at most once a day.
 * The stamp is written before the request: a short command that exits mid-request must not send another.
 */
export function checkStale(
  currentVersion: string,
  stampFile: string,
  httpFetch: typeof fetch = fetch,
  now: number = Date.now(),
): string | undefined {
  let stamp: { checkedAt?: number; latest?: string } = {};
  try {
    stamp = JSON.parse(readFileSync(stampFile, "utf8"));
  } catch {
    // No stamp yet.
  }
  if (stamp.checkedAt === undefined || now - stamp.checkedAt >= CHECK_INTERVAL_MS) {
    const save = (latest: string | undefined): void => {
      try {
        mkdirSync(dirname(stampFile), { recursive: true });
        writeFileSync(stampFile, JSON.stringify({ checkedAt: now, latest }));
      } catch {
        // An unwritable cache dir only means the check repeats.
      }
    };
    save(stamp.latest);
    void httpFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(5000),
    })
      .then(async (res) => {
        if (res.ok) save(((await res.json()) as { tag_name?: string }).tag_name?.replace(/^v/, ""));
      })
      .catch(() => {});
  }
  return stamp.latest && stamp.latest !== currentVersion ? stamp.latest : undefined;
}

/** The npm prefix and platform package of a global npm install, read from the binary's path; undefined for any other install. */
export function npmGlobalInstall(
  binPath: string,
  platform: string = process.platform,
): { prefix: string; pkg: string } | undefined {
  const m =
    /^(.+?)[\\/]node_modules[\\/]@endeavourai[\\/]agency[\\/]node_modules[\\/]@endeavourai[\\/](agency-[\w-]+)[\\/]bin[\\/]/.exec(
      binPath,
    );
  if (!m?.[1] || !m[2]) return undefined;
  // Windows keeps global packages in <prefix>\node_modules, the others in <prefix>/lib/node_modules.
  return { prefix: platform === "win32" ? m[1] : m[1].replace(/[\\/]lib$/, ""), pkg: m[2] };
}

/**
 * Starts `npm i -g` of `latest` in the background for a global npm install, at most once a day per version; the next
 * start runs it. Waits for the platform package on the registry: npm skips a missing optional one and leaves no binary.
 */
export function startNpmUpdate(o: {
  current: string;
  latest: string;
  binPath: string;
  stampFile: string;
  httpFetch?: typeof fetch;
  spawn?: (cmd: string[]) => void;
  npm?: string | null;
  now?: number;
}): boolean {
  const install = npmGlobalInstall(o.binPath);
  const npm = o.npm === undefined ? Bun.which("npm") : o.npm;
  if (!install || !npm || Bun.semver.order(o.latest, o.current) <= 0) return false;
  const now = o.now ?? Date.now();
  let tried: { version?: string; at?: number } = {};
  try {
    tried = JSON.parse(readFileSync(o.stampFile, "utf8"));
  } catch {
    // No attempt yet.
  }
  if (tried.version === o.latest && now - (tried.at ?? 0) < CHECK_INTERVAL_MS) return false;
  try {
    mkdirSync(dirname(o.stampFile), { recursive: true });
    writeFileSync(o.stampFile, JSON.stringify({ version: o.latest, at: now }));
  } catch {
    return false;
  }
  const spawn =
    o.spawn ??
    ((cmd: string[]) =>
      Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"], detached: true, windowsHide: true }).unref());
  void (o.httpFetch ?? fetch)(`https://registry.npmjs.org/@endeavourai%2f${install.pkg}/${o.latest}`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (res.ok) spawn([npm, "i", "-g", "--prefix", install.prefix, `@endeavourai/agency@${o.latest}`]);
    })
    .catch(() => {});
  return true;
}

/** Verify ed25519 signature for the asset buffer using the embedded public key. */
export function verifySignature(assetBuf: Buffer, signatureBuf: Buffer): boolean {
  if (signatureBuf.length !== 64) return false;
  try {
    const publicKey = getUpdatePublicKey();
    const keyObject = createPublicKey({ key: publicKey, format: "der", type: "spki" });
    return verify(undefined, assetBuf, keyObject, signatureBuf);
  } catch {
    return false;
  }
}

export async function runUpdate(options: {
  currentVersion: string;
  rollback?: boolean;
  binPath?: string;
  httpFetch?: typeof fetch;
}): Promise<string> {
  const binPath = options.binPath ?? process.execPath;
  const httpFetch = options.httpFetch ?? fetch;

  // npm owns this file: replacing it desyncs the package, and the next npm run restores it.
  if (/[\\/]node_modules[\\/]/.test(binPath))
    throw new Error("agency was installed with npm; update it with: npm i -g @endeavourai/agency@latest");

  if (options.rollback) {
    const backup = `${binPath}.previous`;
    if (!existsSync(backup)) throw new Error("No previous version to rollback to");
    swapBinary(backup, binPath, `${binPath}.rolled-back`);
    return "Rolled back to previous version";
  }

  const latestRes = await httpFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github.v3+json" },
  });
  // GitHub answers 404 for the latest release of a repository that has none.
  if (latestRes.status === 404) throw new Error("No release is published yet: there is nothing to update to");
  if (!latestRes.ok) throw new Error(`Failed to fetch latest release: ${latestRes.status}`);
  const latest = (await latestRes.json()) as {
    tag_name: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const latestVersion = latest.tag_name.replace(/^v/, "");
  if (latestVersion === options.currentVersion) return `Already at latest version ${latestVersion}`;

  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  // Inlined by scripts/build.ts: a glibc binary does not start on Alpine.
  const musl = process.env.AGENCY_LIBC === "musl" ? "-musl" : "";
  const assetName = `agency-${os}-${arch}${musl}${os === "windows" ? ".exe" : ""}`;
  const checksumName = "checksums-signed.txt";

  const baseUrl = `https://github.com/${REPO}/releases/download/v${latestVersion}`;
  const assetRes = await httpFetch(`${baseUrl}/${assetName}`);
  if (!assetRes.ok) throw new Error(`Failed to download ${assetName}: ${assetRes.status}`);
  const assetBuf = Buffer.from(await assetRes.arrayBuffer());

  // --- Step 1: ed25519 signature verification (PRIMARY) ---
  //
  // The release provides both checksums-signed.txt and per-asset .sig files.
  // We prefer the .sig file (raw 64-byte ed25519 signature) for simplicity.
  // If the .sig file is missing, we fall back to the inline signature in
  // checksums-signed.txt (for backward compatibility during transition).
  const sigRes = await httpFetch(`${baseUrl}/${assetName}.sig`);
  let sigVerified = false;
  if (sigRes.ok) {
    const sigBuf = Buffer.from(await sigRes.arrayBuffer());
    sigVerified = verifySignature(assetBuf, sigBuf);
  } else {
    // Fallback: try parsing inline signature from checksums-signed.txt
    const checksumRes = await httpFetch(`${baseUrl}/${checksumName}`);
    if (checksumRes.ok) {
      const checksumText = await checksumRes.text();
      const checksumLine = checksumText.split("\n").find((l) => l.includes(assetName));
      if (checksumLine) {
        const sigMatch = checksumLine.match(/ed25519:([A-Za-z0-9+/=]+)/);
        if (sigMatch?.[1]) {
          const sigBuf = Buffer.from(sigMatch[1], "base64");
          sigVerified = verifySignature(assetBuf, sigBuf);
        }
      }
    }
  }

  if (!sigVerified) {
    throw new Error(
      `Ed25519 signature verification failed for ${assetName}. ` +
        "The downloaded artifact may be tampered with or corrupted. " +
        "Refusing to install. " +
        "If you are on a development build, ensure AGENCY_UPDATE_PUBLIC_KEY is set correctly.",
    );
  }

  // --- Step 2: SHA-256 checksum (SECONDARY) ---
  const checksumRes = await httpFetch(`${baseUrl}/${checksumName}`);
  if (!checksumRes.ok) throw new Error(`Failed to download checksums: ${checksumRes.status}`);
  const checksumText = await checksumRes.text();
  const expected = checksumText
    .split("\n")
    .find((l) => l.includes(assetName))
    ?.split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum for ${assetName} in manifest`);
  const actual = createHash("sha256").update(assetBuf).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);

  const tmpPath = `${binPath}.new`;
  writeFileSync(tmpPath, assetBuf, { mode: 0o755 });
  swapBinary(tmpPath, binPath, `${binPath}.previous`);
  return `Updated to ${latestVersion}`;
}

/** Puts `source` at `binPath`. Windows cannot overwrite a running executable but can rename it, so the old one moves aside first. */
function swapBinary(source: string, binPath: string, aside: string): void {
  if (existsSync(binPath)) renameSync(binPath, aside);
  try {
    renameSync(source, binPath);
  } catch (error) {
    if (existsSync(aside)) renameSync(aside, binPath);
    throw error;
  }
}
