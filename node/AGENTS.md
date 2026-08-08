# Symphony Node

This directory is the Node.js/TypeScript Symphony implementation. Keep it aligned with
[`../SPEC.md`](../SPEC.md) without changing the Elixir implementation for Node-only work.

## Conventions

- Use strict TypeScript, native ESM, Node built-ins, and existing dependencies before adding one.
- Keep workflow configuration in `src/config/`; avoid ad-hoc environment reads outside adapter
  boundaries.
- Keep tracker-specific behavior in `src/trackers/` and agent-specific behavior in `src/agents/`.
- Preserve workspace containment: an agent must never run in this source checkout or outside the
  configured workspace root.
- Keep claims, retries, blocked runs, reconciliation, and cleanup consistent across success,
  failure, timeout, and shutdown paths.
- Do not enable Claude `bypassPermissions`. Treat hooks and expanded tool permissions as trusted
  code execution.
- Keep Codex in `workspace-write` with network, web search, login shells, and subagents disabled
  unless a reviewed deployment requirement explicitly changes that boundary.
- Bind provider mutation tools to the current issue in the host process; never expose tracker
  tokens, arbitrary repository targets, or raw provider errors to the agent child.
- Bind publishing to the current issue and owned workspace. Derive branch/base/remotes host-side,
  disable repository-controlled Git execution, and never put credentials in clone URLs or logs.
- Prefer the smallest coherent implementation; do not add a database, queue, framework, or
  abstraction without a current requirement.

## Validation

Run focused tests while editing, then finish with:

```bash
npm run check
npm test
```

Update `README.md` and `WORKFLOW.md` whenever public configuration or runtime behavior changes.
