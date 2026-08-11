import { LinearClient, LinearError, LinearErrorType, type LinearClientOptions } from "@linear/sdk";
import { z } from "zod";
import type {
  BlockerRef,
  Issue,
  IssueMutation,
  IssueMutationOptions,
  Tracker,
} from "@ai-symphony/core/domain.js";
import type { AppLogger } from "@ai-symphony/core/log.js";
import { asInvalidTrackerConfig, TrackerError } from "./error.js";
import {
  assertKnownKeys,
  ENV_REFERENCE,
  IDEMPOTENCY_KEY,
  isRecord,
  normalizeHttpUrl,
  normalizeToken,
  REQUEST_TIMEOUT_MS,
  sameRoutingSnapshot,
} from "./internal.js";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_API_KEY_REFERENCE = "$LINEAR_API_KEY";
const PAGE_SIZE = 50;
const MAX_PAGES = 1_000;
const MAX_COMMENT_LENGTH = 65_536;
const MAX_LABEL_LENGTH = 50;
const MAX_STATE_LENGTH = 100;
const DEFAULT_TERMINAL_STATES = ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"];

const linearMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comment"),
    body: z.string().max(MAX_COMMENT_LENGTH).refine((body) => body.trim() !== ""),
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional(),
  }).strict(),
  z.object({
    kind: z.literal("add_label"),
    label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  }).strict(),
  z.object({
    kind: z.literal("remove_label"),
    label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  }).strict(),
  z.object({
    kind: z.literal("set_state"),
    state: z.string().trim().min(1).max(MAX_STATE_LENGTH),
  }).strict(),
]);

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

type CommentsQueryInput = NonNullable<Parameters<LinearClient["comments"]>[0]>;
type WorkflowStatesQueryInput = NonNullable<Parameters<LinearClient["workflowStates"]>[0]>;
type IssueLabelsQueryInput = NonNullable<Parameters<LinearClient["issueLabels"]>[0]>;
type CommentCreateInput = Parameters<LinearClient["createComment"]>[0];
type CommentUpdateInput = Parameters<LinearClient["updateComment"]>[1];
type IssueUpdateInput = Parameters<LinearClient["updateIssue"]>[1];

export interface LinearClientLike {
  client: {
    rawRequest(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  };
  issue(id: string): PromiseLike<LinearIssueLike>;
  comments(variables: CommentsQueryInput): PromiseLike<LinearConnectionLike<LinearCommentLike>>;
  workflowStates(
    variables: WorkflowStatesQueryInput,
  ): PromiseLike<LinearConnectionLike<LinearWorkflowStateLike>>;
  issueLabels(
    variables: IssueLabelsQueryInput,
  ): PromiseLike<LinearConnectionLike<LinearIssueLabelLike>>;
  createComment(input: CommentCreateInput): PromiseLike<LinearCommentPayloadLike>;
  updateComment(id: string, input: CommentUpdateInput): PromiseLike<LinearCommentPayloadLike>;
  updateIssue(id: string, input: IssueUpdateInput): PromiseLike<LinearIssuePayloadLike>;
  issueAddLabel(id: string, labelId: string): PromiseLike<LinearIssuePayloadLike>;
  issueRemoveLabel(id: string, labelId: string): PromiseLike<LinearIssuePayloadLike>;
}

interface LinearConnectionLike<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
}

interface LinearIssueLike {
  id: string;
  identifier: string;
  archivedAt?: Date | null | undefined;
  trashed?: boolean | null | undefined;
  assigneeId?: string | undefined;
  labelIds: string[];
  projectId?: string | undefined;
  stateId?: string | undefined;
  teamId?: string | undefined;
  project?: PromiseLike<{
    id: string;
    slugId: string;
    archivedAt?: Date | null | undefined;
    trashed?: boolean | null | undefined;
  }> | undefined;
}

interface LinearCommentLike {
  id: string;
  body: string;
  issueId?: string | null | undefined;
}

interface LinearWorkflowStateLike {
  id: string;
  name: string;
  archivedAt?: Date | null | undefined;
  teamId?: string | undefined;
}

