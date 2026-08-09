---
tracker:
  kind: memory
  # This inert memory demo cannot use host delivery. For Linear, replace this tracker and add
  # `delivery.review_state` as shown in README.md.
  provider:
    issues:
      - id: "demo-1"
        identifier: "DEMO-1"
        title: "Describe the first task here"
        description: "Replace this sample with a small, verifiable coding task."
        state: "Todo"
        priority: 1
        labels: ["symphony"]
        # Keep the checked-in example inert until the task and clone hook are configured.
        dispatchable: false
  required_labels: ["symphony"]
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony-workspaces

hooks:
  # Set SOURCE_REPO_URL in the host environment, then uncomment to populate each new workspace.
  # after_create: |
  #   git clone --depth 1 "$SOURCE_REPO_URL" .
  timeout_ms: 60000

agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 300000

runtime:
  kind: claude
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  options:
    max_agentic_turns: 20
    permission_mode: default
    allowed_tools: [Read, Edit, Write, Glob, Grep]
    tools: [Read, Edit, Write, Glob, Grep]
    # Add Bash to both lists only after accepting unsandboxed host command execution.
    # allowed_tools: [Read, Edit, Write, Glob, Grep, Bash]
    # tools: [Read, Edit, Write, Glob, Grep, Bash]
    setting_sources: []
---

You are working on issue {{ issue.identifier }} in an isolated workspace.

Title: {{ issue.title }}

Description:
{{ issue.description }}

Work only inside the current workspace. Inspect the repository instructions before editing. Make
the smallest complete change, run the relevant checks available to you, and summarize the result
and any remaining blocker. Do not claim the issue is complete unless you have verification.
