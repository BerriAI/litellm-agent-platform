"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronRight,
  MoreHorizontal,
  PanelRight,
  ArrowUp,
  Image as ImageIcon,
  Loader2,
  ChevronDown,
  Wrench,
  RotateCw,
} from "lucide-react";
import {
  ApiError,
  AgentRow,
  HarnessMessage,
  HarnessMessagePart,
  SessionRow,
  api,
  getAgent,
  getSession,
  listSessionMessages,
  sendMessageStream,
} from "@/lib/api";
import { AgentAvatar } from "@/components/agent-avatar";

type LocalRole = "user" | "assistant";

type LocalStatus = "queued" | "in_progress" | "completed" | "failed";

interface LocalMessage {
  id: string;
  role: LocalRole;
  // user msgs use `text`. assistant msgs use `parts` once `completed`.
  // `text` on assistant is reserved for the failed/error path.
  text?: string;
  parts?: HarnessMessagePart[];
  status: LocalStatus;
  error?: string;
}

// Map opencode's `[{info, parts}, ...]` thread into the local message
// structure. User entries collapse to text-only; assistant entries carry
// the full parts array so reasoning/tool blocks render.
function mapHarnessMessages(msgs: HarnessMessage[]): LocalMessage[] {
  return msgs.map((m) => {
    const role: LocalRole = m.info?.role === "user" ? "user" : "assistant";
    if (role === "user") {
      const text = (m.parts ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
      return {
        id: m.info.id,
        role,
        text,
        status: "completed",
      };
    }
    return {
      id: m.info.id,
      role,
      parts: m.parts ?? [],
      status: "completed",
    };
  });
}

const POLL_INTERVAL_MS = 5000;
const NEAR_BOTTOM_PX = 200;
const COUNTDOWN_TICK_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Render the idle-reap countdown for a `ready` sandbox. Reconciler reaps
// `ready` sessions that haven't had message activity within
// `idle_timeout_ms` (24h by default). Returns null when the session isn't
// active, so callers can skip rendering entirely.
function formatExpiresIn(
  session: SessionRow | null,
  nowMs: number,
): string | null {
  if (!session || session.status !== "ready") return null;
  const lastSeenIso = session.last_seen_at ?? session.created_at;
  if (!lastSeenIso) return null;
  const lastSeenMs = Date.parse(lastSeenIso);
  if (Number.isNaN(lastSeenMs)) return null;
  const idleMs = session.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS;
  const remainingMs = lastSeenMs + idleMs - nowMs;
  if (remainingMs <= 0) return "expiring now";
  const totalMin = Math.floor(remainingMs / 60_000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `expires in ${h}h ${m}m`;
  }
  if (totalMin >= 1) return `expires in ${totalMin}m`;
  const sec = Math.max(1, Math.floor(remainingMs / 1000));
  return `expires in ${sec}s`;
}

export default function SessionThreadView() {
  const params = useParams<{ sid: string }>();
  const sessionId = params?.sid || "";

  const [session, setSession] = useState<SessionRow | null>(null);
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<boolean>(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Guards re-entry of the queue drain effect. The effect re-fires every
  // time `messages` changes, including when the drain mutates a row, so
  // without a ref we'd race ourselves.
  const drainingRef = useRef<boolean>(false);
  // Holds the AbortController for the in-flight streaming send. The
  // unmount cleanup aborts it so the client fetch and the upstream SSE
  // subscription both tear down — without this, navigating away during a
  // stream leaves the upstream subscription open until the harness hits
  // its keepalive timeout.
  const sendAbortRef = useRef<AbortController | null>(null);

  const hasInProgress = useMemo(
    () => messages.some((m) => m.status === "in_progress"),
    [messages],
  );

  const currentModel = agent?.model ?? "";
  const currentAgentName = useMemo(() => {
    if (agent?.name?.trim()) return agent.name.trim();
    if (session) return session.agent_id;
    return "";
  }, [session, agent]);

  // Pull the full opencode thread and replace local state. Source of truth
  // lives in the harness — POST /message only returns the final assistant
  // turn, so we re-fetch after every send to pick up tool/reasoning parts
  // from the agent loop.
  //
  // Local rows for follow-ups the user queued while a previous turn was in
  // flight aren't in the harness yet, so we splice them onto the end of the
  // refreshed thread. They keep their local-id until the drain ships them
  // and the next refresh picks them up under their harness id.
  const refreshThread = useCallback(async () => {
    if (!sessionId) return;
    try {
      const msgs = await listSessionMessages(sessionId);
      const harnessMapped = mapHarnessMessages(msgs);
      setMessages((prev) => {
        const localTail: LocalMessage[] = [];
        for (let i = 0; i < prev.length; i++) {
          const m = prev[i];
          if (m.role === "assistant" && m.status === "queued") {
            const userMsg = i > 0 ? prev[i - 1] : null;
            if (
              userMsg &&
              userMsg.role === "user" &&
              userMsg.id.startsWith("local-")
            ) {
              localTail.push(userMsg);
            }
            localTail.push(m);
          }
        }
        return [...harnessMapped, ...localTail];
      });
    } catch (e) {
      // Harness can be unreachable mid-spawn — leave existing thread alone.
      console.warn("listSessionMessages failed", e);
    }
  }, [sessionId]);

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const s = await getSession(sessionId);
      setSession(s);
      try {
        setAgent(await getAgent(s.agent_id));
      } catch {
        setAgent(null);
      }
      if (s.status === "ready") {
        await refreshThread();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, refreshThread]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Restart a dead/failed session. The backend POST takes 60-120s while a
  // fresh Fargate task spins up; keep the UI responsive (the button shows a
  // spinner) and re-fetch the session once it returns so the new ready state
  // and replayed thread land naturally.
  const handleRestart = useCallback(async () => {
    if (!sessionId || restarting) return;
    // Manual restart of a healthy sandbox is destructive — it stops the
    // running Fargate task and spawns a new one. The history is replayed,
    // but in-flight tool runs / unsaved scratch state are lost. Confirm.
    if (session?.status === "ready") {
      const ok = window.confirm(
        "Restart will stop the current sandbox and start a fresh one. " +
          "Conversation history will be replayed; in-flight work is lost.\n\n" +
          "Continue?",
      );
      if (!ok) return;
    }
    setRestarting(true);
    setRestartError(null);
    try {
      await api<unknown>(
        "POST",
        `/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/restart`,
      );
      await loadSession();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setRestartError(msg);
    } finally {
      setRestarting(false);
    }
  }, [sessionId, restarting, loadSession, session]);

  // Refresh session status periodically so creating→ready transitions are
  // visible in the header and the composer enables when the harness is up.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getSession(sessionId);
        if (cancelled) return;
        setSession(s);
      } catch {
        // silent
      }
    };
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId]);

  // First load on a session URL: jump straight to the latest turn so the
  // user lands at the live end of the conversation (matches Slack, iMessage,
  // every chat UI). After that, fall back to "auto-scroll only if the user
  // is already near the bottom" so we don't yank them off content they're
  // reading higher up in the thread.
  const lastMessageCountRef = useRef<number>(0);
  const didInitialScrollRef = useRef<boolean>(false);
  useEffect(() => {
    const c = scrollContainerRef.current;
    if (!c) return;
    const newCount = messages.length;
    const grew = newCount > lastMessageCountRef.current;
    lastMessageCountRef.current = newCount;

    if (!didInitialScrollRef.current && newCount > 0) {
      didInitialScrollRef.current = true;
      messagesEndRef.current?.scrollIntoView({
        behavior: "auto",
        block: "end",
      });
      return;
    }

    const distanceFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    const nearBottom = distanceFromBottom < NEAR_BOTTOM_PX;
    if (grew && nearBottom) {
      messagesEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
  }, [messages]);

  // Always enqueue. The drain effect below picks up the next `queued` row
  // and POSTs it to the harness; submitting while a previous turn is still
  // in flight is the supported path — the new message lands as `queued` and
  // the drain processes it FIFO.
  const handleSend = useCallback(() => {
    const content = draft.trim();
    if (!content || !sessionId) return;
    if (session?.status !== "ready") {
      setError(
        `Session is not ready yet (status=${session?.status ?? "unknown"}).`,
      );
      return;
    }
    setError(null);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userId = `local-${stamp}`;
    const assistantId = `local-${stamp}-a`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: content, status: "completed" },
      { id: assistantId, role: "assistant", status: "queued" },
    ]);
    setDraft("");
  }, [draft, sessionId, session]);

  // Queue drain: at most one in-flight stream per session. When the
  // in-flight turn resolves and there's a `queued` assistant row waiting,
  // kick the next. FIFO ordering carries through `messages` ordering — no
  // separate queue structure to keep in sync. After a successful stream we
  // re-fetch the full thread so tool/reasoning parts from the agent loop
  // render correctly (bus events alone don't reconstruct earlier loop
  // iterations).
  useEffect(() => {
    if (drainingRef.current) return;
    if (!sessionId || session?.status !== "ready") return;
    if (
      messages.some(
        (m) => m.role === "assistant" && m.status === "in_progress",
      )
    ) {
      return;
    }
    const idx = messages.findIndex(
      (m) => m.role === "assistant" && m.status === "queued",
    );
    if (idx === -1) return;

    const queuedAssistant = messages[idx];
    const userMsg = idx > 0 ? messages[idx - 1] : null;
    if (!userMsg || userMsg.role !== "user" || !userMsg.text) return;
    const userText = userMsg.text;
    const assistantId = queuedAssistant.id;

    drainingRef.current = true;

    // All state mutations live inside the async task so they happen after
    // the effect body returns — sidesteps `react-hooks/set-state-in-effect`
    // and keeps render scheduling predictable.
    void (async () => {
      setError(null);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, status: "in_progress" } : m,
        ),
      );

      const ctl = new AbortController();
      sendAbortRef.current = ctl;

      try {
        // Stream token deltas live. `message.part.delta` carries text or
        // thinking chunks per partID; we accumulate per-part and render the
        // result as a list of parts so each block (text, thinking, tool)
        // renders distinctly. After `done` we refreshThread() to pull
        // canonical state (tool inputs/outputs that the bus deltas don't
        // reconstruct on their own).
        type StreamPart = { id: string; type: "text" | "thinking"; text: string };
        const partsState: Map<string, StreamPart> = new Map();
        const renderStreaming = () => {
          // Stable order: insertion order matches the order parts were first
          // seen on the bus, which matches the order the model produced
          // them (thinking before text, etc).
          const partsArray = Array.from(partsState.values()).map((p) => ({
            id: p.id,
            type: p.type,
            text: p.text,
          })) as HarnessMessagePart[];
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, text: undefined, parts: partsArray, status: "in_progress" }
                : m,
            ),
          );
        };
        const ingestDelta = (
          partID: string,
          delta: string,
          field: "text" | "thinking",
        ) => {
          const cur = partsState.get(partID) ?? {
            id: partID,
            type: field,
            text: "",
          };
          cur.text += delta;
          // If a partID flips field mid-stream (shouldn't happen, but be
          // defensive), trust the latest field type.
          cur.type = field;
          partsState.set(partID, cur);
        };
        await sendMessageStream(
          sessionId,
          { text: userText },
          (frame) => {
            if (frame.type !== "harness_event" || !frame.event) return;
            const ev = frame.event;
            const props = ev.properties ?? {};
            if (ev.type === "message.part.delta") {
              const partID = props.partID as string | undefined;
              const delta = props.delta as string | undefined;
              const field = props.field as string | undefined;
              if (!partID || !delta) return;
              if (field !== "text" && field !== "thinking") return;
              ingestDelta(partID, delta, field);
              renderStreaming();
            } else if (ev.type === "message.part.updated") {
              // Authoritative replacement when we missed earlier deltas
              // (or when the model bundles a block without per-token deltas,
              // which is what Haiku does for thinking today).
              const part = props.part as
                | { id?: string; type?: string; text?: string }
                | undefined;
              if (
                part?.id &&
                (part.type === "text" || part.type === "thinking") &&
                typeof part.text === "string"
              ) {
                partsState.set(part.id, {
                  id: part.id,
                  type: part.type,
                  text: part.text,
                });
                renderStreaming();
              }
            }
          },
          { signal: ctl.signal },
        );
        await refreshThread();
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error).message;
        setError(msg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text: msg, status: "failed", error: msg }
              : m,
          ),
        );
      } finally {
        sendAbortRef.current = null;
        drainingRef.current = false;
      }
    })();
  }, [messages, sessionId, session?.status, refreshThread]);

  // Abort any in-flight stream when the route unmounts so the underlying
  // fetch and the upstream SSE subscription both tear down cleanly.
  useEffect(() => {
    return () => {
      sendAbortRef.current?.abort();
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="sessions-app flex w-full h-full bg-white text-gray-900 overflow-hidden">
      <MainPanel
        session={session}
        agent={agent}
        agentName={currentAgentName}
        messages={messages}
        loading={loading}
        error={error}
        hasInProgress={hasInProgress}
        currentModel={currentModel}
        draft={draft}
        setDraft={setDraft}
        handleSend={handleSend}
        handleKeyDown={handleKeyDown}
        messagesEndRef={messagesEndRef}
        scrollContainerRef={scrollContainerRef}
        restarting={restarting}
        restartError={restartError}
        handleRestart={handleRestart}
      />
    </div>
  );
}

// =====================================================================
// MAIN PANEL
// =====================================================================

interface MainPanelProps {
  session: SessionRow | null;
  agent: AgentRow | null;
  agentName: string;
  messages: LocalMessage[];
  loading: boolean;
  error: string | null;
  hasInProgress: boolean;
  currentModel: string;
  draft: string;
  setDraft: (s: string) => void;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  restarting: boolean;
  restartError: string | null;
  handleRestart: () => void;
}

function MainPanel({
  session,
  agent,
  agentName,
  messages,
  loading,
  error,
  hasInProgress,
  currentModel,
  draft,
  setDraft,
  handleSend,
  handleKeyDown,
  messagesEndRef,
  scrollContainerRef,
  restarting,
  restartError,
  handleRestart,
}: MainPanelProps) {
  const sessionShortId = session?.id ? session.id.slice(0, 8) : "—";
  const statusLabel = session?.status ?? "unknown";
  const isReady = session?.status === "ready";
  const isDead = statusLabel === "dead" || statusLabel === "failed";

  // Re-render the idle countdown every 30s so the header label stays fresh
  // without spamming server polls. Detached from the existing 5s session
  // poll because the countdown is purely client-side arithmetic.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  const expiresLabel = formatExpiresIn(session, nowMs);
  const canRestart = !!session && statusLabel !== "creating";

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-white overflow-hidden">
      {/* Header */}
      <div className="h-12 border-b border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-2 text-[13px] text-gray-600 min-w-0">
          <AgentAvatar
            name={agent?.name ?? agentName}
            pfpUrl={agent?.pfp_url}
            size={22}
          />
          {agent ? (
            <Link
              href={`/agents/${agent.id}`}
              className="font-medium text-gray-800 transition-colors hover:underline"
            >
              {agentName || "Agent"}
            </Link>
          ) : (
            <span className="font-medium text-gray-800">
              {agentName || "Session"}
            </span>
          )}
          <ChevronRight className="w-3 h-3 text-gray-300 shrink-0" aria-hidden />
          <span className="text-gray-700 truncate">
            Session{" "}
            <span className="font-mono text-[12px] text-gray-500">
              {sessionShortId}
            </span>
          </span>
          <span
            aria-hidden
            title={statusLabel}
            className={`shrink-0 size-1.5 rounded-full ${
              statusLabel === "ready"
                ? "bg-emerald-500"
                : statusLabel === "creating"
                  ? "bg-amber-500"
                  : statusLabel === "failed" || statusLabel === "dead"
                    ? "bg-red-500"
                    : "bg-gray-300"
            }`}
          />
          <span className="mono text-[11px] text-gray-500">{statusLabel}</span>
          {expiresLabel && (
            <>
              <span className="text-gray-300" aria-hidden>·</span>
              <span
                className="mono text-[11px] text-gray-500"
                title="Sandbox is reaped after the idle window. Send a message to reset the timer."
              >
                {expiresLabel}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-gray-400">
          <button
            type="button"
            onClick={handleRestart}
            disabled={!canRestart || restarting}
            title={
              statusLabel === "creating"
                ? "Sandbox is still spinning up"
                : isReady
                  ? "Restart sandbox (replays history)"
                  : "Restart sandbox"
            }
            className="inline-flex items-center gap-1.5 text-[12px] text-gray-600 border border-gray-200 rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {restarting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCw className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">
              {restarting ? "Restarting…" : "Restart"}
            </span>
          </button>
          <button className="p-1.5 hover:bg-gray-100 rounded">
            <MoreHorizontal className="w-4 h-4" />
          </button>
          <button className="p-1.5 hover:bg-gray-100 rounded">
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Scrollable thread */}
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[720px] mx-auto w-full py-10 px-6 flex flex-col gap-6">
          {loading && messages.length === 0 && (
            <div className="text-[13px] text-gray-400">Loading…</div>
          )}
          {!loading && messages.length === 0 && !isReady && (
            <div className="text-[13px] text-gray-400">
              Sandbox is {statusLabel}. Wait for it to become{" "}
              <span className="font-mono">ready</span> before sending a message.
            </div>
          )}
          {!loading && messages.length === 0 && isReady && (
            <div className="text-[13px] text-gray-400">
              Sandbox is ready. Send a message below.
            </div>
          )}

          {isDead && (
            <div className="border border-gray-200 bg-gray-50 rounded-lg px-4 py-3 flex items-start gap-3">
              <div className="flex-1 text-[13px] text-gray-700 leading-relaxed">
                Sandbox ended (
                <span className="mono text-[12px] text-gray-500">
                  {statusLabel}
                </span>
                ) — prior conversation was preserved. Use the Restart
                button in the header to start a fresh sandbox; the saved
                history will replay as the first message.
              </div>
            </div>
          )}
          {restartError && (
            <div className="border border-red-200 bg-red-50 rounded-lg px-4 py-3 text-[13px] text-red-800">
              <div className="font-medium">Restart failed</div>
              <div className="mono text-[11px] text-red-700 mt-1 break-words">
                {restartError}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <MessageBlock
              key={m.id}
              msg={m}
              isFirstUser={
                m.role === "user" &&
                messages.slice(0, i).every((x) => x.role !== "user")
              }
            />
          ))}

          <div ref={messagesEndRef} />
          <div className="h-4" />
        </div>
      </div>

      {/* Sticky composer */}
      <div className="flex-shrink-0 border-t border-gray-200 bg-white">
        <div className="max-w-[720px] mx-auto w-full px-6 py-4">
          <Composer
            draft={draft}
            setDraft={setDraft}
            hasInProgress={hasInProgress}
            currentModel={currentModel}
            error={error}
            disabled={!isReady}
            handleSend={handleSend}
            handleKeyDown={handleKeyDown}
          />
        </div>
      </div>
    </div>
  );
}

