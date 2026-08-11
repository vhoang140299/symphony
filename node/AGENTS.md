# Symphony Node

This directory is the Node.js/TypeScript Symphony implementation, organized as a pnpm workspace.
Keep it aligned with [`SPEC.md`](../SPEC.md) without changing the Elixir implementation for
Node-only work. See [`README.md`](README.md) for the package layout.

## Conventions

- Use strict TypeScript, native ESM, Node built-ins, and existing dependencies before adding one.
- Respect the package boundaries: `core` must not import from `agents`, `trackers`, `server`, or
  `cli`, and `agents` and `trackers` must not import from each other. The dependency graph stays
  acyclic.
- Import across packages with the published subpath specifier
  (`@ai-symphony/core/domain.js`), never a relative path that escapes the package.
- Add a shared dependency to the `catalog` in `pnpm-workspace.yaml` and reference it with
  `"catalog:"` rather than pinning a version per package. A package must declare every dependency
  it imports, including `@types/node`.
- Keep workflow configuration in `packages/core/src/config/`; avoid ad-hoc environment reads outside
  adapter boundaries.
- Keep tracker-specific behavior in `packages/trackers/src/` and agent-specific behavior in
  `packages/agents/src/`.
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

Run focused tests while editing — `pnpm vitest run --project core` limits the run to one package.
Use `pnpm run check` for fast type-check feedback across packages, tests, and the dashboard. Finish
with the full gate, which builds and type-checks before running every suite:

```bash
pnpm test
```

Update `packages/cli/README.md` and `workflows/WORKFLOW.md` whenever public configuration or runtime
behavior changes, and the package table in `README.md` whenever a package's contents change.
