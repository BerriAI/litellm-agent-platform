/**
 * Shared types for the vault interceptions debug surface.
 *
 * These shapes cross two boundaries:
 *   - `src/server/k8s.ts` reads them from the vault sidecar's
 *     `/interceptions` endpoint.
 *   - `src/lib/api.ts` re-exposes them to the browser via the session
 *     interceptions route handler.
 *
 * Keep this module dependency-free so it can be imported from both server
 * and client code without dragging in Node-only modules.
 */

export interface VaultInterceptionFingerprint {
  stub: string;
  credential: string;
  real_tail: string;
}

export interface VaultInterception {
  timestamp: string;
  method: string;
  host: string;
  path: string;
  stubs_swapped: string[];
  real_value_fingerprint: VaultInterceptionFingerprint[];
  blocked?: boolean;
}
