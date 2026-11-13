// The order of schema diagnostics (E0104) among themselves is by UTF-16 code units of their
// paths, as the keys of canonical text are (RFC 8785 §3.2.3). It must not depend on the
// machine's locale data, so that another implementation can reproduce it.

import { describe, expect, it } from "vitest";
import { compareUtf16 } from "../src/json/jcs.js";
import { checkJson, minimal } from "./helpers.js";

describe("the order of schema diagnostics", () => {
  // Names whose order by code unit differs from the order by locale: capital letters come before
  // lower-case ones, and `_` between them, by code unit. localeCompare puts them a, B, Z, _ or so.
  const names = ["b", "Zz", "_u", "a", "B", "é", "Aa"];

  it("is by UTF-16 code units of the path, not by locale", () => {
    const extra = Object.fromEntries(names.map((n) => [n, true]));
    const r = checkJson({ ...minimal(), ...extra });
    const paths = r.diagnostics.map((d) => d.at.path ?? "");
    expect(r.diagnostics.map((d) => d.code)).toEqual(names.map(() => "MDT-E0104"));
    expect(paths).toEqual(["/Aa", "/B", "/Zz", "/_u", "/a", "/b", "/é"]);
    expect(paths).toEqual([...paths].sort(compareUtf16));
    // The two orders really differ for these paths, so a locale-sensitive sort would fail above.
    expect([...paths].sort((a, b) => a.localeCompare(b))).not.toEqual(paths);
  });

  it("puts a character outside the Basic Multilingual Plane before a later BMP one, as code units do", () => {
    // U+1F600 is the code units D83D DE00; U+FF5E is FF5E. By code unit D83D < FF5E, by code point it is the other way round.
    const r = checkJson({ ...minimal(), "\u{1F600}": true, "～": true });
    expect(r.diagnostics.map((d) => d.at.path)).toEqual(["/\u{1F600}", "/～"]);
  });
});
