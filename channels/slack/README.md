# Slack channel

Lets you @mention a LAP agent in Slack, or DM it, and get a reply in-thread.

The whole thing rides on LAP's existing `integrations/` framework — Slack is just another provider next to Linear. No new tables. The conversation map lives in `IntegrationSession` keyed on `slack:{team_id}:{channel_id}[:{thread_ts}]`.

## How a message flows

```
Slack @mention / DM
  └─ POST /api/integrations/webhooks/slack
       ├─ url_verification → 200 with echoed challenge
       └─ event_callback → handleInbound("slack", req)
            ├─ verify signing secret (HMAC v0)
            ├─ parse → { kind: "message", external_session_id, prompt }
            └─ handleMessage()
                 ├─ IntegrationSession exists + ready + < 24h?
                 │    yes → POST /sessions/{id}/message → forward reply
                 │    no  → POST /agents/{OPENCLAW}/session
                 │            └─ poll Session.response → forward reply
                 └─ provider.onSessionEvent(response)
                      └─ chat.postMessage in the same thread
```

## One-time Slack setup (via the LAP web UI)

1. **Set three env vars on the LAP server** and restart it:
   - `SLACK_CLIENT_ID`
   - `SLACK_CLIENT_SECRET`
   - `SLACK_SIGNING_SECRET`

   You'll grab these from <https://api.slack.com/apps> after creating the app in step 3, then come back and set them. The integration is gated by `enabled()` checking all three.

2. **Open the agent page** at `/agents/<your-agent-id>` and scroll to the **Channels** section. Click **Set up** next to Slack — a four-step wizard takes over from here.

3. **Wizard step 1 (server check)**: confirms the three env vars are present.

4. **Wizard step 2 (manifest)**: shows the Slack app manifest with your LAP hostname already substituted into both URLs. Copy it, paste into <https://api.slack.com/apps> → **Create New App → From a manifest**. Submit, then click **Install to Workspace**.

5. **Wizard step 3 (install)**: click **Open OAuth flow**. The dialog polls every two seconds and advances automatically once the install lands.

6. **Wizard step 4 (bind)**: click **Connect to this agent**. Done.

7. **Smoke-test.** In Slack, DM the bot. Within ~30s you should see a reply in-thread.

## Local development

Slack must reach your dev box on HTTPS. Easiest path:

```bash
# Terminal 1: LAP web
docker compose up

# Terminal 2: ngrok tunnel to :3000
ngrok http 3000
```

Take the `https://<random>.ngrok.app` URL ngrok prints and paste it into the manifest (replacing `REPLACE_WITH_YOUR_HOSTNAME`). Repeat any time ngrok rotates the subdomain.

## What this v1 includes (and what it doesn't)

In:

- DMs (`message` events with `channel_type=im`) and @mentions (`app_mention`).
- DM conversations collapse into one LAP session per DM channel (24h TTL).
- Channel @mentions create one LAP session per thread (24h TTL).
- Self-echo dedup via `bot_user_id` stored in `IntegrationInstall.metadata`.
- HMAC-SHA256 signing-secret verify + 5-min replay window.

Out (deferred):

- Feedback CTAs / "save this as a skill" flows.
- Slash commands (`/feedback`, etc.).
- Streaming token-by-token replies — currently posts one message when the agent finishes.
- Per-workspace settings UI for selecting which agent answers (still SQL-bound).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slack says "Your URL didn't respond with the value of the `challenge` parameter" | LAP isn't reachable on the URL you pasted, OR `SLACK_SIGNING_SECRET` isn't set so `enabled()` returns false → 404 |
| `401 bad signature` in logs | `SLACK_SIGNING_SECRET` doesn't match the value in Slack app Basic Information |
| `404 install not found` in logs | OAuth callback hasn't run yet; complete step 3 |
| `404 no agent bound to this install` | Skip step 4 — insert the `agent_integration_binding` row |
| Slack message arrives, no reply | Check Render/docker logs for `[integrations/dispatcher]` errors; the response polling has a 5min cap |
