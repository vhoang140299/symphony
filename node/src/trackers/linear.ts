import { LinearClient, type LinearClientOptions } from "@linear/sdk";
import { z } from "zod";
import type { BlockerRef, Issue, Tracker } from "../domain.js";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_API_KEY_REFERENCE = "$LINEAR_API_KEY";
const PAGE_SIZE = 50;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const DEFAULT_TERMINAL_STATES = ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"];

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  state { name }
  branchName
  url
  assignee { id isMe }
  labels { nodes { name } }
  inverseRelations(first: $relationFirst) {
    nodes {
      type
      issue { id identifier state { name } }
    }
    pageInfo { hasNextPage }
  }
  createdAt
  updatedAt
`;

const ISSUES_BY_STATES_QUERY = `
  query SymphonyLinearPoll(
    $projectSlug: String!
    $stateNames: [String!]!
    $assigneeFilter: NullableUserFilter
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      filter: {
        project: {slugId: {eq: $projectSlug}}
        state: {name: {in: $stateNames}}
        assignee: $assigneeFilter
      }
      first: $first
      after: $after
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_BY_IDS_QUERY = `
  query SymphonyLinearIssuesById(
    $ids: [ID!]!
    $projectSlug: String!
    $first: Int!
    $relationFirst: Int!
  ) {
    issues(
      filter: {
        id: {in: $ids}
        project: {slugId: {eq: $projectSlug}}
      }
      first: $first
    ) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;

const rfc3339 = z.string().datetime({ offset: true });

interface LinearSettings {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  assignee: string | null;
}

export interface LinearClientLike {
  client: {
    rawRequest(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  };
}

export type LinearClientFactory = (options: LinearClientOptions) => LinearClientLike;

export interface LinearTrackerDependencies {
  clientFactory?: LinearClientFactory;
  terminalStates?: string[];
}

export class LinearTracker implements Tracker {
  readonly #settings: LinearSettings;
  readonly #clientFactory: LinearClientFactory;
  readonly #terminalStates: ReadonlySet<string>;

  constructor(
    provider: Record<string, unknown>,
    dependencies: LinearTrackerDependencies = {},
  ) {
    this.#settings = parseSettings(provider);
    this.#terminalStates = normalizeTerminalStates(
      dependencies.terminalStates ?? DEFAULT_TERMINAL_STATES,
    );
    this.#clientFactory = dependencies.clientFactory ?? defaultClientFactory;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const stateNames = uniqueStates(normalizeInputs(states, "state"));
    if (stateNames.length === 0) return [];

    const requestedStates = new Set(stateNames.map(normalizeState));
    const issues: Issue[] = [];
    const visitedCursors = new Set<string>();
    let after: string | null = null;
    let pageCount = 0;

    for (;;) {
      if (pageCount >= MAX_PAGES) {
        throw new Error(`Linear issue pagination exceeded ${MAX_PAGES} pages`);
      }
      pageCount += 1;
      const data = await this.#request(ISSUES_BY_STATES_QUERY, {
        projectSlug: this.#settings.projectSlug,
        stateNames,
        assigneeFilter: assigneeFilter(this.#settings.assignee),
        first: PAGE_SIZE,
        relationFirst: PAGE_SIZE,
        after,
      });
      const connection = issueConnection(data);

      for (const raw of connection.nodes) {
        const issue = normalizeIssue(raw, this.#settings.assignee, this.#terminalStates);
        if (issue !== null && requestedStates.has(normalizeState(issue.state))) issues.push(issue);
      }

      const next = nextCursor(connection.pageInfo);
      if (next === null) return issues;
      if (visitedCursors.has(next)) {
        throw new Error("Linear issue pagination cursor loop detected");
      }
      visitedCursors.add(next);
      after = next;
    }
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const uniqueIds = normalizeInputs(ids, "issue id");
    if (uniqueIds.length === 0) return [];

    const issues: Issue[] = [];

    for (let offset = 0; offset < uniqueIds.length; offset += PAGE_SIZE) {
      const batch = uniqueIds.slice(offset, offset + PAGE_SIZE);
      const data = await this.#request(ISSUES_BY_IDS_QUERY, {
        ids: batch,
        projectSlug: this.#settings.projectSlug,
        first: batch.length,
        relationFirst: PAGE_SIZE,
      });
      const nodes = issueNodes(data);
      const byId = new Map<string, Issue>();

      for (const raw of nodes) {
        const issue = normalizeIssue(raw, this.#settings.assignee, this.#terminalStates);
        if (issue === null) {
          throw new Error("Linear returned a malformed issue during ID refresh");
        }
        if (!batch.includes(issue.id) || byId.has(issue.id)) {
          throw new Error("Linear returned an unexpected issue during ID refresh");
        }
        byId.set(issue.id, issue);
      }

      for (const id of batch) {
        const issue = byId.get(id);
        if (issue !== undefined) issues.push(issue);
      }
    }

    return issues;
  }

  async #request(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: unknown;
    try {
      const client = this.#clientFactory({
        apiKey: this.#settings.apiKey,
        apiUrl: this.#settings.endpoint,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      response = await client.client.rawRequest(query, variables);
    } catch {
      throw new Error("Linear GraphQL request failed");
    }

    if (!isRecord(response)) throw new Error("Linear GraphQL returned an invalid response");
    if (!isRecord(response.data)) throw new Error("Linear GraphQL response is missing data");
    return response.data;
  }
}

export function validateLinearProvider(provider: Record<string, unknown>): void {
  parseSettings(provider, false);
}

function defaultClientFactory(options: LinearClientOptions): LinearClientLike {
  return new LinearClient(options);
}

function parseSettings(
  provider: Record<string, unknown>,
  materializeApiKey = true,
): LinearSettings {
  const unknownKeys = Object.keys(provider).filter(
    (key) => !["endpoint", "api_key", "project_slug", "assignee"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported Linear tracker provider option(s): ${unknownKeys.sort().join(", ")}`);
  }

  const endpoint = normalizeEndpoint(provider.endpoint);
  const apiKeyReference = apiKeyEnvironmentReference(provider.api_key);
  const apiKey = materializeApiKey ? resolveApiKey(apiKeyReference) : apiKeyReference;
  const projectSlug = requiredProjectSlug(provider.project_slug);
  const assignee = optionalAssignee(provider.assignee);
  return { endpoint, apiKey, projectSlug, assignee };
}

