# Symphony

Symphony turns project work into isolated, autonomous implementation runs, allowing teams to manage
work instead of supervising coding agents.

[![Symphony demo video preview](.github/media/symphony-demo-poster.jpg)](https://player.vimeo.com/video/1186371009?h=5626e4b899)

_In this [demo video](https://player.vimeo.com/video/1186371009?h=5626e4b899), Symphony monitors a Linear board for work and spawns agents to handle the tasks. The agents complete the tasks and provide proof of work: CI status, PR review feedback, complexity analysis, and walkthrough videos. When accepted, the agents land the PR safely. Engineers do not need to supervise Codex; they can manage the work at a higher level._

> [!WARNING]
> Symphony is a low-key engineering preview for testing in trusted environments.

## Running Symphony

### Requirements

Symphony works best in codebases that have adopted
[harness engineering](https://openai.com/index/harness-engineering/). Symphony is the next step --
moving from managing coding agents to managing work that needs to get done.

### Option 1. Make your own

Tell your favorite coding agent to build Symphony in a programming language of your choice:

> Implement Symphony according to the following spec:
> https://github.com/openai/symphony/blob/main/SPEC.md

### Option 2. Use an experimental implementation

Choose the implementation that fits your environment. Both follow [SPEC.md](SPEC.md) and keep
independent toolchains and release tags:

- [Node.js/TypeScript](node/README.md) — setup: `cd node && mise trust && mise install && mise exec
  -- pnpm install --frozen-lockfile`; validate: `mise exec -- pnpm test`; releases: `node-v*`.
- [Elixir](elixir/README.md) — setup: `cd elixir && mise trust && mise install && mise exec -- make
  setup`; validate: `mise exec -- make all`; releases: `v*`.

---

## License

This project is licensed under the [Apache License 2.0](LICENSE).
