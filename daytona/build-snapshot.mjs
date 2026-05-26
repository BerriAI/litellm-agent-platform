#!/usr/bin/env node
/**
 * Build the LiteLLM Daytona snapshot from daytona/daytona.Dockerfile.
 *
 * Daytona equivalent of `e2b template build`. Run once (or whenever the
 * Dockerfile changes); set DAYTONA_SNAPSHOT=<name> on the LAP platform after.
 *
 *   DAYTONA_API_KEY=<key> node daytona/build-snapshot.mjs
 *
 * Optional env:
 *   DAYTONA_API_URL=...        (default: provider default)
 *   DAYTONA_SNAPSHOT_NAME=...  (default: litellm-8gb)
 *   DAYTONA_MEMORY_GB=8        (default: 8)
 *   DAYTONA_CPU=2              (default: 2)
 *   DAYTONA_DISK_GB=10         (default: 10 — Daytona's default per-sandbox cap)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Daytona, Image } from "@daytona/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = path.join(__dirname, "daytona.Dockerfile");

const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) {
  console.error("DAYTONA_API_KEY not set");
  process.exit(1);
}

const name = process.env.DAYTONA_SNAPSHOT_NAME || "litellm-8gb";
const memory = Number(process.env.DAYTONA_MEMORY_GB || 8);
const cpu = Number(process.env.DAYTONA_CPU || 2);
const disk = Number(process.env.DAYTONA_DISK_GB || 10);

const daytona = new Daytona({
  apiKey,
  ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
});

console.error(`[build-snapshot] name=${name}  resources=cpu:${cpu} mem:${memory}GB disk:${disk}GB`);
console.error(`[build-snapshot] dockerfile=${DOCKERFILE}`);

const image = Image.fromDockerfile(DOCKERFILE);

await daytona.snapshot.create(
  { name, image, resources: { cpu, memory, disk } },
  {
    // Stream build logs so a multi-minute apt+pip install isn't a silent wait.
    onLogs: (chunk) => process.stderr.write(chunk),
    // Big builds (proxy deps + postgres init) can run 10-15 min. Allow 30.
    timeout: 1800,
  },
);

console.error(`[build-snapshot] done — set DAYTONA_SNAPSHOT=${name} on the platform`);
