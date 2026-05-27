/**
 * GET /api/v1/managed_agents/sessions
 *
 * Lists managed-agent sessions. With `?agent_id=<id>` the result is filtered
 * to that agent; otherwise the most recent sessions across all agents are
 * returned, newest first. Each row is mapped through `toApiSession` so the
 * response uses the wire shape the frontend expects (and the stored
 * `response` blob is surfaced verbatim — no inline harness call).
 *
 * Pagination + column selection: capped at 50 rows by default (the sidebar
 * only renders the top recent ones anyway) and excludes the per-session
 * `history` / `pending_assistant_parts` JSON columns from the SELECT.
 * Without these limits the route returned every row in the table with the
 * full message-thread snapshot inlined — empirically ~65MB per response at
 * ~3.8k sessions, polled every 10s by the sidebar, which caused the LAP web
 * process to OOM. The single-session GET still hydrates the full row, so
 * detail views are unaffected.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { HttpError, toApiSession, type SessionRow } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sidebar shows recent sessions; nobody renders thousands at once. Allow
// callers to request fewer (or, if they really must, more) via `?limit=`,
// but cap the upper bound to keep the worst-case payload bounded.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request) {
  try {
    assertAuth(req);
    const url = new URL(req.url);
    const agent_id = url.searchParams.get("agent_id") ?? undefined;

    const rawLimit = url.searchParams.get("limit");
    const parsed = rawLimit !== null ? Number.parseInt(rawLimit, 10) : NaN;
    const take =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const rows = await prisma.session.findMany({
      where: agent_id ? { agent_id } : {},
      orderBy: { created_at: "desc" },
      take,
      // Explicit select drops the fat `history` and `pending_assistant_parts`
      // JSON columns from the list response. They're only needed by the
      // single-session GET and by the messages route. Sidebar/UI list views
      // don't render them. `title_preview` (which is derived from history)
      // becomes null in list responses — the sidebar already falls back to
      // the short-id label when title_preview is null.
      select: {
        session_id: true,
        agent_id: true,
        status: true,
        created_at: true,
        last_seen_at: true,
        stopped_at: true,
        failure_reason: true,
        phase: true,
        phase_detail: true,
        sandbox_url: true,
        harness_session_id: true,
        task_arn: true,
        response: true,
        sandboxes: true,
        agent: { select: { harness_id: true } },
      },
    });
    // Cast: rows are narrower than the full SessionRow type because of the
    // explicit `select` above (no `history` / `pending_assistant_parts`).
    // toApiSession's only access to those fields goes through
    // `extractTitlePreview(row.history)` which tolerates `undefined` (it
    // returns `null` for non-arrays). The list view therefore renders with
    // a null title_preview, which the sidebar already handles by falling
    // back to the short-id label.
    return Response.json(
      rows.map((row) =>
        toApiSession(
          row as unknown as SessionRow,
          null,
          null,
          row.agent?.harness_id ?? undefined,
        ),
      ),
    );
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
