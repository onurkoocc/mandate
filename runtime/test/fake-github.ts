// An in-memory GitHub for the git.open_pr adapter's tests: the endpoints the
// adapter calls, with failures a test can inject on the pull-request call.

import { createHash } from "node:crypto";

export type PullFault = "lose_response" | "network" | 500;

interface Pull {
  number: number;
  html_url: string;
  state: string;
  title: string;
  body: string;
  head: { ref: string };
  base: { ref: string };
  merged?: boolean;
  merge_commit_sha?: string | null;
}

/** A fault for the next merge: the merge applies but its answer is lost, or nothing happens and the call fails. */
export type MergeFault = "lose_response" | "network" | 409;

export class FakeGitHub {
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly pulls: Pull[] = [];
  readonly calls: string[] = [];
  /** Faults for the next pull-request creations, in order. */
  readonly pullFaults: PullFault[] = [];
  /** Faults for the next merges, in order. */
  readonly mergeFaults: MergeFault[] = [];

  constructor(readonly repo: string) {
    const tree = this.put("tree", new Map([["src/a.ts", "export const a = 1;\n"]]));
    const commit = this.hash(`commit seed`);
    this.trees.set(tree.sha, tree.files);
    this.commits.set(commit, { tree: tree.sha, parents: [], message: "seed" });
    this.refs.set("heads/main", commit);
  }

  /** Files of the head commit of a branch. */
  filesOf(branch: string): Map<string, string> | undefined {
    const sha = this.refs.get(`heads/${branch}`);
    const commit = sha && this.commits.get(sha);
    return commit ? this.trees.get(commit.tree) : undefined;
  }

