import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildClaudeEnvironment,
  ClaudeAgentDriver,
  createIssueMutationTools,
  createIssueToolOptions,
  createPublishChangeTools,
  createWorkspacePermissionPolicy,
  issueToolNames,
  normalizeClaudeMessage,
  selectIssueTools,
} from "../src/agents/claude.js";
import type {
  AgentEvent,
  AgentRunContext,
  Issue,
  IssueMutation,
  PublishChangeInput,
} from "../src/domain.js";

test("normalizes Claude result usage as absolute totals", () => {
  const events = normalizeClaudeMessage({
    type: "result",
    subtype: "success",
    session_id: "session-1",
    result: "done",
    permission_denials: [],
    modelUsage: {
      sonnet: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        costUSD: 0.02,
      },
    },
  } as unknown as SDKMessage);

  assert.deepEqual(events.map((event) => event.type), ["usage_updated", "turn_completed"]);
  assert.deepEqual(events[0]?.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 2,
    totalTokens: 20,
    costUsd: 0.02,
  });
});

test("validates Claude structured completion without exposing the raw result", () => {
  const events = normalizeClaudeMessage(
    {
      type: "result",
      subtype: "success",
      session_id: "session-1",
      result: "private raw result",
      structured_output: {
        status: "ready",
        summary: "Implemented and verified the change",
        verification: ["pnpm test"],
      },
      permission_denials: [],
      modelUsage: {},
    } as unknown as SDKMessage,
    "publish_change",
  );

  assert.deepEqual(events.map(({ type }) => type), ["usage_updated", "turn_completed"]);
  assert.deepEqual(events[1]?.completion, {
    status: "ready",
    summary: "Implemented and verified the change",
    verification: ["pnpm test"],
  });
  assert.equal(events[1]?.summary, "Implemented and verified the change");
  assert.equal(events.some(({ summary }) => summary?.includes("private raw result")), false);
});

test("fails Claude completion mode once for missing or invalid structured output", () => {
  for (const structured_output of [undefined, { status: "ready", summary: "Done", verification: [] }]) {
    const events = normalizeClaudeMessage(
      {
        type: "result",
        subtype: "success",
        session_id: "session-1",
        result: "private raw result",
        structured_output,
        permission_denials: [],
        modelUsage: {},
      } as unknown as SDKMessage,
      "publish_change",
    );

    assert.equal(events.filter(({ type }) => type === "turn_failed").length, 1);
    assert.equal(events.filter(({ type }) => type === "turn_completed").length, 0);
    assert.equal(events.some(({ summary }) => summary?.includes("private raw result")), false);
  }

  const sdkFailure = normalizeClaudeMessage(
    {
      type: "result",
      subtype: "error_max_structured_output_retries",
      session_id: "session-1",
      permission_denials: [],
      modelUsage: {},
      errors: ["private malformed model output"],
    } as unknown as SDKMessage,
    "publish_change",
  );
  assert.equal(sdkFailure.filter(({ type }) => type === "turn_failed").length, 1);
  assert.equal(sdkFailure.some(({ summary }) => summary?.includes("private malformed model output")), false);
});

test("maps Claude permission denials to a fail-closed approval event", () => {
  const events = normalizeClaudeMessage({
    type: "result",
    subtype: "success",
    session_id: "session-1",
    result: "partial",
    permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }],
    modelUsage: {},
  } as unknown as SDKMessage);

  assert.deepEqual(events.map((event) => event.type), ["usage_updated", "approval_required", "turn_completed"]);
  assert.match(events[1]?.summary ?? "", /Bash/);
});

test("maps otherwise-unhandled Claude output to activity for silence-timeout accounting", () => {
  const events = normalizeClaudeMessage({
    type: "tool_progress",
    session_id: "session-1",
  } as unknown as SDKMessage);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "activity");
});

test("invalid dangerous Claude options yield exactly one terminal event without spawning Claude", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "symphony-claude-"));
  const driver = new ClaudeAgentDriver();
  const controller = new AbortController();
  const context: AgentRunContext = {
    issue: sampleIssue,
    workspacePath,
    prompt: "Do the task",
    attempt: null,
    continuation: 0,
    signal: controller.signal,
    runtimeOptions: { permission_mode: "bypassPermissions" },
  };
  const events: AgentEvent[] = [];
  for await (const event of driver.run(context)) events.push(event);

  assert.equal(events.filter((event) => event.type === "turn_failed").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 0);
  assert.match(events[0]?.summary ?? "", /unsupported/);
});

