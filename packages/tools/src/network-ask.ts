import { requireNetwork } from "@agency/guard";
import { t } from "@agency/i18n";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { ToolContext, ToolDeps } from "./contract.ts";

/**
 * The network limit of the sandbox holds for this tool too. Past it the user is asked for this one host, as `bash`
 * asks with `network: true`; else a sandbox with no network would leave the tool no way on. Returns why it is
 * refused, or undefined when the tool may go on.
 */
export async function networkOrAsk(
  deps: ToolDeps,
  tool: string,
  host: string,
  ctx: Pick<ToolContext, "requestApproval">,
): Promise<string | undefined> {
  try {
    requireNetwork(deps.identity, deps.capabilities, host);
    return undefined;
  } catch (error) {
    if (!(error instanceof AgencyError) || error.code !== ErrorCode.PERMISSION_DENIED) throw error;
    const answer = await ctx.requestApproval?.({
      tool,
      title: t("tool.network_ask", { tool, host }),
      command: `${tool} ${host}`,
      riskTier: "moderate",
      source: "sandbox:network",
    });
    return answer === "once" || answer === "always" ? undefined : t("tool.network_refused", { host });
  }
}
