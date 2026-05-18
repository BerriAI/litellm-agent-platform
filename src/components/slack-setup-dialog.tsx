"use client";

/**
 * Slack setup wizard — walks the operator through the four steps needed to
 * make a LAP agent reachable from Slack.
 *
 * The four steps:
 *   1. Server config check
 *        Three env vars need to be set on the LAP server:
 *          SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET
 *        We detect this indirectly by hitting GET /api/v1/integrations and
 *        looking at `slack.enabled`. If false, the wizard stops here with
 *        instructions — we can't write the env vars from the browser.
 *   2. Slack app from manifest
 *        Show the manifest pre-substituted with this deployment's base URL.
 *        Copy-to-clipboard button. Link to api.slack.com/apps.
 *   3. Install into workspace
 *        Button opens /api/integrations/oauth/slack/authorize in a new tab.
 *        We poll the integrations list every 2s while the dialog is open
 *        and advance once an install appears for this workspace.
 *   4. Bind to this agent
 *        If only one workspace: auto-pick + show "Save" button.
 *        If multiple: dropdown.
 *
 * On success the parent's onCompleted reloads the channels list.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  bindIntegration,
  getIntegrationManifest,
  IntegrationInstallSummary,
  listIntegrations,
  type IntegrationSummary,
} from "@/lib/api";

interface Props {
  agentId: string;
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}

type Step = "config" | "manifest" | "install" | "bind";

const SLACK_APP_DASHBOARD = "https://api.slack.com/apps";

export function SlackSetupDialog({
  agentId,
  open,
  onClose,
  onCompleted,
}: Props) {
  const [step, setStep] = useState<Step>("config");
  const [provider, setProvider] = useState<IntegrationSummary | null>(null);
  const [manifestJson, setManifestJson] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedInstallId, setSelectedInstallId] = useState<string | null>(
    null,
  );
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull the slack provider snapshot on open and whenever we want to re-poll
  // for a freshly-completed OAuth install.
  const refresh = useCallback(async () => {
    try {
      const data = await listIntegrations(agentId);
      const slack = data.providers.find((p) => p.id === "slack") ?? null;
      setProvider(slack);
      setError(null);
      return slack;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [agentId]);

  // Initial load + manifest fetch.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const slack = await refresh();
      if (!slack) return;
      // Advance past the steps the operator has already done.
      if (!slack.enabled) {
        setStep("config");
      } else if (slack.installs.length === 0) {
        setStep("manifest");
      } else {
        setStep("bind");
        setSelectedInstallId(slack.installs[0]?.install_id ?? null);
      }
      if (slack.enabled && slack.has_manifest && manifestJson === null) {
        try {
          const { manifest, base_url } = await getIntegrationManifest("slack");
          setManifestJson(JSON.stringify(manifest, null, 2));
          setBaseUrl(base_url);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    // We intentionally don't depend on manifestJson — first-open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refresh]);

  // While on the "install" step, poll for OAuth completion so the user
  // doesn't have to click anything when they come back from the Slack
  // consent screen.
  useEffect(() => {
    if (!open || step !== "install") return;
    const id = setInterval(async () => {
      const slack = await refresh();
      if (slack && slack.installs.length > 0) {
        setSelectedInstallId(slack.installs[0]!.install_id);
        setStep("bind");
        clearInterval(id);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [open, step, refresh]);

  const handleCopy = async () => {
    if (!manifestJson) return;
    try {
      await navigator.clipboard.writeText(manifestJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleBind = async () => {
    if (!selectedInstallId) return;
    setBinding(true);
    try {
      await bindIntegration(agentId, "slack", selectedInstallId);
      onCompleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBinding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set up Slack</DialogTitle>
          <DialogDescription>
            Once connected, anyone in your workspace can DM this agent or
            @-mention it in a channel.
          </DialogDescription>
        </DialogHeader>

        <StepIndicator step={step} />

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
            {error}
          </div>
        )}

        {step === "config" && <ConfigStep />}
        {step === "manifest" && (
          <ManifestStep
            manifestJson={manifestJson}
            baseUrl={baseUrl}
            copied={copied}
            onCopy={handleCopy}
          />
        )}
        {step === "install" && <InstallStep baseUrl={baseUrl} />}
        {step === "bind" && (
          <BindStep
            installs={provider?.installs ?? []}
            selectedInstallId={selectedInstallId}
            onSelect={setSelectedInstallId}
          />
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {step === "config" && (
            <Button onClick={() => void refresh().then((s) => s?.enabled && setStep("manifest"))}>
              I&apos;ve set the env vars
            </Button>
          )}
          {step === "manifest" && (
            <Button onClick={() => setStep("install")} disabled={!manifestJson}>
              I&apos;ve created the app
            </Button>
          )}
          {step === "install" && (
            <Button variant="outline" disabled>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="ml-1.5">Waiting for install…</span>
            </Button>
          )}
          {step === "bind" && (
            <Button
              onClick={handleBind}
              disabled={!selectedInstallId || binding}
            >
              {binding ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="ml-1.5">Saving…</span>
                </>
              ) : (
                "Connect to this agent"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- step subcomponents ----------

function StepIndicator({ step }: { step: Step }) {
  const order: Step[] = ["config", "manifest", "install", "bind"];
  const labels: Record<Step, string> = {
    config: "Server",
    manifest: "App",
    install: "Install",
    bind: "Bind",
  };
  const activeIndex = order.indexOf(step);
  return (
    <ol className="flex items-center gap-1 text-xs">
      {order.map((s, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <li
            key={s}
            className={
              "flex items-center gap-1 rounded-full border px-2 py-0.5 " +
              (active
                ? "border-foreground/40 bg-foreground text-background"
                : done
                  ? "border-muted-foreground/30 text-muted-foreground"
                  : "border-dashed border-muted-foreground/20 text-muted-foreground/60")
            }
          >
            <span className="font-mono">{i + 1}.</span>
            <span>{labels[s]}</span>
            {done && <Check className="h-3 w-3" />}
          </li>
        );
      })}
    </ol>
  );
}

function ConfigStep() {
  return (
    <div className="space-y-3 text-sm">
      <p>
        Slack needs three env vars set on the LAP server before it can talk to
        Slack&apos;s API:
      </p>
      <pre className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
        {`SLACK_CLIENT_ID=…
SLACK_CLIENT_SECRET=…
SLACK_SIGNING_SECRET=…`}
      </pre>
      <p className="text-muted-foreground">
        You&apos;ll get all three from{" "}
        <a
          href={SLACK_APP_DASHBOARD}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          api.slack.com/apps
        </a>{" "}
        once you create the app (next step). For now, you only need to know
        where they go: set them on the LAP web service and restart it. Then
        click below to continue.
      </p>
      <p className="text-xs text-muted-foreground">
        Tip: the wizard re-checks server state when you click the button —
        the dialog stays put until the three vars are detected.
      </p>
    </div>
  );
}

function ManifestStep({
  manifestJson,
  baseUrl,
  copied,
  onCopy,
}: {
  manifestJson: string | null;
  baseUrl: string | null;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!manifestJson) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <ol className="ml-5 list-decimal space-y-1.5 text-sm">
        <li>
          Go to{" "}
          <a
            href={SLACK_APP_DASHBOARD}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            api.slack.com/apps
            <ExternalLink className="h-3 w-3" />
          </a>{" "}
          and click <b>Create New App → From a manifest</b>.
        </li>
        <li>Pick the workspace this agent should reply in.</li>
        <li>Paste the JSON below.</li>
        <li>
          Submit and click <b>Install to Workspace</b>.
        </li>
      </ol>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">
            Manifest (uses{" "}
            <span className="font-mono">{baseUrl ?? "this host"}</span>)
          </Label>
          <Button size="sm" variant="ghost" onClick={onCopy}>
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
        <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {manifestJson}
        </pre>
      </div>
    </div>
  );
}

function InstallStep({ baseUrl }: { baseUrl: string | null }) {
  const authorizeUrl = `${baseUrl ?? ""}/api/integrations/oauth/slack/authorize`;
  return (
    <div className="space-y-3 text-sm">
      <p>
        Authorize the Slack app you just created against LAP. This populates
        the encrypted bot token so the agent can post replies.
      </p>
      <a
        href={authorizeUrl}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants()}
      >
        Open OAuth flow
        <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
      </a>
      <p className="text-xs text-muted-foreground">
        The dialog polls every two seconds and advances automatically when
        the install lands.
      </p>
    </div>
  );
}

function BindStep({
  installs,
  selectedInstallId,
  onSelect,
}: {
  installs: IntegrationInstallSummary[];
  selectedInstallId: string | null;
  onSelect: (id: string) => void;
}) {
  if (installs.length === 0) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        No Slack workspaces installed yet — finish the previous step first.
      </div>
    );
  }

  if (installs.length === 1) {
    const w = installs[0]!;
    return (
      <div className="space-y-2 text-sm">
        <p>
          Bind this agent to{" "}
          <span className="font-mono">{w.workspace_name}</span> — DMs and
          @mentions in that workspace will route here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <Label className="text-xs">Workspace</Label>
      <select
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        value={selectedInstallId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
      >
        {installs.map((w) => (
          <option key={w.install_id} value={w.install_id}>
            {w.workspace_name}
          </option>
        ))}
      </select>
    </div>
  );
}
