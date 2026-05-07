"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  PanelLeft,
  Search,
  SquarePen,
  Workflow,
  Layers,
  MessageSquarePlus,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import {
  ApiError,
  AgentRow,
  SessionRow,
  listAgents,
  listSessions,
} from "@/lib/api";

const POLL_INTERVAL_MS = 5000;
const REPO_URL = "https://github.com/BerriAI/litellm-agent-platform";

interface QuickLink {
  href: string;
  label: string;
  Icon: typeof SquarePen;
  isActive: (pathname: string) => boolean;
}

const QUICK_LINKS: readonly QuickLink[] = [
  {
    href: "/agents/new",
    label: "New Agent",
    Icon: SquarePen,
    isActive: (p) => p === "/agents/new",
  },
  {
    href: "/sessions/new",
    label: "New Session",
    Icon: MessageSquarePlus,
    isActive: (p) => p === "/sessions/new",
  },
  {
    href: "/agents",
    label: "Agents",
    Icon: Layers,
    isActive: (p) => p === "/agents" || (p.startsWith("/agents/") && p !== "/agents/new"),
  },
  {
    href: "/sessions",
    label: "Sessions",
    Icon: Workflow,
    isActive: (p) => p === "/sessions" || (p.startsWith("/sessions/") && p !== "/sessions/new"),
  },
];

interface SessionGroup {
  label: string;
  items: SessionRow[];
}

function groupSessionsByAge(sessions: SessionRow[]): SessionGroup[] {
  const now = Date.now();
  const day = 1000 * 60 * 60 * 24;
  const buckets: Record<string, SessionRow[]> = {
    Today: [],
    "This Week": [],
    "This Month": [],
    Older: [],
  };
  for (const s of sessions) {
    const age = now - new Date(s.created_at).getTime();
    if (age < day) buckets.Today.push(s);
    else if (age < 7 * day) buckets["This Week"].push(s);
    else if (age < 30 * day) buckets["This Month"].push(s);
    else buckets.Older.push(s);
  }
  return [
    { label: "Today", items: buckets.Today },
    { label: "This Week", items: buckets["This Week"] },
    { label: "This Month", items: buckets["This Month"] },
    { label: "Older", items: buckets.Older },
  ].filter((g) => g.items.length > 0);
}

function activeSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/sessions\/([^/]+)/);
  if (!match) return null;
  const sid = match[1];
  if (sid === "new") return null;
  return sid;
}

export function Sidebar() {
  const pathname = usePathname() ?? "";
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sessionsRes, agentsRes] = await Promise.all([
        listSessions(100),
        listAgents(),
      ]);
      setSessions(sessionsRes.data);
      setAgents(agentsRes.data);
      setError(null);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setError(msg);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [load]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) {
      map.set(a.id, a.name);
    }
    return map;
  }, [agents]);

  const groups = useMemo(() => groupSessionsByAge(sessions), [sessions]);
  const currentSessionId = activeSessionId(pathname);

  return (
    <aside
      className="sticky top-0 flex h-screen w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label="Primary sidebar"
    >
      {/* Logo + product title */}
      <div className="flex flex-col gap-1 px-4 pt-4 pb-3">
        <Link
          href="/"
          aria-label="LiteLLM Agent Platform home"
          className="flex shrink-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Image
            src="https://berrie-ai-incorporated.litellm-sandbox.ai/get_image"
            alt="LiteLLM"
            width={120}
            height={24}
            priority
            className="h-6 w-auto"
            style={{ height: 24, width: "auto" }}
            sizes="120px"
          />
        </Link>
        <span
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Agent Platform
        </span>
      </div>

      {/* Collapse + Search row */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <button
          type="button"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (coming soon)"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <PanelLeft className="size-4" aria-hidden />
        </button>
        <div
          className="flex flex-1 items-center gap-2 rounded-md border border-sidebar-border px-2 py-1.5 text-xs text-muted-foreground"
          aria-hidden
        >
          <Search className="size-3.5" />
          <span className="flex-1">Search</span>
          <kbd className="font-sans text-[11px] tabular-nums">⌘K</kbd>
        </div>
      </div>

      {/* Quick links */}
      <nav aria-label="Quick links" className="px-2 pt-1">
        <ul className="space-y-0.5">
          {QUICK_LINKS.map(({ href, label, Icon, isActive }) => {
            const active = isActive(pathname);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                  )}
                >
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-primary"
                    />
                  ) : null}
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Sessions list */}
      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No sessions yet.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mt-3 first:mt-0">
              <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </div>
              <ul className="space-y-0.5">
                {group.items.map((s) => {
                  const active = s.id === currentSessionId;
                  const name =
                    agentNameById.get(s.agent_id) ?? s.agent_name ?? s.agent_id;
                  return (
                    <li key={s.id}>
                      <Link
                        href={`/sessions/${s.id}`}
                        title={`${name} — ${s.id}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                          active
                            ? "bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                        )}
                      >
                        {active ? (
                          <span
                            aria-hidden
                            className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-primary"
                          />
                        ) : null}
                        <span className="truncate">{name}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* Sticky footer */}
      <div className="sticky bottom-0 flex items-center gap-1 border-t border-sidebar-border bg-sidebar px-3 py-2">
        <ThemeToggle />
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View repository on GitHub"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <svg
            className="size-4"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <path d="M12 .5C5.65.5.5 5.65.5 12.04c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.34-1.27-1.7-1.27-1.7-1.04-.72.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.77 2.69 1.26 3.34.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.3-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18.92-.26 1.9-.39 2.88-.39.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.75.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.7.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56 4.57-1.53 7.85-5.85 7.85-10.95C23.5 5.65 18.35.5 12 .5z" />
          </svg>
        </a>
      </div>
    </aside>
  );
}
