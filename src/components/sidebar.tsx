"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PanelLeft,
  Search,
  Layers,
  Workflow,
  Boxes,
  PlugZap,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/BerriAI/litellm-agent-platform";

interface NavItem {
  href: string;
  label: string;
  Icon: typeof Layers;
  isActive: (pathname: string) => boolean;
}

/**
 * Single primary nav. Each entry is an entity *list* the user navigates to.
 * Page-level CTAs ("+ New Agent", "+ New Session") live on the destination
 * pages, not here, so the sidebar has exactly one hierarchy.
 */
const NAV: readonly NavItem[] = [
  {
    href: "/agents",
    label: "Agents",
    Icon: Layers,
    isActive: (p) => p.startsWith("/agents"),
  },
  {
    href: "/sessions",
    label: "Sessions",
    Icon: Workflow,
    isActive: (p) => p.startsWith("/sessions"),
  },
  {
    href: "/models",
    label: "Models",
    Icon: Boxes,
    isActive: (p) => p === "/models",
  },
  {
    href: "/mcps",
    label: "MCP Servers",
    Icon: PlugZap,
    isActive: (p) => p === "/mcps",
  },
];

export function Sidebar() {
  const pathname = usePathname() ?? "";

  return (
    <aside
      className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label="Primary sidebar"
    >
      {/* Wordmark */}
      <div className="flex flex-col gap-0.5 px-4 pt-4 pb-3">
        <Link
          href="/"
          aria-label="LiteLLM Agent Platform home"
          className="inline-flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span
            aria-hidden
            className="grid h-5 w-5 place-items-center rounded-[5px] bg-foreground text-[10px] font-semibold tracking-tight text-background"
          >
            L
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-foreground">
            LiteLLM
          </span>
        </Link>
        <span className="ml-7 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
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

      {/* Primary nav */}
      <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-2 pt-1">
        <ul className="space-y-0.5">
          {NAV.map(({ href, label, Icon, isActive }) => {
            const active = isActive(pathname);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-foreground" : "text-muted-foreground",
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