function MessageBlock({
  msg,
  isFirstUser,
}: {
  msg: LocalMessage;
  isFirstUser: boolean;
}) {
  if (msg.role === "user") {
    return <UserPromptBlock content={msg.text ?? ""} emphasized={isFirstUser} />;
  }
  return <AssistantBlock msg={msg} />;
}

// Cap any single message at ~60% of the viewport so an oversized prompt or a
// huge assistant reply (e.g. the agent dumping a whole file) doesn't shove
// every other message off-screen. The block itself scrolls internally; the
// page keeps scrolling past it.
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

function AssistantBlock({ msg }: { msg: LocalMessage }) {
  const failed = msg.status === "failed";
  const inProgress = msg.status === "in_progress";
  const queued = msg.status === "queued";
  const parts = msg.parts ?? [];

  // Render parts in order. Skip step-start/step-finish — internal markers
  // with no UI affordance. Group consecutive text parts so markdown lists
  // still render correctly.
  const visibleParts = parts.filter((p) => {
    const t = typeof p?.type === "string" ? p.type : "";
    return t === "text" || t === "reasoning" || t === "thinking" || t === "tool";
  });

  return (
    <div
      className="flex flex-col gap-3 overflow-y-auto"
      style={{ maxHeight: MESSAGE_MAX_HEIGHT }}
    >
      {failed && msg.text ? (
        <div
          className="sessions-md text-[14px] leading-relaxed"
          style={{ color: "#b91c1c" }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      ) : queued ? (
        <div className="flex items-center gap-2 text-[13px] text-gray-400 leading-relaxed">
          <span aria-hidden className="size-1.5 rounded-full bg-gray-300" />
          queued — will send when current finishes
        </div>
      ) : inProgress && visibleParts.length === 0 ? (
        // Streamed deltas land on `msg.text` (parts only get populated after
        // refreshThread() runs on `done`). Render the running text live so
        // tokens show as they arrive; fall back to a thinking spinner only
        // when we have nothing to display yet.
        msg.text ? (
          <div className="sessions-md text-[14px] text-gray-800 leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[14px] text-gray-400 leading-relaxed">
            <Loader2 className="w-3 h-3 animate-spin" />
            thinking…
          </div>
        )
      ) : (
        visibleParts.map((p, i) => (
          <PartBlock key={i} part={p} />
        ))
      )}

      {failed && msg.error && (
        <div className="mono text-[11px] text-red-700">{msg.error}</div>
      )}
    </div>
  );
}

function PartBlock({ part }: { part: HarnessMessagePart }) {
  const t = typeof part?.type === "string" ? part.type : "";
  if (t === "text") {
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) return null;
    return (
      <div className="sessions-md text-[14px] text-gray-800 leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  if (t === "thinking") {
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) return null;
    return <ThinkingBlock text={text} />;
  }
  if (t === "reasoning") {
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) return null;
    return <ReasoningBlock text={text} />;
  }
  if (t === "tool") {
    return <ToolBlock part={part} />;
  }
  return null;
}

