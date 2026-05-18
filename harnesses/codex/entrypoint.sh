#!/usr/bin/env bash
# Codex (OpenAI) TUI harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
set -euo pipefail

. /opt/lap/common.sh

# Pre-create ~/.codex/auth.json so the codex TUI skips the "Sign in with
# ChatGPT / Device Code / Provide API key" welcome screen on first launch.
# Codex looks up its api key from this file before falling back to
# OPENAI_API_KEY env, and even when OPENAI_API_KEY is set the TUI shows the
# sign-in chooser unless auth.json exists with auth_mode=apikey. Mirroring
# the file shape codex writes after the user picks option 3 interactively.
# The stub key from vault (/lap-shared/env) is what we write; vault swaps
# it for the real key at egress.
if [ -n "${LITELLM_API_KEY:-}" ]; then
  mkdir -p "$HOME/.codex"
  cat > "$HOME/.codex/auth.json" <<EOF
{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "$LITELLM_API_KEY"
}
EOF
  chmod 600 "$HOME/.codex/auth.json"
  # Also trust the workspace, dismiss the model NUX, AND route the model
  # client through the LiteLLM gateway via `wire_api = "chat"`. Without a
  # [model_providers.litellm] block, codex defaults to wire_api =
  # "responses", which hardcodes wss://api.openai.com/v1/responses and
  # IGNORES OPENAI_BASE_URL — every chat blows up with a 401 against the
  # real OpenAI endpoint using the (rejected) LiteLLM key. `wire_api =
  # "chat"` makes codex use OpenAI Chat Completions over plain HTTP,
  # which LiteLLM speaks. `model_provider = "litellm"` selects this
  # provider as default; the agent's model string (e.g. "openai/gpt-5.5")
  # passes through unchanged to LiteLLM's router.
  if [ -n "${LITELLM_API_BASE:-}" ]; then
    cat > "$HOME/.codex/config.toml" <<EOF
model_provider = "litellm"

[projects."$REPO_DIR"]
trust_level = "trusted"

[tui.model_availability_nux]
"gpt-5.5" = 1

[model_providers.litellm]
name = "LiteLLM Gateway"
base_url = "${LITELLM_API_BASE%/}/v1"
wire_api = "chat"
env_key = "OPENAI_API_KEY"
EOF
  else
    cat > "$HOME/.codex/config.toml" <<EOF
[projects."$REPO_DIR"]
trust_level = "trusted"

[tui.model_availability_nux]
"gpt-5.5" = 1
EOF
  fi
  chmod 600 "$HOME/.codex/config.toml"
fi

# Hydrate attached skills as ~/.claude/skills/<slug>/SKILL.md when present.
# Codex doesn't read this directory natively today, but we materialize the
# files anyway so the user can `cat` / reference them inside the TUI, and so
# any future skill consumer here picks them up. Empty/unset = no-op.
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
