import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type ModelUsage,
  type Options,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { agentCompletionOutputSchema, parseAgentCompletion } from "@ai-symphony/core/completion.js";
import type {
  AgentDriver,
  AgentEvent,
  AgentRunContext,
  AgentUsage,
  IssueMutation,
  PublishChangeInput,
} from "@ai-symphony/core/domain.js";
import { normalizeAgentRateLimit } from "@ai-symphony/core/domain.js";
import { isPathContained, pickEnvironment } from "./environment.js";

const issueToolServerName = "symphony";

export const issueToolNames = {
  comment: `mcp__${issueToolServerName}__comment_current_issue`,
  addLabel: `mcp__${issueToolServerName}__add_current_issue_label`,
  removeLabel: `mcp__${issueToolServerName}__remove_current_issue_label`,
  setState: `mcp__${issueToolServerName}__set_current_issue_state`,
  publishChange: `mcp__${issueToolServerName}__publish_current_change`,
} as const;

const permissionModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;

const claudeOptionsSchema = z.object({
  model: z.string().min(1).optional(),
  max_agentic_turns: z.number().int().positive().default(50),
  max_budget_usd: z.number().positive().optional(),
  permission_mode: z.enum(permissionModes).default("default"),
  allowed_tools: z.array(z.string()).default(["Read", "Edit", "Write", "Glob", "Grep"]),
  disallowed_tools: z.array(z.string()).default([]),
  tools: z.array(z.string()).optional(),
  setting_sources: z.array(z.enum(["user", "project", "local"])).default([]),
  env_allowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).default([]),
  include_partial_messages: z.boolean().default(false),
  claude_executable: z.string().min(1).optional(),
});

export class ClaudeAgentDriver implements AgentDriver {
  readonly kind = "claude";

  async *run(context: AgentRunContext): AsyncIterable<AgentEvent> {
    let terminalEmitted = false;
    let sessionId = context.sessionId;
    let claudeQuery: ReturnType<typeof query> | undefined;
    let abort: (() => void) | undefined;

    try {
      const configured = parseClaudeRuntimeOptions(context.runtimeOptions);

      const abortController = new AbortController();
      abort = () => abortController.abort(context.signal.reason);
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });

      const issueTools = createIssueToolOptions(
        context,
        configured.allowed_tools,
        configured.disallowed_tools,
        configured.permission_mode,
      );

      const options: Options = {
        cwd: context.workspacePath,
        abortController,
        systemPrompt: { type: "preset", preset: "claude_code" },
        maxTurns: configured.max_agentic_turns,
        permissionMode: configured.permission_mode,
        disallowedTools: configured.disallowed_tools,
        tools: (configured.tools ?? configured.allowed_tools).filter((name) => !name.startsWith("mcp__")),
        canUseTool: createWorkspacePermissionPolicy(context.workspacePath, configured.allowed_tools),
        settingSources: configured.setting_sources,
        strictMcpConfig: true,
        includePartialMessages: configured.include_partial_messages,
        env: buildClaudeEnvironment(configured.env_allowlist, context.sensitiveEnvNames),
        ...issueTools,
        ...(context.completionMode === "publish_change"
          ? { outputFormat: { type: "json_schema", schema: agentCompletionOutputSchema } as const }
          : {}),
        ...(configured.model === undefined ? {} : { model: configured.model }),
        ...(configured.max_budget_usd === undefined ? {} : { maxBudgetUsd: configured.max_budget_usd }),
        ...(configured.claude_executable === undefined
          ? {}
          : { pathToClaudeCodeExecutable: configured.claude_executable }),
        ...(context.sessionId === undefined ? {} : { resume: context.sessionId }),
      };

