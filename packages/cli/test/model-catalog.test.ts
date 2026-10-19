import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { createModelCatalog } from "../src/daemon/model-catalog.ts";

const home = process.env.AGENCY_HOME;
const dirs: string[] = [];
afterEach(() => {
  if (home === undefined) delete process.env.AGENCY_HOME;
  else process.env.AGENCY_HOME = home;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ID = "poolside/laguna-s-2.1";
function counting(): { http: HttpClient; downloads: () => number } {
  let downloads = 0;
  const body = {
    data: [
      { id: ID, context_length: 1_048_576, pricing: { prompt: "0.00000009", completion: "0.00000018" } },
    ],
  };
  return {
    http: {
      fetch: async () => {
        downloads += 1;
        return Response.json(body);
      },
    },
    downloads: () => downloads,
  };
}

test("a model that a daemon learned from OpenRouter's list is known to the next daemon at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agency-learn-"));
  dirs.push(dir);
  process.env.AGENCY_HOME = dir;
  const net = counting();

  const first = createModelCatalog({}, {} as never);
  await first.learnModel("openrouter", ID, net.http);
  expect(first.catalogModel("openrouter", ID)?.contextWindow).toBe(1_048_576);

  // Live: every headless run started a daemon that waited 0.23 to 0.32 s for this 787 KB list before its first request.
  const next = createModelCatalog({}, {} as never);
  expect(next.catalogModel("openrouter", ID)?.contextWindow).toBe(1_048_576);
  await next.learnModel("openrouter", ID, net.http);
  expect(net.downloads()).toBe(1);

  // A list older than a day is read again, but the turn does not wait for it.
  const old = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(join(dir, "data", "cache", "openrouter-models.json"), old, old);
  const later = createModelCatalog({}, {} as never);
  await later.learnModel("openrouter", ID, net.http);
  await Bun.sleep(50);
  expect(net.downloads()).toBe(2);
});
