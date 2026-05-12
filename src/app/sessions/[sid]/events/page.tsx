"use client";

/**
 * Demo page for the unified SessionEvent log.
 *
 * Long-polls GET /api/v1/managed_agents/sessions/{sid}/events?since=N&wait=10
 * and renders the rows by grouping them into "turns" (one user_message and
 * the assistant parts that follow). Visual idioms mirror the existing
 * session view (UserPromptBlock / assistant markdown / ThinkingBlock /
 * ToolBlock) so this page sits inside the rest of the light-theme app
 * instead of looking like a debug console.
 */

import React, { useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Wrench, Loader2 } from "lucide-react";

import type { SessionEvent } from "@lap/harness-shared/session-event";

type Row = { seq: number; event: SessionEvent; ts?: string };

// =====================================================================
// Auth
// =====================================================================

function readDemoToken(): string | null {
  if (typeof window === "undefined") return null;
  return (
    window.localStorage.getItem("demo_token") ||
    window.localStorage.getItem("ui_master_key") ||
    null
  );
}

// =====================================================================
// Visual blocks — copied from view.tsx so this page can render without
// pulling in HarnessMessagePart. Keep the class lists identical so the
// look matches pixel-for-pixel.
// =====================================================================

const MESSAGE_MAX_HEIGHT = "60vh";

function UserPromptBlock({
  content,
  emphasized,
}: {
  content: string;
  emphasized: boolean;
}) {
  return (
    <div
      className={`bg-[#f9f9f9] border border-gray-100 rounded-xl p-4 text-[14px] text-gray-700 leading-relaxed whitespace-pre-wrap overflow-y-auto ${
        emphasized ? "shadow-sm" : ""
      }`}
      style={{ maxHeight: MESSAGE_MAX_HEIGHT }}
    >
      {content}
    </div>
  );
}

