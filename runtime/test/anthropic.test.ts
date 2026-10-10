// The Anthropic model adapter against a fake client (P1-6, K10–K12): what it
// sends, what it reserves and settles, and what it journals. The same
// program runs against the real API in live.test.ts (MANDATE_LIVE=1).

import type Anthropic from "@anthropic-ai/sdk";
import { check } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { AnthropicModel, boundOf, forApi, priceUsage, type AnthropicClient } from "../src/anthropic.js";
import { closeAll, world } from "./helpers.js";
import { ASK_CAPITAL, LOCK } from "./models.js";

class FakeClient implements AnthropicClient {
  readonly created: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly counted: Anthropic.MessageCountTokensParams[] = [];
  constructor(
    private readonly answer: (p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message | Promise<Anthropic.Message>,
    private readonly inputTokens = 120,
  ) {}
  messages = {
    create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
      this.created.push(p);
      return this.answer(p);
    },
    countTokens: async (p: Anthropic.MessageCountTokensParams) => {
      this.counted.push(p);
      return { input_tokens: this.inputTokens } as Anthropic.MessageTokensCount;
    },
  };
}

const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Anthropic.Usage;

function message(text: string, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
    ...extra,
  } as Anthropic.Message;
}

afterAll(closeAll);

describe("pricing (K12)", () => {
  const tariff = LOCK.tariffs!["claude-opus-5-5"]!;

  it("counts every token the model processed and prices each kind at its rate", () => {
    // 1000 input × 4 + 2000 cache write × 5 + 50 000 cache read × 0.2 + 500 output × 20 micro-USD per token… per million.
    expect(priceUsage(tariff, { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50_000, output_tokens: 500 })).toEqual({
      tokens: 53_500,
      spend: { micros: 34_000, currency: "USD" },
    });
  });

  it("bounds a call by its counted input, priced as a cache write, and the whole output limit", () => {
    expect(boundOf(tariff, LOCK.models!["standard"]!, 10_000)).toEqual({ tokens: 22_000, steps: 1, spend: { micros: 290_000, currency: "USD" } });
  });
});

