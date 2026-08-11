import type { Issue } from "@ai-symphony/core/domain.js";

export const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
export const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REQUEST_TIMEOUT_MS = 30_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported ${subject} option(s): ${unknownKeys.sort().join(", ")}`);
  }
}

export function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeHttpUrl(
  value: unknown,
  fallback: string,
  setting: string,
  protocols: readonly string[],
): string {
  const requirement = `${setting} must be an ${protocols.length === 1 ? "HTTPS" : "HTTP(S)"} URL`;
  const raw = value ?? fallback;
  if (typeof raw !== "string" || raw.trim() === "") throw new Error(requirement);

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(requirement);
  }
  if (
    !protocols.includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${requirement} without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function routingFingerprint(issue: Issue): string {
  const labels = issue.labels.map(normalizeToken).sort();
  const blockedBy = issue.blockedBy
    .map(({ id, identifier, state }) => JSON.stringify([
      id,
      identifier,
      state === null ? null : normalizeToken(state),
    ]))
    .sort();
  return JSON.stringify({
    state: normalizeToken(issue.state),
    labels,
    blockedBy,
    dispatchable: issue.dispatchable,
  });
}

export function sameRoutingSnapshot(expected: Issue, current: Issue): boolean {
  if (
    expected.id !== current.id ||
    expected.identifier !== current.identifier ||
    expected.updatedAt === null ||
    current.updatedAt === null ||
    Date.parse(expected.updatedAt) !== Date.parse(current.updatedAt)
  ) return false;
  return routingFingerprint(expected) === routingFingerprint(current);
}

export function nextLinkTargets(value: string): string[] | null {
  const targets: string[] = [];
  for (const part of splitLinkHeader(value)) {
    const bracketed = /^\s*<([^>]*)>/.exec(part);
    if (bracketed === null) {
      if (part.trim() === "") continue;
      return null;
    }
    const relation = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(part.slice(bracketed[0].length));
    const relations = (relation?.[1] ?? relation?.[2] ?? "").split(/\s+/);
    if (relations.includes("next")) targets.push(bracketed[1] ?? "");
  }
  return targets;
}

function splitLinkHeader(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angle = false;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (!angle && character === "\"") {
      quoted = !quoted;
    } else if (!quoted && character === "<") {
      angle = true;
    } else if (!quoted && character === ">") {
      angle = false;
    } else if (!angle && !quoted && character === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}
