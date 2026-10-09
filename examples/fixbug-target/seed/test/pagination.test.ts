import assert from "node:assert/strict";
import { test } from "node:test";
import { page, pageCount } from "../src/pagination.ts";

test("counts pages when the items fill them exactly", () => {
  assert.equal(pageCount(10, 5), 2);
  assert.deepEqual(page([1, 2, 3, 4], 2, 2), [3, 4]);
});

test("has no pages without items", () => {
  assert.equal(pageCount(0, 5), 0);
  assert.deepEqual(page([], 1, 5), []);
});

test("returns an empty page out of range", () => {
  assert.deepEqual(page([1, 2], 3, 2), []);
  assert.deepEqual(page([1, 2], 0, 2), []);
});

test("rejects a page size below one", () => {
  assert.throws(() => pageCount(3, 0), RangeError);
});
