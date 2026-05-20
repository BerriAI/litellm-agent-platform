/**
 * POST /api/v1/managed_agents/agents/{agent_id}/tools/invoke
 *
 * Invokes a sub-agent as a tool from an orchestrator agent's harness.
 *
 * Flow:
 *   1. Verify caller has a valid per-agent token or master key.
 *   2. Check sub_agent_id is in the caller's agent_tools list (auth guard).
 *   3. Spin up a cold-start Session for the sub-agent.
 *   4. Send `input` as the initial prompt, wait for a reply.
 *   5. Return the response text + session_id for observability.
 *
 * Timeout: AGENT_TOOL_INVOKE_TIMEOUT_MS (default 120 s).
 * The endpoint blocks — no streaming.
 */

import { assertAgentTokenOrMaster } from "@/server/auth";
import { prisma } from "@/server/db";
import { runTask, waitRunningGetUrl, waitHttpReady } from "@/server/k8s";
import { harnessCreateSession, harnessSendMessage } from "@/server/harness";
import { httpError, type AgentRow } from "@/server/types";
import { wrap } from "@/server/route-helpers";
import { env } from "@/server/env";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

const InvokeBody = z.object({
  sub_agent_id: z.string().uuid(),
  input: z.string().min(1).max(32_000),
  parent_session_id: z.string().optional(),
});

const TIMEOUT_MS =
  parseInt(process.env.AGENT_TOOL_INVOKE_TIMEOUT_MS ?? "120000", 10);

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { agent_id } = await ctx.params;
  assertAgentTokenOrMaster(req, { scope: "tool", agent_id });

  const callerAgent = await prisma.agent.findUnique({ where: { agent_id } });
  if (!callerAgent) httpError(404, `caller agent '${agent_id}' not found`);

  let body: unknown;
  try { body = await req.json(); } catch { httpError(400, "invalid JSON body"); }

  const parsed = InvokeBody.safeParse(body);
  if (!parsed.success) httpError(400, parsed.error.issues[0]?.message ?? "invalid body");

  const { sub_agent_id, input, parent_session_id } = parsed.data!;

  // Guard: sub_agent_id must be in caller's agent_tools.
  const agentTools = Array.isArray(callerAgent!.agent_tools)
    ? (callerAgent!.agent_tools as Array<{ agent_id: string }>)
    : [];
  if (!agentTools.some((t) => t.agent_id === sub_agent_id)) {
    httpError(403, `agent '${sub_agent_id}' is not in the caller agent's agent_tools list`);
  }

  const subAgent = await prisma.agent.findUnique({ where: { agent_id: sub_agent_id } });
  if (!subAgent) httpError(404, `sub-agent '${sub_agent_id}' not found`);

  // Create Session row.
  const session = await prisma.session.create({
    data: {
      agent_id: sub_agent_id,
      status: "creating",
      phase: "queued",
      phase_detail: `invoked as tool by agent ${agent_id}`,
      created_by: `agent:${agent_id}`,
    },
  });
  const session_id = session.session_id;

  async function failSession(reason: string) {
    await prisma.session.update({
      where: { session_id },
      data: { status: "failed", failure_reason: reason, stopped_at: new Date() },
    }).catch(() => {});
  }

  // Cold-start bring-up.
  let sandboxUrl: string;
  try {
    const { task_arn } = await runTask({
      agent: subAgent as AgentRow,
      session_id,
      env_vars: {
        PARENT_RUN_ID: parent_session_id ?? "",
        PARENT_AGENT_ID: agent_id,
      },
    });

    await prisma.session.update({
      where: { session_id },
      data: { task_arn, phase: "starting_task" },
    });

    sandboxUrl = await waitRunningGetUrl(task_arn, subAgent as AgentRow, TIMEOUT_MS);

    await prisma.session.update({
      where: { session_id },
      data: { sandbox_url: sandboxUrl, phase: "waiting_http" },
    });

    await waitHttpReady(sandboxUrl, TIMEOUT_MS);

    await prisma.session.update({
      where: { session_id },
      data: { status: "ready", phase: "ready" },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await failSession(`bring-up failed: ${reason}`);
    httpError(502, `sub-agent bring-up failed: ${reason}`);
    return new Response(); // unreachable
  }

  // Handshake + send message.
  let responseText: string;
  try {
    const harness_session_id = await harnessCreateSession({
      sandbox_url: sandboxUrl,
      title: `tool-invoke:${agent_id}`,
    });

    await prisma.session.update({
      where: { session_id },
      data: { harness_session_id },
    });

    const reply = await harnessSendMessage({
      sandbox_url: sandboxUrl,
      harness_session_id,
      model: subAgent!.model,
      parts: [{ type: "text", text: input }],
    });

    // reply is HarnessMessageResponse — extract text parts.
    responseText = Array.isArray(reply)
      ? reply
          .filter((p: { type: string; text?: string }) => p.type === "text")
          .map((p: { text?: string }) => p.text ?? "")
          .join("")
      : String(reply);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await failSession(`harness communication failed: ${reason}`);
    httpError(502, `sub-agent harness error: ${reason}`);
    return new Response(); // unreachable
  }

  // Mark session complete.
  await prisma.session.update({
    where: { session_id },
    data: { status: "dead", stopped_at: new Date(), phase: "complete" },
  }).catch(() => {});

  return Response.json({ session_id, sub_agent_id, output: responseText });
});
