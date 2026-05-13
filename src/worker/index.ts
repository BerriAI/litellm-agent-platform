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
 * Reconcile is always on; warm-pool top-up is a no-op when
 * `WARM_POOL_SIZE=0`, so disabled deploys don't hit the DB at all on this
 * code path.
 */

import { env } from "@/server/env";
import { reconcileOrphans } from "@/server/reconcile";
import { topUpWarmPool } from "@/server/warmPool";

const intervalMs = env.RECONCILE_INTERVAL_SECONDS * 1000;

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

setInterval(tick, intervalMs);
tick();
console.log(
  `reconciler worker started (interval=${intervalMs}ms, ` +
    `warm_pool_size=${env.WARM_POOL_SIZE})`,
);
