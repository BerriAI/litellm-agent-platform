import { fetch } from "undici";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { runTask, waitHttpReady, waitRunningGetUrl } from "@/server/k8s";
import { getRegistry } from "@/server/sandbox";
import { HARNESS_EXECUTOR, type AgentRow } from "@/server/types";

const EXECUTE_TIMEOUT_MS = 300_000;

const sandboxMap = new Map<string, string>();

function mapKey(session_id: string, name: string): string {
  return `${session_id}:${name}`;
}

export async function provisionSandbox(
  session_id: string,
  name: string,
  agent: AgentRow,
  existingSandboxes?: Record<string, string>,
): Promise<string> {
  const registry = getRegistry();
  if (env.SANDBOX_CHOICE && env.SANDBOX_CHOICE in registry) {
    const p = registry[env.SANDBOX_CHOICE];
    const existing = existingSandboxes?.[name] ?? sandboxMap.get(mapKey(session_id, name));
    if (existing) {
      sandboxMap.set(mapKey(session_id, name), existing);
      return `sandbox '${name}' ready`;
    }
    const id = await p.create({ session_id, agent });
    const url = `${p.urlScheme}://${id}`;
    sandboxMap.set(mapKey(session_id, name), url);
    const merged = { ...(existingSandboxes ?? {}), [name]: url };
    await prisma.session.update({
      where: { session_id },
      data: { sandboxes: merged } as Prisma.SessionUpdateInput,
    });
    return `sandbox '${name}' ready`;
  }

  if (env.LOCAL_EXECUTOR_URL) {
    sandboxMap.set(mapKey(session_id, name), env.LOCAL_EXECUTOR_URL);
    const merged = { ...(existingSandboxes ?? {}), [name]: env.LOCAL_EXECUTOR_URL };
    await prisma.session.update({
      where: { session_id },
      data: { sandboxes: merged } as Prisma.SessionUpdateInput,
    });
    return `sandbox '${name}' ready`;
  }

  if (env.LOCAL_SANDBOX_URL) {
    sandboxMap.set(mapKey(session_id, name), env.LOCAL_SANDBOX_URL);
    const merged = { ...(existingSandboxes ?? {}), [name]: env.LOCAL_SANDBOX_URL };
    await prisma.session.update({
      where: { session_id },
      data: { sandboxes: merged } as Prisma.SessionUpdateInput,
    });
    return `sandbox '${name}' ready`;
  }

  // Idempotency: if this sandbox name was already provisioned, skip the
  // expensive pod-wait path and return the stored URL immediately.
  const existingUrl = existingSandboxes?.[name] ?? sandboxMap.get(mapKey(session_id, name));
  if (existingUrl) {
    sandboxMap.set(mapKey(session_id, name), existingUrl);
    return `sandbox '${name}' ready`;
  }

  const { task_arn } = await runTask({ agent: { ...agent, harness_id: HARNESS_EXECUTOR }, session_id });

  // Only write task_arn for non-brain-inline sessions. brain-inline sessions
  // use a shared harness pod — writing the sandbox pod's task_arn causes the
  // reconciler ghost sweep to kill the brain-inline session when the sandbox
  // pod dies from idle timeout.
  if (agent.harness_id !== "claude-code-brain-inline") {
    await prisma.session.update({
      where: { session_id },
      data: { task_arn },
    });
  }

  const sandbox_url = await waitRunningGetUrl(task_arn, agent);
  await waitHttpReady(sandbox_url);

  const merged = { ...(existingSandboxes ?? {}), [name]: sandbox_url };
  await prisma.session.update({
    where: { session_id },
    data: { sandboxes: merged } as Prisma.SessionUpdateInput,
  });

  sandboxMap.set(mapKey(session_id, name), sandbox_url);
  return `sandbox '${name}' ready`;
}