test("workspace permission policy confines default file tools and denies unlisted tools", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "symphony-claude-policy-"));
  const workspacePath = path.join(parent, "workspace");
  const outsideDirectory = path.join(parent, "outside-directory");
  const outsidePath = path.join(parent, "outside.txt");
  await mkdir(workspacePath);
  await mkdir(path.join(outsideDirectory, "child"), { recursive: true });
  await writeFile(outsidePath, "secret");
  await symlink(outsidePath, path.join(workspacePath, "escape.txt"));
  await symlink(path.join(outsideDirectory, "child"), path.join(workspacePath, "escape-directory"));
  const policy = createWorkspacePermissionPolicy(workspacePath, ["Read", "Edit", "Write", "Glob", "Grep"]);
  const options = {
    signal: new AbortController().signal,
    toolUseID: "tool-1",
    requestId: "request-1",
  };

  assert.equal((await policy("Write", { file_path: path.join(workspacePath, "new.txt") }, options))?.behavior, "allow");
  assert.equal((await policy("Read", { file_path: outsidePath }, options))?.behavior, "deny");
  assert.equal(
    (await policy("Read", { file_path: path.join(workspacePath, "escape.txt") }, options))?.behavior,
    "deny",
  );
  assert.equal(
    (
      await policy(
        "Read",
        { file_path: `${workspacePath}${path.sep}escape-directory${path.sep}..${path.sep}outside.txt` },
        options,
      )
    )?.behavior,
    "deny",
  );
  assert.equal((await policy("Glob", { pattern: "../*" }, options))?.behavior, "deny");
  assert.equal((await policy("Glob", { pattern: "{../*,src/*}" }, options))?.behavior, "deny");
  assert.equal((await policy("Bash", { command: "pwd" }, options))?.behavior, "deny");
  assert.equal(
    (await createWorkspacePermissionPolicy(workspacePath, ["Bash"])("Bash", { command: "pwd" }, options))
      ?.behavior,
    "allow",
  );
  const issuePolicy = createWorkspacePermissionPolicy(workspacePath, [issueToolNames.comment]);
  assert.equal((await issuePolicy(issueToolNames.comment, {}, options))?.behavior, "allow");
  assert.equal((await issuePolicy(issueToolNames.setState, {}, options))?.behavior, "deny");
});

test("Claude child environment strips unrelated host secrets unless explicitly allowed", () => {
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  const previousGithub = process.env.GITHUB_TOKEN;
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  process.env.GITHUB_TOKEN = "github-test";
  try {
    const safe = buildClaudeEnvironment([]);
    assert.equal(safe.ANTHROPIC_API_KEY, "anthropic-test");
    assert.equal(safe.GITHUB_TOKEN, undefined);
    assert.equal(buildClaudeEnvironment(["GITHUB_TOKEN"]).GITHUB_TOKEN, "github-test");
  } finally {
    restoreEnvironment("ANTHROPIC_API_KEY", previousAnthropic);
    restoreEnvironment("GITHUB_TOKEN", previousGithub);
  }
});

test("Claude sensitive environment names override defaults and explicit allowlists case-insensitively", () => {
  const previousGithub = process.env.GITHUB_TOKEN;
  const previousPath = process.env.PATH;
  process.env.GITHUB_TOKEN = "github-test";
  process.env.PATH = "path-test";
  try {
    const safe = buildClaudeEnvironment(["GITHUB_TOKEN"], ["github_token", "path"]);
    assert.equal(safe.GITHUB_TOKEN, undefined);
    assert.equal(safe.PATH, undefined);
    assert.equal(
      buildClaudeEnvironment([], ["claude_agent_sdk_client_app"]).CLAUDE_AGENT_SDK_CLIENT_APP,
      undefined,
    );
  } finally {
    restoreEnvironment("GITHUB_TOKEN", previousGithub);
    restoreEnvironment("PATH", previousPath);
  }
});

