import { Daytona } from "@daytona/sdk";

import { env } from "@/server/env";
import { decrypt } from "@/server/integrations/core/crypto";
import { deriveStub } from "./deriveStub";
import { SandboxProvider, type ProvisionParams } from "./provider";

export class DaytonaProvider extends SandboxProvider {
  readonly urlScheme = "daytona";

  private readonly daytona: Daytona;

  constructor(
    private readonly apiKey: string,
    apiUrl: string | undefined,
    private readonly snapshot: string | undefined,
    private readonly image: string | undefined,
  ) {
    super();
    this.daytona = new Daytona({
      apiKey,
      ...(apiUrl ? { apiUrl } : {}),
    });
  }

  async create(params: ProvisionParams): Promise<{ id: string; envMap: Record<string, string> }> {
    const raw =
      params.agent.env_vars &&
      typeof params.agent.env_vars === "object" &&
      !Array.isArray(params.agent.env_vars)
        ? (params.agent.env_vars as Record<string, string>)
        : {};

    const stubEnv: Record<string, string> = {};
    for (const [key, encryptedVal] of Object.entries(raw)) {
      try {
        decrypt(encryptedVal);
        stubEnv[key] = deriveStub(params.agent.agent_id, key);
      } catch {
        // Skip keys that can't be decrypted (ENCRYPTION_KEY mismatch in dev).
      }
    }
    stubEnv["LITELLM_API_KEY"] = deriveStub("platform", "LITELLM_API_KEY");

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

    const vaultCaEnv: Record<string, string> = {};
    if (env.VAULT_CA_CRT && env.VAULT_URL) {
      vaultCaEnv["GIT_SSL_CAINFO"] = "/tmp/vault-ca.crt";
      vaultCaEnv["CURL_CA_BUNDLE"] = "/tmp/vault-ca.crt";
      vaultCaEnv["NODE_EXTRA_CA_CERTS"] = "/tmp/vault-ca.crt";
      vaultCaEnv["SSL_CERT_FILE"] = "/tmp/vault-ca.crt";
    }

    const envVars = { ...stubEnv, ...proxyEnv, ...vaultCaEnv };

    // autoStopInterval: 0 disables the 15-min idle kill — critical for long agent runs.
    let sandbox;
    if (this.image) {
      sandbox = await this.daytona.create(
        { image: this.image, envVars, autoStopInterval: 0 },
        { timeout: 120 },
      );
    } else {
      sandbox = await this.daytona.create(
        { snapshot: this.snapshot, envVars, autoStopInterval: 0 },
        { timeout: 120 },
      );
    }

    if (env.VAULT_CA_CRT && env.VAULT_URL) {
      try {
        const caCrt = env.VAULT_CA_CRT.replace(/\\n/g, "\n");
        await sandbox.fs.uploadFile(Buffer.from(caCrt), "/tmp/vault-ca.crt");
        await sandbox.process.executeCommand(
          "cat /etc/ssl/certs/ca-certificates.crt /tmp/vault-ca.crt > /tmp/combined-ca.crt && mv /tmp/combined-ca.crt /tmp/vault-ca.crt",
          undefined,
          undefined,
          10,
        );
      } catch {
        // Non-fatal — sandbox still works, just TLS verify may fail for vault-proxied requests.
      }
    }

    return { id: sandbox.id, envMap: {} };
  }

  async execute(id: string, cmd: string, timeoutMs: number): Promise<string> {
    try {
      const sandbox = await this.daytona.get(id);
      const result = await sandbox.process.executeCommand(
        cmd,
        undefined,
        undefined,
        Math.ceil(timeoutMs / 1000),
      );
      // Daytona's executeCommand exposes stdout only (no separate stderr field).
      // Append exit code on failure so agents can detect command errors.
      const out = result.result ?? "";
      return result.exitCode !== 0 ? `${out}\n[exit code ${result.exitCode}]`.trimStart() : out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("404") ||
        msg.includes("not found") ||
        msg.includes("deleted") ||
        msg.includes("destroyed")
      ) {
        return `error: sandbox expired — call provision to create a new one (${msg})`;
      }
      throw err;
    }
  }

  async readFile(id: string, path: string): Promise<string> {
    try {
      const sandbox = await this.daytona.get(id);
      const buf = await sandbox.fs.downloadFile(path);
      return buf.toString("utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("404") ||
        msg.includes("not found") ||
        msg.includes("deleted") ||
        msg.includes("destroyed")
      ) {
        return `error: sandbox expired — call provision to create a new one (${msg})`;
      }
      throw err;
    }
  }

  async terminate(id: string): Promise<void> {
    try {
      const sandbox = await this.daytona.get(id);
      await this.daytona.delete(sandbox);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("404") ||
        msg.includes("not found") ||
        msg.includes("deleted") ||
        msg.includes("destroyed")
      ) {
        return; // Already gone — nothing to clean up.
      }
      throw err;
    }
  }
}
