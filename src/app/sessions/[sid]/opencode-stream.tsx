"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyEvent,
  initState,
  seedFromHistory,
  type AgentMessage,
  type AgentState,
  type OpencodeEvent,
  type PermissionRequest,
} from "@/lib/agent-state";
import { browserOpencodeClient } from "@/lib/opencode-client";
import { ensureUiCookie } from "@/lib/ui-cookie";

export type SendParts = Array<
  { type: "text"; text: string } | { type: "file"; mime: string; url: string }
>;

export type PermissionResponse = "once" | "always" | "reject";

export interface OpencodeThread {
  /** The whole parent thread (user + assistant), in order. */
  messages: AgentMessage[];
  /** Subagent (child session) threads, keyed by child sessionID. A `task`
   *  tool's `state.metadata.sessionId` maps to one of these. */
  subThreads: Map<string, AgentMessage[]>;
  /** Permission prompts the agent (or a subagent) is currently blocked on. */
  permissions: PermissionRequest[];
  /** True between a send and the next session.idle. */
  busy: boolean;
  error?: string;
  send: (
    parts: SendParts,
    model?: { providerID: string; modelID: string },
  ) => Promise<void>;
  respondPermission: (
    permissionID: string,
    permSessionID: string,
    response: PermissionResponse,
  ) => Promise<void>;
}

function childSessionIds(parent: AgentState): Set<string> {
  const ids = new Set<string>();
  for (const m of parent.messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.tool === "task") {
        const cid = (p.state?.metadata as { sessionId?: string } | undefined)
          ?.sessionId;
        if (cid) ids.add(cid);
      }
    }
  }
  return ids;
}

/**
 * The entire session tree, driven by the opencode SDK. One subscription folds
 * the `/event` bus per-session: the parent thread plus every subagent (child)
 * session a `task` tool spawns. The UI renders the parent thread and lets each
 * `task` tool expand to show its subagent's work (the child sub-thread).
 *
 * Seed once from history (opencode `/event` doesn't replay); no drains, no
 * optimistic state, no refetch reconciliation.
 */
export function useOpencodeThread(
  sessionId: string,
  harnessSessionId: string | null | undefined,
  enabled: boolean,
): OpencodeThread {
  // Per-session reducer states (parent + children). Held in React state so the
  // render derives from it reactively (no refs during render).
  const [states, setStates] = useState<Map<string, AgentState>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState(false);
  const ocRef = useRef<ReturnType<typeof browserOpencodeClient> | null>(null);
  const fetchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || !sessionId || !harnessSessionId) return;
    setStates(new Map());
    fetchedRef.current = new Set();
    let cancelled = false;
    const ctl = new AbortController();

    void (async () => {
      // Install the HttpOnly UI cookie before any /api/ui/* request so that
      // prompt_async, event subscription, and history fetches all succeed.
      // ensureUiCookie is cached per page-load — only one POST per session.
      await ensureUiCookie();
      if (cancelled) return;

      const oc = browserOpencodeClient(sessionId);
      ocRef.current = oc;

      try {
        const hist = await oc.session.messages({
          path: { id: harnessSessionId },
        });
        const seeded = seedFromHistory(
          (hist.data ?? []) as unknown as Parameters<typeof seedFromHistory>[0],
        );
        if (!cancelled) {
          setStates((prev) => new Map(prev).set(harnessSessionId, seeded));
        }
      } catch {
        // pod warming up — live events will populate the thread
      }
      if (cancelled) return;

      let events;
      try {
        events = await oc.event.subscribe({ signal: ctl.signal });
      } catch {
        return;
      }
      try {
        for await (const ev of events.stream) {
          if (cancelled) break;
          const e = ev as unknown as OpencodeEvent;
          const sid = e.properties?.sessionID;
          if (typeof sid !== "string") continue; // global lifecycle — skip
          setStates((prev) => {
            const next = new Map(prev);
            next.set(sid, applyEvent(next.get(sid) ?? initState(), e));
            return next;
          });
          if (
            sid === harnessSessionId &&
            (e.type === "session.idle" ||
              e.type === "session.aborted" ||
              e.type === "session.error")
          ) {
            // session.error must clear busy too, or an agent error (rate limit,
            // context overflow, harness crash) locks the composer on a spinner
            // until a hard refresh.
            setBusy(false);
          }
        }
      } catch {
        // aborted on unmount / nav, or the stream closed
      }
    })();

    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [sessionId, harnessSessionId, enabled]);

  // Derive parent + subagent sub-threads (scoped to children this parent
  // spawned via a `task` tool) + aggregate permissions.
  const parent = states.get(harnessSessionId ?? "") ?? initState();
  const subThreads = new Map<string, AgentMessage[]>();
  let permissions: PermissionRequest[] = [...parent.permissions];
  for (const cid of childSessionIds(parent)) {
    const st = states.get(cid);
    if (st) {
      subThreads.set(cid, st.messages);
      permissions = permissions.concat(st.permissions);
    }
  }

  // Seed subagent (child) session histories so a completed subagent's work
  // shows even when its live events fired before we subscribed (e.g. opening a
  // session whose `task` already ran). Live events build on top.
  const childKey = [...childSessionIds(parent)].sort().join(",");
  useEffect(() => {
    const oc = ocRef.current;
    if (!oc || !childKey) return;
    let cancelled = false;
    for (const cid of childKey.split(",")) {
      if (!cid || fetchedRef.current.has(cid)) continue;
      fetchedRef.current.add(cid);
      void (async () => {
        try {
          const hist = await oc.session.messages({ path: { id: cid } });
          if (cancelled) return;
          const seeded = seedFromHistory(
            (hist.data ?? []) as unknown as Parameters<
              typeof seedFromHistory
            >[0],
          );
          setStates((prev) =>
            prev.has(cid) ? prev : new Map(prev).set(cid, seeded),
          );
        } catch {
          // child not reachable — leave the card showing "working…"
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [childKey]);

  const send = useCallback(
    async (
      parts: SendParts,
      model?: { providerID: string; modelID: string },
    ) => {
      if (!harnessSessionId) throw new Error("session not ready");
      const oc = ocRef.current ?? browserOpencodeClient(sessionId);
      setBusy(true);
      try {
        await oc.session.promptAsync({
          path: { id: harnessSessionId },
          body: { ...(model ? { model } : {}), parts },
          throwOnError: true,
        });
      } catch (e) {
        setBusy(false);
        throw e;
      }
    },
    [sessionId, harnessSessionId],
  );

  const respondPermission = useCallback(
    async (
      permissionID: string,
      permSessionID: string,
      response: PermissionResponse,
    ) => {
      const oc = ocRef.current ?? browserOpencodeClient(sessionId);
      await oc.postSessionIdPermissionsPermissionId({
        path: { id: permSessionID, permissionID },
        body: { response },
        throwOnError: true,
      });
    },
    [sessionId],
  );

  return {
    messages: parent.messages,
    subThreads,
    permissions,
    busy,
    error: parent.error,
    send,
    respondPermission,
  };
}
