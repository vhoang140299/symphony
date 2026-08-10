import { z } from "zod";
import { tmpdir } from "node:os";
import path from "node:path";

const positiveInteger = z.number().int().positive();
const nonEmptyString = z.string().trim().min(1);
const githubLabel = z.string().trim().min(1).max(50);
const githubStates = new Set(["open", "closed", "all"]);

const trackerSchema = z
  .object({
    kind: z.enum(["memory", "github", "linear"]),
    provider: z.record(z.string(), z.unknown()).default({}),
    required_labels: z.array(z.string()).default([]),
    active_states: z.array(nonEmptyString).optional(),
    terminal_states: z.array(nonEmptyString).optional(),
  })
  .superRefine((value, context) => {
    if (value.kind !== "github") return;
    for (const key of ["active_states", "terminal_states"] as const) {
      value[key]?.forEach((state, index) => {
        if (!githubStates.has(state.toLowerCase())) {
          context.addIssue({
            code: "custom",
            path: [key, index],
            message: "GitHub tracker states must be open, closed, or all",
          });
        }
      });
    }
  });

const pollingSchema = z
  .object({
    interval_ms: positiveInteger.default(30_000),
  })
  .prefault({});

const workspaceSchema = z
  .object({
    root: z.string().trim().min(1).default(path.join(tmpdir(), "symphony_workspaces")),
  })
  .prefault({});

const hooksSchema = z
  .object({
    after_create: z.string().optional(),
    before_run: z.string().optional(),
    after_run: z.string().optional(),
    before_remove: z.string().optional(),
    timeout_ms: positiveInteger.default(60_000),
  })
  .prefault({});

const agentSchema = z
  .object({
    max_concurrent_agents: positiveInteger.default(10),
    max_turns: positiveInteger.optional(),
    max_continuations: positiveInteger.optional(),
    max_attempts: positiveInteger.optional(),
    max_retry_backoff_ms: positiveInteger.default(300_000),
    max_concurrent_agents_by_state: z.record(z.string(), positiveInteger).default({}),
  })
  .superRefine((value, context) => {
    if (
      value.max_turns !== undefined &&
      value.max_continuations !== undefined &&
      value.max_turns !== value.max_continuations
    ) {
      context.addIssue({
        code: "custom",
        message: "agent.max_turns conflicts with deprecated agent.max_continuations",
      });
    }
  })
  .prefault({});

