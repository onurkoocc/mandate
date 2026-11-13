// The strict HTTP/1.1 reading the egress proxy does on its client side
// (spec/egress.md "Reading a request"). The proxy reads every request head
// itself rather than through Node's parser, so that what it refuses does not
// depend on the Node version, and so each refusal has its own name. It reads
// one request per connection. Anything it cannot read in exactly one way is
// refused: a bare CR or LF, obsolete line folding, a header name followed by
// white space, `Content-Length` together with `Transfer-Encoding`, a repeated
// or non-numeric `Content-Length`, a transfer coding other than `chunked`.

import { Transform, type TransformCallback } from "node:stream";

export const MAX_HEAD_BYTES = 64 * 1024;
export const MAX_HEADERS = 100;
const MAX_CHUNK_LINE = 4096;

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A field value's bytes, as latin1: visible ASCII, space, tab and obs-text; no control characters. */
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const TARGET = /^[\x21-\x7e]+$/;

export interface Head {
  method: string;
  target: string;
  version: string;
  /** Names in lower case, values with surrounding white space removed, in the order received. */
  headers: [string, string][];
  /** How the body is framed: none, a length, or chunked. */
  body: { kind: "none" } | { kind: "length"; length: number } | { kind: "chunked" };
}

/** Why a head could not be read: the request line was HTTP/2's preface, or anything else. */
export type HeadError = { why: "malformed_request" | "upgrade_not_allowed"; detail: string; method?: string; target?: string };

/** The index just past the blank line that ends a head in `buf`, or -1 when it has not arrived yet. */
export function headEnd(buf: Buffer): number {
  const i = buf.indexOf("\r\n\r\n", 0, "latin1");
  return i < 0 ? -1 : i + 4;
}

/** Reads a request head (the bytes up to and including its blank line) strictly. */
export function parseHead(raw: Buffer): Head | HeadError {
  const text = raw.toString("latin1");
  const bad = (detail: string, method?: string, target?: string): HeadError => ({ why: "malformed_request", detail, ...(method !== undefined ? { method } : {}), ...(target !== undefined ? { target } : {}) });
  if (!text.endsWith("\r\n\r\n")) return bad("the head does not end with an empty line");
  const lines = text.slice(0, -4).split("\r\n");
  // Every line ends in CRLF: a CR or LF left inside a line is a bare one.
  if (lines.some((l) => l.includes("\r") || l.includes("\n"))) return bad("a bare CR or LF in the head");
  const requestLine = lines[0]!;
  const parts = requestLine.split(" ");
  if (parts.length !== 3) return bad("the request line is not method, target and version separated by single spaces");
  const [method, target, version] = parts as [string, string, string];
  if (method === "PRI" && target === "*" && version === "HTTP/2.0") return { why: "upgrade_not_allowed", detail: "HTTP/2 is not spoken", method, target };
  if (!TOKEN.test(method) || method.length > 32) return bad("the method is not a token");
  if (!TARGET.test(target)) return bad("the request target has a character outside visible ASCII", method);
  if (version !== "HTTP/1.1") return { why: version.startsWith("HTTP/2") || version.startsWith("HTTP/3") ? "upgrade_not_allowed" : "malformed_request", detail: `${version} is not HTTP/1.1`, method, target };
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith(" ") || line.startsWith("\t")) return bad("obsolete line folding", method, target);
    const colon = line.indexOf(":");
    if (colon < 1) return bad("a header line without a name", method, target);
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) return bad("a header name that is not a token, or white space before the colon", method, target);
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (!FIELD_VALUE.test(value)) return bad(`a control character in the value of ${name.toLowerCase()}`, method, target);
    headers.push([name.toLowerCase(), value]);
  }
  if (headers.length > MAX_HEADERS) return bad(`more than ${MAX_HEADERS} header lines`, method, target);
  const cl = headers.filter(([n]) => n === "content-length");
  const te = headers.filter(([n]) => n === "transfer-encoding");
  if (cl.length && te.length) return bad("both Content-Length and Transfer-Encoding", method, target);
  if (cl.length > 1) return bad("Content-Length is repeated", method, target);
  if (te.length > 1) return bad("Transfer-Encoding is repeated", method, target);
  let body: Head["body"] = { kind: "none" };
  if (cl.length) {
    const v = cl[0]![1];
    if (!/^[0-9]{1,15}$/.test(v)) return bad("Content-Length is not a single decimal number", method, target);
    body = { kind: "length", length: Number(v) };
  }
  if (te.length) {
    if (te[0]![1].toLowerCase() !== "chunked") return bad("a transfer coding other than chunked alone", method, target);
    body = { kind: "chunked" };
  }
  return { method, target, version, headers, body };
}

/**
 * Decodes a request body as its head frames it, from the bytes as they arrive. `push` returns the body's bytes so
 * far, whether it ended, and an error when the framing breaks; bytes past the end are ignored, since the proxy reads
 * one request per connection. Chunk extensions and trailers are read and dropped.
 */
export class BodyDecoder {
  private left: number;
  private state: "size" | "data" | "data-crlf" | "trailer" | "done";
  private pending = Buffer.alloc(0);

