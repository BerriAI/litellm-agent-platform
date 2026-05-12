/**
 * Reconciler worker entrypoint.
 *
 * Standalone Node process that ticks `reconcileOrphans` and `topUpWarmPool`
 * on a fixed interval. Run alongside the Next.js server (e.g.
 * `node --import tsx src/worker/index.ts`) so background sweeps don't depend
 * on a request landing on a particular Next instance.
 *
 * Both ticks share the same loop:
 *   - reconcileOrphans: deletes Sandbox CRs whose DB row is gone / terminal.
 *   - topUpWarmPool:    drives the warm pool toward `WARM_POOL_SIZE`.
 *
 * In addition, a `pumpSessionEventSubscribers` subsystem subscribes to each
 * ready session's harness /event SSE and persists the SessionEvent JSON
 * the harness emits. The harness owns translation — see
 * harnesses/_shared/src/session-event.ts and the per-harness translator.
 * Runs on its own 10s scan cadence (independent of the reconcile interval).
 *
 * Reconcile is always on; warm-pool top-up is a no-op when
 * `WARM_POOL_SIZE=0`, so disabled deploys don't hit the DB at all on this
 * code path.
 */

import type { SessionEvent } from "@/server/types";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { harnessOpenEventStream } from "@/server/harness";
import { reconcileOrphans } from "@/server/reconcile";
import { appendSessionEvent } from "@/server/sessionEvents";
import { topUpWarmPool } from "@/server/warmPool";

const intervalMs = env.RECONCILE_INTERVAL_SECONDS * 1000;
const SESSION_EVENT_SCAN_INTERVAL_MS = 10_000;

async function tick() {
  try {
    const r = await reconcileOrphans();
    if (
      r.stopped > 0 ||
      r.failed_creating > 0 ||
      r.idle_killed > 0 ||
      r.warm_orphans_stopped > 0 ||
      r.ghost_killed > 0
    ) {
      console.log(
        `reconcile: inspected=${r.inspected} stopped=${r.stopped} ` +
          `failed_creating=${r.failed_creating} idle_killed=${r.idle_killed} ` +
          `warm_orphans_stopped=${r.warm_orphans_stopped} ` +
          `ghost_killed=${r.ghost_killed}`,
      );
    }
  } catch (e) {
    console.error("reconcile tick failed:", e);
  }

  // Top-up runs after reconcile so any budget freed by recycling dead /
  // TTL-expired warm rows is reflected on the same tick. Guarded by
  // WARM_POOL_SIZE so disabled deploys don't even hit the DB.
  if (env.WARM_POOL_SIZE > 0) {
    try {
      const t = await topUpWarmPool();
      if (t.provisioned > 0 || t.recycled > 0 || t.fallback_dead > 0) {
        console.log(
          `warm_pool: provisioned=${t.provisioned} recycled=${t.recycled} ` +
            `fallback_dead=${t.fallback_dead}`,
        );
      }
    } catch (e) {
      console.error("warm_pool tick failed:", e);
    }
  }
}

// =============================================================================
// SessionEvent subscriber subsystem
// =============================================================================
// One AbortController per session_id currently being tailed. Cancelling the
// controller tears down the SSE reader and frees the entry on next scan.

interface Subscriber {
  controller: AbortController;
  done: Promise<void>;
}

const subscribers = new Map<string, Subscriber>();

/**
 * Open the harness SSE for one session and pump events through the
 * translator + appender. Runs until the upstream closes, the signal aborts,
 * or an unrecoverable error happens. Cleans up its own subscribers entry
 * on exit.
 */
/**
 * One round-trip through the harness SSE — opens the stream, reads
 * frames, persists events. Returns on signal abort or stream close.
 * Throws on undici socket errors; the outer loop reconnects.
 */
async function pumpOnce(
  session_id: string,
  sandbox_url: string,
  signal: AbortSignal,
): Promise<void> {
  const upstream = await harnessOpenEventStream({ sandbox_url, signal });
  if (!upstream.body) return;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = pending.indexOf("\n\n");
      if (idx < 0) break;
      const frame = pending.slice(0, idx);
      pending = pending.slice(idx + 2);
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trimStart();
        if (!raw) continue;
        let event: SessionEvent;
        try {
          event = JSON.parse(raw) as SessionEvent;
        } catch {
          continue;
        }
        // Defensive: ignore frames that don't carry a recognised `type`.
        // The harness's SessionEventTranslator is the single source of
        // truth — anything else on the wire is wire-protocol noise (e.g.
        // SSE comments, keep-alive pings) and should be dropped.
        if (!event || typeof event.type !== "string") continue;
        try {
          await appendSessionEvent(session_id, event);
        } catch (e) {
          console.error(
            `session_events: append failed for ${session_id}:`,
            e,
          );
        }
      }
    }
  }
}