interface LinearIssueLabelLike {
  id: string;
  name: string;
  archivedAt?: Date | null | undefined;
  isGroup: boolean;
  teamId?: string | undefined;
}

interface LinearCommentPayloadLike {
  success: boolean;
  commentId?: string | undefined;
}

interface LinearIssuePayloadLike {
  success: boolean;
  issueId?: string | undefined;
}

export type LinearClientFactory = (options: LinearClientOptions) => LinearClientLike;

export interface LinearTrackerDependencies {
  clientFactory?: LinearClientFactory;
  logger?: Pick<AppLogger, "warn">;
  terminalStates?: string[];
}

export class LinearTracker implements Tracker {
  readonly issueStateMutationMode = "named" as const;
  readonly #settings: LinearSettings;
  readonly #clientFactory: LinearClientFactory;
  readonly #logger: Pick<AppLogger, "warn"> | undefined;
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
    this.#logger = dependencies.logger;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const stateNames = uniqueStates(normalizeInputs(states, "state"));
    if (stateNames.length === 0) return [];

    const requestedStates = new Set(stateNames.map(normalizeToken));
    const issues: Issue[] = [];
    const visitedCursors = new Set<string>();
    let after: string | null = null;
    let pageCount = 0;

    for (;;) {
      if (pageCount >= MAX_PAGES) {
        throw new TrackerError(
          "tracker_pagination",
          `Linear issue pagination exceeded ${MAX_PAGES} pages`,
        );
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

      let malformedCount = 0;
      for (const raw of connection.nodes) {
        const issue = normalizeIssue(raw, this.#settings.assignee, this.#terminalStates);
        if (issue === null) {
          malformedCount += 1;
        } else if (requestedStates.has(normalizeToken(issue.state))) {
          issues.push(issue);
        }
      }
      if (malformedCount > 0) {
        this.#logger?.warn(
          { malformed_count: malformedCount },
          "Dropping malformed Linear issue records",
        );
      }

      const next = nextCursor(connection.pageInfo);
      if (next === null) return issues;
      if (visitedCursors.has(next)) {
        throw new TrackerError(
          "tracker_pagination",
          "Linear issue pagination cursor loop detected",
        );
      }
      visitedCursors.add(next);
      after = next;
    }
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return this.#fetchIssuesByIds(ids);
  }

  async #fetchIssuesByIds(ids: string[], signal?: AbortSignal): Promise<Issue[]> {
    const uniqueIds = normalizeInputs(ids, "issue id");
    if (uniqueIds.length === 0) return [];

    const issues: Issue[] = [];

