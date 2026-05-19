/**
 * Inbound + outbound glue between integrations and LAP sessions.
 *
 * Inbound (webhook → LAP):
 *   raw POST → handleInbound(integration_id, req):
 *     1. Find the provider in the registry.
 *     2. Parse the JSON body, ask the provider which workspace it belongs
 *        to, look up IntegrationInstall.
 *     3. Provider verifies the signature against the install's secret.
 *     4. Provider translates the payload into a canonical IntegrationEvent.
 *     5. Dispatch:
 *          new_task → ack with a "thought" activity (Linear has a 10s
 *                     window), then async-spawn a LAP Session and write an
 *                     IntegrationSession row.
 *          followup → look up IntegrationSession by external_session_id,
 *                     forward the body to the existing LAP Session.
 *          cancel   → mark the LAP Session dead.
 *
 * Outbound (LAP session event → webhook):
 *   forwardSessionEvent(session_id, event):
 *     1. Look up IntegrationSession by session_id.
 *     2. Resolve provider + install + agent through the binding join.
 *     3. Call provider.onSessionEvent(...).
 *
 * Session create/send are delegated to the existing v1 routes via an
 * in-process fetch authenticated with the server's MASTER_KEY. That avoids
 * duplicating the warm-pool claim + cold-fallback logic in this file. When
 * those routes are someday factored into a server-side helper, swap the
 * fetches for direct calls.
 */

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { getProvider } from "./registry";
import type {
  Integration,
  IntegrationAttachment,
  IntegrationEvent,
  SessionEvent,
} from "./types";

/**
 * Messaging-style integrations reuse a conversation after this many ms of
 * idleness. Past that, a fresh LAP session is spawned. Matches the platform's
 * own session reaper window so we don't try to send into a sandbox the
 * reconciler has already torn down.
 */
const MESSAGING_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface ParsedRequest {
  raw: Buffer;
  json: unknown;
}

