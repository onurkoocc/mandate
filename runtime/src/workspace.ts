// The multi-repo workspace (design doc 9 §12, B3; BACKLOG item 31). A run
// that works on components of a system model starts from one base commit per
// component. Before the run starts, the workspace adapter puts each
// component's working copy at its root, checked out at that commit. The run
// records the commits in its manifest, whose hash (R) the views show, so what
// the run started from is part of what it is.
//
// The adapter runs in the control plane. git's credentials stay here; agent
// sandboxes see only the working copies their grants name (K7).
//
// A root holds one working copy, so one live run at a time uses it: the
// runtime refuses to start a run on a root another unfinished run holds
// (`workspace_busy`).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WorkspaceComponent {
  name: string;
  repo: string;
  root: string;
}

export interface WorkspaceAdapter {
  /**
   * Puts each component's working copy at its root, at the commit the run
   * starts from, and says which commit that is. Work left in a root by an
   * earlier run is discarded; ignored files (dependencies) stay.
   */
  prepare(components: WorkspaceComponent[]): Promise<Record<string, { base: string }>>;
}

/** Where a component's commits come from: a clone URL or a local path, and the ref to start from. */
export interface ComponentSource {
  url: string;
  /** Default `main`. */
  ref?: string;
}

/**
 * Working copies from git. A root that is not a clone yet is cloned from its
 * source; then the source's ref is fetched and checked out, detached, and the
 * copy is cleaned. The base is the fetched commit, never a moving name.
 */
export class GitWorkspace implements WorkspaceAdapter {
  constructor(private readonly sources: Record<string, ComponentSource>) {}

  async prepare(components: WorkspaceComponent[]): Promise<Record<string, { base: string }>> {
    const out: Record<string, { base: string }> = {};
    for (const c of [...components].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const src = Object.hasOwn(this.sources, c.name) ? this.sources[c.name] : undefined;
      if (!src) throw new Error(`the workspace has no source for component ${c.name} (${c.repo})`);
      if (!existsSync(join(c.root, ".git"))) {
        mkdirSync(dirname(c.root), { recursive: true });
        git(dirname(c.root), ["clone", "--quiet", "--no-checkout", src.url, c.root]);
      }
      git(c.root, ["fetch", "--quiet", src.url, src.ref ?? "main"]);
      const base = git(c.root, ["rev-parse", "FETCH_HEAD"]).trim();
      git(c.root, ["checkout", "--quiet", "--force", "--detach", base]);
      // Untracked work of an earlier run goes; ignored files (node_modules, build output) stay.
      git(c.root, ["clean", "-fdq"]);
      out[c.name] = { base };
    }
    return out;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "advice.detachedHead=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
