// The migration of spec/envelope.md, from the first approval to the replay
// (fixtures/envelope): a person approves the envelope once; a map moves 24
// repositories, 16 at a time; a lead plans what is left as sub-programs, one
// refused for what the envelope has left and one admitted; the admitted one
// moves the last repository and merges it, which the release manager signs
// twice, once as evidence that the change is accepted and once to authorize
// the merge; and the finished run replays without a model, an adapter or the
// checker.
//
// The agents are loops answered by a scripted model. Every number the test
// states is one the ledger or the journal holds.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, hashProgram, kindOf, load, loadModules, toMarkdown, type Json, type Modules, type Program } from "@mandate/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatModel, TurnRequest } from "../src/adapters.js";
import { AnthropicModel } from "../src/anthropic.js";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { baseOf, type WorkerChecker } from "../src/plan.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimChat, SimSandboxHost, SimTool, toolUse, type SimTurn } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";
import { runDoc, runView } from "../src/views.js";
import { closeAll, commandIds, planChecker, world, type World } from "./helpers.js";
import { LOCK } from "./models.js";

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);

afterAll(async () => {
  await checker.close();
  await closeAll();
});

const here = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const DOMAIN = "fixtures/envelope/domain.mdt";
const MODULE = "company.migrations";

/**
 * The fixture as it is. Its contract `Moved` is what lets a sub-program merge: `git.merge` takes a verified value
 * and, being irreversible, one a person approved (E0405), and a sub-program may use its parent's contracts but
 * define none (E1705).
 */
const source = (): string => here("fixtures/envelope/migrate-all.mdt");

const NAMES = Array.from({ length: 24 }, (_, i) => `svc-${String(i + 1).padStart(2, "0")}`);
/** The one repository the bulk migration cannot move. */
const HARD = "svc-07";
const PLAN = "/defs/MigrateAll/body/1/value";
const PROGRAM = `${PLAN}/program/1`;

