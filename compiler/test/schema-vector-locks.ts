// The bases and mutations of the lock vectors (compiler/test/schema-vectors.test.ts). A base is a lock of the
// repository; the mutations are those of the IR cases (schema-vector-support.ts).

import { add, dup, empty, insert, remove, rename, set } from "./schema-vector-support.js";
import { ARR, many, N, one, type CaseSpec } from "./schema-vector-cases.js";

export const LOCK_BASES: Array<{ id: string; path: string }> = [
  { id: "reach", path: "fixtures/boundary/reach.lock.json" },
  { id: "bindings", path: "conformance/E1802c/mandate.lock.json" },
  { id: "members", path: "conformance/E1502/mandate.lock.json" },
  { id: "modules", path: "fixtures/fixbug/mandate.lock.json" },
];

const BA = "/bindings/managed-agents";
/** One character over the 253 a host name may have. */
const LONG_HOST = "h".repeat(254);

export const LOCK_CASES: CaseSpec[] = [
  one("reach", "/lock", remove),
  one("reach", "/modules", remove),
  one("reach", "", add("extra")),
  one("reach", "/lock", set("mandate/lock/0.9")),
  one("reach", "/lock", N),
  one("reach", "/models/standard/provider", set("openai")),
  one("reach", "/models/standard/effort", set("extreme")),
  one("reach", "/models/standard/max_input_tokens", set(0)),
  one("reach", "/models/standard/model", N),
  one("reach", "/models/standard/model", remove),
  one("reach", "/models/standard", add("extra")),
  one("reach", "/models", rename("standard", "Bad Tier")),
  one("reach", "/tariffs/claude-opus-5-5/currency", set("usd")),
  one("reach", "/tariffs/claude-opus-5-5/as_of", set("2026-1-9")),
  one("reach", "/tariffs/claude-opus-5-5/micros_per_mtok/input", set(-1)),
  one("reach", "/tariffs/claude-opus-5-5/micros_per_mtok/output", remove),
  one("reach", "/tariffs/claude-opus-5-5/micros_per_mtok", add("extra")),
  one("reach", "/host", empty),
  one("reach", "/host/node", set("22.x")),
  one("reach", "/host/bwrap", set("")),
  one("reach", "/host", add("git", "2")),
  one("reach", "/isolation", empty),
  one("reach", "/isolation/floor", rename("confidential", "secret")),
  one("reach", "/isolation/floor/restricted", set("vm")),
  one("reach", "/isolation/untrusted_network", set("none")),
  one("reach", "/isolation/co_tenancy/restricted", set("maybe")),
  one("reach", "/egress", rename("Reacher", "9bad")),
  one("reach", "/egress/Reacher", empty),
  one("reach", "/egress/Reacher/api.github.com", set("9x")),
  one("reach", "/egress/Reacher", rename("api.github.com", "")),
  one("reach", "/egress/Reacher", rename("api.github.com", LONG_HOST), false),
  one("bindings", `${BA}/format`, set("mandate/binding/other/0.1")),
  one("bindings", `${BA}/tools`, set("direct")),
  one("bindings", `${BA}/environment/config`, set("sha256:xyz")),
  one("bindings", `${BA}/session_fee/currency`, set("usd")),
  one("bindings", `${BA}/harness_tokens`, set(-1)),
  one("bindings", `${BA}/agents/Reader/version`, set(0)),
  one("bindings", `${BA}/agents/Reader/tier`, set("Standard")),
  one("bindings", `${BA}/agents`, rename("Reader", "bad name")),
  one("bindings", `${BA}/profile/cancel`, set("half")),
  one("bindings", `${BA}/profile`, remove),
  one("bindings", "/bindings", add("other", {})),
  one("bindings", "/egress/Reader", rename("api.github.com", "x".repeat(254)), false),
  one("members", "/members/alice/keys", empty),
  one("members", "/members/alice/keys", dup(0)),
  one("members", "/members/alice/keys/0", set("sha256:short")),
  one("members", "/members", rename("alice", "9a")),
  one("members", "/members/alice/keys", remove),
  one("members", "/roles/platform_lead", empty),
  one("members", "/roles/platform_lead", dup(0)),
  one("members", "/roles/platform_lead/0", set("bad name")),
  one("members", "/roles", rename("platform_lead", "9r")),
  one("modules", "/modules/company.domain", set("")),
  one("modules", "/modules/company.domain", N),
  one("modules", "/modules", ARR),
  many("three independent errors at three depths, in the order of the sort", "modules", [["/tariffs/claude-sonnet-5-5/currency", set("usd")], ["/lock", set("mandate/lock/0.9")], ["/models/economy/max_output_tokens", set(0)]]),
  many("two required members missing at one path", "modules", [["/models/economy/model", remove], ["/models/economy/effort", remove]]),
  // Valid for the schema, refused by validateLock after it
  many("bindings in a lock of 0.2, and every field that needs 0.5", "bindings", [["/lock", set("mandate/lock/0.2")]]),
  many("members and roles in a lock of 0.3", "members", [["/lock", set("mandate/lock/0.3")]]),
  many("host, isolation and egress in a lock of 0.4", "reach", [["/lock", set("mandate/lock/0.4")]]),
  many("a key listed under two members", "members", [["/members/bob/keys/0", set("sha256:1111111111111111111111111111111111111111111111111111111111111111")]]),
  many("a role lists a member that is not in members", "members", [["/roles/platform_lead", insert(1, "carol")]]),
  many("a tier maps to a model that has no tariff", "modules", [["/models/economy/model", set("claude-haiku-9")]]),
];