    for (let offset = 0; offset < uniqueIds.length; offset += PAGE_SIZE) {
      const batch = uniqueIds.slice(offset, offset + PAGE_SIZE);
      const requestedIds = new Set(batch);
      const data = await this.#request(ISSUES_BY_IDS_QUERY, {
        ids: batch,
        projectSlug: this.#settings.projectSlug,
        first: batch.length,
        relationFirst: PAGE_SIZE,
      }, signal);
      const nodes = issueNodes(data);
      const byId = new Map<string, Issue>();

      for (const raw of nodes) {
        const issue = normalizeIssue(raw, this.#settings.assignee, this.#terminalStates);
        if (issue === null) {
          throw new TrackerError(
            "tracker_response",
            "Linear returned a malformed issue during ID refresh",
          );
        }
        if (!requestedIds.has(issue.id) || byId.has(issue.id)) {
          throw new TrackerError(
            "tracker_response",
            "Linear returned an unexpected issue during ID refresh",
          );
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

  async mutateIssue(
    issue: Issue,
    mutation: IssueMutation,
    signal: AbortSignal,
    options: IssueMutationOptions = {},
  ): Promise<void> {
    const validated = validateMutation(mutation);
    const boundIssue = bindLinearIssue(issue);
    if (signal.aborted) throw new Error("Linear issue mutation was aborted");

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const operationSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const client = this.#clientFactory({
        apiKey: this.#settings.apiKey,
        apiUrl: this.#settings.endpoint,
        signal: operationSignal,
      });
      const current = await client.issue(boundIssue.id);
      const context = await mutationContext(current, boundIssue, this.#settings);

      if (validated.kind === "comment") {
        await mutateComment(client, context.issueId, validated, operationSignal);
        return;
      }

      if (validated.kind === "set_state") {
        const stateId = workflowStateId(
          await client.workflowStates({
            first: 2,
            includeArchived: false,
            filter: {
              name: { eqIgnoreCase: validated.state },
              team: { id: { eq: context.teamId } },
            },
          }),
          validated.state,
          context.teamId,
        );
        if (options.requireUnchanged === true) {
          const [refreshed] = await this.#fetchIssuesByIds([context.issueId], operationSignal);
          if (refreshed === undefined || !sameRoutingSnapshot(issue, refreshed)) {
            throw new Error("Linear issue changed before state mutation");
          }
          if (normalizeToken(refreshed.state) === normalizeToken(validated.state)) return;
        } else if (current.stateId === stateId) {
          return;
        }
        operationSignal.throwIfAborted();
        // ponytail: Linear has no conditional update; revalidate as close to this write as its API permits.
        assertIssuePayload(
          await client.updateIssue(context.issueId, { stateId }),
          context.issueId,
        );
        return;
      }

      const labelId = issueLabelId(
        await client.issueLabels({
          first: 2,
          includeArchived: false,
          filter: {
            name: { eqIgnoreCase: validated.label },
            isGroup: { eq: false },
            or: [
              { team: { id: { eq: context.teamId } } },
              { team: { null: true } },
            ],
          },
        }),
        validated.label,
        context.teamId,
      );
      const attached = current.labelIds.includes(labelId);
      if (validated.kind === "add_label" && attached) return;
      if (validated.kind === "remove_label" && !attached) return;
      operationSignal.throwIfAborted();
      const payload = validated.kind === "add_label"
        ? await client.issueAddLabel(context.issueId, labelId)
        : await client.issueRemoveLabel(context.issueId, labelId);
      assertIssuePayload(payload, context.issueId);
    } catch {
      if (signal.aborted) throw new Error("Linear issue mutation was aborted");
      if (timeoutSignal.aborted) throw new Error("Linear issue mutation timed out");
      throw new Error("Linear issue mutation failed");
    }
  }

  async #request(
    query: string,
    variables: Record<string, unknown>,
    signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<Record<string, unknown>> {
    let response: unknown;
    try {
      const client = this.#clientFactory({
        apiKey: this.#settings.apiKey,
        apiUrl: this.#settings.endpoint,
        signal,
      });
      response = await client.client.rawRequest(query, variables);
    } catch (error) {
      throw linearRequestError(error);
    }

    if (!isRecord(response)) {
      throw new TrackerError("tracker_response", "Linear GraphQL returned an invalid response");
    }
    if (!isRecord(response.data)) {
      throw new TrackerError("tracker_response", "Linear GraphQL response is missing data");
    }
    return response.data;
  }
}

function linearRequestError(error: unknown): TrackerError {
  const message = "Linear GraphQL request failed";
  if (error instanceof TrackerError) return new TrackerError(error.category, message);
  if (error instanceof SyntaxError) return new TrackerError("tracker_response", message);
  if (!(error instanceof LinearError)) {
    return new TrackerError("tracker_request", message);
  }
  if (error.type === LinearErrorType.Ratelimited || error.status === 429) {
    return new TrackerError("tracker_rate_limited", message);
  }
  if (
    typeof error.status === "number" &&
    error.status >= 100 &&
    (error.status < 200 || error.status >= 300)
  ) {
    return new TrackerError("tracker_status", message);
  }
  return new TrackerError("tracker_response", message);
}

type ValidMutation = z.infer<typeof linearMutationSchema>;

function validateMutation(mutation: IssueMutation): ValidMutation {
  const result = linearMutationSchema.safeParse(mutation);
  if (!result.success) throw new Error("Invalid Linear issue mutation");
  return result.data;
}

interface MutationContext {
  issueId: string;
  teamId: string;
}

interface BoundLinearIssue {
  id: string;
  identifier: string;
  assigneeId: string | null;
}