/** The definitions of a sub-program, written as text, as the operations a lead sends. */
function ops(defs: string): Value[] {
  const r = load(`mandate @ 0.4\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n${defs}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return Object.entries((r.program as Program).defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
}

/**
 * The lead's sub-program: it moves the repository the map could not, inside that repository only, checks what the
 * migrator reports, and merges it. `agents` is what it asks of the envelope's agents.
 */
const retry = (agents: number): string => `capability Hard = SrcWrite.narrow("/work/repos/${HARD}")

workflow Retry() -> Inferred<Summary>
  caps   RepoRead, Hard, Build, ModelStd, Merge
  budget { tokens: 400k, time: 20m, spend: 0.5 USD, steps: 12, agents: ${agents} }
{
  let repo = Repo { name: "${HARD}", root: "${HARD}" }
  let moved = delegate Migrator.migrate(repo) with caps Hard
  let checked = verify moved against Moved(repo, moved)
  effect git.merge(checked)
    idempotent_by repo.name
  moved
}`;

const submit = (id: string, defs: string): SimTurn => [toolUse(id, "submit_program", { base: baseOf(MODULE, 1), ops: ops(defs) })];

/** The text of a loop's first message: the skill and its inputs. */
const task = (req: TurnRequest): string => JSON.stringify(req.messages[0]);
const repoOf = (req: TurnRequest): string => /\\"name\\":\\"(svc-\d\d)\\"/.exec(task(req))?.[1] ?? "?";
/** What a tool call answered, when the turn before this one made one. */
function answered(req: TurnRequest): Obj | undefined {
  const last = req.messages.at(-1) as { role: string; content: Array<{ type: string; content?: string }> };
  const result = last.role === "user" ? last.content.find((b) => b.type === "tool_result") : undefined;
  return result?.content?.startsWith("{") ? (JSON.parse(result.content) as Obj) : undefined;
}

const events = async (w: World, runId: string, type: string): Promise<Obj[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);

describe("MigrateAll: an envelope approved once, 24 migrators, and a lead that plans what is left", () => {
  it("runs from the approval to the replay", async () => {
    const { modules, problems } = loadModules([{ file: DOMAIN, text: here(DOMAIN), kind: kindOf(DOMAIN) }]);
    expect(problems).toEqual([]);
    const mods: Modules = modules;
    const alice = EvidenceSigner.generate();
    const bob = EvidenceSigner.generate();
    const lock = {
      modules: { "company.domain": hashProgram(check(here(DOMAIN), "mdt").program as unknown as Json).program },
      members: { alice: { keys: [alice.keyId] }, bob: { keys: [bob.keyId] } },
      roles: { platform_lead: ["alice"], release_manager: ["bob"] },
    };
    const merge = new SimTool("git.merge", "reconcilable");
    const w = await world(source(), { modules: mods, lock, decisions: { keys: new TrustedKeys([alice.publicKey, bob.publicKey]) }, plan: { checker }, tools: [merge] });

    // ── the model ─────────────────────────────────────────────────────
    const summary = { migrated: NAMES, left: [], notes: `${HARD} by a sub-program` };
    const lead: SimTurn[] = [
      // The envelope has 200 agents. 24 migrators and the lead have taken 25 of them.
      submit("s1", retry(176)),
      submit("s2", retry(1)),
      [toolUse("done", "finish", { result: summary })],
    ];
    const told: Obj[] = [];
    let handed = "";
    let inFlight = 0;
    let arrived = 0;
    let peak = 0;
    const full: Array<() => void> = [];
    const chat = new SimChat(async (req) => {
      if (req.agent === "Lead") {
        handed ||= task(req);
        const answer = answered(req);
        if (answer) told.push(answer);
        return lead.shift()!;
      }
      // A migrator. In the map they wait for each other until sixteen are at work, so the peak is the envelope's.
      const bulk = !req.commandId.startsWith(PROGRAM);
      if (bulk) {
        inFlight++;
        arrived++;
        peak = Math.max(peak, inFlight);
        if (inFlight < 16 && arrived < NAMES.length) await new Promise<void>((r) => full.push(r));
        for (const r of full.splice(0)) r();
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
      }
      const name = repoOf(req);
      if (bulk && name === HARD) return { error: { tag: "SkillFailed", args: ["its build is not the one the bulk migration knows"] }, cost: { steps: 1 } };
      return [toolUse("f", "finish", { result: { migrated: [name], left: [], notes: "" } })];
    });
    const host = new SimSandboxHost();
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    const input = { repos: NAMES.map((n) => ({ name: n, root: n })) };
    const sign = async (who: "alice" | "bob", signer: EvidenceSigner) => signDecision(signer, await w.rt.shown("demo", "wait"), { kind: "approve", member: who, at: new Date(w.adapters.clock.now()) });
    let sent = 0;
    const decide = async (who: "alice" | "bob", signer: EvidenceSigner) => w.rt.decideAction("demo", { sender: "test", messageId: `m${++sent}` }, { signed: await sign(who, signer) });

    // ── nothing starts before the envelope's owner has approved it ────
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "MigrateAll", input, runId: "early" })).rejects.toMatchObject({ code: "unapproved_envelope" });
    await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));

    // ── the map, the lead, and the sub-program up to its contract ─────
    const asked = await w.rt.startRun({ pkg: w.pkg, workflow: "MigrateAll", input, runId: "demo" });
    expect(asked.state, JSON.stringify(asked.error ?? asked.attention ?? told)).toBe("waiting");
    expect(asked.waiting).toMatchObject({ kind: "decision", command: `${PROGRAM}/defs/Retry/body/2/value/contract/accept/release_approved/call`, request: { role: "release_manager", criterion: "release_approved" } });

    // 24 migrators, sixteen at a time, each writing below its own repository and nowhere else.
    expect(await events(w, "demo", "map_started")).toEqual([{ map: "/defs/MigrateAll/body/0/value", items: 24, par: 16 }]);
    expect(peak).toBe(16);
    const bulk = host.created.slice(0, 24).map((c) => c.policy.filesystem.readWrite.filter((p) => p.startsWith("/work/")));
    expect(bulk.map((p) => p.join()).sort()).toEqual(NAMES.map((n) => `/work/repos/${n}`));

    // The lead was handed one outcome for each repository, in the order of the list.
    const done = JSON.parse(/<data name=\\"done\\">\\n(.*?)\\n<\/data>/.exec(handed)![1]!.replaceAll('\\"', '"')) as Obj[];
    expect(done).toHaveLength(24);
    expect(done.map((o) => o["$tag"])).toEqual(NAMES.map((n) => (n === HARD ? "Failed" : "Ok")));
    expect(done[0]).toMatchObject({ $tag: "Ok", $args: [{ migrated: ["svc-01"] }] });

    // Its first sub-program asked for more agents than the envelope had left, and was refused with the numbers.
    expect(told[0]).toMatchObject({ admitted: false, number: 1 });
    expect((told[0]!["diagnostics"] as Obj[]).filter((d) => d["severity"] === "error").map((d) => [d["code"], d["facts"]])).toEqual([["MDT-E1706", { dimension: "agents", asked: 176, left: 175 }]]);
    expect(await events(w, "demo", "program_refused")).toMatchObject([{ number: 1, codes: ["MDT-E1706"] }]);
    // The second fits, was admitted under the same number, and is in flight: its contract waits for the release manager.
    expect(await events(w, "demo", "program_admitted")).toMatchObject([{ number: 1, command: PROGRAM, workflow: "Retry", reservation: { tokens: 400_000, steps: 12, agents: 1, "spend:USD": 500_000 } }]);
    expect(merge.executions).toHaveLength(0);

    // ── the contract: the release manager's approval is evidence ──────
    // The envelope's owner approved the envelope. She is not the release manager, and her approval is none here.
    await expect(decide("alice", alice)).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    const verified = await decide("bob", bob);
    expect(verified.state, JSON.stringify(verified.error ?? verified.attention)).toBe("waiting");

    // ── the merge: admission authorized nothing, and neither did the evidence ─
    expect(verified.waiting).toMatchObject({ kind: "decision", command: `${PROGRAM}/defs/Retry/body/3/value/authorize`, request: { effect: "git.merge", role: "release_manager" } });
    expect(merge.executions).toHaveLength(0);
    await expect(decide("alice", alice)).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    expect(merge.executions).toHaveLength(0);
    const r = await decide("bob", bob);
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual(summary);
    expect(merge.executions).toHaveLength(1);
    expect(await events(w, "demo", "action_authorized")).toMatchObject([{ by: "bob", member: "bob", role: "release_manager" }]);
    expect(told[1]).toMatchObject({ admitted: true, number: 1, result: { migrated: [HARD], left: [], notes: "" } });
    // The sub-program's migrator could write below the one repository its capability names. It is the 25th sandbox
    // that could write anything; the lead's, which was opened again after each wait, can only read.
    const writers = host.created.map((c) => c.policy.filesystem.readWrite.filter((p) => p.startsWith("/work/")).join()).filter((p) => p !== "");
    expect(writers).toHaveLength(25);
    expect(writers.at(-1)).toBe(`/work/repos/${HARD}`);

    // ── the ledger: 24 migrators, the lead, and the sub-program's one ──
    const budget = await w.rt.journal.budget("demo");
    expect(budget["agents"]).toEqual({ limit: 200, settled: 26, reserved: 0 });
    for (const dim of ["tokens", "steps", "spend:USD"]) expect(budget[dim]!.reserved, dim).toBe(0);
    expect(await commandIds(w, "demo", "program")).toEqual([PROGRAM]);
    expect((await commandIds(w, "demo", "delegate")).filter((id) => id.startsWith(PROGRAM))).toEqual([`${PROGRAM}/defs/Retry/body/1/value`]);

    // ── the people: every decision of the run is signed by the member whose role it names ─
    // The envelope once, by its owner; then the evidence and the authorization of the merge, by the release manager.
    const decisions = await w.rt.verifyDecisions("demo");
    expect(decisions.map((d) => [d.record.kind, d.record.member, d.record.role ?? null, d.valid])).toEqual([
      ["envelope", "alice", "platform_lead", true],
      ["approve", "bob", "release_manager", true],
      ["approve", "bob", "release_manager", true],
    ]);
    expect((await w.rt.verifyEvidence("demo")).map((e) => [e.criterion, e.valid])).toEqual([
      ["moved", true],
      ["nothing_left", true],
      ["release_approved", true],
    ]);

    // ── the view: what a person reads of the run afterwards ───────────
    const { view, program } = await runView(w.rt, "demo");
    // 174 of the envelope's 200 agents are left, and the run had the envelope's six hours from its start.
    expect(view.envelope).toMatchObject({ workflow: "MigrateAll", owner: "platform_lead", amendments: [] });
    expect(view.envelope!.remainder.find((d) => d.dimension === "agents")).toEqual({ dimension: "agents", envelope: 200, limit: 200, settled: 26, reserved: 0, left: 174 });
    expect(view.envelope!.deadline! - (await w.rt.journal.startedAt("demo"))).toBe(6 * 3_600_000);
    // The map's 24 items by index: one failed, and the lead was told which.
    expect(view.maps).toEqual([{ node: "/defs/MigrateAll/body/0/value", items: 24, par: 16, state: "ended", failed: null, outcomes: NAMES.map((n) => (n === HARD ? "SkillFailed" : "Ok")) }]);
    // The lead's two submissions under the same number: the one refused with its code, the one admitted with its reservation.
    expect(view.plans).toMatchObject([
      {
        node: PLAN,
        lead: "Lead.finish",
        submissions: [
          { number: 1, outcome: "refused", codes: ["MDT-E1706"], hash: null, command: null },
          { number: 1, outcome: "admitted", codes: [], reservation: { tokens: 400_000, steps: 12, agents: 1, "spend:USD": 500_000 }, command: PROGRAM, state: "succeeded", stored: "kept" },
        ],
        amendments: [],
      },
    ]);
    expect(view.plans[0]!.submissions[1]!.text).toContain(`capability Hard = SrcWrite.narrow("/work/repos/${HARD}")`);
    expect(view.decisions.map((d) => [d.kind, d.by, d.role, d.signature])).toEqual([
      ["envelope", "alice", "platform_lead", "valid"],
      ["approve", "bob", "release_manager", "valid"],
      ["approve", "bob", "release_manager", "valid"],
    ]);
    const md = toMarkdown(runDoc(view, program));
    for (const heading of ["## Envelope", `## Plan at ${PLAN}`, "## Map at /defs/MigrateAll/body/0/value", "## Decisions"]) expect(md).toContain(heading);

    // ── the replay: the same value, from the journal and the stored sub-program ─
    const turns = chat.calls.length;
    const sandboxes = host.created.length;
    expect(await w.rt.replayRun("demo")).toEqual({ status: "complete", value: summary });
    expect(chat.calls).toHaveLength(turns);
    expect(host.created).toHaveLength(sandboxes);
    expect(merge.executions).toHaveLength(1);
  });
});