function AssistantTextBlock({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="sessions-md text-[14px] text-gray-800 leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50/60 text-[13px] text-gray-600">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-gray-100"
      >
        <ChevronDown
          className={`w-3 h-3 shrink-0 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="font-medium">Thinking</span>
        <span className="text-gray-400">·</span>
        <span className="text-gray-400 text-[11px]">
          {open ? "click to collapse" : "click to expand"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-gray-200 px-3 py-2 italic leading-relaxed whitespace-pre-wrap text-gray-500">
          {text}
        </div>
      ) : null}
    </div>
  );
}

type ToolStatus = "running" | "completed" | "error" | "unknown";

function ToolBlock({
  toolName,
  status,
  input,
  output,
}: {
  toolName: string;
  status: ToolStatus;
  input: unknown;
  output: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const hasDetails = input !== undefined || output !== undefined;
  const statusColor =
    status === "completed"
      ? "text-emerald-600"
      : status === "error"
        ? "text-red-600"
        : status === "running"
          ? "text-amber-600"
          : "text-gray-500";

  return (
    <div className="border border-gray-200 rounded-md bg-gray-50/60 text-[13px]">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left ${
          hasDetails ? "hover:bg-gray-100 cursor-pointer" : "cursor-default"
        }`}
      >
        <Wrench className="w-3 h-3 text-gray-500 shrink-0" />
        <span className="mono text-gray-700">{toolName}</span>
        <span className={`mono text-[11px] ${statusColor}`}>{status}</span>
        {status === "running" ? (
          <Loader2 className="w-3 h-3 text-amber-600 animate-spin" />
        ) : null}
        {hasDetails && (
          <ChevronDown
            className={`ml-auto w-3 h-3 text-gray-400 transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
        )}
      </button>
      {open && hasDetails && (
        <div className="border-t border-gray-200 px-3 py-2 flex flex-col gap-2">
          {input !== undefined && <ToolKv label="input" value={input} />}
          {output !== undefined && <ToolKv label="output" value={output} />}
        </div>
      )}
    </div>
  );
}

function ToolKv({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="flex flex-col gap-1">
      <span className="mono text-[10px] uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <pre className="mono text-[11px] text-gray-700 whitespace-pre-wrap break-words bg-white border border-gray-200 rounded p-2 max-h-64 overflow-auto">
        {text}
      </pre>
    </div>
  );
}

// =====================================================================
// Status / phase chips — small inline pill, never loud.
// =====================================================================

function StatusChip({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string | null;
  tone: "ok" | "warn" | "neutral";
}) {
  const dot =
    tone === "ok"
      ? "bg-emerald-400"
      : tone === "warn"
        ? "bg-amber-400"
        : "bg-gray-300";
  return (
    <div className="flex items-center gap-1.5 mono text-[11px] text-gray-400">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      <span>{label}</span>
      <span className="text-gray-500">{value}</span>
      {detail ? <span className="text-gray-400">— {detail}</span> : null}
    </div>
  );
}

function statusTone(status: string): "ok" | "warn" | "neutral" {
  if (status === "ready") return "ok";
  if (status === "failed" || status === "dead") return "warn";
  return "neutral";
}

// =====================================================================
// Turn grouping. A user_message opens a turn; turn_complete closes it.
// Events that arrive before any user_message (status/phase) go into a
// leading bootstrap turn with user=null.
// =====================================================================

interface Turn {
  user: Row | null;
  parts: Row[];
  done: Row | null;
}

function groupIntoTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const row of rows) {
    const t = row.event.type;
    if (t === "user_message") {
      current = { user: row, parts: [], done: null };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { user: null, parts: [], done: null };
      turns.push(current);
    }
    if (t === "turn_complete") {
      current.done = row;
      current = null;
      continue;
    }
    current.parts.push(row);
  }
  return turns;
}

// =====================================================================
// Tool merge — fold tool_result rows into their matching tool_call by
// call_id so the UI shows ONE bordered card per tool invocation.
// =====================================================================

type RenderItem =
  | { kind: "assistant_text"; row: Row; text: string }
  | { kind: "thinking"; row: Row; text: string }
  | {
      kind: "tool";
      row: Row;
      toolName: string;
      input: unknown;
      status: ToolStatus;
      output: string | undefined;
    }
  | {
      kind: "status";
      row: Row;
      label: string;
      value: string;
      detail?: string | null;
      tone: "ok" | "warn" | "neutral";
    }
  | { kind: "error"; row: Row; message: string };

function buildRenderItems(parts: Row[]): RenderItem[] {
  // Pre-index tool_result rows by call_id so each tool_call lookup is O(1).
  const resultByCallId = new Map<
    string,
    Extract<SessionEvent, { type: "tool_result" }>
  >();
  for (const row of parts) {
    if (row.event.type === "tool_result") {
      resultByCallId.set(row.event.call_id, row.event);
    }
  }
  const callIds = new Set(
    parts
      .filter((r) => r.event.type === "tool_call")
      .map((r) =>
        (r.event as Extract<SessionEvent, { type: "tool_call" }>).call_id,
      ),
  );

  const items: RenderItem[] = [];
  for (const row of parts) {
    const e = row.event;
    switch (e.type) {
      case "assistant_text":
        items.push({ kind: "assistant_text", row, text: e.text });
        break;
      case "thinking":
        items.push({ kind: "thinking", row, text: e.text });
        break;
      case "tool_call": {
        const matched = resultByCallId.get(e.call_id);
        const status: ToolStatus = matched
          ? matched.is_error
            ? "error"
            : "completed"
          : "running";
        items.push({
          kind: "tool",
          row,
          toolName: e.tool,
          input: e.input,
          status,
          output: matched?.output,
        });
        break;
      }
      case "tool_result":
        // Already folded into the matching tool_call above; only render
        // orphans (no matching call in this turn) so nothing silently
        // disappears.
        if (!callIds.has(e.call_id)) {
          items.push({
            kind: "status",
            row,
            label: "tool_result",
            value: e.call_id,
            detail: e.is_error ? "error" : null,
            tone: e.is_error ? "warn" : "neutral",
          });
        }
        break;
      case "status":
        items.push({
          kind: "status",
          row,
          label: "status",
          value: e.status,
          detail: e.detail,
          tone: statusTone(e.status),
        });
        break;
      case "phase":
        items.push({
          kind: "status",
          row,
          label: "phase",
          value: e.phase,
          detail: e.detail ?? null,
          tone: "neutral",
        });
        break;
      case "error":
        items.push({ kind: "error", row, message: e.message });
        break;
      default:
        // user_message / turn_complete handled by groupIntoTurns.
        break;
    }
  }
  return items;
}

// =====================================================================
// turn_complete footer — small mono line, matches AssistantBlock latency.
// =====================================================================

function formatCost(cost: number | null): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function TurnFooter({ row }: { row: Row }) {
  if (row.event.type !== "turn_complete") return null;
  const e = row.event;
  const usageBits: string[] = [];
  if (e.usage) {
    if (typeof e.usage.input === "number")
      usageBits.push(`in ${e.usage.input}`);
    if (typeof e.usage.output === "number")
      usageBits.push(`out ${e.usage.output}`);
    if (typeof e.usage.cache_read === "number")
      usageBits.push(`cache_r ${e.usage.cache_read}`);
    if (typeof e.usage.cache_write === "number")
      usageBits.push(`cache_w ${e.usage.cache_write}`);
  }
  return (
    <div className="mono text-[11px] text-gray-400">
      {formatCost(e.cost_usd)}
      {usageBits.length > 0 ? ` · ${usageBits.join(" · ")}` : ""}
    </div>
  );
}

// =====================================================================
// Page
// =====================================================================

export default function SessionEventsDemoPage() {
  const params = useParams<{ sid: string }>();
  const sid = params?.sid ?? "";

  const [rows, setRows] = React.useState<Row[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [polling, setPolling] = React.useState<boolean>(true);

  React.useEffect(() => {
    if (!sid) return;
    let cancelled = false;
    let since = 0;

    const poll = async (): Promise<void> => {
      while (!cancelled) {
        try {
          setPolling(true);
          const token = readDemoToken();
          const headers: Record<string, string> = {};
          if (token) headers.authorization = `Bearer ${token}`;
          const url = `/api/v1/managed_agents/sessions/${encodeURIComponent(
            sid,
          )}/events?since=${since}&wait=10`;
          const res = await fetch(url, { headers, cache: "no-store" });
          if (!res.ok) {
            const text = await res.text();
            if (!cancelled)
              setError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          const body = (await res.json()) as {
            events: Array<{ seq: number; event: SessionEvent }>;
            next_since: number;
          };
          if (cancelled) return;
          setError(null);
          if (body.events.length > 0) {
            setRows((prev) => [...prev, ...body.events]);
          }
          since = body.next_since;
        } catch (e: unknown) {
          if (!cancelled)
            setError(e instanceof Error ? e.message : String(e));
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      setPolling(false);
    };
  }, [sid]);

  const turns = groupIntoTurns(rows);

  return (
    <div className="min-h-screen bg-white text-gray-800">
      <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
        <header className="flex flex-wrap items-center gap-3 border-b border-gray-100 pb-4">
          <span className="mono text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-0.5">
            {sid || "—"}
          </span>
          <span
            className="mono text-[11px] text-gray-400"
            data-testid="event-count"
          >
            {rows.length} events
          </span>
          <span className="flex items-center gap-1.5 mono text-[11px] text-gray-400 ml-auto">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                polling ? "animate-pulse bg-emerald-400" : "bg-gray-300"
              }`}
            />
            {polling ? "live" : "idle"}
          </span>
        </header>

        {error ? (
          <div className="mono text-[11px] text-red-700 border border-red-200 bg-red-50 rounded px-2 py-1">
            {error}
          </div>
        ) : null}

        {turns.map((turn, ti) => {
          const items = buildRenderItems(turn.parts);
          return (
            <div
              key={ti}
              className="flex flex-col gap-3"
              data-turn-index={ti}
            >
              {turn.user ? (
                <UserPromptBlock
                  content={
                    turn.user.event.type === "user_message"
                      ? turn.user.event.text
                      : ""
                  }
                  emphasized={ti === 0}
                />
              ) : null}

              {items.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {items.map((item) => {
                    const seq = item.row.seq;
                    if (item.kind === "assistant_text") {
                      return (
                        <div
                          key={seq}
                          data-event-type="assistant_text"
                          data-seq={seq}
                        >
                          <AssistantTextBlock text={item.text} />
                        </div>
                      );
                    }
                    if (item.kind === "thinking") {
                      return (
                        <div
                          key={seq}
                          data-event-type="thinking"
                          data-seq={seq}
                        >
                          <ThinkingBlock text={item.text} />
                        </div>
                      );
                    }
                    if (item.kind === "tool") {
                      return (
                        <div
                          key={seq}
                          data-event-type="tool_call"
                          data-seq={seq}
                        >
                          <ToolBlock
                            toolName={item.toolName}
                            status={item.status}
                            input={item.input}
                            output={item.output}
                          />
                        </div>
                      );
                    }
                    if (item.kind === "status") {
                      return (
                        <div
                          key={seq}
                          data-event-type={item.label}
                          data-seq={seq}
                        >
                          <StatusChip
                            label={item.label}
                            value={item.value}
                            detail={item.detail}
                            tone={item.tone}
                          />
                        </div>
                      );
                    }
                    if (item.kind === "error") {
                      return (
                        <div
                          key={seq}
                          data-event-type="error"
                          data-seq={seq}
                          className="mono text-[11px] text-red-700"
                        >
                          {item.message}
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              ) : null}

              {turn.done ? (
                <div
                  data-event-type="turn_complete"
                  data-seq={turn.done.seq}
                >
                  <TurnFooter row={turn.done} />
                </div>
              ) : null}
            </div>
          );
        })}

        {turns.length === 0 && !error ? (
          <div className="mono text-[11px] text-gray-400">
            waiting for events…
          </div>
        ) : null}

        {rows.length > 0 ? <DebugEventLog rows={rows} /> : null}

        <MessageInput sid={sid} />
      </div>
    </div>
  );
}

// =====================================================================
// Message input — POSTs to /sessions/{id}/message. The 202 response
// returns immediately; the new SessionEvents stream in via the existing
// long-poll above, so there's nothing to do here on success besides
// clear the textarea.
// =====================================================================

function MessageInput({ sid }: { sid: string }) {
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setErr(null);
    try {
      const token = readDemoToken();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(
        `/api/v1/managed_agents/sessions/${encodeURIComponent(sid)}/message`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ text: trimmed }),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        setErr(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        return;
      }
      setText("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sticky bottom-4 mt-6">
      <div className="border border-gray-200 rounded-xl bg-white shadow-sm p-3 flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Send a follow-up… (⌘↩ to send)"
          className="resize-none outline-none text-[14px] text-gray-800 leading-relaxed bg-transparent placeholder:text-gray-400 min-h-[44px]"
          rows={2}
          disabled={sending}
        />
        <div className="flex items-center gap-2">
          {err ? (
            <span className="mono text-[11px] text-red-700">{err}</span>
          ) : null}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending || !text.trim()}
            className="ml-auto px-3 py-1.5 text-[13px] rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Debug: expandable chronological dump of the raw SessionEvent rows.
// Useful while wiring up the platform — confirms which events landed in
// the DB, in what order, with their full JSON payload.
// =====================================================================

function DebugEventLog({ rows }: { rows: Row[] }) {
  const [expanded, setExpanded] = React.useState<Record<number, boolean>>({});
  return (
    <details className="border-t border-gray-100 pt-4 mt-4 group">
      <summary className="cursor-pointer mono text-[11px] text-gray-400 hover:text-gray-600 select-none flex items-center gap-1.5">
        <span className="inline-block transition-transform group-open:rotate-90">▸</span>
        Debug · raw SessionEvent log ({rows.length} rows)
      </summary>
      <div className="mt-3 flex flex-col gap-1">
        {rows.map((r) => {
          const isOpen = !!expanded[r.seq];
          return (
            <div
              key={r.seq}
              className="border border-gray-200 rounded text-[11px] font-mono"
            >
              <button
                type="button"
                onClick={() =>
                  setExpanded((p) => ({ ...p, [r.seq]: !isOpen }))
                }
                className="w-full px-2 py-1 flex items-center gap-2 text-left hover:bg-gray-50"
              >
                <span className="text-gray-400 tabular-nums w-8">
                  #{r.seq}
                </span>
                <span className="text-gray-700 w-32">{r.event.type}</span>
                <span className="text-gray-400">
                  {r.ts ? r.ts.slice(11, 23) : ""}
                </span>
                <span className="ml-auto text-gray-300">
                  {isOpen ? "−" : "+"}
                </span>
              </button>
              {isOpen ? (
                <pre className="bg-gray-50 border-t border-gray-200 px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-gray-600">
{JSON.stringify(r.event, null, 2)}
                </pre>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}
