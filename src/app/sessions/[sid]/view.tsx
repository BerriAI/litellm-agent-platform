"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronRight,
  MoreHorizontal,
  PanelRight,
  ArrowUp,
  Loader2,
  ChevronDown,
  Wrench,
  RotateCw,
  Stethoscope,
  RefreshCw,
  Copy,
  Check,
  Activity,
  ShieldCheck,
  ScrollText,
  Trash2,
  MessageSquare,
  ExternalLink,
  FileText,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import {
  ApiError,
  AgentRow,
  DiagnoseDetectedIssue,
  DiagnoseResponse,
  HarnessMessagePart,
  SendMessageAttachment,
  SessionOrigin,
  SessionRow,
  SkillRow,
  api,
  abortSession,
  deleteSession,
  getAgent,
  getDiagnose,
  getSandboxLogs,
  getSession,
  listSkills,
} from "@/lib/api";
import { type AgentMessage, type PermissionRequest } from "@/lib/agent-state";
import { AgentAvatar } from "@/components/agent-avatar";
import { SlackLogo } from "@/components/slack-logo";
import { InspectorPanel } from "@/components/inspector-dialog";
import { VaultPanel } from "@/components/vault-dialog";
import { SessionLogPanel } from "./session-log-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useOpencodeThread,
  type SendParts,
  type PermissionResponse,
} from "./opencode-stream";
import { TerminalPanel } from "./terminal-panel";
import { SessionSidebar, extractLatestTasks } from "./session-sidebar";
import { toast } from "sonner";

// Harnesses whose pod exposes a PTY (xterm.js attaches to it directly)
// rather than the JSON message API. Add new TUI harness ids here.
const TUI_HARNESS_IDS = new Set<string>(["claude-code", "codex"]);

type LocalRole = "user" | "assistant";

type LocalStatus = "queued" | "in_progress" | "completed" | "failed";

interface LocalMessage {
  id: string;
  role: LocalRole;
  // user msgs use `text`. assistant msgs use `parts` once `completed`.
  // `text` on assistant is reserved for the failed/error path.
  text?: string;
  parts?: HarnessMessagePart[];
  // Image / file uploads attached to a user message. Populated locally
  // when the composer captures a paste; populated on refresh from the
  // harness thread when an `image` part is present on the user entry.
  // Rendered as thumbnails alongside the prompt text in UserPromptBlock.
  attachments?: SendMessageAttachment[];
  status: LocalStatus;
  error?: string;
  // Wall-clock ms from the user pressing send to the assistant reply
  // landing in the UI (sendMessage POST + refreshThread GET combined).
  // Set only on the most recent assistant message after a successful send.
  latency_ms?: number;
}

// Hard caps for composer attachments. Mirrors the server-side
// `INITIAL_ATTACHMENT_MAX_BYTES` and `INITIAL_ATTACHMENTS_MAX_COUNT` so the
// client surfaces friendly errors before we even POST.
const COMPOSER_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const COMPOSER_ATTACHMENTS_MAX_COUNT = 10;
const COMPOSER_ATTACHMENT_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Subagent sub-threads (child sessionID → messages), provided by the thread
// hook so a `task` tool can render its subagent's work without prop drilling.
const SubThreadsContext = createContext<Map<string, AgentMessage[]>>(new Map());

// Map an opencode-folded AgentMessage into the local render shape. User
// entries collapse to text; assistant entries keep the full parts array so
// text / reasoning / tool blocks render in order.
function agentToLocal(m: AgentMessage): LocalMessage {
  const role: LocalRole = m.role === "user" ? "user" : "assistant";
  if (role === "user") {
    const text = m.parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    const attachments = extractAttachmentsFromParts(
      m.parts as unknown as HarnessMessagePart[],
    );
    return {
      id: m.id,
      role,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      status: "completed",
    };
  }
  return {
    id: m.id,
    role,
    parts: m.parts as unknown as HarnessMessagePart[],
    status: "completed",
  };
}

