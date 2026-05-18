#!/usr/bin/env bash
# Hermes (Nous Research) TUI harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
set -euo pipefail

. /opt/lap/common.sh

# Pre-create hermes config + .env so the TUI lands on a working session
# instead of "No inference provider configured. Run 'hermes model'…".
#
# Hermes' integration docs recommend pointing it at LiteLLM via "Custom
# endpoint" (hermes_cli/providers.py — see resolve_custom_provider and
# the `custom_providers:` config schema). The fields the parser reads:
#   name      — provider id; users reference it via --provider <name>
#               or via config model.provider
#   base_url  — endpoint URL
#   key_env   — env var that holds the API key
#   transport — "openai_chat" (LiteLLM is OpenAI-compatible)
#
# LITELLM_API_KEY in .env is the vault stub sourced from /lap-shared/env
# by common.sh; vault swaps it for the real key at egress, same path as
# claude-code's ANTHROPIC_API_KEY and codex's OPENAI_API_KEY.
if [ -n "${LITELLM_API_BASE:-}" ] && [ -n "${LITELLM_API_KEY:-}" ]; then
  mkdir -p "$HOME/.hermes"
  cat > "$HOME/.hermes/.env" <<ENV
LITELLM_API_KEY=$LITELLM_API_KEY
ENV
  chmod 600 "$HOME/.hermes/.env"

  cat > "$HOME/.hermes/config.yaml" <<YAML
model:
  default: ${LITELLM_DEFAULT_MODEL:-anthropic/claude-haiku-4-5}
  provider: litellm
max_turns: 90
custom_providers:
  - name: litellm
    base_url: ${LITELLM_API_BASE%/}/v1
    key_env: LITELLM_API_KEY
    transport: openai_chat
YAML
  chmod 600 "$HOME/.hermes/config.yaml"
fi

# Hydrate attached skills as ~/.hermes/skills/<slug>/SKILL.md so hermes's
# skill loader picks them up on boot. (Hermes uses ~/.hermes/skills/ — see
# the install layout in the upstream docs. Different from claude-code's
# ~/.claude/skills/.) Empty/unset = no-op. Failure non-fatal.
if [ -n "${SKILLS_JSON:-}" ]; then
  mkdir -p "$HERMES_HOME/skills"
  printf '%s' "$SKILLS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const skills = JSON.parse(raw);
        const fs = require("fs"), path = require("path");
        const root = path.join(process.env.HERMES_HOME, "skills");
        // Whitelist slugs to kebab-case ASCII so a crafted "../" entry
        // cant escape the skills dir via path.join. Mirrors the slug shape
        // produced by slugifySkillName() on the platform side.
        const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
        for (const { slug, content } of skills) {
          if (!slug || typeof content !== "string") continue;
          if (!SLUG_RE.test(slug)) {
            console.error("[entrypoint] WARNING: skipping skill with invalid slug:", JSON.stringify(slug));
            continue;
          }
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

exec node /app/server.js
