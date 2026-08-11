import assert from "node:assert/strict";
import { test } from "vitest";
import { MemoryTracker } from "../src/memory.js";
import { trackerError } from "./assertions.js";

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
    trackerError("invalid_tracker_config", /Duplicate memory issue id: 1/),
  );
  assert.throws(
    () => new MemoryTracker({ issues: [rawIssue("1", "ISSUE-1"), rawIssue("2", "ISSUE-1")] }),
    trackerError("invalid_tracker_config", /Duplicate memory issue identifier: ISSUE-1/),
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

test("accepts only RFC 3339 timestamps and null native references", async () => {
  const tracker = new MemoryTracker({
    issues: [{
      ...rawIssue("1", "ISSUE-1"),
      native_ref: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T01:00:00+01:00",
    }],
  });
  const [issue] = await tracker.fetchIssuesByIds(["1"]);
  assert.ok(issue);
  assert.equal(issue.nativeRef, null);
  assert.equal(issue.createdAt, "2025-01-01T00:00:00Z");
  assert.equal(issue.updatedAt, "2025-01-01T01:00:00+01:00");

  for (const field of ["created_at", "updated_at"] as const) {
    assert.throws(
      () => new MemoryTracker({ issues: [{ ...rawIssue("1"), [field]: "2025-01-01T00:00:00" }] }),
      trackerError("invalid_tracker_config"),
    );
  }

  for (const nativeRef of [{ number: 7 }, { token: "must-not-enter-agent-context" }]) {
    assert.throws(
      () => new MemoryTracker({ issues: [{ ...rawIssue("1"), native_ref: nativeRef }] }),
      trackerError("invalid_tracker_config"),
    );
  }
});

test("rejects blank state updates without changing the issue", async () => {
  assert.throws(
    () => new MemoryTracker({ issues: [{ ...rawIssue("1"), state: " " }] }),
    trackerError("invalid_tracker_config", /Memory issue state must be a non-empty string/),
  );

  const tracker = new MemoryTracker({ issues: [rawIssue("1")] });
  for (const state of ["", " \t "]) {
    assert.throws(
      () => tracker.setIssueState("1", state),
      /Memory issue state must be a non-empty string/,
    );
  }
  const [unchanged] = await tracker.fetchIssuesByIds(["1"]);
  assert.ok(unchanged);
  assert.equal(unchanged.state, "Todo");
  assert.equal(unchanged.updatedAt, null);

  tracker.setIssueState("1", " In Progress ");
  const [updated] = await tracker.fetchIssuesByIds(["1"]);
  assert.ok(updated?.updatedAt);
  assert.equal(updated.state, " In Progress ");
  assert.equal(new Date(updated.updatedAt).toISOString(), updated.updatedAt);
});
