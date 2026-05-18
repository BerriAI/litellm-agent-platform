#!/usr/bin/env bash
# Claude Agent SDK harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
set -euo pipefail

. /opt/lap/common.sh

: "${LITELLM_DEFAULT_MODEL:?LITELLM_DEFAULT_MODEL required}"

# Hydrate attached skills as ~/.claude/skills/<slug>/SKILL.md so the SDK's
# in-sandbox `claude` binary (and any future file-based skill consumer)
# discovers them on boot. Platform builds SKILLS_JSON in
# src/server/k8s.ts:buildSkillsJsonForAgent. Empty/unset = no-op. Failure
# must not block the harness.
if [ -n "${SKILLS_JSON:-}" ]; then
  mkdir -p "$HOME/.claude/skills"
  printf '%s' "$SKILLS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const skills = JSON.parse(raw);
        const fs = require("fs"), path = require("path");
        const root = path.join(process.env.HOME, ".claude", "skills");
        for (const { slug, content } of skills) {
          if (!slug || typeof content !== "string") continue;
          const dir = path.join(root, slug);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "SKILL.md"), content);
        }
        console.log("[entrypoint] hydrated " + skills.length + " skill(s)");
      } catch (e) {
        console.error("[entrypoint] WARNING: SKILLS_JSON parse failed:", e.message);
      }
    });
  ' || echo "[entrypoint] WARNING: skill hydration failed; continuing"
fi

exec node /opt/harnesses/claude-agent-sdk/dist/server.js
