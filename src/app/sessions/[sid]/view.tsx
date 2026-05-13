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
  Stethoscope,
  RefreshCw,
  Copy,
  Check,
  Activity,
} from "lucide-react";
import {
  ApiError,
  AgentRow,
  DiagnoseDetectedIssue,
  DiagnoseResponse,
  HarnessMessage,
  HarnessMessagePart,
  SessionRow,
  api,
  getAgent,
  getDiagnose,
  getSandboxLogs,
  getSession,
  listSessionMessages,
  sendMessageStream,
} from "@/lib/api";
import { AgentAvatar } from "@/components/agent-avatar";
import { InspectorPanel } from "@/components/inspector-dialog";
import {
  SdkStreamPanel,
  useSdkMessageStream,
  type SdkStreamStatus,
} from "./sdk-stream";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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
  // Wall-clock ms from the user pressing send to the assistant reply
  // landing in the UI (sendMessage POST + refreshThread GET combined).
  // Set only on the most recent assistant message after a successful send.
  latency_ms?: number;
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
// Re-render the spawn-progress card every 250ms so the elapsed-time counter
// and the auto-advancing step indicator both stay smooth. 5s session-status
// polling is too coarse for the elapsed counter; this is purely client-side.
const SPAWN_PROGRESS_TICK_MS = 250;

// Spawn-progress steps. Each step maps to one or more `Session.phase`
// values written by the backend (`coldBringUp` / `warmBringUp` /
// `finishBringUp`) and by the in-sandbox harness (`cloning_repo`,
// `installing_deps`, `harness_listening`). The `fromMs` field is the
// fallback wall-clock threshold used only when `session.phase` is null —
// i.e. for legacy rows created before the phase column existed.
//
// Source of truth ordering: the index here is the canonical order shown to
// the user. The runtime ordering of phase writes follows the same sequence,
// so as the platform / harness advances we can map any received phase to a
// step index without re-sorting.
//
// Phase -> step mapping:
//   creating_sandbox                                   -> Creating sandbox
//   pod_pending                                        -> Pod scheduling
//   pod_running, waiting_harness                       -> Image pull / boot
//   harness_ready, harness_listening                   -> Harness ready
//   cloning_repo, installing_deps                      -> Cloning repo
//   ready                                              -> (UI swaps to chat)
interface SpawnStep {
  label: string;
  phases: ReadonlyArray<string>;
  fromMs: number;
}
const SPAWN_STEPS: ReadonlyArray<SpawnStep> = [
  {
    label: "Creating sandbox",
    phases: ["creating_sandbox"],
    fromMs: 0,
  },
  {
    label: "Pod scheduling",
    phases: ["pod_pending"],
    fromMs: 2_000,
  },
  {
    label: "Image pull / boot",
    phases: ["pod_running", "waiting_harness"],
    fromMs: 10_000,
  },
  {
    label: "Harness ready",
    phases: ["harness_ready", "harness_listening"],
    fromMs: 25_000,
  },
  {
    label: "Cloning repo",
    phases: ["cloning_repo", "installing_deps"],
    fromMs: 35_000,
  },
];

