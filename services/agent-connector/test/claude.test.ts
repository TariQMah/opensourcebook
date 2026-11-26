/** The Claude Code adapter's command line and its reading of the stream, without running the CLI. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { test } from "node:test";
import { CLAUDE_ON_KEY, claudeAdapter, claudeArgs, readLine, signedInFrom, ToolInputs } from "../src/agents/claude.ts";
import { agentBins, createDefaultAgents } from "../src/agents/registry.ts";
import { claudeLimited, fakeCli } from "./fake-cli.ts";

const spec = {
  turnId: "t1",
  systemPrompt: "You are Open Sourcebook's chat.",
  prompt: "hi",
  model: "haiku",
  effort: "low",
  cwd: "/tmp/opensourcebook-agent-x",
  mcp: { name: "opensourcebook", url: "http://127.0.0.1:8650/mcp/t1", headers: { Authorization: "Bearer secret" } },
};

test("boxes the agent in: no built-in tools, only Open Sourcebook's MCP server and tools, no prompts, no settings or saved session", () => {
  const args = claudeArgs(spec);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes("-p"));
  assert.equal(after("--tools"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(after("--mcp-config")!), { mcpServers: { opensourcebook: { type: "http", url: spec.mcp.url, headers: spec.mcp.headers } } });
  assert.equal(after("--allowedTools"), "mcp__opensourcebook");
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--setting-sources"), "");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(after("--system-prompt"), spec.systemPrompt);
  assert.ok(!args.includes("--append-system-prompt"));
  // A turn that keeps the agent's own instructions adds Open Sourcebook's to them instead.
  const kept = claudeArgs({ ...spec, keepAgentPrompt: true });
  assert.equal(kept[kept.indexOf("--append-system-prompt") + 1], spec.systemPrompt);
  assert.ok(!kept.includes("--system-prompt"));
  assert.equal(after("--model"), "haiku");
  assert.equal(after("--effort"), "low");
  assert.ok(!args.includes(spec.prompt), "the prompt goes on stdin");

  const fileArgs = claudeArgs(spec, "/tmp/sys.txt");
  assert.equal(fileArgs[fileArgs.indexOf("--system-prompt-file") + 1], "/tmp/sys.txt");
  assert.ok(!fileArgs.includes("--system-prompt"));
  const keptFileArgs = claudeArgs({ ...spec, keepAgentPrompt: true }, "/tmp/sys.txt");
  assert.equal(keptFileArgs[keptFileArgs.indexOf("--append-system-prompt-file") + 1], "/tmp/sys.txt");
  assert.ok(!keptFileArgs.includes("--append-system-prompt"));
});

test("reads the model, the final words, tokens and a refused rate limit from the stream", () => {
  const seen: Parameters<typeof readLine>[1] = {};
  readLine(JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" }), seen);
  readLine("not json", seen);
  readLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.0125, usage: { input_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 250, output_tokens: 40 } }), seen);
  assert.deepEqual(seen, { model: "claude-haiku-5-5", resultOk: true, text: "Done.", tokensIn: 1254, inputTokens: 4, cacheReadTokens: 1000, cacheWriteTokens: 250, tokensOut: 40, costUsd: 0.0125 });

  const limited: Parameters<typeof readLine>[1] = {};
  readLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }), limited);
  readLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit" }), limited);
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.resultOk, false);
  assert.equal(limited.tokensIn, undefined, "no usage object leaves tokens undefined");
  assert.equal(limited.costUsd, undefined);

  const firstCall: Parameters<typeof readLine>[1] = {};
  readLine(JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 25000, cache_read_input_tokens: 0 } } }), firstCall);
  readLine(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 25000 } } }), firstCall);
  assert.equal(firstCall.firstTokensIn, 25010, "keeps the first model call's input tokens");
  assert.equal(firstCall.model, "claude-sonnet-5-5", "falls back to assistant message model");

  const fromIterations: Parameters<typeof readLine>[1] = {};
  readLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 8, cache_creation_input_tokens: 12000, cache_read_input_tokens: 12000, output_tokens: 20, iterations: [{ input_tokens: 3, cache_creation_input_tokens: 12000, cache_read_input_tokens: 0 }] } }), fromIterations);
  assert.equal(fromIterations.firstTokensIn, 12003);
  assert.equal(fromIterations.tokensIn, 24008);
  assert.equal(fromIterations.inputTokens, 8);
  assert.equal(fromIterations.cacheWriteTokens, 12000);
  assert.equal(fromIterations.cacheReadTokens, 12000);
  assert.equal(fromIterations.costUsd, undefined);
});

test("hands on the input of a call to Open Sourcebook's tools while it is written, and only with drafts asked for", () => {
  assert.ok(!claudeArgs(spec).includes("--include-partial-messages"));
  assert.ok(claudeArgs({ ...spec, onDraft: () => undefined }).includes("--include-partial-messages"));
  const drafts: Array<[string, string]> = [];
  const inputs = new ToolInputs("opensourcebook", (tool, input) => drafts.push([tool, input]));
  const event = (body: unknown) => JSON.stringify({ type: "stream_event", event: body });
  const seen: Parameters<typeof readLine>[1] = {};
  readLine(event({ type: "message_start" }), seen, inputs);
  readLine(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), seen, inputs);
  readLine(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me answer." } }), seen, inputs);
  readLine(event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__opensourcebook__reply", input: {} } }), seen, inputs);
  readLine(event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"blocks": [{"kind"' } }), seen, inputs);
  readLine(event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ': "paragraph", "text": "Hi' } }), seen, inputs);
  readLine(event({ type: "content_block_stop", index: 1 }), seen, inputs);
  readLine(event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "late" } }), seen, inputs);
  readLine(event({ type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "Bash", input: {} } }), seen, inputs);
  readLine(event({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } }), seen, inputs);
  assert.deepEqual(drafts, [
    ["reply", '{"blocks": [{"kind"'],
    ["reply", '{"blocks": [{"kind": "paragraph", "text": "Hi'],
  ]);
});

test("its sign-in is read past a notice printed around the JSON, and nothing is guessed from other words", () => {
  assert.deepEqual(signedInFrom('Update available: 2.2.0\n{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n'), { signedIn: false });
  assert.deepEqual(signedInFrom('{"loggedIn":true}\nwarning: something'), { signedIn: true });
  assert.deepEqual(signedInFrom("Not logged in"), {});
  assert.deepEqual(signedInFrom(""), {});
});

const RESULT = `${JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" })}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 4, output_tokens: 5 } })}\n`;

test("what it says about itself: not installed, not signed in, ready, and ready on the person's API key", async () => {
  assert.deepEqual(await claudeAdapter({ bin: "/nonexistent/claude" }).info(), { installed: false });
  const out = fakeCli([{ args: "--version", out: "2.1.0 (Claude Code)\n" }, { args: "auth status --json", out: '{"loggedIn":false,"authMethod":"none"}\n', code: 1 }]);
  const inn = fakeCli([{ args: "--version", out: "2.1.0 (Claude Code)\n" }, { args: "auth status --json", out: '{"loggedIn":true}\n' }]);
  try {
    assert.deepEqual(await claudeAdapter({ bin: out.bin }).info(), { installed: true, version: "2.1.0", signedIn: false });
    assert.deepEqual(await claudeAdapter({ bin: out.bin, apiKey: "sk-ant-fake" }).info(), { installed: true, version: "2.1.0", signedIn: false, apiKey: true, note: CLAUDE_ON_KEY });
    assert.deepEqual(await claudeAdapter({ bin: inn.bin, apiKey: "sk-ant-fake" }).info(), { installed: true, version: "2.1.0", signedIn: true }, "signed in, it answers with its own login");
  } finally {
    out.remove();
    inn.remove();
  }
});

test("a turn runs on its own login as it has it; on the person's key only when it is not signed in; never with Open Sourcebook's settings", async () => {
  const saved = process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN;
  process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN = "connector-token";
  const inn = fakeCli([{ args: "auth status --json", out: '{"loggedIn":true}\n' }, { args: "-p", out: RESULT }]);
  const out = fakeCli([{ args: "auth status --json", out: '{"loggedIn":false}\n', code: 1 }, { args: "-p", out: RESULT }]);
  try {
    const own = await claudeAdapter({ bin: inn.bin, apiKey: "sk-ant-fake" }).run({ ...spec, cwd: tmpdir() }).done;
    assert.deepEqual(own, { ok: true, text: "Done.", model: "claude-haiku-5-5", tokensIn: 4, inputTokens: 4, tokensOut: 5 });
    assert.ok(!inn.env().some((line) => line.startsWith("ANTHROPIC_API_KEY=") || line.startsWith("OPENSOURCEBOOK_")));
    assert.ok(inn.env().includes("ENABLE_TOOL_SEARCH=false"));
    assert.deepEqual(inn.stdins().slice(-1), ["hi"]);
    await claudeAdapter({ bin: out.bin, apiKey: "sk-ant-fake" }).run({ ...spec, cwd: tmpdir() }).done;
    assert.ok(out.env().includes("ANTHROPIC_API_KEY=sk-ant-fake"));
    // Without a key it is never asked whether it is signed in before a turn: it just runs.
    const plain = fakeCli([{ args: "-p", out: RESULT }]);
    await claudeAdapter({ bin: plain.bin }).run({ ...spec, cwd: tmpdir() }).done;
    assert.deepEqual(plain.calls().map((c) => c.split(" ")[0]), ["-p"]);
    const m = /--system-prompt-file\s+(\S+)/.exec(plain.calls()[0]!);
    assert.ok(m, "run passes system prompt via --system-prompt-file");
    assert.equal(existsSync(dirname(m[1]!)), false, "temporary prompt directory is cleaned up after exit");
    plain.remove();
  } finally {
    if (saved === undefined) delete process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN;
    else process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN = saved;
    inn.remove();
    out.remove();
  }
});

test("a turn out of usage ends as a limit, with the reset the stream gave and the CLI's own words for it, and nothing more", async () => {
  const resetsAt = Math.floor(Date.parse("2026-11-18T14:00:00.000Z") / 1000);
  const both = fakeCli([{ args: "-p", out: claudeLimited("You've hit your limit · resets 3pm (Europe/Berlin)", resetsAt), code: 1 }]);
  const words = fakeCli([{ args: "-p", out: claudeLimited("You've hit your limit · resets 3pm (Europe/Berlin)"), code: 1 }]);
  const none = fakeCli([{ args: "-p", out: claudeLimited("You've hit your limit"), code: 1 }]);
  try {
    const end = await claudeAdapter({ bin: both.bin }).run({ ...spec, cwd: tmpdir() }).done;
    assert.equal(end.problem, "agentLimit");
    assert.deepEqual(end.limit, { resetsAt: "2026-11-18T14:00:00.000Z", resets: "3pm (Europe/Berlin)" });
    assert.deepEqual((await claudeAdapter({ bin: words.bin }).run({ ...spec, cwd: tmpdir() }).done).limit, { resets: "3pm (Europe/Berlin)" });
    const silent = await claudeAdapter({ bin: none.bin }).run({ ...spec, cwd: tmpdir() }).done;
    assert.equal(silent.problem, "agentLimit");
    assert.equal(silent.limit, undefined, "no reset is made up");
  } finally {
    both.remove();
    words.remove();
    none.remove();
  }
});

test("the registry: every agent once, Claude Code, Codex, OpenCode, Antigravity, Cursor and GitHub Copilot by default, each key only to its own provider's agents", () => {
  const agents = createDefaultAgents({}, { anthropic: "sk-ant-fake" });
  assert.deepEqual(agents.list().map((a) => a.id), ["claude", "codex", "opencode", "antigravity", "cursor", "copilot"]);
  assert.equal(agents.get("claude")!.boxing!.unready(), undefined);
  assert.notEqual(agents.get("codex")!.boxing!.unready(), undefined, "an Anthropic key is not Codex's");
  assert.equal(agents.get("opencode")!.boxing, undefined);
  assert.notEqual(agents.get("antigravity")!.boxing!.unready(), undefined, "an Anthropic key is not Antigravity's");
  assert.equal(agents.get("cursor")!.boxing, undefined);
  assert.equal(agents.get("copilot")!.boxing, undefined);
  assert.throws(() => agents.register(agents.get("claude")!), /already registered/);
  assert.equal(agents.get("nope"), undefined);
});

test("each agent's program is found by its own <ID>_BIN, and only a registered agent's", () => {
  assert.deepEqual(agentBins({ CLAUDE_BIN: " /opt/claude ", CODEX_BIN: "", OPENCODE_BIN: "/opt/opencode", OTHER_BIN: "/x" }), { claude: "/opt/claude", opencode: "/opt/opencode" });
  assert.equal((createDefaultAgents({ claude: "/opt/claude" }).get("claude")!.signIn), "/opt/claude auth login");
});

test("claudeAdapter tags its model tiers, effort weights, and high work effort", () => {
  const adapter = claudeAdapter();
  assert.deepEqual(adapter.defaultModels, { chat: "haiku", work: "sonnet" });
  assert.deepEqual(adapter.defaultEfforts, { work: "high" });
  assert.deepEqual(
    adapter.models!.map((m) => [m.id, m.tier]),
    [["haiku", "fast"], ["sonnet", "balanced"], ["opus", "strong"]],
  );
  assert.deepEqual(
    adapter.efforts!.map((e) => [e.id, e.weight]),
    [["low", "light"], ["medium", "medium"], ["high", "high"], ["xhigh", "max"], ["max", "max"]],
  );
});
