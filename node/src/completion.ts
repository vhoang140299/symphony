import { z } from "zod";
import type { AgentCompletion } from "./domain.js";

const maxSummaryLength = 2_000;
const maxVerificationItems = 20;
const maxVerificationItemLength = 500;

export const agentCompletionSchema = z
  .object({
    status: z.enum(["ready", "blocked"]),
    summary: z.string().trim().min(1).max(maxSummaryLength),
    verification: z
      .array(z.string().trim().min(1).max(maxVerificationItemLength))
      .min(1)
      .max(maxVerificationItems),
  })
  .strict();

export const agentCompletionOutputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: maxSummaryLength },
    verification: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: maxVerificationItemLength },
      minItems: 1,
      maxItems: maxVerificationItems,
    },
  },
  required: ["status", "summary", "verification"],
  additionalProperties: false,
} as const;

export function parseAgentCompletion(value: unknown): AgentCompletion | undefined {
  const parsed = agentCompletionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseAgentCompletionJson(value: string | undefined): AgentCompletion | undefined {
  if (value === undefined) return undefined;
  try {
    return parseAgentCompletion(JSON.parse(value));
  } catch {
    return undefined;
  }
}