// ── with a real model as the lead ───────────────────────────────────────
//
// The same run with the lead's turns answered by a real model. It runs only
// with MANDATE_LIVE=1 and MANDATE_ENVELOPE=1, never in PR CI, and it spends
// real money: the lead's budget is 10 USD at most. The key is read as in
// live.test.ts. The migrators stay scripted, so what is shown is a model
// that reads the outcomes of the map, writes a sub-program as IR and sends
// it to the checker. What the model writes is its own. The test holds the
// run to what must be true whatever it writes, and prints what happened.

const LIVE = process.env["MANDATE_LIVE"] === "1" && process.env["MANDATE_ENVELOPE"] === "1";
const envFile = new URL("../../.env", import.meta.url);
if (LIVE && !process.env["CLAUDE_API_KEY"] && existsSync(envFile)) process.loadEnvFile(envFile);

describe.skipIf(!LIVE)("live: MigrateAll with a real model as its lead", () => {
  it("runs nothing that does not fit the envelope, whatever the lead writes", async () => {
    const { modules, problems } = loadModules([{ file: DOMAIN, text: here(DOMAIN), kind: kindOf(DOMAIN) }]);
    expect(problems).toEqual([]);
    const signers = { alice: EvidenceSigner.generate(), bob: EvidenceSigner.generate() };
    // FixBug's lock pins the models and their prices. This one adds the people and the module.
    const lock = {
      ...LOCK,
      modules: { "company.domain": hashProgram(check(here(DOMAIN), "mdt").program as unknown as Json).program },
      members: { alice: { keys: [signers.alice.keyId] }, bob: { keys: [signers.bob.keyId] } },
      roles: { platform_lead: ["alice"], release_manager: ["bob"] },
    };
    const merge = new SimTool("git.merge", "reconcilable");
    const w = await world(source(), { modules, lock, decisions: { keys: new TrustedKeys([signers.alice.publicKey, signers.bob.publicKey]) }, plan: { checker }, tools: [merge] });
    const apiKey = process.env["CLAUDE_API_KEY"];
    expect(apiKey, "CLAUDE_API_KEY").toBeTruthy();
    const ws = process.env["CLAUDE_WORKSPACE_ID"] ?? process.env["anthropic-workspace-id"];
    const model = new AnthropicModel({ lock, program: check(source(), "mdt", { modules }).program!, apiKey: apiKey!, ...(ws ? { workspaceId: ws } : {}) });
    // A migrator of the map cannot move one repository. Any other migrator, one of a sub-program among them, moves its own.
    const migrators = new SimChat((req) => {
      const name = repoOf(req);
      if (name === HARD && !req.commandId.startsWith(`${PLAN}/program/`)) return { error: { tag: "SkillFailed", args: ["its build is not the one the bulk migration knows"] }, cost: { steps: 1 } };
      return [toolUse("f", "finish", { result: { migrated: [name], left: [], notes: "" } })];
    });
    const of = (req: TurnRequest): ChatModel => (req.agent === "Lead" ? model : migrators);
    const chat: ChatModel = { turnBound: (req) => of(req).turnBound(req), turn: (req) => of(req).turn(req) };
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };

    await w.rt.approveEnvelope(w.pkg, signDecision(signers.alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));
    let r = await w.rt.startRun({ pkg: w.pkg, workflow: "MigrateAll", input: { repos: NAMES.map((n) => ({ name: n, root: n })) }, runId: "live-demo" });
    // The people answer what the run asks them: the release manager approves, and the owner does not widen the envelope.
    for (let sent = 1; sent <= 12 && r.state === "waiting"; sent++) {
      const wait = isObj(r.waiting) ? r.waiting : {};
      const role = isObj(wait["request"]) ? wait["request"]["role"] : undefined;
      const who = role === "platform_lead" ? "alice" : role === "release_manager" ? "bob" : undefined;
      if (!who || (wait["kind"] !== "decision" && wait["kind"] !== "amendment")) break;
      const signed = signDecision(signers[who], await w.rt.shown("live-demo", "wait"), { kind: wait["kind"] === "amendment" ? "decline" : "approve", member: who, at: new Date(w.adapters.clock.now()) });
      const msg = { sender: "test", messageId: `live-${sent}` };
      r = wait["kind"] === "amendment" ? await w.rt.decideAmendment("live-demo", msg, signed) : await w.rt.decideAction("live-demo", msg, { signed });
    }

    const { view } = await runView(w.rt, "live-demo");
    const plan = view.plans[0];
    console.log(
      `live demo: ${JSON.stringify({
        state: r.state,
        result: r.result ?? r.error ?? r.attention ?? r.waiting,
        submissions: plan?.submissions.map((s) => [s.number, s.outcome, s.codes]),
        amendments: plan?.amendments.map((a) => a.outcome),
        merges: merge.executions.length,
        left: view.envelope?.remainder.map((d) => [d.dimension, d.left]),
      })}`,
    );
    // The bulk migration is the program's own: 24 items, and the one that failed.
    expect(view.maps[0]).toMatchObject({ items: 24, state: "ended", outcomes: NAMES.map((n) => (n === HARD ? "SkillFailed" : "Ok")) });
    // Whatever the lead wrote, the run stayed inside the envelope in every dimension.
    for (const d of view.envelope!.remainder) {
      expect(d.settled + d.reserved, d.dimension).toBeLessThanOrEqual(d.envelope ?? d.limit);
      expect(d.left, d.dimension).toBeGreaterThanOrEqual(0);
    }
    // A submission was admitted or refused, and an admitted one is stored as what was admitted.
    for (const s of plan?.submissions ?? []) {
      expect(["admitted", "refused"]).toContain(s.outcome);
      if (s.outcome === "admitted") expect(s.stored).toBe("kept");
    }
    // Nothing was merged without the release manager's signed approval of that merge.
    const authorized = await events(w, "live-demo", "action_authorized");
    expect(merge.executions.length).toBeLessThanOrEqual(authorized.length);
    for (const a of authorized) expect(a).toMatchObject({ member: "bob", role: "release_manager" });
    // Every decision the run took is a signed record that verifies.
    expect(view.decisions.map((d) => d.signature)).toEqual(view.decisions.map(() => "valid"));
    // A finished run replays to the same value. A replay refuses any call to a model, an adapter or the checker.
    if (r.state === "succeeded") expect(await w.rt.replayRun("live-demo")).toEqual({ status: "complete", value: r.result });
  }, 900_000);
});
