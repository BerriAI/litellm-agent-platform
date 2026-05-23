// Resolve an agent's attached MCP server IDs → HarnessMcpServerSpec configs.
// Fetches server metadata from LiteLLM and constructs URLs for LiteLLM's MCP
// proxy. The harness uses its own LITELLM_API_KEY (vault-swapped) to call these
// endpoints — no credentials flow through the session body.
//
// Shared by the session-create path (finishBringUp) and the restart/recovery
// path (rehydrateSession) so both wire the same external MCP servers — keeping
// it in one place avoids the two paths drifting (restarted sessions silently
// losing their MCPs).
import { env } from "@/server/env";
import type { HarnessMcpServerSpec } from "@/server/types";

export async function resolveAgentMcpServers(
  serverIds: string[],
): Promise<{ specs: HarnessMcpServerSpec[]; warning: string | null }> {
  if (!serverIds || serverIds.length === 0) return { specs: [], warning: null };
  const litellmBase = env.LITELLM_API_BASE.replace(/\/+$/, "");
  try {
    const res = await fetch(`${litellmBase}/v1/mcp/server`, {
      headers: { Authorization: `Bearer ${env.LITELLM_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`resolveAgentMcpServers: LiteLLM returned ${res.status}`);
      return { specs: [], warning: "MCP server list unavailable — tools may be missing. LiteLLM returned an error." };
    }
    const servers = (await res.json()) as Array<{
      server_id: string;
      server_name: string;
      alias?: string;
    }>;
    const byId = new Map(servers.map((s) => [s.server_id, s]));
    const specs: HarnessMcpServerSpec[] = [];
    for (const id of serverIds) {
      const s = byId.get(id);
      if (!s) continue;
      const name = s.alias || s.server_name;
      specs.push({
        name,
        url: `${litellmBase}/mcp/${encodeURIComponent(name)}`,
        transport: "http",
      });
    }
    return { specs, warning: null };
  } catch (err) {
    console.warn(`resolveAgentMcpServers: fetch failed — ${err instanceof Error ? err.message : String(err)}`);
    return { specs: [], warning: "MCP tools could not be loaded (LiteLLM unreachable). The session was created without them." };
  }
}

// Extract the agent's attached MCP server IDs from its (loosely-typed) row.
export function agentMcpServerIds(agent: { mcp_servers?: unknown }): string[] {
  return Array.isArray(agent.mcp_servers)
    ? (agent.mcp_servers as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
}
