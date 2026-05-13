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
  const tickStart = Date.now();
  let k8s_ok = true;
  let r = { inspected: 0, stopped: 0, failed_creating: 0, idle_killed: 0, warm_orphans_stopped: 0, ghost_killed: 0 };
  let t = { provisioned: 0, recycled: 0, fallback_dead: 0 };

  try {
    r = await reconcileOrphans();
  } catch (e) {
    k8s_ok = false;
    console.error("reconcile tick failed:", e);
  }

  // Top-up runs after reconcile so any budget freed by recycling dead /
  // TTL-expired warm rows is reflected on the same tick. Guarded by
  // WARM_POOL_SIZE so disabled deploys don't even hit the DB.
  if (env.WARM_POOL_SIZE > 0) {
    try {
      t = await topUpWarmPool();
    } catch (e) {
      console.error("warm_pool tick failed:", e);
    }
  }

  // Heartbeat — emitted every tick so operators can confirm the worker is
  // alive and K8s is reachable without waiting for a non-zero event.
  console.log(
    `reconcile: ok=${k8s_ok} elapsed_ms=${Date.now() - tickStart}` +
    ` inspected=${r.inspected} stopped=${r.stopped}` +
    ` failed_creating=${r.failed_creating} idle_killed=${r.idle_killed}` +
    ` ghost_killed=${r.ghost_killed} warm_provisioned=${t.provisioned}` +
    ` warm_recycled=${t.recycled}`,
  );
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
async function runSessionSubscriber(
  session_id: string,
  sandbox_url: string,
  signal: AbortSignal,
): Promise<void> {
  try {
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
  } catch (e) {
    if (!signal.aborted) {
      console.error(
        `session_events: subscriber for ${session_id} failed:`,
        e,
      );
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
  try {
    rows = await prisma.session.findMany({
      where: { status: "ready", sandbox_url: { not: null } },
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

setInterval(tick, intervalMs);
tick();
setInterval(sessionEventTick, SESSION_EVENT_SCAN_INTERVAL_MS);
sessionEventTick();
console.log(
  `reconciler worker started (interval=${intervalMs}ms, ` +
    `warm_pool_size=${env.WARM_POOL_SIZE}, ` +
    `session_event_scan_interval_ms=${SESSION_EVENT_SCAN_INTERVAL_MS})`,
);
