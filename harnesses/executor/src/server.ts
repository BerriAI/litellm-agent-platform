import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { exec } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const EXECUTOR_SECRET = process.env.EXECUTOR_SECRET ?? "";

/**
 * Constant-time comparison to prevent timing-oracle attacks on the secret.
 * Returns true when the provided token matches EXECUTOR_SECRET (or when no
 * secret is configured, so local dev without K8s works out of the box).
 */
function checkSecret(token: string | undefined): boolean {
  if (!EXECUTOR_SECRET) return true; // no secret configured — open for local dev
  if (!token) return false;
  try {
    const a = Buffer.from(EXECUTOR_SECRET);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ ok: true });
});

// Block commands that attempt to unset or clear the vault proxy env vars.
const PROXY_TAMPER_RE = /unset\s+(https?_proxy|HTTPS?_PROXY)\b/i;

function rejectsProxyTamper(cmd: string): boolean {
  return PROXY_TAMPER_RE.test(cmd);
}

app.post("/execute", async (c) => {
  const token = c.req.header("x-executor-secret");
  if (!checkSecret(token)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const { cmd } = await c.req.json<{ cmd: string }>();

  if (rejectsProxyTamper(cmd)) {
    return c.json({ error: "command blocked: proxy env vars cannot be unset" }, 403);
  }

  const cwd = process.env.REPO_DIR ?? undefined;

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 300_000, cwd });
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return c.json({ output, exit_code: 0 });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const output = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean).join("\n");
    return c.json({ output, exit_code: e.code ?? 1 });
  }
});

const port = parseInt(process.env.PORT ?? "4096", 10);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`executor harness listening on http://0.0.0.0:${port}`);
});