function ThinkingBlock({ text }: { text: string }) {
  // Claude.ai-style: a small "Thinking" pill collapsed by default; clicking
  // reveals the full reasoning in a subdued gray box. Default-collapsed so
  // it doesn't compete visually with the actual response.
  const [open, setOpen] = useState(false);
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

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
  return (
    <div className="border-l-2 border-gray-200 pl-3 text-[13px] text-gray-500 italic leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-start gap-1 text-left hover:text-gray-700"
      >
        <ChevronDown
          className={`w-3 h-3 mt-1 shrink-0 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="whitespace-pre-wrap">
          {open ? text : preview}
        </span>
      </button>
    </div>
  );
}

function ToolBlock({ part }: { part: HarnessMessagePart }) {
  const [open, setOpen] = useState(false);
  const toolName =
    typeof part.tool === "string" ? part.tool : "tool";
  const state = (part.state as Record<string, unknown> | undefined) ?? {};
  const status =
    typeof state.status === "string" ? state.status : "unknown";
  const input = state.input;
  const output = state.output;
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
          {input !== undefined && (
            <ToolKv label="input" value={input} />
          )}
          {output !== undefined && (
            <ToolKv label="output" value={output} />
          )}
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
// COMPOSER
// =====================================================================

interface ComposerProps {
  draft: string;
  setDraft: (s: string) => void;
  hasInProgress: boolean;
  currentModel: string;
  error: string | null;
  disabled: boolean;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

function Composer({
  draft,
  setDraft,
  hasInProgress,
  currentModel,
  error,
  disabled,
  handleSend,
  handleKeyDown,
}: ComposerProps) {
  // Submitting while a previous message is in flight is supported — the new
  // message lands in the FIFO queue and the drain effect picks it up. So the
  // textarea stays enabled and the send button is gated only on a non-empty
  // draft + a ready sandbox.
  const canSend = draft.trim().length > 0 && !disabled;
  const placeholder = disabled
    ? "Sandbox not ready yet…"
    : hasInProgress
      ? "Queue a follow up"
      : "Add a follow up";

  return (
    <div className="border border-gray-200 rounded-xl shadow-sm bg-white overflow-hidden focus-within:ring-1 focus-within:ring-gray-300 focus-within:border-gray-300 transition-all">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="w-full p-4 outline-none resize-none text-[15px] placeholder:text-gray-400 bg-transparent"
      />
      <div className="flex items-center justify-between px-4 pb-3 text-xs text-gray-500">
        <span className="mono">
          {error ? (
            <span className="text-red-600">{error}</span>
          ) : (
            currentModel || "Enter to send · Shift+Enter for newline"
          )}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="hover:text-gray-700 transition-colors"
            aria-label="Attach"
            disabled
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="bg-black text-white p-1.5 rounded-full hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:hover:bg-black"
            aria-label={hasInProgress ? "Queue follow-up" : "Send"}
            title={
              hasInProgress
                ? "Queue follow-up — sends when the current message finishes"
                : "Send (Enter)"
            }
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