  readonly fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.calls.push(`${method} ${u.pathname}`);
    const base = `/repos/${this.repo}`;
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (!u.pathname.startsWith(base)) return json(404, { message: "Not Found" });
    const path = u.pathname.slice(base.length);
    if (path === "" && method === "GET") return json(200, { full_name: this.repo, default_branch: "main" });
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/git\/ref\/(.+)$/)) && method === "GET") {
      const sha = this.refs.get(m[1]!);
      return sha ? json(200, { ref: `refs/${m[1]}`, object: { sha } }) : json(404, { message: "Not Found" });
    }
    if ((m = path.match(/^\/git\/commits\/([0-9a-f]+)$/)) && method === "GET") {
      const c = this.commits.get(m[1]!);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree } }) : json(404, { message: "Not Found" });
    }
    if (path === "/git/trees" && method === "POST") {
      const files = new Map(this.trees.get(String(body["base_tree"])) ?? []);
      for (const e of body["tree"] as Array<{ path: string; content: string }>) files.set(e.path, e.content);
      const t = this.put("tree", files);
      this.trees.set(t.sha, t.files);
      return json(201, { sha: t.sha });
    }
    if (path === "/git/commits" && method === "POST") {
      const sha = this.hash(`commit ${JSON.stringify(body)}`);
      this.commits.set(sha, { tree: String(body["tree"]), parents: body["parents"] as string[], message: String(body["message"]) });
      return json(201, { sha });
    }
    if (path === "/git/refs" && method === "POST") {
      const ref = String(body["ref"]).replace(/^refs\//, "");
      if (this.refs.has(ref)) return json(422, { message: "Reference already exists" });
      this.refs.set(ref, String(body["sha"]));
      return json(201, { ref: body["ref"] });
    }
    if ((m = path.match(/^\/git\/refs\/(.+)$/)) && method === "PATCH") {
      this.refs.set(m[1]!, String(body["sha"]));
      return json(200, {});
    }
    if (path === "/pulls" && method === "POST") {
      const fault = this.pullFaults.shift();
      if (fault === "network") throw new TypeError("fetch failed");
      if (fault === 500) return json(500, { message: "Server Error" });
      const head = String(body["head"]);
      if (this.pulls.some((p) => p.head.ref === head)) return json(422, { message: "A pull request already exists" });
      const pr: Pull = {
        number: this.pulls.length + 1,
        html_url: `https://github.com/${this.repo}/pull/${this.pulls.length + 1}`,
        state: "open",
        title: String(body["title"]),
        body: String(body["body"]),
        head: { ref: head },
        base: { ref: String(body["base"]) },
      };
      this.pulls.push(pr);
      if (fault === "lose_response") throw new TypeError("fetch failed: the connection closed after the request was sent");
      return json(201, pr);
    }
    if ((m = path.match(/^\/pulls\/(\d+)$/)) && method === "GET") {
      const pr = this.pulls.find((p) => p.number === Number(m![1]));
      return pr ? json(200, this.shown(pr)) : json(404, { message: "Not Found" });
    }
    if ((m = path.match(/^\/pulls\/(\d+)\/merge$/)) && method === "PUT") {
      const pr = this.pulls.find((p) => p.number === Number(m![1]));
      if (!pr) return json(404, { message: "Not Found" });
      const fault = this.mergeFaults.shift();
      if (fault === "network") throw new TypeError("fetch failed");
      if (pr.merged) return json(405, { message: "Pull Request is not mergeable" });
      const head = this.refs.get(`heads/${pr.head.ref}`);
      if (fault === 409 || body["sha"] !== head) return json(409, { message: "Head branch was modified. Review and try the merge again." });
      const commit = this.commits.get(head!)!;
      const sha = this.hash(`merge ${pr.number} ${head}`);
      this.commits.set(sha, { tree: commit.tree, parents: [this.refs.get(`heads/${pr.base.ref}`)!, head!], message: `Merge pull request #${pr.number}` });
      this.refs.set(`heads/${pr.base.ref}`, sha);
      pr.merged = true;
      pr.state = "closed";
      pr.merge_commit_sha = sha;
      if (fault === "lose_response") throw new TypeError("fetch failed: the connection closed after the request was sent");
      return json(200, { sha, merged: true, message: "Pull Request successfully merged" });
    }
    if (path === "/pulls" && method === "GET") {
      const head = u.searchParams.get("head");
      const all = head ? this.pulls.filter((p) => `${this.repo.split("/")[0]}:${p.head.ref}` === head) : this.pulls;
      const page = Number(u.searchParams.get("page") ?? "1");
      const per = Number(u.searchParams.get("per_page") ?? "30");
      // Like GitHub, the list does not say whether a pull request was merged.
      return json(200, all.slice((page - 1) * per, page * per).map((p) => ({ ...this.shown(p), merged: undefined })));
    }
    return json(404, { message: `no fake for ${method} ${path}` });
  };

  /** A pull request as GitHub shows it: with its head commit. */
  private shown(p: Pull): Pull & { head: { ref: string; sha: string | undefined } } {
    return { ...p, merged: !!p.merged, head: { ref: p.head.ref, sha: this.refs.get(`heads/${p.head.ref}`) } };
  }

  private put(kind: string, files: Map<string, string>): { sha: string; files: Map<string, string> } {
    return { sha: this.hash(`${kind} ${JSON.stringify([...files.entries()].sort())}`), files };
  }

  private hash(s: string): string {
    return createHash("sha1").update(s).digest("hex");
  }
}

/** Several fake repositories behind one fetch, routed by `/repos/<owner>/<name>`. */
export function fakeGitHubs(repos: string[]): { repos: Record<string, FakeGitHub>; fetch: typeof fetch } {
  const all = Object.fromEntries(repos.map((r) => [r, new FakeGitHub(r)]));
  const fetchAll = (async (url: string | URL | Request, init?: RequestInit) => {
    const m = new URL(String(url)).pathname.match(/^\/repos\/([^/]+\/[^/]+)/);
    const fake = m ? all[m[1]!] : undefined;
    return fake ? fake.fetch(url, init) : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
  return { repos: all, fetch: fetchAll };
}