const runtimeSchema = z
  .object({
    kind: z.enum(["claude", "codex"]).default("claude"),
    turn_timeout_ms: positiveInteger.default(3_600_000),
    stall_timeout_ms: z.number().int().nonnegative().default(300_000),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .prefault({});

const githubDeliverySchema = z
  .object({
    queue_label: githubLabel,
    review_label: githubLabel,
  })
  .strict();

const linearDeliverySchema = z
  .object({
    review_state: z.string().trim().min(1).max(100),
  })
  .strict();

const deliverySchema = z.union([githubDeliverySchema, linearDeliverySchema]);

const controlSchema = z
  .object({
    retry_label: githubLabel,
  })
  .strict();

const stateSchema = z
  .object({
    path: nonEmptyString,
  })
  .strict();

const serverSchema = z
  .object({
    port: z.number().int().min(0).max(65_535).optional(),
    host: nonEmptyString.default("127.0.0.1"),
  })
  .strict();

const rawWorkflowConfigSchema = z
  .object({
    tracker: trackerSchema,
    polling: pollingSchema,
    workspace: workspaceSchema,
    hooks: hooksSchema,
    agent: agentSchema,
    runtime: runtimeSchema,
    delivery: deliverySchema.optional(),
    control: controlSchema.optional(),
    state: stateSchema.optional(),
    server: serverSchema.optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (Object.hasOwn(value, "codex")) {
      context.addIssue({
        code: "custom",
        path: ["codex"],
        message: "Top-level codex configuration is unsupported; use runtime.kind: codex and runtime.options",
      });
    }
    if (value.delivery === undefined && value.control === undefined) return;
    const githubDelivery = value.delivery !== undefined && "queue_label" in value.delivery
      ? value.delivery
      : undefined;
    const linearDelivery = value.delivery !== undefined && "review_state" in value.delivery
      ? value.delivery
      : undefined;

    if (githubDelivery !== undefined && value.tracker.kind !== "github") {
      context.addIssue({
        code: "custom",
        path: ["delivery"],
        message: "Configured GitHub pull-request delivery requires the GitHub tracker",
      });
    }
    if (linearDelivery !== undefined && value.tracker.kind !== "linear") {
      context.addIssue({
        code: "custom",
        path: ["delivery"],
        message: "Configured Linear host handoff requires the Linear tracker",
      });
    }
    if (
      value.control !== undefined &&
      value.tracker.kind !== "github" &&
      value.tracker.kind !== "linear"
    ) {
      context.addIssue({
        code: "custom",
        path: ["control"],
        message: "Configured retry control requires the GitHub or Linear tracker",
      });
    }
    if (value.delivery !== undefined && value.hooks.after_run !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["hooks", "after_run"],
        message: "Host delivery does not support hooks.after_run",
      });
    }

    const requiredLabels = value.tracker.required_labels.map((label) => label.trim().toLowerCase());
    const deliveryLabels: string[] = [];
    if (githubDelivery !== undefined) {
      const queueLabel = githubDelivery.queue_label.trim().toLowerCase();
      const reviewLabel = githubDelivery.review_label.trim().toLowerCase();
      deliveryLabels.push(queueLabel, reviewLabel);
      if (!requiredLabels.includes(queueLabel)) {
        context.addIssue({
          code: "custom",
          path: ["delivery", "queue_label"],
          message: "delivery.queue_label must be present in tracker.required_labels",
        });
      }
      if (requiredLabels.includes(reviewLabel)) {
        context.addIssue({
          code: "custom",
          path: ["delivery", "review_label"],
          message: "delivery.review_label must differ from every tracker.required_labels entry",
        });
      }
    }
    if (linearDelivery !== undefined && value.tracker.kind === "linear") {
      const reviewState = linearDelivery.review_state.trim().toLowerCase();
      const activeStates = value.tracker.active_states ?? ["Todo", "In Progress"];
      const terminalStates = value.tracker.terminal_states ?? [
        "Done",
        "Closed",
        "Cancelled",
        "Canceled",
        "Duplicate",
      ];
      if ([...activeStates, ...terminalStates].some((state) => state.trim().toLowerCase() === reviewState)) {
        context.addIssue({
          code: "custom",
          path: ["delivery", "review_state"],
          message: "delivery.review_state must differ from tracker active_states and terminal_states",
        });
      }
    }
    if (value.control !== undefined) {
      const retryLabel = value.control.retry_label.trim().toLowerCase();
      if ([...requiredLabels, ...deliveryLabels].includes(retryLabel)) {
        context.addIssue({
          code: "custom",
          path: ["control", "retry_label"],
          message: "control.retry_label must differ from tracker.required_labels and delivery labels",
        });
      }
    }

    const credential = value.tracker.kind === "github"
      ? {
          key: "token",
          defaultName: "GITHUB_TOKEN",
          missingMessage: "Host-controlled GitHub features require an explicit tracker token environment reference",
        }
      : value.tracker.kind === "linear" && value.control !== undefined
        ? {
            key: "api_key",
            defaultName: "LINEAR_API_KEY",
            missingMessage: "Linear retry control requires an explicit tracker API key environment reference",
          }
        : value.tracker.kind === "linear" && linearDelivery !== undefined
          ? {
              key: "api_key",
              defaultName: "LINEAR_API_KEY",
              missingMessage: "Linear host handoff requires an explicit tracker API key environment reference",
            }
        : undefined;
    if (credential === undefined) return;

    const tokenReference = value.tracker.provider[credential.key];
    const tokenMatch = typeof tokenReference === "string"
      ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(tokenReference.trim())
      : null;
    if (!tokenMatch?.[1]) {
      context.addIssue({
        code: "custom",
        path: ["tracker", "provider", credential.key],
        message: credential.missingMessage,
      });
      return;
    }

    const allowlist = value.runtime.options.env_allowlist;
    if (!Array.isArray(allowlist)) return;
    const forbidden = new Set([credential.defaultName.toLowerCase(), tokenMatch[1].toLowerCase()]);
    const leakedIndex = allowlist.findIndex(
      (name) => typeof name === "string" && forbidden.has(name.toLowerCase()),
    );
    if (leakedIndex >= 0) {
      context.addIssue({
        code: "custom",
        path: ["runtime", "options", "env_allowlist", leakedIndex],
        message: "Tracker credentials must not be passed to the coding-agent child",
      });
    }
  });

