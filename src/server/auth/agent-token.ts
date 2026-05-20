/**
 * Per-agent scoped tokens for pod → LAP API auth.
 *
 * Replaces the historical pattern of injecting `MASTER_KEY` into every
 * sandbox pod (which gave any pod admin access to the entire platform).
 * Each pod now gets:
 *
 *   - an `access` token (15min TTL, scoped to a single agent + one or more
 *     route classes — currently just "memory")
 *   - a `refresh` token (lifetime = pod max idle TTL, used only by the
 *     /api/v1/agent-auth/refresh endpoint to mint a fresh access token)
 *
 * The harness's MCP tool handler retries once on 401: hit /refresh with the
 * refresh token, swap in the new access token, retry the original call.
 *
 * Wire format (minimal, no JWT library):
 *
 *     base64url(payload) + "." + base64url(hmac_sha256(payload, key))
 *
 * `payload` is a UTF-8 JSON object with the claims below. Encoding is
 * url-safe-base64 without `=` padding so the tokens are safe to drop into
 * env vars and JSON bodies without escaping.
 *
 * Verification is stateless — no DB round trip. The server validates the
 * HMAC, checks `exp`, and then the caller (assertAgentTokenOrMaster)
 * matches `agent_id` against the URL param and `scope` against the route's
 * required scope. Revocation is implicit: when the pod dies, the tokens
 * die with it — nothing's holding them. If we need explicit revocation
 * later, a `pod` claim + a small denylist on the server gives it to us.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/server/env";

// Hard ceiling on access-token lifetime. Short enough that a leaked
// access token is brief, long enough that the refresh-on-401 path doesn't
// fire on every single tool call. 15 minutes is the conventional choice.
const ACCESS_TOKEN_TTL_SEC = 15 * 60;

// Refresh-token lifetime. Pinned to "comfortably exceeds the longest pod
// we ever expect to keep around" — 24h is more than the platform's idle
// reaper plus a generous slack. When the pod dies the token is moot.
const REFRESH_TOKEN_TTL_SEC = 24 * 60 * 60;

// Scopes we currently mint. The full set is just "memory" until we
// extend the JWT path to other route classes; keeping this a string-array
// so the call site reads naturally (`scope: ["memory"]`) and so we don't
// have to migrate token payloads when we add the second one.
export type AgentScope = "memory" | "tool";

interface BaseClaims {
  /** "access" — a regular bearer that authorizes requests under `scope`. */
  /** "refresh" — only valid at /api/v1/agent-auth/refresh.                 */
  kind: "access" | "refresh";
  /** Agent whose resources this token authorizes. */
  agent_id: string;
  /** Issued-at, unix seconds. Aids future audit logging. */
  iat: number;
  /** Expires-at, unix seconds. */
  exp: number;
  /** Optional opaque pod identifier, useful for future revocation. */
  pod?: string;
}

interface AccessClaims extends BaseClaims {
  kind: "access";
  scope: AgentScope[];
}

interface RefreshClaims extends BaseClaims {
  kind: "refresh";
  /**
   * The scope set this refresh token is allowed to mint future access tokens
   * for — must mirror the original mint-time grant. Carried in the refresh
   * token's claims so /agent-auth/refresh re-derives privileges from the
   * token itself rather than a hardcoded default. Without this, widening
   * the access-token scope set in k8s.ts (or anywhere else) would silently
   * downgrade every pod's first post-rotation token.
   */
  scope: AgentScope[];
}

export type AgentTokenClaims = AccessClaims | RefreshClaims;

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

interface MintAccessInput {
  agent_id: string;
  scope: AgentScope[];
  pod?: string;
  /** Override the TTL — used only in tests; production code should not pass this. */
  ttl_sec?: number;
}

export function mintAgentAccessToken(input: MintAccessInput): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = {
    kind: "access",
    agent_id: input.agent_id,
    scope: input.scope,
    iat: now,
    exp: now + (input.ttl_sec ?? ACCESS_TOKEN_TTL_SEC),
    ...(input.pod ? { pod: input.pod } : {}),
  };
  return signClaims(claims);
}

interface MintRefreshInput {
  agent_id: string;
  /**
   * The scope set the resulting refresh token is allowed to mint access
   * tokens for. Must equal the scope grant on the access token minted
   * alongside it at pod-spawn time — they are issued as a pair.
   */
  scope: AgentScope[];
  pod?: string;
  ttl_sec?: number;
}