function normalizeEndpoint(value: unknown): string {
  const raw = value ?? DEFAULT_ENDPOINT;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Linear tracker provider.endpoint must be an HTTPS URL");
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Linear tracker provider.endpoint must be an HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Linear tracker provider.endpoint must be an HTTPS URL without credentials, query, or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function requiredProjectSlug(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Linear tracker provider.project_slug must be a non-empty string");
  }
  return value.trim();
}

function apiKeyEnvironmentReference(value: unknown): string {
  const reference = value ?? DEFAULT_API_KEY_REFERENCE;
  if (typeof reference !== "string" || !ENV_REFERENCE.test(reference.trim())) {
    throw new Error(
      "Linear tracker provider.api_key must be an environment reference such as $LINEAR_API_KEY",
    );
  }
  return reference.trim();
}

function resolveApiKey(reference: string): string {
  const environmentName = ENV_REFERENCE.exec(reference)?.[1];
  if (environmentName === undefined) throw new Error("Linear API key environment reference is invalid");
  const apiKey = process.env[environmentName]?.trim();
  if (!apiKey) throw new Error(`Linear API key environment variable ${environmentName} is not set`);
  return apiKey;
}

function optionalAssignee(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Linear tracker provider.assignee must be a non-empty Linear user ID or 'me'");
  }
  const assignee = value.trim();
  return assignee.toLowerCase() === "me" ? "me" : assignee;
}

function assigneeFilter(assignee: string | null): Record<string, unknown> | null {
  if (assignee === null) return null;
  return assignee === "me" ? { isMe: { eq: true } } : { id: { eq: assignee } };
}

