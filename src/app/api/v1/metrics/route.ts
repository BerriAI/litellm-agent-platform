import { prisma } from "@/server/db";
import { registry } from "@/server/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Seed in-memory counters from DB totals on first scrape so Prometheus has
// accurate baselines after pod restarts. increase() handles resets correctly.
let seeded = false;
async function seedOnce() {
  if (seeded) return;
  seeded = true;
  try {
    const spawns = await prisma.session.groupBy({
      by: ["status"],
      _count: { session_id: true },
    });
    for (const row of spawns) {
      const result =
        row.status === "dead" || row.status === "ready" || row.status === "stopped"
          ? "success"
          : "failed";
      registry.inc("session_spawn_total", { path: "cold", result }, row._count.session_id);
    }

    const failures = await prisma.session.findMany({
      where: { status: "failed", failure_reason: { not: null } },
      select: { failure_reason: true },
    });
    const byReason = new Map<string, number>();
    for (const f of failures) {
      const r =
        (f.failure_reason as string)
          .slice(0, 64)
          .replace(/[^a-z0-9_]/gi, "_")
          .toLowerCase() || "unknown";
      byReason.set(r, (byReason.get(r) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      registry.inc("session_spawn_failure_total", { path: "cold", reason }, count);
    }
    console.log("[metrics] seeded counters from DB");
  } catch (e) {
    console.warn("[metrics] seed failed:", e instanceof Error ? e.message : String(e));
    seeded = false;
  }
}

export async function GET() {
  await seedOnce();
  return new Response(registry.renderText(), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
