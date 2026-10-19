import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, dataDir, type ProviderConfig, parseModelRef } from "@agency/core";
import type { HttpClient } from "@agency/net";
import {
  BUILTIN_MODELS,
  fetchOpenRouterModels,
  GATEWAY_BASE_URLS,
  loadCachedCatalog,
  loadCachedModelsDevCatalog,
  type ModelInfo,
  mergeCatalogWithConfig,
} from "@agency/providers";

/** Model metadata: on-disk cache or build-time snapshot, plus what a gateway's own list says, plus config overrides. */
export interface ModelCatalog {
  listModels: () => ModelInfo[];
  catalogModel: (provider: string, model: string) => ModelInfo | undefined;
  resolveAgentModel: (provider: string, model?: string) => string;
  /** Reads the model list of OpenRouter when the catalog does not know one of its models. */
  learnModel: (provider: string, model: string, http: HttpClient) => Promise<void>;
}

/** A turn waits at most this long for the model list. */
const LEARN_TIMEOUT_MS = 4000;
/** A saved list older than this is read again in the background. */
const LEARNED_TTL_MS = 86_400_000;

// Live: each headless run's new daemon waited 0.23 to 0.32 s for OpenRouter's 787 KB list before its first request.
const learnedPath = (): string => join(dataDir(), "cache", "openrouter-models.json");
function savedModels(): ModelInfo[] {
  try {
    return (JSON.parse(readFileSync(learnedPath(), "utf8")) as { models: ModelInfo[] }).models;
  } catch {
    return [];
  }
}
function savedIsFresh(): boolean {
  try {
    return Date.now() - statSync(learnedPath()).mtimeMs < LEARNED_TTL_MS;
  } catch {
    return false;
  }
}

export function createModelCatalog(providers: Record<string, ProviderConfig>, config: Config): ModelCatalog {
  let base: readonly ModelInfo[] | undefined;
  let mergedCatalog: ModelInfo[] | undefined;
  const ensureCatalog = (): ModelInfo[] => {
    if (!mergedCatalog) {
      base ??= [...(loadCachedCatalog(join(dataDir(), "cache"))?.models ?? BUILTIN_MODELS), ...savedModels()];
      mergedCatalog = mergeCatalogWithConfig(base, providers);
    }
    return mergedCatalog;
  };
  // The levels come from models.dev, which the picker shows. Its limits do not: the base entry's stay.
  const catalogModel = (provider: string, model: string): ModelInfo | undefined => {
    const found = ensureCatalog().find((m) => m.id === model && m.family === provider);
    if (!found || found.efforts) return found;
    const efforts = loadCachedModelsDevCatalog(join(dataDir(), "cache"))?.models.find(
      (m) => m.id === model && m.family === provider,
    )?.efforts;
    return efforts ? { ...found, efforts } : found;
  };
  const resolveAgentModel = (provider: string, model?: string): string => {
    if (model) return model;
    const ref = parseModelRef(config.model ?? "");
    if (ref && ref.provider === provider) return ref.model;
    const first = ensureCatalog().find((m) => m.family === provider);
    return first?.id ?? "";
  };
  // One read for the life of the daemon. After a failure the defaults stay: a turn must not wait a second time.
  let learned: Promise<void> | undefined;
  const learnModel = (provider: string, model: string, http: HttpClient): Promise<void> => {
    if (provider !== "openrouter") return Promise.resolve();
    const known = catalogModel(provider, model) !== undefined;
    if (known && savedIsFresh()) return Promise.resolve();
    const baseUrl = providers.openrouter?.baseUrl ?? GATEWAY_BASE_URLS.openrouter ?? "";
    learned ??= fetchOpenRouterModels(http, baseUrl, AbortSignal.timeout(LEARN_TIMEOUT_MS))
      .then((models) => {
        base = [...(loadCachedCatalog(join(dataDir(), "cache"))?.models ?? BUILTIN_MODELS), ...models];
        mergedCatalog = undefined;
        try {
          mkdirSync(join(dataDir(), "cache"), { recursive: true });
          writeFileSync(learnedPath(), JSON.stringify({ savedAt: new Date().toISOString(), models }));
        } catch {}
      })
      .catch(() => {});
    // A known model does not wait for a stale list to be read again.
    return known ? Promise.resolve() : learned;
  };
  return { listModels: () => ensureCatalog(), catalogModel, resolveAgentModel, learnModel };
}
