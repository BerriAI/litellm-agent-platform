"use client";

/**
 * Channels (integrations) section for the agent detail page.
 *
 * One row per registered provider. Each row shows status at a glance and an
 * action button that either opens a setup wizard (first-time) or toggles
 * the binding off (already connected).
 *
 * States we render:
 *   - disabled:     server env vars missing → greyed out, "Configure on server"
 *   - available:    enabled but no install + no binding → "Set up"
 *   - installed-not-bound: install exists, this agent isn't bound → "Connect"
 *   - bound:        binding active → "Connected to <workspace>" + Disconnect
 *
 * The setup wizard is provider-specific. Today only Slack ships one
 * (SlackSetupDialog); other providers (Linear etc.) fall back to a link to
 * the OAuth authorize endpoint.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2, Plug, Unplug } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  IntegrationSummary,
  listIntegrations,
  unbindIntegration,
} from "@/lib/api";
import { SlackSetupDialog } from "@/components/slack-setup-dialog";

interface Props {
  agentId: string;
}

export function ChannelsSection({ agentId }: Props) {
  const [providers, setProviders] = useState<IntegrationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupProviderId, setSetupProviderId] = useState<string | null>(null);
  const [unbindingId, setUnbindingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await listIntegrations(agentId);
      setProviders(data.providers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleUnbind = async (providerId: string) => {
    setUnbindingId(providerId);
    try {
      await unbindIntegration(agentId, providerId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnbindingId(null);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Channels</h2>
        <p className="text-xs text-muted-foreground">
          Reach this agent from outside LAP.
        </p>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {providers === null ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          No channel integrations registered.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card/40">
          {providers.map((p) => (
            <ChannelRow
              key={p.id}
              provider={p}
              unbinding={unbindingId === p.id}
              onSetup={() => setSetupProviderId(p.id)}
              onDisconnect={() => handleUnbind(p.id)}
            />
          ))}
        </ul>
      )}

      {setupProviderId === "slack" && (
        <SlackSetupDialog
          agentId={agentId}
          open={true}
          onClose={() => setSetupProviderId(null)}
          onCompleted={async () => {
            setSetupProviderId(null);
            await reload();
          }}
        />
      )}
    </section>
  );
}

interface RowProps {
  provider: IntegrationSummary;
  unbinding: boolean;
  onSetup: () => void;
  onDisconnect: () => void;
}

function ChannelRow({ provider, unbinding, onSetup, onDisconnect }: RowProps) {
  const state = deriveState(provider);

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background">
          {/* Don't crash if the icon file isn't in /public yet — fall back to a plug. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={provider.icon}
            alt=""
            className="h-5 w-5"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{provider.display_name}</span>
            <StateBadge state={state} workspace={provider.binding?.workspace_name ?? null} />
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {state === "disabled" &&
              "Server is missing the env vars for this integration."}
            {state === "available" &&
              "Click set up to connect a workspace and bind it to this agent."}
            {state === "installed-not-bound" &&
              "A workspace is already connected — click connect to route this agent through it."}
            {state === "bound" && (
              <>
                Bound to{" "}
                <span className="font-mono">
                  {provider.binding?.workspace_name}
                </span>
                . Messages to this agent flow through it.
              </>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0">
        <RowAction
          state={state}
          providerId={provider.id}
          unbinding={unbinding}
          onSetup={onSetup}
          onDisconnect={onDisconnect}
        />
      </div>
    </li>
  );
}

type RowState = "disabled" | "available" | "installed-not-bound" | "bound";

function deriveState(provider: IntegrationSummary): RowState {
  if (!provider.enabled) return "disabled";
  if (provider.binding) return "bound";
  if (provider.installs.length > 0) return "installed-not-bound";
  return "available";
}

function StateBadge({
  state,
  workspace,
}: {
  state: RowState;
  workspace: string | null;
}) {
  if (state === "bound") {
    return (
      <Badge variant="default" className="font-normal">
        Connected{workspace ? ` · ${workspace}` : ""}
      </Badge>
    );
  }
  if (state === "installed-not-bound") {
    return (
      <Badge variant="secondary" className="font-normal">
        Installed, not bound
      </Badge>
    );
  }
  if (state === "disabled") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        Not configured
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-normal">
      Available
    </Badge>
  );
}

function RowAction({
  state,
  providerId,
  unbinding,
  onSetup,
  onDisconnect,
}: {
  state: RowState;
  providerId: string;
  unbinding: boolean;
  onSetup: () => void;
  onDisconnect: () => void;
}) {
  if (state === "disabled") {
    return (
      <Button variant="ghost" size="sm" disabled>
        Configure on server
      </Button>
    );
  }
  if (state === "bound") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onDisconnect}
        disabled={unbinding}
      >
        {unbinding ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Unplug className="h-3.5 w-3.5" />
        )}
        <span className="ml-1.5">Disconnect</span>
      </Button>
    );
  }

  // available + installed-not-bound: open the setup wizard for known
  // providers, fall back to the generic OAuth authorize link otherwise.
  if (providerId === "slack") {
    return (
      <Button variant="default" size="sm" onClick={onSetup}>
        <Plug className="h-3.5 w-3.5" />
        <span className="ml-1.5">
          {state === "installed-not-bound" ? "Connect" : "Set up"}
        </span>
        <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
      </Button>
    );
  }
  return (
    <a
      className={buttonVariants({ variant: "outline", size: "sm" })}
      href={`/api/integrations/oauth/${encodeURIComponent(providerId)}/authorize`}
    >
      Install
      <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
    </a>
  );
}
