import assert from "node:assert/strict";
import { TrackerError, type TrackerErrorCategory } from "../src/error.js";

export function trackerError(
  category: TrackerErrorCategory,
  message?: RegExp,
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof TrackerError);
    assert.equal(error.category, category);
    assert.equal(error.cause, undefined);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  };
}
