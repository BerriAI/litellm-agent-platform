/**
 * GET /api/v1/sandbox/test
 *
 * Diagnostic: provisions a sandbox via the configured provider, runs
 * `nproc` + `free -m` to confirm CPU/RAM, then terminates it.
 * Returns provider config + measured specs. Auth-gated.
 */

import { assertAuth } from "@/server/auth";
import { env } from "@/server/env";
import { getRegistry } from "@/server/sandbox";
import { HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    assertAuth(req);

    const choice = env.SANDBOX_CHOICE;
    const template = env.E2B_TEMPLATE;

    if (!choice) {
      return Response.json({
        provider: "k8s (SANDBOX_CHOICE not set)",
        note: "Set SANDBOX_CHOICE=e2b to use E2B provider",
      });
    }

    const registry = getRegistry();
    if (!(choice in registry)) {
      return Response.json({ error: `SANDBOX_CHOICE=${choice} not in registry` }, { status: 500 });
    }

    const provider = registry[choice];
    const started = Date.now();

    // Provision a throwaway sandbox
    const { id } = await provider.create({ session_id: "test", agent: {} as never });
    const provisionMs = Date.now() - started;

    // Measure CPU + RAM
    const output = await provider.execute(id, "nproc && free -m | grep '^Mem'", 30_000);
    const lines = output.trim().split("\n");
    const cpuCount = parseInt(lines[0] ?? "0", 10);
    const memFields = (lines[1] ?? "").split(/\s+/);
    const memTotalMB = parseInt(memFields[1] ?? "0", 10);

    // Clean up
    await provider.terminate(id).catch(() => {});

    return Response.json({
      ok: true,
      provider: choice,
      template: template ?? "base",
      sandboxId: id,
      measured: {
        cpuCount,
        memTotalMB,
      },
      provisionMs,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError) return Response.json({ error: e.detail }, { status: e.status });
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