test("current-issue tools are exact opt-ins and bind mutation targets outside model input", async () => {
  const mutations: Array<{ mutation: IssueMutation; aborted: boolean }> = [];
  const publications: PublishChangeInput[] = [];
  const context: AgentRunContext = {
    issue: sampleIssue,
    workspacePath: "/tmp/symphony-test",
    prompt: "Do the task",
    attempt: null,
    continuation: 0,
    signal: new AbortController().signal,
    runtimeOptions: {},
    async mutateCurrentIssue(mutation, signal) {
      mutations.push({ mutation, aborted: signal.aborted });
    },
    async publishCurrentChange(input) {
      publications.push(input);
      return { url: "https://github.example/acme/widget/pull/7", number: 7, branch: "symphony/issue-1" };
    },
  };

  const definitions = createIssueMutationTools(context);
  assert.deepEqual(
    definitions.map(({ name }) => name),
    [
      "comment_current_issue",
      "add_current_issue_label",
      "remove_current_issue_label",
      "set_current_issue_state",
    ],
  );
  assert.ok(definitions.every(({ description }) => !description.includes("GitHub")));
  const defaultStateSchema = definitions[3]?.inputSchema.state;
  assert.equal(defaultStateSchema?.safeParse("Human Review").success, false);
  const toolController = new AbortController();
  toolController.abort();
  const result = await definitions[3]?.handler({ state: "closed" }, { signal: toolController.signal });

  assert.deepEqual(mutations, [
    { mutation: { kind: "set_state", state: "closed" }, aborted: true },
  ]);
  assert.equal(result?.isError, undefined);
  assert.deepEqual(result?.structuredContent, { identifier: "TEST-1", action: "set_state" });

  const namedDefinitions = createIssueMutationTools({
    ...context,
    issueStateMutationMode: "named",
  });
  const namedStateSchema = namedDefinitions[3]?.inputSchema.state;
  assert.equal(namedStateSchema?.safeParse(" Human Review ").success, true);
  await namedDefinitions[3]?.handler({ state: "Human Review" }, {});
  assert.deepEqual(mutations[1], {
    mutation: { kind: "set_state", state: "Human Review" },
    aborted: false,
  });

  const publishResult = await createPublishChangeTools(context)[0]?.handler(
    {
      commit_message: "Fix TEST-1",
      pull_request_title: "Fix TEST-1",
      pull_request_body: "Verified with pnpm test.",
    },
    {},
  );
  assert.deepEqual(publications, [
    {
      commitMessage: "Fix TEST-1",
      pullRequestTitle: "Fix TEST-1",
      pullRequestBody: "Verified with pnpm test.",
    },
  ]);
  assert.deepEqual(publishResult?.structuredContent, {
    identifier: "TEST-1",
    url: "https://github.example/acme/widget/pull/7",
    number: 7,
    branch: "symphony/issue-1",
  });

  const options = createIssueToolOptions(
    context,
    [issueToolNames.comment, issueToolNames.setState, issueToolNames.publishChange, "mcp__symphony__lookalike"],
    [issueToolNames.setState],
    "default",
  );
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["symphony"]);
  assert.deepEqual(
    selectIssueTools(
      context,
      [issueToolNames.comment, issueToolNames.setState, issueToolNames.publishChange, "mcp__symphony__lookalike"],
      [issueToolNames.setState],
    ).map(({ name }) => name),
    ["comment_current_issue", "publish_current_change"],
  );
  assert.deepEqual(createIssueToolOptions(context, [issueToolNames.comment], [], "plan"), {});
  assert.deepEqual(createIssueToolOptions(context, ["mcp__symphony__lookalike"], [], "default"), {});
  assert.deepEqual(
    selectIssueTools(context, [issueToolNames.publishChange], [issueToolNames.publishChange]),
    [],
  );
});

test("current-issue tool failures do not expose provider errors", async () => {
  const context: AgentRunContext = {
    issue: sampleIssue,
    workspacePath: "/tmp/symphony-test",
    prompt: "Do the task",
    attempt: null,
    continuation: 0,
    signal: new AbortController().signal,
    runtimeOptions: {},
    async mutateCurrentIssue() {
      throw new Error("Bearer secret-token and private response body");
    },
    async publishCurrentChange() {
      throw new Error("Bearer publish-token and private git output");
    },
  };

  const result = await createIssueMutationTools(context)[0]?.handler(
    { body: "Progress update" },
    {},
  );
  assert.equal(result?.isError, true);
  const content = result?.content[0];
  assert.equal(content?.type, "text");
  if (content?.type === "text") {
    assert.doesNotMatch(content.text, /secret-token|private response body/);
  }

  const publishResult = await createPublishChangeTools(context)[0]?.handler(
    { commit_message: "Commit", pull_request_title: "PR", pull_request_body: "Body" },
    {},
  );
  assert.equal(publishResult?.isError, true);
  const publishContent = publishResult?.content[0];
  assert.equal(publishContent?.type, "text");
  if (publishContent?.type === "text") {
    assert.doesNotMatch(publishContent.text, /publish-token|private git output/);
  }
});

const sampleIssue: Issue = {
  id: "test-1",
  nativeRef: null,
  identifier: "TEST-1",
  title: "Test",
  description: null,
  priority: 1,
  state: "Todo",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
};

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
