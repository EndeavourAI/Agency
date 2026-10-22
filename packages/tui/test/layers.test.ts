import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The framework-free layers must stay importable without a terminal: this fails when one reaches for the renderer. */
const SRC = join(import.meta.dir, "..", "src");
const PURE = ["client", "state", "input", "render-model", "controller"];
const BANNED = [/^@opentui\//, /^solid-js(\/|$)/, /^bun:ffi$/, /\/(term|view)\//];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  return found;
}

describe("layer boundaries", () => {
  for (const layer of PURE) {
    test(`${layer}/ imports no terminal or UI framework`, () => {
      const offenders: string[] = [];
      for (const file of files(join(SRC, layer))) {
        for (const spec of specifiers(readFileSync(file, "utf8"))) {
          if (BANNED.some((re) => re.test(spec))) offenders.push(`${file}: ${spec}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  test("the check sees a banned import", () => {
    expect(specifiers(`import { x } from "@opentui/core";\nawait import("solid-js")`)).toEqual([
      "@opentui/core",
      "solid-js",
    ]);
  });
});
