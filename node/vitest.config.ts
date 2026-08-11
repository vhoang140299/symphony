import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesRoot = fileURLToPath(new URL("./packages/", import.meta.url));

// Cross-package imports use the same subpath specifiers the packages publish
// (`@ai-symphony/core/domain.js`). Pointing them at the TypeScript sources keeps
// `vitest` usable without building the workspace first and keeps stack traces on
// source lines.
const workspaceAliases = ["core", "agents", "trackers", "server"].map((name) => ({
  find: new RegExp(`^@ai-symphony/${name}/(.*)\\.js$`, "u"),
  replacement: `${packagesRoot}${name}/src/$1.ts`,
}));

function project(name: string) {
  return {
    resolve: { alias: workspaceAliases },
    test: {
      name,
      root: `packages/${name}`,
      environment: "node",
      include: ["test/**/*.test.ts"],
    },
  };
}

export default defineConfig({
  test: {
    projects: [project("core"), project("agents"), project("trackers"), project("server"), project("cli")],
  },
});