export interface WorkflowConfig {
  tracker: {
    kind: string;
    provider: Record<string, unknown>;
    requiredLabels: string[];
    activeStates: string[];
    terminalStates: string[];
  };
  polling: { intervalMs: number };
  workspace: { root: string };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxAttempts: number | null;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
  runtime: {
    kind: string;
    turnTimeoutMs: number;
    stallTimeoutMs: number;
    options: Record<string, unknown>;
  };
  delivery?:
    | {
        kind: "github_pr";
        queueLabel: string;
        reviewLabel: string;
      }
    | {
        kind: "linear_handoff";
        reviewState: string;
      };
  control?: {
    retryLabel: string;
  };
  state?: {
    path: string;
  };
  server?: {
    port?: number;
    host: string;
  };
}

export function parseWorkflowConfig(input: unknown): WorkflowConfig {
  const parsed = rawWorkflowConfigSchema.parse(input);
  const requiredLabels = parsed.tracker.required_labels.map((label) => label.trim().toLowerCase());
  const stateLimits = Object.fromEntries(
    Object.entries(parsed.agent.max_concurrent_agents_by_state).map(([state, limit]) => [state.trim().toLowerCase(), limit]),
  );

  return {
    tracker: {
      kind: parsed.tracker.kind,
      provider: parsed.tracker.provider,
      requiredLabels: [...new Set(requiredLabels)],
      activeStates: parsed.tracker.active_states ?? (parsed.tracker.kind === "github" ? ["open"] : ["Todo", "In Progress"]),
      terminalStates:
        parsed.tracker.terminal_states ??
        (parsed.tracker.kind === "github" ? ["closed"] : ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]),
    },
    polling: { intervalMs: parsed.polling.interval_ms },
    workspace: { root: parsed.workspace.root },
    hooks: {
      ...(parsed.hooks.after_create === undefined ? {} : { afterCreate: parsed.hooks.after_create }),
      ...(parsed.hooks.before_run === undefined ? {} : { beforeRun: parsed.hooks.before_run }),
      ...(parsed.hooks.after_run === undefined ? {} : { afterRun: parsed.hooks.after_run }),
      ...(parsed.hooks.before_remove === undefined ? {} : { beforeRemove: parsed.hooks.before_remove }),
      timeoutMs: parsed.hooks.timeout_ms,
    },
    agent: {
      maxConcurrentAgents: parsed.agent.max_concurrent_agents,
      maxTurns:
        parsed.agent.max_turns ??
        parsed.agent.max_continuations ??
        (parsed.tracker.kind === "linear" ? 1 : 20),
      maxAttempts: parsed.agent.max_attempts ?? (parsed.tracker.kind === "linear" ? 3 : null),
      maxRetryBackoffMs: parsed.agent.max_retry_backoff_ms,
      maxConcurrentAgentsByState: stateLimits,
    },
    runtime: {
      kind: parsed.runtime.kind,
      turnTimeoutMs: parsed.runtime.turn_timeout_ms,
      stallTimeoutMs: parsed.runtime.stall_timeout_ms,
      options: parsed.runtime.options,
    },
    ...(parsed.delivery === undefined
      ? {}
      : {
          delivery: "review_state" in parsed.delivery
            ? {
                kind: "linear_handoff" as const,
                reviewState: parsed.delivery.review_state.trim(),
              }
            : {
                kind: "github_pr" as const,
                queueLabel: parsed.delivery.queue_label.trim().toLowerCase(),
                reviewLabel: parsed.delivery.review_label.trim().toLowerCase(),
              },
        }),
    ...(parsed.control === undefined
      ? {}
      : {
          control: {
            retryLabel: parsed.control.retry_label.trim().toLowerCase(),
          },
        }),
    ...(parsed.state === undefined
      ? {}
      : {
          state: {
            path: parsed.state.path,
          },
        }),
    ...(parsed.server === undefined
      ? {}
      : {
          server: {
            ...(parsed.server.port === undefined ? {} : { port: parsed.server.port }),
            host: parsed.server.host,
          },
        }),
  };
}
