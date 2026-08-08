import type { AgentDriver } from "../domain.js";
import { ClaudeAgentDriver } from "./claude.js";
import { CodexAgentDriver } from "./codex.js";

export function createAgentDriver(kind: string): AgentDriver {
  if (kind === "claude") return new ClaudeAgentDriver();
  if (kind === "codex") return new CodexAgentDriver();
  throw new Error(`Unsupported runtime kind: ${kind}`);
}
