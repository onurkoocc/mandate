// Types of scripts/lib/self-review-world.mjs for the TypeScript that imports it (the self-review kit's test).

export interface SourceFile {
  path: string;
  lines: number;
}
export interface Component {
  task: string;
  title: string;
  focus: string;
  files: SourceFile[];
}
export interface Finding {
  task: string;
  file: SourceFile;
  line: number;
  title: string;
  what: string;
  evidence: string;
  severity: string;
  confidence: string;
}
export interface ReportEntry {
  entry_id: string;
  key: string;
  finding_key: string;
  finding: Finding;
  at: string;
  calls: number;
}
export interface ToolOfServer {
  name: string;
  run(args: Record<string, unknown>): { structured: Record<string, unknown>; text: string } | { error: string };
}

export const COMPONENTS: Array<{ task: string; title: string; focus: string; paths: string[] }>;
export const SIMULATED: Record<string, "grounded" | "unsure" | "off_the_end">;
export const SNAPSHOT_MARKER: string;
export const REVIEW_KNOWN: string[];
export function snapshotGrant(program: string): string;
export function commitOf(repo: string, rev?: string): string;
export function writeSnapshot(repo: string, target: string, commit: string, sessionId: string, components?: Array<{ task: string; title: string; focus: string; paths: string[] }>): Component[];
export function readSnapshotMarker(dir: string): { format: string; session: string; commit: string } | undefined;
export function removeSnapshot(dir: string, sessionId: string): boolean;
export function findingKey(f: Finding): string;
export function reportState(o: { dir: string; components: Component[]; commit: string }): { entries: ReportEntry[]; counts: { appended: number; retried: number; same_finding: number }; tools: ToolOfServer[]; files: { md: string; jsonl: string } };
export function simulatedReview(args: unknown, snapshot: string): { ok?: Finding; error?: unknown; cost: Record<string, unknown> };
export function reviewLockFrom(template: unknown, maintainer: { member: string; keyId: string }): Record<string, unknown>;
export function reviewEgressConfig(admin: string, real?: { env: string }): Record<string, unknown>;
export function reviewRuntimeConfig(template: unknown, o: { database: string; admin: string; real?: { env: string } }): Record<string, unknown>;
export function startReviewWorld(
  o: { dir: string; repo: string; snapshot: string; commit: string; database?: string; real?: { env: string }; log?: (line: string) => void },
  deps: { serveEgress: (o: { config: string; env: Record<string, string>; resolve: unknown; dial: unknown }) => Promise<{ stop(): Promise<void> }>; defaultDialer?: unknown; isPublicAddress?: (a: string) => boolean },
): Promise<{ dir: string; id: string; config: string; components: Component[]; report: ReturnType<typeof reportState>; port: number; admin: string; stop(): Promise<void> }>;
export function newReviewSessionDir(): string;
export function cleanReviewSession(dir: string): { removed: string[]; left: string[]; dirRemoved: boolean; snapshot: string | undefined; snapshotRemoved: boolean };
