// lap-vault sidecar.
//
// Holds real secrets in process memory. Agent sees only stubs.
// HTTPS CONNECT proxy on 127.0.0.1:14322 that MITMs every outbound TLS,
// scans for stubs in request headers + text-y bodies, swaps stub → real,
// forwards to the actual upstream.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

import { bootstrapCa, issueLeaf, type CA } from "./ca.js";
import { swap, isTextLike } from "./intercept.js";

const SHARED_DIR = process.env.LAP_SHARED_DIR ?? "/lap-shared";
const PROXY_PORT = Number(process.env.LAP_VAULT_PORT ?? 14322);

interface SecretEntry {
  realKey: string;   // original env var name (e.g. GITHUB_TOKEN)
  stub: string;      // stub_github_token_a7f3
  real: string;      // actual secret
}

function mintStub(realKey: string): string {
  const ns = realKey.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const rand = randomBytes(4).toString("hex");
  return `stub_${ns}_${rand}`;
}

async function loadSecrets(): Promise<Map<string, string>> {
  const kv = new Map<string, string>();
  const stubLines: string[] = [];
  const entries: SecretEntry[] = [];

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith("REAL_")) continue;
    if (!envVal) continue;
    const realKey = envKey.slice("REAL_".length);
    const stub = mintStub(realKey);
    kv.set(stub, envVal);
    entries.push({ realKey, stub, real: envVal });
    stubLines.push(`${realKey}=${stub}`);
  }

  await fs.mkdir(SHARED_DIR, { recursive: true });
  await fs.writeFile(`${SHARED_DIR}/env`, stubLines.join("\n") + "\n", { mode: 0o644 });
  console.log(
    `[lap-vault] loaded ${entries.length} secret(s): ${entries.map((e) => e.realKey).join(", ")}`,
  );
  return kv;
}

async function startConnectProxy(ca: CA, kv: Map<string, string>) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", stubs: kv.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // CONNECT — the load-bearing path. TLS MITM, swap, forward.
  server.on("connect", async (req: http.IncomingMessage, clientSocket: net.Socket) => {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr) || 443;

    clientSocket.on("error", (e) => console.warn(`[lap-vault] client socket: ${e.message}`));
    clientSocket.write("HTTP/1.1 200 Connection established\r\nProxy-Agent: lap-vault\r\n\r\n");

    let leaf;
    try {
      leaf = await issueLeaf(ca, host);
    } catch (e) {
      console.warn(`[lap-vault] leaf issue failed for ${host}: ${(e as Error).message}`);
      clientSocket.destroy();
      return;
    }

    const agentTls = new tls.TLSSocket(clientSocket, {
      isServer: true,
      cert: leaf.cert,
      key: leaf.key,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    agentTls.on("error", (e) => console.warn(`[lap-vault] agent tls ${host}: ${e.message}`));

    // Re-parse HTTP request out of the decrypted TLS socket.
    const inner = http.createServer();
    inner.on("request", async (agentReq, agentRes) => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of agentReq) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);

        // Swap headers
        const headersOut: Record<string, string> = {};
        const usedAll: string[] = [];
        for (const [k, v] of Object.entries(agentReq.headers)) {
          if (v === undefined) continue;
          const val = Array.isArray(v) ? v.join(", ") : v;
          const r = swap(val, kv);
          usedAll.push(...r.used);
          headersOut[k] = r.out;
        }
        // Drop hop-by-hop / proxy headers
        delete headersOut["proxy-connection"];
        delete headersOut["proxy-authorization"];
        // Force correct host
        headersOut["host"] = host + (port !== 443 ? `:${port}` : "");
        // Drop content-length; we'll set it after body swap
        delete headersOut["content-length"];

        // Swap body if text-y
        const ctype = String(agentReq.headers["content-type"] ?? "");
        let bodyOut = body;
        if (isTextLike(ctype) && body.length > 0) {
          const r = swap(body.toString("utf8"), kv);
          usedAll.push(...r.used);
          bodyOut = Buffer.from(r.out);
        }
        if (bodyOut.length > 0) {
          headersOut["content-length"] = String(bodyOut.length);
        }

        if (usedAll.length) {
          const uniq = [...new Set(usedAll)];
          console.log(
            `[lap-vault] ${agentReq.method} ${host}${agentReq.url} swapped ${uniq.length} stub(s): ${uniq.join(", ")}`,
          );
        }

        const upstreamReq = https.request(
          {
            host,
            port,
            method: agentReq.method,
            path: agentReq.url,
            headers: headersOut,
            servername: host,
          },
          (upstreamRes) => {
            agentRes.writeHead(
              upstreamRes.statusCode ?? 502,
              upstreamRes.statusMessage,
              upstreamRes.headers,
            );
            upstreamRes.pipe(agentRes);
          },
        );
        upstreamReq.on("error", (e) => {
          console.warn(`[lap-vault] upstream ${host}: ${e.message}`);
          try {
            agentRes.writeHead(502);
            agentRes.end(`lap-vault upstream error: ${e.message}`);
          } catch { /* socket already gone */ }
        });
        if (bodyOut.length > 0) upstreamReq.write(bodyOut);
        upstreamReq.end();
      } catch (e) {
        console.warn(`[lap-vault] inner handler ${host}: ${(e as Error).message}`);
        try { agentRes.writeHead(500); agentRes.end(); } catch { /* */ }
      }
    });
    inner.emit("connection", agentTls);
  });

  server.listen(PROXY_PORT, "127.0.0.1", () => {
    console.log(`[lap-vault] listening on 127.0.0.1:${PROXY_PORT}`);
  });
}

async function main() {
  console.log("[lap-vault] starting");
  const kv = await loadSecrets();
  const ca = await bootstrapCa(SHARED_DIR);
  console.log(`[lap-vault] CA written to ${SHARED_DIR}/ca.crt`);
  await startConnectProxy(ca, kv);
}

main().catch((e) => {
  console.error("[lap-vault] fatal:", e);
  process.exit(1);
});