/**
 * Resolve a provisioned sandbox's URL (`scheme://id` or an http URL). Falls
 * back to the DB-persisted map when the in-process cache was wiped by a pod
 * restart. Returns null when the sandbox was never provisioned.
 */
async function resolveSandboxUrl(
  session_id: string,
  name: string,
): Promise<string | null> {
  const cached = sandboxMap.get(mapKey(session_id, name));
  if (cached) return cached;
  const row = await (prisma.session.findUnique as (args: unknown) => Promise<Record<string, unknown> | null>)({
    where: { session_id },
    select: { sandboxes: true },
  });
  const stored = (row?.sandboxes as Record<string, string> | null)?.[name];
  if (stored) {
    sandboxMap.set(mapKey(session_id, name), stored);
    return stored;
  }
  return null;
}

export async function executeSandbox(
  session_id: string,
  name: string,
  cmd: string,
): Promise<string> {
  const sandbox_url = await resolveSandboxUrl(session_id, name);
  if (!sandbox_url) {
    return `error: sandbox '${name}' not provisioned — call provision first`;
  }

  const registry = getRegistry();
  const scheme = sandbox_url.split("://")[0];
  if (scheme && scheme in registry) {
    const id = sandbox_url.slice(scheme.length + 3);
    return registry[scheme].execute(id, cmd, EXECUTE_TIMEOUT_MS);
  }

  const url = `${sandbox_url.replace(/\/+$/, "")}/execute`;
  const secret = env.EXECUTOR_SECRET;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-executor-secret"] = secret;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ cmd }),
      signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
    });
    const data = (await res.json()) as { output?: string };
    return data.output ?? "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Cap on inline file content so a large file can't blow up the agent context.
const READ_FILE_MAX_BYTES = 256 * 1024;

/**
 * Read a file out of a provisioned sandbox and return its text content. Lets
 * the agent pull files from the sandbox into its own workspace without
 * `cat`/base64 gymnastics. Registry providers (E2B) use their native file API;
 * the http-executor path falls back to `cat`.
 */
export async function readSandboxFile(
  session_id: string,
  name: string,
  path: string,
): Promise<string> {
  const sandbox_url = await resolveSandboxUrl(session_id, name);
  if (!sandbox_url) {
    return `error: sandbox '${name}' not provisioned — call provision first`;
  }

  const registry = getRegistry();
  const scheme = sandbox_url.split("://")[0];
  let content: string;
  if (scheme && scheme in registry) {
    const id = sandbox_url.slice(scheme.length + 3);
    content = await registry[scheme].readFile(id, path);
  } else {
    // http executor has no file API — fall back to `cat` (text only).
    content = await executeSandbox(session_id, name, `cat -- ${JSON.stringify(path)}`);
  }

  if (content.length > READ_FILE_MAX_BYTES) {
    return `error: file too large to return inline (${content.length} bytes > ${READ_FILE_MAX_BYTES}). Read a smaller slice (e.g. head/tail) or split it.`;
  }
  return content;
}

export function getSandboxUrl(
  session_id: string,
  name: string,
): string | undefined {
  return sandboxMap.get(mapKey(session_id, name));
}

export async function terminateSandbox(session_id: string, name: string): Promise<void> {
  const sandbox_url = sandboxMap.get(mapKey(session_id, name));
  if (!sandbox_url) return;
  const registry = getRegistry();
  const scheme = sandbox_url.split("://")[0];
  if (scheme && scheme in registry) {
    await registry[scheme].terminate(sandbox_url.slice(scheme.length + 3)).catch(() => {});
  }
}

export async function clearSandboxes(session_id: string): Promise<void> {
  for (const key of sandboxMap.keys()) {
    if (key.startsWith(`${session_id}:`)) {
      sandboxMap.delete(key);
    }
  }
  await prisma.session.update({
    where: { session_id },
    data: { sandboxes: {} } as Prisma.SessionUpdateInput,
  }).catch(() => {});
}
