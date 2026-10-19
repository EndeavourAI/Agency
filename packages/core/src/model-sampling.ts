/** The temperature that the vendor recommends for agentic coding (OpenCode `provider/transform.ts`, the Qwen3-Coder
 * model card); undefined leaves the provider's default. */
export function temperatureFor(model: string): number | undefined {
  const id = model.toLowerCase();
  if (/glm-4\.[67]|minimax-m2/.test(id)) return 1.0;
  if (id.includes("kimi-k2"))
    return ["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s)) ? 1.0 : 0.6;
  if (/qwen3?-coder/.test(id)) return 0.7;
  return undefined;
}
