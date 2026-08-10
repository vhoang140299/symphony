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
- CLI and tooling: Commander, Fastify for optional operational HTTP, pnpm, and Vitest
  (Vite-powered)
- Coding agents: Claude Code via `@anthropic-ai/claude-agent-sdk`, or Codex via `@openai/codex-sdk`
- Trackers: in-memory issues; Linear polling with manual Claude tools, host-controlled handoff, and
  operator retry labels through the official SDK; or GitHub Issues polling with manual Claude tools,
  host-controlled PR delivery, and operator retry labels
- Operations: structured logs, an in-process runtime snapshot, and an optional locally leased
  checkpoint

The in-memory tracker is for development and smoke tests. It does not persist state, synchronize
with an issue service, or give Claude a tool for moving an issue to a new state. Active memory
issues may therefore be retried after a run.

## Prerequisites

- Node.js 24 or newer; [`mise`](https://mise.jdx.dev/) can install the recommended Node version
  from `mise.toml`.
- pnpm 11.20.0; `mise install` installs the pinned package manager from `mise.toml`.
- Git. The GitHub profiles also require the [GitHub CLI](https://cli.github.com/) authenticated with
  access to the target repository.
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
pnpm install --frozen-lockfile
pnpm run build
pnpm start ./WORKFLOW.md
```

Without `mise`, install a supported Node release and pnpm 11.20.0, then run the three `pnpm`
commands directly. The workflow path defaults to `./WORKFLOW.md`.

For one supervised or CI cycle, invoke the built CLI directly so stdout remains machine-readable:

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

To validate routing without creating a workspace or starting an agent, run:

```bash
node dist/src/cli.js --preflight ./WORKFLOW.md
```

`--preflight` validates the workflow, performs one read-only tracker fetch, and prints one JSON
document containing the tracker/runtime kinds, enabled delivery/control flags, fetched count, and
the sorted eligible issue snapshot (IDs, identifiers, and states). This snapshot does not account
for live claims, concurrency capacity, or the final per-issue refresh before dispatch. It does not
run hooks, create workspaces, start an agent, mutate issues, or publish changes. It also does not
validate coding-agent login, model access, or the configured runtime executable. Configuration and
tracker-read failures exit nonzero; an empty or nonempty eligible list is a successful preflight.
`--preflight` and `--once` cannot be combined.

For a completely offline deployment-readiness check, run:

```bash
node dist/src/cli.js --doctor ./WORKFLOW.md
```

`--doctor` prints exactly one compact JSON document with `schemaVersion: 1`, an overall `ok`
boolean, the configured `tracker` and `runtime` kinds, and fixed checks shaped as
`{ id, status, summary }`. The check IDs, in order, are `workflow.config`, `tracker.config`,
`runtime.options`, `runtime.executable`, `runtime.auth`, `workspace.root`, and `state.store`.
`tracker` and `runtime` are `null` when the workflow cannot be loaded. Check status is `ok`,
`warning`, or `error`; warnings still exit zero, while any error exits one. A missing workspace root
or configured checkpoint is a warning because Symphony can create it when real work starts. An
existing unsafe workspace or checkpoint is an error.

Doctor validates workflow and adapter configuration, runtime options, and existing
workspace/checkpoint safety. It is deliberately offline: it does not contact the
tracker or an AI provider, start a subprocess or model, run hooks, create or modify workspace/state
paths, mutate issues, or publish changes. It does not validate credential presence or authentication;
the runtime-authentication check remains a warning. Use `--preflight` for the read-only tracker fetch and a
supervised `--once` run for the real agent path. Doctor output omits paths, tokens, environment
variable names, account details, prompts, and raw underlying errors. `--doctor`, `--preflight`, and
`--once` are mutually exclusive.

For local health checks and aggregate runtime status, opt the continuous daemon into its Fastify
server:

```bash
node dist/src/cli.js --http-port 3000 --http-host 127.0.0.1 ./WORKFLOW.md
```

`--http-host` defaults to `127.0.0.1`. The HTTP flags are daemon-only and cannot be combined with
`--once`, `--preflight`, or `--doctor`. The read-only server exposes:

- `GET /healthz`: reports that the HTTP process is responding.
- `GET /readyz`: reports ready only while the scheduler is initialized and running and no local
  fatal condition, such as a durable checkpoint failure, has stopped it. It does not test tracker
  or coding-agent provider reachability.
- `GET /status`: reports timestamps, aggregate run-state counts, and usage totals. It omits issue
  identifiers, workspace paths, agent session IDs, provider details, and raw errors.
- `GET /api/v1/state`: reports privacy-filtered running, retrying, and blocked entries, including
  issue IDs and identifiers, lifecycle timestamps, retry details, and usage totals. It omits
  workspace paths, agent session IDs, blocked summaries, provider details, and raw errors.

Fatal durable checkpoint errors close the operations server and exit the daemon nonzero. Transient
tracker polling errors remain retryable and do not make the scheduler unready.

These endpoints have no authentication. Keep the default loopback binding; if you bind to a remote
interface, add authentication and network access controls outside Symphony.

For development:

```bash
pnpm run check
pnpm test
pnpm test:watch
```

Tests run with Vitest, the Vite-powered test runner.

## GitHub preview quickstart

Start with Claude and one small issue in a trusted test repository. After installing and building as
above, authenticate Git and create the three labels used by host-controlled delivery and retry:

```bash
SYMPHONY_REPO=YOUR_ORG/YOUR_REPO
gh auth status
gh auth setup-git
gh label create symphony --repo "$SYMPHONY_REPO" --color 1D76DB \
  --description "Queued for Symphony" --force
gh label create human-review --repo "$SYMPHONY_REPO" --color FBCA04 \
  --description "Ready for human review" --force
gh label create symphony-retry --repo "$SYMPHONY_REPO" --color D4C5F9 \
  --description "Retry one blocked Symphony run" --force
```

Copy [`WORKFLOW.github.md`](WORKFLOW.github.md) to a local profile:

```bash
cp WORKFLOW.github.md WORKFLOW.preview.claude.md
```

Replace every `YOUR_ORG` and `YOUR_REPO`, and review the clone hook,
workspace root, limits, prompt, and repository instructions. The token needs `Issues: write`,
`Contents: write`, and `Pull requests: write`; Symphony keeps it in the host process.

Before adding the queue label to any issue, confirm the repository has no open `symphony` issues and
run one no-op poll:

```bash
gh api "repos/$SYMPHONY_REPO/issues?state=open&per_page=100" --paginate \
  --jq '.[] | select(.pull_request == null and (.labels | any(.name == "symphony"))) | .html_url'
GITHUB_TOKEN="$(gh auth token)" \
  node dist/src/cli.js --once ./WORKFLOW.preview.claude.md
```

`--once` is not a dry run. With an empty queue it makes no agent call; after an issue is queued it
performs one poll and waits for that poll's dispatched work. Queue exactly one reviewed issue for
the first real run:

```bash
gh issue edit ISSUE_NUMBER --repo "$SYMPHONY_REPO" --add-label symphony
GITHUB_TOKEN="$(gh auth token)" \
  node dist/src/cli.js --once ./WORKFLOW.preview.claude.md
```

A successful handoff creates or updates `symphony/issue-ISSUE_NUMBER` and its pull request, changes
the issue from `symphony` to `human-review`, and leaves `main` untouched for human review. Once the
supervised flow is proven, omit `--once` to poll continuously.

To use Codex instead, copy [`WORKFLOW.codex.github.md`](WORKFLOW.codex.github.md), make the same
repository edits, and authenticate a dedicated private profile using the
[official Codex authentication guide](https://developers.openai.com/codex/auth/). Do not use your
normal `~/.codex`:

```bash
cp WORKFLOW.codex.github.md WORKFLOW.preview.codex.md
SYMPHONY_CODEX_HOME="$HOME/.symphony-codex"
install -d -m 700 "$SYMPHONY_CODEX_HOME"
CODEX_HOME="$SYMPHONY_CODEX_HOME" pnpm exec codex login
CODEX_HOME="$SYMPHONY_CODEX_HOME" pnpm exec codex login status
GITHUB_TOKEN="$(gh auth token)" CODEX_HOME="$SYMPHONY_CODEX_HOME" \
  node dist/src/cli.js --once ./WORKFLOW.preview.codex.md
```

Keep passing that same dedicated `CODEX_HOME` on every Codex run. Start with one tightly scoped
issue because the Codex SDK reports token usage but does not provide Symphony with a USD limit or
cost amount.

## Workflow configuration

[`WORKFLOW.md`](WORKFLOW.md) is both configuration and prompt. YAML front matter controls the
tracker, polling interval, workspace root, lifecycle hooks, concurrency, optional checkpoint, and
coding-agent runtime. The Markdown body is rendered with Liquid for every issue.

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
before placing it on the short continuation retry queue. Optional `agent.max_attempts` limits
dispatched agent run cycles per issue, including the initial run; omission means unlimited. Host-only
delivery retries do not count. Exhaustion moves the issue to blocked/manual retry. Attempt counters
belong to the claim lifecycle and reset when the claim is released. Without a checkpoint they also
reset when Symphony restarts. An explicit `retryBlocked()` grants one additional run before
reapplying the limit. With `max_turns: 1`, `max_attempts: 3` caps a claimed issue at three SDK queries
before manual retry.

### Durable checkpoint preview

Configure one local checkpoint file to preserve host orchestration state across restarts:

```yaml
state:
  path: ~/.local/state/symphony/checkpoint.json
```

Omitting `state` preserves the current ephemeral behavior. `state.path` supports the same exact
`$ENV_NAME`, `~`/`~/`, and workflow-relative forms as `workspace.root`. The resolved path must be
outside `workspace.root` or name a direct file child of it; it cannot equal the root or sit deeper
inside an issue workspace. The checked-in workflow profiles intentionally leave checkpointing off.

This is a same-host POSIX preview, not a database or durable work queue. Symphony writes one atomic
JSON checkpoint with mode `0600` inside a private `0700` directory. Configuring `state.path` also
enforces one active Symphony process per checkpoint through an append-only lease chain under
`${state.path}.lease`. A clean stop appends a release marker; after a crash, a successor
automatically takes the lease once the recorded PID is dead. It persists retry budgets, ordinary
scheduled retries, blocked claims, and pending host delivery. After restart, an ordinary retry
resumes on schedule, a pending delivery resumes host-only without another model call, and an agent
run dispatched before the crash becomes blocked for manual retry. It does store bounded blocked
summaries plus pending-delivery summary and verification text; these fields are agent-generated and
can quote issue or repository content, so treat the checkpoint as sensitive despite mode `0600`.
The checkpoint never stores tracker credentials, model tokens, rendered prompts, raw provider
events, or agent sessions.

A corrupt checkpoint, tracker/workflow scope mismatch, an active lease, or unsafe ownership or
permissions fails startup rather than silently dispatching work. `state.path` cannot be changed by
workflow hot reload; restart Symphony to change it. Lease ownership is local coordination and is
valid only when contenders share the same host identity and PID namespace; it is not a multi-host,
cross-container, or network-filesystem lock. The append-only lease chain is capped at 1,024 owners
and is not compacted online. To reset it, first stop every process using that checkpoint, then remove
only the exact `${state.path}.lease` directory; never reset a live lease. Without `state.path`, no
lease exists and multiple Symphony processes remain uncoordinated.

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

### Linear tracker

The Linear adapter implements the scheduler's read kernel through the official `@linear/sdk`. It
scopes reads to one project, follows issue pages in batches of 50, and refreshes opaque Linear issue
IDs in batches of 50:

```yaml
tracker:
  kind: linear
  provider:
    project_slug: your-project-slug
    api_key: $LINEAR_API_KEY
    # assignee: me # or a Linear user ID
    # endpoint: https://api.linear.app/graphql
  required_labels: [symphony]
  active_states: [Todo, In Progress]
  terminal_states: [Done, Closed, Cancelled, Canceled, Duplicate]
control:
  retry_label: symphony-retry
agent:
  max_turns: 1
  max_attempts: 3
runtime:
  kind: claude
  options:
    allowed_tools:
      - Read
      - Edit
      - Write
      - Glob
      - Grep
      - mcp__symphony__comment_current_issue
      - mcp__symphony__add_current_issue_label
      - mcp__symphony__remove_current_issue_label
      - mcp__symphony__set_current_issue_state
    tools: [Read, Edit, Write, Glob, Grep]
```

`project_slug` is required. `api_key` defaults to `$LINEAR_API_KEY`; any configured key must be an
environment reference, and Symphony removes both that variable and `LINEAR_API_KEY` from the coding
agent's environment. `assignee` is optional; `me` resolves to the authenticated Linear viewer and a
user ID matches that exact assignee. Custom endpoints must be HTTPS; configure one only when it is
operator-controlled because Symphony sends the Linear API key to it.

Enabling `control.retry_label` or host handoff requires an explicit
`tracker.provider.api_key: $ENV_NAME` reference. The named variable and `LINEAR_API_KEY` cannot be
added to `runtime.options.env_allowlist`; Symphony keeps the credential in the host process for
polling and host-side updates.

The adapter preserves Linear state spelling, normalizes labels to lowercase, and includes inverse
`blocks` relations. A `Todo` issue is dispatchable only when every known blocker is in a configured
terminal state and the optional assignee matches. Candidate pages drop malformed records; an ID
refresh fails closed if a requested record is malformed. Empty state or ID lists make no request.

The four optional Claude tools above are typed, host-side operations bound to the current Linear
issue. Before each update Symphony refreshes the issue and verifies its identifier, project, team,
and configured assignee. State names must uniquely match an existing state in that team; labels must
uniquely match an existing non-group team or workspace label. The model cannot supply an issue ID,
project, team, API endpoint, or raw GraphQL request, and the Linear API key stays out of the coding
agent environment. Omit the tool names to keep Linear read-only. Codex does not expose these
in-process tools. `control.retry_label` must differ from every required label and is reserved for
the operator; agent mutation tools cannot add or remove it.

Linear workflows default to one turn per run and three total attempts; explicit
`agent.max_turns` and `agent.max_attempts` override those defaults. A manual state tool can move the
issue out of `active_states` after a verified handoff so the current claim is released immediately.

For a host-controlled Linear handoff with either runtime, add a review state instead of GitHub's
queue/review label pair:

```yaml
delivery:
  review_state: Human Review
runtime:
  kind: codex
  options:
    model_reasoning_effort: high
```

The configured state must exist uniquely in the issue's Linear team and must differ
case-insensitively from every active and terminal state. In this mode the agent edits and verifies,
then returns the existing constrained `status`, `summary`, and `verification` completion. A `blocked`
completion leaves the issue blocked. For `ready`, Symphony writes one idempotent handoff comment
after revalidating the owned workspace and issue routing, then refreshes routing again before moving
the issue to `review_state`; the state transition is last so an ambiguous response cannot discard the
handoff details or overwrite an earlier observed transition. A failed host update retries with the
same completion and comment identity without rerunning the agent. With `state.path`, that pending
handoff survives a restart.
Linear handoff does not publish a branch or pull request and, like GitHub delivery, rejects
`hooks.after_run`.

Create the configured retry label in Linear before starting Symphony. Adding it to a blocked,
still-routable issue requests at most one extra run with either runtime. Symphony removes the label
before releasing the run; if removal fails, the claim stays blocked. After that run, `max_attempts`
applies again. If an ambiguous provider response removes the label but the issue remains blocked,
add the label again to request another retry. A configured `state.path` restores the blocked claim
across restarts so a later poll can consume the label.

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

control:
  retry_label: symphony-retry

agent:
  max_turns: 1
  max_attempts: 3

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

GitHub PR delivery uses the queue/review label pair above; Linear handoff instead uses
`delivery.review_state`. Operator retry control supports both trackers.
`delivery.queue_label` must be one of `tracker.required_labels`; `delivery.review_label` and
`control.retry_label` must differ from the required and delivery labels. Create all three labels in
the repository before starting Symphony so their color and description are controlled and the
profile remains portable to GitHub Enterprise. GitHub.com may create a missing review label with
default metadata. The checked-in profiles use one SDK query per run (`agent.max_turns: 1`) because
each run must make an explicit handoff decision, and block after three dispatched runs
(`agent.max_attempts: 3`).

Adding `control.retry_label` to an issue requests one more run only when that issue is already
blocked in the current process and remains routable. Symphony removes the retry label before
releasing the run; if removal fails, the issue stays blocked. After that one run, `max_attempts`
applies again. This control is at-most-once: if the label disappears but the issue remains blocked
after an ambiguous GitHub response, add the label again. Without `state.path`, blocked claims are in
memory: restarting Symphony loses them, leaves any retry label on GitHub, and may dispatch the
still-routable issue as a fresh claim instead of consuming the label. A configured checkpoint
restores the blocked claim so a later poll can consume the retry label.

```bash
gh issue edit ISSUE_NUMBER --repo "$SYMPHONY_REPO" --add-label symphony-retry
```

In GitHub PR delivery mode, Claude and Codex return a constrained result with this shape:

```json
{
  "status": "ready",
  "summary": "Implemented the requested change.",
  "verification": ["pnpm test — passed"]
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
Without `state.path`, pending delivery is in memory; after a process restart, a still-routable issue
can be dispatched to the agent again. A configured checkpoint instead resumes host delivery without
rerunning the agent.

For GitHub, host delivery and operator retry control require `tracker.provider.token` to be an
explicit environment reference such as `$GITHUB_TOKEN`; set that variable in Symphony's host
environment. The named variable and `GITHUB_TOKEN` must not appear in
`runtime.options.env_allowlist`. Comment and label updates execute inside Symphony, so the tracker
credential never needs to enter the coding-agent child. The checked-in profiles need repository
`Issues: write`, `Contents: write`, and `Pull requests: write` permissions.

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

The MVP deliberately has no database, durable queue, multi-node coordination, or dashboard. Add
those only when the target deployment requires them.

Approval or user-input requests fail closed and remain visible in `Orchestrator.snapshot()` until
an embedding calls `retryBlocked()`, or the tracker moves the issue out of an active state. The CLI
does not yet provide an operator UI for this path.

## License

This implementation uses the repository's [Apache License 2.0](../LICENSE).