// Map a backend phase string to a SPAWN_STEPS index. Returns null when the
// phase is unrecognised (e.g. a future phase value rolled out before the
// frontend catches up) so the caller can fall back to the wall-clock path.
function phaseToStepIndex(phase: string | null | undefined): number | null {
  if (!phase) return null;
  for (let i = 0; i < SPAWN_STEPS.length; i++) {
    if (SPAWN_STEPS[i].phases.includes(phase)) return i;
  }
  return null;
}

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

  // Disabled — the passive EventSource was double-rendering with the
  // /message_stream-driven assistant message. /message_stream is the single
  // source of truth for live updates now.
  const sdkStreamEnabled = false;
  const { messages: sdkMessages, status: sdkStreamStatus } =
    useSdkMessageStream(sessionId, sdkStreamEnabled);

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

    // Wall-clock from "we picked this up off the queue" to "refreshThread
    // landed the canonical row". Stamped onto the assistant message after
    // the stream + refresh finishes so the UI can show round-trip latency.
    const sendStartMs = performance.now();

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
        // partsState stores ANY part type the harness produces (text /
        // thinking / reasoning / tool). The order tracks insertion, which
        // matches the order parts were first observed on the bus.
        const partsState: Map<string, HarnessMessagePart> = new Map();
        const renderStreaming = () => {
          const partsArray = Array.from(partsState.values());
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
          const cur = (partsState.get(partID) ?? {
            id: partID,
            type: field,
            text: "",
          }) as HarnessMessagePart;
          (cur as { text?: string }).text =
            ((cur as { text?: string }).text || "") + delta;
          // If a partID flips field mid-stream, trust the latest field type.
          (cur as { type?: string }).type = field;
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
              // Authoritative replacement. The harness sends the FULL part
              // object — text deltas resolved, tool inputs/outputs filled.
              // Store it verbatim so tool blocks render in the streaming
              // view too (not just after refreshThread).
              const part = props.part as HarnessMessagePart | undefined;
              const rawId = part
                ? (part as Record<string, unknown>).id
                : undefined;
              if (part && typeof rawId === "string") {
                partsState.set(rawId, part);
                renderStreaming();
              }
            }
          },
          { signal: ctl.signal },
        );
        await refreshThread();
        const elapsedMs = Math.round(performance.now() - sendStartMs);
        // Stamp the freshly-arrived assistant message (the last one in the
        // thread) with the round-trip latency. refreshThread has already
        // replaced the optimistic in_progress placeholder, so we mutate the
        // most recent assistant row in-place. Skip if the thread is empty.
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant") {
              const next = prev.slice();
              next[i] = { ...next[i], latency_ms: elapsedMs };
              return next;
            }
          }
          return prev;
        });
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

  const [inspectorOpen, setInspectorOpen] = useState(false);

  return (
    <div className="sessions-app flex w-full h-full bg-white text-gray-900 overflow-hidden">
      <MainPanel
        session={session}
        agent={agent}
        agentName={currentAgentName}
        messages={messages}
        sdkMessages={sdkMessages}
        sdkStreamStatus={sdkStreamStatus}
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
        inspectorOpen={inspectorOpen}
        setInspectorOpen={setInspectorOpen}
      />
      <InspectorPanel
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        sessionId={sessionId}
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
  sdkMessages: SDKMessage[];
  sdkStreamStatus: SdkStreamStatus;
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
  inspectorOpen: boolean;
  setInspectorOpen: (v: boolean) => void;
}

