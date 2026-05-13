"use client";

/**
 * Side-by-side wire inspector. Renders as a flex-child of the session
 * container, so when it's open the main chat shrinks instead of being
 * covered. Two stacked panes (platform envelope / raw harness bus) tail
 * the same session SSE endpoints view.tsx itself talks to.
 *
 *   platform pane  ← GET /api/v1/.../events  (wrapped envelope)
 *   harness pane   ← GET /api/v1/.../stream  (pure passthrough)
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Activity, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { getStoredMasterKey } from "@/lib/api";

type BusEvent = {
  id?: string;
  type: string;
  properties?: Record<string, unknown> & { sessionID?: string };
  event?: BusEvent;
};

interface InspectedFrame {
  ts: number;
  raw: BusEvent;
}

function summarize(evt: BusEvent | undefined): string {
  if (!evt) return "";
  if (evt.type === "harness_event" && evt.event) return summarize(evt.event);
  if (evt.type === "server.heartbeat") return "";
  if (evt.type === "stream.opened") return "platform→harness SSE established";
  if (evt.type === "server.connected") return "upstream alive";
  if (evt.type === "session.status") {
    const s = (evt.properties as { status?: { type?: string } } | undefined)?.status;
    return `status=${s?.type ?? "?"}`;
  }
  if (evt.type === "session.idle") return "agent loop returned control";
  if (evt.type === "message.part.delta") {
    const p = evt.properties as { delta?: string; field?: string } | undefined;
    return `${p?.field}: ${(p?.delta ?? "").slice(0, 100)}`;
  }
  if (evt.type === "message.part.updated") {
    const part = (evt.properties as { part?: { type?: string; tool?: string; state?: { status?: string } } } | undefined)?.part;
    if (part?.type === "tool") return `tool ${part.tool ?? "?"} ${part.state?.status ?? ""}`;
    if (part?.type === "text") return `text part replaced`;
    return `part type=${part?.type ?? "?"}`;
  }
  if (evt.type === "message.updated") {
    const info = (evt.properties as { info?: { role?: string; id?: string } } | undefined)?.info;
    return `${info?.role ?? "?"} ${(info?.id ?? "").slice(0, 20)}`;
  }
  return JSON.stringify(evt.properties ?? {}).slice(0, 100);
}

const TYPE_COLORS: Record<string, string> = {
  "server.connected": "text-emerald-600",
  "server.heartbeat": "text-gray-400",
  "session.idle": "text-amber-600",
  "session.error": "text-red-600",
  "session.status": "text-violet-600",
  "session.created": "text-emerald-600",
  "session.updated": "text-blue-600",
  "message.updated": "text-blue-600",
  "message.part.updated": "text-blue-600",
  "message.part.delta": "text-blue-600",
  "stream.opened": "text-emerald-600",
  ready: "text-emerald-600",
  done: "text-amber-600",
  error: "text-red-600",
  harness_event: "text-blue-600",
};

function EventRow({ frame, hideHeartbeat }: { frame: InspectedFrame; hideHeartbeat: boolean }) {
  const [open, setOpen] = useState(false);
  const innerType =
    frame.raw.type === "harness_event" && frame.raw.event ? frame.raw.event.type : null;
  const visibleType = frame.raw.type;
  if (hideHeartbeat && (innerType === "server.heartbeat" || visibleType === "server.heartbeat")) {
    return null;
  }
  const color = TYPE_COLORS[innerType ?? visibleType] ?? "text-gray-700";
  return (
    <div
      onClick={() => setOpen((v) => !v)}
      className="border-b border-dashed border-gray-200 py-1.5 px-2 cursor-pointer hover:bg-gray-50 font-mono text-[11px]"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-gray-400 text-[10px] shrink-0">
          {new Date(frame.ts).toLocaleTimeString()}
        </span>
        <span className={`font-semibold shrink-0 ${color}`}>
          {visibleType}
          {innerType && <span className="font-normal text-gray-400"> → {innerType}</span>}
        </span>
        {!open && <span className="text-gray-500 truncate">{summarize(frame.raw)}</span>}
      </div>
      {open && (
        <pre className="mt-1 p-2 bg-gray-50 rounded text-[10.5px] text-gray-700 whitespace-pre-wrap break-all overflow-x-auto">
          {JSON.stringify(frame.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

function StatusPill({ status, error }: { status: StreamStatus; error?: string }) {
  const map: Record<StreamStatus, readonly [string, string, string]> = {
    idle: ["bg-gray-100", "text-gray-500", "idle"],
    connecting: ["bg-amber-50", "text-amber-700", "connecting…"],
    waiting: ["bg-blue-50", "text-blue-700", "waiting for first event"],
    live: ["bg-emerald-100", "text-emerald-700", "● streaming"],
    closed: ["bg-gray-100", "text-gray-500", "closed"],
    error: ["bg-red-100", "text-red-700", "error"],
  };
  const [bg, fg, label] = map[status];
  return (
    <span
      className={`ml-auto px-2 py-0.5 rounded-full font-mono text-[10px] ${bg} ${fg}`}
      title={error || label}
    >
      {label}
    </span>
  );
}

type StreamStatus = "idle" | "connecting" | "waiting" | "live" | "closed" | "error";

/**
 * Monkey-patches window.fetch while the inspector is open so every
 * `POST /message_stream` the UI fires (from the composer / sendMessageStream)
 * is tee'd into the platform pane. The original fetch caller still gets a
 * usable response — we use ReadableStream.tee() to split the body so the
 * UI's renderer reads one half and we read the other.
 *
 * Returns the frames + a status. Status only goes "live" once the UI
 * actually sends a message; before that it's "idle" with a hint.
 */
