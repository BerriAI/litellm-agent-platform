# agent-templates/

File storage for templates defined in [`agent_templates.json`](../agent_templates.json).

When a template in `agent_templates.json` has a `"files"` array, the referenced
files are read from `agent-templates/<id>/<template_path>` at server startup,
base64-encoded, and injected into the sandbox pod as env vars. The harness
entrypoint writes them to `sandbox_path` before starting the agent.

## Structure

```
agent-templates/
  <template-id>/
    <file>        any file referenced by the template's "files" array
```

No `template.json` here — all template metadata lives in `agent_templates.json`.

---

## Publishing changes to a template

Templates use Helm-style integer versioning. When you change a template and want
existing agents to be notified and offered an upgrade, **bump the `version` field**.

### When to bump

Bump `version` when the change is meaningful enough that existing agents should
know about it — broken behaviour, important new capability, significant prompt
improvement. Don't bump for typo fixes or whitespace.

### How to publish

1. **Edit `agent_templates.json`** — change `prompt`, `tools`, `files`, or any
   other field on the template.

2. **Increment `version`** — the integer in the same template object:

   ```json
   {
     "id": "coding-agent",
     "version": 3,
     "prompt": "..."
   }
   ```

3. **Deploy** — template text is read live at session spawn time, so no harness
   image rebuild is needed for `prompt`-only changes. Changes to `files` require
   a redeploy so the new file content is available at server startup.

4. **Agents self-update on next session spawn** — the platform injects the
   current template prompt into `AGENT_PROMPT` automatically. The agent's
   `template_version` counter just determines whether the "update available"
   banner appears in the UI.

### What the user sees

When `agent.template_version < currentTemplate.version`, an amber banner appears
on the agent detail page:

```
A new version of coding-agent is available (v2 → v3).
[View changes]  [Update now]
```

- **View changes** — opens a full overlay showing a Myers LCS diff of the
  prompt text the agent currently has vs the new template prompt.
- **Update now** — bumps `agent.template_version` to the latest and invalidates
  warm tasks so the next session picks up any changed files or env vars.

Agents that are already in sync see nothing — no banner, no noise.

### Version field is required

Every non-sample template in `agent_templates.json` must have a `"version"`
field (integer ≥ 1). New templates start at `1`. The loader defaults to `1` if
the field is absent, but omitting it means drift can never be detected.

---

## Adding a new template

1. Add an entry to `agent_templates.json` with `"version": 1`.
2. If the template needs files, create `agent-templates/<id>/` and add them.
3. If it needs a skill, add `agent-templates/<id>/skill.md` with YAML frontmatter:

   ```markdown
   ---
   name: my-skill-name
   ---
   Skill body here.
   ```

4. Reference it in the template with `"skill_file": "skill.md"`.

## Example (files)

`claude-code-dangerously-allow-permissions/settings.json` is referenced by:

```json
{
  "id": "claude-code-dangerously-allow-permissions",
  "version": 2,
  "files": [
    {
      "template_path": "settings.json",
      "sandbox_path": "~/.claude/settings.json"
    }
  ]
}
```

At pod startup the harness writes the file to `~/.claude/settings.json`
before exec'ing the server. `~` expands to `/root`.
