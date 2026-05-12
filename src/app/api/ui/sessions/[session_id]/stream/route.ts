/**
 * GET /api/ui/sessions/[session_id]/stream
 *
 * Thin CORS-friendly UI proxy in front of the LAP v1 stream endpoint
 * (`/api/v1/managed_agents/sessions/:id/stream`). The browser opens this
 * via `EventSource`, which can't attach an `Authorization` header — so we
 * gate this route with the HttpOnly cookie installed by
 * `/api/ui/auth/cookie` and use the server-side bearer (`MASTER_KEY`) to
 * call upstream.
 *
 * Upstream base URL is `process.env.LITELLM_API_BASE || ""`. The empty
 * default makes this same-origin in production, where LAP serves both the
 * UI and the v1 stream from the same host. Local dev can point at a
 * separate running instance by exporting LITELLM_API_BASE.
 *
 * Wire format coming through is the same the harness emits — see
 * `/api/v1/managed_agents/sessions/[session_id]/stream/route.ts`. The new
 * frames the UI cares about are:
 *   - { type: "claude_sdk_message", properties: { message: SDKMessage } }
 *   - { type: "session.idle" | "session.error" | "session.aborted", ... }
 * Plus the legacy `message.part.*` envelopes for backcompat.
 *
 * This route does not parse the SSE stream — it pipes the upstream body
 * to the client unchanged so consumers can `JSON.parse(ev.data)` and apply
 * the same envelope logic the SDK uses.
 */

import { assertCookieAuth } from "@/server/auth";
import { env } from "@/server/env";
import { HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertCookieAuth(req);
    const { session_id } = await ctx.params;

    // Empty base => same-origin. In prod LAP serves the UI and v1 from the
    // same Render service, so a relative path is correct. Locally a dev
    // can set LITELLM_API_BASE=http://localhost:4096 to split them.
    const base = (process.env.LITELLM_API_BASE || "").replace(/\/$/, "");
    const upstreamUrl =
      `${base}/api/v1/managed_agents/sessions/` +
      `${encodeURIComponent(session_id)}/stream`;

    // Tie upstream lifetime to the client connection. EventSource closes
    // its socket on page unload / .close(); Next forwards that as a
    // `req.signal` abort. Without this the upstream subscription would
    // keep running until the harness's keepalive ceiling.
    const upstreamCtl = new AbortController();
    req.signal.addEventListener("abort", () => upstreamCtl.abort(), {
      once: true,
    });

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        headers: {
          authorization: `Bearer ${env.MASTER_KEY}`,
          accept: "text/event-stream",
        },
        signal: upstreamCtl.signal,
        // SSE is a long-lived response; disable any framework-level
        // caching just in case a proxy in front of us tries to be clever.
        cache: "no-store",
      });
    } catch (err) {
      console.error("ui stream upstream fetch failed", err);
      return Response.json({ error: "upstream unreachable" }, { status: 502 });
    }

    if (!upstream.ok || !upstream.body) {
      // Surface the upstream status verbatim so the browser can show a
      // meaningful error (404 if session gone, 410 if dead, 504 if not
      // ready yet, etc).
      const text = await upstream.text().catch(() => "");
      return new Response(text || JSON.stringify({ error: "upstream error" }), {
        status: upstream.status,
        headers: {
          "content-type":
            upstream.headers.get("content-type") || "application/json",
        },
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Match upstream — disables proxy buffering on any nginx/Render
        // edge that respects the hint.
        "x-accel-buffering": "no",
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
