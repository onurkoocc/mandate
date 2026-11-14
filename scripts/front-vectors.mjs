#!/usr/bin/env node
// Writes crates/mandate-check/tests/front/expected.json: what the TypeScript
// compiler gives for the inputs of crates/mandate-check/tests/front/inputs.json
// from link and references (compiler/src/modules.ts), resolveNames
// (compiler/src/resolve/resolve.ts) and roleSites, rolesNamed and roleChecks
// (compiler/src/check/roles.ts), so that the hand-ported JavaScript in the
// Rust port of them (Set and object order, sorting by UTF-16 code units,
// "did you mean", the member order of the facts, what a plain object finds
// on Object.prototype) is tested against the TypeScript
// (crates/mandate-check/tests/front.rs reads both files).
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/front-vectors.mjs
//
// The inputs are written by hand to reach the branches the vectors of
// vectors/diagnostics/ do not; each result is JSON.stringify of what the
// function returns (a Set as an array, a RoleSite's value function as its
// value for the role "X"). Running it again writes the same bytes.

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`compiler/dist/${path}`, root).href);
const { link, references } = await dist("modules.js");
const { roleSites, rolesNamed, roleChecks } = await dist("check/roles.js");
const { resolveNames } = await dist("resolve/resolve.js");

const dir = new URL("crates/mandate-check/tests/front/", root);
const inputs = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8"));
const linked = link(inputs.program, inputs.modules);
const out = {
  references: [...references(inputs.workflow)],
  link: { defs: Object.keys(linked.defs), origin: Object.entries(linked.origin), diagnostics: linked.diagnostics },
  role_sites: roleSites(inputs.roles.defs).map(({ value, ...s }) => ({ ...s, value: value("X") })),
  roles_named: rolesNamed(inputs.roles.defs),
  role_checks: roleChecks(inputs.roles, undefined, link(inputs.roles, inputs.modules).defs),
  role_checks_opaque: roleChecks(inputs.roles),
  resolve: resolveNames(inputs.names),
  resolve_linked: resolveNames(inputs.names, undefined, link(inputs.names, inputs.modules).defs),
};
const text = JSON.stringify(out, null, 2).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
writeFileSync(new URL("expected.json", dir), text);
