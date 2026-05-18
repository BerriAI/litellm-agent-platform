#!/usr/bin/env bash
# Gemini (Google) TUI harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
set -euo pipefail

. /opt/lap/common.sh

# Hydrate attached skills as ~/.gemini/skills/<slug>/SKILL.md so any future
# skill consumer here picks them up. Gemini CLI doesn't read this directory
# natively today; we materialize the files anyway so the user can reference
# them inside the TUI. Empty/unset = no-op. Failure non-fatal.
if [ -n "${SKILLS_JSON:-}" ]; then
  mkdir -p "$HOME/.gemini/skills"
  printf '%s' "$SKILLS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const skills = JSON.parse(raw);
        const fs = require("fs"), path = require("path");
        const root = path.join(process.env.HOME, ".gemini", "skills");
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

# Optional self-test: when GEMINI_SELFTEST_PROMPT is set, run a one-shot
# non-interactive gemini call with `-p` so the model reply lands in this
# container's stdout (and therefore in pod logs / the platform's
# /sessions/<id>/diagnose endpoint). Lets you prove the harness's
# credential + routing produce a real model reply WITHOUT needing the WS
# /tty proxy (useful as a smoke test on a regressed proxy). Non-fatal on
# failure — TUI flow still starts below.
# Vertex AI auto-config. Vault stubs every agent.env_var value, so any
# config that the CLI reads locally (booleans, paths) is opaque garbage
# inside the container — vault only swaps stubs at the HTTPS wire, not
# at local file reads. So pulling Vertex settings out of agent.env_vars
# doesn't work.
#
# Instead: when a service-account JSON is present at /work/repo/key.json
# (cloned in via REPO_URL), auto-derive everything the gemini CLI needs
# from the JSON itself + safe defaults. Real values, not vault stubs.
SA_JSON_PATH="/work/repo/key.json"
if [ -f "$SA_JSON_PATH" ] && grep -q '"private_key"' "$SA_JSON_PATH" 2>/dev/null; then
  export GOOGLE_APPLICATION_CREDENTIALS="$SA_JSON_PATH"
  export GOOGLE_GENAI_USE_VERTEXAI=true
  _proj=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$SA_JSON_PATH','utf8')).project_id||'')}catch(e){}")
  [ -n "$_proj" ] && export GOOGLE_CLOUD_PROJECT="$_proj"
  # If GOOGLE_CLOUD_LOCATION was stubbed by vault or never set, default to us-central1.
  case "${GOOGLE_CLOUD_LOCATION:-}" in
    stub_*|"") export GOOGLE_CLOUD_LOCATION=us-central1 ;;
  esac
  # Skip the gemini-cli trust dialog in non-interactive contexts. The pod
  # itself is the trust boundary; without this the CLI bails with
  # "not running in a trusted directory". Real value, not vault-stubbed.
  export GEMINI_CLI_TRUST_WORKSPACE=true
  # Bypass vault for gemini. The CLI's bundled HttpsProxyAgent import is
  # broken ("TypeError: HttpsProxyAgent is not a constructor") when
  # HTTPS_PROXY is set, so every model call dies before reaching Google.
  # In Vertex mode we have a real SA on disk and the CLI mints real OAuth
  # bearer tokens locally — vault's stub-swap adds nothing here. Send
  # gemini's egress direct.
  unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy
  echo "[entrypoint] vertex auto-config: project=$GOOGLE_CLOUD_PROJECT location=$GOOGLE_CLOUD_LOCATION trust=true (proxy bypassed)"
fi

# When GEMINI_SELFTEST_PROMPT is set (any value — vault stubs the content but
# its presence as a key is what matters), run a non-interactive `gemini -p`
# with a fixed prompt so the model reply lands in pod stdout. Provable via
# /api/v1/managed_agents/sessions/<id>/diagnose.pod_logs_tail.
if [ -n "${GEMINI_SELFTEST_PROMPT:-}" ]; then
  # Hardcoded prompt: agent.env_var values pass through vault stub-substitution
  # so the real user-supplied prompt isn't readable inside the container.
  # For the smoke-test path the prompt content doesn't carry information —
  # only that the CLI produces *a* model reply. Use a deterministic prompt
  # so the validator can grep for an exact substring in the reply.
  _prompt="Reply with exactly four words: hello from gemini cli"
  echo "[selftest] env probe:"
  echo "  GOOGLE_GENAI_USE_VERTEXAI=${GOOGLE_GENAI_USE_VERTEXAI:-<unset>}"
  echo "  GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-<unset>}"
  echo "  GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-<unset>}"
  echo "  GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS:-<unset>}"
  echo "  GEMINI_CLI_TRUST_WORKSPACE=${GEMINI_CLI_TRUST_WORKSPACE:-<unset>}"
  echo "[selftest] running: gemini -p \"$_prompt\""
  echo "[selftest-begin]"
  gemini -p "$_prompt" 2>&1 || echo "[selftest] gemini exited non-zero"
  echo "[selftest-end]"
fi

exec node /app/server.js
