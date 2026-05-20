import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ ok: true });
});

app.post("/execute", async (c) => {
  const { cmd } = await c.req.json<{ cmd: string }>();
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
