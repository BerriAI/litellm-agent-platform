import type { AgentRow } from "@/server/types";

export interface ProvisionParams {
  session_id: string;
  agent: AgentRow;
  template?: string;
}

export abstract class SandboxProvider {
  abstract readonly urlScheme: string;
  abstract create(params: ProvisionParams): Promise<{ id: string; envMap: Record<string, string> }>;
  abstract execute(id: string, cmd: string, timeoutMs: number): Promise<string>;
  /**
   * Read a file out of the sandbox and return its UTF-8 text content. Powers
   * the `read_file` tool so the agent can pull files from the sandbox into its
   * own workspace without `cat`/base64 gymnastics.
   */
  abstract readFile(id: string, path: string): Promise<string>;
  abstract terminate(id: string): Promise<void>;
}
