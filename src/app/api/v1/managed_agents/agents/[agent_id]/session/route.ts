/**
 * POST /api/v1/managed_agents/agents/{agent_id}/session
 *
 * Two paths:
 *
 *   warm  — claim a pre-provisioned Fargate task from the pool and run only
 *           the harness handshake (~5s on the happy path).
 *   cold  — fall through to the original RunTask + waits + harness flow
 *           (~30s-8min). Used when the pool is disabled
 *           (`WARM_POOL_SIZE=0`), drained, has no warm task for this
 *           agent's config, or the request carries per-session `env_vars`
 *           that wouldn't be in a warm task's container env.
 *
 * The handler returns the `creating` Session row immediately (~50ms) and
 * runs the bring-up fire-and-forget in the background. The UI polls
 * /sessions/{id} for the `ready` (or `failed`) flip — so a slow cold path
 * doesn't block the response and the user sees the session page right away
 * with a live progress indicator instead of a spinner on the agent page.
 *
 * Either path persists the `creating` row up front so an in-flight failure
 * leaves an auditable row rather than a silently orphaned task. Background
 * failures flip status to `failed` with `failure_reason`.
 *
 * Cold-path bring-up is ported from
 * litellm/proxy/managed_agents_endpoints/endpoints_sessions.py:create_session
 * but stripped of the multi-tenant key minting that lives in the upstream
 * Python proxy.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { parseAttachedSkillIds } from "@/server/skill-prompt";
import {
  buildSkillSandboxFiles,
  getInlineHarnessPodUrl,
  inlineHarnessUrl,
  runTask,
  waitHttpReady,
  waitRunningGetUrl,
} from "@/server/k8s";
import { putCachedSession } from "@/server/sessionCache";
import {
  appendUserMessage,
  completeAssistantMessage,
} from "@/server/sessionStore";
import {
  expandMessage,
  harnessCreateSession,
  harnessListMessages,
  harnessSendMessage,
  prependAgentSystemPrompt,
} from "@/server/harness";
import {
  CreateSessionBody,
  HARNESS_OPENCODE,
  HARNESS_OPENCODE_BRAIN_INLINE,
  inlineHarnessUrlEnv,
  isInlineHarness,
  HttpError,
  httpError,
  toApiSession,
  type AgentRow,
  type HarnessMessageResponse,
  type HarnessMcpServerSpec,
  type SessionRow,
  type WarmTaskRow,
} from "@/server/types";
import {
  claimWarmTask,
  deleteClaimedWarmTask,
  markClaimedTaskDead,
  topUpWarmPool,
} from "@/server/warmPool";
import { safeStopTask } from "@/server/reconcile";
import { wrap } from "@/server/route-helpers";
import { registry } from "@/server/metrics";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

interface BringUpResult {
  updated: SessionRow;
  response: HarnessMessageResponse | null;
}

interface InitialAttachment {
  name?: string;
  mime_type: string;
  base64: string;
}

interface BringUpBody {
  initial_prompt?: string;
  title?: string;
  env_vars?: Record<string, string>;
  initial_attachments?: InitialAttachment[];
  /** Extra skill IDs to inject into the sandbox for this session only. */
  skill_ids?: string[];
}

// ---------------------------------------------------------------------------
// Resolve agent MCP server IDs → HarnessMcpServerSpec configs.
// Fetches server metadata from LiteLLM and constructs URLs for LiteLLM's
// MCP proxy. The harness uses its own LITELLM_API_KEY (vault-swapped) to
// call these endpoints — no credentials flow through the session body.
// ---------------------------------------------------------------------------

async function resolveAgentMcpServers(
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

// ---------------------------------------------------------------------------
// Maps a spawn error to a short Prometheus label value for session_spawn_failure_total.
// ---------------------------------------------------------------------------

function classifySpawnError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes("cni") || msg.includes("ip exhaustion")) return "cni_exhaustion";
  if (msg.includes("never reached running")) return "pod_timeout";
  if (msg.includes("never ready at")) return "harness_timeout";
  if (msg.includes("pod") && msg.includes("failed")) return "pod_failed";
  if (msg.includes("imagepull") || msg.includes("image pull")) return "image_pull";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Phase marker. Writes the current bring-up phase onto the Session row so the