function normalizeInputs(values: string[], label: "state" | "issue id"): string[] {
  const unique = new Set<string>();
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Linear tracker ${label} at index ${index} must be a non-empty string`);
    }
    unique.add(value.trim());
  });
  return [...unique];
}

function normalizeTerminalStates(states: string[]): ReadonlySet<string> {
  return new Set(normalizeInputs(states, "state").map(normalizeState));
}

function uniqueStates(states: string[]): string[] {
  const seen = new Set<string>();
  return states.filter((state) => {
    const normalized = normalizeState(state);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function issueConnection(data: Record<string, unknown>): {
  nodes: unknown[];
  pageInfo: Record<string, unknown>;
} {
  if (!isRecord(data.issues) || !Array.isArray(data.issues.nodes) || !isRecord(data.issues.pageInfo)) {
    throw new Error("Linear GraphQL returned an invalid issue page");
  }
  return { nodes: data.issues.nodes, pageInfo: data.issues.pageInfo };
}

function issueNodes(data: Record<string, unknown>): unknown[] {
  if (!isRecord(data.issues) || !Array.isArray(data.issues.nodes)) {
    throw new Error("Linear GraphQL returned an invalid issue list");
  }
  return data.issues.nodes;
}

function nextCursor(pageInfo: Record<string, unknown>): string | null {
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error("Linear issue pagination is missing hasNextPage");
  }
  if (!pageInfo.hasNextPage) return null;
  if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.trim() === "") {
    throw new Error("Linear issue pagination is missing endCursor");
  }
  return pageInfo.endCursor;
}

function normalizeIssue(
  raw: unknown,
  routingAssignee: string | null,
  terminalStates: ReadonlySet<string>,
): Issue | null {
  if (!isRecord(raw) || !isRecord(raw.state)) return null;

  const id = optionalString(raw.id);
  const identifier = optionalString(raw.identifier);
  const title = optionalString(raw.title);
  const state = optionalString(raw.state.name);
  if (id === null || identifier === null || title === null || state === null) return null;

  const assigneeId = isRecord(raw.assignee) ? optionalString(raw.assignee.id) : null;
  const routed = routingAssignee === null || (
    routingAssignee === "me"
      ? isRecord(raw.assignee) && raw.assignee.isMe === true
      : assigneeId === routingAssignee
  );
  const { blockers, incomplete } = extractBlockers(raw.inverseRelations);
  const blocked = normalizeState(state) === "todo" && (
    incomplete || blockers.some(({ state: blockerState }) =>
      blockerState === null || !terminalStates.has(normalizeState(blockerState)))
  );

  return {
    id,
    nativeRef: null,
    identifier,
    title,
    description: typeof raw.description === "string" ? raw.description : null,
    priority: typeof raw.priority === "number" && Number.isSafeInteger(raw.priority) ? raw.priority : null,
    state,
    branchName: optionalString(raw.branchName),
    url: optionalUrl(raw.url),
    assigneeId,
    labels: extractLabels(raw.labels),
    blockedBy: blockers,
    dispatchable: routed && !blocked,
    createdAt: optionalTimestamp(raw.createdAt),
    updatedAt: optionalTimestamp(raw.updatedAt),
  };
}

function extractLabels(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return [];
  const labels = value.nodes.flatMap((label) => {
    if (!isRecord(label) || typeof label.name !== "string") return [];
    const name = label.name.trim().toLowerCase();
    return name ? [name] : [];
  });
  return [...new Set(labels)];
}

function extractBlockers(value: unknown): { blockers: BlockerRef[]; incomplete: boolean } {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return { blockers: [], incomplete: true };
  const blockers: BlockerRef[] = [];
  let malformedRelation = false;
  for (const relation of value.nodes) {
    if (!isRecord(relation) || typeof relation.type !== "string") {
      malformedRelation = true;
      continue;
    }
    if (normalizeState(relation.type) !== "blocks") continue;
    if (!isRecord(relation.issue)) {
      malformedRelation = true;
      continue;
    }
    blockers.push({
      id: optionalString(relation.issue.id),
      identifier: optionalString(relation.issue.identifier),
      state: isRecord(relation.issue.state) ? optionalString(relation.issue.state.name) : null,
    });
  }
  const pageInfo = isRecord(value.pageInfo) ? value.pageInfo : null;
  const pageInfoComplete = pageInfo !== null && typeof pageInfo.hasNextPage === "boolean";
  const incomplete = malformedRelation || !pageInfoComplete || pageInfo?.hasNextPage === true;
  return { blockers, incomplete };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "") return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "http:" || url.protocol === "https:" ? normalized : null;
  } catch {
    return null;
  }
}

function optionalTimestamp(value: unknown): string | null {
  return rfc3339.safeParse(value).success ? value as string : null;
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
