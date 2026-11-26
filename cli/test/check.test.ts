import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLines, gather, chromeLine, ffmpegLine, lines, nodeLine, packagesLine, render, voiceLine, webDevVarsLine, type AgentFacts, type Facts } from "../check.ts";

// Read as the launcher reads it, at run time: the scenes service is its own program with its own checks.
const { NO_KEY_NOTE } = (await import("../../services/scenes/src/voice-choice.ts" as string)) as { NO_KEY_NOTE: string };

const claude: AgentFacts = { id: "claude", label: "Claude Code", installed: true, version: "2.1.0", signedIn: true, signIn: "claude auth login" };
const codex: AgentFacts = { id: "codex", label: "Codex", installed: false, unavailable: "not yet", signIn: "codex login" };

test("Node: 24 is fine, older blocks the start and says how to get 24", () => {
  assert.deepEqual(nodeLine("24.13.0"), { status: "ok", text: "Node 24.13.0" });
  const old = nodeLine("v22.4.0");
  assert.equal(old.status, "missing");
  assert.equal(old.blocks, true);
  assert.equal(old.text, "Node 22.4.0 is too old: install Node 24 from nodejs.org (or run `nvm install 24`), check it with `node --version`, and run this again.");
});

test("ffmpeg: missing says how to install it on each system", () => {
  assert.equal(ffmpegLine("7.1", "darwin").text, "ffmpeg 7.1");
  assert.match(ffmpegLine(null, "darwin").text, /^ffmpeg is missing, so videos can't be made: install it with `brew install ffmpeg` \(Homebrew is at brew\.sh; without it, download ffmpeg from ffmpeg\.org\/download\.html\), then start again\./);
  assert.match(ffmpegLine(null, "darwin").text, /`ffmpeg -version`/);
  assert.match(ffmpegLine(null, "linux").text, /sudo apt install ffmpeg/);
  assert.match(ffmpegLine(null, "win32").text, /winget install ffmpeg/);
  assert.equal(ffmpegLine(null, "linux").blocks, undefined, "Open Sourcebook still starts without it");
});

test("agents: signed in, not signed in, not installed, not usable yet", () => {
  assert.deepEqual(agentLines([claude, codex]), [
    { status: "ok", text: "Claude Code 2.1.0, signed in" },
    { status: "note", text: "Open Sourcebook also works with Codex, which isn't installed here." },
  ]);
  const out = agentLines([{ ...claude, signedIn: false }, codex]);
  assert.deepEqual(out[0], { status: "missing", text: "Claude Code 2.1.0 is installed but not signed in: run `claude auth login` in a terminal." });
  assert.equal(out.length, 2, "the sign-in line already says what to do");
  assert.equal(agentLines([claude, { ...codex, installed: true, version: "0.1" }])[1]!.text, "Codex 0.1 is installed; Open Sourcebook can't answer the chat with it yet.");
});

test("agents: the ones not installed are one line, not one each, whatever their place in the list", () => {
  const opencode: AgentFacts = { id: "opencode", label: "OpenCode", installed: false };
  const antigravity: AgentFacts = { id: "antigravity", label: "Antigravity", installed: false };
  assert.deepEqual(agentLines([codex, claude, opencode, antigravity]), [
    { status: "ok", text: "Claude Code 2.1.0, signed in" },
    { status: "note", text: "Open Sourcebook also works with Codex, OpenCode and Antigravity, which aren't installed here." },
  ]);
  const none = agentLines([{ id: "claude", label: "Claude Code", installed: false, signIn: "claude auth login" }, opencode, antigravity]);
  assert.deepEqual(none, [
    { status: "note", text: "Open Sourcebook works with Claude Code, OpenCode and Antigravity; none is installed here." },
    { status: "missing", text: "No coding agent is ready, so the chat can't answer: install Claude Code and sign in with `claude auth login`." },
  ]);
  assert.equal(agentLines([claude]).length, 1, "with every agent installed there is nothing to add");
});

test("agents: one on the person's API key, and one with no sign-in to ask about, are ready in their adapter's words", () => {
  const onKey = { ...claude, signedIn: false, apiKey: true, note: "Answers with the Anthropic API key in Open Sourcebook's connector settings." };
  const open = { id: "opencode", label: "OpenCode", installed: true, version: "2.2.6", note: "Answers with the models OpenCode offers on this computer." };
  assert.deepEqual(agentLines([onKey, open]), [
    { status: "ok", text: "Claude Code 2.1.0: Answers with the Anthropic API key in Open Sourcebook's connector settings." },
    { status: "ok", text: "OpenCode 2.2.6: Answers with the models OpenCode offers on this computer." },
  ]);
});

test("agents: none installed says which to install and how to sign in", () => {
  const out = agentLines([{ id: "claude", label: "Claude Code", installed: false, signIn: "claude auth login" }, codex]);
  assert.deepEqual(out.at(-1), { status: "missing", text: "No coding agent is ready, so the chat can't answer: install Claude Code and sign in with `claude auth login`." });
});

test("agents: a failure to ask is one plain line", () => {
  assert.deepEqual(agentLines({ error: "boom" }), [{ status: "missing", text: "Couldn't ask which coding agents are installed (boom); the chat may not answer." }]);
});

test("voice: no key means no sound on every system, in the scenes service's own words; a key says nothing to do", async () => {
  assert.equal(voiceLine({}).status, "ok");
  assert.deepEqual(voiceLine({ kind: "speechify" }), { status: "ok", text: "Voice key set (Speechify)" });
  const none = voiceLine({ note: NO_KEY_NOTE });
  assert.equal(none.status, "note");
  assert.equal(none.notice, true);
  assert.equal(none.text, "No voice set up: videos are made without sound, with captions carrying the words. For a voice, pick one in Settings, under Voice.");
  assert.equal(voiceLine({ problem: "SCENES_VOICE=robot is not a voice" }).status, "missing");
  // What is gathered is the service's own choice, so the wording cannot drift from its status.
  const root = join(import.meta.dirname, "..", "..");
  const noKey = await gather(root, { PATH: process.env.PATH, ELEVENLABS_API_KEY: "" });
  assert.equal(noKey.voice.note, NO_KEY_NOTE);
  assert.deepEqual((await gather(root, { PATH: process.env.PATH, ELEVENLABS_API_KEY: "a-key" })).voice, {});
  assert.match((await gather(root, { PATH: process.env.PATH, SCENES_VOICE: "say" })).voice.note ?? "", /robotic.*SCENES_VOICE=say.*quick test/);
  // Kokoro: named when installed, and how to install it when it is asked for and not there.
  assert.deepEqual((await gather(root, { PATH: process.env.PATH, ELEVENLABS_API_KEY: "", SPEECHIFY_API_KEY: "a-key" })).voice, { kind: "speechify" });
  const kokoro = await gather(root, { PATH: process.env.PATH, SCENES_VOICE: "kokoro" });
  const { kokoroInstalled } = (await import("../../services/scenes/src/kokoro.ts" as string)) as { kokoroInstalled(): boolean };
  if (kokoroInstalled()) assert.deepEqual(voiceLine(kokoro.voice), { status: "ok", text: "Voice: Kokoro, on this computer" });
  else assert.match(voiceLine(kokoro.voice).text, /^The voice setting is wrong: SCENES_VOICE=kokoro needs it installed on this computer: run opensourcebook voice install kokoro\.$/);
});

test("voice: the voice chosen in the app's private file wins over the settings, as the scenes service reads it", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-check-voice-"));
  try {
    const file = join(dir, "voice.json");
    writeFileSync(file, JSON.stringify({ SCENES_VOICE: "say" }));
    const chosen = await gather(root, { PATH: process.env.PATH, ELEVENLABS_API_KEY: "a-key", SCENES_VOICE_FILE: file });
    assert.match(chosen.voice.note ?? "", /SCENES_VOICE=say/);
    writeFileSync(file, JSON.stringify({ SPEECHIFY_API_KEY: "file-key" }));
    assert.deepEqual((await gather(root, { PATH: process.env.PATH, ELEVENLABS_API_KEY: "", SCENES_VOICE_FILE: file })).voice, { kind: "speechify" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Chrome, packages and web/.dev.vars", () => {
  assert.equal(chromeLine("/x/chrome-headless-shell").status, "ok");
  assert.equal(chromeLine(null).text, "The browser that draws videos is not downloaded yet; starting Open Sourcebook downloads it once (about 180 MB to download, about half a gigabyte once unpacked).");
  assert.equal(packagesLine([]), undefined);
  assert.equal(packagesLine(["engine", "web"])!.text, "What the Engine, Web app need is not installed yet; starting Open Sourcebook installs it once (a few minutes).");
  assert.equal(webDevVarsLine(false), undefined);
  assert.match(webDevVarsLine(true)!.text, /^web\/\.dev\.vars is there/);
});

test("the whole check never mentions a stand-in mode and renders one line each", () => {
  const facts: Facts = { platform: "darwin", node: "24.1.0", ffmpeg: null, agents: [claude, codex], voice: { note: NO_KEY_NOTE }, chrome: null, missingPackages: ["engine"], webDevVars: false };
  const all = lines(facts);
  const text = render(all);
  assert.equal(text.split("\n").length, all.length);
  assert.doesNotMatch(text, /mock|offline|storyboard/i);
  assert.match(text, /^ {2}ok {4}Node 24\.1\.0$/m);
  assert.match(text, /^ {2}fix {3}ffmpeg is missing/m);
  assert.doesNotMatch(text, /\n\s+at /, "no stack trace");
});
