import { fetch } from "undici";

import type { AgentRow, HarnessMessage } from "./types";
import {
  provisionSandbox,
  executeSandbox,
  clearSandboxes,
} from "./tools/sandboxTools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

interface SessionState {
  messages: ChatMessage[];
  agent: AgentRow;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionState>();

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "provision",
      description: "Spin up a named sandbox pod. Must be called before execute.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Unique name for this sandbox, e.g. 'dev'",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute",
      description: "Run a shell command in a named sandbox. Returns stdout+stderr.",
      parameters: {
        type: "object",
        properties: {
          sandbox_name: { type: "string" },
          cmd: { type: "string", description: "Shell command to run" },
        },
        required: ["sandbox_name", "cmd"],
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
// LiteLLM /chat/completions call
// ---------------------------------------------------------------------------

async function callLiteLLM(
  messages: ChatMessage[],
  model: string,
): Promise<ChatCompletionChoice> {
  const base = (process.env.LITELLM_API_BASE ?? "").replace(/\/+$/, "");
  const key = process.env.LITELLM_API_KEY ?? "";
  const url = `${base}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    }),
    signal: AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LiteLLM error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const choice = data.choices?.[0];
  if (!choice) throw new Error("LiteLLM returned no choices");
  return choice;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function dispatchTool(
  session_id: string,
  agent: AgentRow,
  name: string,
  argsJson: string,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return `error: could not parse tool arguments: ${argsJson}`;
  }

  try {
    if (name === "provision") {
      const sandboxName = String(args.name ?? "");
      return await provisionSandbox(session_id, sandboxName, agent);
    }
    if (name === "execute") {
      const sandboxName = String(args.sandbox_name ?? "");
      const cmd = String(args.cmd ?? "");
      return await executeSandbox(session_id, sandboxName, cmd);
    }
    return `error: unknown tool '${name}'`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

type BrainEvent =
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string }
  | { type: "assistant_text"; text: string };

async function runAgentLoop(
  session_id: string,
  state: SessionState,
  onEvent?: (e: BrainEvent) => void,
): Promise<string> {
  for (;;) {
    const choice = await callLiteLLM(state.messages, state.agent.model);
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      state.messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        let input: unknown;
        try { input = JSON.parse(tc.function.arguments); } catch { input = tc.function.arguments; }
        onEvent?.({ type: "tool_call", name: tc.function.name, input });

        const result = await dispatchTool(
          session_id,
          state.agent,
          tc.function.name,
          tc.function.arguments,
        );
        onEvent?.({ type: "tool_result", name: tc.function.name, output: result });

        state.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue;
    }

    const text = msg.content ?? "";
    state.messages.push({ role: "assistant", content: text });
    onEvent?.({ type: "assistant_text", text });
    return text;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInlineBrainSession(
  session_id: string,
  agent: AgentRow,
  priorEvents?: Array<{ event_type: string; payload: unknown }>,
): void {
  const messages: ChatMessage[] = [
    { role: "system", content: agent.prompt ?? "" },
  ];

  if (priorEvents) {
    for (const event of priorEvents) {
      if (event.event_type === "user_message") {
        const payload = event.payload as { text?: string } | null;
        const text = payload?.text ?? "";
        messages.push({ role: "user", content: text });
      } else if (event.event_type === "assistant_message") {
        const payload = event.payload as { text?: string } | null;
        const text = payload?.text ?? "";
        messages.push({ role: "assistant", content: text });
      }
    }
  }

  sessions.set(session_id, { messages, agent });
}

export async function sendInlineBrainMessage(
  session_id: string,
  text: string,
  agent: AgentRow,
  onEvent?: (e: BrainEvent) => void,
): Promise<{ response: string }> {
  let state = sessions.get(session_id);
  if (!state) {
    createInlineBrainSession(session_id, agent);
    state = sessions.get(session_id)!;
  }

  state.messages.push({ role: "user", content: text });
  const response = await runAgentLoop(session_id, state, onEvent);
  return { response };
}

export function listInlineBrainMessages(
  session_id: string,
): HarnessMessage[] {
  const state = sessions.get(session_id);
  if (!state) return [];

  return state.messages
    .filter(
      (m): m is ChatMessage & { role: "user" | "assistant" } =>
        m.role === "user" || m.role === "assistant",
    )
    .map((m, i) => ({
      info: {
        id: `brain-inline-${session_id}-${i}`,
        sessionID: session_id,
        role: m.role,
      },
      parts: [{ type: "text", text: m.content ?? "" }],
    }));
}

export function clearInlineBrainSession(session_id: string): void {
  clearSandboxes(session_id);
  sessions.delete(session_id);
}