describe("infer through the Anthropic adapter", () => {
  const program = check(ASK_CAPITAL, "mdt").program!;

  it("sends the locked model and effort, reserves the bound, settles the usage and journals the snapshot", async () => {
    const client = new FakeClient(() => message('{"value":{"capital":"Ankara"}}', { model: "claude-opus-5-5" }));
    const model = new AnthropicModel({ lock: LOCK, program, client });
    const w = await world(ASK_CAPITAL, { lock: LOCK, realModel: model });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "a1" });
    expect(run.state).toBe("succeeded");
    expect(run.result).toEqual({ capital: "Ankara" });

    const sent = client.created[0]!;
    expect(sent).toMatchObject({ model: "claude-opus-5-5", max_tokens: 12_000, output_config: { effort: "high", format: { type: "json_schema" } }, cache_control: { type: "ephemeral" } });
    expect(JSON.stringify(sent.messages)).toContain("<data>");
    // One count for the reservation, reused by the call.
    expect(client.counted).toHaveLength(1);

    const report = await w.rt.budgetReport("a1");
    const infer = report.commands.find((c) => c.kind === "infer")!;
    // Reserved: 120 counted input at the cache-write price + 12 000 output tokens at 20 USD/MTok.
    expect(infer.reserved).toEqual({ tokens: 12_120, steps: 1, "spend:USD": 240_600 });
    expect(infer.cost).toEqual({ tokens: 120, steps: 1, spend: { micros: 800, currency: "USD" } });
    expect(report.dimensions).toEqual([
      { dimension: "spend:USD", limit: 1_000_000, settled: 800, reserved: 0, available: 999_200 },
      { dimension: "tokens", limit: 200_000, settled: 120, reserved: 0, available: 199_880 },
    ]);
    const completed = (await w.rt.journal.events("a1")).find((e) => e.type === "command_completed")!;
    expect(completed.data).toMatchObject({ meta: { model: "claude-opus-5-5", locked: "claude-opus-5-5", effort: "high", request: "msg_1" } });
    // Replay reads the journal and calls nothing.
    expect(await w.rt.replayRun("a1")).toEqual({ status: "complete", value: { capital: "Ankara" } });
    expect(client.created).toHaveLength(1);
  });

  it("sends no schema keyword the API refuses, and still refuses an answer out of the type's bounds", async () => {
    const SRC = ASK_CAPITAL.replace("type Answer = { capital: Text }", "type Answer = { capital: Text, wait: Duration, cities: List<Text> where len(cities) >= 2 }");
    const p = check(SRC, "mdt").program!;
    const client = new FakeClient(() => message('{"value":{"capital":"Ankara","wait":-5,"cities":["Ankara"]}}'));
    const w = await world(SRC, { lock: LOCK, realModel: new AnthropicModel({ lock: LOCK, program: p, client }) });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "a-bounds" });
    const sent = JSON.stringify(client.created[0]!.output_config);
    for (const k of ["minimum", "minItems", "maxItems"]) expect(sent).not.toContain(`"${k}"`);
    // The bound the API was not told about is checked on the answer: a negative Duration is refused.
    expect(run.state).not.toBe("succeeded");
    expect(JSON.stringify(await w.rt.journal.events("a-bounds"))).toContain("schema_mismatch");
    // A property that happens to be named like a keyword stays.
    expect(forApi({ type: "object", properties: { minimum: { type: "integer", minimum: 0 } } })).toEqual({ type: "object", properties: { minimum: { type: "integer" } } });
  });

  it("does not send a call whose input is over the locked limit", async () => {
    const client = new FakeClient(() => message("{}"), 200_000);
    const w = await world(ASK_CAPITAL, { lock: LOCK, realModel: new AnthropicModel({ lock: LOCK, program, client }) });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "a2" });
    expect(client.created).toHaveLength(0);
    // The bound alone (200 000 input + 12 000 output tokens) is over the run's 200k tokens.
    expect(run.state).toBe("waiting");
    expect(run.waiting).toMatchObject({ kind: "budget_exceeded" });
  });

  it("settles nothing for a rejected request, and keeps the reservation when the connection broke (R16)", async () => {
    const Sdk = (await import("@anthropic-ai/sdk")).default;
    const rejected = new FakeClient(() => {
      throw new Sdk.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers());
    });
    const w = await world(ASK_CAPITAL, { lock: LOCK, realModel: new AnthropicModel({ lock: LOCK, program, client: rejected }) });
    const r1 = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "a3" });
    expect(r1.state).toBe("failed");
    expect(r1.error).toMatchObject({ $tag: "Rejected" });
    expect((await w.rt.budgetReport("a3")).dimensions.every((d) => d.settled === 0 && d.reserved === 0)).toBe(true);

    const broken = new FakeClient(() => {
      throw new Sdk.APIConnectionTimeoutError();
    });
    const w2 = await world(ASK_CAPITAL, { lock: LOCK, realModel: new AnthropicModel({ lock: LOCK, program, client: broken }) });
    const r2 = await w2.rt.startRun({ pkg: w2.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "a4" });
    expect(r2.error).toMatchObject({ $tag: "Timeout" });
    expect((await w2.rt.budgetReport("a4")).dimensions.find((d) => d.dimension === "spend:USD")).toMatchObject({ settled: 0, reserved: 240_600 });
  });

  it("waits out the provider's quota and sends the same call again: Throttled, not a Timeout (§8.6, V14)", async () => {
    const Sdk = (await import("@anthropic-ai/sdk")).default;
    let calls = 0;
    const client = new FakeClient(() => {
      if (++calls === 1) throw new Sdk.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers({ "retry-after": "7" }));
      return message('{"value":{"capital":"Ankara"}}');
    });
    const w = await world(ASK_CAPITAL, { lock: LOCK, realModel: new AnthropicModel({ lock: LOCK, program, client }) });
    const t0 = w.clock.now();
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "a5" });
    expect(run.state).toBe("succeeded");
    expect(client.created).toHaveLength(2);
    expect(w.clock.now() - t0).toBe(7_000);
    const throttled = (await w.rt.journal.events("a5")).filter((e) => e.type === "command_throttled");
    expect(throttled).toHaveLength(1);
    expect(throttled[0]!.data).toMatchObject({ fault: { tag: "Throttled", args: [{ retry_after_ms: 7_000, status: 429 }] } });
  });

  it("refuses to run without models in the lock", () => {
    expect(() => new AnthropicModel({ lock: { modules: {} }, program, client: new FakeClient(() => message("{}")) })).toThrow(expect.objectContaining({ code: "unlocked_model_tier" }));
  });
});