export function mintAgentRefreshToken(input: MintRefreshInput): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: RefreshClaims = {
    kind: "refresh",
    agent_id: input.agent_id,
    scope: input.scope,
    iat: now,
    exp: now + (input.ttl_sec ?? REFRESH_TOKEN_TTL_SEC),
    ...(input.pod ? { pod: input.pod } : {}),
  };
  return signClaims(claims);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export type VerifyResult<T extends AgentTokenClaims> =
  | { ok: true; claims: T }
  | { ok: false; reason: VerifyFailure };

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_kind"
  | "wrong_agent"
  | "missing_scope";

export interface VerifyAccessOpts {
  /** Required token kind. Defaults to "access". */
  kind?: "access";
  /** If set, claims.agent_id must equal this. */
  expected_agent_id?: string;
  /** If set, claims.scope must include this. */
  required_scope?: AgentScope;
}

export function verifyAgentAccessToken(
  token: string,
  opts: VerifyAccessOpts = {},
): VerifyResult<AccessClaims> {
  const base = verifyAndDecode(token);
  if (!base.ok) return base;
  const claims = base.claims;
  if (claims.kind !== "access") return { ok: false, reason: "wrong_kind" };
  if (opts.expected_agent_id && claims.agent_id !== opts.expected_agent_id) {
    return { ok: false, reason: "wrong_agent" };
  }
  if (opts.required_scope && !claims.scope.includes(opts.required_scope)) {
    return { ok: false, reason: "missing_scope" };
  }
  return { ok: true, claims };
}

export function verifyAgentRefreshToken(
  token: string,
): VerifyResult<RefreshClaims> {
  const base = verifyAndDecode(token);
  if (!base.ok) return base;
  if (base.claims.kind !== "refresh") {
    return { ok: false, reason: "wrong_kind" };
  }
  return { ok: true, claims: base.claims };
}

// ---------------------------------------------------------------------------
// Internals — sign/verify primitive
// ---------------------------------------------------------------------------

function signClaims(claims: AgentTokenClaims): string {
  const payload = b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = hmac(payload);
  return `${payload}.${sig}`;
}

function verifyAndDecode(
  token: string,
): VerifyResult<AgentTokenClaims> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload);
  if (!safeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };

  let raw: unknown;
  try {
    const decoded = Buffer.from(b64urlDecodeToBuffer(payload)).toString("utf8");
    raw = JSON.parse(decoded);
  } catch {
    // Signature passed but the body isn't decodable JSON — should be
    // impossible with our own minter, but treat as malformed defensively.
    return { ok: false, reason: "malformed" };
  }
  // Defense-in-depth: the HMAC gate already restricts callers to
  // signing-key holders, but a malformed (or maliciously-crafted) payload
  // from a key-holder would otherwise slip through TypeScript's compile-time
  // `as AgentTokenClaims` and reach the comparison logic below — where
  // `undefined <= number` is silently `false` (so a missing `exp` would never
  // expire) and `claims.scope.includes(...)` would throw a 500 instead of
  // returning a clean 401. Validate every field we depend on before use.
  const claims = parseClaims(raw);
  if (!claims) return { ok: false, reason: "malformed" };
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

function parseClaims(raw: unknown): AgentTokenClaims | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.agent_id !== "string" || r.agent_id.length === 0) return null;
  if (typeof r.iat !== "number" || !Number.isFinite(r.iat)) return null;
  if (typeof r.exp !== "number" || !Number.isFinite(r.exp)) return null;
  if (r.pod !== undefined && typeof r.pod !== "string") return null;
  if (
    !Array.isArray(r.scope) ||
    !r.scope.every((s) => typeof s === "string")
  ) {
    return null;
  }
  const scope = r.scope as AgentScope[];
  if (r.kind === "access") {
    return {
      kind: "access",
      agent_id: r.agent_id,
      iat: r.iat,
      exp: r.exp,
      scope,
      ...(r.pod !== undefined ? { pod: r.pod as string } : {}),
    };
  }
  if (r.kind === "refresh") {
    return {
      kind: "refresh",
      agent_id: r.agent_id,
      iat: r.iat,
      exp: r.exp,
      scope,
      ...(r.pod !== undefined ? { pod: r.pod as string } : {}),
    };
  }
  return null;
}

function hmac(payload: string): string {
  const key = env.HARNESS_TOKEN_SIGNING_KEY;
  return b64urlEncode(
    createHmac("sha256", key).update(payload).digest(),
  );
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// base64url helpers (no `=` padding, `+`/`/` → `-`/`_`)
// ---------------------------------------------------------------------------

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecodeToBuffer(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  // Buffer.from is lenient about missing padding in base64 mode.
  return Buffer.from(padded, "base64");
}