async function readBody(req: Request): Promise<ParsedRequest | null> {
  const raw = Buffer.from(await req.arrayBuffer());
  try {
    return { raw, json: JSON.parse(raw.toString("utf8")) };
  } catch {
    return null;
  }
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleInbound(
  integrationId: string,
  req: Request,
): Promise<Response> {
  const integration = getProvider(integrationId);
  if (!integration) return errorResponse(404, "unknown integration");

  const body = await readBody(req);
  if (!body) return errorResponse(400, "invalid json");

  const workspaceId = integration.webhook.workspaceIdFromPayload(body.json);
  if (!workspaceId) return errorResponse(400, "could not resolve workspace");

  const install = await prisma.integrationInstall.findUnique({
    where: {
      integration_id_workspace_id: {
        integration_id: integration.id,
        workspace_id: workspaceId,
      },
    },
  });
  if (!install) return errorResponse(404, "install not found");

  const verified = await integration.webhook.verify(
    body.raw,
    req.headers,
    install,
  );
  if (!verified) return errorResponse(401, "bad signature");

  // Providers can resolve auth-gated side content (e.g. Slack file URLs that
  // need the bot token to download) inside `parse`, so the return value may
  // be a Promise. Await unconditionally to handle both shapes.
  const event = await integration.webhook.parse(body.json, install);

  if (event.kind === "ignore") {
    return new Response(null, { status: 204 });
  }

  if (event.kind === "new_task") {
    const binding = await prisma.agentIntegrationBinding.findFirst({
      where: { install_id: install.install_id, enabled: true },
      include: { agent: true },
    });
    if (!binding) {
      return errorResponse(404, "no agent bound to this install");
    }

    // ACK inside the medium's deadline (Linear: 10s). The session spawn
    // below is fire-and-forget so we don't block this response.
    await integration.onSessionEvent({
      install,
      externalSessionId: event.external_session_id,
      event: {
        type: "thought",
        body: `Picking up ${event.external_ref ?? "task"}.`,
      },
      agent: binding.agent,
    });

    void spawnSessionForEvent({
      integration,
      install_id: install.install_id,
      binding_id: binding.binding_id,
      external_session_id: event.external_session_id,
      external_ref: event.external_ref ?? null,
      agent_id: binding.agent.agent_id,
      prompt: event.prompt,
      attachments: event.attachments,
    });

    return new Response(null, { status: 202 });
  }

  if (event.kind === "followup") {
    const ext = await prisma.integrationSession.findUnique({
      where: { external_session_id: event.external_session_id },
    });
    if (!ext) return errorResponse(404, "no session for that external id");

    void sendFollowupToSession({ session_id: ext.session_id, body: event.body });
    return new Response(null, { status: 202 });
  }

  if (event.kind === "message") {
    return handleMessage({ integration, install, event });
  }

  if (event.kind === "cancel") {
    const ext = await prisma.integrationSession.findUnique({
      where: { external_session_id: event.external_session_id },
    });
    if (ext) {
      await prisma.session
        .update({
          where: { session_id: ext.session_id },
          data: { status: "dead", stopped_at: new Date() },
        })
        .catch(() => {
          /* best-effort */
        });
    }
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Outbound: forward a LAP SessionEvent to whatever integration delegated it.
// ---------------------------------------------------------------------------

export async function forwardSessionEvent(
  session_id: string,
  event: SessionEvent,
): Promise<void> {
  // Absorb the race with spawnSessionForEvent: the IntegrationSession row is
  // written only after the v1 session create returns, so an outbound harness
  // event in that gap would otherwise silently drop. Retry the lookup for up
  // to ~500ms before giving up.
  let ext: Awaited<ReturnType<typeof findIntegrationSession>> = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    ext = await findIntegrationSession(session_id);
    if (ext) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ext) {
    console.warn(
      `[integrations/dispatcher] no IntegrationSession for session_id=${session_id}; event dropped`,
    );
    return; // session didn't originate from an integration, or row never landed
  }

  const integration = getProvider(ext.binding.install.integration_id);
  if (!integration) return;

  await integration.onSessionEvent({
    install: ext.binding.install,
    externalSessionId: ext.external_session_id,
    event,
    agent: ext.binding.agent,
  });
}

function findIntegrationSession(session_id: string) {
  return prisma.integrationSession.findUnique({
    where: { session_id },
    include: {
      binding: { include: { install: true, agent: true } },
    },
  });
}

/**
 * Resolve the public LAP URL for an agent's dashboard page. Prefers
 * `LAP_BASE_URL` (the external https URL the UI is served from) and falls
 * back to `BASE_URL`. Returns `null` if neither is set so callers can omit
 * the link rather than dropping a `http://localhost:3000/...` URL into a
 * production Slack channel.
 */
function buildAgentDashboardUrl(agent_id: string): string | null {
  const base = process.env.LAP_BASE_URL || process.env.BASE_URL;
  if (!base) return null;
  const host = base.replace(/\/+$/, "");
  return `${host}/agents/${encodeURIComponent(agent_id)}`;
}

// ---------------------------------------------------------------------------
// Internal: spawn a LAP Session via the existing v1 route.
//
// v1 punts here instead of duplicating warm-pool + cold-fallback logic
// from src/app/api/v1/managed_agents/agents/[agent_id]/session/route.ts.
// The in-process fetch uses MASTER_KEY auth, same as the UI would.
// ---------------------------------------------------------------------------

interface SpawnInput {
  integration: Integration;
  install_id: string;
  binding_id: string;
  external_session_id: string;
  external_ref: string | null;
  agent_id: string;
  prompt: string;
  /** Image / file uploads to forward to the harness as multimodal parts. */
  attachments?: IntegrationAttachment[];
}

async function spawnSessionForEvent(input: SpawnInput): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/v1/managed_agents/agents/${encodeURIComponent(
    input.agent_id,
  )}/session`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MASTER_KEY}`,
      },
      body: JSON.stringify({
        initial_prompt: input.prompt,
        title: input.external_ref ?? "integration task",
        initial_attachments: input.attachments,
      }),
    });
    if (!res.ok) {
      throw new Error(`session create failed: ${res.status} ${await res.text()}`);
    }
    // The v1 session-create route returns the new row keyed by `id`
    // (`toApiSession` renames `session_id` → `id`). Read the canonical
    // field rather than the DB column name.
    const session = (await res.json()) as { id: string };
    await prisma.integrationSession.create({
      data: {
        external_session_id: input.external_session_id,
        session_id: session.id,
        binding_id: input.binding_id,
        external_ref: input.external_ref,
      },
    });
    // The session create endpoint returns immediately with status=creating;
    // the initial_prompt is processed once the pod is up. Poll for the
    // resulting Session.response and forward it to the integration so the
    // user actually gets the agent's answer back in their medium.
    void pollAndForwardInitialResponse(session.id);
  } catch (err) {
    console.error("[integrations/dispatcher] spawn failed:", err);
    // Surface the failure to the medium so the user isn't left hanging.
    const reason = err instanceof Error ? err.message : String(err);
    const install = await prisma.integrationInstall.findUnique({
      where: { install_id: input.install_id },
    });
    if (install) {
      await input.integration
        .onSessionEvent({
          install,
          externalSessionId: input.external_session_id,
          event: { type: "error", body: `Failed to start session: ${reason}` },
          // No binding row was fetched on this path — the spawn failure
          // happens after we already know the agent_id but before we
          // refetch the agent row. Providers that need the agent on
          // error events should guard the optional field.
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }
}

async function sendFollowupToSession(args: {
  session_id: string;
  body: string;
  /**
   * Image / file uploads on the followup message. Dropped today: the
   * v1 `/sessions/{id}/message` endpoint is text-only. Tracked as a
   * follow-up — initial images on a new thread already cover the primary
   * Slack use case; in-thread image followups land in a v2 PR.
   */
  attachments?: IntegrationAttachment[];
}): Promise<void> {
  if (args.attachments && args.attachments.length > 0) {
    console.warn(
      `[integrations/dispatcher] dropping ${args.attachments.length} attachment(s) on followup — not yet supported on the message endpoint`,
    );
  }
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/v1/managed_agents/sessions/${encodeURIComponent(
    args.session_id,
  )}/message`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MASTER_KEY}`,
      },
      body: JSON.stringify({ text: args.body }),
    });
    if (!res.ok) {
      throw new Error(`followup failed: ${res.status} ${await res.text()}`);
    }
    // /sessions/:id/message returns the harness reply synchronously. Pipe it
    // back to the originating integration so the user sees the answer.
    const reply = (await res.json()) as unknown;
    const text = extractTextFromHarnessReply(reply);
    if (text) {
      await forwardSessionEvent(args.session_id, {
        type: "response",
        body: text,
      });
    }
  } catch (err) {
    console.error("[integrations/dispatcher] followup failed:", err);
    await forwardSessionEvent(args.session_id, {
      type: "error",
      body: err instanceof Error ? err.message : String(err),
    }).catch(() => {
      /* best-effort */
    });
  }
}