  constructor(private readonly framing: Head["body"]) {
    this.left = framing.kind === "length" ? framing.length : 0;
    this.state = framing.kind === "chunked" ? "size" : framing.kind === "length" && framing.length > 0 ? "data" : "done";
  }

  get done(): boolean {
    return this.state === "done";
  }

  push(chunk: Buffer): { data: Buffer[]; done: boolean; error?: string } {
    const data: Buffer[] = [];
    if (this.state === "done") return { data, done: true };
    if (this.framing.kind === "length") {
      const take = chunk.subarray(0, this.left);
      this.left -= take.length;
      if (take.length) data.push(take);
      if (this.left === 0) this.state = "done";
      return { data, done: this.state === "done" };
    }
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.state === "data") {
        const take = buf.subarray(0, this.left);
        if (take.length) data.push(take);
        this.left -= take.length;
        buf = buf.subarray(take.length);
        if (this.left > 0) break;
        this.state = "data-crlf";
      }
      if (this.state === "data-crlf") {
        if (buf.length < 2) break;
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) return { data, done: false, error: "a chunk is not followed by CRLF" };
        buf = buf.subarray(2);
        this.state = "size";
      }
      if (this.state === "size" || this.state === "trailer") {
        const lf = buf.indexOf(0x0a);
        if (lf < 0) {
          if (buf.length > MAX_CHUNK_LINE) return { data, done: false, error: "a chunk line is too long" };
          break;
        }
        if (lf === 0 || buf[lf - 1] !== 0x0d) return { data, done: false, error: "a bare LF in the chunked body" };
        const line = buf.subarray(0, lf - 1).toString("latin1");
        buf = buf.subarray(lf + 1);
        if (line.includes("\r")) return { data, done: false, error: "a bare CR in the chunked body" };
        if (this.state === "trailer") {
          if (line === "") {
            this.state = "done";
            break;
          }
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e\x80-\xff]*$/.test(line)) return { data, done: false, error: "a malformed trailer line" };
          continue;
        }
        const m = line.match(/^([0-9a-fA-F]{1,12})((?:;[\t\x20-\x7e]*)?)$/);
        if (!m) return { data, done: false, error: "a malformed chunk size" };
        this.left = parseInt(m[1]!, 16);
        this.state = this.left === 0 ? "trailer" : "data";
        continue;
      }
      break;
    }
    this.pending = this.state === "done" ? Buffer.alloc(0) : Buffer.from(buf);
    return { data, done: this.state === "done" };
  }
}

/**
 * Replaces each secret's exact bytes with its replacement in a stream, including a secret split across chunks: the
 * last `longest - 1` bytes of what has been seen are held back until the next chunk shows whether they begin one.
 */
export class Scrubber extends Transform {
  private held = Buffer.alloc(0);
  private readonly keep: number;

  constructor(private readonly pairs: { secret: Buffer; replacement: Buffer }[]) {
    super();
    this.keep = Math.max(0, ...pairs.map((p) => p.secret.length - 1));
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    const buf = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    const { out, rest } = scrubBytes(buf, this.pairs, this.keep);
    this.held = Buffer.from(rest);
    if (out.length) this.push(out);
    done();
  }

  override _flush(done: TransformCallback): void {
    const { out } = scrubBytes(this.held, this.pairs, 0);
    if (out.length) this.push(out);
    done();
  }
}

/**
 * Scrubs `buf`; the last `keep` bytes are returned as `rest` instead of being examined, unless a match before them
 * reaches into them. Where two secrets begin at the same byte (one a prefix of the other), the longer is replaced.
 */
export function scrubBytes(buf: Buffer, pairs: { secret: Buffer; replacement: Buffer }[], keep: number): { out: Buffer; rest: Buffer } {
  const parts: Buffer[] = [];
  // A match is taken only where it begins before the held-back bytes: there, every secret that could begin at the
  // same byte fits in `buf`, so the longest is known. One that begins later waits for the bytes that follow.
  const limit = buf.length - keep;
  let at = 0;
  for (;;) {
    let best = -1;
    let which: { secret: Buffer; replacement: Buffer } | undefined;
    for (const p of pairs) {
      const i = buf.indexOf(p.secret, at);
      if (i >= 0 && (best < 0 || i < best || (i === best && p.secret.length > which!.secret.length))) [best, which] = [i, p];
    }
    if (best < 0 || best >= limit || !which) break;
    parts.push(buf.subarray(at, best), which.replacement);
    at = best + which.secret.length;
  }
  const cut = Math.max(at, limit);
  parts.push(buf.subarray(at, cut));
  return { out: Buffer.concat(parts), rest: buf.subarray(cut) };
}

/** Frames a stream as an HTTP/1.1 chunked body; the last chunk is written only when the stream ends cleanly. */
export class ChunkedEncoder extends Transform {
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    if (chunk.length) this.push(Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`, "latin1"), chunk, Buffer.from("\r\n", "latin1")]));
    done();
  }

  override _flush(done: TransformCallback): void {
    this.push(Buffer.from("0\r\n\r\n", "latin1"));
    done();
  }
}