function useFetchInterceptor(sessionId: string) {
  const [frames, setFrames] = useState<InspectedFrame[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");

  useEffect(() => {
    if (!sessionId) return;
    const matchUrl = `/sessions/${encodeURIComponent(sessionId)}/message_stream`;
    const original = window.fetch;
    // Patch installed eagerly the moment the session view mounts — so a POST
    // /message_stream fired BEFORE you open the inspector still gets tee'd.
    // Frames persist across panel toggles.
    setStatus("idle");

    window.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const reqUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!reqUrl.includes(matchUrl)) return original(input, init);

      // Capture the outbound request
      let bodyPreview: unknown = null;
      if (init?.body && typeof init.body === "string") {
        try { bodyPreview = JSON.parse(init.body); }
        catch { bodyPreview = init.body.slice(0, 500); }
      }
      setFrames((prev) => [
        ...prev,
        {
          ts: Date.now(),
          raw: {
            type: "http_request",
            properties: { method: init?.method ?? "POST", url: reqUrl, body: bodyPreview },
          },
        },
      ]);
      setStatus("connecting");

      let res: Response;
      try {
        res = await original(input, init);
      } catch (e) {
        setStatus("error");
        setFrames((prev) => [
          ...prev,
          { ts: Date.now(), raw: { type: "fetch_error", properties: { message: (e as Error).message } } },
        ]);
        throw e;
      }

      if (!res.ok || !res.body) {
        setStatus("error");
        setFrames((prev) => [
          ...prev,
          { ts: Date.now(), raw: { type: "http_response", properties: { status: res.status, statusText: res.statusText } } },
        ]);
        return res;
      }

      setStatus("waiting");
      setFrames((prev) => [
        ...prev,
        {
          ts: Date.now(),
          raw: {
            type: "http_response",
            properties: { status: res.status, contentType: res.headers.get("content-type") },
          },
        },
      ]);

      // Tee the body: one half goes back to the UI's caller, one half
      // we parse into the inspector pane.
      const [forUi, forInspector] = res.body.tee();

      // Parse the inspector copy off in the background.
      void (async () => {
        const reader = forInspector.getReader();
        const dec = new TextDecoder();
        let pending = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += dec.decode(value, { stream: true });
            for (;;) {
              const idx = pending.indexOf("\n\n");
              if (idx < 0) break;
              const frame = pending.slice(0, idx);
              pending = pending.slice(idx + 2);
              for (const line of frame.split(/\r?\n/)) {
                if (!line.startsWith("data:")) continue;
                const raw = line.slice(5).trimStart();
                if (!raw) continue;
                try {
                  const evt = JSON.parse(raw) as BusEvent;
                  setStatus("live");
                  setFrames((prev) => [
                    ...prev.slice(-500),
                    { ts: Date.now(), raw: evt },
                  ]);
                } catch { /* skip */ }
              }
            }
          }
          setStatus("closed");
        } catch {
          setStatus("error");
        }
      })();

      // Hand the other half back wrapped in a new Response so the UI's
      // existing reader pipeline is unchanged.
      return new Response(forUi, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };

    return () => {
      window.fetch = original;
    };
  }, [sessionId]);

  const clear = useCallback(() => setFrames([]), []);
  return { frames, status, error: "", clear };
}

