// A fake of the Claude Managed Agents API, as far as the bridge executor uses
// it (runtime/src/managed-agents.ts): agents with versions, environments,
// sessions that hold their conversation and answer every message with a
// scripted agent turn, as an event stream. Like the service, it refuses a
// custom tool that takes a built-in tool's name, and a session that waits on
// tool results takes only tool results.

import type { ToolSpec } from "../src/adapters.js";
import { maToolName, type MaAgent, type MaEnvironment, type MaEvent, type MaSession, type ManagedAgentsApi } from "../src/managed-agents.js";
import type { SimTurn } from "../src/sim.js";
import { isObj, type Value } from "../src/values.js";

const BUILTIN = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"];

/** What a scripted turn may also do: hang until interrupted, hit the session's cap, or fail. */
export type FakeTurn = SimTurn | "hang" | "budget_reached" | "retries_exhausted";

interface Session {
  id: string;
  body: Record<string, unknown>;
  tools: Array<Record<string, unknown>>;
  events: MaEvent[];
  /** The conversation as the model sees it, in the Messages API's form. */
  messages: Value[];
  pending: string[];
  answered: Value[];
  activeSeconds: number;
  hanging: boolean;
  archived: boolean;
  turns: number;
}

export class FakeManagedAgents implements ManagedAgentsApi {
  readonly agents = new Map<string, MaAgent[]>();
  readonly environments = new Map<string, MaEnvironment>();
  readonly sessions = new Map<string, Session>();
  readonly sent: Array<{ session: string; events: Array<Record<string, unknown>> }> = [];
  readonly calls: string[] = [];
  private n = 0;
  /** The service's clock: a turn takes `secondsPerTurn`, everything else no time. */
  private clockMs = 1_800_000_000_000;

  constructor(
    public script: (messages: Value[], n: number) => FakeTurn,
    readonly o: { ceiling?: number; secondsPerTurn?: number; usage?: { input_tokens: number; output_tokens: number } } = {},
  ) {}

  private id(prefix: string): string {
    return `${prefix}_${String(++this.n).padStart(4, "0")}`;
  }

  private log(call: string): void {
    this.calls.push(call);
  }

  async modelMaxOutput(): Promise<number> {
    this.log("models.retrieve");
    return this.o.ceiling ?? 128_000;
  }

  async countTokens(p: { system: string; tools: ToolSpec[]; messages: Value[] }): Promise<number> {
    this.log("messages.countTokens");
    return Math.ceil(JSON.stringify([p.system, p.tools, p.messages]).length / 4);
  }

  async createAgent(body: Record<string, unknown>): Promise<MaAgent> {
    this.log("agents.create");
    const a = agentOf(this.id("agent"), 1, body);
    this.agents.set(a.id, [a]);
    return a;
  }

  async updateAgent(id: string, body: Record<string, unknown>): Promise<MaAgent> {
    this.log("agents.update");
    const versions = this.agents.get(id);
    if (!versions) throw status(404, `no agent ${id}`);
    const cur = versions.at(-1)!;
    if (body["version"] !== undefined && body["version"] !== cur.version) throw status(409, "version mismatch");
    const a = agentOf(id, cur.version + 1, body);
    versions.push(a);
    return a;
  }

  async retrieveAgent(id: string, version: number): Promise<MaAgent> {
    this.log("agents.retrieve");
    const a = this.agents.get(id)?.find((v) => v.version === version);
    if (!a) throw status(404, `no agent ${id} v${version}`);
    return a;
  }

  async createEnvironment(body: Record<string, unknown>): Promise<MaEnvironment> {
    this.log("environments.create");
    const e: MaEnvironment = { id: this.id("env"), archived_at: null, config: { ...(body["config"] as object), packages: {} } };
    this.environments.set(e.id, e);
    return e;
  }

  async retrieveEnvironment(id: string): Promise<MaEnvironment> {
    this.log("environments.retrieve");
    const e = this.environments.get(id);
    if (!e) throw status(404, `no environment ${id}`);
    return e;
  }

  async createSession(body: Record<string, unknown>): Promise<MaSession> {
    this.log("sessions.create");
    const agent = body["agent"] as { id: string; version: number; tools?: Array<Record<string, unknown>> };
    if (!this.agents.get(agent.id)?.some((a) => a.version === agent.version)) throw status(404, "no such agent version");
    if (!this.environments.has(String(body["environment_id"]))) throw status(404, "no such environment");
    const tools = agent.tools ?? [];
    this.checkTools(tools);
    const s: Session = { id: this.id("sesn"), body, tools, events: [], messages: [], pending: [], answered: [], activeSeconds: 0, hanging: false, archived: false, turns: 0 };
    this.sessions.set(s.id, s);
    return this.view(s);
  }

  private checkTools(tools: Array<Record<string, unknown>>): void {
    for (const t of tools) {
      if (BUILTIN.includes(String(t["name"]))) throw status(400, `custom tool name ${String(t["name"])} is a built-in tool's name`);
      // As the service does (seen live): no $ref in a custom tool's input schema.
      if (JSON.stringify(t["input_schema"] ?? {}).includes('"$ref"')) throw status(400, `custom tool "${String(t["name"])}" input_schema contains $ref, which is not supported`);
    }
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw status(404, `no session ${id}`);
    return s;
  }

  private view(s: Session): MaSession {
    return { id: s.id, status: s.archived ? "terminated" : "idle", usage: { active_seconds: s.activeSeconds } };
  }

