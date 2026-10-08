// 0.1 reference-profile resource limits (Doc 4 §3.4). These bound what the
// checker accepts; they are not scale claims.
export const LIMITS = {
  /** Source size in bytes (UTF-8). */
  sourceBytes: 1024 * 1024,
  /** JSON nesting depth of the canonical IR. */
  jsonDepth: 64,
  /** Number of top-level definitions in one program. */
  definitions: 64,
  /** Expanded static node count (enforced by the static checks in 0.1 step 2). */
  expandedNodes: 1000,
} as const;
