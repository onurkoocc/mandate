// Types of scripts/lib/live-world.mjs for the TypeScript that imports it (the rehearsal's world, the kit's test).

export interface Book {
  N: number;
  TOTALS: number[];
  WITHIN: number[];
  VENDOR: number[];
  ALL: number[];
  PASSED: number[];
  invoiceNo(i: number): string;
  orderNo(i: number): string;
  vendorOf(i: number): string;
  invoice(i: number): { invoice_no: string; vendor_id: string; total_cents: number };
  order(i: number): { order_no: string; vendor_id: string; total_cents: number };
  values(): { texts: string[]; numbers: number[] };
}
export function makeBook(o?: { invoice?: string; order?: string; vendor?: string; other?: string; n?: number; totals?: number[]; within?: number[]; vendors?: number[]; base?: number; step?: number }): Book;
export const LIVE: Book;
export function simulatedMatch(book: Book, args: unknown): { ok?: unknown; error?: unknown; cost: Record<string, unknown> };

export function isLoopbackAddress(a: string): boolean;
export function isReservedName(host: string): boolean;
export function assertLocalOnly(what: string, host: string): void;
export function hostsIn(text: string): string[];

export function durationMs(text: string): number;
export function clockOffsetMs(dir: string): number;
export function advanceClock(dir: string, ms: number): number;

export function fill(value: unknown, given: Record<string, unknown>): any;
export function placeholders(text: string): string[];
export function lockFrom(template: unknown, people: Record<"accountant" | "finance_lead", { member: string; keyId: string }>): any;
export function egressConfigFor(admin: string, real?: { env: string }): any;
export function runtimeConfigFor(template: unknown, o: { database: string; admin: string; real?: { env: string } }): any;

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export function mcpServer(o: { tools: unknown[]; header: string; secret: string; log?: (line: string) => void }): (req: FakeRequest) => FakeResponse;
export function erpState(book: Book): { orders: Array<{ order_no: string; vendor_id: string; total_cents: number }>; drafts: Map<string, { draft_id: string; invoice_no: string; order_no: string; key: string }>; tools: unknown[] };
export function mailboxState(book: Book): { invoices: Array<{ invoice_no: string; vendor_id: string; total_cents: number }>; tools: unknown[] };
export function listen(handler: (req: FakeRequest) => FakeResponse | Promise<FakeResponse>, host?: string): Promise<{ server: import("node:http").Server; port: number }>;

export interface World {
  dir: string;
  config: string;
  erp: ReturnType<typeof erpState>;
  mailbox: ReturnType<typeof mailboxState>;
  ports: { erp: number; mailbox: number };
  admin: string;
  stop(): Promise<void>;
}
export function startWorld(
  o: { dir: string; repo: string; book: Book; database?: string; real?: { env: string }; log?: (line: string) => void },
  deps: { serveEgress: (o: any) => Promise<{ stop(): Promise<void> }>; defaultDialer?: (ca?: string) => any; isPublicAddress?: (a: string) => boolean },
): Promise<World>;
export function newSessionDir(): string;
