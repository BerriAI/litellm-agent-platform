"use client";

/**
 * Opencode event inspector. Tails the session's opencode `/event` bus — the
 * exact stream the UI renders from — and pretty-prints each frame: timestamp,
 * event type, a one-line summary, and the full JSON on click. One clean view:
 * no platform envelopes, no message_stream / stream tees.
 */

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ChevronRight,
  Plug,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";

import { browserOpencodeClient } from "@/lib/opencode-client";

interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/** Skill loaded into the session — passed in from the session view, which
 * already resolves the agent's `attached_skill_ids` against the catalog. */
export interface LoadedSkill {
  id: string;
  name: string;
  description?: string | null;
}

interface Frame {
  ts: number;
  ev: OcEvent;
}

function summarize(ev: OcEvent): string {
  const p = (ev.properties ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "server.connected":
      return "stream connected";
    case "session.idle":
      return "agent loop returned control";
    case "session.error":
      return String((p.message as string) ?? "error");
    case "message.updated": {
      const info = (p.info ?? {}) as { role?: string; id?: string };
      return `${info.role ?? "?"} ${(info.id ?? "").slice(0, 22)}`;
    }
    case "message.part.delta":
      return `${(p.field as string) ?? "text"}: ${String(p.delta ?? "").slice(0, 80)}`;
    case "message.part.updated": {
      const part = (p.part ?? {}) as {
        type?: string;
        tool?: string;
        text?: string;
        state?: { status?: string };
      };
      if (part.type === "tool")
        return `tool ${part.tool ?? "?"} · ${part.state?.status ?? ""}`;
      if (part.type === "text")
        return `text: ${String(part.text ?? "").slice(0, 80)}`;
      if (part.type === "reasoning")
        return `reasoning: ${String(part.text ?? "").slice(0, 80)}`;
      return `part ${part.type ?? "?"}`;
    }
    case "session.status": {
      const s = p.status as { type?: string } | string | undefined;
      return typeof s === "string" ? s : (s?.type ?? "");
    }
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 80) : "";
  }
}