// ---------------------------------------------------------------------------
// Messaging-style mediums (Slack, …): one webhook arrives, we figure out from
// IntegrationSession existence + TTL whether to spawn or follow up.
// ---------------------------------------------------------------------------

async function handleMessage(input: {
  integration: Integration;
  install: Awaited<ReturnType<typeof prisma.integrationInstall.findUnique>>;
  event: Extract<IntegrationEvent, { kind: "message" }>;
}): Promise<Response> {
  const { integration, install, event } = input;
  if (!install) return errorResponse(404, "install not found");

  // Fast-path UX: drop a `:eyes:` reaction on the user's message before
  // we do any DB work or session bring-up. Fires fully in parallel — the
  // dispatcher returns 202 in <200ms whether or not Slack's API answers
  // promptly. `agent` is intentionally omitted because the binding lookup
  // hasn't happened yet; SessionEventContext.agent is now optional and
  // the Slack/Linear `react` handlers don't touch it.
  void integration
    .onSessionEvent({
      install,
      externalSessionId: event.external_session_id,
      event: {
        type: "react",
        emoji: "eyes",
        anchor: event.original_ts ? { ts: event.original_ts } : undefined,
      },
    })
    .catch((err) => {
      console.warn(
        `[integrations/dispatcher] react ack failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  // Reusable session lookup. We pull the linked Session so we can check
  // status + last_seen_at without a second round trip.
  const existing = await prisma.integrationSession.findUnique({
    where: { external_session_id: event.external_session_id },
    include: { session: true },
  });
  const reusable = isReusableSession(existing?.session);

  if (existing && reusable) {
    // Same conversation — POST as a follow-up to the live LAP session.
    void sendFollowupToSession({
      session_id: existing.session_id,
      body: event.prompt,
      attachments: event.attachments,
    });
    return new Response(null, { status: 202 });
  }

  // No existing session, or the prior one is stale/dead. Start fresh.
  const binding = await prisma.agentIntegrationBinding.findFirst({
    where: { install_id: install.install_id, enabled: true },
    include: { agent: true },
  });
  if (!binding) {
    return errorResponse(404, "no agent bound to this install");
  }

  // Text ack in-thread, fire-and-forget. Lets the user see we picked up
  // the work before the sandbox finishes bring-up (~10-60s on a cold
  // start). We have `binding.agent` here so the provider can build a
  // link to the agent / session page.
  const agentUrl = buildAgentDashboardUrl(binding.agent.agent_id);
  void integration
    .onSessionEvent({
      install,
      externalSessionId: event.external_session_id,
      event: {
        type: "thought",
        body: "Setting up an agent session.",
        externalUrls: agentUrl
          ? [{ url: agentUrl, label: "Open in LAP" }]
          : undefined,
      },
      agent: binding.agent,
    })
    .catch((err) => {
      console.warn(
        `[integrations/dispatcher] thought ack failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  if (existing && !reusable) {
    // Drop the stale row so the unique constraint on external_session_id
    // doesn't block the upcoming `integrationSession.create` for the new
    // LAP session. The orphan Session row stays — the reconciler reaps it.
    await prisma.integrationSession
      .delete({ where: { external_session_id: event.external_session_id } })
      .catch(() => {
        /* best-effort — concurrent webhook may have raced us */
      });
  }

  void spawnSessionForEvent({
    integration,
    install_id: install.install_id,
    binding_id: binding.binding_id,
    external_session_id: event.external_session_id,
    external_ref: event.external_ref ?? null,
    agent_id: binding.agent.agent_id,
    prompt: event.prompt,
    attachments: event.attachments,
  });

  return new Response(null, { status: 202 });
}

function isReusableSession(
  session: { status?: string; last_seen_at?: Date | null; created_at?: Date } | null | undefined,
): boolean {
  if (!session?.status) return false;
  if (session.status !== "ready") return false;
  const lastActivity =
    session.last_seen_at?.getTime() ?? session.created_at?.getTime();
  if (!lastActivity) return false;
  return Date.now() - lastActivity < MESSAGING_SESSION_TTL_MS;
}

// ---------------------------------------------------------------------------
// Response polling: the session create endpoint runs bring-up asynchronously
// and returns a `creating` row immediately. The agent's reply to the initial
// prompt lands in `Session.response` once bring-up + the first harness round
// trip both complete. We poll for it and emit a `response` SessionEvent so
// the originating integration can post the answer back to the user.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 5 * 60_000;

async function pollAndForwardInitialResponse(
  session_id: string,
): Promise<void> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const row = await prisma.session.findUnique({
      where: { session_id },
      select: { status: true, response: true, failure_reason: true },
    });
    if (!row) return; // session was deleted under us
    if (row.status === "failed") {
      await forwardSessionEvent(session_id, {
        type: "error",
        body: row.failure_reason ?? "session failed to start",
      }).catch(() => {
        /* best-effort */
      });
      return;
    }
    if (row.status === "dead") return; // stopped externally
    if (row.response) {
      const text = extractTextFromHarnessReply(row.response);
      if (text) {
        await forwardSessionEvent(session_id, {
          type: "response",
          body: text,
        }).catch(() => {
          /* best-effort */
        });
        return;
      }
    }
  }
  // Hit the 5-minute cap. Tell the user instead of silently giving up.
  await forwardSessionEvent(session_id, {
    type: "error",
    body: "Agent didn't reply within 5 minutes.",
  }).catch(() => {
    /* best-effort */
  });
}

/**
 * Pull the assistant's text out of a HarnessMessageResponse (or the row JSON
 * snapshot). The harness reply shape is `{ parts: [{ type, text? }, ...] }`;
 * we concatenate every `text` part in order. Returns null if the blob has no
 * extractable text (e.g. only tool-call parts).
 */
function extractTextFromHarnessReply(reply: unknown): string | null {
  if (!reply || typeof reply !== "object") return null;
  const r = reply as { parts?: unknown };
  if (!Array.isArray(r.parts)) return null;
  const chunks: string[] = [];
  for (const part of r.parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      chunks.push(p.text);
    }
  }
  if (chunks.length === 0) return null;
  return chunks.join("\n").trim() || null;
}
