/**
 * /api/v1/managed_agents/sessions/{session_id}/mcp/{server}
 *
 * Platform MCP broker. The agent's harness points its external MCP clients
 * here (with a scoped per-agent token, scope "mcp") instead of straight at the
 * LiteLLM gateway. The platform:
 *   1. resolves the session's agent,
 *   2. enforces that {server} is in that agent's allow-list (its mcp_servers),
 *   3. proxies the MCP JSON-RPC to ${LITELLM_API_BASE}/mcp/{server} with the
 *      gateway key held SERVER-SIDE,
 *   4. streams the response back.
 *
 * Net: the gateway key never reaches the agent, and the agent can only reach
 * the MCP servers explicitly attached to it. This is the brokered half of the
 * "one platform MCP surface" model (native MCPs like memory are served here too,
 * e.g. /sessions/{id}/memory).
 */

import { assertAgentScopeOrMaster } from "@/server/auth";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { httpError, HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string; server: string }>;
}

/** The agent for a session, plus the MCP server ids attached to it. */
async function sessionAgentAndServers(
  session_id: string,
): Promise<{ agent_id: string; serverIds: string[] }> {
  const row = await prisma.session.findUnique({
    where: { session_id },
    select: { agent: { select: { agent_id: true, mcp_servers: true } } },
  });
  if (row === null || row.agent === null) httpError(404, `session '${session_id}' not found`);
  const ids = Array.isArray(row.agent.mcp_servers)
    ? (row.agent.mcp_servers as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return { agent_id: row.agent.agent_id, serverIds: ids };
}

type GatewayServer = { server_id: string; server_name: string; alias?: string };

// The gateway's server list (id<->name) changes only when an operator edits
// agent config, so cache it briefly instead of hitting the gateway on every
// MCP call (initialize + tools/list + each tools/call). On fetch error we
// reuse the last good list rather than failing closed.
let _serverCache: { at: number; servers: GatewayServer[] } | null = null;
const SERVER_LIST_TTL_MS = 60_000;
async function gatewayServers(): Promise<GatewayServer[]> {
  if (_serverCache && Date.now() - _serverCache.at < SERVER_LIST_TTL_MS) return _serverCache.servers;
  const base = env.LITELLM_API_BASE.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/mcp/server`, {
      headers: { Authorization: `Bearer ${env.LITELLM_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return _serverCache?.servers ?? [];
    const servers = (await res.json()) as GatewayServer[];
    _serverCache = { at: Date.now(), servers };
    return servers;
  } catch {
    return _serverCache?.servers ?? [];
  }
}

/** True if `serverName` maps (by id, not spoofable name) to an attached server. */
function allows(serverName: string, serverIds: string[], servers: GatewayServer[]): boolean {
  if (serverIds.length === 0) return false;
  const allowed = new Set(serverIds);
  return servers.some((s) => (s.alias || s.server_name) === serverName && allowed.has(s.server_id));
}

async function broker(req: Request, ctx: RouteContext): Promise<Response> {
  const { session_id, server } = await ctx.params;

  // 1. Authenticate BEFORE any DB access — otherwise an unauthenticated caller
  //    could probe session existence via 404-vs-401. The token carries agent_id
  //    as a signed claim; we bind it to the session below.
  const id = assertAgentScopeOrMaster(req, "mcp");

  // 2. Resolve the session's agent + its attached MCP servers.
  const { agent_id, serverIds } = await sessionAgentAndServers(session_id);

  // 3. An agent token must belong to THIS session's agent (master key bypasses).
  if (id.source === "agent" && id.agent_id !== agent_id) {
    httpError(403, "token does not match this session's agent");
  }

  // 4. Allow-list by id (cached gateway server list).
  if (!allows(server, serverIds, await gatewayServers())) {
    httpError(403, `MCP server '${server}' is not attached to this agent`);
  }

  console.log(`[mcp-broker] session=${session_id} agent=${agent_id} server=${server} -> gateway (key held server-side)`);

  // Proxy to the gateway with the real key — held only here, never sent to the
  // agent. Preserve method/body so the full MCP handshake passes through.
  const base = env.LITELLM_API_BASE.replace(/\/+$/, "");
  const upstream = await fetch(`${base}/mcp/${encodeURIComponent(server)}`, {
    method: req.method,
    headers: {
      "content-type": req.headers.get("content-type") ?? "application/json",
      accept: req.headers.get("accept") ?? "application/json, text/event-stream",
      Authorization: `Bearer ${env.LITELLM_API_KEY}`,
    },
    ...(req.method !== "GET" && req.method !== "HEAD"
      ? { body: req.body, duplex: "half" }
      : {}),
  } as RequestInit & { duplex?: "half" });

  // Stream the gateway's response (SSE or JSON) straight back to the harness.
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const sid = upstream.headers.get("mcp-session-id");
  if (sid) headers.set("mcp-session-id", sid);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    return await broker(req, ctx);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError) return Response.json({ error: e.detail }, { status: e.status });
    throw e;
  }
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    return await broker(req, ctx);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError) return Response.json({ error: e.detail }, { status: e.status });
    throw e;
  }
}
