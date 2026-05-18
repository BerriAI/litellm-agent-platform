/**
 * Provider registry.
 *
 * Adding a new integration:
 *   1. Create `../providers/<id>/index.ts` exporting a default `Integration`.
 *   2. Add one import line below.
 *   3. Add it to the `ALL` array.
 *
 * That's the whole rule. No dynamic file scanning — explicit imports keep
 * the dependency tree obvious and play well with Next.js bundling.
 */

import linear from "../providers/linear";
import slack from "../providers/slack";
import type { Integration } from "./types";

const ALL: Integration[] = [linear, slack];

/** Every registered provider, including the disabled ones (their config is incomplete). */
export function listProviders(): Integration[] {
  return [...ALL];
}

/** Every provider whose `enabled()` returns true. Use this for routing. */
export function listEnabledProviders(): Integration[] {
  return ALL.filter((p) => p.enabled());
}

/**
 * Lookup by id. Returns undefined if the id is unknown OR if the provider is
 * registered but its `enabled()` returns false — callers should treat both
 * cases as "this integration isn't available", typically with a 404.
 */
export function getProvider(id: string): Integration | undefined {
  const p = ALL.find((x) => x.id === id);
  if (!p) return undefined;
  if (!p.enabled()) return undefined;
  return p;
}
