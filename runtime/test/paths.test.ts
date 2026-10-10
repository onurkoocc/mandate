// Paths the agents name, used in the control plane (Doc 11 §7): relative to
// their root or refused, and written or deleted only through real directories.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inside, outside, PathRefused, removeWithin, writeWithin } from "../src/paths.js";

const tmp = mkdtempSync(join(tmpdir(), "mandate-paths-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("inside", () => {
  const root = join(tmp, "work");

  it("keeps a path inside its root, relative and with forward slashes", () => {
    expect(inside(root, "src/a.ts")).toBe("src/a.ts");
    expect(inside(root, "./src/../src/a.ts")).toBe("src/a.ts");
    expect(inside(root, join(root, "src", "a.ts"))).toBe("src/a.ts");
  });

  it("refuses `..`, an absolute path elsewhere, the root itself and an empty path", () => {
    for (const f of ["..", "../x", "src/../../x", "../../home/user/.ssh/id_ed25519", join(tmp, "other", "x"), ".", "", "a\0b"]) expect(inside(root, f), f).toBeUndefined();
    expect(outside(root, ["src/a.ts", "../x"])).toEqual(["../x"]);
  });

  it.runIf(process.platform === "win32")("refuses another drive and a UNC path on Windows", () => {
    const other = root.slice(0, 1).toUpperCase() === "Z" ? "Y:\\x" : "Z:\\x";
    for (const f of [other, "\\\\server\\share\\x", "..\\x"]) expect(inside(root, f), f).toBeUndefined();
    expect(inside(root, "src\\a.ts")).toBe("src/a.ts");
  });
});

describe("writeWithin and removeWithin", () => {
  const dir = join(tmp, "copy");
  const victim = join(tmp, "victim");
  mkdirSync(dir, { recursive: true });
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "keep.txt"), "keep\n");
  symlinkSync(victim, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");

  it("writes and removes through real directories, creating them on the way", () => {
    writeWithin(dir, "src/deep/a.ts", "a\n");
    expect(readFileSync(join(dir, "src", "deep", "a.ts"), "utf8")).toBe("a\n");
    removeWithin(dir, "src/deep/a.ts");
    expect(existsSync(join(dir, "src", "deep", "a.ts"))).toBe(false);
    removeWithin(dir, "src/missing.ts");
  });

  it("refuses a path outside the directory or through a link, and touches nothing", () => {
    expect(() => removeWithin(dir, `../${basename(victim)}/keep.txt`)).toThrow(PathRefused);
    expect(() => removeWithin(dir, "linked/keep.txt")).toThrow(/passes through a link \(linked\)/);
    expect(() => writeWithin(dir, "linked/keep.txt", "changed\n")).toThrow(PathRefused);
    expect(() => writeWithin(dir, "linked/new/x.txt", "x\n")).toThrow(PathRefused);
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(victim, "new"))).toBe(false);
  });
});