function bindLinearIssue(issue: Issue): BoundLinearIssue {
  const id = optionalString(issue.id);
  const identifier = optionalString(issue.identifier);
  if (issue.nativeRef !== null || id === null || identifier === null) {
    throw new Error("Issue is not bound to this Linear tracker");
  }
  return { id, identifier, assigneeId: optionalString(issue.assigneeId) };
}

async function mutationContext(
  current: LinearIssueLike,
  issue: BoundLinearIssue,
  settings: LinearSettings,
): Promise<MutationContext> {
  const teamId = optionalString(current.teamId);
  const projectId = optionalString(current.projectId);
  if (
    optionalString(current.id) !== issue.id ||
    optionalString(current.identifier) !== issue.identifier ||
    teamId === null ||
    projectId === null ||
    current.archivedAt != null ||
    current.trashed === true ||
    !Array.isArray(current.labelIds) ||
    current.labelIds.some((id) => optionalString(id) === null)
  ) {
    throw new Error("Linear issue is no longer safe to mutate");
  }

  const project = await current.project;
  if (
    project === undefined ||
    optionalString(project.id) !== projectId ||
    optionalString(project.slugId) !== settings.projectSlug ||
    project.archivedAt != null ||
    project.trashed === true
  ) {
    throw new Error("Linear issue is outside the configured project");
  }

  if (settings.assignee !== null) {
    const expectedAssignee = settings.assignee === "me" ? issue.assigneeId : settings.assignee;
    if (expectedAssignee === null || optionalString(current.assigneeId) !== expectedAssignee) {
      throw new Error("Linear issue is no longer assigned to the configured user");
    }
  }
  return { issueId: issue.id, teamId };
}

async function mutateComment(
  client: LinearClientLike,
  issueId: string,
  mutation: Extract<ValidMutation, { kind: "comment" }>,
  signal: AbortSignal,
): Promise<void> {
  const idempotencyKey = mutation.idempotencyKey;
  if (idempotencyKey !== undefined) {
    const existing = await client.comments({
      first: 2,
      includeArchived: true,
      filter: { id: { eq: idempotencyKey } },
    });
    assertCompleteConnection(existing);
    if (existing.nodes.length > 1) throw new Error("Linear comment lookup was ambiguous");
    const comment = existing.nodes[0];
    if (comment !== undefined) {
      if (
        optionalString(comment.id) !== idempotencyKey ||
        optionalString(comment.issueId) !== issueId
      ) {
        throw new Error("Linear comment idempotency key is already in use");
      }
      if (comment.body === mutation.body) return;
      signal.throwIfAborted();
      assertCommentPayload(
        await client.updateComment(idempotencyKey, { body: mutation.body }),
        idempotencyKey,
      );
      return;
    }
  }

  signal.throwIfAborted();
  const input: CommentCreateInput = { issueId, body: mutation.body };
  if (idempotencyKey !== undefined) input.id = idempotencyKey;
  const payload = await client.createComment(input);
  assertCommentPayload(payload, idempotencyKey);
}

function workflowStateId(
  connection: LinearConnectionLike<LinearWorkflowStateLike>,
  stateName: string,
  teamId: string,
): string {
  assertCompleteConnection(connection);
  if (connection.nodes.length !== 1) throw new Error("Linear workflow state lookup was not unique");
  const [state] = connection.nodes;
  if (
    state === undefined ||
    optionalString(state.id) === null ||
    normalizeToken(state.name) !== normalizeToken(stateName) ||
    optionalString(state.teamId) !== teamId ||
    state.archivedAt != null
  ) {
    throw new Error("Linear returned an invalid workflow state");
  }
  return state.id;
}

function issueLabelId(
  connection: LinearConnectionLike<LinearIssueLabelLike>,
  labelName: string,
  teamId: string,
): string {
  assertCompleteConnection(connection);
  if (connection.nodes.length !== 1) throw new Error("Linear issue label lookup was not unique");
  const [label] = connection.nodes;
  if (
    label === undefined ||
    optionalString(label.id) === null ||
    normalizeToken(label.name) !== normalizeToken(labelName) ||
    label.isGroup !== false ||
    label.archivedAt != null ||
    (label.teamId !== undefined && optionalString(label.teamId) !== teamId)
  ) {
    throw new Error("Linear returned an invalid issue label");
  }
  return label.id;
}

