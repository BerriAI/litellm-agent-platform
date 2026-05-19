/**
 * Cron-trigger session bring-up.
 *
 * Thin wrapper around `runBringUp` from session-bringup.ts that the worker's
 * cron tick uses. The HTTP route does the same dance but adds auth + body
 * parsing on top; cron has no caller identity and a synthetic prompt.
 *
 * Lives in its own file so cron.ts → cron-bringup.ts → session-bringup.ts
 * doesn't pull in API route code into the worker bundle. Also keeps the
 * synthetic-prompt text in one place so it can be tweaked without grepping.
 */

import { runBringUp } from "@/server/session-bringup";
import type { AgentRow, WarmTaskRow } from "@/server/types";

export async function runBringUpForCron(
  agent: AgentRow,
  session_id: string,
  initial_prompt: string,
  warm: WarmTaskRow | null,
): Promise<void> {
  await runBringUp(
    agent,
    session_id,
    {
      initial_prompt,
      title: `[cron] ${new Date().toISOString()}`,
    },
    warm,
  );
}