      claudeQuery = query({ prompt: context.prompt, options });
      for await (const message of claudeQuery) {
        for (const event of normalizeClaudeMessage(message, context.completionMode)) {
          sessionId = event.sessionId ?? sessionId;
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            if (terminalEmitted) continue;
            terminalEmitted = true;
            yield event;
            return;
          }
          yield event;
        }
      }
      if (!terminalEmitted) {
        terminalEmitted = true;
        yield eventNow("turn_failed", {
          summary: "Claude stream ended without a result message",
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      }
    } catch (error) {
      if (!terminalEmitted) {
        terminalEmitted = true;
        yield eventNow("turn_failed", {
          summary: context.completionMode === "publish_change" ? "Claude run failed" : errorMessage(error),
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      }
    } finally {
      if (abort !== undefined) context.signal.removeEventListener("abort", abort);
      try {
        claudeQuery?.close();
      } catch {
        // The terminal event already describes the run; cleanup must not create a second outcome.
      }
    }
  }
}

export function parseClaudeRuntimeOptions(options: Record<string, unknown>) {
  const configured = claudeOptionsSchema.parse(options);
  if (configured.permission_mode !== "default" && configured.permission_mode !== "plan") {
    throw new Error(
      `Claude permission mode ${configured.permission_mode} is unsupported because it can bypass workspace policy`,
    );
  }
  return configured;
}

export function createIssueMutationTools(context: AgentRunContext): SdkMcpToolDefinition<any>[] {
  if (context.mutateCurrentIssue === undefined) return [];
  const namedStates = context.issueStateMutationMode === "named";
  return [
    tool(
      "comment_current_issue",
      "Post a concise comment to the tracker issue bound to this Symphony run. Use it for verified progress, results, or blockers. It cannot target another issue.",
      { body: z.string().trim().min(1).max(65_536) },
      (input, extra) => runIssueMutation(context, { kind: "comment", body: input.body }, extra),
    ),
    tool(
      "add_current_issue_label",
      "Add one existing label to the tracker issue bound to this Symphony run. Use only when the workflow requires that label. It cannot target another issue.",
      { label: z.string().trim().min(1).max(50) },
      (input, extra) => runIssueMutation(context, { kind: "add_label", label: input.label }, extra),
    ),
    tool(
      "remove_current_issue_label",
      "Remove one label from the tracker issue bound to this Symphony run. Use only when the workflow requires removing that label. It cannot target another issue.",
      { label: z.string().trim().min(1).max(50) },
      (input, extra) => runIssueMutation(context, { kind: "remove_label", label: input.label }, extra),
    ),
    tool(
      "set_current_issue_state",
      namedStates
        ? "Set the tracker issue bound to this Symphony run to an existing workflow state by exact name. It cannot target another issue."
        : "Set the tracker issue bound to this Symphony run to open or closed. Close it only after the requested work is complete and verified. It cannot target another issue.",
      { state: namedStates ? z.string().trim().min(1).max(100) : z.enum(["open", "closed"]) },
      (input, extra) => runIssueMutation(context, { kind: "set_state", state: input.state }, extra),
    ),
  ];
}

export function createPublishChangeTools(context: AgentRunContext): SdkMcpToolDefinition<any>[] {
  if (context.publishCurrentChange === undefined) return [];
  return [
    tool(
      "publish_current_change",
      "Commit and push the current workspace, then create or update its bound GitHub pull request. The repository, branch, and issue are fixed by Symphony and cannot be selected here.",
      {
        commit_message: z.string().trim().min(1).max(200),
        pull_request_title: z.string().trim().min(1).max(256),
        pull_request_body: z.string().max(65_536),
      },
      (input, extra) =>
        runPublishChange(
          context,
          {
            commitMessage: input.commit_message,
            pullRequestTitle: input.pull_request_title,
            pullRequestBody: input.pull_request_body,
          },
          extra,
        ),
    ),
  ];
}

export function createIssueToolOptions(
  context: AgentRunContext,
  allowedTools: string[],
  disallowedTools: string[],
  permissionMode: string,
): Partial<Pick<Options, "mcpServers">> {
  if (permissionMode === "plan") return {};

  const tools = selectIssueTools(context, allowedTools, disallowedTools);
  if (tools.length === 0) return {};

  return {
    mcpServers: {
      [issueToolServerName]: createSdkMcpServer({
        name: issueToolServerName,
        version: "0.1.0",
        alwaysLoad: true,
        tools,
      }),
    },
  };
}

export function selectIssueTools(
  context: AgentRunContext,
  allowedTools: string[],
  disallowedTools: string[],
): SdkMcpToolDefinition<any>[] {
  const allowed = new Set(allowedTools);
  const disallowed = new Set(disallowedTools);
  return [...createIssueMutationTools(context), ...createPublishChangeTools(context)].filter((definition) => {
    const fullName = `mcp__${issueToolServerName}__${definition.name}`;
    return allowed.has(fullName) && !disallowed.has(fullName);
  });
}

async function runPublishChange(
  context: AgentRunContext,
  input: PublishChangeInput,
  extra: unknown,
) {
  const publish = context.publishCurrentChange;
  if (publish === undefined) return publishToolError();

  try {
    const result = await publish(input, combinedToolSignal(context, extra));
    return {
      content: [{ type: "text" as const, text: `Published ${context.issue.identifier}: ${result.url}` }],
      structuredContent: { identifier: context.issue.identifier, ...result },
    };
  } catch {
    return publishToolError();
  }
}

async function runIssueMutation(
  context: AgentRunContext,
  mutation: IssueMutation,
  extra: unknown,
) {
  const mutate = context.mutateCurrentIssue;
  if (mutate === undefined) return issueToolError();

  try {
    await mutate(mutation, combinedToolSignal(context, extra));
    return {
      content: [{ type: "text" as const, text: `Updated ${context.issue.identifier}` }],
      structuredContent: { identifier: context.issue.identifier, action: mutation.kind },
    };
  } catch {
    return issueToolError();
  }
}

function publishToolError() {
  return {
    content: [{ type: "text" as const, text: "The current change could not be published" }],
    isError: true,
  };
}

function issueToolError() {
  return {
    content: [{ type: "text" as const, text: "The current issue could not be updated" }],
    isError: true,
  };
}

function toolSignal(extra: unknown): AbortSignal | undefined {
  if (extra === null || typeof extra !== "object" || !("signal" in extra)) return undefined;
  return extra.signal instanceof AbortSignal ? extra.signal : undefined;
}

function combinedToolSignal(context: AgentRunContext, extra: unknown): AbortSignal {
  const signal = toolSignal(extra);
  return signal === undefined ? context.signal : AbortSignal.any([context.signal, signal]);
}

export function createWorkspacePermissionPolicy(workspacePath: string, allowedTools: string[]): CanUseTool {
  const allowed = new Set(allowedTools);
  return async (toolName, input, options) => {
    const deny = (message: string) => ({
      behavior: "deny" as const,
      message,
      interrupt: false,
      toolUseID: options.toolUseID,
    });
    if (options.signal.aborted) return deny("Tool request was aborted");
    if (!allowed.has(toolName)) return deny(`Tool ${toolName} is not in runtime.options.allowed_tools`);

    if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
      const filePath = input.file_path;
      if (typeof filePath !== "string" || !(await isPathInsideWorkspace(workspacePath, filePath))) {
        return deny(`${toolName} is restricted to the issue workspace`);
      }
    }

    if (toolName === "Glob" || toolName === "Grep") {
      const searchPath = input.path;
      if (
        searchPath !== undefined &&
        (typeof searchPath !== "string" || !(await isPathInsideWorkspace(workspacePath, searchPath)))
      ) {
        return deny(`${toolName} is restricted to the issue workspace`);
      }
      if (toolName === "Glob" && (typeof input.pattern !== "string" || unsafeGlob(input.pattern))) {
        return deny("Glob patterns must remain inside the issue workspace");
      }
    }

    return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID };
  };
}

