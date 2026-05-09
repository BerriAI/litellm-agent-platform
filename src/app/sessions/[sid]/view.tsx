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
  Square,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import {
  ApiError,
  AgentRow,
  HarnessMessageResponse,
  SessionRow,
  getAgent,
  getSession,
  harnessResponseText,
  sendMessage,
} from "@/lib/api";
import { AgentAvatar } from "@/components/agent-avatar";

type LocalRole = "user" | "assistant";

interface LocalMessage {
  id: string;
  role: LocalRole;
  text: string;
  status: "in_progress" | "completed" | "failed";
  error?: string;
}

const POLL_INTERVAL_MS = 5000;
const NEAR_BOTTOM_PX = 200;

export default function SessionThreadView() {
  const params = useParams<{ sid: string }>();
  const sessionId = params?.sid || "";

  const [session, setSession] = useState<SessionRow | null>(null);
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const seededFromInitialPromptRef = useRef<boolean>(false);

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

  // Append the initial-prompt response (returned by spawn) so the user lands
  // on a thread that already shows the conversation seed.
  function seedFromInitialResponse(resp: HarnessMessageResponse | null | undefined) {
    if (!resp || seededFromInitialPromptRef.current) return;
    const text = harnessResponseText(resp);
    if (!text) return;
    seededFromInitialPromptRef.current = true;
    setMessages((prev) => [
      ...prev,
      {
        id: `seed-${Date.now()}`,
        role: "assistant",
        text,
        status: "completed",
      },
    ]);
  }

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const s = await getSession(sessionId);
      setSession(s);
      seedFromInitialResponse(s.response);
      try {
        setAgent(await getAgent(s.agent_id));
      } catch {
        setAgent(null);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

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

  // Auto-scroll only when user is already near the bottom.
  const lastMessageCountRef = useRef<number>(0);
  useEffect(() => {
    const c = scrollContainerRef.current;
    if (!c) return;
    const newCount = messages.length;
    const grew = newCount > lastMessageCountRef.current;
    lastMessageCountRef.current = newCount;
    const distanceFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    const nearBottom = distanceFromBottom < NEAR_BOTTOM_PX;
    if (grew && nearBottom) {
      messagesEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || !sessionId || sending) return;
    if (session?.status !== "ready") {
      setError(
        `Session is not ready yet (status=${session?.status ?? "unknown"}).`,
      );
      return;
    }
    setSending(true);
    setError(null);

    const userId = `local-${Date.now()}`;
    const assistantId = `local-${Date.now()}-a`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: content, status: "completed" },
      { id: assistantId, role: "assistant", text: "", status: "in_progress" },
    ]);
    setDraft("");

    try {
      const resp = await sendMessage(sessionId, { text: content });
      const text = harnessResponseText(resp) || "(no text in response)";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text, status: "completed" }
            : m,
        ),
      );
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
      setSending(false);
    }
  }, [draft, sessionId, sending, session]);

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
        sending={sending}
        hasInProgress={hasInProgress}
        currentModel={currentModel}
        draft={draft}
        setDraft={setDraft}
        handleSend={handleSend}
        handleKeyDown={handleKeyDown}
        messagesEndRef={messagesEndRef}
        scrollContainerRef={scrollContainerRef}
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
  sending: boolean;
  hasInProgress: boolean;
  currentModel: string;
  draft: string;
  setDraft: (s: string) => void;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

function MainPanel({
  session,
  agent,
  agentName,
  messages,
  loading,
  error,
  sending,
  hasInProgress,
  currentModel,
  draft,
  setDraft,
  handleSend,
  handleKeyDown,
  messagesEndRef,
  scrollContainerRef,
}: MainPanelProps) {
  const sessionShortId = session?.id ? session.id.slice(0, 8) : "—";
  const statusLabel = session?.status ?? "unknown";
  const isReady = session?.status === "ready";

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
                  : statusLabel === "failed"
                    ? "bg-red-500"
                    : "bg-gray-300"
            }`}
          />
          <span className="mono text-[11px] text-gray-500">{statusLabel}</span>
        </div>
        <div className="flex items-center gap-2 text-gray-400">
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
            sending={sending}
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
    return <UserPromptBlock content={msg.text} emphasized={isFirstUser} />;
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

  return (
    <div className="flex flex-col gap-3">
      {msg.text ? (
        <div
          className="sessions-md text-[14px] text-gray-800 leading-relaxed overflow-y-auto"
          style={{
            color: failed ? "#b91c1c" : undefined,
            maxHeight: MESSAGE_MAX_HEIGHT,
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      ) : inProgress ? (
        <div className="flex items-center gap-2 text-[14px] text-gray-400 leading-relaxed">
          <Loader2 className="w-3 h-3 animate-spin" />
          thinking…
        </div>
      ) : null}

      {failed && msg.error && (
        <div className="mono text-[11px] text-red-700">{msg.error}</div>
      )}
    </div>
  );
}

// =====================================================================
// COMPOSER
// =====================================================================

interface ComposerProps {
  draft: string;
  setDraft: (s: string) => void;
  sending: boolean;
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
  sending,
  hasInProgress,
  currentModel,
  error,
  disabled,
  handleSend,
  handleKeyDown,
}: ComposerProps) {
  const canSend = draft.trim().length > 0 && !sending && !disabled;
  const placeholder = disabled
    ? "Sandbox not ready yet…"
    : "Add a follow up";

  return (
    <div className="border border-gray-200 rounded-xl shadow-sm bg-white overflow-hidden focus-within:ring-1 focus-within:ring-gray-300 focus-within:border-gray-300 transition-all">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={sending || disabled}
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
          {hasInProgress ? (
            <button
              type="button"
              disabled
              className="bg-black text-white p-1.5 rounded-full opacity-50"
              aria-label="Stop (not supported)"
              title="Abort is not supported on this proxy yet"
            >
              <Square className="w-3 h-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="bg-black text-white p-1.5 rounded-full hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:hover:bg-black"
              aria-label="Send"
              title="Send (Enter)"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
