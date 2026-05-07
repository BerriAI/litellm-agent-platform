"use client";

import { FormEvent, useState } from "react";
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
import { ApiError, createAgent, PROXY_BASE } from "@/lib/api";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_KEY = "sk-1234";
const NAME_MAX = 64;

function parseTools(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return Array.from(seen);
}

export default function NewAgentPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [toolsRaw, setToolsRaw] = useState("");
  const [apiKey, setApiKey] = useState(DEFAULT_KEY);
  const [baseUrl, setBaseUrl] = useState(PROXY_BASE);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    const trimmedName = name.trim();
    if (!trimmedName) return "Name is required.";
    if (trimmedName.length > NAME_MAX) {
      return `Name must be ${NAME_MAX} characters or fewer.`;
    }
    if (!model.trim()) return "Model is required.";
    if (!systemPrompt.trim()) return "System prompt is required.";
    if (!apiKey.trim()) return "LiteLLM API key is required.";
    if (!baseUrl.trim()) return "LiteLLM base URL is required.";
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

    setSubmitting(true);
    try {
      const created = await createAgent({
        name: name.trim(),
        config: {
          model: model.trim(),
          system_prompt: systemPrompt,
          tools: parseTools(toolsRaw),
          litellm_api_key: apiKey.trim(),
          litellm_base_url: baseUrl.trim(),
        },
      });
      router.push(`/agents/${created.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div>
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to agents
        </Link>
      </div>

      <div className="mt-6">
        <h1 className="text-[22px] font-semibold tracking-tight">New Agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Define the model, system prompt, and tools. The agent is a pure
          definition — sandboxes are created per session.
        </p>
      </div>

      <Card className="mt-6">
        <CardHeader className="sr-only">
          <CardTitle>New Agent</CardTitle>
          <CardDescription>
            Define the model, system prompt, and tools.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                placeholder="code-reviewer"
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={DEFAULT_MODEL}
                disabled={submitting}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="system-prompt">System prompt</Label>
              <Textarea
                id="system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You are a senior engineer reviewing code for clarity, correctness, and security."
                rows={6}
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tools">Tools</Label>
              <Input
                id="tools"
                value={toolsRaw}
                onChange={(e) => setToolsRaw(e.target.value)}
                placeholder="read, write, bash, grep"
                disabled={submitting}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated tool names.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="api-key">LiteLLM API key</Label>
              <Input
                id="api-key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={submitting}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="base-url">LiteLLM base URL</Label>
              <Input
                id="base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={submitting}
                className="font-mono text-xs"
              />
            </div>

            <div className="pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create agent"}
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
