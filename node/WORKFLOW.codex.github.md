---
tracker:
  kind: github
  provider:
    owner: YOUR_ORG
    repo: YOUR_REPO
    token: $GITHUB_TOKEN
    base_branch: main
  required_labels: [symphony]
  active_states: [open]
  terminal_states: [closed]

delivery:
  queue_label: symphony
  review_label: human-review

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
  max_turns: 1
  max_retry_backoff_ms: 300000

runtime:
  kind: codex
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  options:
    model_reasoning_effort: high
---

You are implementing GitHub issue {{ issue.identifier }} in its dedicated workspace.

Title: {{ issue.title }}

Description:
{{ issue.description }}

Follow the repository instructions. Work only inside the current workspace and do not change Git
remotes or Git configuration. Make the smallest complete change and verify it with the available
tools.

Return `status: ready` only after the implementation and its verification are complete. Put a concise
change summary in `summary` and every check you actually ran in `verification`. Return
`status: blocked` when the change cannot safely be handed off; explain why in `summary` and include
the checks or evidence gathered in `verification`. Never claim a check passed unless you ran it
successfully. Symphony handles commits, pull requests, issue comments, and labels after your run.
