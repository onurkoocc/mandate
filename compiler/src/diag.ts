// Diagnostics in the JSON shape of Doc 4 §13.1.
// `code` is stable and machine-read; `message` is for humans and may change.

export type Severity = "error" | "warning";

/** [startLine, startCol, endLine, endCol], 1-based, end exclusive. */
export type Span = [number, number, number, number];

export interface Location {
  /** Definition the diagnostic belongs to, when known. */
  def?: string;
  /** RFC 6901 JSON Pointer into the canonical IR. */
  path?: string;
  /** Source span in the file that was read (text or JSON). */
  span?: Span;
}

export interface RepairOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

export interface Repair {
  id: string;
  summary: string;
  patch: RepairOp[];
  risk: "low" | "medium" | "high";
  requires_approval?: boolean;
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  at: Location;
  facts?: Record<string, unknown>;
  repair?: Repair[];
  docs: string;
}

export function diag(
  code: string,
  message: string,
  at: Location = {},
  extra: { facts?: Record<string, unknown>; repair?: Repair[] } = {},
): Diagnostic {
  const severity: Severity = code.startsWith("W") ? "warning" : "error";
  const full = `MDT-${code}`;
  const d: Diagnostic = { code: full, severity, message, at, docs: `mandate explain ${full}` };
  if (extra.facts) d.facts = extra.facts;
  if (extra.repair) d.repair = extra.repair;
  return d;
}

export function hasErrors(diags: readonly Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

/** Carries diagnostics out of a phase that cannot continue. */
export class DiagnosticError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
}

export function formatDiagnostic(d: Diagnostic, file?: string): string {
  const where = d.at.span ? `${file ?? "<input>"}:${d.at.span[0]}:${d.at.span[1]}` : (file ?? "<input>");
  const path = d.at.path !== undefined ? ` [${d.at.path}]` : "";
  return `${where}: ${d.severity} ${d.code}: ${d.message}${path}`;
}

/** Escapes one JSON Pointer reference token (RFC 6901 §4). */
export function ptrToken(s: string | number): string {
  return String(s).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function ptr(...tokens: Array<string | number>): string {
  return tokens.length === 0 ? "" : "/" + tokens.map(ptrToken).join("/");
}
