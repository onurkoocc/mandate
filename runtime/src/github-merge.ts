// The `git.merge` adapter (design doc 9 §3.2, §6; BACKLOG item 32, B4): it
// lands one component's change in that component's repository, as a member
// of a change set. It runs in the runtime process; the token stays here and
// never enters a sandbox (K7, K18).
//
// A member's parameters name its component (repository, working copy root,
// and the base commit the run started from) and its verified change (the
// files it touches). `prepare` reads those files from the working copy, and
// the runtime freezes them; `execute` lands exactly those bytes:
//
//   one commit on top of the run's base commit   →  branch mandate/<component>-<op>
//                                                →  pull request into the base branch
//                                                →  merged, pinned to that head commit
//
// The merge is pinned to the head commit it made (`sha`), so a branch that
// moved after the action was prepared is refused, not merged. <op> comes from
// the operation key, so the effect is reconcilable (§8.9): `reconcile` finds
// the pull request of the operation and reports it applied if merged, or not
// applied if it was not, and only then may the merge be sent again, which
// finds the same branch and pull request.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthorizationContext, PreparedAction, PreparedFile, ToolAdapter, ToolContract } from "./adapters.js";
import { GitHubError, opTag } from "./github.js";
import { inside } from "./paths.js";
import { digest, isObj, type Obj, type Value } from "./values.js";

export interface GitHubMergeOptions {
  /** A fine-grained token for these repositories only (K18). */
  token: string;
  /** "owner/name" of every repository the adapter may merge into. */
  repos: string[];
  /** The branch changes land on. Default `main`. */
  base?: string;
  fetch?: typeof fetch;
  apiUrl?: string;
}

interface Target {
  component: string;
  repo: string;
  root: string;
  base: string | null;
}

interface PullJson {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  head: { ref: string; sha?: string };
}

export class GitHubMerges implements ToolAdapter {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly api: string;

  constructor(private readonly o: GitHubMergeOptions) {
    this.base = o.base ?? "main";
    this.fetch = o.fetch ?? fetch;
    this.api = o.apiUrl ?? "https://api.github.com";
  }

  describe(): ToolContract {
    return { id: "github/merge@1", digest: digest("request", { adapter: "github/merge@1", repos: [...this.o.repos].sort(), base: this.base }), retryClass: "reconcilable" };
  }

  async validateBinding(binding: { repos: string[] }): Promise<{ supported: true } | { unsupported: string }> {
    const other = binding.repos.filter((r) => !this.o.repos.includes(r));
    if (other.length) return { unsupported: `this adapter merges into ${this.o.repos.join(", ")}, not ${other.join(", ")}` };
    for (const r of binding.repos) {
      try {
        await this.call(r, "GET", "");
      } catch (e) {
        return { unsupported: `cannot see ${r} with this token: ${(e as Error).message}` };
      }
    }
    return { supported: true };
  }

  /** Reads the change's files from the component's working copy; the runtime freezes them (§8.8). */
  async prepare(params: Value): Promise<{ prepared: true; artifacts: PreparedFile[] } | { rejected: string }> {
    const m = memberOf(params);
    if (typeof m === "string") return { rejected: m };
    if (!this.o.repos.includes(m.target.repo)) return { rejected: `this adapter does not merge into ${m.target.repo}` };
    const artifacts: PreparedFile[] = [];
    for (const f of m.files) {
      const rel = inside(m.target.root, f);
      if (!rel) return { rejected: `${f} is outside ${m.target.component}'s working copy` };
      try {
        artifacts.push({ path: rel, content: await readFile(join(m.target.root, rel), "utf8") });
      } catch {
        return { rejected: `${rel} does not exist in ${m.target.component}'s working copy` };
      }
    }
    return { prepared: true, artifacts };
  }

  async execute(action: PreparedAction, auth: AuthorizationContext, operationKey: string): Promise<{ confirmed: Value } | { rejected: string } | { unknown: string }> {
    const m = memberOf(action.params);
    if (typeof m === "string") return { rejected: m };
    const { repo, component } = m.target;
    const branch = `mandate/${component}-${opTag(operationKey)}`;
    try {
      let pr = await this.pullFrom(repo, branch);
      if (pr?.merged) return { confirmed: receipt(repo, pr, branch, operationKey) };
      if (!pr) {
        const parent = m.target.base ?? (await this.refSha(repo, `heads/${this.base}`));
        const baseTree = ((await this.call(repo, "GET", `/git/commits/${parent}`)) as { tree: { sha: string } }).tree.sha;
        const frozen = new Map((action.artifacts ?? []).map((a) => [a.path, a]));
        const tree: Array<{ path: string; mode: string; type: string; content: string }> = [];
        for (const f of m.files) {
          const rel = inside(m.target.root, f);
          const a = rel === undefined ? undefined : frozen.get(rel);
          if (!rel || !a) return { rejected: `${f} was not frozen when the action was prepared` };
          tree.push({ path: rel, mode: "100644", type: "blob", content: new TextDecoder().decode(a.content) });
        }
        const treeSha = ((await this.call(repo, "POST", "/git/trees", { base_tree: baseTree, tree })) as { sha: string }).sha;
        const message = `${m.title ?? `Change ${component}`}\n\nMandate-Operation: ${operationKey}\nMandate-Action: ${action.actionDigest}\nMandate-Authorization: ${auth.authorizationId} (${auth.decidedBy})`;
        const commitSha = ((await this.call(repo, "POST", "/git/commits", { message, tree: treeSha, parents: [parent] })) as { sha: string }).sha;
        await this.setRef(repo, branch, commitSha);
        const body = ["Landed by Mandate as a member of an authorized change set.", "", `- Operation: \`${operationKey}\``, `- Action digest: \`${action.actionDigest}\``, `- Authorization: \`${auth.authorizationId}\` by ${auth.decidedBy}`].join("\n");
        try {
          pr = (await this.call(repo, "POST", "/pulls", { title: m.title ?? `Change ${component}`, head: branch, base: this.base, body })) as PullJson;
        } catch (e) {
          // Opened by an earlier attempt whose answer was lost.
          if (!(e instanceof GitHubError && e.status === 422)) throw e;
          pr = await this.pullFrom(repo, branch);
          if (!pr) throw e;
        }
      }
      const head = pr.head.sha ?? (await this.refSha(repo, `heads/${branch}`));
      try {
        const merged = (await this.call(repo, "PUT", `/pulls/${pr.number}/merge`, { sha: head, merge_method: "merge" })) as { sha?: string; merged?: boolean };
        return { confirmed: receipt(repo, { ...pr, merged: true, merge_commit_sha: merged.sha ?? null }, branch, operationKey) };
      } catch (e) {
        // 405: not mergeable (a conflict); 409: the head moved since this action's commit. Nothing was merged.
        if (e instanceof GitHubError && (e.status === 405 || e.status === 409)) return { rejected: e.message };
        throw e;
      }
    } catch (e) {
      if (e instanceof GitHubError && e.definite) return { rejected: e.message };
      return { unknown: (e as Error).message };
    }
  }