const TYPE_COLOR: Record<string, string> = {
  "server.connected": "text-emerald-600",
  "session.idle": "text-amber-600",
  "session.error": "text-red-600",
  "session.status": "text-violet-600",
  "message.updated": "text-violet-600",
  "message.part.delta": "text-sky-600",
  "message.part.updated": "text-blue-600",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString([], { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function EventRow({
  frame,
  currentSid,
}: {
  frame: Frame;
  currentSid?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const color = TYPE_COLOR[frame.ev.type] ?? "text-gray-700";
  const sid = (frame.ev.properties as { sessionID?: string } | undefined)
    ?.sessionID;
  // A subagent (task tool) runs in a child session — flag those rows so a
  // hang/loop inside a subagent is visible instead of looking like "nothing".
  const isSub = !!sid && !!currentSid && sid !== currentSid;
  return (
    <div className="border-b border-gray-100 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${
          isSub ? "bg-amber-50/50" : ""
        }`}
      >
        <ChevronRight
          className={`mt-0.5 size-3 shrink-0 text-gray-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="font-mono text-gray-400 shrink-0">
          {fmtTime(frame.ts)}
        </span>
        {isSub && (
          <span className="font-mono text-[9px] shrink-0 px-1 rounded bg-amber-200 text-amber-800">
            subagent
          </span>
        )}
        <span className={`font-mono font-medium shrink-0 ${color}`}>
          {frame.ev.type}
        </span>
        <span className="font-mono text-gray-500 truncate">
          {summarize(frame.ev)}
        </span>
      </button>
      {open && (
        <pre className="px-3 pb-2 pl-8 font-mono text-[10.5px] text-gray-600 whitespace-pre-wrap break-words max-h-80 overflow-auto">
          {JSON.stringify(frame.ev, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context tab — what's wired into this session right now: MCP servers (live
// connection status), the tool palette the agent can call, and attached skills.
// ---------------------------------------------------------------------------

interface McpServer {
  name: string;
  status: string;
}

function statusDot(status: string): string {
  if (status === "connected") return "bg-emerald-500";
  if (status === "failed" || status === "error") return "bg-red-500";
  return "bg-gray-300";
}

function SectionHeader({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5 text-[11px] font-medium text-gray-700">
      {icon}
      <span>{label}</span>
      <span className="font-mono text-gray-400">{count}</span>
    </div>
  );
}

function ContextView({
  sessionId,
  harnessSessionId,
  skills,
}: {
  sessionId: string;
  harnessSessionId?: string | null;
  skills: LoadedSkill[];
}) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // No harness yet (session still creating, or failed before bring-up) —
    // there's nothing to query. Surface that instead of spinning forever.
    if (!sessionId || !harnessSessionId) {
      setError("no harness session — context unavailable");
      return;
    }
    let cancelled = false;
    // Clear any stale "no harness" message once the harness is available.
    setError(null);
    const oc = browserOpencodeClient(sessionId);
    void (async () => {
      try {
        const [mcpRes, toolRes] = await Promise.all([
          oc.mcp.status(),
          oc.tool.ids(),
        ]);
        if (cancelled) return;
        const mcpData = (mcpRes.data ?? {}) as Record<
          string,
          { status?: string }
        >;
        setServers(
          Object.entries(mcpData)
            .map(([name, v]) => ({ name, status: v?.status ?? "unknown" }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        setTools(((toolRes.data ?? []) as string[]).slice().sort());
      } catch {
        if (!cancelled) setError("could not reach the harness");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, harnessSessionId]);

  const loading = servers === null && tools === null && !error;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-100">
      {error && (
        <div className="p-3 text-[11px] text-red-500">{error}</div>
      )}
      {loading && (
        <div className="p-3 text-[11px] text-gray-400">loading context…</div>
      )}

      {/* MCP servers */}
      <section>
        <SectionHeader
          icon={<Plug className="size-3.5 text-gray-500" />}
          label="MCP servers"
          count={servers?.length ?? 0}
        />
        {servers && servers.length === 0 && (
          <div className="px-3 pb-2 text-[11px] text-gray-400">
            no MCP servers connected
          </div>
        )}
        {servers?.map((s) => (
          <div
            key={s.name}
            className="flex items-center gap-2 px-3 py-1 text-[11px]"
          >
            <span
              className={`size-1.5 rounded-full shrink-0 ${statusDot(s.status)}`}
            />
            <span className="font-mono text-gray-700 truncate">{s.name}</span>
            <span className="ml-auto font-mono text-[10px] text-gray-400">
              {s.status}
            </span>
          </div>
        ))}
      </section>

      {/* Tools */}
      <section>
        <SectionHeader
          icon={<Wrench className="size-3.5 text-gray-500" />}
          label="Tools"
          count={tools?.length ?? 0}
        />
        {tools && tools.length === 0 && (
          <div className="px-3 pb-2 text-[11px] text-gray-400">
            no tools available
          </div>
        )}
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {tools?.map((t) => (
            <span
              key={t}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
            >
              {t}
            </span>
          ))}
        </div>
      </section>

      {/* Skills */}
      <section>
        <SectionHeader
          icon={<Sparkles className="size-3.5 text-gray-500" />}
          label="Skills"
          count={skills.length}
        />
        {skills.length === 0 && (
          <div className="px-3 pb-2 text-[11px] text-gray-400">
            no skills attached
          </div>
        )}
        {skills.map((sk) => (
          <div key={sk.id} className="px-3 py-1">
            <div className="font-mono text-[11px] text-gray-700">{sk.name}</div>
            {sk.description && (
              <div className="text-[10.5px] text-gray-400 truncate">
                {sk.description}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

export function InspectorPanel({
  open,
  onClose,
  sessionId,
  harnessSessionId,
  skills = [],
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  harnessSessionId?: string | null;
  skills?: LoadedSkill[];
}) {
  const [tab, setTab] = useState<"events" | "context">("events");
  const [frames, setFrames] = useState<Frame[]>([]);
  const [hideHeartbeat, setHideHeartbeat] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !sessionId || !harnessSessionId) return;
    let cancelled = false;
    const ctl = new AbortController();
    const oc = browserOpencodeClient(sessionId);
    void (async () => {
      let events;
      try {
        events = await oc.event.subscribe({ signal: ctl.signal });
      } catch {
        return;
      }
      try {
        for await (const ev of events.stream) {
          if (cancelled) break;
          const e = ev as unknown as OcEvent;
          // Show ALL events on the bus, including subagent (child) sessions a
          // `task` tool spawns — otherwise a hang inside a subagent looks like
          // "nothing happening". Child-session rows are tagged "subagent".
          setFrames((prev) => [...prev.slice(-999), { ts: Date.now(), ev: e }]);
        }
      } catch {
        // aborted on close / stream ended
      }
    })();
    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [open, sessionId, harnessSessionId]);

  // Pin to newest as frames arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frames]);

  if (!open) return null;

  const shown = hideHeartbeat
    ? frames.filter((f) => f.ev.type !== "server.heartbeat")
    : frames;

  return (
    <aside className="flex flex-col h-full min-h-0 border-l border-gray-200 bg-white w-[560px] shrink-0">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-gray-200">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab("events")}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] font-medium ${
              tab === "events"
                ? "bg-gray-100 text-gray-800"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Activity className="size-3.5" />
            Events
          </button>
          <button
            type="button"
            onClick={() => setTab("context")}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] font-medium ${
              tab === "context"
                ? "bg-gray-100 text-gray-800"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Plug className="size-3.5" />
            Context
          </button>
        </div>
        <span className="font-mono text-[11px] text-gray-400">
          {sessionId.slice(0, 8)}…
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1 hover:bg-gray-100 rounded"
          title="Close inspector"
        >
          <X className="size-4 text-gray-500" />
        </button>
      </header>

      {tab === "events" ? (
        <>
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
              onClick={() => setFrames([])}
              className="text-gray-500 hover:text-gray-800 underline-offset-2 hover:underline"
            >
              clear
            </button>
            <span className="ml-auto text-gray-400 font-mono">
              {shown.length} events
            </span>
          </div>

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
            {shown.map((f, i) => (
              <EventRow key={i} frame={f} currentSid={harnessSessionId} />
            ))}
            {shown.length === 0 && (
              <div className="p-3 text-[11px] text-gray-400 text-center leading-relaxed">
                subscribed to the opencode /event bus
                <br />
                events appear as the agent loop emits them
              </div>
            )}
          </div>

          <footer className="px-4 py-1.5 border-t border-gray-200 text-[10px] text-gray-400 font-mono">
            GET /sessions/:id/opencode/event
          </footer>
        </>
      ) : (
        <>
          <ContextView
            sessionId={sessionId}
            harnessSessionId={harnessSessionId}
            skills={skills}
          />
          <footer className="px-4 py-1.5 border-t border-gray-200 text-[10px] text-gray-400 font-mono">
            GET /sessions/:id/opencode/mcp · /tool/ids
          </footer>
        </>
      )}
    </aside>
  );
}

// Keep the old name exported for backwards compat with any other importer.
export { InspectorPanel as InspectorDialog };