export function buildClaudeEnvironment(
  extraNames: string[],
  sensitiveEnvNames: string[] = [],
): Record<string, string> {
  return pickEnvironment([...safeEnvironmentNames, ...extraNames], sensitiveEnvNames, {
    CLAUDE_AGENT_SDK_CLIENT_APP: "ai-symphony-node/0.1.0",
  });
}

export function normalizeClaudeMessage(
  message: SDKMessage,
  completionMode?: AgentRunContext["completionMode"],
): AgentEvent[] {
  const timestamp = new Date().toISOString();
  const sessionId = "session_id" in message ? message.session_id : undefined;
  const base = sessionId === undefined ? { timestamp } : { timestamp, sessionId };

  if (message.type === "result") {
    const usage = aggregateModelUsage(message.modelUsage);
    const events: AgentEvent[] = [{ type: "usage_updated", ...base, usage }];
    if (message.permission_denials.length > 0) {
      const toolNames = [...new Set(message.permission_denials.map((denial) => denial.tool_name))];
      events.push({
        type: "approval_required",
        ...base,
        summary: `Claude permission denied for ${toolNames.join(", ")}`,
        blockingReason: "approval",
        providerData: { toolNames },
      });
    }
    if (message.subtype === "success") {
      if (completionMode === "publish_change") {
        const completion = parseAgentCompletion(message.structured_output);
        if (completion === undefined) {
          return [
            ...events,
            { type: "turn_failed", ...base, summary: "Claude returned invalid structured completion" },
          ];
        }
        return [...events, { type: "turn_completed", ...base, summary: completion.summary, completion }];
      }
      return [...events, { type: "turn_completed", ...base, summary: message.result }];
    }
    return [
      ...events,
      {
        type: "turn_failed",
        ...base,
        summary:
          completionMode === "publish_change"
            ? "Claude structured completion failed"
            : message.errors.join("; ") || message.subtype,
        providerData: { subtype: message.subtype },
      },
    ];
  }

  if (message.type === "assistant") {
    const summary = summarizeAssistantContent(message.message.content);
    const asksForInput = message.message.content.some(
      (block) => block.type === "tool_use" && block.name === "AskUserQuestion",
    );
    if (asksForInput) {
      return [{ type: "input_required", ...base, summary, blockingReason: "input" }];
    }
    return [{ type: "activity", ...base, ...(summary ? { summary } : {}) }];
  }

  if (message.type === "rate_limit_event") {
    return [{ type: "rate_limit_updated", ...base, rateLimits: normalizeAgentRateLimit(message.rate_limit_info) }];
  }

  if (message.type === "system" && message.subtype === "permission_denied") {
    return [
      {
        type: "approval_required",
        ...base,
        summary: message.message || `Claude permission denied for ${message.tool_name}`,
        blockingReason: "approval",
        providerData: {
          toolName: message.tool_name,
          toolUseId: message.tool_use_id,
          ...(message.decision_reason_type === undefined
            ? {}
            : { decisionReasonType: message.decision_reason_type }),
          ...(message.decision_reason === undefined ? {} : { decisionReason: message.decision_reason }),
        },
      },
    ];
  }

  if (message.type === "system" && message.subtype === "init") {
    return [
      {
        type: "session_started",
        ...base,
        summary: `Claude ${message.claude_code_version} using ${message.model}`,
      },
    ];
  }

  if (message.type === "system" && message.subtype === "session_state_changed" && message.state === "requires_action") {
    return [{ type: "input_required", ...base, summary: "Claude session requires action", blockingReason: "input" }];
  }

  if (message.type === "system" && message.subtype === "api_retry") {
    return [
      {
        type: "activity",
        ...base,
        summary: `Claude API retry ${message.attempt}/${message.max_retries} in ${message.retry_delay_ms}ms`,
      },
    ];
  }

  return [{ type: "activity", ...base, summary: `Claude ${message.type} event` }];
}