  async reconcile(operationKey: string): Promise<{ applied: Value } | { notApplied: string } | { unknown: string }> {
    try {
      const found = await this.pullForOperation(operationKey);
      if (found?.pr.merged) return { applied: receipt(found.repo, found.pr, found.pr.head.ref, operationKey) };
      return { notApplied: found ? `pull request #${found.pr.number} in ${found.repo} is not merged` : `no pull request comes from a branch of operation ${opTag(operationKey)}` };
    } catch (e) {
      return { unknown: (e as Error).message };
    }
  }

  async cancel(operationKey: string): Promise<{ cancelled: string } | { tooLate: Value } | { unknown: string }> {
    const r = await this.reconcile(operationKey);
    if ("applied" in r) return { tooLate: r.applied };
    if ("notApplied" in r) return { cancelled: r.notApplied };
    return r;
  }

  // ── GitHub ────────────────────────────────────────────────────────────

  private async refSha(repo: string, ref: string): Promise<string> {
    return ((await this.call(repo, "GET", `/git/ref/${ref}`)) as { object: { sha: string } }).object.sha;
  }

  private async setRef(repo: string, branch: string, sha: string): Promise<void> {
    try {
      await this.call(repo, "POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      await this.call(repo, "PATCH", `/git/refs/heads/${branch}`, { sha, force: true });
    }
  }

  private async pullFrom(repo: string, branch: string): Promise<PullJson | undefined> {
    const owner = repo.split("/")[0]!;
    const prs = (await this.call(repo, "GET", `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`)) as PullJson[];
    const pr = prs.find((p) => p.head.ref === branch);
    // The list does not say whether it was merged; the pull request itself does.
    return pr ? ((await this.call(repo, "GET", `/pulls/${pr.number}`)) as PullJson) : undefined;
  }

  /** The pull request of this operation, in whichever repository it was made. */
  private async pullForOperation(operationKey: string): Promise<{ repo: string; pr: PullJson } | undefined> {
    const tag = `-${opTag(operationKey)}`;
    for (const repo of this.o.repos) {
      for (let page = 1; page <= 10; page++) {
        const prs = (await this.call(repo, "GET", `/pulls?state=all&per_page=100&page=${page}`)) as PullJson[];
        const pr = prs.find((p) => p.head.ref.startsWith("mandate/") && p.head.ref.endsWith(tag));
        if (pr) return { repo, pr: (await this.call(repo, "GET", `/pulls/${pr.number}`)) as PullJson };
        if (prs.length < 100) break;
      }
    }
    return undefined;
  }

  private async call(repo: string, method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(`${this.api}/repos/${repo}${path}`, {
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
      throw new GitHubError(undefined, `${method} ${repo}${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (res.status >= 300) {
      const msg = isObj(parsed as Value) ? String((parsed as { message?: unknown }).message ?? "") : "";
      throw new GitHubError(res.status, `${method} ${repo}${path}: HTTP ${res.status}${msg ? ` ${msg}` : ""}`);
    }
    return parsed;
  }
}

function receipt(repo: string, pr: PullJson, branch: string, operationKey: string): Value {
  return { system: "github", repo, number: pr.number, url: pr.html_url, branch, merged: !!pr.merged, merge_sha: pr.merge_commit_sha ?? null, operation: operationKey };
}

/** A change set member's parameters: its target component, and the verified change with its files. */
function memberOf(params: Value): { target: Target; files: string[]; title?: string } | string {
  if (!Array.isArray(params) || !isObj(params[0] ?? null)) return "git.merge is a change set member: it takes its component and a change";
  const t = params[0] as Obj;
  if (typeof t["repo"] !== "string" || typeof t["root"] !== "string" || typeof t["component"] !== "string") return "the member does not name its component";
  const change = isObj(params[1] ?? null) ? (params[1] as Obj) : {};
  const files = Array.isArray(change["files"]) ? [...new Set(change["files"].filter((f): f is string => typeof f === "string"))].sort() : [];
  if (!files.length) return "the change names no files";
  return {
    target: { component: t["component"], repo: t["repo"], root: t["root"], base: typeof t["base"] === "string" ? t["base"] : null },
    files,
    ...(typeof change["title"] === "string" ? { title: change["title"] } : {}),
  };
}
