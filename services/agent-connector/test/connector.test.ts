/**
 * The connector end to end on this computer, with a fake agent that speaks
 * MCP to it and a fake engine: a turn starts only with the token and a
 * local callback, the agent sees exactly the engine's tools, each call is
 * forwarded with the turn's token, the end is reported once, and stop and
 * time-out end a turn as such.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AgentRegistry, createDefaultAgents } from "../src/agents/registry.ts";
import type { AgentAdapter, TurnEnd, TurnSpec } from "../src/agents/types.ts";
import type { Box } from "../src/box.ts";
import { claudeAdapter } from "../src/agents/claude.ts";
import { createConnector } from "../src/server.ts";
import { MAX_TIMEOUT_MS, readImages, turnEffort, turnModel, turnTimeoutMs } from "../src/turns.ts";
import { claudeLimited, claudeReply, fakeCli } from "./fake-cli.ts";

const TOKEN = "connector-token-0123456789";

/** An agent that calls `script` with its MCP access, then ends as the script says. */
function fakeAgent(script: (mcp: (method: string, params?: unknown) => Promise<any>, spec: TurnSpec) => Promise<TurnEnd>): AgentAdapter & { specs: TurnSpec[]; infos: number } {
  const specs: TurnSpec[] = [];
  return {
    id: "fake",
    label: "Fake agent",
    specs,
    infos: 0,
    async info() {
      this.infos++;
      return { installed: true, version: "1.0", signedIn: true };
    },
    run(spec) {
      specs.push(spec);
      let killed: (end: TurnEnd) => void = () => undefined;
      const stopped = new Promise<TurnEnd>((resolve) => (killed = resolve));
      let id = 0;
      const mcp = async (method: string, params?: unknown) => {
        const response = await fetch(spec.mcp.url, { method: "POST", headers: { ...spec.mcp.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
        return response.json();
      };
      return { done: Promise.race([script(mcp, spec), stopped]), kill: () => killed({ ok: false, problem: "stopped" }) };
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An engine that answers tool calls and records what the connector sends it. */
async function fakeEngine(answer: (body: any) => unknown = (body) => ({ text: `ran ${body.name}`, isError: false })) {
  const calls: Array<{ path: string; auth: string | undefined; body: any }> = [];
  let finished: (body: any) => void = () => undefined;
  const finish = new Promise<any>((resolve) => (finished = resolve));
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: request.url ?? "", auth: request.headers.authorization, body });
    if (request.url?.endsWith("/finish")) finished(body);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(request.url?.endsWith("/tools") ? answer(body) : { ok: true }));
  });
  const url = await listen(server);
  return { url, calls, finish, server };
}

async function setup(agent: AgentAdapter, timeoutMs?: number, answer?: (body: any) => unknown, box?: Box, noWorkspaces = false) {
  const engine = await fakeEngine(answer);
  const { server } = createConnector({ token: TOKEN, agents: new AgentRegistry().register(agent), defaults: { agent: "fake", model: "small" }, log: () => undefined, ...(timeoutMs ? { timeoutMs } : {}), ...(box ? { box } : {}), ...(noWorkspaces ? { noWorkspaces: true } : {}) });
  const url = await listen(server);
  const post = (path: string, body: unknown, token = TOKEN) =>
    fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const turn = (turnId: string, callback = `${engine.url}/v1/agent-turns/${turnId}`) => ({
    turnId,
    systemPrompt: "You are Open Sourcebook's chat.",
    prompt: "hi",
    tools: [{ name: "reply", description: "Ends the turn.", inputSchema: { type: "object" } }],
    callback: { url: callback, token: "turn-token" },
  });
  const close = () => {
    server.close();
    engine.server.close();
  };
  return { url, post, turn, engine, close };
}

test("runs a turn: the agent sees the engine's tools, calls are forwarded with the turn's token, the end is reported", async () => {
  const agent = fakeAgent(async (mcp) => {
    const init = await mcp("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(init.result.serverInfo.name, "opensourcebook");
    const listed = await mcp("tools/list");
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["reply"]);
    const called = await mcp("tools/call", { name: "reply", arguments: { parts: [] } });
    assert.deepEqual(called.result, { content: [{ type: "text", text: "ran reply" }], isError: false });
    const unknown = await mcp("tools/call", { name: "Bash", arguments: {} });
    assert.equal(unknown.result.isError, true);
    return { ok: true, text: "Hello", model: "small-1", tokensIn: 10, tokensOut: 2 };
  });
  const t = await setup(agent);
  try {
    assert.equal((await t.post("/turns", t.turn("t1"), "wrong-token-0123456789")).status, 401);
    assert.equal((await t.post("/turns", t.turn("t2", "https://example.com/v1/agent-turns/t2"))).status, 400);
    assert.equal((await t.post("/turns", t.turn("t1"))).status, 202);
    const end = await t.engine.finish;
    assert.deepEqual({ ...end, durationMs: 0 }, { outcome: "done", text: "Hello", model: "small-1", tokensIn: 10, tokensOut: 2, toolCalls: 1, durationMs: 0 });
    const tool = t.engine.calls.find((call) => call.path.endsWith("/tools"))!;
    assert.equal(tool.path, "/v1/agent-turns/t1/tools");
    assert.equal(tool.auth, "Bearer turn-token");
    assert.deepEqual(tool.body, { name: "reply", arguments: { parts: [] } });
    const [spec] = agent.specs;
    assert.equal(spec!.model, "small");
    assert.ok(!existsSync(spec!.cwd), "the turn's directory is removed");
    // The MCP route needs the turn's secret; the turn is gone now anyway.
    const stranger = await fetch(spec!.mcp.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(stranger.status, 401);
  } finally {
    t.close();
  }
});

test("sends the newest unfinished input of a tool the engine asked to see, numbered by the calls before it", async () => {
  const agent = fakeAgent(async (mcp, spec) => {
    assert.ok(spec.onDraft, "drafts asked for");
    spec.onDraft!("reply", '{"blocks": [');
    spec.onDraft!("Bash", "{}");
    spec.onDraft!("reply", '{"blocks": [{"kind": "paragraph", "text": "Hi');
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A draft still waiting when its call comes is dropped: the call says it all.
    spec.onDraft!("reply", '{"blocks": [{"kind": "paragraph", "text": "Hi there"}]');
    await mcp("tools/call", { name: "reply", arguments: { blocks: [] } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { ok: true };
  });
  const t = await setup(agent);
  try {
    assert.equal((await t.post("/turns", { ...t.turn("t1"), drafts: ["reply", "nope"] })).status, 202);
    await t.engine.finish;
    const drafts = t.engine.calls.filter((call) => call.path.endsWith("/draft"));
    assert.deepEqual(
      drafts.map((call) => call.body),
      [{ tool: "reply", input: '{"blocks": [{"kind": "paragraph", "text": "Hi', calls: 0 }],
    );
    assert.equal(drafts[0]!.auth, "Bearer turn-token");
  } finally {
    t.close();
  }
});

test("a stopped turn and a turn out of time are reported as such", async () => {
  const agent = fakeAgent(() => new Promise<TurnEnd>(() => undefined));
  const t = await setup(agent, 1_000);
  try {
    await t.post("/turns", t.turn("slow"));
    assert.deepEqual(await (await t.post("/turns/slow/stop", {})).json(), { ok: true });
    assert.equal((await t.engine.finish).problem, "stopped");
  } finally {
    t.close();
  }
  const late = await setup(fakeAgent(() => new Promise<TurnEnd>(() => undefined)), 1_000);
  try {
    await late.post("/turns", { ...late.turn("late"), timeoutMs: 1_000 });
    assert.equal((await late.engine.finish).problem, "timedOut");
  } finally {
    late.close();
  }
});

test("says whether a turn still runs here, so the engine can tell a dropped turn", async () => {
  const agent = fakeAgent(() => new Promise<TurnEnd>(() => undefined));
  const t = await setup(agent);
  const running = async (id: string, token = TOKEN) => fetch(`${t.url}/turns/${id}`, { headers: { authorization: `Bearer ${token}` } });
  try {
    await t.post("/turns", t.turn("long"));
    assert.deepEqual(await (await running("long")).json(), { running: true });
    assert.deepEqual(await (await running("other")).json(), { running: false });
    assert.equal((await running("long", "wrong-token-0123456789")).status, 401);
    await t.post("/turns/long/stop", {});
    await t.engine.finish;
    assert.deepEqual(await (await running("long")).json(), { running: false });
  } finally {
    t.close();
  }
});

test("status lists the agents without any credential", async () => {
  const t = await setup(fakeAgent(async () => ({ ok: true })));
  try {
    const status = await (await fetch(`${t.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.deepEqual(status, { agent: "fake", model: "small", agents: [{ id: "fake", label: "Fake agent", installed: true, version: "1.0", signedIn: true, workspace: false }], running: 0 });
    assert.equal((await fetch(`${t.url}/status`)).status, 401);
  } finally {
    t.close();
  }
});

test("every registered agent says where it is installed from, and status passes that on with its sign-in command", async () => {
  for (const agent of createDefaultAgents().list()) {
    assert.ok(agent.install, agent.id);
    assert.match(agent.install.url, /^https:\/\/[^\s]+$/, agent.id);
    if (agent.install.command !== undefined) assert.ok(agent.install.command.trim() && !agent.install.command.includes("\n"), agent.id);
    assert.ok(agent.signIn, agent.id);
  }
  const agent = { ...fakeAgent(async () => ({ ok: true })), signIn: "fake login", install: { command: "get fake", url: "https://example.com/fake" } };
  const t = await setup(agent);
  try {
    const status = await (await fetch(`${t.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.deepEqual([status.agents[0].signIn, status.agents[0].install], ["fake login", { command: "get fake", url: "https://example.com/fake" }]);
  } finally {
    t.close();
  }
});

test("with no OPENSOURCEBOOK_AGENT the connector prefers no agent: status names none, and a turn that names none is refused", async () => {
  const agent = fakeAgent(async () => ({ ok: true }));
  const engine = await fakeEngine();
  const { server } = createConnector({ token: TOKEN, agents: new AgentRegistry().register(agent), defaults: {}, log: () => undefined });
  const url = await listen(server);
  const post = (body: unknown) => fetch(`${url}/turns`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const turn = (turnId: string) => ({ turnId, systemPrompt: "s", prompt: "hi", tools: [], callback: { url: `${engine.url}/v1/agent-turns/${turnId}`, token: "turn-token" } });
  try {
    const status = await (await fetch(`${url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal("agent" in status, false);
    assert.equal("model" in status, false);
    assert.deepEqual(status.agents.map((one: { id: string }) => one.id), ["fake"]);
    const refused = await post(turn("a"));
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).problem, "agentMissing");
    assert.equal(agent.specs.length, 0);
    assert.equal((await post({ ...turn("b"), agent: "fake" })).status, 202);
    assert.equal(agent.specs.length, 1);
  } finally {
    server.close();
    engine.server.close();
  }
});

test("status lists the models and efforts each agent offers, and a picked agent that is not the default runs on its own default model", async () => {
  const main = fakeAgent(async () => ({ ok: true }));
  const other = { ...fakeAgent(async () => ({ ok: true })), id: "other", label: "Other agent", models: [{ id: "big", label: "Big" }], efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] };
  const engine = await fakeEngine();
  const { server } = createConnector({ token: TOKEN, agents: new AgentRegistry().register(main).register(other), defaults: { agent: "fake", model: "small", effort: "low" }, log: () => undefined });
  const url = await listen(server);
  const post = (body: unknown) => fetch(`${url}/turns`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const turn = (turnId: string) => ({ turnId, systemPrompt: "s", prompt: "hi", tools: [], callback: { url: `${engine.url}/v1/agent-turns/${turnId}`, token: "turn-token" } });
  try {
    const status = await (await fetch(`${url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(status.effort, "low");
    assert.deepEqual(status.agents.map((agent: { id: string; models?: unknown; efforts?: unknown }) => [agent.id, agent.models, agent.efforts]), [
      ["fake", undefined, undefined],
      ["other", [{ id: "big", label: "Big" }], [{ id: "low", label: "Low" }, { id: "high", label: "High" }]],
    ]);
    // ?fresh=1 asks each agent again instead of answering from the last check.
    const asked = main.infos;
    await fetch(`${url}/status?fresh=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(main.infos, asked + 1);
    assert.equal((await post({ ...turn("a"), agent: "other" })).status, 202);
    assert.equal((await post({ ...turn("b"), agent: "other", model: "big", effort: "high" })).status, 202);
    assert.equal((await post(turn("c"))).status, 202);
    assert.deepEqual(other.specs.map((spec) => [spec.model, spec.effort]), [
      [undefined, undefined],
      ["big", "high"],
    ]);
    assert.deepEqual(main.specs.map((spec) => [spec.model, spec.effort]), [["small", "low"]]);
  } finally {
    server.close();
    engine.server.close();
  }
});

test("with no model named, each agent runs on its own: the adapter's model for the kind of turn, else none passed, never another agent's", async () => {
  const main = { ...fakeAgent(async () => ({ ok: true })), defaultModels: { chat: "quick", work: "steady" }, defaultEfforts: { chat: "low", work: "high" }, replacesWorkPrompt: true };
  const plain = { ...fakeAgent(async () => ({ ok: true })), id: "plain", label: "Plain agent" };
  const engine = await fakeEngine();
  const { server } = createConnector({ token: TOKEN, agents: new AgentRegistry().register(main).register(plain), defaults: { agent: "fake", effort: "medium" }, log: () => undefined });
  const url = await listen(server);
  const post = (body: unknown) => fetch(`${url}/turns`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const turn = (turnId: string) => ({ turnId, systemPrompt: "s", prompt: "hi", tools: [], callback: { url: `${engine.url}/v1/agent-turns/${turnId}`, token: "turn-token" } });
  try {
    const status = await (await fetch(`${url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    // The connector's chat model is its agent's own, and each agent says its own defaults.
    assert.equal(status.model, "quick");
    assert.equal(status.effort, "medium");
    assert.deepEqual(status.agents.map((agent: { id: string; defaultModels?: unknown; defaultEfforts?: unknown; replacesWorkPrompt?: boolean }) => [agent.id, agent.defaultModels, agent.defaultEfforts, agent.replacesWorkPrompt]), [
      ["fake", { chat: "quick", work: "steady" }, { chat: "low", work: "high" }, true],
      ["plain", undefined, undefined, undefined],
    ]);
    const mainStarts: unknown[] = [];
    for (const [id, body] of [["a", {}], ["b", { kind: "work" }], ["c", { kind: "work", model: "named" }]] as const) {
      const reply = await post({ ...turn(id), ...body });
      assert.equal(reply.status, 202);
      mainStarts.push(await reply.json());
    }
    const plainStarts: unknown[] = [];
    for (const [id, body] of [["d", { agent: "plain" }], ["e", { agent: "plain", kind: "work" }]] as const) {
      const reply = await post({ ...turn(id), ...body });
      assert.equal(reply.status, 202);
      plainStarts.push(await reply.json());
    }
    assert.deepEqual(mainStarts, [
      { ok: true, agent: "fake", model: "quick", effort: "medium", workspace: false },
      { ok: true, agent: "fake", model: "steady", effort: "high", workspace: false },
      { ok: true, agent: "fake", model: "named", effort: "high", workspace: false },
    ]);
    assert.deepEqual(plainStarts, [
      { ok: true, agent: "plain", workspace: false },
      { ok: true, agent: "plain", workspace: false },
    ]);
    assert.deepEqual(main.specs.map((spec) => [spec.model, spec.effort]), [["quick", "medium"], ["steady", "high"], ["named", "high"]]);
    // An agent with no defaults of its own gets no model or effort: it runs on its own defaults.
    assert.deepEqual(plain.specs.map((spec) => [spec.model, spec.effort]), [[undefined, undefined], [undefined, undefined]]);
  } finally {
    server.close();
    engine.server.close();
  }
});

test("work turns report the resolved effort back on the finish callback", async () => {
  const agent = {
    ...fakeAgent(async () => ({ ok: true })),
    defaultModels: { chat: "quick", work: "steady" },
    defaultEfforts: { work: "high" },
  };
  const t = await setup(agent);
  try {
    const started = await t.post("/turns", { ...t.turn("w1"), kind: "work" });
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { ok: true, agent: "fake", model: "steady", effort: "high", workspace: false });
    const end = await t.engine.finish;
    assert.equal(end.effort, "high");
  } finally {
    t.close();
  }
});

test("turnModel: the person's chat model is for chat only; a piece of work takes the adapter's, or none", () => {
  const agent = { ...fakeAgent(async () => ({ ok: true })), defaultModels: { chat: "quick", work: "steady" } };
  assert.equal(turnModel(agent, {}, "theirs"), "theirs");
  assert.equal(turnModel(agent, {}), "quick");
  assert.equal(turnModel(agent, { kind: "work" }, "theirs"), "steady");
  assert.equal(turnModel(fakeAgent(async () => ({ ok: true })), { kind: "work" }, "theirs"), undefined);
  assert.equal(turnModel(agent, { kind: "work", model: "named" }), "named");
});

test("turnEffort: the person's chat effort does not carry into a piece of work", () => {
  const agent = { ...fakeAgent(async () => ({ ok: true })), defaultEfforts: { chat: "low", work: "high" } };
  assert.equal(turnEffort(agent, {}, "medium"), "medium");
  assert.equal(turnEffort(agent, {}), "low");
  assert.equal(turnEffort(agent, { kind: "work" }, "medium"), "high");
  assert.equal(turnEffort(fakeAgent(async () => ({ ok: true })), { kind: "work" }, "medium"), undefined);
  assert.equal(turnEffort(agent, { kind: "work", effort: "max" }, "medium"), "max");
});

test("a tool may answer with pictures: the agent gets them as image blocks after the words, and the caller's instructions", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const agent = fakeAgent(async (mcp) => {
    const init = await mcp("initialize", {});
    assert.equal(init.result.instructions, "Write the video's scenes. End with finish.");
    const called = await mcp("tools/call", { name: "look", arguments: { scene: "s1" } });
    assert.deepEqual(called.result, {
      content: [
        { type: "text", text: "two stills" },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: png, mimeType: "image/jpeg" },
      ],
      isError: false,
    });
    return { ok: true };
  });
  const answer = () => ({
    text: "two stills",
    images: [
      { mimeType: "image/png", dataBase64: png },
      { mimeType: "image/jpeg", dataBase64: png },
      // Not a picture an agent can see, and not base64: both dropped.
      { mimeType: "application/pdf", dataBase64: png },
      { mimeType: "image/png", dataBase64: "not base64!" },
    ],
  });
  const t = await setup(agent, undefined, answer);
  try {
    const body = { ...t.turn("pics"), tools: [{ name: "look", description: "Stills.", inputSchema: { type: "object" } }], instructions: "Write the video's scenes. End with finish." };
    assert.equal((await t.post("/turns", body)).status, 202);
    assert.equal((await t.engine.finish).outcome, "done");
  } finally {
    t.close();
  }
});

test("a chat turn is told the chat's instructions when the caller says nothing", async () => {
  const agent = fakeAgent(async (mcp) => {
    const init = await mcp("initialize", {});
    assert.match(init.result.instructions, /reply tool/);
    return { ok: true };
  });
  const t = await setup(agent);
  try {
    await t.post("/turns", t.turn("chat"));
    assert.equal((await t.engine.finish).outcome, "done");
  } finally {
    t.close();
  }
});

test("a turn may ask for up to 45 minutes; the default and the chat's 10 minutes are unchanged", () => {
  assert.equal(turnTimeoutMs(undefined), 180_000);
  assert.equal(turnTimeoutMs(undefined, 240_000), 240_000);
  assert.equal(turnTimeoutMs(600_000), 600_000);
  assert.equal(turnTimeoutMs(30 * 60_000), 30 * 60_000);
  assert.equal(turnTimeoutMs(5 * 60 * 60_000), MAX_TIMEOUT_MS);
  assert.equal(MAX_TIMEOUT_MS, 45 * 60_000);
  // 0 asks for no limit: the turn runs until it ends or is stopped.
  assert.equal(turnTimeoutMs(0), undefined);
});

test("only pictures an agent can see pass, at most eight", () => {
  const ok = { mimeType: "image/webp", dataBase64: "AAAA" };
  assert.deepEqual(readImages(undefined), []);
  assert.deepEqual(readImages([ok, { mimeType: "image/svg+xml", dataBase64: "AAAA" }, "x", null]), [ok]);
  assert.equal(readImages(Array.from({ length: 12 }, () => ok)).length, 8);
});

test("the scenes service's token starts turns only in its own folders, sees and stops only its own turns, and opens nothing else; the full token still opens everything", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-scenes-")));
  const root = join(base, "repo", "services", "scenes", ".data");
  const inside = join(root, "job1", "work");
  const outside = join(base, "elsewhere", "work");
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const SCENES = "scenes-token-0123456789";
  const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
  // Turns that run until they are stopped.
  const agent = { ...fakeAgent(() => new Promise<TurnEnd>(() => undefined)), boxing: { note: "boxed", unready: () => undefined } };
  const engine = await fakeEngine();
  // The root is named through a link, as a caller may; it is compared by its real path.
  symlinkSync(root, join(base, "root-link"));
  const { server } = createConnector({ token: TOKEN, scenes: { token: SCENES, roots: [join(base, "root-link")] }, agents: new AgentRegistry().register(agent), defaults: { agent: "fake" }, box, log: () => undefined });
  const url = await listen(server);
  const call = (method: string, path: string, token: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const turn = (turnId: string, path?: string) => ({ turnId, systemPrompt: "s", prompt: "p", tools: [], callback: { url: `${engine.url}/v1/agent-turns/${turnId}`, token: "t" }, ...(path ? { workspace: { path } } : {}) });
  try {
    assert.equal((await call("GET", "/status", SCENES)).status, 200);
    assert.equal((await call("POST", "/turns", SCENES, turn("s1", inside))).status, 202, "inside its folders");
    assert.equal((await call("POST", "/turns", SCENES, turn("s2"))).status, 202, "with no work folder");
    const refused = await call("POST", "/turns", SCENES, turn("s3", outside));
    assert.equal(refused.status, 403, "outside its folders");
    assert.match((await refused.json()).message, /scenes service's own folders/);
    assert.equal((await call("POST", "/turns", SCENES, turn("s4", root))).status, 403, "not the root itself");
    assert.equal((await call("POST", "/turns", SCENES, turn("s5", join(inside, "..", "..", "..", "..", "..", "elsewhere", "work")))).status, 403, "not by climbing out");
    assert.equal((await call("POST", "/agents/fake/probe", SCENES, {})).status, 403, "no other route");
    assert.equal((await call("GET", "/nope", SCENES)).status, 403);
    // The engine's turn, with the full token, anywhere a work folder may be.
    assert.equal((await call("POST", "/turns", TOKEN, turn("e1", outside))).status, 202, "the full token still works");
    assert.deepEqual(await (await call("GET", "/turns/e1", SCENES)).json(), { running: false }, "not its turn");
    assert.deepEqual(await (await call("POST", "/turns/e1/stop", SCENES, {})).json(), { ok: false });
    assert.deepEqual(await (await call("GET", "/turns/e1", TOKEN)).json(), { running: true }, "still running");
    assert.deepEqual(await (await call("GET", "/turns/s1", SCENES)).json(), { running: true });
    assert.deepEqual(await (await call("POST", "/turns/s1/stop", SCENES, {})).json(), { ok: true }, "its own turn");
    assert.equal((await call("GET", "/status", "wrong-token-0123456789")).status, 401);
    for (const id of ["e1", "s2"]) await call("POST", `/turns/${id}/stop`, TOKEN, {});
  } finally {
    server.close();
    engine.server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("on an installed copy the scenes service's turns start in its folder under ~/.opensourcebook, and a refused folder says why", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-home-")));
  const root = join(home, ".opensourcebook", "app", "services", "scenes", ".data");
  const inside = join(root, "job1", "work");
  const other = join(home, ".opensourcebook", "app", "elsewhere", "work");
  const settings = join(home, ".ssh", "work");
  for (const dir of [inside, other, settings]) mkdirSync(dir, { recursive: true });
  const SCENES = "scenes-token-0123456789";
  const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
  const agent = { ...fakeAgent(() => new Promise<TurnEnd>(() => undefined)), boxing: { note: "boxed", unready: () => undefined } };
  const engine = await fakeEngine();
  const { server } = createConnector({ token: TOKEN, scenes: { token: SCENES, roots: [root] }, agents: new AgentRegistry().register(agent), defaults: { agent: "fake" }, box, home, log: () => undefined });
  const url = await listen(server);
  const call = (path: string, token: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const turn = (turnId: string, path: string) => ({ turnId, systemPrompt: "s", prompt: "p", tools: [], callback: { url: `${engine.url}/v1/agent-turns/${turnId}`, token: "t" }, workspace: { path } });
  try {
    const started = await call("/turns", SCENES, turn("s1", inside));
    assert.equal(started.status, 202, "the video's work folder");
    assert.equal((await started.json()).workspace, true);
    assert.equal(agent.specs[0]!.cwd, inside);
    const elsewhere = await call("/turns", SCENES, turn("s2", other));
    assert.equal(elsewhere.status, 403);
    assert.match((await elsewhere.json()).message, /\.opensourcebook at the top of the home folder/, "the real reason, not only that it is outside the service's folders");
    const ssh = await call("/turns", TOKEN, turn("e1", settings));
    assert.equal(ssh.status, 400, "the full token neither");
    assert.match((await ssh.json()).message, /own settings/);
    await call("/turns/s1/stop", TOKEN, {});
  } finally {
    server.close();
    engine.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a boxed turn gets a temporary folder of its own, 0700, removed when the turn ends", async () => {
  const work = mkdtempSync(join(tmpdir(), "opensourcebook-work-"));
  const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
  let during: { exists: boolean; mode: number } | undefined;
  const boxable = { ...fakeAgent(async (_mcp, spec) => {
    const tmp = spec.workspace!.tmp!;
    during = { exists: existsSync(tmp), mode: statSync(tmp).mode & 0o777 };
    return { ok: true };
  }), boxing: { note: "boxed", unready: () => undefined } };
  const t = await setup(boxable, undefined, undefined, box);
  try {
    assert.equal((await t.post("/turns", { ...t.turn("tmp1"), workspace: { path: work } })).status, 202);
    await t.engine.finish;
    const tmp = boxable.specs[0]!.workspace!.tmp!;
    // Windows has no such modes; there the folder is the user's own by its place in their temporary folder.
    assert.deepEqual(during, { exists: true, mode: process.platform === "win32" ? during!.mode : 0o700 });
    assert.ok(tmp.startsWith(join(realpathSync(tmpdir()), "opensourcebook-box-tmp-")), "in this user's temporary folder, by its real path");
    assert.ok(!tmp.startsWith(realpathSync(work)), "not in the work folder");
    assert.ok(!existsSync(tmp), "removed with the turn");
  } finally {
    t.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("a turn that asks for a workspace runs there with the box only where there is one, and the folder is kept", async () => {
  const work = mkdtempSync(join(tmpdir(), "opensourcebook-work-"));
  const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
  let why: string | undefined;
  const boxable = { ...fakeAgent(async () => ({ ok: true })), boxing: { note: "boxed", unready: () => why } };
  const t = await setup(boxable, undefined, undefined, box);
  try {
    const started = await (await t.post("/turns", { ...t.turn("w1"), workspace: { path: work } })).json();
    assert.deepEqual(started, { ok: true, agent: "fake", model: "small", workspace: true, access: "full" });
    await t.engine.finish;
    const spec = boxable.specs[0]!;
    assert.equal(spec.cwd, realpathSync(work));
    assert.equal(spec.workspace?.box, box);
    assert.equal(spec.workspace?.connectorPort, Number(new URL(t.url).port));
    assert.ok(existsSync(work), "the caller's folder is kept");
    const refused = await t.post("/turns", { ...t.turn("w2"), workspace: { path: "/" } });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).message, /folder of its own/);
    const status = await (await fetch(`${t.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(status.agents[0].workspace, true);
  } finally {
    t.close();
  }
  // Not ready for the box (e.g. no API key for it): the turn runs with its own tools off, and status says why.
  why = "no key";
  const v = await setup(boxable, undefined, undefined, box);
  try {
    const unready = await (await v.post("/turns", { ...v.turn("w4"), workspace: { path: work } })).json();
    assert.deepEqual(unready, { ok: true, agent: "fake", model: "small", workspace: false });
    const status = await (await fetch(`${v.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(status.agents[0].workspace, false);
    assert.equal(status.agents[0].workspaceUnavailable, "no key");
  } finally {
    v.close();
  }
  const plain = fakeAgent(async () => ({ ok: true }));
  const u = await setup(plain);
  try {
    const started = await (await u.post("/turns", { ...u.turn("w3"), workspace: { path: work } })).json();
    assert.deepEqual(started, { ok: true, agent: "fake", model: "small", workspace: false }, "no box: own tools stay off");
    await u.engine.finish;
    assert.equal(plain.specs[0]!.workspace, undefined);
    assert.notEqual(plain.specs[0]!.cwd, realpathSync(work));
  } finally {
    u.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("an agent that can work with its file tools only gets that workspace on its own login, boxed where there is a box, and status says so", async () => {
  const work = mkdtempSync(join(tmpdir(), "opensourcebook-work-"));
  const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
  const status = async (t: Awaited<ReturnType<typeof setup>>) => (await (await fetch(`${t.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).agents[0];
  const agent = () => ({ ...fakeAgent(async () => ({ ok: true })), filesOnly: { note: "its file tools only" }, boxing: { note: "everything", unready: () => "no key" } });
  const boxed = agent();
  const t = await setup(boxed, undefined, undefined, box);
  try {
    assert.deepEqual(await (await t.post("/turns", { ...t.turn("f1"), workspace: { path: work } })).json(), { ok: true, agent: "fake", model: "small", workspace: true, access: "files" });
    await t.engine.finish;
    const spec = boxed.specs[0]!;
    assert.equal(spec.cwd, realpathSync(work));
    assert.equal(spec.workspace?.access, "files");
    assert.equal(spec.workspace?.box, box, "the box as a second wall");
    assert.equal(spec.workspace?.model, undefined, "no model calls through the connector: its own login");
    const s = await status(t);
    assert.deepEqual([s.workspace, s.workspaceAccess, s.workspaceNote, s.workspaceUnavailable], [true, "files", "its file tools only", "no key"]);
  } finally {
    t.close();
  }
  const bare = agent();
  const u = await setup(bare);
  try {
    assert.deepEqual(await (await u.post("/turns", { ...u.turn("f2"), workspace: { path: work } })).json(), { ok: true, agent: "fake", model: "small", workspace: true, access: "files" }, "no box: its own rules are the wall");
    await u.engine.finish;
    assert.equal(bare.specs[0]!.workspace?.box, undefined);
  } finally {
    u.close();
  }
  const off = agent();
  const v = await setup(off, undefined, undefined, undefined, true);
  try {
    assert.deepEqual(await (await v.post("/turns", { ...v.turn("f3"), workspace: { path: work } })).json(), { ok: true, agent: "fake", model: "small", workspace: false }, "workspaces off: none");
    assert.equal((await status(v)).workspace, false);
  } finally {
    v.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("a boxed turn's model calls go through the connector, which adds the person's API key; the agent never holds it", async () => {
  // The provider: records what reaches it, and streams its answer back in two pieces.
  const seen: Array<{ method: string; url: string; authorization?: string; apiKey?: string; beta?: string; body: string }> = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"] as string, beta: request.headers["anthropic-beta"] as string, body });
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
    response.write("event: one\n\n");
    setTimeout(() => response.end("event: two\n\n"), 20);
  });
  const providerUrl = await listen(provider);
  const work = mkdtempSync(join(tmpdir(), "opensourcebook-work-"));
  const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
  let checks: Record<string, unknown> = {};
  let model: { baseUrl: string; secret: string } | undefined;
  const boxable = {
    ...fakeAgent(async (_mcp, spec) => {
      model = spec.workspace!.model!;
      const call = (path: string, secret: string, init: RequestInit = {}) => fetch(`${model!.baseUrl}${path}`, { method: "POST", ...init, headers: { authorization: `Bearer ${secret}`, "anthropic-beta": "some-beta-2025", "x-api-key": "what-the-agent-sent", "content-type": "application/json", ...(init.headers ?? {}) } });
      const answer = await call("/v1/messages?beta=true", model.secret, { body: '{"model":"m","stream":true}' });
      checks = {
        status: answer.status,
        body: await answer.text(),
        requestId: answer.headers.get("request-id"),
        wrongSecret: (await call("/v1/messages", "nope")).status,
        notAModelCall: (await call("/v1/files", model.secret)).status,
        hello: (await fetch(`${model.baseUrl}/api/hello`, { method: "HEAD" })).status,
      };
      return { ok: true };
    }),
    boxing: { note: "boxed", unready: () => undefined, upstream: () => ({ origin: providerUrl, headers: { "x-api-key": "the-persons-api-key" }, allows: (method: string, path: string) => method === "POST" && path === "/v1/messages" }) },
  };
  const t = await setup(boxable, undefined, undefined, box);
  try {
    assert.deepEqual(await (await t.post("/turns", { ...t.turn("m1"), workspace: { path: work } })).json(), { ok: true, agent: "fake", model: "small", workspace: true, access: "full" });
    await t.engine.finish;
    assert.ok(model && model.baseUrl.endsWith("/model/m1") && model.secret.length >= 32, "the agent gets the connector's address and a secret of its own");
    assert.notEqual(model.secret, "the-persons-api-key");
    assert.deepEqual(checks, { status: 200, body: "event: one\n\nevent: two\n\n", requestId: "req_1", wrongSecret: 401, notAModelCall: 403, hello: 200 });
    assert.equal(seen.length, 1, "only the signed model call reached the provider");
    assert.deepEqual(seen[0], { method: "POST", url: "/v1/messages?beta=true", authorization: undefined, apiKey: "the-persons-api-key", beta: "some-beta-2025", body: '{"model":"m","stream":true}' });
    // Once the turn is over its secret opens nothing.
    const after = await fetch(`${model.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${model.secret}` }, body: "{}" });
    assert.equal(after.status, 401);
  } finally {
    t.close();
    provider.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("a boxed turn's secret also works as a Google API key header, and no key the agent sent, in a header or the address, is passed on", async () => {
  const seen: Array<{ url: string; googKey?: string }> = [];
  const provider = createServer(async (request, response) => {
    for await (const _ of request) void _;
    seen.push({ url: request.url!, googKey: request.headers["x-goog-api-key"] as string });
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const providerUrl = await listen(provider);
  const work = mkdtempSync(join(tmpdir(), "opensourcebook-work-"));
  const box: Box = { kind: "seatbelt", wrap: (bin, args) => ({ bin, args }) };
  let checks: Record<string, unknown> = {};
  const boxable = {
    ...fakeAgent(async (_mcp, spec) => {
      const model = spec.workspace!.model!;
      const call = (secret: string) => fetch(`${model.baseUrl}/v1beta/models/m:streamGenerateContent?alt=sse&key=${secret}`, { method: "POST", headers: { "x-goog-api-key": secret, "content-type": "application/json" }, body: "{}" });
      checks = { ok: (await call(model.secret)).status, wrong: (await call("nope")).status };
      return { ok: true };
    }),
    boxing: { note: "boxed", unready: () => undefined, upstream: () => ({ origin: providerUrl, headers: { "x-goog-api-key": "the-persons-api-key" }, allows: (method: string, path: string) => method === "POST" && path.startsWith("/v1beta/models/") }) },
  };
  const t = await setup(boxable, undefined, undefined, box);
  try {
    assert.equal((await t.post("/turns", { ...t.turn("g1"), workspace: { path: work } })).status, 202);
    await t.engine.finish;
    assert.deepEqual(checks, { ok: 200, wrong: 401 });
    assert.deepEqual(seen, [{ url: "/v1beta/models/m:streamGenerateContent?alt=sse", googKey: "the-persons-api-key" }]);
  } finally {
    t.close();
    provider.close();
    rmSync(work, { recursive: true, force: true });
  }
});

/** Waits for the end the connector reports for `turnId`. */
async function finishOf(engine: { calls: Array<{ path: string; body: any }> }, turnId: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const call = engine.calls.find((c) => c.path === `/v1/agent-turns/${turnId}/finish`);
    if (call) return call.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no end reported for ${turnId}`);
}

/** An agent whose turns end as `ends` says, one after the other (the last again after that). */
function endsWith(...ends: TurnEnd[]) {
  let n = 0;
  return fakeAgent(async () => ends[Math.min(n++, ends.length - 1)]!);
}

const statusOf = async (url: string) => (await (await fetch(`${url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any;

test("a turn the agent itself ends in an error says so with its own words and how many tools it called; a stop from here carries none", async () => {
  const agent = endsWith({ ok: false, problem: "error", said: "The model asked for is not supported on this account.", detail: "exit 1; log text" });
  const t = await setup(agent);
  try {
    assert.equal((await t.post("/turns", t.turn("e1"))).status, 202);
    const end = await finishOf(t.engine, "e1");
    assert.deepEqual({ ...end, durationMs: 0 }, { outcome: "failed", problem: "error", said: "The model asked for is not supported on this account.", toolCalls: 0, durationMs: 0 });
    assert.ok(!JSON.stringify(end).includes("log text"), "the log's detail stays in the connector's log");
  } finally {
    t.close();
  }
});

test("a turn out of usage tells the engine when it resets; status shows the limit until a turn of that agent ends well", async () => {
  const limit: TurnEnd = { ok: false, problem: "agentLimit", limit: { resets: "3pm (Europe/Berlin)" } };
  const agent = endsWith(limit, { ok: true, text: "Hello" }, limit, { ok: true });
  const t = await setup(agent);
  try {
    assert.equal((await statusOf(t.url)).agents[0].limit, undefined);
    assert.equal((await t.post("/turns", t.turn("t1"))).status, 202);
    const end = await finishOf(t.engine, "t1");
    assert.deepEqual({ ...end, durationMs: 0 }, { outcome: "failed", problem: "agentLimit", limit: { resets: "3pm (Europe/Berlin)" }, toolCalls: 0, durationMs: 0 });
    // Status is kept for a while, but the limit is always as it is now.
    const limited = (await statusOf(t.url)).agents[0].limit;
    assert.equal(limited.resets, "3pm (Europe/Berlin)");
    assert.ok(Date.parse(limited.since) <= Date.now());
    assert.equal(limited.resetsAt, undefined);
    // Without a known reset time a turn is still tried.
    assert.equal((await t.post("/turns", t.turn("t2"))).status, 202);
    assert.equal((await finishOf(t.engine, "t2")).outcome, "done");
    assert.equal((await statusOf(t.url)).agents[0].limit, undefined);
    // A check that answers forgets a limit too.
    await t.post("/turns", t.turn("t3"));
    await finishOf(t.engine, "t3");
    assert.ok((await statusOf(t.url)).agents[0].limit);
    assert.deepEqual(await (await t.post("/agents/fake/probe", {})).json(), { ok: true });
    assert.equal((await statusOf(t.url)).agents[0].limit, undefined);
  } finally {
    t.close();
  }
});

test("while a known reset time is ahead, a turn is refused at once and a check runs nothing; once it passes, both go ahead", async () => {
  const resetsAt = new Date(Date.now() + 1_500).toISOString();
  const agent = endsWith({ ok: false, problem: "agentLimit", limit: { resetsAt } }, { ok: true });
  const t = await setup(agent);
  try {
    await t.post("/turns", t.turn("t1"));
    assert.deepEqual((await finishOf(t.engine, "t1")).limit, { resetsAt });
    const refused = await t.post("/turns", t.turn("t2"));
    assert.equal(refused.status, 429);
    const body = (await refused.json()) as any;
    assert.equal(body.problem, "agentLimit");
    assert.match(body.message, /^Fake agent has used up its plan's usage for now; it said it resets at /);
    assert.equal(body.limit.resetsAt, resetsAt);
    assert.ok(body.limit.since);
    const probed = (await (await t.post("/agents/fake/probe", {})).json()) as any;
    assert.deepEqual(probed, { ok: false, problem: "agentLimit", limit: body.limit });
    assert.equal(agent.specs.length, 1, "neither the refused turn nor the check ran the agent");
    assert.equal((await t.post("/agents/nope/probe", {})).status, 404);
    assert.equal((await t.post("/agents/fake/probe", {}, "wrong-token-0123456789")).status, 401);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    assert.equal((await statusOf(t.url)).agents[0].limit, undefined, "a reset time that passed is gone");
    assert.equal((await t.post("/turns", t.turn("t3"))).status, 202);
    assert.equal((await finishOf(t.engine, "t3")).outcome, "done");
  } finally {
    t.close();
  }
});

test("a check runs the smallest turn: no tools, the agent's own default model, an empty folder; two at once run one turn", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const listed: unknown[] = [];
  const agent = fakeAgent(async (mcp) => {
    listed.push((await mcp("tools/list")).result.tools);
    await gate;
    return { ok: true, text: "ok" };
  });
  const t = await setup(agent);
  try {
    const first = t.post("/agents/fake/probe", {});
    const second = t.post("/agents/fake/probe", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    assert.deepEqual(await (await first).json(), { ok: true });
    assert.deepEqual(await (await second).json(), { ok: true });
    assert.equal(agent.specs.length, 1, "one turn for both");
    const [spec] = agent.specs;
    assert.equal(spec!.prompt, "Reply with the single word ok.");
    assert.equal(spec!.model, undefined, "its own default, not the connector's");
    assert.equal(spec!.effort, undefined);
    assert.equal(spec!.workspace, undefined);
    assert.deepEqual(listed, [[]], "none of Open Sourcebook's tools");
    assert.ok(!existsSync(spec!.cwd), "its folder is removed");
    assert.equal(t.engine.calls.length, 0, "a check tells the engine nothing");
    assert.deepEqual(await (await t.post("/agents/fake/probe", {})).json(), { ok: true }, "a later check runs again");
    assert.equal(agent.specs.length, 2);
  } finally {
    t.close();
  }
});

test("a check of Claude Code that is out of usage remembers when it resets; the next check and turn wait for it; one that answers says ok", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
  const limited = fakeCli([{ args: "-p", out: claudeLimited("You've hit your limit · resets 3pm (Europe/Berlin)", resetsAt), code: 1 }]);
  const t = await setup(claudeAdapter({ bin: limited.bin }));
  try {
    const probed = (await (await t.post("/agents/claude/probe", {})).json()) as any;
    assert.equal(probed.ok, false);
    assert.equal(probed.problem, "agentLimit");
    assert.equal(probed.limit.resetsAt, new Date(resetsAt * 1000).toISOString());
    assert.equal(probed.limit.resets, "3pm (Europe/Berlin)");
    assert.equal(limited.calls().length, 1);
    assert.deepEqual(limited.stdins(), ["Reply with the single word ok."]);
    assert.ok(!limited.calls()[0]!.includes("--model"), "its own default model");
    assert.deepEqual(await (await t.post("/agents/claude/probe", {})).json(), probed, "not run again before the reset");
    assert.equal((await t.post("/turns", { ...t.turn("c1"), agent: "claude" })).status, 429);
    assert.equal(limited.calls().length, 1);
  } finally {
    t.close();
    limited.remove();
  }

  const answers = fakeCli([{ args: "-p", out: claudeReply("ok") }]);
  const fine = await setup(claudeAdapter({ bin: answers.bin }));
  try {
    assert.deepEqual(await (await fine.post("/agents/claude/probe", {})).json(), { ok: true });
  } finally {
    fine.close();
    answers.remove();
  }
});

test("a Claude Code turn out of usage tells the engine when it resets, as the CLI said it", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
  const cli = fakeCli([{ args: "-p", out: claudeLimited("You've hit your limit · resets 3pm (Europe/Berlin)", resetsAt), code: 1 }]);
  const t = await setup(claudeAdapter({ bin: cli.bin }));
  try {
    assert.equal((await t.post("/turns", { ...t.turn("c1"), agent: "claude" })).status, 202);
    const end = await finishOf(t.engine, "c1");
    assert.equal(end.problem, "agentLimit");
    assert.deepEqual(end.limit, { resetsAt: new Date(resetsAt * 1000).toISOString(), resets: "3pm (Europe/Berlin)" });
  } finally {
    t.close();
    cli.remove();
  }
});

test("appends one JSONL line per turn to usageLog with separate cache tokens, reported cost, nulls for unreported fields, and skips probes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-usage-log-"));
  const usageLog = join(dir, "logs", "usage.jsonl");
  let stopGate: () => void = () => undefined;
  const agent: AgentAdapter = {
    id: "fake",
    label: "Fake agent",
    async info() {
      return { installed: true, version: "1.0", signedIn: true };
    },
    run(spec) {
      let killed: (end: TurnEnd) => void = () => undefined;
      const stopped = new Promise<TurnEnd>((resolve) => (killed = resolve));
      const mcp = async (method: string, params?: unknown) =>
        (await fetch(spec.mcp.url, { method: "POST", headers: { ...spec.mcp.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      const work = async (): Promise<TurnEnd> => {
        if (spec.turnId === "t-full") {
          await mcp("tools/call", { name: "reply", arguments: {} });
          await mcp("tools/call", { name: "reply", arguments: {} });
          return { ok: true, model: "claude-opus-4-6", inputTokens: 120, tokensOut: 45, cacheReadTokens: 800, cacheWriteTokens: 200, costUsd: 0.015 };
        }
        if (spec.turnId === "t-sparse") {
          return { ok: true, tokensIn: 50, tokensOut: 10 };
        }
        if (spec.turnId === "t-fail") {
          return { ok: false, problem: "error" };
        }
        if (spec.turnId === "t-stop") {
          await new Promise<void>((resolve) => (stopGate = resolve));
          return { ok: false, problem: "stopped" };
        }
        return { ok: true, text: "ok" };
      };
      return { done: Promise.race([work(), stopped]), kill: () => killed({ ok: false, problem: "stopped" }) };
    },
  };
  const engine = await fakeEngine();
  const { server } = createConnector({
    token: TOKEN,
    agents: new AgentRegistry().register(agent),
    defaults: { agent: "fake", effort: "high" },
    log: () => undefined,
    usageLog,
  });
  const url = await listen(server);
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const turn = (turnId: string, extra: Record<string, unknown> = {}) => ({
    turnId,
    systemPrompt: "s",
    prompt: "p",
    tools: [{ name: "reply", description: "r", inputSchema: { type: "object" } }],
    callback: { url: `${engine.url}/v1/agent-turns/${turnId}`, token: "turn-token" },
    ...extra,
  });
  try {
    assert.equal((await post("/turns", turn("t-full", { target: { type: "video", id: "job-1" }, effort: "medium" }))).status, 202);
    await finishOf(engine, "t-full");

    assert.equal((await post("/turns", turn("t-sparse", { target: { type: "chat", id: "chat-1" } }))).status, 202);
    await finishOf(engine, "t-sparse");

    assert.equal((await post("/turns", turn("t-fail"))).status, 202);
    await finishOf(engine, "t-fail");

    assert.equal((await post("/turns", turn("t-stop"))).status, 202);
    await post("/turns/t-stop/stop", {});
    stopGate();
    await finishOf(engine, "t-stop");

    // Probes must not be logged to usage.jsonl.
    assert.deepEqual(await (await post("/agents/fake/probe", {})).json(), { ok: true });

    const lines = readFileSync(usageLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 4);

    assert.equal(lines[0].type, "video");
    assert.equal(lines[0].targetId, "job-1");
    assert.equal(lines[0].turnId, "t-full");
    assert.equal(lines[0].agent, "fake");
    assert.equal(lines[0].model, "claude-opus-4-6");
    assert.equal(lines[0].effort, "medium");
    assert.equal(lines[0].inputTokens, 120);
    assert.equal(lines[0].outputTokens, 45);
    assert.equal(lines[0].cacheReadTokens, 800);
    assert.equal(lines[0].cacheWriteTokens, 200);
    assert.equal(lines[0].costUsd, 0.015);
    assert.equal(lines[0].toolCalls, 2);
    assert.equal(lines[0].outcome, "done");
    assert.equal(typeof lines[0].durationMs, "number");
    assert.ok(Number.isFinite(Date.parse(lines[0].time)));

    assert.deepEqual(
      { ...lines[1], time: "T", durationMs: 0 },
      {
        time: "T",
        type: "chat",
        targetId: "chat-1",
        turnId: "t-sparse",
        agent: "fake",
        model: null,
        effort: "high",
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        durationMs: 0,
        toolCalls: 0,
        outcome: "done",
      },
    );

    assert.deepEqual(
      { ...lines[2], time: "T", durationMs: 0 },
      {
        time: "T",
        type: null,
        targetId: null,
        turnId: "t-fail",
        agent: "fake",
        model: null,
        effort: "high",
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        durationMs: 0,
        toolCalls: 0,
        outcome: "failed",
      },
    );

    assert.equal(lines[3].turnId, "t-stop");
    assert.equal(lines[3].outcome, "stopped");
  } finally {
    server.close();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a work folder's turn may read what the caller named beside it, read only and only inside the box; outside the folder around it is refused", async () => {
  const jobs = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-jobs-")));
  const job = join(jobs, "v1");
  const work = join(job, "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(job, "extracted"));
  writeFileSync(join(job, "README.md"), "note");
  const read = [join(job, "README.md"), join(job, "extracted")];
  const opened: string[][] = [];
  const box: Box = { kind: "seatbelt", wrap: (bin, args, s) => (opened.push(s.read), { bin, args }) };
  const status = async (t: Awaited<ReturnType<typeof setup>>) => (await (await fetch(`${t.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).agents[0];
  const agent = (reads?: boolean) => ({ ...fakeAgent(async () => ({ ok: true })), filesOnly: { note: "its file tools only", ...(reads ? { reads } : {}) } });
  const boxed = agent(true);
  const t = await setup(boxed, undefined, undefined, box);
  try {
    assert.equal((await status(t)).workspaceReads, true);
    assert.deepEqual(await (await t.post("/turns", { ...t.turn("r1"), workspace: { path: work, read } })).json(), { ok: true, agent: "fake", model: "small", workspace: true, access: "files", read: true });
    await t.engine.finish;
    const spec = boxed.specs[0]!;
    assert.deepEqual(spec.workspace?.reach, { write: [work], folders: [join(job, "extracted")], files: [join(job, "README.md")] });
    spec.workspace!.box!.wrap("agent", [], { workspace: work, home: "/h", read: ["/opt/agent"], write: [], connectorPort: 1 });
    assert.deepEqual(opened[0], ["/opt/agent", join(job, "extracted"), join(job, "README.md")], "the box the adapter gets opens them for it");
    const refused = await t.post("/turns", { ...t.turn("r2"), workspace: { path: work, read: [jobs] } });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).message, /folder that holds the workspace/);
  } finally {
    t.close();
  }
  const noBox = agent(true);
  const u = await setup(noBox);
  try {
    assert.equal((await status(u)).workspaceReads, undefined);
    assert.deepEqual(await (await u.post("/turns", { ...u.turn("r3"), workspace: { path: work, read } })).json(), { ok: true, agent: "fake", model: "small", workspace: true, access: "files" }, "no box: its folder alone");
    await u.engine.finish;
    assert.equal(noBox.specs[0]!.workspace?.reach, undefined);
  } finally {
    u.close();
  }
  const ownRules = agent();
  const v = await setup(ownRules, undefined, undefined, box);
  try {
    assert.equal((await status(v)).workspaceReads, undefined);
    assert.equal((await (await v.post("/turns", { ...v.turn("r4"), workspace: { path: work, read } })).json()).read, undefined, "an agent outside the box: its folder alone");
    await v.engine.finish;
    assert.equal(ownRules.specs[0]!.workspace?.reach, undefined);
  } finally {
    v.close();
    rmSync(jobs, { recursive: true, force: true });
  }
});
