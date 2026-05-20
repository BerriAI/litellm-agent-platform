import { mkdirSync, writeFileSync } from "node:fs";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function buildScreenshotMcpServer(): McpSdkServerConfigWithInstance {
  const screenshotUrl = tool(
    "screenshot_url",
    "Capture a screenshot of any URL accessible in the sandbox (e.g. Jaeger UI at http://localhost:16686, LiteLLM proxy UI). Returns the screenshot as an image. Also saves PNG to /tmp/screenshots/ for committing to the repo as proof.",
    z.object({
      url: z
        .string()
        .url()
        .refine((u) => /^https?:$/.test(new URL(u).protocol), {
          message: "Only http(s) URLs are supported (file://, data:, ftp://, etc. are rejected)",
        })
        .describe("URL to screenshot (http or https only)"),
      wait_ms: z
        .number()
        .optional()
        .describe("Extra ms to wait after page load, default 2000"),
    }),
    async (input: { url: string; wait_ms?: number }) => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      try {
        const page = await browser.newPage();
        await page.goto(input.url, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(input.wait_ms ?? 2000);
        const buf = await page.screenshot({ type: "png", fullPage: true });
        const dir = "/tmp/screenshots";
        mkdirSync(dir, { recursive: true });
        const filePath = `${dir}/screenshot_${Date.now()}.png`;
        writeFileSync(filePath, buf);
        return {
          content: [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png" as const,
                data: buf.toString("base64"),
              },
            },
            {
              type: "text" as const,
              text: `Screenshot saved to ${filePath}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Screenshot failed: ${message}` }],
          isError: true,
        };
      } finally {
        await browser.close();
      }
    },
  );

  return createSdkMcpServer({
    name: "lap-screenshot",
    version: "0.1.0",
    tools: [screenshotUrl],
  });
}

export const SCREENSHOT_TOOL_NAMES = [
  "mcp__lap-screenshot__screenshot_url",
] as const;
