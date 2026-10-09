// Splits a list into pages of `perPage` items. Pages are numbered from 1.

export function pageCount(total: number, perPage: number): number {
  if (!Number.isInteger(perPage) || perPage < 1) throw new RangeError("perPage must be a positive integer");
  if (!Number.isInteger(total) || total < 0) throw new RangeError("total must be a non-negative integer");
  return Math.floor(total / perPage);
}

export function page<T>(items: readonly T[], n: number, perPage: number): T[] {
  const count = pageCount(items.length, perPage);
  if (!Number.isInteger(n) || n < 1 || n > count) return [];
  return items.slice((n - 1) * perPage, n * perPage);
}
