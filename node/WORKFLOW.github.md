---
tracker:
  kind: github
  provider:
    owner: YOUR_ORG
    repo: YOUR_REPO
    token: $GITHUB_TOKEN
    base_branch: main
    # For a custom API endpoint, also set an explicit HTTPS git_url.
  required_labels: [symphony]
  active_states: [open]
  terminal_states: [closed]

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony-workspaces

hooks:
  after_create: |
    git clone https://github.com/YOUR_ORG/YOUR_REPO.git .
  timeout_ms: 120000

agent:
  max_concurrent_agents: 1
  max_turns: 3
  max_retry_backoff_ms: 300000

runtime:
  kind: claude
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  options:
    max_agentic_turns: 50
    max_budget_usd: 2
    permission_mode: default
    setting_sources: []
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
    tools: [Read, Edit, Write, Glob, Grep]
---

You are implementing GitHub issue {{ issue.identifier }} in its dedicated workspace.

Title: {{ issue.title }}

Description:
{{ issue.description }}

Follow the repository instructions. Work only inside the current workspace and do not change Git
remotes or Git configuration. Make the smallest complete change and verify it with the available
tools.

When the work is verified, call `publish_current_change` exactly once with a concise commit message,
pull request title, and pull request body containing the verification evidence. Only after publishing
succeeds:

1. Comment on the current issue with the returned pull request URL and verification summary.
2. Add the `human-review` label.
3. Remove the `symphony` label so this issue leaves the agent queue while review continues.

If publishing or verification fails, do not remove `symphony`; report the blocker instead. Never
claim a check passed unless you ran it successfully.
