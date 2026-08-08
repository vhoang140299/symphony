# Symphony Node

This directory contains a small TypeScript implementation of
[`SPEC.md`](../SPEC.md). It polls a tracker, creates an isolated workspace for each issue, and runs
Claude Code or Codex through their official SDKs.

> [!WARNING]
> This is a developer MVP for trusted local environments. It can let coding agents edit files and
> run shell commands. Review the workflow, repository instructions, hooks, and
> allowed tools before starting it. A workspace is a dedicated current working directory, not an
> OS/container security sandbox.

## Current scope

- Runtime: Node.js with strict TypeScript and ESM
- Coding agents: Claude Code via `@anthropic-ai/claude-agent-sdk`, or Codex via `@openai/codex-sdk`
- Trackers: in-memory issues, or GitHub Issues polling with manual Claude tools and host-controlled
  PR delivery
- Operations: structured logs and an in-process runtime snapshot

The in-memory tracker is for development and smoke tests. It does not persist state, synchronize
with an issue service, or give Claude a tool for moving an issue to a new state. Active memory
issues may therefore be retried after a run.

## Prerequisites

- Node.js 24 or newer; [`mise`](https://mise.jdx.dev/) can install the recommended Node version
  from `mise.toml`.
- Claude Code authentication available to the child process, such as `ANTHROPIC_API_KEY` or an
  existing Claude Code login. Symphony does not store or refresh Claude credentials.
- For the Codex runtime, set `CODEX_HOME` to a dedicated private profile and authenticate it with
  `CODEX_HOME=/absolute/path codex login`. API-key variables are passed only when explicitly named
  in `runtime.options.env_allowlist`.
- The safe Codex adapter currently supports macOS and Linux. Claude remains available on Windows.
- GitHub PR publishing currently requires macOS or Linux so an aborted token-authenticated push can
  terminate the complete Git process group.

Keep credentials in the host environment. Agent children receive a small system/auth allowlist,
not the complete host environment; add exceptional variable names with `runtime.options.env_allowlist`.
Do not commit API keys in `WORKFLOW.md`, because the agent can read files in its workspace.

The checked-in sample issue is intentionally `dispatchable: false`. Before the first agent run,
customize the issue, configure the clone hook, and set `dispatchable: true`.

## Install and run

```bash
cd node
mise trust
mise install
npm ci
npm run build
npm start -- ./WORKFLOW.md
```

Without `mise`, install a supported Node release and run the three `npm` commands directly. The
workflow path defaults to `./WORKFLOW.md`.

For one supervised or CI cycle, bypass npm's banner so stdout remains machine-readable:

```bash
node dist/src/cli.js --once ./WORKFLOW.md
```

`--once` performs one poll, waits for only the runs dispatched by that poll, writes one compact JSON
summary to stdout, sends logs to stderr, and exits. It returns zero only when the tracker poll
succeeds and `running`, `retrying`, and `blocked` are all zero; queued retries are reported but never
executed. One poll fills the current concurrency capacity—it does not prove the tracker's entire
queue is drained. `SIGINT` and `SIGTERM` request graceful shutdown before exiting with the
conventional signal status. On macOS and Linux, Symphony also terminates the complete hook process
group; Windows child cleanup is best-effort. Omit `--once` for the continuous daemon.

For development:

```bash
npm run check
npm test
```

## Workflow configuration

[`WORKFLOW.md`](WORKFLOW.md) is both configuration and prompt. YAML front matter controls the
tracker, polling interval, workspace root, lifecycle hooks, concurrency, and coding-agent runtime. The
Markdown body is rendered with Liquid for every issue.

Useful prompt values include `issue.identifier`, `issue.title`, `issue.description`,
`issue.state`, `issue.labels`, and `attempt`. Configuration is reloaded when the file changes; an
invalid reload keeps the last known-good configuration.

[`WORKFLOW.github.md`](WORKFLOW.github.md) and
[`WORKFLOW.codex.github.md`](WORKFLOW.codex.github.md) are host-delivery GitHub issue-to-PR profiles
for Claude and Codex. Copy one before editing; the default `WORKFLOW.md` remains an inert local
example.

Claude-specific settings live under `runtime.options` when `runtime.kind` is `claude`:

- `model`: optional model override; omission uses the account/default selection.
- `max_agentic_turns` and `max_budget_usd`: per-SDK-query limits passed to Claude.
- `permission_mode`: defaults to `default`; modes that bypass the workspace permission callback are
  rejected. `plan` is also supported.
- `tools`: restricts the built-in Claude tools. `allowed_tools` is Symphony's unattended policy and
  the exact opt-in list for host-side issue tools; default file tools are additionally confined to
  the canonical issue workspace.
- `disallowed_tools`: an additional SDK-level deny list.
- `setting_sources`: defaults to `[]`. Enabling `project`, `local`, or `user` explicitly trusts that
  settings source, including any permission rules or hooks it defines. External MCP configuration
  is ignored; only in-process servers supplied by Symphony are accepted.
- `env_allowlist`: extra host environment variable names to pass to Claude. Anthropic/Claude auth
  variables and basic process variables are passed automatically; unrelated secrets are stripped.
- `claude_executable`: optional path to a specific Claude Code executable.

`agent.max_turns` separately limits how many completed SDK queries Symphony resumes for one issue
before placing it on the short continuation retry queue.

### Codex runtime

Select Codex with a small runtime block:

```yaml
runtime:
  kind: codex
  options:
    model_reasoning_effort: high
```

The Codex adapter starts or resumes an SDK thread in the issue workspace with `workspace-write`,
approval policy `never`, login shells and subagents disabled, a minimal command environment, and
network and web search disabled. Optional settings are `model`,
`model_reasoning_effort`, `skip_git_repo_check`, `env_allowlist`, and `codex_executable`. The default
environment preserves the local Codex login and basic process/TLS variables while stripping
unrelated host secrets. Add `CODEX_API_KEY` or `OPENAI_API_KEY` to `env_allowlist` only when that
credential mode is intentional.

The Codex adapter does not expose Symphony's manual GitHub mutation or publishing tools. Use the
host-delivery configuration below when Codex should hand verified work back to Symphony for
publishing.

The Codex SDK does not yet expose the CLI's `--ignore-user-config` switch. Symphony therefore runs
the bundled CLI through a small wrapper that always adds `--ignore-user-config` and `--ignore-rules`,
and disables apps, browser/computer use, image generation, hooks, plugins, and skill extensions at
CLI precedence. `CODEX_HOME` must be an existing absolute, private, user-owned directory disjoint
from every issue workspace. Create a profile dedicated to Symphony; do not point it at your normal
`~/.codex`. Generated session, cache, system-skill, and
authentication state may remain there, but global `AGENTS` overrides, `hooks.json`, `.agents`, and
user-installed Codex skills are rejected. Complete workspace-local `.codex` and `.agents` layers
are also rejected, and skill search/dependency installation is disabled at CLI precedence.

User-configured additional writable roots and broad `/tmp` writes are cleared for every turn.
Commands receive one private per-run temporary directory as their only writable root outside the
issue workspace, and Symphony removes it after the SDK stream closes. The Codex process also sees
the dedicated profile as its OS home, preventing host-user skills under `~/.agents/skills` from being
loaded.

The Codex SDK reports token usage but not a USD amount, so Symphony records `costUsd: 0` for Codex
runs. That value means “unavailable,” not “free.”

### GitHub Issues tracker

Use GitHub issue numbers as tracker IDs and `open`/`closed` as states. Add `delivery` to opt in to
host-controlled publishing:

```yaml
tracker:
  kind: github
  provider:
    owner: your-org
    repo: your-repo
    token: $GITHUB_TOKEN # required for mutations and publishing
    base_branch: main # optional when origin/HEAD is configured by clone
    # endpoint: https://api.github.com
    # git_url: https://github.example/your-org/your-repo.git # required to publish with a custom endpoint
  required_labels: [symphony]
  active_states: [open]
  terminal_states: [closed]

delivery:
  queue_label: symphony
  review_label: human-review

agent:
  max_turns: 1

runtime:
  kind: claude
  options:
    allowed_tools:
      - Read
      - Edit
      - Write
      - Glob
      - Grep
    tools: [Read, Edit, Write, Glob, Grep]
```

Host delivery currently requires the GitHub tracker. `delivery.queue_label` must be one of
`tracker.required_labels`, and `delivery.review_label` must differ from every required label. Create
both labels in the repository before starting Symphony so their color and description are controlled
and the profile remains portable to GitHub Enterprise. GitHub.com may create a missing review label
with default metadata. The checked-in profiles use one SDK query per issue (`agent.max_turns: 1`)
because each run must make an explicit handoff decision.

In delivery mode, Claude and Codex return a constrained result with this shape:

```json
{
  "status": "ready",
  "summary": "Implemented the requested change.",
  "verification": ["npm test — passed"]
}
```

`status` is `ready` or `blocked`; `summary` and at least one `verification` entry are required. The
agent edits and verifies only—it cannot supply the repository, branch, issue, labels, or direct
publishing input. Symphony refreshes the issue and validates the owned workspace before it derives
commit and pull-request metadata from the issue and constrained result, then publishes. It creates
or updates one handoff comment for the current in-process retry chain, adds the review label, and
removes the queue label last. A host-side delivery retry reuses the completed result, deterministic
branch, open pull request, and handoff comment without rerunning the agent. If an earlier step fails,
the queue label remains for retry. Host delivery rejects `hooks.after_run` because running cleanup
between host retries can change the pending commit, while delaying cleanup can leak resources.
Pending delivery state is in memory; after a process restart, a still-routable issue can be dispatched
to the agent again.

Host delivery requires `tracker.provider.token` to be an explicit environment reference such as
`$GITHUB_TOKEN`; set that variable in Symphony's host environment. The named variable and
`GITHUB_TOKEN` must not appear in `runtime.options.env_allowlist`. Comment and label updates execute
inside Symphony, so the tracker credential never needs to enter the coding-agent child. The token
needs repository `Issues: write`, `Contents: write`, and `Pull requests: write` permissions.

Outside delivery mode, the implicit `GITHUB_TOKEN` fallback is limited to `https://api.github.com`.
A custom endpoint must name its token environment variable explicitly, and authenticated endpoints
must use HTTPS. HTTP mutations from the manual tools below are not automatically retried.

Publishing stages the bound workspace, creates a commit when needed, pushes the deterministic
`symphony/issue-<number>` branch without force, and creates or updates the matching open pull
request. Git hooks, signing, interactive credentials, and executable Git filters are disabled or
rejected. For a custom API endpoint, configure an explicit HTTPS `git_url`; Symphony will not guess
where to send Git credentials.

When `delivery` is omitted, Claude's manual host tools remain available through explicit
`allowed_tools` entries:

```yaml
runtime:
  kind: claude
  options:
    allowed_tools:
      - Read
      - Edit
      - Write
      - Glob
      - Grep
      - mcp__symphony__publish_current_change
      - mcp__symphony__comment_current_issue
      - mcp__symphony__add_current_issue_label
      - mcp__symphony__remove_current_issue_label
      - mcp__symphony__set_current_issue_state
    tools: [Read, Edit, Write, Glob, Grep]
```

Each enabled manual tool is bound to the current issue; Claude cannot provide a repository, URL, or
issue number. `publish_current_change` accepts only the commit message, pull-request title, and
pull-request body. Codex does not expose these in-process manual tools.

Workspace hooks run with the issue workspace as their current directory. `after_create` is the
normal place to clone the target repository. Workspaces must remain below `workspace.root`; do not
point that root at this source checkout. Enabling `Bash` is explicit unsandboxed host command
execution even though its current directory is the workspace. It may also reach authenticated host
CLIs, credential helpers, keyrings, and files outside the workspace; the GitHub profile therefore
leaves `Bash` disabled by default. Symphony requires a private,
user-owned root and an issue-matching ownership marker before it will reuse or recursively remove a
workspace; a pre-existing unmarked directory is left untouched.

Clone URLs must not contain credentials because the model can inspect workspace Git metadata. Use
a host credential helper or SSH agent for private clone access; publishing uses the tracker token
only in its short-lived host Git/API operations.

## Extending the MVP

Additional trackers implement the `Tracker` contract under `src/trackers/` and register their
`kind` in the tracker registry. Additional coding agents follow the same pattern with the
`AgentDriver` contract under `src/agents/`.

The MVP deliberately has no database, durable queue, multi-node coordination, dashboard, or
status API. Add those only when the target deployment requires them.

Approval or user-input requests fail closed and remain visible in `Orchestrator.snapshot()` until
an embedding calls `retryBlocked()`, or the tracker moves the issue out of an active state. The CLI
does not yet provide an operator UI for this path.

## License

This implementation uses the repository's [Apache License 2.0](../LICENSE).
