"use client";

/**
 * Vault interceptions panel — per-session debugging surface that answers:
 * "did vault swap my stub on this tool call?"
 *
 * Behaviour:
 *   - Polls /api/v1/managed_agents/sessions/<id>/interceptions every 3s.
 *   - Shows the most recent request first.
 *   - Records carry only the credential name and the last 2 chars of the
 *     real value — full real values never leave the vault sidecar.
 *   - Header counts requests in the last hour (independent of the buffer
 *     size, so "I just sent a request" doesn't always say "100").
 *
 * Backend is lenient — empty arrays on missing pods / transient errors —
 * so a single failed poll does not flash a red error. We surface the most
 * recent network error inline only after we've already had a successful
 * payload, to avoid noise during cold-start.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { getSessionInterceptions, type VaultInterception } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const POLL_INTERVAL_MS = 3_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

interface InterceptionsPanelProps {
  sessionId: string;
  /**
   * Initial expanded state. Defaults to `false` (collapsed) for in-thread
   * placement. The inspector tab placement passes `true` so the table is
   * visible the moment the user opens the Vault tab.
   */
  initialExpanded?: boolean;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // HH:mm:ss.SSS — high resolution helps when several swaps land in the
  // same second (e.g. parallel tool calls). Date string is omitted; the
  // user already knows which session they're inside.
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function countInLastHour(records: VaultInterception[]): number {
  const cutoff = Date.now() - ONE_HOUR_MS;
  let n = 0;
  for (const r of records) {
    const t = Date.parse(r.timestamp);
    if (Number.isFinite(t) && t >= cutoff) n += 1;
  }
  return n;
}

/**
 * Render one interception record as one or more <TableRow>s — one row per
 * swapped credential when there are swaps, or a single "no swap" row when
 * the request tunneled through unchanged. Pulled out as a module-level
 * helper so we can reuse the exact same row shape for both the matched
 * table (top) and the unmatched accordion (bottom).
 */
function renderInterceptionRows(
  rec: VaultInterception,
  idx: number,
): React.ReactElement[] {
  const baseKey = `${rec.timestamp}-${idx}`;
  if (rec.blocked) {
    return [
      <TableRow key={baseKey} className="bg-red-50">
        <TableCell className="mono text-[11px]">
          {formatTimestamp(rec.timestamp)}
        </TableCell>
        <TableCell>
          <Badge variant="secondary">{rec.method}</Badge>
        </TableCell>
        <TableCell className="mono text-[11px]">{rec.host}</TableCell>
        <TableCell className="mono text-[11px] break-all">{rec.path}</TableCell>
        <TableCell colSpan={3}>
          <Badge variant="destructive">BLOCKED</Badge>
        </TableCell>
      </TableRow>,
    ];
  }
  if (rec.real_value_fingerprint.length === 0) {
    return [
      <TableRow key={baseKey}>
        <TableCell className="mono text-[11px]">
          {formatTimestamp(rec.timestamp)}
        </TableCell>
        <TableCell>
          <Badge variant="secondary">{rec.method}</Badge>
        </TableCell>
        <TableCell className="mono text-[11px]">{rec.host}</TableCell>
        <TableCell className="mono text-[11px] break-all">{rec.path}</TableCell>
        <TableCell colSpan={3}>
          <span className="text-[11px] text-gray-400 italic">no swap</span>
        </TableCell>
      </TableRow>,
    ];
  }
  return rec.real_value_fingerprint.map((fp, fpIdx) => (
    <TableRow key={`${baseKey}-${fpIdx}`}>
      <TableCell className="mono text-[11px]">
        {fpIdx === 0 ? formatTimestamp(rec.timestamp) : ""}
      </TableCell>
      <TableCell>
        {fpIdx === 0 ? <Badge variant="secondary">{rec.method}</Badge> : null}
      </TableCell>
      <TableCell className="mono text-[11px]">
        {fpIdx === 0 ? rec.host : ""}
      </TableCell>
      <TableCell className="mono text-[11px] break-all">
        {fpIdx === 0 ? rec.path : ""}
      </TableCell>
      <TableCell>
        <Badge>{fp.credential}</Badge>
      </TableCell>
      <TableCell className="mono text-[11px] break-all">{fp.stub}</TableCell>
      <TableCell className="mono text-[11px]">
        {fp.real_tail ? `…${fp.real_tail}` : "…"}
      </TableCell>
    </TableRow>
  ));
}

/**
 * Self-contained table renderer for a list of interception records.
 * Same column shape regardless of whether the records had swaps.
 */
function InterceptionsTable({
  records,
}: {
  records: VaultInterception[];
}): React.ReactElement {
  return (
    <div className="rounded border border-gray-200 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">Time</TableHead>
            <TableHead className="w-[70px]">Method</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Credential</TableHead>
            <TableHead>Stub</TableHead>
            <TableHead className="w-[80px]">Real (…last 2)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.flatMap((rec, idx) => renderInterceptionRows(rec, idx))}
        </TableBody>
      </Table>
    </div>
  );
}