async function runSessionSubscriber(
  session_id: string,
  sandbox_url: string,
  signal: AbortSignal,
): Promise<void> {
  // Reconnect loop. A harness restart sends a TCP RST that surfaces as
  // an undici `TypeError: terminated`; without this loop the subscriber
  // dies on first RST and never comes back. Exponential-ish backoff
  // capped at 5s so a permanently-dead pod doesn't tight-loop.
  let backoff = 250;
  try {
    while (!signal.aborted) {
      try {
        await pumpOnce(session_id, sandbox_url, signal);
        // Clean close (`done` from reader.read()). Reconnect immediately —
        // some proxies idle-close SSE every 30–60s.
        backoff = 250;
      } catch (e) {
        if (signal.aborted) break;
        console.warn(
          `session_events: subscriber for ${session_id} disconnected ` +
            `(${e instanceof Error ? e.message : String(e)}); ` +
            `reconnecting in ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  } finally {
    subscribers.delete(session_id);
  }
}

/**
 * Single scan: attach a subscriber to every ready session with a sandbox_url
 * that doesn't already have one, and tear down subscribers whose session has
 * gone dead/failed (or whose row vanished).
 */
async function scanReadySessions(): Promise<void> {
  let rows: { session_id: string; sandbox_url: string | null }[];
  // Local mode: only follow rows whose sandbox we know is reachable from
  // this process (the host harness backing LAP_LOCAL_SANDBOX_URL). Avoids
  // hammering host.docker.internal URLs from k8s-spawned sessions a
  // separately-running production worker owns.
  const where = env.LAP_LOCAL_SANDBOX_URL.length > 0
    ? { status: "ready", task_arn: "local", sandbox_url: { not: null } }
    : { status: "ready", sandbox_url: { not: null } };
  try {
    rows = await prisma.session.findMany({
      where,
      select: { session_id: true, sandbox_url: true },
    });
  } catch (e) {
    console.error("session_events: scan failed:", e);
    return;
  }

  const live = new Set<string>();
  for (const row of rows) {
    if (!row.sandbox_url) continue;
    live.add(row.session_id);
    if (subscribers.has(row.session_id)) continue;
    const controller = new AbortController();
    const done = runSessionSubscriber(
      row.session_id,
      row.sandbox_url,
      controller.signal,
    );
    subscribers.set(row.session_id, { controller, done });
  }

  // Drop subscribers for sessions that are no longer ready.
  for (const [sid, sub] of subscribers) {
    if (!live.has(sid)) {
      sub.controller.abort();
    }
  }
}

async function sessionEventTick(): Promise<void> {
  try {
    await scanReadySessions();
  } catch (e) {
    console.error("session_events tick failed:", e);
  }
}

// Local-mode short-circuit: when LAP_LOCAL_SANDBOX_URL is set the platform
// isn't talking to k8s/ECS, so the reconciler + warm-pool ticks would only
// produce errors (or, worse, fight a separately-running production worker).
// Skip both. The SessionEvent subscriber still runs — it's what lets the
// UI see harness output in local-dev.
const localMode = env.LAP_LOCAL_SANDBOX_URL.length > 0;
if (!localMode) {
  setInterval(tick, intervalMs);
  tick();
}
setInterval(sessionEventTick, SESSION_EVENT_SCAN_INTERVAL_MS);
sessionEventTick();
console.log(
  localMode
    ? `worker started in local mode (sandbox=${env.LAP_LOCAL_SANDBOX_URL}, ` +
        `session_event_scan_interval_ms=${SESSION_EVENT_SCAN_INTERVAL_MS}; ` +
        `reconcile + warm-pool ticks disabled)`
    : `reconciler worker started (interval=${intervalMs}ms, ` +
        `warm_pool_size=${env.WARM_POOL_SIZE}, ` +
        `session_event_scan_interval_ms=${SESSION_EVENT_SCAN_INTERVAL_MS})`,
);
