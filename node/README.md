# Symphony Node

This directory contains a small TypeScript implementation of
[`SPEC.md`](../SPEC.md). It polls a tracker, creates an isolated workspace for each issue, and runs
Claude Code through the Claude Agent SDK.

> [!WARNING]
> This is a developer MVP for trusted local environments. It can let Claude edit files and, when
> explicitly enabled, run shell commands. Review the workflow, repository instructions, hooks, and
> allowed tools before starting it. A workspace is a dedicated current working directory, not an
> OS/container security sandbox.

## Current scope

- Runtime: Node.js with strict TypeScript and ESM
- Coding agent: Claude Code via `@anthropic-ai/claude-agent-sdk`
- Trackers: in-memory issues, or GitHub Issues polling with opt-in issue mutations and PR publishing
- Operations: structured logs and an in-process runtime snapshot

The in-memory tracker is for development and smoke tests. It does not persist state, synchronize
with an issue service, or give Claude a tool for moving an issue to a new state. Active memory
issues may therefore be retried after a run.

## Prerequisites

- Node.js 24 or newer; [`mise`](https://mise.jdx.dev/) can install the recommended Node version
  from `mise.toml`.
- Claude Code authentication available to the child process, such as `ANTHROPIC_API_KEY` or an
  existing Claude Code login. Symphony does not store or refresh Claude credentials.
- GitHub PR publishing currently requires macOS or Linux so an aborted token-authenticated push can
  terminate the complete Git process group.

Keep credentials in the host environment. The Claude child receives a small system/auth allowlist,
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
tracker, polling interval, workspace root, lifecycle hooks, concurrency, and Claude runtime. The
Markdown body is rendered with Liquid for every issue.

Useful prompt values include `issue.identifier`, `issue.title`, `issue.description`,
`issue.state`, `issue.labels`, and `attempt`. Configuration is reloaded when the file changes; an
invalid reload keeps the last known-good configuration.

[`WORKFLOW.github.md`](WORKFLOW.github.md) is a GitHub issue-to-PR profile. Copy it before editing;
the default `WORKFLOW.md` remains an inert local example.

Claude-specific settings live under `runtime.options`:

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

### GitHub Issues tracker

Use GitHub issue numbers as tracker IDs and `open`/`closed` as states:

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

runtime:
  kind: claude
  options:
    allowed_tools:
      - Read
      - Edit
      - Write
      - Glob
      - Grep
      # Add only the mutations this workflow needs:
      - mcp__symphony__comment_current_issue
      - mcp__symphony__add_current_issue_label
      - mcp__symphony__remove_current_issue_label
      - mcp__symphony__set_current_issue_state
      - mcp__symphony__publish_current_change
    tools: [Read, Edit, Write, Glob, Grep]
```

The adapter polls issues and filters out pull requests. Each enabled mutation tool is bound to the
current issue; Claude cannot provide a repository, URL, or issue number. Comment, label, and state
updates execute inside the Symphony process, so the GitHub token never needs to enter the Claude
child environment. A token with repository `Issues: write` permission is required for mutations;
do not add `GITHUB_TOKEN` to `runtime.options.env_allowlist`.

The implicit `GITHUB_TOKEN` fallback is limited to `https://api.github.com`; a custom endpoint must
name its token environment variable explicitly, and authenticated endpoints must use HTTPS. HTTP
mutations are not automatically retried, because retrying a comment could post it twice.

`publish_current_change` stages the bound workspace, creates a commit when needed, pushes the
deterministic `symphony/issue-<number>` branch without force, and creates or updates the matching
open pull request. Its input contains only the commit message, PR title, and PR body; repository,
remote, base branch, branch name, and issue number remain host-controlled. Git hooks, signing,
interactive credentials, and executable Git filters are disabled or rejected during publishing.
The token also needs repository `Contents: write` and `Pull requests: write` permissions. For a
custom API endpoint, configure an explicit HTTPS `git_url`; Symphony will not guess where to send
Git credentials.

After publishing, the GitHub profile adds `human-review` and removes the required `symphony` label.
That leaves the issue open for review while making it unroutable, so no extra workflow state or
database is needed. Create both labels in the target repository before starting the daemon.

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