function aggregateModelUsage(modelUsage: Record<string, ModelUsage>): AgentUsage {
  return Object.values(modelUsage).reduce<AgentUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens: total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      totalTokens:
        total.totalTokens +
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens,
      costUsd: total.costUsd + usage.costUSD,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  );
}

function summarizeAssistantContent(content: readonly unknown[]): string {
  const summaries: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;
    if (block.type === "text" && "text" in block && typeof block.text === "string") summaries.push(block.text);
    if (block.type === "tool_use" && "name" in block && typeof block.name === "string") {
      summaries.push(`Tool: ${block.name}`);
    }
  }
  return summaries.join("\n").slice(0, 2_000);
}

function eventNow(type: AgentEvent["type"], fields: Omit<AgentEvent, "type" | "timestamp">): AgentEvent {
  return { type, timestamp: new Date().toISOString(), ...fields };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const safeEnvironmentNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "APPDATA",
  "CI",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "COMSPEC",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
] as const;

async function isPathInsideWorkspace(workspacePath: string, candidate: string): Promise<boolean> {
  try {
    if (candidate.startsWith("~") || hasParentPathSegment(candidate)) return false;
    const root = await realpath(workspacePath);
    const absolute = path.resolve(root, candidate);

    let ancestor = absolute;
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        const canonicalCandidate = path.resolve(canonicalAncestor, path.relative(ancestor, absolute));
        return isPathContained(root, canonicalCandidate);
      } catch (error) {
        if (!isMissingPathError(error)) return false;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
    }
  } catch {
    return false;
  }
}

function unsafeGlob(pattern: string): boolean {
  const portable = pattern.replaceAll("\\", "/");
  return path.isAbsolute(pattern) || portable.includes("../") || portable.split("/").includes("..");
}

function hasParentPathSegment(candidate: string): boolean {
  return candidate.replaceAll("\\", "/").split("/").includes("..");
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
