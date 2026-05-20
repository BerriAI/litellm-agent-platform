import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Browser, BrowserContext, Page } from "playwright";

const execFileAsync = promisify(execFile);

interface RecordingSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const sessions = new Map<string, RecordingSession>();

// Close all open browser sessions on process exit to prevent leaked Playwright processes.
async function closeAllSessions() {
  for (const [id, s] of sessions) {
    try { await s.context.close(); } catch {}
    try { await s.browser.close(); } catch {}
    sessions.delete(id);
  }
}
for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { closeAllSessions().catch(() => {}); });
}

export function buildRecordingMcpServer(): McpSdkServerConfigWithInstance {
  // ---------------------------------------------------------------------------
  // recording_start
  // ---------------------------------------------------------------------------
  const recordingStart = tool(
    "recording_start",
    "Start a screen recording session. Opens a headless Chromium browser with video recording enabled and navigates to the given URL. Returns a session_id used by all other recording tools. Save the .webm to the repo as proof when done.",
    {
      url: z
        .string()
        .url()
        .refine((u) => /^https?:$/.test(new URL(u).protocol), {
          message: "Only http(s) URLs are supported",
        })
        .describe("URL to open first (http or https only)"),
      width: z.number().optional().describe("Viewport width, default 1600"),
      height: z.number().optional().describe("Viewport height, default 900"),
    },
    async (input: { url: string; width?: number; height?: number }) => {
      const { chromium } = await import("playwright");
      const w = input.width ?? 1600;
      const h = input.height ?? 900;
      const dir = "/tmp/recordings";
      mkdirSync(dir, { recursive: true });

      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      try {
        const context = await browser.newContext({
          recordVideo: { dir, size: { width: w, height: h } },
          viewport: { width: w, height: h },
        });
        const page = await context.newPage();

        try {
          await page.goto(input.url, { waitUntil: "networkidle", timeout: 30000 });
        } catch {
          // domcontentloaded fallback for slow pages
          await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        }

        const sessionId = randomUUID();
        sessions.set(sessionId, { browser, context, page });

        return {
          content: [
            {
              type: "text" as const,
              text: `Recording started. session_id: ${sessionId}`,
            },
          ],
        };
      } catch (e) {
        await browser.close();
        return err(`recording_start failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // recording_navigate
  // ---------------------------------------------------------------------------
  const recordingNavigate = tool(
    "recording_navigate",
    "Navigate the recording browser to a new URL mid-recording.",
    {
      session_id: z.string().describe("session_id from recording_start"),
      url: z
        .string()
        .url()
        .refine((u) => /^https?:$/.test(new URL(u).protocol), {
          message: "Only http(s) URLs are supported",
        })
        .describe("URL to navigate to (http or https only)"),
    },
    async (input: { session_id: string; url: string }) => {
      const s = sessions.get(input.session_id);
      if (!s) return err(`No recording session: ${input.session_id}`);
      try {
        try {
          await s.page.goto(input.url, { waitUntil: "networkidle", timeout: 30000 });
        } catch {
          await s.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        }
      } catch (e) {
        return err(`Navigate failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return ok(`Navigated to ${input.url}`);
    },
  );

  // ---------------------------------------------------------------------------
  // recording_click
  // ---------------------------------------------------------------------------
  const recordingClick = tool(
    "recording_click",
    "Click an element in the recording browser. Use `text` to click by visible text (most reliable for dropdowns and buttons), or `selector` for a CSS selector.",
    {
      session_id: z.string(),
      text: z.string().optional().describe("Visible text of the element to click (partial match OK)"),
      selector: z.string().optional().describe("CSS selector — used only when text is not provided"),
      wait_after_ms: z.number().min(0).max(10000).optional().describe("Ms to wait after click for UI to settle, default 800 (capped at 10 000 ms)"),
    },
    async (input: {
      session_id: string;
      text?: string;
      selector?: string;
      wait_after_ms?: number;
    }) => {
      const s = sessions.get(input.session_id);
      if (!s) return err(`No recording session: ${input.session_id}`);
      if (!input.text && !input.selector)
        return err("Provide text or selector");
      try {
        if (input.text) {
          await s.page
            .getByText(input.text, { exact: false })
            .first()
            .click({ timeout: 10000 });
        } else {
          await s.page.locator(input.selector!).first().click({ timeout: 10000 });
        }
        await s.page.waitForTimeout(input.wait_after_ms ?? 800);
        return ok(`Clicked "${input.text ?? input.selector}"`);
      } catch (e) {
        return err(`Click failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // recording_wait
  // ---------------------------------------------------------------------------
  const recordingWait = tool(
    "recording_wait",
    "Pause the recording for a fixed duration so the viewer can read the current screen state. Use 1000–2000ms after interactions, 2000–3000ms when key evidence is visible.",
    {
      session_id: z.string(),
      ms: z.number().min(0).max(10000).describe("Duration to wait in milliseconds (capped at 10 000 ms)"),
    },
    async (input: { session_id: string; ms: number }) => {
      const s = sessions.get(input.session_id);
      if (!s) return err(`No recording session: ${input.session_id}`);
      await s.page.waitForTimeout(input.ms);
      return ok(`Waited ${input.ms}ms`);
    },
  );

  // ---------------------------------------------------------------------------
  // recording_scroll_into_view
  // ---------------------------------------------------------------------------
  const recordingScrollIntoView = tool(
    "recording_scroll_into_view",
    "Scroll an element into the visible viewport during recording.",
    {
      session_id: z.string(),
      text: z.string().optional().describe("Visible text of element to scroll to"),
      selector: z.string().optional().describe("CSS selector — used when text not provided"),
    },
    async (input: { session_id: string; text?: string; selector?: string }) => {
      const s = sessions.get(input.session_id);
      if (!s) return err(`No recording session: ${input.session_id}`);
      if (!input.text && !input.selector) return err("Provide text or selector");
      try {
        const loc = input.text
          ? s.page.getByText(input.text, { exact: false }).first()
          : s.page.locator(input.selector!).first();
        await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
        return ok(`Scrolled "${input.text ?? input.selector}" into view`);
      } catch (e) {
        return err(`Scroll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // recording_screenshot_check
  // ---------------------------------------------------------------------------
  const recordingScreenshotCheck = tool(
    "recording_screenshot_check",
    "Take a screenshot mid-recording to verify the current browser state before continuing. Use after clicks that open dropdowns or load new content to confirm the interaction worked before proceeding.",
    {
      session_id: z.string(),
    },
    async (input: { session_id: string }) => {
      const s = sessions.get(input.session_id);
      if (!s) return err(`No recording session: ${input.session_id}`);
      try {
        const buf = await s.page.screenshot({ type: "png" });
        return {
          content: [
            {
              type: "image" as const,
              data: buf.toString("base64"),
              mimeType: "image/png" as const,
            },
          ],
        };
      } catch (e) {
        return err(`Screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // recording_stop
  // ---------------------------------------------------------------------------
  const recordingStop = tool(
    "recording_stop",
    "Stop the recording and finalize the video file. Returns the path to the saved .mp4 file (or .webm if ffmpeg is unavailable). Commit it to the repo (e.g. proof/demo.mp4) as visual proof of the e2e flow.",
    {
      session_id: z.string(),
    },
    async (input: { session_id: string }) => {
      const s = sessions.get(input.session_id);
      if (!s) return err(`No recording session: ${input.session_id}`);
      try {
        const videoPath = await s.page.video()?.path();
        // context.close() finalizes the .webm — must happen before reading path
        await s.context.close();
        await s.browser.close();
        sessions.delete(input.session_id);
        // After close, path() is stable
        const finalPath = videoPath ?? (await s.page.video()?.path());
        if (finalPath) {
          const mp4Path = finalPath.replace(/\.webm$/, ".mp4");
          try {
            await execFileAsync("ffmpeg", [
              "-i", finalPath,
              "-c:v", "libx264", "-pix_fmt", "yuv420p",
              "-movflags", "+faststart",
              mp4Path,
            ]);
            return ok(`Recording saved to ${mp4Path}. Commit to proof/demo.mp4 on the PR branch.`);
          } catch {
            // ffmpeg not available — return raw webm path
            return ok(`Recording saved to ${finalPath}. Commit to proof/demo.webm on the PR branch.`);
          }
        }
        return ok("Recording stopped. Check /tmp/recordings/ for the video file.");
      } catch (e) {
        sessions.delete(input.session_id);
        return err(`Stop failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "lap-recording",
    version: "0.1.0",
    tools: [
      recordingStart,
      recordingNavigate,
      recordingClick,
      recordingWait,
      recordingScrollIntoView,
      recordingScreenshotCheck,
      recordingStop,
    ],
  });
}

export const RECORDING_TOOL_NAMES = [
  "mcp__lap-recording__recording_start",
  "mcp__lap-recording__recording_navigate",
  "mcp__lap-recording__recording_click",
  "mcp__lap-recording__recording_wait",
  "mcp__lap-recording__recording_scroll_into_view",
  "mcp__lap-recording__recording_screenshot_check",
  "mcp__lap-recording__recording_stop",
] as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
