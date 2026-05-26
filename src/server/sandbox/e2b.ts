import { Sandbox } from "e2b";

import { env } from "@/server/env";
import { decrypt } from "@/server/integrations/core/crypto";
import { deriveStub } from "./deriveStub";
import { SandboxProvider, type ProvisionParams } from "./provider";

async function readEnvMap(sandbox: Sandbox): Promise<Record<string, string>> {
  try {
    const content = await (sandbox as unknown as { files: { read: (p: string) => Promise<string> } }).files.read("/tmp/lap_env");
    return Object.fromEntries(
      content.split("\n").map((l: string) => l.trim()).filter((l: string) => l.includes("=")).map((l: string) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
  } catch {
    return {};
  }
}

export class E2bProvider extends SandboxProvider {
  readonly urlScheme = "e2b";

  constructor(
    private readonly apiKey: string,
    private readonly template: string,
  ) {
    super();
  }

  async create(params: ProvisionParams): Promise<{ id: string; envMap: Record<string, string> }> {
    const raw =
      params.agent.env_vars &&
      typeof params.agent.env_vars === "object" &&
      !Array.isArray(params.agent.env_vars)
        ? (params.agent.env_vars as Record<string, string>)
        : {};

    // Build stub env: each agent secret becomes stub_<agentId>_<keyName>.
    // The cloud-vault derives the same stubs independently from the DB,
    // so no registration call is needed — stubs are deterministic.
    const stubEnv: Record<string, string> = {};
    for (const [key, encryptedVal] of Object.entries(raw)) {
      try {
        // Decrypt just to verify the value exists and is readable.
        // The stub (not the real value) is what goes into the sandbox.
        decrypt(encryptedVal);
        stubEnv[key] = deriveStub(params.agent.agent_id, key);
      } catch {
        // Skip keys that can't be decrypted (ENCRYPTION_KEY mismatch in dev).
      }
    }
    // Platform key — always injected, keyed off the "platform" sentinel.
    stubEnv["LITELLM_API_KEY"] = deriveStub("platform", "LITELLM_API_KEY");

    // Proxy config — only injected when cloud-vault is configured.
    // Embed token in URL so curl, Python requests, Node.js, etc. all
    // automatically send Proxy-Authorization: Basic base64(x:<token>).
    const proxyEnv: Record<string, string> = {};
    if (env.VAULT_URL && env.VAULT_PROXY_TOKEN) {
      const parsed = new URL(env.VAULT_URL);
      parsed.username = "x";
      parsed.password = env.VAULT_PROXY_TOKEN;
      const proxyWithAuth = parsed.toString();
      proxyEnv["HTTPS_PROXY"] = proxyWithAuth;
      proxyEnv["HTTP_PROXY"] = proxyWithAuth;
    } else if (env.VAULT_URL) {
      proxyEnv["HTTPS_PROXY"] = env.VAULT_URL;
      proxyEnv["HTTP_PROXY"] = env.VAULT_URL;
    }

    // If vault CA cert is configured, point SSL tools at a combined bundle
    // that we'll write after sandbox creation. E2B strips Dockerfile ENV vars
    // at runtime, so we set these at Sandbox.create() time instead.
    const vaultCaEnv: Record<string, string> = {};
    if (env.VAULT_CA_CRT && env.VAULT_URL) {
      vaultCaEnv["GIT_SSL_CAINFO"] = "/tmp/vault-ca.crt";
      vaultCaEnv["CURL_CA_BUNDLE"] = "/tmp/vault-ca.crt";
      vaultCaEnv["NODE_EXTRA_CA_CERTS"] = "/tmp/vault-ca.crt";
      vaultCaEnv["SSL_CERT_FILE"] = "/tmp/vault-ca.crt";
    }

    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      timeoutMs: 60 * 60 * 1000, // E2B max is 1 hour; keepalive on execute resets it
      envs: { ...stubEnv, ...proxyEnv, ...vaultCaEnv },
    });

    // Write combined CA bundle (system + vault CA) so git/curl/node trust vault's MITM certs
    if (env.VAULT_CA_CRT && env.VAULT_URL) {
      try {
        const caCrt = env.VAULT_CA_CRT.replace(/\\n/g, "\n");
        await (sandbox as unknown as { files: { write: (p: string, c: string) => Promise<void> } }).files.write("/tmp/vault-ca.crt", caCrt);
        // Prepend system CA bundle so all existing certs still work
        await sandbox.commands.run(
          "cat /etc/ssl/certs/ca-certificates.crt /tmp/vault-ca.crt > /tmp/combined-ca.crt && mv /tmp/combined-ca.crt /tmp/vault-ca.crt",
          { timeoutMs: 10000 },
        );
      } catch {
        // Non-fatal — sandbox still works, just TLS verify may fail for vault-proxied requests
      }
    }

    // Run setup.sh if the agent has one in sandbox_files
    const sandboxFiles = Array.isArray(params.agent.sandbox_files)
      ? (params.agent.sandbox_files as Array<{ name: string; content: string }>)
      : [];
    const setupEntry = sandboxFiles.find((f) => f.name === "setup.sh");
    let envMap: Record<string, string> = {};
    if (setupEntry) {
      try {
        const script = Buffer.from(setupEntry.content, "base64").toString("utf-8");
        await (sandbox as unknown as { files: { write: (p: string, c: string) => Promise<void> } }).files.write("/lap/setup.sh", script);
        const result = await sandbox.commands.run("bash /lap/setup.sh", { timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
          throw new Error(`setup.sh failed (exit ${result.exitCode}): ${result.stderr ?? result.stdout ?? "(no output)"}`);
        }
        envMap = await readEnvMap(sandbox);
      } catch (err) {
        await sandbox.kill().catch(() => {});
        throw err;
      }
    }

    return { id: sandbox.sandboxId, envMap };
  }

  async execute(id: string, cmd: string, timeoutMs: number): Promise<string> {
    try {
      const sandbox = await Sandbox.connect(id, { apiKey: this.apiKey });
      const result = await sandbox.commands.run(cmd, { timeoutMs });
      return (result.stdout ?? "") + (result.stderr ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("terminated") || msg.includes("doesn't exist")) {
        return `error: sandbox expired — call provision to create a new one (${msg})`;
      }
      throw err;
    }
  }

  async readFile(id: string, path: string): Promise<string> {
    try {
      const sandbox = await Sandbox.connect(id, { apiKey: this.apiKey });
      // E2B's files.read returns UTF-8 text by default.
      return await sandbox.files.read(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("terminated") || msg.includes("doesn't exist")) {
        return `error: sandbox expired — call provision to create a new one (${msg})`;
      }
      throw err;
    }
  }

  async terminate(id: string): Promise<void> {
    await Sandbox.kill(id, { apiKey: this.apiKey });
  }
}
