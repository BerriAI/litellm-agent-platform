"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type HarnessMode = "CHAT" | "TUI";

export interface HarnessOption {
  id: string;
  label: string;
  description: string;
  mode: HarnessMode;
}

export const HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "opencode",
    label: "opencode",
    description: "OpenCode TUI running in the sandbox. Multi-provider via LiteLLM. Opens as a live TUI in your browser via xterm.js. Set OPENCODE_MODE=serve to use the JSON API instead.",
    mode: "TUI",
  },
  {
    id: "claude-agent-sdk",
    label: "claude-agent-sdk",
    description: "Anthropic's first-party agent loop. Fewer harness bugs; SDK persists session state for free.",
    mode: "CHAT",
  },
  {
    id: "claude-code",
    label: "claude-code",
    description: "Claude Code CLI, running in the sandbox. Opens as a live TUI in your browser via xterm.js.",
    mode: "TUI",
  },
  {
    id: "codex",
    label: "codex",
    description: "OpenAI Codex CLI, running in the sandbox. Opens as a live TUI in your browser via xterm.js.",
    mode: "TUI",
  },
  {
    id: "hermes",
    label: "hermes",
    description: "Nous Research Hermes Agent, running in the sandbox. Self-improving CLI with persistent memory + skills. Opens as a live TUI via xterm.js.",
    mode: "TUI",
  },
  {
    id: "gemini",
    label: "gemini",
    description: "Google Gemini CLI, running in the sandbox. Routes through the LiteLLM gateway via the /gemini passthrough. Opens as a live TUI via xterm.js.",
    mode: "TUI",
  },
];

export const DEFAULT_HARNESS_ID = HARNESS_OPTIONS[0].id;

const MODE_CLASS: Record<HarnessMode, string> = {
  CHAT: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
  TUI:  "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
};

interface HarnessPickerProps {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function HarnessPicker({ value, onChange, disabled }: HarnessPickerProps) {
  return (
    <div className="rounded-lg border bg-card">
      <ul role="radiogroup" aria-label="Harness" className="divide-y">
        {HARNESS_OPTIONS.map((opt) => {
          const selected = opt.id === value;
          return (
            <li key={opt.id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(opt.id)}
                disabled={disabled}
                className={cn(
                  "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  selected && "bg-accent/30",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                    selected
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-transparent",
                  )}
                  aria-hidden
                >
                  {selected ? <Check className="size-3" /> : null}
                </span>
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-[13px] text-foreground">{opt.label}</span>
                    <span className="text-[11px] text-muted-foreground">{opt.description}</span>
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
                      MODE_CLASS[opt.mode],
                    )}
                  >
                    {opt.mode}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
