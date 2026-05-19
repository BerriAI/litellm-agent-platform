"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { listAgentsPaginated } from "@/lib/api";

export interface AgentToolSpec {
  agent_id: string;
  name: string;
  description: string;
}

interface AgentOption {
  agent_id: string;
  agent_name: string | null;
}

interface AgentAsToolPickerProps {
  /** The agent_id of the orchestrator — excluded from the dropdown. */
  self_agent_id: string;
  value: AgentToolSpec[];
  onChange: (v: AgentToolSpec[]) => void;
  disabled?: boolean;
}

export function AgentAsToolPicker({
  self_agent_id,
  value,
  onChange,
  disabled,
}: AgentAsToolPickerProps) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAgentsPaginated({ limit: 200 })
      .then((res) =>
        setAgents(
          res.data
            .filter((a) => a.id !== self_agent_id)
            .map((a) => ({ agent_id: a.id, agent_name: a.name ?? null })),
        ),
      )
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, [self_agent_id]);

  function addEntry() {
    if (value.length >= 10) return;
    onChange([
      ...value,
      { agent_id: "", name: "", description: "" },
    ]);
  }

  function removeEntry(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  function updateEntry(i: number, patch: Partial<AgentToolSpec>) {
    onChange(value.map((entry, idx) => (idx === i ? { ...entry, ...patch } : entry)));
  }

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading agents…</p>;
  }

  const available = agents.filter(
    (a) => !value.some((t) => t.agent_id === a.agent_id),
  );

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No sub-agent tools configured. Add one below.
        </p>
      ) : (
        <ul className="space-y-2">
          {value.map((entry, i) => (
            <li key={i} className="rounded-lg border bg-card p-3">
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {/* Agent selector */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Agent
                    </label>
                    <select
                      disabled={disabled || agents.length === 0}
                      value={entry.agent_id}
                      onChange={(e) => {
                        const selected = agents.find(
                          (a) => a.agent_id === e.target.value,
                        );
                        updateEntry(i, {
                          agent_id: e.target.value,
                          // Auto-fill name from agent_name if the tool name is still empty
                          ...(entry.name === "" && selected?.agent_name
                            ? {
                                name: selected.agent_name
                                  .toLowerCase()
                                  .replace(/[^a-z0-9_-]+/g, "_")
                                  .slice(0, 64),
                              }
                            : {}),
                        });
                      }}
                      className={cn(
                        "w-full rounded-md border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring",
                        disabled && "opacity-60",
                      )}
                    >
                      <option value="">— select agent —</option>
                      {available.map((a) => (
                        <option key={a.agent_id} value={a.agent_id}>
                          {a.agent_name ?? a.agent_id}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Tool name */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Tool name{" "}
                      <span className="font-normal normal-case text-muted-foreground/70">
                        (alphanumeric + _ -)
                      </span>
                    </label>
                    <input
                      type="text"
                      disabled={disabled}
                      value={entry.name}
                      maxLength={64}
                      placeholder="e.g. research_agent"
                      onChange={(e) => updateEntry(i, { name: e.target.value })}
                      className={cn(
                        "w-full rounded-md border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring",
                        disabled && "opacity-60",
                        entry.name && !/^[a-zA-Z0-9_-]+$/.test(entry.name) &&
                          "border-destructive",
                      )}
                    />
                  </div>

                  {/* Description */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Description
                    </label>
                    <textarea
                      disabled={disabled}
                      value={entry.description}
                      maxLength={256}
                      rows={2}
                      placeholder="What this agent does — shown to the model in the tool manifest."
                      onChange={(e) => updateEntry(i, { description: e.target.value })}
                      className={cn(
                        "w-full resize-none rounded-md border bg-background px-2 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring",
                        disabled && "opacity-60",
                      )}
                    />
                  </div>
                </div>

                {/* Remove button */}
                <button
                  type="button"
                  aria-label="Remove tool"
                  disabled={disabled}
                  onClick={() => removeEntry(i)}
                  className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add button */}
      <button
        type="button"
        disabled={disabled || value.length >= 10}
        onClick={addEntry}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        <Plus className="size-3.5" />
        Add sub-agent tool
        {value.length >= 10 ? " (max 10)" : ""}
      </button>
    </div>
  );
}
