// The real `git.open_pr` adapter (Doc 4 §8.8, §8.9, §16.1; BACKLOG P1-9, K17,
// K18). It runs in the runtime process: the token is a fine-grained PAT for
// one repository, held here and never handed to a sandbox (§8.9).
//
// An effect `git.open_pr(checked)` opens one pull request with the files the
// checked draft names (`patch.files` and `tests.files`), read from the working
// copy the agents worked in:
//
//   one commit on top of the base branch  →  branch mandate/<issue>-<op>
//                                         →  pull request into the base
//
// <op> comes from the operation key, so the same operation always names the
// same branch. That makes the effect reconcilable (§8.9): after a lost
// response, `reconcile` looks for a pull request from a branch of this
// operation and reports it applied, or proves it was not, and only then may
// the action be sent again. Sending it again reuses the branch and finds an
// existing pull request instead of opening a second one.
//
// The adapter contract (§16.1) also has:
//   validateBinding  the repository the program names is this adapter's, and
//                    the token can see it
//   cancel           TooLate once a pull request exists; else Cancelled, with
//                    the lookup as proof

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import type { AuthorizationContext, PreparedAction, ToolAdapter, ToolContract } from "./adapters.js";
import { digest, isObj, type Value } from "./values.js";

export interface GitHubOptions {
  /** A fine-grained token for this repository only (K18). */
  token: string;
  /** "owner/name". */
  repo: string;
  /** The branch pull requests go into. Default `main`. */
  base?: string;
  /** The working copy the agents changed; files are read from here. */
  workdir: string;
  /** Default: the global fetch. Tests pass a fake GitHub. */
  fetch?: typeof fetch;
  /** Default https://api.github.com. */
  apiUrl?: string;
}

type Http = { status: number; body: unknown };

