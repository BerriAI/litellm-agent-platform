/**
 * Linear outbound — SessionEvent → agentActivityCreate.
 *
 * Linear's UI renders these as the agent's progress feed on the issue.
 * The dispatcher calls into here whenever the harness emits an event for
 * a session that originated from Linear.
 *
 * Mutation:
 *   mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
 *     agentActivityCreate(input: $input) { success agentActivity { id } }
 *   }
 *
 * Content shape per `type`:
 *   thought / response / error / elicitation : { body }
 *   action                                   : { action, parameter, result? }
 */

import { fetch } from "undici";
import { getAccessToken } from "../../core/oauth";
import type {
  Integration,
  SessionEvent,
  SessionEventContext,
} from "../../core/types";

const GRAPHQL_URL = "https://api.linear.app/graphql";

const MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
      agentActivity { id }
    }
  }
`.trim();

interface LinearActivityContent {
  type: "thought" | "action" | "response" | "error" | "elicitation";
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

function sessionEventToContent(event: SessionEvent): LinearActivityContent {
  switch (event.type) {
    case "thought":
      return { type: "thought", body: event.body };
    case "action":
      return event.result === undefined
        ? { type: "action", action: event.action, parameter: event.parameter }
        : {
            type: "action",
            action: event.action,
            parameter: event.parameter,
            result: event.result,
          };
    case "response":
      // externalUrls is a separate agentSessionUpdate mutation; v1 just
      // posts the body as the response. Adding the PR link is a follow-up.
      return { type: "response", body: event.body };
    case "error":
      return { type: "error", body: event.body };
    case "elicit":
      // Canonical SessionEvent uses "elicit"; Linear's wire format uses
      // "elicitation". Translate at the boundary.
      return { type: "elicitation", body: event.body };
  }
}

export async function postActivity(
  integration: Integration,
  ctx: SessionEventContext,
): Promise<void> {
  const accessToken = await getAccessToken(ctx.install.install_id, integration);
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: MUTATION,
      variables: {
        input: {
          agentSessionId: ctx.externalSessionId,
          content: sessionEventToContent(ctx.event),
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Linear agentActivityCreate returned ${res.status}: ${text}`,
    );
  }
  const json = (await res.json()) as {
    data?: { agentActivityCreate?: { success?: boolean } };
    errors?: unknown;
  };
  if (json.errors) {
    throw new Error(
      `Linear agentActivityCreate errors: ${JSON.stringify(json.errors)}`,
    );
  }
  if (json.data?.agentActivityCreate?.success !== true) {
    throw new Error(
      `Linear agentActivityCreate did not succeed: ${JSON.stringify(json)}`,
    );
  }
}
