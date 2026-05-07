"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  AgentRow,
  ApiError,
  createSession,
  listAgents,
} from "@/lib/api";

const DEFAULT_REPO = "https://github.com/BerriAI/litellm";
const DEFAULT_REF = "main";
const DEFAULT_TIMEOUT = 60;
const DEFAULT_IDLE_TIMEOUT = 10;
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 1440;

const SANDBOX_SIZES = ["small", "medium", "large"] as const;
type SandboxSize = (typeof SANDBOX_SIZES)[number];

function parseEnvVars(raw: string): {
  envVars: Record<string, string>;
  error: string | null;
} {
  const envVars: Record<string, string> = {};
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      return {
        envVars: {},
        error: `Line ${i + 1} is not in KEY=VALUE format: "${line}"`,
      };
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!key) {
      return {
        envVars: {},
        error: `Line ${i + 1} has an empty key.`,
      };
    }
    envVars[key] = value;
  }
  return { envVars, error: null };
}

export default function NewSessionPage() {
  const router = useRouter();

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [agentId, setAgentId] = useState("");
  const [sandboxSize, setSandboxSize] = useState<SandboxSize>("small");
  const [timeout, setTimeoutMin] = useState<string>(String(DEFAULT_TIMEOUT));
  const [idleTimeout, setIdleTimeout] = useState<string>(
    String(DEFAULT_IDLE_TIMEOUT),
  );
  const [repoUrl, setRepoUrl] = useState(DEFAULT_REPO);
  const [startingRef, setStartingRef] = useState(DEFAULT_REF);
  const [envVarsRaw, setEnvVarsRaw] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setAgentsError(null);
    try {
      const res = await listAgents();
      setAgents(res.data);
      if (!agentId && res.data.length > 0) {
        setAgentId(res.data[0].id);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setAgentsError(msg);
    } finally {
      setAgentsLoading(false);
    }
    // We deliberately exclude `agentId` to avoid re-running on selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  function validate(): string | null {
    if (!agentId) return "Agent is required.";

    const t = Number(timeout);
    if (!Number.isFinite(t) || !Number.isInteger(t)) {
      return "Timeout must be an integer.";
    }
    if (t < TIMEOUT_MIN || t > TIMEOUT_MAX) {
      return `Timeout must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} minutes.`;
    }

    const i = Number(idleTimeout);
    if (!Number.isFinite(i) || !Number.isInteger(i)) {
      return "Idle timeout must be an integer.";
    }
    if (i < TIMEOUT_MIN || i > TIMEOUT_MAX) {
      return `Idle timeout must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} minutes.`;
    }
    if (i > t) {
      return "Idle timeout must be less than or equal to the timeout.";
    }

    if (!repoUrl.trim()) return "Repo URL is required.";
    if (!startingRef.trim()) return "Starting ref is required.";

    return null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const { envVars, error: envError } = parseEnvVars(envVarsRaw);
    if (envError) {
      setError(`Env vars: ${envError}`);
      return;
    }

    setSubmitting(true);
    try {
      const created = await createSession({
        agent_id: agentId,
        sandbox: {
          type: "opencode",
          size: sandboxSize,
          timeout_minutes: Number(timeout),
          idle_timeout_minutes: Number(idleTimeout),
        },
        repos: [
          {
            url: repoUrl.trim(),
            starting_ref: startingRef.trim(),
          },
        ],
        ...(Object.keys(envVars).length > 0 ? { env_vars: envVars } : {}),
      });
      router.push(`/sessions/${created.id}`);
    } catch (err) {
      let msg = err instanceof ApiError ? err.message : (err as Error).message;
      if (err instanceof ApiError && err.status === 405) {
        msg =
          "POST /v2/sessions isn't implemented on this proxy yet. Wait for the sandbox-provisioning endpoint or set LITELLM_PRESET_SESSION_ID for testing.";
      }
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div>
        <Link
          href="/sessions"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to sessions
        </Link>
      </div>

      <div className="mt-6">
        <h1 className="text-[22px] font-semibold tracking-tight">
          New Session
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick an agent and provision a sandbox to start running it on a repo.
        </p>
      </div>

      <Card className="mt-6">
        <CardHeader className="sr-only">
          <CardTitle>New Session</CardTitle>
          <CardDescription>
            Pick an agent and provision a sandbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="agent">Agent</Label>
              <select
                id="agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={submitting || agentsLoading}
                required
                className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              >
                {agentsLoading ? (
                  <option value="">Loading…</option>
                ) : agents.length === 0 ? (
                  <option value="">No agents found — create one first</option>
                ) : (
                  <>
                    <option value="" disabled>
                      Select an agent…
                    </option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </>
                )}
              </select>
              {agentsError ? (
                <p className="font-mono text-xs text-destructive">
                  {agentsError}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sandbox-type">Sandbox type</Label>
              <Input
                id="sandbox-type"
                value="opencode"
                disabled
                readOnly
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sandbox-size">Sandbox size</Label>
              <select
                id="sandbox-size"
                value={sandboxSize}
                onChange={(e) =>
                  setSandboxSize(e.target.value as SandboxSize)
                }
                disabled={submitting}
                className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              >
                {SANDBOX_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="timeout">Timeout (minutes)</Label>
                <Input
                  id="timeout"
                  type="number"
                  inputMode="numeric"
                  min={TIMEOUT_MIN}
                  max={TIMEOUT_MAX}
                  value={timeout}
                  onChange={(e) => setTimeoutMin(e.target.value)}
                  disabled={submitting}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idle-timeout">Idle timeout (minutes)</Label>
                <Input
                  id="idle-timeout"
                  type="number"
                  inputMode="numeric"
                  min={TIMEOUT_MIN}
                  max={TIMEOUT_MAX}
                  value={idleTimeout}
                  onChange={(e) => setIdleTimeout(e.target.value)}
                  disabled={submitting}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="repo-url">Repo URL</Label>
              <Input
                id="repo-url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder={DEFAULT_REPO}
                disabled={submitting}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="starting-ref">Starting ref</Label>
              <Input
                id="starting-ref"
                value={startingRef}
                onChange={(e) => setStartingRef(e.target.value)}
                placeholder={DEFAULT_REF}
                disabled={submitting}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="env-vars">Env vars</Label>
              <Textarea
                id="env-vars"
                value={envVarsRaw}
                onChange={(e) => setEnvVarsRaw(e.target.value)}
                placeholder={"FOO=bar\nBAZ=qux"}
                rows={5}
                disabled={submitting}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                One <span className="font-mono">KEY=VALUE</span> per line.
                Optional.
              </p>
            </div>

            <div className="pt-2">
              <Button
                type="submit"
                disabled={submitting || agentsLoading || agents.length === 0}
              >
                {submitting ? "Creating…" : "Create session"}
              </Button>
              {error ? (
                <p className="mt-3 font-mono text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
