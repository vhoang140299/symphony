import path from "node:path";

export function pickEnvironment(
  names: Iterable<string>,
  sensitiveNames: readonly string[] = [],
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const excluded = new Set(sensitiveNames.map((name) => name.toUpperCase()));
  const environment: Record<string, string> = {};
  for (const name of new Set([...names, ...Object.keys(overrides)])) {
    if (excluded.has(name.toUpperCase())) continue;
    const value = Object.hasOwn(overrides, name) ? overrides[name] : process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function isPathContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