function assertCompleteConnection<T>(connection: LinearConnectionLike<T>): void {
  if (
    !isRecord(connection) ||
    !Array.isArray(connection.nodes) ||
    !isRecord(connection.pageInfo) ||
    connection.pageInfo.hasNextPage !== false
  ) {
    throw new Error("Linear lookup returned an incomplete result");
  }
}

function assertCommentPayload(payload: LinearCommentPayloadLike, expectedId?: string): void {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    optionalString(payload.commentId) === null ||
    (expectedId !== undefined && payload.commentId !== expectedId)
  ) {
    throw new Error("Linear comment mutation did not succeed");
  }
}

function assertIssuePayload(payload: LinearIssuePayloadLike, issueId: string): void {
  if (!isRecord(payload) || payload.success !== true || payload.issueId !== issueId) {
    throw new Error("Linear issue mutation did not succeed");
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
  try {
    assertKnownKeys(provider, ["endpoint", "api_key", "project_slug", "assignee"], "Linear tracker provider");

    const endpoint = normalizeHttpUrl(
      provider.endpoint,
      DEFAULT_ENDPOINT,
      "Linear tracker provider.endpoint",
      ["https:"],
    );
    const apiKeyReference = apiKeyEnvironmentReference(provider.api_key);
    const apiKey = materializeApiKey ? resolveApiKey(apiKeyReference) : apiKeyReference;
    const projectSlug = requiredProjectSlug(provider.project_slug);
    const assignee = optionalAssignee(provider.assignee);
    return { endpoint, apiKey, projectSlug, assignee };
  } catch (error) {
    throw asInvalidTrackerConfig(
      error,
      "Linear tracker provider configuration is invalid",
    );
  }
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
  if (!apiKey) {
    throw new TrackerError(
      "missing_tracker_secret",
      `Linear API key environment variable ${environmentName} is not set`,
    );
  }
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

function assigneeFilter(assignee: string | null): Record<string, unknown> {
  if (assignee === null) return {};
  return assignee === "me" ? { isMe: { eq: true } } : { id: { eq: assignee } };
}

function normalizeInputs(values: string[], label: "state" | "issue id"): string[] {
  const unique = new Set<string>();
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TrackerError(
        "invalid_tracker_config",
        `Linear tracker ${label} at index ${index} must be a non-empty string`,
      );
    }
    unique.add(value.trim());
  });
  return [...unique];
}

function normalizeTerminalStates(states: string[]): ReadonlySet<string> {
  return new Set(normalizeInputs(states, "state").map(normalizeToken));
}

function uniqueStates(states: string[]): string[] {
  const seen = new Set<string>();
  return states.filter((state) => {
    const normalized = normalizeToken(state);
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
    throw new TrackerError("tracker_response", "Linear GraphQL returned an invalid issue page");
  }
  return { nodes: data.issues.nodes, pageInfo: data.issues.pageInfo };
}

function issueNodes(data: Record<string, unknown>): unknown[] {
  if (!isRecord(data.issues) || !Array.isArray(data.issues.nodes)) {
    throw new TrackerError("tracker_response", "Linear GraphQL returned an invalid issue list");
  }
  return data.issues.nodes;
}

function nextCursor(pageInfo: Record<string, unknown>): string | null {
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new TrackerError(
      "tracker_pagination",
      "Linear issue pagination is missing hasNextPage",
    );
  }
  if (!pageInfo.hasNextPage) return null;
  if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.trim() === "") {
    throw new TrackerError(
      "tracker_pagination",
      "Linear issue pagination is missing endCursor",
    );
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
  const blocked = normalizeToken(state) === "todo" && (
    incomplete || blockers.some(({ state: blockerState }) =>
      blockerState === null || !terminalStates.has(normalizeToken(blockerState)))
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
    if (normalizeToken(relation.type) !== "blocks") continue;
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
