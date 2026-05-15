"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { ModelRow, listModels } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function ModelPicker({ value, onChange, disabled }: ModelPickerProps) {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listModels().catch(() => [] as ModelRow[]).then(setModels);
  }, []);

  const sorted = useMemo(() => {
    const seen = new Set<string>();
    const deduped = models.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    return deduped.sort((a, b) => a.id.localeCompare(b.id));
  }, [models]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((m) => m.id.toLowerCase().includes(q));
  }, [sorted, query]);

  if (sorted.length === 0) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="anthropic/claude-haiku-4-5"
        disabled={disabled}
        className="font-mono text-xs"
      />
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${sorted.length} models…`}
          disabled={disabled}
          className="pl-8 font-mono text-xs"
          autoComplete="off"
        />
      </div>
      <div className="rounded-lg border bg-card">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No models match <span className="font-mono">&quot;{query.trim()}&quot;</span>.
          </p>
        ) : (
          <ul role="listbox" aria-label="Models" className="max-h-64 divide-y overflow-y-auto">
            {filtered.map((m) => {
              const selected = m.id === value;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onChange(m.id)}
                    disabled={disabled}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      selected && "bg-accent/30",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                        selected
                          ? "border-foreground bg-foreground text-background"
                          : "border-border bg-transparent",
                      )}
                      aria-hidden
                    >
                      {selected ? <Check className="size-3" /> : null}
                    </span>
                    <span className="truncate font-mono text-xs text-foreground">{m.id}</span>
                    {m.owned_by ? (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {m.owned_by}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