  async retrieveSession(id: string): Promise<MaSession> {
    this.log("sessions.retrieve");
    return this.view(this.session(id));
  }

  async updateSession(id: string, body: Record<string, unknown>): Promise<MaSession> {
    this.log("sessions.update");
    const s = this.session(id);
    const tools = (body["agent"] as { tools?: Array<Record<string, unknown>> } | undefined)?.tools;
    if (tools) {
      this.checkTools(tools);
      s.tools = tools;
    }
    return this.view(s);
  }

  async archiveSession(id: string): Promise<MaSession> {
    this.log("sessions.archive");
    const s = this.session(id);
    s.archived = true;
    return this.view(s);
  }

  async listEvents(id: string): Promise<MaEvent[]> {
    this.log("events.list");
    return [...this.session(id).events];
  }

  private emit(s: Session, type: string, extra: Record<string, unknown> = {}): MaEvent {
    const e = { id: this.id("sevt"), type, processed_at: new Date(this.clockMs).toISOString(), ...extra } as MaEvent;
    s.events.push(e);
    return e;
  }

  async sendEvents(id: string, events: Array<Record<string, unknown>>): Promise<void> {
    this.log("events.send");
    const s = this.session(id);
    if (s.archived) throw status(400, "session is archived");
    this.sent.push({ session: id, events });
    for (const ev of events) {
      if (ev["type"] === "user.interrupt") {
        this.emit(s, "user.interrupt");
        if (s.hanging) {
          s.hanging = false;
          this.emit(s, "session.status_idle", { stop_reason: { type: "end_turn" } });
        }
        continue;
      }
      if (ev["type"] === "user.message") {
        if (s.pending.length) throw status(400, "the session is waiting on tool results");
        this.emit(s, "user.message", { content: ev["content"] });
        s.messages.push({ role: "user", content: ev["content"] as Value });
        this.turn(s);
        continue;
      }
      if (ev["type"] === "user.custom_tool_result") {
        const use = String(ev["custom_tool_use_id"]);
        if (!s.pending.includes(use)) throw status(400, `no pending tool use ${use}`);
        this.emit(s, "user.custom_tool_result", { custom_tool_use_id: use, content: ev["content"], is_error: ev["is_error"] });
        s.pending = s.pending.filter((p) => p !== use);
        const text = ((ev["content"] ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
        s.answered.push({ type: "tool_result", tool_use_id: use, content: text, ...(ev["is_error"] ? { is_error: true } : {}) });
        if (!s.pending.length) {
          s.messages.push({ role: "user", content: s.answered });
          s.answered = [];
          this.turn(s);
        }
        continue;
      }
      throw status(400, `unknown event ${String(ev["type"])}`);
    }
  }

  /** One agent turn: the script's blocks become the service's events. */
  private turn(s: Session): void {
    s.turns++;
    this.emit(s, "session.status_running");
    const r = this.script(s.messages, s.turns);
    s.activeSeconds += this.o.secondsPerTurn ?? 2;
    this.clockMs += (this.o.secondsPerTurn ?? 2) * 1000;
    if (r === "hang") {
      s.hanging = true;
      return;
    }
    const start = this.emit(s, "span.model_request_start");
    const usage = this.o.usage ?? { input_tokens: 1000, output_tokens: 200 };
    if (r === "budget_reached" || r === "retries_exhausted") {
      this.emit(s, "span.model_request_end", { model_request_start_id: start.id, is_error: r === "retries_exhausted", model_usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
      this.emit(s, "session.status_idle", { stop_reason: { type: r } });
      return;
    }
    if (!Array.isArray(r)) throw new Error("a fake turn is a list of blocks");
    const content: Value[] = [];
    const uses: string[] = [];
    for (const b of r) {
      if (!isObj(b)) continue;
      if (b["type"] === "text") {
        this.emit(s, "agent.message", { content: [b] });
        content.push(b);
      } else if (b["type"] === "tool_use") {
        // The model sees the session's tools by their names there.
        const e = this.emit(s, "agent.custom_tool_use", { name: maToolName(String(b["name"])), input: b["input"] });
        uses.push(e.id);
        content.push({ type: "tool_use", id: e.id, name: b["name"]!, input: b["input"]! });
      }
    }
    s.messages.push({ role: "assistant", content });
    this.emit(s, "span.model_request_end", { model_request_start_id: start.id, is_error: false, model_usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    s.pending = uses;
    this.emit(s, "session.status_idle", { stop_reason: uses.length ? { type: "requires_action", event_ids: uses } : { type: "end_turn" } });
  }

  /** Changes a deployed agent behind the binding's back, as a person in the Console could. */
  tamper(id: string, version: number, change: Partial<MaAgent>): void {
    const a = this.agents.get(id)!.find((v) => v.version === version)!;
    Object.assign(a, change);
  }
}

function agentOf(id: string, version: number, body: Record<string, unknown>): MaAgent {
  const m = body["model"] as { id: string; effort?: string };
  return {
    id,
    version,
    archived_at: null,
    model: { id: m.id, effort: m.effort ?? "medium", speed: "standard" },
    tools: (body["tools"] as unknown[]) ?? [],
    mcp_servers: (body["mcp_servers"] as unknown[]) ?? [],
    skills: (body["skills"] as unknown[]) ?? [],
    multiagent: null,
  };
}

function status(code: number, message: string): Error {
  return Object.assign(new Error(`${code} ${message}`), { status: code });
}
