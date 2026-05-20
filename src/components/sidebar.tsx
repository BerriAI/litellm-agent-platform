"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, FileText, LayoutTemplate, Plus, Settings } from "lucide-react";

interface LocalProject { id: string; name: string; }

import { AgentAvatar } from "@/components/agent-avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import {
  AgentRow,
  SessionRow,
  SkillRow,
  listAgents,
  listSessions,
  listSkills,
} from "@/lib/api";
import { PROJECTS_STORAGE_KEY } from "@/lib/constants";

const REPO_URL = "https://github.com/BerriAI/litellm-agent-platform";
const POLL_INTERVAL_MS = 10000;
const RECENT_LIMIT = 5;

function statusDotClass(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "creating":
      return "bg-amber-500";
    case "failed":
      return "bg-red-500";
    case "dead":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground";
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function agentLabel(a: AgentRow): string {
  return a.name?.trim() || a.id;
}

function sessionLabel(s: SessionRow): string {
  // Prefer the first-user-message preview the server projects from the
  // harness thread snapshot — far more recognisable than a UUID prefix.
  // Fall back to the short-id for brand-new sessions with no user turn
  // recorded yet, and for legacy rows whose history pre-dates the field.
  const preview = s.title_preview?.trim();
  if (preview) return preview;
  return `Session ${shortId(s.id)}`;
}

export function Sidebar() {
  const pathname = usePathname() ?? "";

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (raw) setProjects(JSON.parse(raw) as LocalProject[]);
    } catch { /* ignore */ }
  }, []);

  // Track which agent the current route belongs to so we can auto-expand it.
  const activeAgentId = useMemo(() => {
    if (pathname.startsWith("/agents/")) {
      const segs = pathname.split("/");
      const id = segs[2];
      // Filter out non-id paths like "/agents/new"
      if (id && id !== "new") return id;
    }
    if (pathname.startsWith("/sessions/")) {
      const segs = pathname.split("/");
      const sid = segs[2];
      if (sid && sid !== "new") {
        const session = sessions.find((s) => s.id === sid);
        return session?.agent_id ?? null;
      }
    }
    return null;
  }, [pathname, sessions]);

  // Auto-expand the active agent whenever the route changes.
  useEffect(() => {
    if (!activeAgentId) return;
    setExpanded((prev) => {
      if (prev.has(activeAgentId)) return prev;
      const next = new Set(prev);
      next.add(activeAgentId);
      return next;
    });
  }, [activeAgentId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [a, s, sk] = await Promise.all([
          listAgents().catch(() => null),
          listSessions().catch(() => null),
          listSkills().catch(() => null),
        ]);
        if (cancelled) return;
        if (a) setAgents(a);
        if (s) setSessions(s);
        if (sk) setSkills(sk);
      } catch {
        // silent — sidebar shouldn't crash on transient proxy errors
      }
    }
    void load();
    const id = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const sessionsByAgent = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const list = m.get(s.agent_id) ?? [];
      list.push(s);
      m.set(s.agent_id, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => {
        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bt - at;
      });
    }
    return m;
  }, [sessions]);

  // Top 5 agents sorted by most recent session activity, then creation time.
  const sortedAgents = useMemo(() => {
    const lastActiveMs = (a: AgentRow): number => {
      const agentSessions = sessionsByAgent.get(a.id) ?? [];
      const times = agentSessions
        .map((s) => (s.created_at ? new Date(s.created_at).getTime() : 0))
        .filter((t) => !Number.isNaN(t) && t > 0);
      return times.length > 0 ? Math.max(...times) : 0;
    };
    return [...agents]
      .sort((a, b) => {
        const byActivity = lastActiveMs(b) - lastActiveMs(a);
        if (byActivity !== 0) return byActivity;
        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bt - at;
      })
      .slice(0, 5);
  }, [agents, sessionsByAgent]);

  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => {
          const at = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
          return bt - at;
        })
        .slice(0, RECENT_LIMIT),
    [sessions],
  );

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, agentLabel(a));
    return m;
  }, [agents]);

  function toggle(agentId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  return (
    <aside
      className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label="Primary sidebar"
    >
      {/* Wordmark */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Link
          href="/agents"
          aria-label="LiteLLM Agent Platform home"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span
            aria-hidden
            className="grid h-[20px] w-[20px] place-items-center rounded-[4px] bg-foreground text-[12px] leading-none"
          >
            🚄
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-foreground">
            LiteLLM Agent Platform
          </span>
        </Link>
      </div>

      {/* New Agent CTA */}
      <div className="px-2 pb-2">
        <Link
          href="/agents/new"
          aria-current={pathname === "/agents/new" ? "page" : undefined}
          className={cn(
            "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            pathname === "/agents/new"
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          <Plus
            className={cn(
              "size-[14px] shrink-0",
              pathname === "/agents/new"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            aria-hidden
          />
          <span className="truncate">New Agent</span>
        </Link>
      </div>

      {/* Lists */}
      <nav
        aria-label="Agents and sessions"
        className="flex-1 overflow-y-auto px-2 pb-2"
      >
        {/* Recent sessions across agents */}
        {recentSessions.length > 0 ? (
          <>
            <SectionHeader
              label="Recent"
              count={recentSessions.length}
              href="/sessions"
              active={pathname === "/sessions"}
            />
            <ul className="mb-3 space-y-px">
              {recentSessions.map((s) => {
                const href = `/sessions/${s.id}`;
                const active = pathname === href;
                const agentName =
                  agentNameById.get(s.agent_id) ?? s.agent_id;
                return (
                  <li key={s.id}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        active
                          ? "bg-sidebar-accent text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                      )}
                      title={`${agentName} · ${s.id}`}
                    >
                      <span
                        aria-hidden
                        title={s.status}
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          statusDotClass(s.status),
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate text-foreground">
                          {sessionLabel(s)}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground/80">
                          {agentName} · {formatRelative(s.created_at)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        {/* Agents — each row is collapsible to show its sessions. */}
        <SectionHeader
          label="Agents"
          count={sortedAgents.length}
          href="/agents"
          active={pathname === "/agents"}
          seeAllHref="/agents"
        />
        <ul className="space-y-px">
          {sortedAgents.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-muted-foreground">
              No agents yet.
            </li>
          ) : (
            sortedAgents.map((a) => {
              const href = `/agents/${a.id}`;
              const active = pathname === href;
              const label = agentLabel(a);
              const agentSessions = sessionsByAgent.get(a.id) ?? [];
              const hasSessions = agentSessions.length > 0;
              const isOpen = expanded.has(a.id) && hasSessions;

              return (
                <li key={a.id}>
                  <div className="flex items-center gap-0.5">
                    {hasSessions ? (
                      <button
                        type="button"
                        onClick={() => toggle(a.id)}
                        aria-label={isOpen ? "Collapse" : "Expand"}
                        aria-expanded={isOpen}
                        className="inline-flex h-7 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {isOpen ? (
                          <ChevronDown className="size-3" aria-hidden />
                        ) : (
                          <ChevronRight className="size-3" aria-hidden />
                        )}
                      </button>
                    ) : (
                      <span className="inline-flex h-7 w-5 shrink-0" aria-hidden />
                    )}
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        active
                          ? "bg-sidebar-accent font-medium text-foreground"
                          : isOpen
                            ? "font-medium text-foreground hover:bg-sidebar-accent"
                            : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                      )}
                      title={label}
                    >
                      <AgentAvatar
                        name={a.name ?? a.id}
                        pfpUrl={a.pfp_url}
                        size={20}
                      />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {hasSessions ? (
                        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/60">
                          {agentSessions.length}
                        </span>
                      ) : null}
                    </Link>
                  </div>

                  {isOpen ? (
                    <ul className="ml-[26px] mt-1 mb-2 space-y-px">
                      {agentSessions.map((s) => {
                        const sHref = `/sessions/${s.id}`;
                        const sActive = pathname === sHref;
                        return (
                          <li key={s.id}>
                            <Link
                              href={sHref}
                              aria-current={sActive ? "page" : undefined}
                              className={cn(
                                "flex h-9 items-center gap-2 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                sActive
                                  ? "bg-sidebar-accent font-medium text-foreground"
                                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                              )}
                              title={`${s.id} · ${s.status}`}
                            >
                              {sActive ? (
                                <span
                                  aria-hidden
                                  title={s.status}
                                  className={cn(
                                    "size-1.5 shrink-0 rounded-full",
                                    statusDotClass(s.status),
                                  )}
                                />
                              ) : (
                                <span className="inline-block size-1.5 shrink-0" aria-hidden />
                              )}
                              <span className="min-w-0 flex-1 truncate">
                                {sessionLabel(s)}
                              </span>
                              <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/60">
                                {formatRelative(s.created_at)}
                              </span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
        {/* Skills */}
        <div className="mt-3">
          <SectionHeader
            label="Skills"
            count={skills.length}
            href="/skills"
            active={pathname === "/skills"}
          />
          <ul className="space-y-px">
            {skills.length === 0 ? (
              <li className="px-2 py-1 text-[11px] text-muted-foreground">
                No skills yet.
              </li>
            ) : (
              skills.slice(0, 5).map((sk) => {
                const href = `/skills/${sk.id}`;
                const active = pathname === href;
                return (
                  <li key={sk.id}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        active
                          ? "bg-sidebar-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                      )}
                      title={sk.name}
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{sk.name}</span>
                    </Link>
                  </li>
                );
              })
            )}
          </ul>
        </div>

        {/* Projects */}
        <div className="mt-3">
          <SectionHeader
            label="Projects"
            count={projects.length}
            href="/projects"
            active={pathname === "/projects"}
          />
          <ul className="space-y-px">
            {projects.length === 0 ? (
              <li className="px-2 py-1 text-[11px] text-muted-foreground">
                No projects yet.
              </li>
            ) : (
              projects.map((t) => {
                const href = `/projects`;
                const active = pathname === "/projects";
                return (
                  <li key={t.id}>
                    <Link
                      href={href}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        active
                          ? "bg-sidebar-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                      )}
                      title={t.name}
                    >
                      <LayoutTemplate className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    </Link>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </nav>

      {/* Sticky footer */}
      <div className="sticky bottom-0 flex items-center gap-0.5 border-t border-sidebar-border bg-sidebar px-2 py-1.5">
        <ThemeToggle />
        <Link
          href="/settings"
          aria-label="Infrastructure"
          aria-current={
            pathname === "/settings" || pathname.startsWith("/settings/")
              ? "page"
              : undefined
          }
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            pathname === "/settings" || pathname.startsWith("/settings/")
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          <Settings className="size-3.5" aria-hidden />
        </Link>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View repository on GitHub"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <svg
            className="size-3.5"
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

interface SectionHeaderProps {
  label: string;
  count: number;
  href?: string;
  active?: boolean;
  seeAllHref?: string;
}

function SectionHeader({ label, count, href, active, seeAllHref }: SectionHeaderProps) {
  const inner = (
    <>
      <span className="truncate">{label}</span>
      <span className="ml-auto tabular-nums text-muted-foreground/60">
        {count}
      </span>
      {seeAllHref && (
        <Link
          href={seeAllHref}
          onClick={(e) => e.stopPropagation()}
          className="ml-1 text-muted-foreground/50 transition-colors hover:text-muted-foreground focus-visible:outline-none"
        >
          see all →
        </Link>
      )}
    </>
  );
  return (
    <div className="mt-1 mb-1">
      {href ? (
        <Link
          href={href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex h-6 items-center gap-2 rounded-md px-2 text-[10px] font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            active
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          {inner}
        </Link>
      ) : (
        <div className="flex h-6 items-center gap-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {inner}
        </div>
      )}
    </div>
  );
}
