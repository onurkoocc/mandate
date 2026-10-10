// Acceptance tests for issue #1. Owned by the maintainers: a fix must make
// them pass without changing them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { page, pageCount } from "../src/pagination.ts";

test("counts the last, partial page", () => {
  assert.equal(pageCount(11, 5), 3);
  assert.equal(pageCount(1, 5), 1);
});

test("returns the items of the last, partial page", () => {
  assert.deepEqual(page([1, 2, 3, 4, 5], 3, 2), [5]);
  assert.deepEqual(page(["a"], 1, 10), ["a"]);
});

test("leaves exact pages as they were", () => {
  assert.equal(pageCount(10, 5), 2);
  assert.deepEqual(page([1, 2, 3, 4], 2, 2), [3, 4]);
});
