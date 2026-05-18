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
if [ -n "${GEMINI_SELFTEST_PROMPT:-}" ]; then
  echo "[selftest] env probe:"
  echo "  GOOGLE_GENAI_USE_VERTEXAI=${GOOGLE_GENAI_USE_VERTEXAI:-<unset>}"
  echo "  GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-<unset>}"
  echo "  GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-<unset>}"
  echo "  GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS:-<unset>}"
  echo "  GEMINI_API_KEY=${GEMINI_API_KEY:+<set>}${GEMINI_API_KEY:-<unset>}"
  echo "  ls /work/repo:"
  ls -la /work/repo 2>&1 | head -5
  echo "  /lap-shared/env contents (keys only):"
  sed 's/=.*$/=<value>/' /lap-shared/env 2>/dev/null | head -10
  echo "[selftest] running: gemini -p ..."
  echo "[selftest-begin]"
  gemini -p "$GEMINI_SELFTEST_PROMPT" 2>&1 || echo "[selftest] gemini exited non-zero"
  echo "[selftest-end]"
fi

exec node /app/server.js
