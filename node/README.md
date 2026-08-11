# Symphony Node

TypeScript implementation of the Symphony coding-agent orchestrator, organized as a pnpm workspace.

Full product documentation — configuration, trackers, agents, the operations API and dashboard —
lives in [`packages/cli/README.md`](packages/cli/README.md).

## Packages

| Package | Name | Contents |
| --- | --- | --- |
| [`packages/core`](packages/core) | `@ai-symphony/core` | Domain model and normalizers, workflow config/schema/store, run state and leases, routing, workspace manager, Git publishing |
| [`packages/agents`](packages/agents) | `@ai-symphony/agents` | Claude and Codex agent drivers, the driver registry, and the Codex wrapper |
| [`packages/trackers`](packages/trackers) | `@ai-symphony/trackers` | GitHub, Linear and in-memory trackers plus the tracker registry |
| [`packages/server`](packages/server) | `@ai-symphony/server` | Orchestrator run loop and the operations HTTP server |
| [`packages/cli`](packages/cli) | `@ai-symphony/node` | `symphony-node` binary, doctor, preflight, and the public API barrel |
| [`packages/dashboard`](packages/dashboard) | `@ai-symphony/dashboard` | React operations dashboard |

The dependency graph is acyclic and flows in one direction:

```
core ──┬──> agents ──┐
       ├──> trackers ─┼──> server ──> cli
       └──────────────┘
```

`core` deliberately owns `publish/git.ts`: both `agents` (Codex needs the Git executable) and
`trackers` (GitHub publishes branches) depend on it, so placing it any higher would create a cycle.

Every package is `private` — nothing is published to npm right now. The internal packages expose
their modules through subpath exports rather than a barrel, so a cross-package import names the
module it wants:

```ts
import type { Issue } from "@ai-symphony/core/domain.js";
import { createTracker } from "@ai-symphony/trackers/registry.js";
```

Shared dependency versions live in the `catalog` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) so
they cannot drift between packages.

## Commands

Run these from the repository root:

```bash
pnpm install
pnpm run build   # tsc -b across packages, then the dashboard bundle
pnpm run check   # build, type-check every test file, type-check the dashboard
pnpm test        # build, then the full Vitest suite
pnpm test:watch  # Vitest in watch mode
pnpm run clean   # drop every dist directory and build info
```

`pnpm run build` uses TypeScript project references, so packages compile in dependency order and
each emits `dist/` next to its `src/`. The dashboard bundle is emitted into
`packages/server/dist/dashboard`, because the operations server serves it from there.

Tests are Vitest projects, one per package. Cross-package specifiers are aliased to TypeScript
sources in [`vitest.config.ts`](vitest.config.ts), so `pnpm test:watch` needs no build. `pnpm test`
still builds first because the CLI suite exercises the compiled `packages/cli/dist/cli.js`.

The real GitHub tracker smoke test is opt-in and must target a disposable repository with Issues
enabled. It creates one isolated issue, reads it through the production adapter, closes it, and
reports as skipped unless explicitly enabled:

```bash
SYMPHONY_RUN_GITHUB_LIVE_E2E=1 \
SYMPHONY_LIVE_GITHUB_REPO=owner/disposable-repo \
GITHUB_TOKEN="$GITHUB_TOKEN" \
pnpm test:integration:github
```

The test always attempts to close the issue in cleanup. GitHub does not support deleting issues,
so the closed issue remains as an audit record. This profile does not start an agent or publish a
pull request.

Example workflow profiles are in [`workflows/`](workflows).

## Relationship to the Elixir implementation

This implementation lives alongside the Elixir implementation and the shared
[`SPEC.md`](../SPEC.md). Keep behavior aligned with that spec.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
