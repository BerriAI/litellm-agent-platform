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

setInterval(tick, intervalMs);
tick();
console.log(
  `reconciler worker started (interval=${intervalMs}ms, warm_pool_size=${env.WARM_POOL_SIZE})`,
);
