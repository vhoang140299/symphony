import { z } from "zod";
import type { Issue, Tracker } from "@ai-symphony/core/domain.js";
import { normalizeState } from "@ai-symphony/core/domain.js";
import { TrackerError } from "./error.js";

const invalidStateMessage = "Memory issue state must be a non-empty string";
const stateSchema = z.string().refine((state) => state.trim() !== "", invalidStateMessage);
const timestampSchema = z.string().datetime({ offset: true }).nullable().default(null);

const blockerSchema = z.object({
  id: z.string().nullable().default(null),
  identifier: z.string().nullable().default(null),
  state: z.string().nullable().default(null),
});

const issueSchema = z.object({
  id: z.string().min(1),
  native_ref: z.null().default(null),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().default(null),
  priority: z.number().int().nullable().default(null),
  state: stateSchema,
  branch_name: z.string().nullable().default(null),
  url: z.string().url().nullable().default(null),
  assignee_id: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  blocked_by: z.array(blockerSchema).default([]),
  dispatchable: z.boolean().default(true),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export class MemoryTracker implements Tracker {
  readonly #issues = new Map<string, Issue>();

  constructor(provider: Record<string, unknown> = {}) {
    const parsed = z.array(issueSchema).safeParse(provider.issues ?? []);
    if (!parsed.success) {
      throw new TrackerError("invalid_tracker_config", parsed.error.message);
    }
    const identifiers = new Set<string>();
    for (const issue of parsed.data) {
      if (this.#issues.has(issue.id)) {
        throw new TrackerError("invalid_tracker_config", `Duplicate memory issue id: ${issue.id}`);
      }
      if (identifiers.has(issue.identifier)) {
        throw new TrackerError(
          "invalid_tracker_config",
          `Duplicate memory issue identifier: ${issue.identifier}`,
        );
      }
      this.#issues.set(issue.id, normalizeIssue(issue));
      identifiers.add(issue.identifier);
    }
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map(normalizeState));
    return [...this.#issues.values()].filter((issue) => wanted.has(normalizeState(issue.state))).map(cloneIssue);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return [...new Set(ids)].flatMap((id) => {
      const issue = this.#issues.get(id);
      return issue ? [cloneIssue(issue)] : [];
    });
  }

  setIssueState(id: string, state: string): void {
    const issue = this.#issues.get(id);
    if (!issue) throw new Error(`Unknown memory issue ${id}`);
    if (!stateSchema.safeParse(state).success) throw new Error(invalidStateMessage);
    this.#issues.set(id, { ...issue, state, updatedAt: new Date().toISOString() });
  }
}

function normalizeIssue(raw: z.infer<typeof issueSchema>): Issue {
  return {
    id: raw.id,
    nativeRef: raw.native_ref,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    state: raw.state,
    branchName: raw.branch_name,
    url: raw.url,
    assigneeId: raw.assignee_id,
    labels: [...new Set(raw.labels.map((label) => label.trim().toLowerCase()).filter(Boolean))],
    blockedBy: raw.blocked_by,
    dispatchable: raw.dispatchable,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function cloneIssue(issue: Issue): Issue {
  return structuredClone(issue);
}
