/**
 * Auto-spawns the claude-agent-sdk harness for local dev when
 * CLAUDE_CODE_INLINE_URL is not set.
 *
 * Called once from instrumentation.ts at Next.js startup. The spawned process
 * inherits the platform's env (LITELLM_API_BASE, LITELLM_API_KEY, etc.) so
 * it can reach the LiteLLM gateway without extra config. A shutdown hook
 * terminates it cleanly when the Next.js process exits.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
    srv.on("error", rej);
  });
}

async function waitReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`inline harness at ${url} did not become ready within ${timeoutMs}ms`);
}

export async function spawnInlineHarness(): Promise<void> {
  // Locate the harness dist relative to the Next.js project root.
  const projectRoot = resolve(process.cwd());
  const harnessEntry = join(projectRoot, "harnesses", "claude-agent-sdk", "dist", "server.js");

  if (!existsSync(harnessEntry)) {
    console.warn(
      `[inline-harness] ${harnessEntry} not found — run: ` +
      `cd harnesses/claude-agent-sdk && npm run build`,
    );
    return;
  }

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [harnessEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      // Default REPO_DIR to /tmp for local dev so the harness doesn't fail
      // trying to find /work/repo. Brain-inline sessions don't need the repo
      // on disk — sandboxes are provisioned lazily via the provision() tool.
      REPO_DIR: process.env.REPO_DIR ?? "/tmp",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[harness] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[harness] ${d}`));
  child.on("error", (err) => console.error("[inline-harness] spawn error:", err));
  child.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      console.error(`[inline-harness] exited code=${code} sig=${sig}`);
    }
  });

  // Terminate child cleanly when Next.js exits.
  const cleanup = () => { if (!child.killed) child.kill(); };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    await waitReady(`${url}/`);
  } catch (err) {
    console.error("[inline-harness] failed to become ready:", err);
    child.kill();
    return;
  }

  // Publish the URL so session/route.ts and any other code reading this env
  // var finds it on the first request.
  process.env.CLAUDE_CODE_INLINE_URL = url;
  console.log(`[inline-harness] ready at ${url}`);
}
