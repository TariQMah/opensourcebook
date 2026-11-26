/** What a video's instructions tell the agent its own tools can do in its folder: only what the connector offered. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Connector } from "../src/connector.ts";
import { systemPrompt, turnPrompt } from "../src/prompt.ts";
import { listStyles } from "../src/styles.ts";

test("a files-only folder is said to hold its file tools only, never a shell or the web", () => {
  const files = systemPrompt("files");
  assert.match(files, /in skills\/ in your folder, as files/);
  assert.match(files, /Your own file tools work there and only there/);
  assert.match(files, /no shell and no web of your own/);
  assert.doesNotMatch(files, /your shell, files, web search/);
  const full = systemPrompt("full");
  assert.match(full, /your shell, files, web search and fetch/);
  assert.equal(systemPrompt(true), full, "true is the full folder, as before");
  const none = systemPrompt();
  assert.match(none, /Read them with read_skill/);
  assert.doesNotMatch(none, /# Your folder/);
});

test("the connector's status says which folder the agent gets; an older connector's folder is the full one", async () => {
  let agent: Record<string, unknown> = {};
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agent: "claude", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, ...agent }] })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const status = async () => new Connector({ url, token: "t" }).status();
    agent = { workspace: true, workspaceAccess: "files" };
    assert.deepEqual([(await status()).workspace, (await status()).access], [true, "files"]);
    agent = { workspace: true };
    assert.equal((await status()).access, "full");
    agent = { workspace: false };
    assert.equal((await status()).workspace, undefined);
  } finally {
    server.close();
  }
});

test("the asked length reaches the agent in seconds and in words, with where it will see its running length", () => {
  const request = { title: "T", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 75, style: "auto", passages: [], limits: { minScenes: 2, maxScenes: 12, narrationMaxChars: 600, visualMinChars: 20, visualMaxChars: 700, onScreenTextMax: 4 } } as never;
  const prompt = turnPrompt(request, listStyles());
  assert.match(prompt, /about 75 seconds of narration, about 190 words at a voice's usual pace; each beat you write answers with the video's spoken length so far/);
});

test("a carry-on turn hears why it was cut off, when known, and what exists in the draft, read back from it", () => {
  const request = { title: "T", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 30, style: "auto", passages: [], limits: { minScenes: 2, maxScenes: 12, narrationMaxChars: 600, visualMinChars: 20, visualMaxChars: 700, onScreenTextMax: 4 } } as never;
  const scene = (id: string, narration: string) => ({ id, narration, onScreenText: [], visual: "", cites: [] });
  const draft = {
    script: { title: "Levers", idea: "A push far away lifts a load near.", scenes: [scene("s1", "A lever turns on one fixed point."), scene("s2", "Push down far from it, and the heavy load near it rises slowly into the air over a long while.")] },
    style: "flat",
    scenes: { s1: { source: "@0", built: true, looked: true, writes: 1, looks: 1 }, s2: { source: "@0", built: false, looked: false, writes: 1, looks: 0 } },
    timings: {},
    toolCalls: 4,
    cut: { number: 2, durationMs: 21_500 },
  } as never;
  const prompt = turnPrompt(request, listStyles(), undefined, { why: "the service restarted", draft });
  assert.match(prompt, /your turn was cut off \(the service restarted\)\. What you made is kept as you left it, and so is this video's folder\. Carry on from there/);
  assert.match(prompt, /- The video: "Levers", A push far away lifts a load near\.\n/);
  assert.match(prompt, /Style: flat \(your pick\)/);
  assert.match(prompt, /s1: "A lever turns on one fixed point\.", its picture builds and you looked at it\./);
  assert.match(prompt, /s2: "Push down far from it, and the heavy load near it rises slowly into…", its picture does not build\./);
  assert.match(prompt, /A cut was rendered \(cut 2, 21\.5 s\)/);
  assert.match(prompt, /write_beat with only a beat's id/);
  assert.match(turnPrompt(request, listStyles(), undefined, { draft: { scenes: {}, timings: {}, toolCalls: 0 } }), /your turn was cut off\. [^\n]*\nWhat exists:\n- No title or idea said yet\.\n- Style: none picked yet\.\n- No beat written yet\./);
  assert.doesNotMatch(turnPrompt(request, listStyles()), /cut off/);
});

test("an agent that may read its job folder beside its own is told where that is, and nothing more", () => {
  for (const access of ["files", "full"] as const) {
    const beside = systemPrompt(access, [], undefined, true);
    assert.match(beside, /this video's job folder, one level up \(`\.\.`\), which you can read but not change: `\.\.\/README\.md` says what is there/, access);
    assert.doesNotMatch(systemPrompt(access), /\.\.\/README\.md/, access);
  }
  assert.doesNotMatch(systemPrompt(undefined, [], undefined, true), /README/, "no folder, nothing said");
  assert.doesNotMatch(systemPrompt("files", [], undefined, true), /only there/);
});

test("the connector's status says whether the job folder beside the work is opened to the agent", async () => {
  let agent: Record<string, unknown> = {};
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agent: "claude", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, ...agent }] })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const status = async () => new Connector({ url, token: "t" }).status();
    agent = { workspace: true, workspaceAccess: "files", workspaceReads: true };
    assert.equal((await status()).reads, true);
    agent = { workspace: true, workspaceAccess: "files" };
    assert.equal((await status()).reads, undefined);
    agent = { workspace: false, workspaceReads: true };
    assert.equal((await status()).reads, undefined, "no folder, nothing beside it");
  } finally {
    server.close();
  }
});
