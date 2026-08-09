import assert from "node:assert/strict";
import { test } from "vitest";
import { MemoryTracker } from "../src/trackers/memory.js";

function rawIssue(id: string, identifier: string = id, labels: string[] = []) {
  return { id, identifier, title: `Issue ${id}`, state: "Todo", labels };
}

test("normalizes labels and returns independent issue copies", async () => {
  const tracker = new MemoryTracker({
    issues: [rawIssue("1", "ISSUE-1", [" Bug ", "BUG", "", "  Ready  "])],
  });

  const [issue] = await tracker.fetchIssuesByStates([" todo "]);
  assert.ok(issue);
  assert.deepEqual(issue.labels, ["bug", "ready"]);

  issue.labels.push("mutated");
  const [fresh] = await tracker.fetchIssuesByIds(["1"]);
  assert.ok(fresh);
  assert.deepEqual(fresh.labels, ["bug", "ready"]);
});

test("rejects duplicate issue ids and identifiers", () => {
  assert.throws(
    () => new MemoryTracker({ issues: [rawIssue("1", "ISSUE-1"), rawIssue("1", "ISSUE-2")] }),
    /Duplicate memory issue id: 1/,
  );
  assert.throws(
    () => new MemoryTracker({ issues: [rawIssue("1", "ISSUE-1"), rawIssue("2", "ISSUE-1")] }),
    /Duplicate memory issue identifier: ISSUE-1/,
  );
});

test("fetchIssuesByIds deduplicates requested ids while preserving order", async () => {
  const tracker = new MemoryTracker({
    issues: [rawIssue("1", "ISSUE-1"), rawIssue("2", "ISSUE-2")],
  });

  const issues = await tracker.fetchIssuesByIds(["2", "1", "2", "missing", "1"]);
  assert.deepEqual(
    issues.map((issue) => issue.id),
    ["2", "1"],
  );
  assert.deepEqual(await tracker.fetchIssuesByIds([]), []);
});
