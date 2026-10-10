// An agent's `run` tool runs a component's command in that component's root
// (K8; design doc 9 §2.2): an agent that reads several components and tests
// one runs the tests where they are, and one that tests two names which.

import { capsOf, check, linkedProgram, type CapVal } from "@mandate/compiler";
import { describe, expect, it } from "vitest";
import { commandFor, Denied, toolsFor } from "../src/tools.js";

const SYSTEM = `mandate @ 0.3
module acme.mini @ 0.1
interface Api {
  protocol openapi
  spec "docs/openapi.json"
}
component web {
  repo "acme/web"
  root "/work/web"
  lang ts
  owner role "web_owner"
  test exec("npm", ["test"])
  consumes Api
}
component api {
  repo "acme/api"
  root "/work/api"
  lang ts
  owner role "api_owner"
  test exec("npm", ["test"])
  provides Api
}
`;

/** The expanded capabilities, as the runtime grants them, of `capability` lines over the mini system. */
function grants(caps: string, names: string[]): CapVal[] {
  const modules = { "acme.mini": check(SYSTEM, "mdt").program! };
  const src = `mandate @ 0.3
module acme.t @ 0.1
use std.{component}
use acme.mini.{web, api}
${caps}
`;
  const r = check(src, "mdt", { modules });
  expect(r.program, JSON.stringify(r.diagnostics)).toBeTruthy();
  const defs = linkedProgram(r.program!, modules).defs as never;
  return names.flatMap((name) => capsOf(defs, { op: "var", name } as never));
}

describe("run's working directory", () => {
  it("is the component's root when the agent may test one component", () => {
    const tools = toolsFor(grants(`capability R = component.read(web, api)
capability T = component.exec(api, test)`, ["R", "T"]), { type: "string" });
    const r = commandFor(tools, "run", { command: "npm", args: ["test"] });
    expect(r).toMatchObject({ argv: ["npm", "test"], cwd: "/work/api" });
  });

  it("must be named when the agent may test two, and only as one of their roots", () => {
    const tools = toolsFor(grants(`capability R = component.read(web, api)
capability TW = component.exec(web, test)
capability TA = component.exec(api, test)`, ["R", "TW", "TA"]), { type: "string" });
    expect(commandFor(tools, "run", { command: "npm", args: ["test"] })).toBeInstanceOf(Denied);
    expect(commandFor(tools, "run", { command: "npm", args: ["test"], cwd: "/work/web" })).toMatchObject({ cwd: "/work/web" });
    expect(commandFor(tools, "run", { command: "npm", args: ["test"], cwd: "/work" })).toBeInstanceOf(Denied);
    expect(JSON.stringify(tools.specs.find((s) => s.name === "run"))).toContain("cwd");
  });
});
