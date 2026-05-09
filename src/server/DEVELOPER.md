# Developer Usage

End-to-end: create an agent, open a session, send a message, read the reply. Single-tenant Bearer auth — `MASTER_KEY` from `.env`.

```bash
export BASE=http://localhost:3000
export KEY=$MASTER_KEY
```

## 1. Create an agent

```bash
curl -s $BASE/api/v1/managed_agents/agents \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "code-reviewer",
    "model": "anthropic/claude-opus-4-7",
    "prompt": "You review pull requests.",
    "repo_url": "https://github.com/BerriAI/litellm",
    "branch": "main"
  }'
```

Returns the new agent. Save `id` as `AGENT_ID`.

## 2. Create a session

Boots a sandbox pod and the harness inside it. Cold start ~10s on k8s; sub-2s when a warm pool slot is available.

```bash
curl -s $BASE/api/v1/managed_agents/agents/$AGENT_ID/session \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "title": "review #1234",
    "initial_prompt": "Look at the diff in the latest PR."
  }'
```

Returns the new session. Save `id` as `SESSION_ID`. The agent's reply to `initial_prompt` is in `response`.

`initial_prompt` is optional — omit it to bring up the sandbox without sending anything.

### Per-session env vars

Pass `env_vars` to inject short-lived secrets into the harness shell at task-launch time — useful for agents that need to authenticate to GitHub, CircleCI, or other services from inside the sandbox.

```bash
curl -s $BASE/api/v1/managed_agents/agents/$AGENT_ID/session \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "title": "fix issue #1234",
    "env_vars": {
      "GITHUB_TOKEN": "ghp_...",
      "CIRCLECI_TOKEN": "cci_..."
    }
  }'
```

`env_vars` is `Record<string, string>`. Values are passed verbatim into the sandbox pod's container env at Sandbox-CR-create time. They are **never persisted** to the database and **never logged** by value — keep this contract intact in any future logging you add.

Constraints (each is a 400 from zod):

- key names match `^[A-Za-z_][A-Za-z0-9_]*$`
- max 50 keys
- total JSON-encoded size ≤ 16 KB
- keys cannot intersect the reserved set:
  `REPO_URL`, `BRANCH`, `LITELLM_API_KEY`, `LITELLM_API_BASE`, `LITELLM_DEFAULT_MODEL`, `AGENT_PROMPT`, `PORT`, `GIT_TOKEN`

`GIT_TOKEN` is reserved because the entrypoint uses it for clone-and-wipe (the token is erased after `git clone` so the LLM can't read it back). For tokens that need to survive into the agent shell — e.g. for `gh pr create` or `git push` — pass `GITHUB_TOKEN` or `GH_TOKEN` instead.

## 3. Send a message

```bash
curl -s $BASE/api/v1/managed_agents/sessions/$SESSION_ID/message \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{ "text": "Summarize the largest file changed." }'
```

Response body is the harness reply, synchronous. The message is appended to the session's history.

## 4. Read session state

```bash
curl -s $BASE/api/v1/managed_agents/sessions/$SESSION_ID \
  -H "authorization: Bearer $KEY"
```

Returns metadata plus the latest `response` blob.

## Cleanup

```bash
curl -X DELETE -s $BASE/api/v1/managed_agents/sessions/$SESSION_ID \
  -H "authorization: Bearer $KEY"
```

Deletes the Sandbox CR and marks the session `dead`. Idempotent.