export function InterceptionsPanel({
  sessionId,
  initialExpanded = false,
}: InterceptionsPanelProps) {
  const [expanded, setExpanded] = useState<boolean>(initialExpanded);
  const [records, setRecords] = useState<VaultInterception[]>([]);
  const [hasLoaded, setHasLoaded] = useState<boolean>(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const seenSuccessRef = useRef<boolean>(false);

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
        const data = await getSessionInterceptions(sessionId, {
          signal: ctl.signal,
        });
        if (cancelled) return;
        setRecords(data);
        setHasLoaded(true);
        setPollError(null);
        seenSuccessRef.current = true;
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        // Only surface errors after we've shown data at least once. During
        // cold-start the route returns [] anyway; an error here means
        // something genuinely broke after the route was healthy.
        if (seenSuccessRef.current) {
          const msg = e instanceof Error ? e.message : String(e);
          setPollError(msg);
        }
        console.warn("interceptions poll failed", e);
      } finally {
        if (inflight === ctl) inflight = null;
      }
    };

    const loop = async (): Promise<void> => {
      await fetchOnce();
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        void loop();
      }, POLL_INTERVAL_MS);
    };

    void loop();

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      inflight?.abort();
    };
  }, [sessionId, expanded]);

  // Newest first. The vault buffer is appended in order, so reversing
  // gives a most-recent-on-top table — which is what a debugger wants.
  const sorted = useMemo(() => {
    return [...records].sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
      return tb - ta;
    });
  }, [records]);

  // Split sorted records into "notable" (had a real stub→real swap, OR was
  // blocked by egress policy) and "unmatched" (request tunneled through
  // unchanged with no swap and no block). Notable rows are the signal the
  // user cares about; unmatched rows live in a collapsed accordion.
  const matched = useMemo(
    () => sorted.filter((r) => r.stubs_swapped.length > 0 || r.blocked),
    [sorted],
  );
  const unmatched = useMemo(
    () => sorted.filter((r) => r.stubs_swapped.length === 0 && !r.blocked),
    [sorted],
  );

  const lastHour = useMemo(() => countInLastHour(records), [records]);

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <ChevronDown
          className={`w-3 h-3 text-gray-500 shrink-0 transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
          aria-hidden
        />
        <span className="mono text-[11px] text-gray-600">
          Vault Interceptions
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="mono text-[11px] text-gray-400">
            {lastHour} in the last hour
          </span>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-gray-200">
          <Card className="rounded-none border-0 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-[13px] font-medium">
                Vault Interceptions
              </CardTitle>
              <CardDescription className="text-[12px]">
                {lastHour} Vault Interception{lastHour === 1 ? "" : "s"} in
                the last hour. Showing the most recent {records.length} from
                the vault sidecar (ring buffer, max 100). Real values are
                never surfaced — only the last 2 characters as a fingerprint.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {pollError && (
                <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 mono text-[11px] text-red-800">
                  poll error: {pollError}
                </div>
              )}
              {!hasLoaded ? (
                <div className="text-[12px] text-gray-500 italic py-2">
                  Loading…
                </div>
              ) : sorted.length === 0 ? (
                <div className="rounded border border-dashed border-gray-200 px-3 py-4 text-center">
                  <div className="text-[13px] text-gray-700">
                    No Vault Interceptions yet.
                  </div>
                  <div className="mt-1 text-[12px] text-gray-500">
                    Try sending a message that triggers a tool call (e.g.{" "}
                    <span className="mono">gh api user</span>).
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {matched.length > 0 ? (
                    <InterceptionsTable records={matched} />
                  ) : (
                    <div className="rounded border border-dashed border-gray-200 px-3 py-3 text-center">
                      <div className="text-[12px] text-gray-600">
                        No swaps yet ({unmatched.length} request
                        {unmatched.length === 1 ? "" : "s"} tunneled through).
                      </div>
                    </div>
                  )}
                  {unmatched.length > 0 && (
                    // Native <details> rather than the shadcn Accordion (which
                    // isn't installed in this repo's `ui/`). Default-closed so
                    // the matched table stays the primary surface.
                    <details className="group rounded border border-gray-200 overflow-hidden">
                      <summary className="cursor-pointer list-none px-3 py-2 bg-gray-50 hover:bg-gray-100 text-[12px] text-gray-700 flex items-center gap-2 select-none">
                        <ChevronDown
                          className="w-3 h-3 text-gray-500 shrink-0 transition-transform -rotate-90 group-open:rotate-0"
                          aria-hidden
                        />
                        <span>
                          Requests with no swaps ({unmatched.length})
                        </span>
                      </summary>
                      <div className="p-2 bg-white">
                        <InterceptionsTable records={unmatched} />
                      </div>
                    </details>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
