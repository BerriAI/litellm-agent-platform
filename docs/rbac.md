# RBAC

Two roles: **admin** and **internal_user**. Every API route requires one of them.

## Roles

| Role | Token | Can do |
|---|---|---|
| `admin` | `MASTER_KEY` | Full access — agents, sessions, sandbox templates |
| `internal_user` | `INTERNAL_USER_PASSWORD` | Agents + sessions only — cannot create or read sandbox templates |

## Configuring an internal user

Set two env vars on the platform:

```bash
INTERNAL_USER_USERNAME=alice
INTERNAL_USER_PASSWORD=<strong-secret>
```

If these are unset, only the admin role exists. The login page shows a "User" tab only when `INTERNAL_USER_USERNAME` is configured.

## Getting a token (internal user)

```bash
POST /api/ui/auth/internal-user
Content-Type: application/json

{ "username": "alice", "password": "<INTERNAL_USER_PASSWORD>" }
```

Response:

```json
{ "token": "<INTERNAL_USER_PASSWORD>" }
```

Use the token as `Authorization: Bearer <token>` on subsequent requests.

## What internal users cannot do

Sandbox template routes (`/api/v1/templates/*`) require admin. Internal users receive `403 Forbidden`:

```bash
# Returns 403 for internal_user role
GET /api/v1/templates
Authorization: Bearer <INTERNAL_USER_PASSWORD>
```

All other managed-agent routes — create agent, create session, send message, stop session — work for both roles.

## Sandbox templates (admin only)

Templates let an admin pre-define a repo URL and environment variable keys. Internal users who create agents can see the key names but never the values.

```bash
# Admin creates template
POST /api/v1/templates
Authorization: Bearer $MASTER_KEY

{
  "name": "security-scanner",
  "repo_url": "https://github.com/org/repo",
  "env_vars": { "SNYK_TOKEN": "<value>", "GITHUB_TOKEN": "<value>" }
}

# Internal user creates agent — sees key names, not values
POST /api/v1/managed_agents/agents
Authorization: Bearer <INTERNAL_USER_PASSWORD>

{ "name": "my-scanner", "template_id": "<template_id>", ... }
```
