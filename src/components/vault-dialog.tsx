"use client";

/**
 * Vault side panel — sibling to the Wire inspector. Renders as a
 * flex-child of the session container so opening it shrinks the chat
 * column instead of overlaying it. Houses only the interceptions table;
 * no SSE plumbing here.
 *
 * Mounting parity with InspectorPanel: we return `null` when closed
 * (rather than not mounting at all) so transient state inside
 * InterceptionsPanel (poll timers, last-fetched records) is reset cleanly
 * via unmount/remount — there's no streaming state worth preserving across
 * close→reopen here, unlike the wire inspector.
 */

import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";

import { InterceptionsPanel } from "@/app/sessions/[sid]/interceptions-panel";
import { getSessionVaultKeys } from "@/lib/api";

function VaultKeysSection({ sessionId }: { sessionId: string }) {
  const [keys, setKeys] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const ctl = new AbortController();
    getSessionVaultKeys(sessionId, { signal: ctl.signal })
      .then((k) => { if (!cancelled) setKeys(k); })
      .catch(() => {});
    return () => { cancelled = true; ctl.abort(); };
  }, [sessionId]);

  if (keys.length === 0) return null;

  return (
    <div className="rounded border border-gray-200 bg-white px-3 py-2">
      <div className="text-[11px] text-gray-500 font-medium mb-1.5">
        Keys in vault ({keys.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {keys.map((k) => (
          <span
            key={k}
            className="mono text-[11px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-gray-700"
          >
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

export function VaultPanel({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  if (!open) return null;
  return (
    <aside className="flex flex-col h-full min-h-0 border-l border-gray-200 bg-white w-[640px] shrink-0">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-gray-200">
        <ShieldCheck className="size-3.5 text-gray-500" />
        <span className="text-[13px] font-medium text-gray-800">Vault</span>
        <span className="font-mono text-[11px] text-gray-400">
          session {sessionId.slice(0, 8)}…
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1 hover:bg-gray-100 rounded"
          title="Close vault panel"
        >
          <X className="size-4 text-gray-500" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 bg-gray-50/30 flex flex-col gap-3">
        <VaultKeysSection sessionId={sessionId} />
        <InterceptionsPanel sessionId={sessionId} initialExpanded={true} />
      </div>

      <footer className="px-4 py-1.5 border-t border-gray-200 text-[10px] text-gray-400 font-mono">
        vault sidecar /interceptions (per-session ring buffer)
      </footer>
    </aside>
  );
}
