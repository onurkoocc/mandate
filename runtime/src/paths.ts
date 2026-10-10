// Paths the agents name, used in the control plane (Doc 11 §7). A patch's
// files, a draft's files and a change set member's files are model output
// (Inferred): the runtime reads, writes and deletes files at them, outside
// every sandbox, so a path must never take it out of the directory it
// belongs to (R1, INV-04).
//
//   inside(root, f)       f relative to root, or undefined: `..`, an
//                         absolute path elsewhere, another drive, root itself
//   realEntries(root)     a copy of real files and directories: the links an
//                         agent left in its working copy are not copied
//   writeWithin(dir, …)   writes and deletes under a copy only through real
//   removeWithin(dir, …)  directories: a symbolic link or junction on the way
//                         (the linked node_modules) is refused, never followed

import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** `f` relative to `root`, with forward slashes; undefined when it is not inside it. */
export function inside(root: string, f: string): string | undefined {
  if (typeof f !== "string" || f === "" || f.includes("\0")) return undefined;
  const rel = relative(resolve(root), resolve(root, f));
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * A `cpSync` filter for a copy of `root` that holds real files and
 * directories only: links are left out (a copy would point them at their
 * targets, outside it), and so is what `skip` matches.
 */
export function realEntries(root: string, skip?: RegExp): (src: string) => boolean {
  const top = resolve(root);
  return (src) => {
    if (resolve(src) === top) return true;
    if (skip?.test(src)) return false;
    try {
      return !lstatSync(src).isSymbolicLink();
    } catch {
      return false;
    }
  };
}

/** The paths of `files` that are not inside `root`. */
export function outside(root: string, files: readonly string[]): string[] {
  return files.filter((f) => inside(root, f) === undefined);
}

export class PathRefused extends Error {}

/** The absolute path of `f` under `dir`, refusing one outside it or one whose way passes through a link. */
function within(dir: string, f: string): string {
  const rel = inside(dir, f);
  if (rel === undefined) throw new PathRefused(`${f} is outside the working copy`);
  const root = resolve(dir);
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const at = join(root, ...parts.slice(0, i));
    let link: boolean;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      break; // Not there yet: nothing below it can be a link.
    }
    if (link) throw new PathRefused(`${rel} passes through a link (${parts.slice(0, i).join("/")})`);
  }
  return join(root, ...parts);
}

/** Writes `content` at `f` under `dir`, creating real directories on the way. */
export function writeWithin(dir: string, f: string, content: Uint8Array | string): void {
  const at = within(dir, f);
  mkdirSync(resolve(at, ".."), { recursive: true });
  writeFileSync(at, content);
}

/** Removes the file at `f` under `dir`, if it is there. */
export function removeWithin(dir: string, f: string): void {
  rmSync(within(dir, f), { force: true });
}