function MainPanel({
  session,
  agent,
  agentName,
  messages,
  sdkMessages,
  sdkStreamStatus,
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
  inspectorOpen,
  setInspectorOpen,
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

  // Diagnose panel — universally available regardless of session state.
  // Slow/misbehaving ready sessions need it as much as stuck/failed ones,
  // so we mount the button on every status.
  const [diagnoseOpen, setDiagnoseOpen] = useState<boolean>(false);

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
            onClick={() => session && setInspectorOpen(!inspectorOpen)}
            disabled={!session}
            title="Inspector — tail the platform envelope + raw harness bus for this session"
            className={`inline-flex items-center gap-1.5 text-[12px] border rounded px-2 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              inspectorOpen
                ? "bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100"
                : "border-gray-200 text-gray-600 hover:bg-gray-100"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Inspect</span>
          </button>
          <button
            type="button"
            onClick={() => session && setDiagnoseOpen(true)}
            disabled={!session}
            title="Diagnose — fetch pod, service, node, warm-pool, and harness-probe state"
            className="inline-flex items-center gap-1.5 text-[12px] text-gray-600 border border-gray-200 rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Stethoscope className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Diagnose</span>
          </button>
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

      {session && diagnoseOpen && (
        <DiagnosePanel
          sessionId={session.id}
          onClose={() => setDiagnoseOpen(false)}
        />
      )}

      {/* Scrollable thread */}
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[720px] mx-auto w-full py-10 px-6 flex flex-col gap-6">
          {loading && messages.length === 0 && (
            <div className="text-[13px] text-gray-400">Loading…</div>
          )}
          {!loading && session && statusLabel === "creating" && (
            <div className="flex flex-col gap-4 max-w-md mx-auto w-full">
              <SpawnProgress session={session} />
              <SandboxLogs sessionId={session.id} isCreating={true} />
            </div>
          )}
          {!loading &&
            session &&
            statusLabel === "failed" &&
            session.failure_reason && (
              <div className="flex flex-col gap-4 max-w-md mx-auto w-full">
                <SpawnFailed reason={session.failure_reason} />
                <SandboxLogs sessionId={session.id} isCreating={false} />
              </div>
            )}
          {!loading &&
            messages.length === 0 &&
            !isReady &&
            statusLabel !== "creating" &&
            statusLabel !== "failed" && (
              <div className="text-[13px] text-gray-400">
                Sandbox is {statusLabel}. Wait for it to become{" "}
                <span className="font-mono">ready</span> before sending a
                message.
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

          {/*
            Live SDKMessage stream from the harness's new
            `claude_sdk_message` envelope. Additive — the historical
            /messages replay below is still the source of truth for the
            legacy `message.part.*` wire format. If the same logical
            message appears in both, the streaming row is fresher and
            wins by being rendered first.
          */}
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

      {!inProgress && !failed && typeof msg.latency_ms === "number" && (
        <div className="mono text-[11px] text-gray-400">
          {formatLatency(msg.latency_ms)}
        </div>
      )}
    </div>
  );
}

// Render the round-trip duration in the smallest unit that keeps it
// readable: ms under 1s, seconds with one decimal otherwise.
function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

// =====================================================================
// SPAWN PROGRESS — creating-state UI
// =====================================================================

// Cursor-style progress card shown while the backend bring-up runs.
// Step highlighting is driven by `session.phase` (written by the platform's
// coldBringUp / warmBringUp / finishBringUp and by the in-sandbox harness).
// When `phase` is null — legacy rows created before the column existed —
// the card falls back to the wall-clock thresholds on each step's
// `fromMs`, matching the original PR #34 behaviour.
function SpawnProgress({ session }: { session: SessionRow }) {
  // `Date.now()` is impure — keep it out of render. Stash the start
  // timestamp on first render via a ref (init via `useState` lazy
  // initializer, which only runs once) and let the interval tick the
  // "now" value through useState. Same pattern as the formatExpiresIn
  // countdown above.
  const [startMs] = useState<number>(() => {
    if (!session.created_at) return Date.now();
    const t = Date.parse(session.created_at);
    return Number.isNaN(t) ? Date.now() : t;
  });

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(
      () => setNowMs(Date.now()),
      SPAWN_PROGRESS_TICK_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  const elapsedMs = Math.max(0, nowMs - startMs);

  // Prefer real phase data. Falls back to the wall-clock approximation
  // only when the backend hasn't written a phase yet (null on legacy rows,
  // or briefly during the ~50ms window between session-row create and the
  // first `setPhase` write).
  const phaseIdx = phaseToStepIndex(session.phase);
  let activeIdx: number;
  if (phaseIdx !== null) {
    activeIdx = phaseIdx;
  } else {
    activeIdx = 0;
    for (let i = 0; i < SPAWN_STEPS.length; i++) {
      if (elapsedMs >= SPAWN_STEPS[i].fromMs) activeIdx = i;
    }
  }
  const usingPhase = phaseIdx !== null;
  const phaseDetail = session.phase_detail ?? null;

  return (
    <div className="border border-gray-200 bg-white rounded-xl shadow-sm px-6 py-5 max-w-md mx-auto w-full">
      <div className="flex items-center gap-2 mb-1">
        <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
        <span className="text-[15px] font-medium text-gray-800">
          Spinning up sandbox…
        </span>
      </div>
      <div className="mono text-[11px] text-gray-400 mb-4">
        elapsed {formatElapsed(elapsedMs)}
        {!usingPhase && <span className="ml-1">(approx.)</span>}
      </div>
      <ol className="flex flex-col gap-2">
        {SPAWN_STEPS.map((step, i) => {
          const isActive = i === activeIdx;
          const isDone = i < activeIdx;
          return (
            <li
              key={step.label}
              className="flex flex-col gap-0.5 text-[13px]"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`shrink-0 size-1.5 rounded-full ${
                    isActive
                      ? "bg-amber-500"
                      : isDone
                        ? "bg-emerald-500"
                        : "bg-gray-300"
                  }`}
                />
                <span
                  className={
                    isActive
                      ? "text-gray-900 font-medium"
                      : isDone
                        ? "text-gray-500"
                        : "text-gray-400"
                  }
                >
                  {step.label}
                </span>
                {isActive && (
                  <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                )}
              </div>
              {isActive && phaseDetail && (
                <div className="ml-3.5 text-[11px] text-gray-500 truncate">
                  {phaseDetail}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-4 text-[11px] text-gray-400 leading-relaxed">
        Cold start typically takes 30-90s. You can navigate away and come
        back — bring-up runs in the background.
      </div>
    </div>
  );
}

function SpawnFailed({ reason }: { reason: string }) {
  return (
    <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-3 max-w-md mx-auto w-full">
      <div className="text-[13px] font-medium text-red-800">
        Sandbox failed to start
      </div>
      <div className="mono text-[11px] text-red-700 mt-1 break-words">
        {reason}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

// =====================================================================
// SANDBOX LOGS — live tail of the harness pod's stdout/stderr
// =====================================================================

// Poll cadence for the log tail. ~1.5s keeps the experience feeling live
// without hammering the apiserver during long cold-spawns. Each tick
// requests only the last 10 min / 500 lines so a slow K8s endpoint can't
// land a giant payload on us.
const SANDBOX_LOG_POLL_INTERVAL_MS = 1_500;
const SANDBOX_LOG_SINCE_SECONDS = 600;
const SANDBOX_LOG_TAIL_LINES = 500;

interface SandboxLogsProps {
  sessionId: string;
  /**
   * True while the session is still spinning up. The component polls only
   * while this is true; when it flips to false it renders one final
   * snapshot of whatever it has and stops fetching.
   */
  isCreating: boolean;
}

// =====================================================================
// DIAGNOSE PANEL — one-shot debug bundle modal
// =====================================================================

// Section keys rendered as collapsible accordions, in the order they appear
// in the modal. `pod_logs_tail` and `detected_issues` are surfaced separately
// (logs in a dark terminal-style pre, issues as colored cards up top).
const DIAGNOSE_SECTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "session", label: "session" },
  { key: "agent", label: "agent" },
  { key: "pod", label: "pod" },
  { key: "sandbox_cr", label: "sandbox_cr" },
  { key: "service", label: "service" },
  { key: "node", label: "node" },
  { key: "image_cache", label: "image_cache" },
  { key: "warm_pool", label: "warm_pool" },
  { key: "harness_probe", label: "harness_probe" },
  { key: "notes", label: "notes" },
];

interface DiagnosePanelProps {
  sessionId: string;
  onClose: () => void;
}

/**
 * Full-screen modal that fetches the one-shot diagnose bundle and renders it.
 * Layout: detected_issues at the top as colored cards (red/yellow/blue by
 * severity), then a terminal-style pod_logs_tail, then collapsible sections
 * for every other top-level key. Refresh re-fetches without closing; Copy
 * JSON puts the raw response on the clipboard.
 *
 * The fetch lives in a useEffect keyed on `refreshKey` so the initial load
 * fires once on mount and re-fires only when the user clicks Refresh — not on
 * every re-render. An AbortController tears down the in-flight request when
 * the modal closes or another refresh starts.
 */
function DiagnosePanel({ sessionId, onClose }: DiagnosePanelProps) {
  const [data, setData] = useState<DiagnoseResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const ctl = new AbortController();
    // Keep all state mutations inside the async task so they fire after the
    // effect body returns — sidesteps `react-hooks/set-state-in-effect` and
    // matches the queue-drain pattern used elsewhere in this file.
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await getDiagnose(sessionId, { signal: ctl.signal });
        if (cancelled) return;
        setData(resp);
      } catch (e) {
        if (cancelled) return;
        if ((e as { name?: string })?.name === "AbortError") return;
        const msg = e instanceof ApiError ? e.message : (e as Error).message;
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [sessionId, refreshKey]);

  // Esc-to-close. Captured on the document so a focused element inside the
  // modal (a collapsed-section button, the textarea, etc.) doesn't swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail (insecure context, permission denied).
      // Surface as a transient error so the user knows it didn't go through.
      setError("Copy to clipboard failed");
    }
  }, [data]);

  const issues = Array.isArray(data?.detected_issues) ? data.detected_issues : [];
  const logsTail = extractLogsTail(data?.pod_logs_tail);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-gray-600" />
            <span className="text-[14px] font-medium text-gray-800">
              Diagnose
            </span>
            <span className="mono text-[11px] text-gray-400">
              session {sessionId.slice(0, 8)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
              title="Re-fetch"
              className="inline-flex items-center gap-1.5 text-[12px] text-gray-600 border border-gray-200 rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!data || loading}
              title="Copy full JSON to clipboard"
              className="inline-flex items-center gap-1.5 text-[12px] text-gray-600 border border-gray-200 rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{copied ? "Copied" : "Copy JSON"}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="p-1.5 hover:bg-gray-100 rounded text-gray-500"
              aria-label="Close"
            >
              <span aria-hidden>×</span>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-4 py-4 flex flex-col gap-4">
            {loading && !data && (
              <div className="flex items-center gap-2 text-[13px] text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Gathering diagnostics…
              </div>
            )}

            {error && (
              <div className="border border-red-200 bg-red-50 rounded-lg px-4 py-3 text-[13px] text-red-800">
                <div className="font-medium">Diagnose failed</div>
                <div className="mono text-[11px] text-red-700 mt-1 break-words">
                  {error}
                </div>
              </div>
            )}

            {data && (
              <>
                <DetectedIssuesList issues={issues} />

                {logsTail && (
                  <DiagnoseLogsSection
                    text={logsTail.text}
                    error={logsTail.error}
                  />
                )}

                <div className="flex flex-col gap-2">
                  {DIAGNOSE_SECTIONS.map((s) => {
                    if (!(s.key in data)) return null;
                    return (
                      <DiagnoseSection
                        key={s.key}
                        label={s.label}
                        value={(data as Record<string, unknown>)[s.key]}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetectedIssuesList({
  issues,
}: {
  issues: DiagnoseDetectedIssue[];
}) {
  if (issues.length === 0) {
    return (
      <div className="border border-emerald-200 bg-emerald-50 rounded-lg px-4 py-3">
        <div className="text-[13px] font-medium text-emerald-800">
          No issues detected
        </div>
        <div className="text-[12px] text-emerald-700 mt-0.5">
          The diagnostic ruleset did not flag anything. If the session is still
          misbehaving, inspect the pod_logs_tail and harness_probe sections
          below.
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {issues.map((iss, i) => (
        <IssueCard key={`${iss.code}-${i}`} issue={iss} />
      ))}
    </div>
  );
}

function IssueCard({ issue }: { issue: DiagnoseDetectedIssue }) {
  const palette =
    issue.severity === "high"
      ? "border-red-200 bg-red-50 text-red-800"
      : issue.severity === "med"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-blue-200 bg-blue-50 text-blue-900";
  const codeColor =
    issue.severity === "high"
      ? "text-red-700"
      : issue.severity === "med"
        ? "text-amber-800"
        : "text-blue-800";
  return (
    <div className={`border rounded-lg px-4 py-3 ${palette}`}>
      <div className="flex items-center gap-2">
        <span
          className={`mono text-[11px] uppercase tracking-wide ${codeColor}`}
        >
          {issue.severity}
        </span>
        <span className={`mono text-[11px] ${codeColor}`}>{issue.code}</span>
      </div>
      <div className="text-[13px] mt-1 leading-relaxed">{issue.message}</div>
      {issue.recommended_action && (
        <div className="text-[12px] mt-2 leading-relaxed opacity-90">
          <span className="font-medium">Recommended: </span>
          {issue.recommended_action}
        </div>
      )}
    </div>
  );
}

// The backend sends pod_logs_tail in two possible shapes — the structured
// `{ available, text?, error? }` envelope used in route.ts today, and a bare
// string (older callers / docs). Handle both so the UI doesn't break if the
// envelope ever loosens.
function extractLogsTail(
  value: unknown,
): { text: string; error?: string } | null {
  if (typeof value === "string") return { text: value };
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const text = typeof v.text === "string" ? v.text : "";
    const error = typeof v.error === "string" ? v.error : undefined;
    if (text || error) return { text, error };
  }
  return null;
}

function DiagnoseLogsSection({
  text,
  error,
}: {
  text: string;
  error?: string;
}) {
  const [open, setOpen] = useState<boolean>(true);
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 border-b border-gray-200"
      >
        <ChevronDown
          className={`w-3 h-3 text-gray-400 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="mono text-[11px] text-gray-500">pod_logs_tail</span>
        <span className="mono text-[11px] text-gray-400 ml-auto">
          {error ? "error" : "last 200 lines"}
        </span>
      </button>
      {open && (
        <pre
          className="mono text-[11px] leading-snug whitespace-pre-wrap break-words px-3 py-2 overflow-y-auto"
          style={{
            maxHeight: 320,
            backgroundColor: "#1c1b18",
            color: "#e8e4dc",
          }}
        >
          {error ? (
            <span className="text-amber-300 italic">{error}</span>
          ) : text.length === 0 ? (
            <span className="text-gray-500 italic">(empty)</span>
          ) : (
            text
          )}
        </pre>
      )}
    </div>
  );
}

function DiagnoseSection({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <ChevronDown
          className={`w-3 h-3 text-gray-400 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="mono text-[12px] text-gray-700">{label}</span>
      </button>
      {open && (
        <pre className="mono text-[11px] text-gray-700 whitespace-pre-wrap break-words bg-gray-50 border-t border-gray-200 px-3 py-2 max-h-80 overflow-auto">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function SandboxLogs({ sessionId, isCreating }: SandboxLogsProps) {
  // Collapsed by default — Cursor-style affordance. The dark terminal block
  // only renders (and only polls) when the user opens it. The last fetched
  // text is retained across collapse/expand so re-opening shows previous
  // content instantly while a fresh fetch is in flight.
  const [expanded, setExpanded] = useState<boolean>(false);
  const [logText, setLogText] = useState<string>("");
  // Tracks whether we've already done the post-creating "final snapshot"
  // fetch. Once isCreating flips to false we want exactly one more fetch
  // (capturing the tail end of the boot logs) and then nothing else.
  // Using state (not ref) so the indicator label re-renders to
  // "final snapshot" once the fetch lands.
  const [finalSnapshotDone, setFinalSnapshotDone] = useState<boolean>(false);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Polling effect. Only runs when the user has expanded the panel AND the
  // session is still creating. On expand we fetch immediately, then every
  // SANDBOX_LOG_POLL_INTERVAL_MS thereafter. When isCreating flips false
  // while expanded, we issue one final snapshot fetch and stop.
  //
  // The setFinalSnapshotDone(...) calls below happen inside async callbacks
  // (after `await`), not synchronously in the effect body — that's what the
  // `react-hooks/set-state-in-effect` rule actually cares about.
  useEffect(() => {
    if (!sessionId || !expanded) return;
    let cancelled = false;
    let timerId: number | null = null;
    let inflight: AbortController | null = null;

    const fetchOnce = async (): Promise<void> => {
      if (cancelled) return;
      const ctl = new AbortController();
      inflight = ctl;
      try {
        const text = await getSandboxLogs(sessionId, {
          sinceSeconds: SANDBOX_LOG_SINCE_SECONDS,
          tailLines: SANDBOX_LOG_TAIL_LINES,
          signal: ctl.signal,
        });
        if (cancelled) return;
        setLogText(text);
      } catch (e) {
        // AbortError on teardown is expected — swallow. Other errors leave
        // the previous snapshot in place; the next tick will retry.
        if ((e as { name?: string })?.name === "AbortError") return;
        console.warn("sandbox_logs poll failed", e);
      } finally {
        if (inflight === ctl) inflight = null;
      }
    };

    const loop = async (): Promise<void> => {
      // Reset the final-snapshot guard if we're polling a session that's
      // currently creating — covers the manual-restart case where a session
      // goes ready → creating → ready and needs a fresh final snapshot.
      if (isCreating) setFinalSnapshotDone(false);
      await fetchOnce();
      if (cancelled) return;
      if (!isCreating) {
        // One-shot post-creating snapshot. Mark done so toggling expand
        // off/on after the session is ready doesn't keep re-fetching.
        setFinalSnapshotDone(true);
        return;
      }
      timerId = window.setTimeout(() => {
        void loop();
      }, SANDBOX_LOG_POLL_INTERVAL_MS);
    };

    // Skip the network round-trip entirely if we've already captured the
    // final snapshot for this session — re-expanding shows the cached text.
    if (!isCreating && finalSnapshotDone) {
      return () => {
        cancelled = true;
      };
    }

    void loop();

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      inflight?.abort();
    };
  }, [sessionId, expanded, isCreating, finalSnapshotDone]);

  // Auto-scroll to bottom on every text update so new lines stay visible.
  // We unconditionally pin to bottom (no "user scrolled up" affordance)
  // because the panel is small (240px) and the use case is "watch it boot,"
  // not "scroll back through history."
  useEffect(() => {
    if (!expanded) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logText, expanded]);

  const empty = logText.length === 0;
  const indicatorLabel = isCreating
    ? "tail -f"
    : finalSnapshotDone
      ? "final snapshot"
      : "snapshot";

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <ChevronDown
          className={`w-3 h-3 text-gray-500 shrink-0 transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
          aria-hidden
        />
        <span className="mono text-[11px] text-gray-600">sandbox stdout</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              isCreating ? "bg-emerald-500 animate-pulse" : "bg-gray-300"
            }`}
          />
          <span className="mono text-[11px] text-gray-400">
            {indicatorLabel}
          </span>
        </span>
      </button>
      {expanded && (
        <pre
          ref={preRef}
          className="mono text-[11px] leading-snug whitespace-pre-wrap break-words px-3 py-2 overflow-y-auto border-t border-gray-200"
          style={{
            height: 240,
            backgroundColor: "#1c1b18",
            color: "#e8e4dc",
          }}
        >
          {empty ? (
            <span className="text-gray-500 italic">
              Waiting for sandbox to start logging…
            </span>
          ) : (
            logText
          )}
        </pre>
      )}
    </div>
  );
}