// UI can render a real progress indicator instead of the wall-clock-driven
// approximation from PR #34. Best-effort: a phase write must never break the
// bring-up itself, so all errors are swallowed (and logged at warn level so a
// systemic DB failure is still visible in the operator logs).
// ---------------------------------------------------------------------------

async function setPhase(
  session_id: string,
  phase: string,
  detail?: string,
): Promise<void> {
  try {
    await prisma.session.update({
      where: { session_id },
      data: { phase, phase_detail: detail ?? null },
    });
  } catch (e) {
    console.warn(
      `setPhase(${session_id}, ${phase}) failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Background bring-up orchestrator.
//
// Wraps the warm/cold + fallback dance that used to live inline in the POST
// handler. Called fire-and-forget so the HTTP response can return the
// `creating` Session row in ~50ms instead of waiting 30s-8min for the
// sandbox to spin up. The UI polls /sessions/{id} for the status flip.
//
// Failures (warm + cold both dead, harness unreachable, network) flip the
// Session row to `failed` with the reason so the client can render it.
// We log too — a silent fire-and-forget is impossible to debug.
// ---------------------------------------------------------------------------

async function runBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  warm: WarmTaskRow | null,
): Promise<void> {
  try {
    let result: BringUpResult;
    if (warm) {
      try {
        result = await warmBringUp(agent, session_id, body, warm);
      } catch (warmErr) {
        // Warm task was claimed but its harness is unreachable (stale
        // sandbox_url, dead container, network drift, etc). Don't bubble
        // the failure to the user — kill the warm row and fall through to
        // a cold spawn. The user pays a slower start instead of a failure.
        const reason =
          warmErr instanceof Error ? warmErr.message : String(warmErr);
        console.warn(
          `warm bring-up failed for warm_task_id=${warm.warm_task_id}: ${reason}; falling back to cold spawn`,
        );
        await markClaimedTaskDead(
          warm.warm_task_id,
          `warm bring-up failed: ${reason}`,
        );
        // Reset the half-claimed Session row so coldBringUp's own
        // claim/update doesn't trip on stale warm fields.
        await prisma.session.update({
          where: { session_id },
          data: { task_arn: null, sandbox_url: null },
        });
        result = await coldBringUp(agent, session_id, body);
      }
    } else {
      result = await coldBringUp(agent, session_id, body);
    }

    // Hand-off succeeded — the Session row owns the ECS task now. Removing
    // the warm row prevents the reconciler from double-stopping it. (Only
    // applies on the success-from-warm path; the fallback already marked it
    // dead, so deleting again is a no-op.)
    if (warm) await deleteClaimedWarmTask(warm.warm_task_id).catch(() => {});

    // Discard the result — the route already returned; the UI polls
    // /sessions/{id} for the `ready` flip.
    void result;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `session create failed: session_id=${session_id} agent_id=${agent.agent_id} reason=${reason}`,
    );
    // Stop the underlying pod so it doesn't sit idle for 24h
    const row = await prisma.session.findUnique({ where: { session_id }, select: { task_arn: true } }).catch(() => null);
    if (row?.task_arn) void safeStopTask(row.task_arn, "session bring-up failed").catch(() => {});
    await prisma.session
      .update({
        where: { session_id },
        data: { status: "failed", failure_reason: reason },
      })
      .catch((dbErr) => {
        // Last-ditch DB write failed — there's nowhere else to surface this,
        // so just log loudly. The orphan reconciler will eventually GC the
        // stuck row.
        console.error(
          `failed to mark session ${session_id} as failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      });
  }
}

// ---------------------------------------------------------------------------
// Cold path — RunTask + waits + harness session.
// ---------------------------------------------------------------------------

