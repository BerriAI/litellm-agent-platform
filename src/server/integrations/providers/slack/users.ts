/**
 * Slack user resolution helper.
 *
 * Inbound events expose only the sender's Slack user id (e.g. `U123ABC`).
 * The display name / handle live behind `users.info`, which requires the
 * `users:read` bot scope. We call it best-effort: if the scope is missing
 * on an existing install, or Slack is having a bad day, we just return the
 * raw id and let the agent address the user via `<@U123ABC>` (which Slack
 * still renders as a clickable mention even without the lookup).
 *
 * A per-process LRU keyed by `(team_id, user_id)` avoids hammering Slack
 * on chatty threads. Entries are evicted after `TTL_MS` regardless of
 * use; the cache is intentionally tiny (this is OSS infra, not a CDN).
 *
 * Bot scope required: `users:read`. Declared in the Slack manifest and
 * mirrored in `./oauth.ts` SCOPES so the OAuth flow requests it too.
 */

import { fetch } from "undici";
import { decrypt } from "../../core/crypto";
import type { IntegrationInstall } from "@prisma/client";

const USERS_INFO_URL = "https://slack.com/api/users.info";
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

interface SlackUsersInfoResponse {
  ok: boolean;
  error?: string;
  user?: {
    id?: string;
    name?: string; // username, no leading "@"
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

interface Resolved {
  /** Slack username (without "@"). */
  handle?: string;
  /** Best human name (display_name → real_name → user.name). */
  display_name?: string;
}

interface CacheEntry {
  value: Resolved;
  /** ms-since-epoch when this entry was written. */
  written_at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(team_id: string, user_id: string): string {
  return `${team_id}:${user_id}`;
}

function readCache(team_id: string, user_id: string): Resolved | null {
  const k = cacheKey(team_id, user_id);
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.written_at > TTL_MS) {
    cache.delete(k);
    return null;
  }
  // Promote to most-recently-used: re-inserting moves the key to the end of
  // the Map's insertion order, so writeCache evicts the genuinely LRU entry.
  cache.delete(k);
  cache.set(k, hit);
  return hit.value;
}

function writeCache(team_id: string, user_id: string, value: Resolved): void {
  // Bounded LRU: evict the least-recently-used entry when full. readCache
  // promotes hits to the newest position, so the Map's first key is the LRU.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(cacheKey(team_id, user_id), {
    value,
    written_at: Date.now(),
  });
}

/**
 * Resolve a Slack user id to a handle + display name. Returns `null` on
 * any failure (missing scope, network error, malformed response) — callers
 * MUST fall back gracefully and propagate the raw user id alone.
 *
 * Caches positive results for 5 minutes per (team, user). Failures are
 * NOT cached so a fixed scope/install will recover on the next message.
 */
export async function resolveSlackUser(
  install: IntegrationInstall,
  team_id: string,
  user_id: string,
): Promise<Resolved | null> {
  const cached = readCache(team_id, user_id);
  if (cached) return cached;

  const token = decrypt(install.access_token);

  try {
    const url = `${USERS_INFO_URL}?user=${encodeURIComponent(user_id)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(
        `[slack/users] users.info HTTP ${res.status} for ${user_id}`,
      );
      return null;
    }
    const json = (await res.json()) as SlackUsersInfoResponse;
    if (!json.ok || !json.user) {
      // missing_scope on installs predating the users:read scope is
      // expected — log at warn once per (team, user) and move on. Don't
      // cache: a reinstall flips the scope and we should pick that up.
      console.warn(
        `[slack/users] users.info not ok for ${user_id}: ${json.error ?? "no user"}`,
      );
      return null;
    }
    const resolved: Resolved = {
      handle: json.user.name || undefined,
      display_name:
        json.user.profile?.display_name ||
        json.user.profile?.real_name ||
        json.user.real_name ||
        json.user.name ||
        undefined,
    };
    writeCache(team_id, user_id, resolved);
    return resolved;
  } catch (err) {
    console.warn(
      `[slack/users] users.info fetch failed for ${user_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Test-only: drop the in-process cache. */
export function _clearSlackUserCache(): void {
  cache.clear();
}
