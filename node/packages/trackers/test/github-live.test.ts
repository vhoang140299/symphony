import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { createTracker } from "../src/registry.js";

const enabled = process.env.SYMPHONY_RUN_GITHUB_LIVE_E2E === "1";

test.skipIf(!enabled)("round-trips a real disposable GitHub issue", { timeout: 120_000 }, async () => {
  const { owner, repo } = parseRepository(requiredEnv("SYMPHONY_LIVE_GITHUB_REPO"));
  const token = requiredEnv("GITHUB_TOKEN");
  const runId = randomUUID();
  let issueId: string | undefined;

  try {
    const created = await githubRequest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      token,
      {
        title: `Symphony Node live E2E ${runId}`,
        body: `Disposable issue created by the Symphony Node GitHub live E2E test.\n\nrun_id=${runId}`,
      },
    );
    assert.equal(typeof created.number, "number");
    issueId = String(created.number);

    const tracker = createTracker("github", {
      owner,
      repo,
      token: "$GITHUB_TOKEN",
    });
    let issue = (await tracker.fetchIssuesByStates(["open"])).find(({ id }) => id === issueId);
    for (let attempt = 1; attempt < 20 && issue === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      issue = (await tracker.fetchIssuesByStates(["open"])).find(({ id }) => id === issueId);
    }
    assert.ok(issue);
    assert.equal(issue.identifier, `${owner}/${repo}#${issueId}`);
    assert.deepEqual((await tracker.fetchIssuesByIds([issueId])).map(({ id }) => id), [issueId]);

    const mutateIssue = tracker.mutateIssue?.bind(tracker);
    assert.ok(mutateIssue);
    await mutateIssue(issue, { kind: "set_state", state: "closed" }, AbortSignal.timeout(30_000));
    const [closed] = await tracker.fetchIssuesByIds([issueId]);
    assert.equal(closed?.state, "closed");
  } finally {
    if (issueId !== undefined) {
      await githubRequest(
        "PATCH",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueId}`,
        token,
        { state: "closed" },
      );
    }
  }
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required for the GitHub live E2E test`);
  return value;
}

function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(value);
  if (match === null) throw new Error("SYMPHONY_LIVE_GITHUB_REPO must use owner/repo form");
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

async function githubRequest(
  method: "POST" | "PATCH",
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ai-symphony-node-live-e2e",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`GitHub live E2E ${method} ${path} failed before a response`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`GitHub live E2E ${method} ${path} failed with HTTP ${response.status}`);
  }
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new Error(`GitHub live E2E ${method} ${path} returned invalid JSON`);
  }
}
