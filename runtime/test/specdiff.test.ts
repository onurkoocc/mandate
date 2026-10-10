// How an interface changed (design doc 9 §4.2; BACKLOG item 33, B5): the
// consumer's side decides. What a consumer receives may grow but not shrink;
// what it sends may loosen but not tighten.

import { describe, expect, it } from "vitest";
import { covers, diffMcpTools, diffMigrations, diffOauth, diffOpenApi } from "../src/specdiff.js";

const api = (paths: Record<string, unknown>) => ({ openapi: "3.0.3", paths, components: { schemas: { Shipment: { type: "object", required: ["trackingNo", "status"], properties: { trackingNo: { type: "string" }, status: { type: "string", enum: ["IN_TRANSIT", "DELIVERED"] } } } } } });
const get = { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Shipment" } } } } } } };

describe("OpenAPI", () => {
  it("adding an operation is additive; removing one is breaking", () => {
    expect(diffOpenApi(api({ "/a": get }), api({ "/a": get, "/b": get })).kind).toBe("additive");
    expect(diffOpenApi(api({ "/a": get, "/b": get }), api({ "/a": get }))).toEqual({ kind: "breaking", changes: ["! /b removed"] });
  });

  it("a response field may be added, not removed or made optional", () => {
    const b = api({ "/a": get });
    const grow = structuredClone(b);
    (grow.components.schemas.Shipment.properties as Record<string, unknown>)["eta"] = { type: "string" };
    expect(diffOpenApi(b, grow).kind).toBe("additive");
    const shrink = structuredClone(b);
    delete (shrink.components.schemas.Shipment.properties as Record<string, unknown>)["status"];
    shrink.components.schemas.Shipment.required = ["trackingNo"];
    expect(diffOpenApi(b, shrink).kind).toBe("breaking");
  });

  it("a request field that becomes required, or a new required parameter, is breaking", () => {
    const post = (required: string[]) => ({ post: { requestBody: { content: { "application/json": { schema: { type: "object", required, properties: { newDate: { type: "string" }, reason: { type: "string" } } } } } }, responses: { "200": {} } } });
    expect(diffOpenApi(api({ "/r": post(["newDate"]) }), api({ "/r": post(["newDate", "reason"]) })).kind).toBe("breaking");
    expect(diffOpenApi(api({ "/r": post(["newDate", "reason"]) }), api({ "/r": post(["newDate"]) })).kind).toBe("additive");
    const withParam = (required: boolean) => ({ get: { parameters: [{ in: "query", name: "k", required, schema: { type: "integer" } }], responses: {} } });
    expect(diffOpenApi(api({ "/s": { get: { responses: {} } } }), api({ "/s": withParam(true) })).kind).toBe("breaking");
    expect(diffOpenApi(api({ "/s": { get: { responses: {} } } }), api({ "/s": withParam(false) })).kind).toBe("additive");
  });

  it("an unchanged spec is no change", () => {
    expect(diffOpenApi(api({ "/a": get }), api({ "/a": get }))).toEqual({ kind: "none", changes: [] });
  });
});

describe("MCP tools", () => {
  const tool = (name: string, required: string[], extra: Record<string, unknown> = {}) => ({ name, inputSchema: { type: "object", additionalProperties: false, required, properties: { tracking_no: { type: "string" }, ...extra } } });
  it("adding a tool is additive; removing one, or requiring a new input, is breaking", () => {
    const base = { tools: [tool("get_shipment", ["tracking_no"])] };
    expect(diffMcpTools(base, { tools: [...base.tools, tool("open_ticket", [])] }).kind).toBe("additive");
    expect(diffMcpTools(base, { tools: [] }).kind).toBe("breaking");
    expect(diffMcpTools(base, { tools: [tool("get_shipment", ["tracking_no", "channel"], { channel: { type: "string" } })] }).kind).toBe("breaking");
    expect(diffMcpTools(base, { tools: [tool("get_shipment", ["tracking_no"], { channel: { type: "string" } })] }).kind).toBe("additive");
  });
});

describe("OAuth metadata", () => {
  const meta = { issuer: "http://auth:9000", token_endpoint: "http://auth:9000/token", scopes_supported: ["shipments:read", "tickets:write"] };
  it("a new scope is additive; a dropped scope or a moved endpoint is breaking", () => {
    expect(diffOauth(meta, { ...meta, scopes_supported: [...meta.scopes_supported, "deliveries:write"] }).kind).toBe("additive");
    expect(diffOauth(meta, { ...meta, scopes_supported: ["shipments:read"] }).kind).toBe("breaking");
    expect(diffOauth(meta, { ...meta, token_endpoint: "http://auth:9000/oauth/token" }).kind).toBe("breaking");
  });
});

describe("database migrations (a heuristic, doc 9 §14 Q1)", () => {
  it("a new migration is additive unless it drops or renames; a changed one is breaking", () => {
    const v1 = { "V1__core.sql": "create table t (a int);" };
    expect(diffMigrations(v1, { ...v1, "V2__more.sql": "alter table t add column b int;" }).kind).toBe("additive");
    expect(diffMigrations(v1, { ...v1, "V2__less.sql": "alter table t drop column a;" }).kind).toBe("breaking");
    expect(diffMigrations(v1, { "V1__core.sql": "create table t (a bigint);" }).kind).toBe("breaking");
  });
});

describe("a declaration covers a measured change when it does not understate it", () => {
  it("orders none < additive < breaking", () => {
    expect(covers("additive", "none")).toBe(true);
    expect(covers("additive", "additive")).toBe(true);
    expect(covers("additive", "breaking")).toBe(false);
    expect(covers("none", "additive")).toBe(false);
  });
});
