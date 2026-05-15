/**
 * Agent template loader.
 *
 * Reads agent_templates.json from the repo root. Each entry is a complete
 * AgentTemplate object — no separate .md files or directories needed.
 *
 * To add or edit a template: edit agent_templates.json. No TypeScript changes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  prompt: string;
  skill_name: string;
  skill: string;
  tools: string[];
  requirements: string | null;
}

const TEMPLATES_FILE = join(process.cwd(), "agent_templates.json");

function loadTemplates(): AgentTemplate[] {
  try {
    const raw: AgentTemplate[] = JSON.parse(readFileSync(TEMPLATES_FILE, "utf8"));
    return raw.map((t) => ({ ...t, requirements: t.requirements ?? null }));
  } catch {
    return [];
  }
}

// Load once at startup — templates are static files, no hot-reload needed.
const TEMPLATES: AgentTemplate[] = loadTemplates();

export function listTemplates(): AgentTemplate[] {
  return TEMPLATES;
}

export function getTemplate(id: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
