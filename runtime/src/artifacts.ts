// The artifact store (Doc 4 §16.1: "a content-addressed directory, locally").
// Large data stays out of events and commands: a test log, a file a pull
// request will carry, the snapshot a verifier ran against. Each is stored
// once by the SHA-256 of its bytes and named by it, `blob:sha256:<hex>`.
//
// Bytes are shared, access is not. PostgreSQL keeps an index row per
// (tenant, run, digest): an artifact is readable only in a run that recorded
// it. A digest from another tenant or another run is refused exactly like a
// digest nobody stored, so a refusal says nothing about whether it exists
// (G08). Reading checks the bytes against their digest again, so a corrupted
// or swapped file is never handed out as the artifact it claims to be.

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db, Row, Tx } from "./db.js";
import { Violation } from "./signals.js";
import { canonical, type Value } from "./values.js";

/** `sha256:<hex>` of raw bytes: an artifact's content address. */
export function sha256Of(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Where artifact bytes live, by digest. Integrity and access are the store's job, not the backend's. */
export interface BlobBackend {
  put(digest: string, bytes: Uint8Array): Promise<void>;
  get(digest: string): Promise<Uint8Array | undefined>;
}

/** Bytes in memory: for tests and in-process runs that keep nothing. */
export class MemoryBlobs implements BlobBackend {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(digest: string, bytes: Uint8Array): Promise<void> {
    if (!this.blobs.has(digest)) this.blobs.set(digest, Uint8Array.from(bytes));
  }
  async get(digest: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(digest);
  }
  /** Test only: replaces stored bytes, as a disk fault or an attacker would. */
  tamper(digest: string, bytes: Uint8Array): void {
    this.blobs.set(digest, bytes);
  }
}

/** A content-addressed directory: `<dir>/sha256/<first two hex>/<hex>`. */
export class DirBlobs implements BlobBackend {
  constructor(readonly dir: string) {}

  private path(digest: string): string {
    const hex = digest.slice("sha256:".length);
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Violation("bad_digest", `Not a sha256 digest: ${digest}.`);
    return join(this.dir, "sha256", hex.slice(0, 2), hex);
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(digest);
    if (existsSync(p)) return;
    mkdirSync(dirname(p), { recursive: true });
    // Written aside and renamed, so a reader never sees half a blob.
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, p);
  }

  async get(digest: string): Promise<Uint8Array | undefined> {
    const p = this.path(digest);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
  }
}

/** A stored artifact, as runs and evidence refer to it. */
export interface ArtifactRef {
  ref: string;
  digest: string;
  size: number;
  media_type: string;
}

export interface ArtifactScope {
  tenant: string;
  runId: string;
}

/** A tree of files by path: what a verifier ran against, what an action will apply. */
export interface TreeManifest {
  format: "mandate/tree/0.1";
  files: Record<string, string>;
}

export const TREE_MEDIA_TYPE = "application/vnd.mandate.tree+json";

export function refOf(digest: string): string {
  return `blob:${digest}`;
}

export function digestOfRef(ref: string): string {
  if (!ref.startsWith("blob:sha256:")) throw new Violation("artifact_not_found", "No such artifact in this run.");
  return ref.slice("blob:".length);
}

export function treeOf(files: Record<string, Uint8Array | string>): TreeManifest {
  const out: Record<string, string> = {};
  for (const p of Object.keys(files).sort()) out[p] = sha256Of(files[p]!);
  return { format: "mandate/tree/0.1", files: out };
}

export class ArtifactStore {
  constructor(
    readonly db: Db,
    readonly blobs: BlobBackend = new MemoryBlobs(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Stores bytes for a run and returns their reference. Storing the same bytes again is a no-op. */
  async put(scope: ArtifactScope, content: Uint8Array | string, mediaType = "text/plain; charset=utf-8", tx?: Tx): Promise<ArtifactRef> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const digest = sha256Of(bytes);
    await this.blobs.put(digest, bytes);
    await (tx ?? this.db).query(
      "insert into artifacts (tenant, run_id, digest, size, media_type, created_at) values ($1, $2, $3, $4, $5, $6) on conflict do nothing",
      [scope.tenant, scope.runId, digest, bytes.length, mediaType, this.now()],
    );
    return { ref: refOf(digest), digest, size: bytes.length, media_type: mediaType };
  }

  /** Stores a tree manifest (not the files' bytes) and returns its reference. */
  async putTree(scope: ArtifactScope, tree: TreeManifest, tx?: Tx): Promise<ArtifactRef> {
    return this.put(scope, canonical(tree as unknown as Value), TREE_MEDIA_TYPE, tx);
  }

  /**
   * Reads an artifact of a run. Missing, recorded only by another run or
   * tenant, and corrupted all fail the same way to the caller (G08).
   */
  async get(scope: ArtifactScope, ref: string): Promise<{ bytes: Uint8Array; media_type: string; digest: string }> {
    const digest = digestOfRef(ref);
    const [row] = await this.db.query<Row>("select size, media_type from artifacts where tenant = $1 and run_id = $2 and digest = $3", [scope.tenant, scope.runId, digest]);
    if (!row) throw new Violation("artifact_not_found", "No such artifact in this run.");
    const bytes = await this.blobs.get(digest);
    if (!bytes || bytes.length !== Number(row["size"]) || sha256Of(bytes) !== digest) {
      throw new Violation("artifact_corrupt", `The stored bytes of ${ref} do not match its digest.`);
    }
    return { bytes, media_type: String(row["media_type"]), digest };
  }

  async text(scope: ArtifactScope, ref: string): Promise<string> {
    return new TextDecoder().decode((await this.get(scope, ref)).bytes);
  }

  /** The artifacts a run recorded, by digest. */
  async list(scope: ArtifactScope): Promise<ArtifactRef[]> {
    const rows = await this.db.query<Row>("select digest, size, media_type from artifacts where tenant = $1 and run_id = $2 order by digest", [scope.tenant, scope.runId]);
    return rows.map((r) => ({ ref: refOf(String(r["digest"])), digest: String(r["digest"]), size: Number(r["size"]), media_type: String(r["media_type"]) }));
  }
}
