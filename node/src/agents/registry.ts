import type { AgentDriver } from "../domain.js";
import { ClaudeAgentDriver } from "./claude.js";

export function createAgentDriver(kind: string): AgentDriver {
  if (kind === "claude") return new ClaudeAgentDriver();
  throw new Error(`Unsupported runtime kind: ${kind}`);
}