function useEventStream(url: string, open: boolean, label: string) {
  const [frames, setFrames] = useState<InspectedFrame[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    if (!open) {
      setStatus("idle");
      return;
    }
    // NOTE: don't clear frames on open — they accumulate so you can scroll
    // back through history without losing rows when you toggle the panel.
    let cancelled = false;
    setErr("");
    setStatus("connecting");
    const ctl = new AbortController();
    const authKey = getStoredMasterKey();
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (authKey) headers.authorization = `Bearer ${authKey}`;

    // eslint-disable-next-line no-console
    console.log(`[inspector:${label}] connect ${url}`);

    (async () => {
      try {
        const res = await fetch(url, { headers, signal: ctl.signal, cache: "no-store" });
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.log(`[inspector:${label}] response HTTP ${res.status}`, {
          contentType: res.headers.get("content-type"),
          hasBody: !!res.body,
        });
        if (!res.ok || !res.body) {
          const txt = (await res.text().catch(() => "")).slice(0, 200);
          setStatus("error");
          setErr(`HTTP ${res.status}${txt ? `: ${txt}` : ""}`);
          return;
        }
        setStatus("waiting");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let pending = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) {
            // eslint-disable-next-line no-console
            console.log(`[inspector:${label}] stream done`);
            break;
          }
          pending += dec.decode(value, { stream: true });
          for (;;) {
            const idx = pending.indexOf("\n\n");
            if (idx < 0) break;
            const frame = pending.slice(0, idx);
            pending = pending.slice(idx + 2);
            for (const line of frame.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trimStart();
              if (!raw) continue;
              try {
                const evt = JSON.parse(raw) as BusEvent;
                if (cancelled) return;
                // eslint-disable-next-line no-console
                console.log(`[inspector:${label}] event ${evt.type}`);
                setStatus("live");
                setFrames((prev) => [...prev.slice(-500), { ts: Date.now(), raw: evt }]);
              } catch (parseErr) {
                // eslint-disable-next-line no-console
                console.warn(`[inspector:${label}] parse error`, parseErr, raw.slice(0, 100));
              }
            }
          }
        }
        if (!cancelled) setStatus("closed");
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string }).name;
        if (name === "AbortError") {
          // eslint-disable-next-line no-console
          console.log(`[inspector:${label}] aborted`);
          setStatus("closed");
        } else {
          // eslint-disable-next-line no-console
          console.error(`[inspector:${label}] fetch failed`, e);
          setStatus("error");
          setErr((e as Error).message || "fetch failed");
        }
      }
    })();

    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [open, url, label]);

  const clear = useCallback(() => setFrames([]), []);
  return { frames, status, error: err, clear };
}

const HARNESS_PREF_KEY = "inspector_show_harness";

function readHarnessPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HARNESS_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHarnessPref(v: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HARNESS_PREF_KEY, v ? "1" : "0");
  } catch {
    /* localStorage unavailable (private mode, quota) — preference simply
     * won't persist; current-session toggle still works. */
  }
}