async function coldBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
): Promise<BringUpResult> {
  const spawnStart = Date.now();
  try {
    const rawSandboxFiles = (agent as Record<string, unknown>).sandbox_files;
    const sandboxFiles = Array.isArray(rawSandboxFiles)
      ? (rawSandboxFiles as import("@/server/types").SandboxFileSpec[])
      : [];

    // Local dev bypass: skip K8s entirely and use the local harness directly.
    if (env.LOCAL_SANDBOX_URL) {
      console.log(`[local-dev] bypassing K8s, using LOCAL_SANDBOX_URL=${env.LOCAL_SANDBOX_URL}`);
      await setPhase(session_id, "waiting_harness");
      await waitHttpReady(env.LOCAL_SANDBOX_URL);
      await setPhase(session_id, "harness_ready");
      const result = await finishBringUp(agent, session_id, body, env.LOCAL_SANDBOX_URL, sandboxFiles);
      registry.observe("session_spawn_duration_seconds", { path: "cold" }, (Date.now() - spawnStart) / 1000);
      registry.inc("session_spawn_total", { path: "cold", result: "success" });
      return result;
    }

    let t = Date.now();
    await setPhase(session_id, "creating_sandbox");
    const { task_arn } = await runTask({ agent, session_id, env_vars: body.env_vars });
    registry.observe("session_phase_duration_seconds", { phase: "creating_sandbox" }, (Date.now() - t) / 1000);

    await prisma.session.update({ where: { session_id }, data: { task_arn } });

    t = Date.now();
    await setPhase(session_id, "pod_pending");
    const sandbox_url = await waitRunningGetUrl(task_arn, agent);
    registry.observe("session_phase_duration_seconds", { phase: "pod_pending" }, (Date.now() - t) / 1000);

    await setPhase(session_id, "pod_running");

    t = Date.now();
    await setPhase(session_id, "waiting_harness");
    await waitHttpReady(sandbox_url);
    registry.observe("session_phase_duration_seconds", { phase: "waiting_harness" }, (Date.now() - t) / 1000);

    await setPhase(session_id, "harness_ready");
    const result = await finishBringUp(agent, session_id, body, sandbox_url, sandboxFiles);

    registry.observe("session_spawn_duration_seconds", { path: "cold" }, (Date.now() - spawnStart) / 1000);
    registry.inc("session_spawn_total", { path: "cold", result: "success" });
    return result;
  } catch (e) {
    registry.inc("session_spawn_total", { path: "cold", result: "failed" });
    registry.inc("session_spawn_failure_total", { path: "cold", reason: classifySpawnError(e) });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Warm path — task already running, just run the harness handshake.
// ---------------------------------------------------------------------------

async function warmBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  warm: WarmTaskRow,
): Promise<BringUpResult> {
  const spawnStart = Date.now();
  try {
    if (!warm.task_arn || !warm.sandbox_url) {
      throw new Error(
        `claimed warm task ${warm.warm_task_id} missing task_arn or sandbox_url`,
      );
    }
    await prisma.session.update({
      where: { session_id },
      data: { task_arn: warm.task_arn },
    });
    const rawWarmFiles = (agent as Record<string, unknown>).sandbox_files;
    const warmFiles = Array.isArray(rawWarmFiles)
      ? (rawWarmFiles as import("@/server/types").SandboxFileSpec[])
      : [];
    await setPhase(session_id, "harness_ready");
    const result = await finishBringUp(agent, session_id, body, warm.sandbox_url, warmFiles);

    registry.observe("session_spawn_duration_seconds", { path: "warm" }, (Date.now() - spawnStart) / 1000);
    registry.inc("session_spawn_total", { path: "warm", result: "success" });
    return result;
  } catch (e) {
    registry.inc("session_spawn_total", { path: "warm", result: "failed" });
    registry.inc("session_spawn_failure_total", { path: "warm", reason: classifySpawnError(e) });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Shared finish — same harness handshake for both paths.
// ---------------------------------------------------------------------------

async function finishBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  sandbox_url: string,
  files: import("@/server/types").SandboxFileSpec[] = [],
): Promise<BringUpResult> {
  // Approximation: by the time harnessCreateSession succeeds the container's
  // entrypoint has already cloned the repo. We surface `cloning_repo` here
  // so the UI shows *some* progress between harness_ready and the final
  // `ready` flip even when Phase 3's harness-side reports are unavailable
  // (e.g. PLATFORM_INTERNAL_URL unset, sandbox can't reach the platform).
  // When the harness *does* report, those writes happen earlier and this
  // line is effectively a no-op overwrite with the same value.
  await setPhase(session_id, "cloning_repo");
  const cloneStart = Date.now();
  const skillFiles = body.skill_ids?.length
    ? await buildSkillSandboxFiles(body.skill_ids)
    : [];
  const allFiles = [...files, ...skillFiles];

  // When skills are active, give the agent a way to improve them based on user
  // feedback. The agent reads skill_id from the SKILL.md frontmatter and calls
  // the platform PATCH route authenticated with its LAP_ACCESS_TOKEN (which
  // carries the "skills" scope). Always ask the user before updating.
  const skillEditingBlock = body.skill_ids?.length
    ? `\n\n## Skill editing\nYou can update a skill's content when the user asks you to improve it.\nRead the skill_id from the skill's SKILL.md frontmatter, then run:\n\`\`\`bash\ncurl -s -X PATCH "$PLATFORM_URL/api/v1/skills/<skill_id>" \\\n  -H "Authorization: Bearer $LAP_ACCESS_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -H "x-session-id: $SESSION_ID" \\\n  -d "{\"content\": \"<new content>\"}"\n\`\`\`\nAlways show the user what you plan to change and get their confirmation first.`
    : "";
  const isOpencodeHarness = agent.harness_id === HARNESS_OPENCODE || agent.harness_id === HARNESS_OPENCODE_BRAIN_INLINE;
  const issueToolName = isOpencodeHarness ? "lap-issue-reporter_report_issue" : "report_issue";
  const sessionContextBlock = `\n\n## Session context\nYour agent_id is \`${agent.agent_id}\`.\nYour session_id is \`${session_id}\`.\n\n## Issue reporting — MANDATORY\nCall \`${issueToolName}\` immediately (before continuing or replying) whenever any of these occur — even if you can work around it:\n- A sandbox command returns unexpected output (file you wrote is gone, state appears reset between operations)\n- A tool returns an error you have to work around\n- Required permissions, integrations, or binaries are missing\n- You are blocked or about to stop\n\nDo not wait until you are fully blocked. File the issue the moment you notice the anomaly, then continue. Always pass session_id and agent_id. This is not optional.`;
  const effectivePrompt = (agent.prompt ?? "") + skillEditingBlock + sessionContextBlock;

  // Resolve the agent's attached MCP server IDs → {name, url} specs and forward
  // them to the harness so external MCPs (Linear, GitHub, etc.) are wired into
  // the session. Without this the K8s warm/cold paths silently drop external
  // MCPs — only the brain-inline path resolved them. Each server is reached
  // through LiteLLM's MCP proxy using the harness's vault-swapped LITELLM_API_KEY,
  // so no raw credentials flow to the sandbox pod.
  const rawMcpServerIds = Array.isArray(agent.mcp_servers)
    ? (agent.mcp_servers as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const { specs: mcpServers, warning: mcpWarning } = await resolveAgentMcpServers(rawMcpServerIds);
  if (mcpWarning) console.warn(`finishBringUp session_id=${session_id}: ${mcpWarning}`);

  const harness_session_id = await harnessCreateSession({
    sandbox_url,
    title: body.title,
    prompt: effectivePrompt || undefined,
    files: allFiles.length > 0 ? allFiles : undefined,
    mcp_servers: mcpServers,
    agent_id: agent.agent_id,
    platform_session_id: session_id,
  });
  registry.observe("session_phase_duration_seconds", { phase: "cloning_repo" }, (Date.now() - cloneStart) / 1000);
  // Flip status=ready as soon as the harness handshake completes. The
  // sandbox is fully usable at this point — the initial_prompt (if any) is
  // the agent doing its job, not part of bring-up, and it can take minutes.
  // Holding `creating` until the agent finishes makes a healthy session look
  // hung and trips the SESSION_CREATING_TIMEOUT_MS reconciler.
  const updated = await prisma.session.update({
    where: { session_id },
    data: {
      status: "ready",
      // Flip phase to `ready` in the same update so the UI sees both
      // status=ready and phase=ready atomically — avoids a tick where the
      // session is ready but the progress card still renders the previous
      // phase.
      phase: "ready",
      phase_detail: null,
      sandbox_url,
      harness_session_id,
      // Seed the idle clock at ready-transition so the reconciler doesn't
      // count container boot time toward the idle window.
      last_seen_at: new Date(),
    },
  });
  // Pre-warm the message-route cache so the first POST after create skips
  // the hydrate round-trip.
  putCachedSession({
    session_id,
    agent_id: agent.agent_id,
    agent_model: agent.model,
    harness_id: agent.harness_id,
    sandbox_url,
    harness_session_id,
    status: "ready",
    sandboxes: null,
  });
  // Fire-and-forget the initial agent task. The session is already ready;
  // the caller (and UI) doesn't need to block on the agent loop, which for
  // a shin PR-review prompt is typically 2-15 minutes. On completion we
  // persist the reply; on failure we log + best-effort write the reason.
  // The .catch is critical: an unhandled rejection here would crash the
  // Node process since this promise is no longer awaited.
  if (body.initial_prompt || (body.initial_attachments && body.initial_attachments.length > 0)) {
    void runInitialPrompt(
      agent,
      session_id,
      sandbox_url,
      harness_session_id,
      body.initial_prompt ?? "",
      body.initial_attachments,
    );
  }
  return { updated, response: null };
}

// ---------------------------------------------------------------------------
// Fire-and-forget runner for the initial agent task. Persists the reply on
// success, logs + persists a failure_reason on error. Never throws — any
// rejection here would be unhandled (the caller doesn't await this).
// ---------------------------------------------------------------------------

// last_seen_at heartbeat cadence while the initial agent task runs. Must stay
// comfortably below SESSION_IDLE_TIMEOUT_MS (reconcile.ts) so an in-flight turn
// is never mistaken for an idle session by the reconciler.
const INITIAL_TASK_HEARTBEAT_MS = 15_000;

// Snapshot the live harness thread into Session.history so the chat can render
// the conversation even after the sandbox is reaped. Automation runs and any
// initial_prompt task drive the agent server-side (not via the browser
// passthrough), so this is the only place their thread gets persisted.
// Best-effort — never let a snapshot failure affect the run.
async function snapshotThreadToHistory(
  session_id: string,
  sandbox_url: string,
  harness_session_id: string,
): Promise<void> {
  try {
    const msgs = await harnessListMessages({ sandbox_url, harness_session_id });
    console.log(`[heartbeat] session=${session_id} snapshot msgs=${msgs.length}`);
    if (msgs.length === 0) return;
    await prisma.session.update({
      where: { session_id },
      data: { history: msgs as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    console.warn(
      `[heartbeat] session=${session_id} snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runInitialPrompt(
  agent: AgentRow,
  session_id: string,
  sandbox_url: string,
  harness_session_id: string,
  initial_prompt: string,
  initial_attachments?: InitialAttachment[],
): Promise<void> {
  // Keep last_seen_at fresh while the (2-15 min) initial agent task runs.
  // Without this, last_seen_at stays pinned at session-creation time and the
  // idle reaper (see SESSION_IDLE_TIMEOUT_MS in reconcile.ts) kills the session
  // mid-task — even though the agent is actively working.
  const heartbeat: NodeJS.Timeout = setInterval(() => {
    void prisma.session
      .update({ where: { session_id }, data: { last_seen_at: new Date() } })
      .catch((err) => {
        console.warn(
          `initial_prompt heartbeat failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    // Also snapshot progress periodically so a long automation run reaped
    // mid-flight still leaves a partial thread to render in the chat.
    void snapshotThreadToHistory(session_id, sandbox_url, harness_session_id);
  }, INITIAL_TASK_HEARTBEAT_MS);

  try {
    // Build Claude-format multimodal parts when attachments are present.
    // Text part first, then each image as a base64 source — matches the
    // Anthropic API content-block shape, which the claude-agent-sdk harness
    // forwards verbatim. `HarnessMessagePart` is intentionally permissive
    // (`[key: string]: unknown`) so the extra `source` field passes through.
    // runInitialPrompt is always the session's first turn, so lead with the
    // agent's system prompt (opencode has no per-session system-prompt API —
    // see prependAgentSystemPrompt). The interactive /message route does the
    // same on turn 1, gated on no prior turns, so this never double-injects.
    const parts = prependAgentSystemPrompt(
      agent.prompt,
      initial_attachments && initial_attachments.length > 0
        ? [
            ...(initial_prompt ? [{ type: "text", text: initial_prompt }] : []),
            ...initial_attachments.map((a) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: a.mime_type,
                data: a.base64,
              },
            })),
          ]
        : expandMessage(initial_prompt),
      session_id,
    );
    // Record the initial prompt in the durable log *before* sending so the
    // first turn is replayable if the sandbox dies before the agent replies.
    const userMsg = await appendUserMessage({
      session_id,
      harness_session_id,
      parts: parts as import("@/server/types").HarnessMessagePart[],
    });
    const response = await harnessSendMessage({
      sandbox_url,
      harness_session_id,
      model: agent.model,
      parts,
    });
    await prisma.session.update({
      where: { session_id },
      data: {
        response: response as unknown as Prisma.InputJsonValue,
        last_seen_at: new Date(),
      },
    });
    void completeAssistantMessage({
      session_id,
      user_message_id: userMsg?.message_id ?? null,
      harness_session_id,
      response,
    });
    // Snapshot the full thread (reasoning + tool + text parts) so the chat can
    // replay it after the sandbox is reaped — the response blob above only has
    // the final assistant message.
    await snapshotThreadToHistory(session_id, sandbox_url, harness_session_id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `initial_prompt send failed: session_id=${session_id} reason=${reason}`,
    );
    // Best-effort persist. The session itself stays `ready` — the sandbox
    // is healthy; only the initial agent task failed. The UI can surface
    // failure_reason alongside an empty response.
    await prisma.session
      .update({
        where: { session_id },
        data: { failure_reason: `initial_prompt failed: ${reason}` },
      })
      .catch((dbErr) => {
        console.error(
          `failed to record initial_prompt failure for ${session_id}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      });
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const identity = assertAuth(req);
  const { agent_id } = await ctx.params;
  const body = CreateSessionBody.parse(await req.json().catch(() => ({})));

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  // Per-session `env_vars` are baked in at Fargate launch time. Warm tasks
  // were provisioned without them, so a request that carries env_vars
  // can't be served from the pool — always go cold.
  const hasEnvVars = body.env_vars && Object.keys(body.env_vars).length > 0;
  const warm = hasEnvVars ? null : await claimWarmTask(agent_id);
  // Replenish immediately on claim — don't wait for the 60s reconciler tick.
  if (warm) void topUpWarmPool().catch(() => {});
  // Track warm pool hit/miss only when pool was actually consulted.
  if (!hasEnvVars) {
    if (warm) registry.inc("warm_pool_hit_total");
    else registry.inc("warm_pool_miss_total");
  }

  let session: SessionRow;
  try {
    session = await prisma.session.create({
      data: {
        agent_id,
        status: "creating",
        created_by: identity.user_id,
        // Inherit the warm task's ARN so that even if bring-up dies between
        // the claim and the harness handshake, the orphan reconciler can
        // still trace the ECS task back to a Session row.
        ...(warm?.task_arn ? { task_arn: warm.task_arn } : {}),
        ...(warm?.sandbox_url ? { sandbox_url: warm.sandbox_url } : {}),
      },
    });
  } catch (e) {
    // Row creation itself failed — we have no Session row to mark failed,
    // so propagate as a 500 the way the old synchronous flow did. Release
    // any warm claim so it isn't orphaned.
    if (warm) {
      await markClaimedTaskDead(
        warm.warm_task_id,
        `session row create failed: ${e instanceof Error ? e.message : String(e)}`,
      ).catch(() => {});
    }
    if (e instanceof HttpError || e instanceof Response) throw e;
    httpError(500, `session create failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Fast path for inline harnesses (claude-code-brain-inline, opencode-brain-inline):
  // no pod needed — delegate to a shared `*_INLINE_URL` server.
  if (isInlineHarness(agent.harness_id)) {
    const isOpencodeInline = agent.harness_id === HARNESS_OPENCODE_BRAIN_INLINE;
    // Prefer the harness-specific env var. For claude-code-brain-inline,
    // in-cluster also resolves to the active pod IP so the session is pinned
    // to it (the reconciler uses sandbox_url to detect a drained pod). The
    // opencode inline server is configured purely via OPENCODE_INLINE_URL.
    const inlineUrl =
      inlineHarnessUrlEnv(agent.harness_id) ||
      (!isOpencodeInline && env.IN_CLUSTER ? await getInlineHarnessPodUrl() : null);
    const inlineEnvName = isOpencodeInline
      ? "OPENCODE_INLINE_URL"
      : "CLAUDE_CODE_INLINE_URL";
    if (!inlineUrl) {
      await prisma.session.update({
        where: { session_id: session.session_id },
        data: { status: "failed", failure_reason: `${inlineEnvName} not configured` },
      });
      console.error(
        `${inlineEnvName} not configured for agent ${agent.agent_id} INSIDE route.ts/session`,
      );
      return Response.json(
        { error: `${inlineEnvName} not configured` },
        { status: 503 }
      );
    }

    const rawFiles = (agent as Record<string, unknown>).sandbox_files;
    const sandboxFiles = Array.isArray(rawFiles) ? (rawFiles as import("@/server/types").SandboxFileSpec[]) : [];
    const rawProjects = (agent as Record<string, unknown>).projects;
    const projects = Array.isArray(rawProjects) ? rawProjects as Array<{ id: string; name: string; description: string; repo_url?: string }> : [];

    // Resolve agent's attached MCP server IDs to {name, url} configs so the
    // harness can wire them into the SDK's mcpServers option. Each server is
    // accessed through LiteLLM's MCP proxy using the harness's LITELLM_API_KEY
    // (vault-swapped at egress) — no raw credentials flow to the harness pod.
    const rawMcpServerIds = Array.isArray(agent.mcp_servers)
      ? (agent.mcp_servers as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const { specs: mcpServers, warning: mcpWarning } = await resolveAgentMcpServers(rawMcpServerIds);

    // Skills for an inline session: the per-session skill_ids PLUS the agent's
    // attached skills. On the pod-per-session path the latter ride along in
    // SKILLS_JSON (hydrated by the entrypoint), but the inline server is shared
    // and boots once, so attached skills must be delivered per session as files.
    // The opencode inline adapter materializes them into a per-agent directory
    // (keyed by agent_id) so each agent only loads its own. claude-code inline
    // already hydrates attached skills its own way, so only do this for opencode.
    const attachedSkillIds = isOpencodeInline
      ? parseAttachedSkillIds(agent.prompt)
      : [];
    const skillIdsForSession = [
      ...new Set([...(body.skill_ids ?? []), ...attachedSkillIds]),
    ];
    const inlineSkillFiles = skillIdsForSession.length
      ? await buildSkillSandboxFiles(skillIdsForSession)
      : [];
    let harness_session_id: string;
    try {
      harness_session_id = await harnessCreateSession({
        sandbox_url: inlineUrl,
        title: body.title ?? "session",
        files: [...sandboxFiles, ...inlineSkillFiles],
        sandbox_tools: true,
        projects,
        agent_id: agent.agent_id,
        mcp_servers: mcpServers,
        platform_session_id: session.session_id,
      });
    } catch (harnessErr) {
      // Harness temporarily unreachable (pod replacement in progress). Mark
      // session failed and return 503 so the client can retry rather than
      // surfacing an opaque 500.
      console.warn(`brain-inline: harnessCreateSession failed for ${session.session_id}:`, harnessErr);
      await prisma.session.update({
        where: { session_id: session.session_id },
        data: { status: "failed", failure_reason: "harness unavailable — pod replacement in progress" },
      }).catch(() => {});
      return Response.json(
        { error: "harness unavailable — pod is being replaced, retry in a few seconds" },
        { status: 503 },
      );
    }

    await prisma.session.update({
      where: { session_id: session.session_id },
      data: { status: "ready", sandbox_url: inlineUrl, harness_session_id },
    });

    putCachedSession({
      session_id: session.session_id,
      agent_id: agent.agent_id,
      agent_model: agent.model,
      harness_id: agent.harness_id,
      sandbox_url: inlineUrl,
      harness_session_id,
      status: "ready",
      sandboxes: null,
    });

    if (body.initial_prompt || (body.initial_attachments && body.initial_attachments.length > 0)) {
      void runInitialPrompt(
        agent,
        session.session_id,
        inlineUrl,
        harness_session_id,
        body.initial_prompt ?? "",
        body.initial_attachments,
      );
    }

    const updatedSession = await prisma.session.findUniqueOrThrow({ where: { session_id: session.session_id } });
    const sessionJson = toApiSession(updatedSession, null, null, agent.harness_id);
    if (mcpWarning) (sessionJson as unknown as Record<string, unknown>).warnings = [mcpWarning];
    return Response.json(sessionJson);
  }

  // Fire-and-forget the bring-up. The Node runtime keeps the promise alive
  // after the response returns (unlike Edge, which terminates the
  // execution context). Render runs this route on Node so the background
  // work continues; nothing inside coldBringUp/warmBringUp reads
  // request-scoped state past this point — they only touch prisma, k8s,
  // and the harness over fetch with their own internal AbortSignals.
  void runBringUp(agent, session.session_id, body, warm);

  // Return the `creating` row immediately. The UI polls /sessions/{id} and
  // flips to the ready/failed view when the background bring-up settles.
  return Response.json(toApiSession(session, null, null, agent.harness_id));
});
