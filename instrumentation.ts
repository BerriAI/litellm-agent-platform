/**
 * Next.js instrumentation hook — runs once at server startup in the Node.js
 * runtime before any routes are served.
 *
 * When CLAUDE_CODE_INLINE_URL is unset (typically local dev) and we are NOT
 * in production, this module auto-spawns the claude-agent-sdk harness on a
 * free port and writes the URL back into process.env so the brain-inline
 * session route finds it without any manual setup.
 *
 * In production / EKS you always set CLAUDE_CODE_INLINE_URL to point at the
 * shared harness Deployment — this module is a no-op in that case.
 */

export async function register() {
  // Only run in the Node.js server runtime, never on the Edge.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Already configured — nothing to do.
  if (process.env.CLAUDE_CODE_INLINE_URL) return;
  // Skip in production; operators set the env var explicitly there.
  if (process.env.NODE_ENV === "production") return;

  // Dynamic import — Turbopack emits a [browser] warning at build time because
  // this module uses node: builtins, but the NEXT_RUNTIME guard above ensures
  // it never actually runs outside Node.js.
  const { spawnInlineHarness } = await import("./src/server/inlineHarnessSpawner");
  await spawnInlineHarness();
}