class GitHubError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
  /** A status that says the request was not applied; anything else (5xx, 429, no answer) leaves it unknown. */
  get definite(): boolean {
    return this.status !== undefined && this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export class GitHubPullRequests implements ToolAdapter {
  private readonly owner: string;
  private readonly name: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly api: string;

  constructor(private readonly o: GitHubOptions) {
    const [owner, name] = o.repo.split("/");
    if (!owner || !name) throw new Error(`GitHubPullRequests: repo must be owner/name, not ${o.repo}`);
    this.owner = owner;
    this.name = name;
    this.base = o.base ?? "main";
    this.fetch = o.fetch ?? fetch;
    this.api = o.apiUrl ?? "https://api.github.com";
  }

  describe(): ToolContract {
    return { id: "github/open_pr@1", digest: digest("request", { adapter: "github/open_pr@1", repo: this.o.repo, base: this.base }), retryClass: "reconcilable" };
  }

  /** The binding is the repository of the program's `git.pr(…)` capability. */
  async validateBinding(binding: { repos: string[] }): Promise<{ supported: true } | { unsupported: string }> {
    const other = binding.repos.filter((r) => r !== this.o.repo);
    if (other.length) return { unsupported: `this adapter opens pull requests in ${this.o.repo}, not ${other.join(", ")}` };
    try {
      await this.call("GET", `/repos/${this.o.repo}`);
      return { supported: true };
    } catch (e) {
      return { unsupported: `cannot see ${this.o.repo} with this token: ${(e as Error).message}` };
    }
  }

  async prepare(params: Value): Promise<{ prepared: true } | { rejected: string }> {
    const d = draftOf(params);
    if (typeof d === "string") return { rejected: d };
    for (const f of d.files) {
      const rel = this.inside(f);
      if (!rel) return { rejected: `${f} is outside the working copy` };
      try {
        await readFile(join(this.o.workdir, rel));
      } catch {
        return { rejected: `${rel} does not exist in the working copy` };
      }
    }
    return { prepared: true };
  }

  async execute(action: PreparedAction, auth: AuthorizationContext, operationKey: string): Promise<{ confirmed: Value } | { rejected: string } | { unknown: string }> {
    const d = draftOf(action.params);
    if (typeof d === "string") return { rejected: d };
    const branch = branchFor(d.issue, operationKey);
    try {
      const existing = await this.pullFrom(branch);
      if (existing) return { confirmed: existing };
      const baseSha = await this.refSha(`heads/${this.base}`);
      const baseTree = ((await this.call("GET", `/repos/${this.o.repo}/git/commits/${baseSha}`)) as { tree: { sha: string } }).tree.sha;
      const tree: Array<{ path: string; mode: string; type: string; content: string }> = [];
      for (const f of d.files) {
        const rel = this.inside(f);
        if (!rel) return { rejected: `${f} is outside the working copy` };
        tree.push({ path: rel, mode: "100644", type: "blob", content: await readFile(join(this.o.workdir, rel), "utf8") });
      }
      const treeSha = ((await this.call("POST", `/repos/${this.o.repo}/git/trees`, { base_tree: baseTree, tree })) as { sha: string }).sha;
      const message = `Fix ${d.issue.title ?? `issue ${d.issue.id}`}\n\nMandate-Operation: ${operationKey}\nMandate-Action: ${action.actionDigest}\nMandate-Authorization: ${auth.authorizationId} (${auth.decidedBy})`;
      const commitSha = ((await this.call("POST", `/repos/${this.o.repo}/git/commits`, { message, tree: treeSha, parents: [baseSha] })) as { sha: string }).sha;
      await this.setRef(branch, commitSha);
      const body = [
        /^\d+$/.test(d.issue.id) ? `Fixes #${d.issue.id}.` : `Fixes ${d.issue.id}.`,
        "",
        "Opened by Mandate after the acceptance contract was met and the change was authorized.",
        "",
        `- Operation: \`${operationKey}\``,
        `- Action digest: \`${action.actionDigest}\``,
        `- Authorization: \`${auth.authorizationId}\` by ${auth.decidedBy}`,
      ].join("\n");
      try {
        const pr = (await this.call("POST", `/repos/${this.o.repo}/pulls`, { title: `Fix: ${d.issue.title ?? d.issue.id}`, head: branch, base: this.base, body })) as PullJson;
        return { confirmed: receipt(pr, branch, operationKey) };
      } catch (e) {
        // Opened by an earlier attempt whose answer was lost.
        if (e instanceof GitHubError && e.status === 422) {
          const found = await this.pullFrom(branch);
          if (found) return { confirmed: found };
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof GitHubError && e.definite) return { rejected: e.message };
      return { unknown: (e as Error).message };
    }
  }

  async reconcile(operationKey: string): Promise<{ applied: Value } | { notApplied: string } | { unknown: string }> {
    try {
      const pr = await this.pullForOperation(operationKey);
      return pr ? { applied: pr } : { notApplied: `no pull request in ${this.o.repo} comes from a branch of operation ${opTag(operationKey)}` };
    } catch (e) {
      return { unknown: (e as Error).message };
    }
  }

  async cancel(operationKey: string): Promise<{ cancelled: string } | { tooLate: Value } | { unknown: string }> {
    try {
      const pr = await this.pullForOperation(operationKey);
      return pr ? { tooLate: pr } : { cancelled: `no pull request in ${this.o.repo} comes from a branch of operation ${opTag(operationKey)}` };
    } catch (e) {
      return { unknown: (e as Error).message };
    }
  }

  // ── GitHub ────────────────────────────────────────────────────────────

  /** `f` relative to the working copy, with forward slashes; undefined when it is not inside it. */
  private inside(f: string): string | undefined {
    const rel = posix.normalize((isAbsolute(f) ? relative(this.o.workdir, f) : f).split(sep).join("/"));
    return rel === ".." || rel.startsWith("../") || rel.startsWith("/") || rel === "." ? undefined : rel;
  }

  private async refSha(ref: string): Promise<string> {
    return ((await this.call("GET", `/repos/${this.o.repo}/git/ref/${ref}`)) as { object: { sha: string } }).object.sha;
  }

  private async setRef(branch: string, sha: string): Promise<void> {
    try {
      await this.call("POST", `/repos/${this.o.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    } catch (e) {
      // The branch of this operation already exists from an earlier attempt: point it at this commit.
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      await this.call("PATCH", `/repos/${this.o.repo}/git/refs/heads/${branch}`, { sha, force: true });
    }
  }

  private async pullFrom(branch: string): Promise<Value | undefined> {
    const prs = (await this.call("GET", `/repos/${this.o.repo}/pulls?state=all&head=${encodeURIComponent(`${this.owner}:${branch}`)}&per_page=10`)) as PullJson[];
    const pr = prs.find((p) => p.head.ref === branch);
    return pr ? receipt(pr, branch, undefined) : undefined;
  }

  /** The pull request from a branch of this operation, whatever the issue part of the branch name says. */
  private async pullForOperation(operationKey: string): Promise<Value | undefined> {
    const tag = `-${opTag(operationKey)}`;
    for (let page = 1; page <= 10; page++) {
      const prs = (await this.call("GET", `/repos/${this.o.repo}/pulls?state=all&per_page=100&page=${page}`)) as PullJson[];
      const pr = prs.find((p) => p.head.ref.startsWith("mandate/") && p.head.ref.endsWith(tag));
      if (pr) return receipt(pr, pr.head.ref, operationKey);
      if (prs.length < 100) return undefined;
    }
    throw new Error("too many pull requests to search");
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(`${this.api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.o.token}`,
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new GitHubError(undefined, `${method} ${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    const parsed: Http = { status: res.status, body: text ? JSON.parse(text) : null };
    if (res.status >= 300) {
      const msg = isObj(parsed.body as Value) ? String((parsed.body as { message?: unknown }).message ?? "") : "";
      throw new GitHubError(res.status, `${method} ${path}: HTTP ${res.status}${msg ? ` ${msg}` : ""}`);
    }
    return parsed.body;
  }
}

interface PullJson {
  number: number;
  html_url: string;
  state: string;
  head: { ref: string; sha?: string };
}

function receipt(pr: PullJson, branch: string, operationKey: string | undefined): Value {
  return { system: "github", number: pr.number, url: pr.html_url, branch, state: pr.state, ...(operationKey ? { operation: operationKey } : {}) };
}

/** The part of the branch name that names the operation. */
function opTag(operationKey: string): string {
  return createHash("sha256").update(operationKey).digest("hex").slice(0, 12);
}

function branchFor(issue: { id: string }, operationKey: string): string {
  const slug = issue.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "issue";
  return `mandate/${slug}-${opTag(operationKey)}`;
}

interface Draft {
  issue: { id: string; title?: string };
  files: string[];
}

/** The checked draft of `git.open_pr(checked)`: its issue and the files its patch and tests name. */
function draftOf(params: Value): Draft | string {
  const d = Array.isArray(params) ? params[0] : params;
  if (!isObj(d ?? null)) return "git.open_pr takes a pull request draft";
  const draft = d as Record<string, Value>;
  const issue = draft["issue"];
  if (!isObj(issue ?? null) || (typeof (issue as Record<string, Value>)["id"] !== "string" && typeof (issue as Record<string, Value>)["id"] !== "number")) return "the draft has no issue id";
  const files = (k: string): string[] => {
    const part = draft[k];
    const list = isObj(part ?? null) ? (part as Record<string, Value>)["files"] : undefined;
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
  };
  const all = [...new Set([...files("patch"), ...files("tests")])].sort();
  if (!all.length) return "the draft names no files";
  const i = issue as Record<string, Value>;
  return { issue: { id: String(i["id"]), ...(typeof i["title"] === "string" ? { title: i["title"] } : {}) }, files: all };
}