function extractAttachmentsFromParts(
  parts: HarnessMessagePart[],
): SendMessageAttachment[] {
  const out: SendMessageAttachment[] = [];
  for (const p of parts) {
    if (p?.type !== "image") continue;
    const src = (p as { source?: { media_type?: string; data?: string } })
      .source;
    if (!src || typeof src.media_type !== "string" || typeof src.data !== "string") {
      continue;
    }
    out.push({ mime_type: src.media_type, base64: src.data });
  }
  return out;
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
  const [draft, setDraft] = useState<string>("");
  // Pasted-image attachments staged for the next send. Cleared in handleSend
  // at the same time as `draft` so a successful submit fully resets the
  // composer; an error during stream-send leaves the user message (with its
  // attachments) in the thread so the user can scroll back and see what they
  // sent.
  const [attachments, setAttachments] = useState<SendMessageAttachment[]>([]);
  // Skill slash-command state — shared with Composer
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [activeSkill, setActiveSkill] = useState<SkillRow | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<boolean>(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // Exactly what the user typed, per send, in order. The harness echoes user
  // messages back over /event (sometimes blank or out of order) — we always
  // render OUR copy in the stream's position so the prompt stays as sent and is
  // never overwritten by the echo.
  const [sentUsers, setSentUsers] = useState<
    { text?: string; attachments?: SendMessageAttachment[] }[]
  >([]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const currentModel = agent?.model ?? "";
  const currentAgentName = useMemo(() => {
    if (agent?.name?.trim()) return agent.name.trim();
    if (session) return session.agent_id;
    return "";
  }, [session, agent]);

  // The whole thread is owned by ONE opencode SDK subscription: seed from
  // history, fold the /event bus through the shared reducer, render. `send`
  // fires a prompt; the user echo and the reply — and any turn started from
  // Slack/Linear on this session — all come back over the same stream. No
  // drain, no optimistic state, no refetch reconciliation.
  const ready = !!sessionId && session?.status === "ready";
  const thread = useOpencodeThread(
    sessionId,
    session?.harness_session_id,
    ready,
  );
  // Assistant turns + ordering come from the event stream; user messages are
  // overridden with the locally-sent copy so the harness echo can't change
  // them. In-flight prompts (echo not yet arrived) append at the end.
  const messages = useMemo<LocalMessage[]>(() => {
    const base = thread.messages.map(agentToLocal);
    let u = 0;
    for (let i = 0; i < base.length; i++) {
      if (base[i].role !== "user") continue;
      if (u < sentUsers.length) {
        base[i] = {
          ...base[i],
          text: sentUsers[u].text,
          attachments: sentUsers[u].attachments,
        };
      }
      u++;
    }
    while (u < sentUsers.length) {
      base.push({
        id: `local-user-${u}`,
        role: "user",
        text: sentUsers[u].text,
        attachments: sentUsers[u].attachments,
        status: "completed",
      });
      u++;
    }
    return base;
  }, [thread.messages, sentUsers]);

  // Reset the local prompt copies when switching sessions.
  useEffect(() => {
    setSentUsers([]);
  }, [sessionId]);

  // Surface any session-creation warnings (e.g. MCP tool resolution failure)
  // stored in sessionStorage by the new-session page.
  useEffect(() => {
    if (!sessionId) return;
    const key = `session-warnings:${sessionId}`;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    sessionStorage.removeItem(key);
    try {
      const warnings = JSON.parse(raw) as string[];
      for (const w of warnings) {
        toast.warning(w, { duration: 8000 });
      }
    } catch { /* ignore malformed */ }
  }, [sessionId]);

  const hasInProgress = thread.busy;

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
      // The thread hook owns message loading (seed + live stream); we only
      // fetch session + agent metadata here.
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    listSkills().then(setSkills).catch(() => {});
  }, []);

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
        // Status only. The thread is driven by the SDK stream (live turns) and
        // the one-time load on mount — we don't re-pull the whole session here.
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

  // Fire the prompt and clear the composer. The user echo and the assistant
  // reply both arrive over the thread subscription — no optimistic rows.
  const handleSend = useCallback(() => {
    let content = draft.trim();
    if (!content && attachments.length === 0) return;
    if (session?.status !== "ready") {
      setError(
        `Session is not ready yet (status=${session?.status ?? "unknown"}).`,
      );
      return;
    }
    setError(null);
    // Inject skill content when a skill was selected via slash-command.
    if (activeSkill && content) {
      const prefix = `/${activeSkill.name} `;
      const userText = content.startsWith(prefix)
        ? content.slice(prefix.length).trim()
        : content;
      content = `<skill name="${activeSkill.name}">\n${activeSkill.content}\n</skill>\n\n${userText}`;
      setActiveSkill(null);
    }
    const parts: SendParts = [];
    if (content) parts.push({ type: "text", text: content });
    for (const a of attachments) {
      parts.push({
        type: "file",
        mime: a.mime_type,
        url: `data:${a.mime_type};base64,${a.base64}`,
      });
    }
    // Keep the exact prompt locally so it renders immediately and stays put.
    setSentUsers((prev) => [
      ...prev,
      {
        text: content || undefined,
        attachments: attachments.length > 0 ? [...attachments] : undefined,
      },
    ]);
    setDraft("");
    setAttachments([]);
    void thread
      .send(
        parts,
        currentModel
          ? { providerID: "litellm", modelID: currentModel }
          : undefined,
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [draft, attachments, session, thread, currentModel, activeSkill]);


  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Signal the harness to abort the current turn — fire-and-forget. The thread
  // subscription clears `busy` on the next session.idle / session.aborted.
  const handleAbort = useCallback(() => {
    if (sessionId) {
      abortSession(sessionId).catch((e) =>
        console.warn("abort signal failed:", e),
      );
    }
  }, [sessionId]);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Vault is a sibling top-level toggle to Inspect. We keep the two open
  // states independent so they can be shown together (each renders as a
  // flex-child aside that shrinks the chat column).
  const [vaultOpen, setVaultOpen] = useState(false);
  // Session Log: another sibling top-level toggle (flex-child aside). Reads the
  // durable event timeline from the DB so it works even for dead sessions.
  const [logOpen, setLogOpen] = useState(false);

  // Tasks panel is driven entirely by the agent's latest plan-tool call.
  const sessionTasks = useMemo(
    () => extractLatestTasks(messages.map((m) => m.parts)),
    [messages],
  );

  return (
    <SubThreadsContext.Provider value={thread.subThreads}>
    <div className="sessions-app flex w-full h-full bg-background text-foreground overflow-hidden">
      <MainPanel
        session={session}
        agent={agent}
        agentName={currentAgentName}
        messages={messages}
        permissions={thread.permissions}
        onRespondPermission={thread.respondPermission}
        loading={loading}
        error={error ?? thread.error ?? null}
        setError={setError}
        hasInProgress={hasInProgress}
        currentModel={currentModel}
        draft={draft}
        setDraft={setDraft}
        attachments={attachments}
        setAttachments={setAttachments}
        handleSend={handleSend}
        handleKeyDown={handleKeyDown}
        handleAbort={handleAbort}
        messagesEndRef={messagesEndRef}
        scrollContainerRef={scrollContainerRef}
        restarting={restarting}
        restartError={restartError}
        handleRestart={handleRestart}
        inspectorOpen={inspectorOpen}
        setInspectorOpen={setInspectorOpen}
        vaultOpen={vaultOpen}
        setVaultOpen={setVaultOpen}
        logOpen={logOpen}
        setLogOpen={setLogOpen}
        skills={skills}
        activeSkill={activeSkill}
        setActiveSkill={setActiveSkill}
      />
      <SessionSidebar tasks={sessionTasks} />
      <SessionLogPanel
        open={logOpen}
        onClose={() => setLogOpen(false)}
        sessionId={sessionId}
      />
      <VaultPanel
        open={vaultOpen}
        onClose={() => setVaultOpen(false)}
        sessionId={sessionId}
      />
      <InspectorPanel
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        sessionId={sessionId}
        harnessSessionId={session?.harness_session_id}
      />
    </div>
    </SubThreadsContext.Provider>
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
  permissions: PermissionRequest[];
  onRespondPermission: (
    permissionID: string,
    permSessionID: string,
    response: PermissionResponse,
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
  setError: (s: string | null) => void;
  hasInProgress: boolean;
  currentModel: string;
  draft: string;
  setDraft: (s: string) => void;
  attachments: SendMessageAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<SendMessageAttachment[]>>;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handleAbort: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  restarting: boolean;
  restartError: string | null;
  handleRestart: () => void;
  inspectorOpen: boolean;
  setInspectorOpen: (v: boolean) => void;
  vaultOpen: boolean;
  setVaultOpen: (v: boolean) => void;
  logOpen: boolean;
  setLogOpen: (v: boolean) => void;
  skills: SkillRow[];
  activeSkill: SkillRow | null;
  setActiveSkill: (s: SkillRow | null) => void;
}

function MainPanel({
  session,
  agent,
  agentName,
  messages,
  permissions,
  onRespondPermission,
  loading,
  error,
  setError,
  hasInProgress,
  currentModel,
  draft,
  setDraft,
  attachments,
  setAttachments,
  handleSend,
  handleKeyDown,
  handleAbort,
  messagesEndRef,
  scrollContainerRef,
  restarting,
  restartError,
  handleRestart,
  inspectorOpen,
  setInspectorOpen,
  vaultOpen,
  setVaultOpen,
  logOpen,
  setLogOpen,
  skills,
  activeSkill,
  setActiveSkill,
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
  const router = useRouter();
  const [diagnoseOpen, setDiagnoseOpen] = useState<boolean>(false);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);

  const [deleteSessionOpen, setDeleteSessionOpen] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);

  async function handleDeleteSession() {
    if (!session || deletingSession) return;
    setDeletingSession(true);
    try {
      await deleteSession(session.id);
      router.push("/sessions");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setDeleteSessionError(msg);
      setDeletingSession(false);
      setDeleteSessionOpen(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-background overflow-hidden relative">
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground min-w-0">
          <AgentAvatar
            name={agent?.name ?? agentName}
            pfpUrl={agent?.pfp_url}
            size={22}
          />
          {agent ? (
            <Link
              href={`/agents/${agent.id}`}
              className="font-medium text-foreground transition-colors hover:underline"
            >
              {agentName || "Agent"}
            </Link>
          ) : (
            <span className="font-medium text-foreground">
              {agentName || "Session"}
            </span>
          )}
          <ChevronRight className="w-3 h-3 text-muted-foreground/40 shrink-0" aria-hidden />
          <span className="text-foreground truncate">
            Session{" "}
            <span className="font-mono text-[12px] text-muted-foreground">
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
                    : "bg-muted-foreground/40"
            }`}
          />
          <span className="mono text-[11px] text-muted-foreground">{statusLabel}</span>
          {expiresLabel && (
            <>
              <span className="text-muted-foreground/40" aria-hidden>·</span>
              <span
                className="mono text-[11px] text-muted-foreground"
                title="Sandbox is reaped after the idle window. Send a message to reset the timer."
              >
                {expiresLabel}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          {session?.sandbox_url && (
            <a
              href={session.sandbox_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open sandbox preview in new tab"
              className="inline-flex items-center gap-1.5 text-[12px] border border-border rounded px-2 py-1 text-muted-foreground hover:bg-muted transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">View Preview</span>
            </a>
          )}
          <button
            type="button"
            onClick={() => session && setVaultOpen(!vaultOpen)}
            disabled={!session}
            title="Vault — credential interception log for this session"
            className={`inline-flex items-center gap-1.5 text-[12px] border rounded px-2 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              vaultOpen
                ? "bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Vault</span>
          </button>
          <button
            type="button"
            onClick={() => session && setLogOpen(!logOpen)}
            disabled={!session}
            title="Session Log — durable event timeline (survives sandbox restarts)"
            className={`inline-flex items-center gap-1.5 text-[12px] border rounded px-2 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              logOpen
                ? "bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <ScrollText className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Log</span>
          </button>
          <button
            type="button"
            onClick={() => session && setInspectorOpen(!inspectorOpen)}
            disabled={!session}
            title="Inspector — tail the platform envelope + raw harness bus for this session"
            className={`inline-flex items-center gap-1.5 text-[12px] border rounded px-2 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              inspectorOpen
                ? "bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100"
                : "border-border text-muted-foreground hover:bg-muted"
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
            className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground border border-border rounded px-2 py-1 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
            className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground border border-border rounded px-2 py-1 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
          <DropdownMenu>
            <DropdownMenuTrigger
              type="button"
              className="p-1.5 hover:bg-muted rounded"
            >
              <MoreHorizontal className="w-4 h-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setDeleteSessionOpen(true)}
              >
                <Trash2 className="mr-2 size-3.5" />
                Delete session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setSessionDrawerOpen((v) => !v)}
            title="API usage"
            className={`p-1.5 rounded transition-colors ${
              sessionDrawerOpen ? "bg-muted text-foreground" : "hover:bg-muted"
            }`}
          >
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

      {agent && TUI_HARNESS_IDS.has(agent.harness_id) ? (
        <TerminalPanel
          sessionId={session?.id ?? ""}
          harnessId={agent.harness_id}
          ttyUrl={session?.tty_url ?? null}
          sandboxUrl={session?.sandbox_url ?? null}
          ttyToken={session?.tty_token ?? null}
        />
      ) : (
      <>
      {/* Scrollable thread */}
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[720px] mx-auto w-full py-10 px-6 flex flex-col gap-6">
          {session?.origin && <OriginBanner origin={session.origin} />}
          {loading && messages.length === 0 && (
            <div className="text-[13px] text-muted-foreground">Loading…</div>
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
              <div className="text-[13px] text-muted-foreground">
                Sandbox is {statusLabel}. Wait for it to become{" "}
                <span className="font-mono">ready</span> before sending a
                message.
              </div>
            )}
          {!loading && messages.length === 0 && isReady && (
            <div className="text-[13px] text-muted-foreground">
              Sandbox is ready. Send a message below.
            </div>
          )}

          {isDead && (
            <div className="border border-border bg-muted/40 rounded-lg px-4 py-3 flex items-start gap-3">
              <div className="flex-1 text-[13px] text-foreground leading-relaxed">
                Sandbox ended (
                <span className="mono text-[12px] text-muted-foreground">
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
          {deleteSessionError && (
            <div className="border border-red-200 bg-red-50 rounded-lg px-4 py-3 text-[13px] text-red-800">
              <div className="font-medium">Delete failed</div>
              <div className="mono text-[11px] text-red-700 mt-1 break-words">
                {deleteSessionError}
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

          {/* Permission prompts the agent (or a subagent) is blocked on. */}
          {permissions.map((p) => (
            <PermissionCard
              key={p.id}
              permission={p}
              onRespond={onRespondPermission}
            />
          ))}

          {/* Persistent "still working" indicator — shows the whole time the
              turn is in progress (through reasoning, tools, and the reply) so
              it's always clear the agent is still going, even on long thinks. */}
          {hasInProgress && permissions.length === 0 && (
            <div className="flex items-center gap-2 text-[14px] text-muted-foreground leading-relaxed">
              <Loader2 className="w-3 h-3 animate-spin" />
              thinking…
            </div>
          )}

          {/*
            Vault interceptions live in the top-level Vault side panel —
            see src/components/vault-dialog.tsx. The chat thread used to
            host an inline collapsed panel here; we hoisted it out of
            scroll into a dedicated header button so debugging tool calls
            is one click away.
          */}

          <div ref={messagesEndRef} />
          <div className="h-4" />
        </div>
      </div>

      {/* Sticky composer */}
      <div className="flex-shrink-0 border-t border-border bg-background">
        <div className="max-w-[720px] mx-auto w-full px-6 py-4">
          <Composer
            draft={draft}
            setDraft={setDraft}
            attachments={attachments}
            setAttachments={setAttachments}
            hasInProgress={hasInProgress}
            currentModel={currentModel}
            error={error}
            setError={setError}
            disabled={!isReady}
            handleSend={handleSend}
            handleKeyDown={handleKeyDown}
            onAbort={handleAbort}
            skills={skills}
            activeSkill={activeSkill}
            setActiveSkill={setActiveSkill}
          />
        </div>
      </div>
      </>
      )}

      <SessionDrawer
        open={sessionDrawerOpen}
        onClose={() => setSessionDrawerOpen(false)}
        session={session}
        agent={agent}
      />

      <Dialog open={deleteSessionOpen} onOpenChange={(open) => { if (!open && !deletingSession) setDeleteSessionOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              Delete this session and all conversation history? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setDeleteSessionOpen(false)}
              disabled={deletingSession}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteSession()}
              disabled={deletingSession}
              className="inline-flex h-9 items-center justify-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {deletingSession ? "Deleting…" : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =====================================================================
// SESSION DRAWER — slides in from the right; API code snippets
// =====================================================================

const CODE_LANGS = ["curl", "python", "js"] as const;
type CodeLang = (typeof CODE_LANGS)[number];

function buildCodeSnippets(
  sessionId: string,
  harnessSessionId: string,
): Record<"message" | "stream", Record<CodeLang, string>> {
  const sid = sessionId || "SESSION_ID";
  const hsid = harnessSessionId || "OPENCODE_SESSION_ID";
  const oc = `https://your-host/api/v1/managed_agents/sessions/${sid}/opencode`;
  return {
    message: {
      curl: `curl -X POST ${oc}/session/${hsid}/message \\
  -H "Authorization: Bearer $MASTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"parts":[{"type":"text","text":"your message"}]}'`,
      python: `import requests

resp = requests.post(
    "${oc}/session/${hsid}/message",
    headers={"Authorization": f"Bearer {MASTER_KEY}"},
    json={"parts": [{"type": "text", "text": "your message"}]},
)
# opencode AssistantMessage: {"info": {...}, "parts": [{"type": "text", ...}]}
print(resp.json())`,
      js: `const r = await fetch(
  \`${oc}/session/${hsid}/message\`,
  {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${MASTER_KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ parts: [{ type: "text", text: "your message" }] }),
  }
);
const msg = await r.json();`,
    },
    stream: {
      curl: `# 1) subscribe to the opencode event bus
curl -N ${oc}/event -H "Authorization: Bearer $MASTER_KEY"

# 2) in another shell, fire the turn (streams on the bus above)
curl -X POST ${oc}/session/${hsid}/prompt_async \\
  -H "Authorization: Bearer $MASTER_KEY" -H "Content-Type: application/json" \\
  -d '{"parts":[{"type":"text","text":"your message"}]}'

# Each SSE frame is a raw opencode event:
# data: {"type":"message.part.delta","properties":{"partID":"p1","delta":"Hi"}}
# data: {"type":"session.idle","properties":{...}}`,
      python: `import httpx, json
# subscribe here; POST .../prompt_async from another task to drive the turn
with httpx.stream("GET", "${oc}/event",
    headers={"Authorization": f"Bearer {MASTER_KEY}"}) as r:
    for line in r.iter_lines():
        if not line.startswith("data: "): continue
        ev = json.loads(line[6:])
        if ev["type"] == "message.part.delta":
            print(ev["properties"]["delta"], end="")
        elif ev["type"] == "session.idle":
            break`,
      js: `// Use the official SDK against the LAP opencode base:
import { createOpencodeClient } from "@opencode-ai/sdk/client";

const client = createOpencodeClient({
  baseUrl: \`${oc}\`,
  fetch: (req) => (req.headers.set("authorization", \`Bearer \${MASTER_KEY}\`), fetch(req)),
});
const events = await client.event.subscribe();
await client.session.promptAsync({ path: { id: "${hsid}" },
  body: { parts: [{ type: "text", text: "your message" }] } });
for await (const ev of events.stream) {
  if (ev.type === "message.part.delta") process.stdout.write(ev.properties.delta);
  if (ev.type === "session.idle") break;
}`,
    },
  };
}

interface SessionDrawerProps {
  open: boolean;
  onClose: () => void;
  session: SessionRow | null;
  agent: AgentRow | null;
}

function SessionDrawer({ open, onClose, session, agent }: SessionDrawerProps) {
  const [lang, setLang] = useState<CodeLang>("curl");
  const [copied, setCopied] = useState<"message" | "stream" | null>(null);

  const sessionId = session?.id ?? "";
  const snippets = useMemo(
    () => buildCodeSnippets(sessionId, session?.harness_session_id ?? ""),
    [sessionId, session?.harness_session_id],
  );

  const handleCopy = useCallback(
    async (which: "message" | "stream") => {
      try {
        await navigator.clipboard.writeText(snippets[which][lang]);
        setCopied(which);
        window.setTimeout(() => setCopied(null), 1500);
      } catch {
        // ignore
      }
    },
    [snippets, lang],
  );

  return (
    <div
      className={`absolute right-0 top-0 bottom-0 w-[360px] flex flex-col bg-background border-l border-border z-20 transition-transform duration-250 ease-in-out ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ boxShadow: open ? "-4px 0 16px rgba(0,0,0,0.06)" : "none" }}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center px-3 gap-2 flex-shrink-0">
        <span className="flex-1 text-[12px] font-medium text-foreground">
          API Usage
        </span>
        <span className="font-mono text-[11px] text-muted-foreground truncate">
          {session?.id ? session.id.slice(0, 8) : "—"}
          {agent?.name ? ` · ${agent.name}` : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-muted-foreground transition-colors"
          aria-label="Close"
        >
          <span aria-hidden className="text-[16px] leading-none">×</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-4 flex flex-col gap-4">
          {/* Lang switcher */}
          <div className="flex gap-1">
            {CODE_LANGS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`px-3 py-1 rounded text-[11px] font-mono border transition-colors ${
                  lang === l
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/40"
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          {/* /message */}
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b border-border">
              <div>
                <div className="text-[12px] font-medium text-foreground">
                  Send message
                </div>
                <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
                  POST /sessions/{"{id}"}/opencode/session/{"{ocid}"}/message
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                  POST
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy("message")}
                  className="text-muted-foreground hover:text-muted-foreground transition-colors"
                  title="Copy"
                >
                  {copied === "message" ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
            <pre className="font-mono text-[10.5px] leading-relaxed p-3 overflow-x-auto whitespace-pre bg-[#1a1a16] text-[#c9c5bc]">
              {snippets.message[lang]}
            </pre>
          </div>

          {/* /message_stream */}
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b border-border">
              <div>
                <div className="text-[12px] font-medium text-foreground">
                  Stream message
                </div>
                <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
                  GET /sessions/{"{id}"}/opencode/event
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                  SSE
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy("stream")}
                  className="text-muted-foreground hover:text-muted-foreground transition-colors"
                  title="Copy"
                >
                  {copied === "stream" ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
            <pre className="font-mono text-[10.5px] leading-relaxed p-3 overflow-x-auto whitespace-pre bg-[#1a1a16] text-[#c9c5bc]">
              {snippets.stream[lang]}
            </pre>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Session must be{" "}
            <span className="font-mono bg-muted px-1 rounded">ready</span>{" "}
            before sending. Session ID above is pre-filled.
          </p>
        </div>
      </div>
    </div>
  );
}

function MessageBlock({
  msg,
  isFirstUser,
  onCancelQueued,
}: {
  msg: LocalMessage;
  isFirstUser: boolean;
  onCancelQueued?: (msgId: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <UserPromptBlock
        content={msg.text ?? ""}
        attachments={msg.attachments}
        emphasized={isFirstUser}
      />
    );
  }
  return <AssistantBlock msg={msg} onCancelQueued={onCancelQueued} />;
}

// Compact banner above the first message when a session was created from an
// integration webhook. Surfaces "this conversation started elsewhere — here's
// the link back" so the operator on the LAP side has a one-click path to the
// originating Slack thread / Linear issue / etc. Renders nothing when the
// integration didn't provide a deep link (we omit the banner rather than show
// a dangling label).
function OriginBanner({ origin }: { origin: SessionOrigin }) {
  const label = originLabel(origin);
  // No URL → nothing actionable to show. The user already sees the session
  // exists; a label-only banner adds noise without affordance.
  if (!origin.url) return null;
  return (
    <a
      href={origin.url}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-2 self-start text-[12px] text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted border border-border rounded-full px-3 py-1.5 transition-colors"
      title={`Open in ${prettyIntegrationName(origin.integration_id)}`}
    >
      <OriginIcon integrationId={origin.integration_id} />
      <span className="truncate max-w-[420px]">{label}</span>
      <ExternalLink className="w-3 h-3 shrink-0 opacity-70" aria-hidden />
    </a>
  );
}

// Per-integration brand icon. Slack gets its 4-color logo; everything else
// falls back to a neutral message-bubble glyph from lucide so future
// integrations (Linear etc.) still show something coherent until their own
// logo lands here.
function OriginIcon({ integrationId }: { integrationId: string }) {
  if (integrationId === "slack") {
    return <SlackLogo className="w-3.5 h-3.5 shrink-0" />;
  }
  return <MessageSquare className="w-3.5 h-3.5 shrink-0" aria-hidden />;
}

function prettyIntegrationName(id: string): string {
  switch (id) {
    case "slack":
      return "Slack";
    case "linear":
      return "Linear";
    default:
      return id;
  }
}

/**
 * Label rendered in the banner. Prefers an explicit `external_ref` when the
 * integration filled one in (Linear's "LIT-1234", a Slack channel name once
 * we wire that up), and otherwise falls back to a generic "thread in <medium>"
 * phrase. Never falls through to the raw `external_session_id` — those are
 * opaque ("slack:T012:C034:1779..."), not useful to humans.
 */
function originLabel(origin: SessionOrigin): string {
  const medium = prettyIntegrationName(origin.integration_id);
  if (origin.external_ref) return `${medium} thread · ${origin.external_ref}`;
  if (origin.integration_id === "slack") return "Slack thread";
  return `${medium} thread`;
}

function UserPromptBlock({
  content,
  attachments,
  emphasized,
}: {
  content: string;
  attachments?: SendMessageAttachment[];
  emphasized: boolean;
}) {
  // Bubble grows to fit its content. The parent thread container owns the
  // only scrollbar — we used to cap at 60vh + overflow-y-auto here, which
  // gave every long message its own nested scroller. One scroll for the
  // whole conversation is what the user expects.
  return (
    <div
      className={`bg-muted/30 border border-border rounded-xl p-4 text-[14px] text-foreground leading-relaxed ${
        emphasized ? "shadow-sm" : ""
      }`}
    >
      {attachments && attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {attachments.map((a, i) => (
            <AttachmentImage key={i} attachment={a} />
          ))}
        </div>
      )}
      {content && <div className="whitespace-pre-wrap">{content}</div>}
    </div>
  );
}

// Read-only render of an attached image inside a posted user message.
// Click opens the full-resolution data URL in a new tab so the user can
// inspect at native resolution without the thumbnail size cap.
function AttachmentImage({
  attachment,
}: {
  attachment: SendMessageAttachment;
}) {
  const src = `data:${attachment.mime_type};base64,${attachment.base64}`;
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-md border border-border overflow-hidden hover:opacity-90 transition-opacity"
      title={attachment.name ?? "attached image"}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={attachment.name ?? "attached image"}
        className="max-h-64 max-w-xs object-contain"
      />
    </a>
  );
}

function AssistantBlock({
  msg,
  onCancelQueued,
}: {
  msg: LocalMessage;
  onCancelQueued?: (msgId: string) => void;
}) {
  const failed = msg.status === "failed";
  const inProgress = msg.status === "in_progress";
  const queued = msg.status === "queued";
  const parts = msg.parts ?? [];

  // Render parts in order. Skip step-start/step-finish — internal markers
  // with no UI affordance. Group consecutive text parts so markdown lists
  // still render correctly.
  const visibleParts = parts.filter((p) => {
    const t = typeof p?.type === "string" ? p.type : "";
    return (
      t === "text" ||
      t === "reasoning" ||
      t === "thinking" ||
      t === "tool" ||
      t === "image"
    );
  });

  // Lets the assistant block grow to fit its content. The parent thread
  // container is the single scroll surface — see the matching change on
  // UserPromptBlock for why we dropped the per-bubble overflow-y-auto.
  return (
    <div className="flex flex-col gap-3">
      {failed && msg.text ? (
        <div
          className="sessions-md text-[14px] leading-relaxed"
          style={{ color: "#b91c1c" }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      ) : queued ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground leading-relaxed">
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
          queued — will send when current finishes
          {onCancelQueued && (
            <button
              type="button"
              onClick={() => onCancelQueued(msg.id)}
              title="Cancel queued message"
              className="ml-1 p-0.5 rounded hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Cancel queued message"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ) : inProgress && visibleParts.length === 0 ? (
        // Streamed deltas land on `msg.text` (parts only get populated after
        // refreshThread() runs on `done`). Render the running text live so
        // tokens show as they arrive; fall back to a thinking spinner only
        // when we have nothing to display yet.
        msg.text ? (
          <div className="sessions-md text-[14px] text-foreground leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[14px] text-muted-foreground leading-relaxed">
            <Loader2 className="w-3 h-3 animate-spin" />
            thinking…
          </div>
        )
      ) : (
        // Flat, in-order: text/thinking/image inline and each tool call as a
        // single line. No grouping bar, no nested cards.
        visibleParts.map((p, i) => <PartBlock key={i} part={p} />)
      )}

      {failed && msg.error && (
        <div className="mono text-[11px] text-red-700">{msg.error}</div>
      )}

      {!inProgress && !failed && typeof msg.latency_ms === "number" && (
        <div className="mono text-[11px] text-muted-foreground">
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
      <div className="sessions-md text-[14px] text-foreground leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  // reasoning + thinking render identically so thinking looks the same across
  // harnesses (opencode emits "reasoning"; we normalize others to it too).
  if (t === "reasoning" || t === "thinking") {
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) return null;
    return <ReasoningBlock text={text} />;
  }
  if (t === "tool") {
    return <ToolBlock part={part} />;
  }
  if (t === "image") {
    // Anthropic content-block shape: `{type: "image", source: {type:
    // "base64", media_type, data}}`. We accept either that or a flat
    // `{mime_type, base64}` for forward-compat with other harnesses.
    const src = (part as { source?: { media_type?: string; data?: string } })
      .source;
    const mime =
      src?.media_type ?? (part as { mime_type?: string }).mime_type ?? "";
    const data = src?.data ?? (part as { base64?: string }).base64 ?? "";
    if (!mime || !data) return null;
    return <AttachmentImage attachment={{ mime_type: mime, base64: data }} />;
  }
  return null;
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 360 ? text.slice(0, 360) + "…" : text;
  return (
    <div className="border-l-2 border-border pl-3 text-[13px] text-muted-foreground italic leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-start gap-1 text-left hover:text-foreground"
      >
        <ChevronDown
          className={`w-3 h-3 mt-1 shrink-0 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="whitespace-pre-wrap">{open ? text : preview}</span>
      </button>
    </div>
  );
}

// One flat line per tool call: "🔧 bash ✓ completed". No card, no nesting, no
// expand — tool calls read inline with the rest of the turn.
// A concise descriptor pulled from the tool's input so the line says what it's
// actually doing — e.g. the bash command, the file path, or (for a `task`
// subagent) what it was asked to do.
function toolDescriptor(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const n = tool.toLowerCase();
  if (n === "task") return pick("description");
  if (n === "bash") return pick("command", "description");
  if (n.includes("read") || n.includes("edit") || n.includes("write") || n.includes("patch"))
    return pick("filePath", "file_path", "path");
  if (n.includes("grep") || n.includes("glob") || n.includes("find"))
    return pick("pattern", "query");
  return "";
}

function ToolBlock({ part }: { part: HarnessMessagePart }) {
  const [open, setOpen] = useState(false);
  const subThreads = useContext(SubThreadsContext);
  const toolName = typeof part.tool === "string" ? part.tool : "tool";
  const state = (part.state as Record<string, unknown> | undefined) ?? {};
  const status = typeof state.status === "string" ? state.status : "running";
  const input = state.input;
  const output = state.output;
  const errorOut = state.error;
  const desc = toolDescriptor(toolName, input);

  // The `task` tool spawns a subagent in a child session; render its work.
  const isTask = toolName === "task";
  const childId = isTask
    ? ((state.metadata as { sessionId?: string } | undefined)?.sessionId ?? "")
    : "";
  const subParts = isTask
    ? (subThreads.get(childId) ?? [])
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts)
    : [];

  // "spawning sub agent" while it runs, "sub agent" once done. Other tools
  // keep their own name.
  const label = isTask
    ? status === "running"
      ? "spawning sub agent"
      : "sub agent"
    : toolName;
  const hasDetails = isTask
    ? subParts.length > 0 || output !== undefined
    : input !== undefined || output !== undefined || errorOut !== undefined;

  const statusColor =
    status === "completed"
      ? "text-emerald-600"
      : status === "error"
        ? "text-red-600"
        : "text-amber-600";
  const StatusIcon =
    status === "completed" ? Check : status === "error" ? X : Loader2;

  // One clean clickable card per tool call (Cursor-style): collapsed by
  // default, click to reveal input/output — or, for a subagent, its full work.
  return (
    <div className="border border-border rounded-md bg-muted/40 text-[13px] overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left min-w-0 ${
          hasDetails ? "hover:bg-muted cursor-pointer" : "cursor-default"
        }`}
      >
        <Wrench className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="mono text-foreground shrink-0">{label}</span>
        {desc && (
          <span className="mono text-muted-foreground truncate">{desc}</span>
        )}
        <StatusIcon
          className={`w-3 h-3 shrink-0 ${statusColor} ${status === "running" ? "animate-spin" : ""}`}
        />
        <span className={`mono text-[11px] shrink-0 ${statusColor}`}>
          {status}
        </span>
        {hasDetails && (
          <ChevronDown
            className={`ml-auto w-3 h-3 shrink-0 text-muted-foreground transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
        )}
      </button>

      {open && isTask && (
        // The subagent's own steps + final output, nested under the card.
        <div className="border-t border-border border-l-2 border-l-amber-300/60 px-3 py-2 flex flex-col gap-2">
          {subParts.length > 0 ? (
            subParts.map((p, i) => (
              <PartBlock key={i} part={p as unknown as HarnessMessagePart} />
            ))
          ) : output !== undefined ? (
            <ToolKv label="sub agent output" value={output} />
          ) : (
            <span className="text-[12px] text-muted-foreground italic">
              sub agent working…
            </span>
          )}
        </div>
      )}

      {open && !isTask && hasDetails && (
        <div className="border-t border-border px-3 py-2 flex flex-col gap-2">
          {input !== undefined && <ToolKv label="input" value={input} />}
          {output !== undefined && <ToolKv label="output" value={output} />}
          {errorOut !== undefined && <ToolKv label="error" value={errorOut} />}
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
      <span className="mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <pre className="mono text-[11px] text-foreground whitespace-pre-wrap break-words bg-background border border-border rounded p-2 max-h-64 overflow-auto">
        {text}
      </pre>
    </div>
  );
}

// A permission the agent (or subagent) is blocked on. opencode asks before
// running a tool unless the config auto-allows it; this lets the user unblock.
function PermissionCard({
  permission,
  onRespond,
}: {
  permission: PermissionRequest;
  onRespond: (
    id: string,
    sessionID: string,
    response: PermissionResponse,
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const respond = (r: PermissionResponse) => {
    setBusy(true);
    void onRespond(permission.id, permission.sessionID, r).catch(() =>
      setBusy(false),
    );
  };
  const btn =
    "px-3 py-1 rounded text-[12px] font-medium border transition-colors disabled:opacity-50";
  return (
    <div className="border border-amber-300 rounded-md bg-amber-50/70 text-[13px] px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-amber-800">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">Permission needed</span>
        {permission.tool && (
          <span className="mono text-[11px] text-amber-700">
            {permission.tool}
          </span>
        )}
      </div>
      <div className="text-foreground break-words">{permission.title}</div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => respond("once")}
          className={`${btn} bg-amber-600 text-white border-amber-600 hover:bg-amber-700`}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => respond("always")}
          className={`${btn} border-amber-400 text-amber-800 hover:bg-amber-100`}
        >
          Always
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => respond("reject")}
          className={`${btn} border-border text-muted-foreground hover:bg-muted`}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// COMPOSER
// =====================================================================

interface ComposerProps {
  draft: string;
  setDraft: (s: string) => void;
  attachments: SendMessageAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<SendMessageAttachment[]>>;
  hasInProgress: boolean;
  currentModel: string;
  error: string | null;
  setError: (s: string | null) => void;
  disabled: boolean;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onAbort?: () => void;
  skills: SkillRow[];
  activeSkill: SkillRow | null;
  setActiveSkill: (s: SkillRow | null) => void;
}

// Convert a clipboard / file blob into the SendMessageAttachment wire shape:
// strip the `data:<mime>;base64,` prefix so the server stores raw base64
// (matches the `MessageAttachment.base64` contract — server logic concatenates
// the prefix on its side). Resolves null on read failure so the caller can
// drop the file without raising.
async function blobToAttachment(
  blob: Blob,
  fallbackName: string,
): Promise<SendMessageAttachment | null> {
  try {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(blob);
    });
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx < 0) return null;
    const base64 = dataUrl.slice(commaIdx + 1);
    if (!base64) return null;
    return {
      name: (blob as File).name || fallbackName,
      mime_type: blob.type,
      base64,
    };
  } catch {
    return null;
  }
}

function Composer({
  draft,
  setDraft,
  attachments,
  setAttachments,
  hasInProgress,
  currentModel,
  error,
  setError,
  disabled,
  handleSend,
  handleKeyDown,
  onAbort,
  skills,
  activeSkill,
  setActiveSkill,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredSkills = (skills ?? []).filter(
    (s) =>
      s.name.toLowerCase().includes(slashFilter.toLowerCase()) ||
      (s.description ?? "").toLowerCase().includes(slashFilter.toLowerCase()),
  );

  function selectSkill(skill: SkillRow) {
    setActiveSkill(skill);
    setDraft(`/${skill.name} `);
    setSlashOpen(false);
    setSlashFilter("");
  }

  function handleDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setDraft(val);

    if (!val.startsWith("/")) {
      setSlashOpen(false);
      setSlashFilter("");
      if (activeSkill) setActiveSkill(null);
      return;
    }
    const afterSlash = val.slice(1);
    const firstSpace = afterSlash.indexOf(" ");
    if (firstSpace === -1) {
      setSlashFilter(afterSlash);
      setSlashOpen(true);
      setSlashIndex(0);
      if (activeSkill && afterSlash !== activeSkill.name) setActiveSkill(null);
    } else {
      setSlashOpen(false);
      const typedName = afterSlash.slice(0, firstSpace);
      if (!activeSkill || activeSkill.name !== typedName) {
        const matched = skills.find(
          (s) => s.name.toLowerCase() === typedName.toLowerCase(),
        );
        setActiveSkill(matched ?? null);
      }
    }
  }

  function composerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => Math.min(i + 1, filteredSkills.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab") { e.preventDefault(); selectSkill(filteredSkills[slashIndex] ?? filteredSkills[0]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlashOpen(false); return; }
      if (e.key === "Enter") { e.preventDefault(); if (filteredSkills[slashIndex]) selectSkill(filteredSkills[slashIndex]); return; }
    }
    handleKeyDown(e);
  }

  // Submitting while a previous message is in flight is supported — the new
  // message lands in the FIFO queue and the drain effect picks it up. So the
  // textarea stays enabled and the send button is gated on a non-empty draft
  // OR at least one staged attachment + a ready sandbox.
  const canSend =
    (draft.trim().length > 0 || attachments.length > 0) && !disabled;
  const placeholder = disabled
    ? "Sandbox not ready yet…"
    : hasInProgress
      ? "Queue a follow up"
      : "Add a follow up — type / to reference a skill";

  // Stage a clipboard / drop / file-picker file onto the attachments list.
  // Validates count + MIME + size client-side so the user gets immediate
  // feedback before we POST — server enforces the same caps as a defence
  // against a malicious client.
  const stageFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (!COMPOSER_ATTACHMENT_ALLOWED_MIME.has(file.type)) {
        return `unsupported file type: ${file.type || "unknown"} (png, jpeg, gif, webp only)`;
      }
      if (file.size > COMPOSER_ATTACHMENT_MAX_BYTES) {
        return `file too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 5 MB)`;
      }
      const att = await blobToAttachment(file, "pasted-image");
      if (!att) return "failed to read file";
      setAttachments((prev) => {
        if (prev.length >= COMPOSER_ATTACHMENTS_MAX_COUNT) return prev;
        return [...prev, att];
      });
      return null;
    },
    [setAttachments],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      // Collect image files first; if none, let the browser handle the paste
      // normally (text falls through to the textarea).
      const images: File[] = [];
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) images.push(f);
        }
      }
      if (images.length === 0) return;
      e.preventDefault();
      if (
        attachments.length + images.length >
        COMPOSER_ATTACHMENTS_MAX_COUNT
      ) {
        setError(
          `too many attachments (max ${COMPOSER_ATTACHMENTS_MAX_COUNT})`,
        );
        return;
      }
      // Stage sequentially so error messages match the file that failed
      // and we don't fire N FileReader instances against the same DOM event.
      for (const f of images) {
        const err = await stageFile(f);
        if (err) {
          setError(err);
          return;
        }
      }
      // All pasted files staged successfully — clear any prior paste error
      // (e.g. an earlier bad-MIME paste) so the composer footer doesn't
      // keep showing a stale red message after the user has visibly
      // recovered with a valid paste.
      setError(null);
    },
    [attachments.length, stageFile, setError],
  );

  const handleRemoveAttachment = useCallback(
    (idx: number) => {
      setAttachments((prev) => {
        const next = prev.filter((_, i) => i !== idx);
        // Removing the last failed-context attachment is the user's signal
        // that they've moved past whatever validation issue they hit; clear
        // any lingering paste error so the footer matches composer state.
        if (next.length === 0) setError(null);
        return next;
      });
    },
    [setAttachments, setError],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      setIsDragOver(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // Only clear when leaving the composer entirely (not a child element).
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setIsDragOver(false);
    },
    [],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      if (attachments.length + files.length > COMPOSER_ATTACHMENTS_MAX_COUNT) {
        setError(`too many attachments (max ${COMPOSER_ATTACHMENTS_MAX_COUNT})`);
        return;
      }
      for (const f of files) {
        const err = await stageFile(f);
        if (err) {
          setError(err);
          return;
        }
      }
      setError(null);
    },
    [disabled, attachments.length, stageFile, setError],
  );

  return (
    <div className="relative">
      {/* Skill slash-command dropdown — outside overflow-hidden inner div */}
      {slashOpen && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-xl border border-border bg-background shadow-lg overflow-hidden"
        >

          {filteredSkills.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-muted-foreground">No skills match &ldquo;{slashFilter}&rdquo;</p>
          ) : (
            <>
              <div className="px-3 pt-2.5 pb-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Skills</span>
              </div>
              {filteredSkills.slice(0, 8).map((sk, i) => (
                <button
                  key={sk.id}
                  type="button"
                  onMouseDown={() => selectSkill(sk)}
                  onMouseEnter={() => setSlashIndex(i)}
                  className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${i === slashIndex ? "bg-muted" : "hover:bg-muted/50"}`}
                >
                  <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${i === slashIndex ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted/50 text-muted-foreground"}`}>
                    <FileText className="size-3" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">{sk.name}</span>
                    {sk.description && <span className="block truncate text-[11px] text-muted-foreground mt-0.5">{sk.description}</span>}
                  </div>
                  {i === slashIndex && <span className="shrink-0 self-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">↵</span>}
                </button>
              ))}
              <div className="border-t border-border px-3 py-2 flex items-center gap-3">
                <span className="text-[10px] text-muted-foreground/50">↑↓ navigate</span>
                <span className="text-[10px] text-muted-foreground/50">↵ select</span>
                <span className="text-[10px] text-muted-foreground/50">esc dismiss</span>
              </div>
            </>
          )}
        </div>
      )}

      <div
        className={`border rounded-xl shadow-sm bg-background overflow-hidden focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-all ${
          isDragOver ? "border-ring ring-1 ring-ring" : "border-border"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => { void handleDrop(e); }}
      >

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.name ?? ""}-${i}`}
              attachment={a}
              onRemove={() => handleRemoveAttachment(i)}
            />
          ))}
        </div>
      )}
      <textarea
        value={draft}
        onChange={handleDraftChange}
        onKeyDown={composerKeyDown}
        onPaste={handlePaste}
        placeholder={activeSkill ? `Ask ${activeSkill.name} anything…` : placeholder}
        disabled={disabled}
        rows={1}
        className="w-full p-4 outline-none resize-none text-[15px] placeholder:text-muted-foreground bg-transparent"
      />
      <div className="flex items-center justify-between px-4 pb-3 text-xs text-muted-foreground">
        <span className="mono flex items-center gap-2">
          {error ? (
            <span className="text-red-600">{error}</span>
          ) : (
            currentModel || "Enter to send · Shift+Enter for newline · paste or drag images"
          )}
          {activeSkill && (
            <span className="flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 dark:border-blue-800 dark:bg-blue-950">
              <FileText className="size-3 text-blue-600 dark:text-blue-400" />
              <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">{activeSkill.name}</span>
              <button
                type="button"
                onClick={() => { setActiveSkill(null); setDraft(draft.replace(/^\/[^\s]*\s*/, "")); }}
                className="ml-0.5 text-blue-500 hover:text-blue-700 dark:text-blue-400"
                aria-label="Remove skill"
              >
                <X className="size-2.5" />
              </button>
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={async (e) => {
              if (!e.target.files) return;
              const files = Array.from(e.target.files);
              e.target.value = "";
              if (attachments.length + files.length > COMPOSER_ATTACHMENTS_MAX_COUNT) {
                setError(`too many attachments (max ${COMPOSER_ATTACHMENTS_MAX_COUNT})`);
                return;
              }
              for (const f of files) {
                const err = await stageFile(f);
                if (err) { setError(err); return; }
              }
              setError(null);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachments.length >= COMPOSER_ATTACHMENTS_MAX_COUNT}
            title="Attach image (PNG, JPEG, GIF, WebP — max 5 MB)"
            className="p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Attach image"
          >
            <Paperclip className="w-3.5 h-3.5" />
          </button>
          {hasInProgress && onAbort ? (
            <button
              type="button"
              onClick={onAbort}
              className="bg-foreground text-background p-1.5 rounded-full hover:bg-foreground/90 transition-colors"
              aria-label="Stop current turn"
              title="Stop — interrupt the running agent turn"
            >
              <Square className="w-3.5 h-3.5 fill-background" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="bg-foreground text-background p-1.5 rounded-full hover:bg-foreground/90 transition-colors disabled:opacity-30 disabled:hover:bg-foreground"
              aria-label="Send"
              title="Send (Enter)"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

// Inline thumbnail chip for a staged attachment. The base64 + mime are
// reconstituted into a data URL only for preview rendering — the wire payload
// uses the prefix-free `base64` field on SendMessageAttachment.
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: SendMessageAttachment;
  onRemove: () => void;
}) {
  const src = `data:${attachment.mime_type};base64,${attachment.base64}`;
  return (
    <div className="relative group rounded-md border border-border bg-muted/30 p-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={attachment.name ?? "attached image"}
        className="h-16 w-16 object-cover rounded"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove attachment"
        className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-foreground text-background text-[11px] leading-none flex items-center justify-center shadow opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        ×
      </button>
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
    <div className="border border-border bg-background rounded-xl shadow-sm px-6 py-5 max-w-md mx-auto w-full">
      <div className="flex items-center gap-2 mb-1">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        <span className="text-[15px] font-medium text-foreground">
          Spinning up sandbox…
        </span>
      </div>
      <div className="mono text-[11px] text-muted-foreground mb-4">
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
                        : "bg-muted-foreground/40"
                  }`}
                />
                <span
                  className={
                    isActive
                      ? "text-foreground font-medium"
                      : isDone
                        ? "text-muted-foreground"
                        : "text-muted-foreground"
                  }
                >
                  {step.label}
                </span>
                {isActive && (
                  <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                )}
              </div>
              {isActive && phaseDetail && (
                <div className="ml-3.5 text-[11px] text-muted-foreground truncate">
                  {phaseDetail}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-4 text-[11px] text-muted-foreground leading-relaxed">
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
      <div className="bg-background rounded-xl shadow-xl border border-border w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-muted-foreground" />
            <span className="text-[14px] font-medium text-foreground">
              Diagnose
            </span>
            <span className="mono text-[11px] text-muted-foreground">
              session {sessionId.slice(0, 8)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
              title="Re-fetch"
              className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground border border-border rounded px-2 py-1 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
              className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground border border-border rounded px-2 py-1 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
              className="p-1.5 hover:bg-muted rounded text-muted-foreground"
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
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
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
    <div className="rounded-lg border border-border overflow-hidden bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 border-b border-border"
      >
        <ChevronDown
          className={`w-3 h-3 text-muted-foreground transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="mono text-[11px] text-muted-foreground">pod_logs_tail</span>
        <span className="mono text-[11px] text-muted-foreground ml-auto">
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
            <span className="text-muted-foreground italic">(empty)</span>
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
    <div className="rounded-lg border border-border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
      >
        <ChevronDown
          className={`w-3 h-3 text-muted-foreground transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="mono text-[12px] text-foreground">{label}</span>
      </button>
      {open && (
        <pre className="mono text-[11px] text-foreground whitespace-pre-wrap break-words bg-muted/40 border-t border-border px-3 py-2 max-h-80 overflow-auto">
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
    <div className="rounded-lg border border-border overflow-hidden bg-background shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted transition-colors text-left"
      >
        <ChevronDown
          className={`w-3 h-3 text-muted-foreground shrink-0 transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
          aria-hidden
        />
        <span className="mono text-[11px] text-muted-foreground">sandbox stdout</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              isCreating ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"
            }`}
          />
          <span className="mono text-[11px] text-muted-foreground">
            {indicatorLabel}
          </span>
        </span>
      </button>
      {expanded && (
        <pre
          ref={preRef}
          className="mono text-[11px] leading-snug whitespace-pre-wrap break-words px-3 py-2 overflow-y-auto border-t border-border"
          style={{
            height: 240,
            backgroundColor: "#1c1b18",
            color: "#e8e4dc",
          }}
        >
          {empty ? (
            <span className="text-muted-foreground italic">
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