export function InspectorPanel({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  const [hideHeartbeat, setHideHeartbeat] = useState(true);
  // Persisted per-session preference. We initialize from localStorage on
  // mount (not via useState initializer, which would run on the server too).
  const [showHarness, setShowHarness] = useState(false);
  useEffect(() => {
    setShowHarness(readHarnessPref());
  }, []);
  const toggleHarness = useCallback(() => {
    setShowHarness((prev) => {
      const next = !prev;
      writeHarnessPref(next);
      return next;
    });
  }, []);

  // Single channel: the UI's POST /message_stream tee'd via fetch patch.
  // Patch is installed from page mount (NOT from inspector-open), so a send
  // fired BEFORE you open the inspector still shows up here.
  const platform = useFetchInterceptor(sessionId);

  const harnessUrl = useMemo(
    () =>
      `/api/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/stream`,
    [sessionId],
  );
  // Only actually subscribe when both the inspector and harness pane are
  // open — `useEventStream` gates on its `open` arg, so passing false keeps
  // the connection torn down.
  const harness = useEventStream(harnessUrl, open && showHarness, "harness");

  const clearAll = useCallback(() => {
    platform.clear();
    harness.clear();
  }, [platform, harness]);

  // Note: we render `null` instead of unmounting when !open so the hooks
  // above keep running — that's how the fetch patch survives across panel
  // toggles and captures sends that happen while the inspector is closed.
  if (!open) return null;
  const widthClass = showHarness ? "w-[1000px]" : "w-[560px]";
  return (
    <aside
      className={`flex flex-col h-full min-h-0 border-l border-gray-200 bg-white ${widthClass} shrink-0`}
    >
      <header className="flex items-center gap-2 px-4 py-2 border-b border-gray-200">
        <Activity className="size-3.5 text-gray-500" />
        <span className="text-[13px] font-medium text-gray-800">Wire inspector</span>
        <span className="font-mono text-[11px] text-gray-400">
          session {sessionId.slice(0, 8)}…
        </span>
        <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={showHarness}
            onChange={toggleHarness}
            className="size-3"
          />
          show harness bus
        </label>
        <button
          type="button"
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded"
          title="Close inspector"
        >
          <X className="size-4 text-gray-500" />
        </button>
      </header>

      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-gray-200 bg-gray-50/50 text-[11px]">
        <label className="inline-flex items-center gap-1.5 text-gray-600">
          <input
            type="checkbox"
            checked={hideHeartbeat}
            onChange={(e) => setHideHeartbeat(e.target.checked)}
            className="size-3"
          />
          hide heartbeats
        </label>
        <button
          type="button"
          onClick={clearAll}
          className="text-gray-500 hover:text-gray-800 underline-offset-2 hover:underline"
        >
          clear
        </button>
        <span className="ml-auto text-gray-400 font-mono">
          {platform.frames.length}
          {showHarness ? ` · ${harness.frames.length}` : ""} frames
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        <section className="flex flex-col flex-1 min-w-0 min-h-0">
          <div className="flex items-center gap-2 px-4 py-1.5 bg-violet-50/40 border-b border-gray-200">
            <Badge
              variant="secondary"
              className="text-[10px] bg-violet-100 text-violet-700 hover:bg-violet-100"
            >
              /message_stream
            </Badge>
            <span className="font-mono text-[10.5px] text-gray-600 truncate">
              POST /sessions/:id/message_stream
            </span>
            <StatusPill status={platform.status} error={platform.error} />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {platform.frames.map((f, i) => (
              <EventRow key={i} frame={f} hideHeartbeat={hideHeartbeat} />
            ))}
            {platform.frames.length === 0 && (
              <div className="p-3 text-[11px] text-gray-400 text-center leading-relaxed">
                patch is armed — send a message from the composer<br />
                (or wait if you just sent one — the in-flight stream will catch up)
              </div>
            )}
          </div>
        </section>

        {showHarness && (
          <section className="flex flex-col flex-1 min-w-0 min-h-0 border-l border-gray-200">
            <div className="flex items-center gap-2 px-4 py-1.5 bg-blue-50/40 border-b border-gray-200">
              <Badge
                variant="secondary"
                className="text-[10px] bg-blue-100 text-blue-700 hover:bg-blue-100"
              >
                /stream
              </Badge>
              <span className="font-mono text-[10.5px] text-gray-600 truncate">
                GET /sessions/:id/stream
              </span>
              <StatusPill status={harness.status} error={harness.error} />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {harness.frames.map((f, i) => (
                <EventRow key={i} frame={f} hideHeartbeat={hideHeartbeat} />
              ))}
              {harness.frames.length === 0 && (
                <div className="p-3 text-[11px] text-gray-400 text-center leading-relaxed">
                  subscribed to the raw harness bus<br />
                  events appear as the agent loop emits them
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      <footer className="px-4 py-1.5 border-t border-gray-200 text-[10px] text-gray-400 font-mono">
        tee&apos;d /message_stream · optional raw /stream
      </footer>
    </aside>
  );
}

// Keep the old name exported for backwards compat with any other importer.
export { InspectorPanel as InspectorDialog };
