"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

interface NavTab {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}

const TABS: readonly NavTab[] = [
  {
    href: "/agents",
    label: "Agents",
    match: (p) => p === "/agents" || p.startsWith("/agents/"),
  },
  {
    href: "/sessions",
    label: "Sessions",
    match: (p) => p === "/sessions" || p.startsWith("/sessions/"),
  },
  {
    href: "/settings",
    label: "Settings",
    match: (p) => p === "/settings" || p.startsWith("/settings/"),
  },
];

const REPO_URL = "https://github.com/BerriAI/litellm-agent-platform";

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function TopNav() {
  const pathname = usePathname() ?? "";

  return (
    <header
      className="sticky top-0 z-40 h-13 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60"
      role="banner"
    >
      <div className="mx-auto flex h-full w-full items-center gap-6 px-4 sm:px-6">
        <Link
          href="/"
          aria-label="LiteLLM home"
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

        <nav
          aria-label="Primary"
          className="flex h-full items-center gap-5 text-sm"
        >
          {TABS.map((tab) => {
            const active = tab.match(pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                aria-label={tab.label}
                className={cn(
                  "relative flex h-full items-center -mb-px border-b-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  active
                    ? "border-foreground text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <span
            aria-hidden="true"
            className="hidden h-7 select-none items-center rounded-md border border-border bg-muted/40 px-2 text-[11px] font-medium tabular-nums text-muted-foreground sm:inline-flex"
            title="Command palette (coming soon)"
          >
            <kbd className="font-sans">⌘</kbd>
            <kbd className="font-sans">K</kbd>
          </span>
          <ThemeToggle />
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View repository on GitHub"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <GitHubMark className="size-4" />
          </a>
        </div>
      </div>
    </header>
  );
}
