/**
 * The fresh viewer's parts on their own: its answer read from the tool or from plain words, what it is given of the
 * cut, its tools on a real mp4 (frames at phone size within the connector's picture limit, a few at full size), the
 * maker's notes, the request's toggle and a turn's own model.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Connector } from "../src/connector.ts";
import type { Cut } from "../src/cut.ts";
import { readRequest } from "../src/request.ts";
import { changedBeats, polishText, readReview, reviewFromText, spokenLines, VIEWER_SYSTEM, viewerCall, viewerPrompt, WATCH, type Review, type ViewerSession } from "../src/review.ts";
import { emptyDraft, type Draft } from "../src/tools.ts";
import { passages } from "./fixtures/scenes.ts";

const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-review-"));
after(() => rmSync(folder, { recursive: true, force: true }));

const cut: Cut = {
  key: "k",
  file: "video.mp4",
  bytes: 1,
  durationMs: 12_000,
  spans: [
    { id: "s1", startMs: 0, endMs: 5_000 },
    { id: "s2", startMs: 5_000, endMs: 9_000 },
  ],
  words: [
    { text: "A", start: 0.3, end: 0.4, beat: "s1" },
    { text: "lever", start: 0.45, end: 0.8, beat: "s1" },
    { text: "turns.", start: 0.85, end: 1.2, beat: "s1" },
    { text: "Push", start: 5.3, end: 5.6, beat: "s2" },
    { text: "down.", start: 5.65, end: 6, beat: "s2" },
  ],
  holds: [{ beat: "s1", id: "h1", start: 2, seconds: 1.5 }],
  voice: { id: "silent", label: "No voice", real: false },
  number: 1,
  renderMs: 1,
  at: "",
};

const good: Review = {
  taught: "A lever turns on a fixed point. Pushing far from it lifts a load near it. The far end moves further.",
  worked: { strengths: ["the bar tips in step with the words at 0:05"], bestMoment: "0:06, the load rising" },
  faults: [{ at: "0:02", what: "the label is too small to read", lens: "finish" }],
  weakestMoment: "0:02, the pause with nothing moving",
  topChange: "Show the push before saying it.",
  via: "tool",
};

test("the viewer's answer is read from submit_review, and refused only without what it taught or with faults that are not a list", () => {
  const read = readReview({ ...good, faults: [...good.faults, "0:08 - the end card is a wall of text", { at: 7, what: "jumps" }, { at: "", what: "" }] }, "tool");
  assert.deepEqual(read.problems, []);
  assert.equal(read.review!.faults.length, 3);
  assert.deepEqual(read.review!.faults[1], { at: "0:08", what: "the end card is a wall of text" });
  assert.deepEqual(read.review!.faults[2], { at: "7 s", what: "jumps" });
  // Worked given as a plain list still keeps the strengths.
  assert.deepEqual(readReview({ ...good, worked: ["a", "b"], bestMoment: "c" }, "tool").review!.worked, { strengths: ["a", "b"], bestMoment: "c" });
  assert.deepEqual(readReview({ ...good, taught: " " }, "tool").problems.length, 1);
  assert.equal(readReview({ ...good, faults: "none" }, "tool").review, undefined);
  // No faults is an answer.
  assert.deepEqual(readReview({ ...good, faults: [] }, "tool").review!.faults, []);
});

test("an answer written out instead of sent is read from its words: a JSON object, or the fields under headings", () => {
  const json = reviewFromText(`Here is my review:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``)!;
  assert.equal(json.via, "text");
  assert.equal(json.faults[0]!.what, "the label is too small to read");
  const words = reviewFromText(
    [
      "## Taught",
      "A lever turns on a fixed point. Pushing far from it lifts a load near it.",
      "**What worked:**",
      "- the bar tips with the words",
      "- clear colours",
      "**Best moment:** 0:06, the load rising",
      "### Faults",
      "1. 0:02: the label is too small",
      "2. **0:07-0:09** – the picture freezes while the voice goes on",
      "Weakest moment: 0:02",
      "Top change: show the push before saying it",
    ].join("\n"),
  )!;
  assert.equal(words.taught, "A lever turns on a fixed point. Pushing far from it lifts a load near it.");
  assert.deepEqual(words.worked, { strengths: ["the bar tips with the words", "clear colours"], bestMoment: "0:06, the load rising" });
  assert.deepEqual(words.faults, [
    { at: "0:02", what: "the label is too small" },
    { at: "0:07-0:09", what: "the picture freezes while the voice goes on" },
  ]);
  assert.equal(words.weakestMoment, "0:02");
  assert.equal(words.topChange, "show the push before saying it");
  // "None" under faults is no faults; nothing taught is no answer.
  assert.deepEqual(reviewFromText("Taught: levers lift.\nFaults: none\nTop change: nothing")!.faults, []);
  assert.equal(reviewFromText("I watched it and it was fine."), undefined);
  assert.equal(reviewFromText(""), undefined);
});

test("the viewer is given the topic, the length against the length asked, the words with their times and the measured numbers, and nothing of how it was made", () => {
  const request = { id: "r", title: "Levers", brief: "how a lever lifts a load", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 10, style: "flat", passages, limits: {} as never };
  const s: ViewerSession = { request, cut, video: "", folder, report: "Measured: s2 is spoken at 200 words a minute.", watched: 0, framesShown: 0 };
  const prompt = viewerPrompt(s);
  assert.match(prompt, /made to teach: "Levers"\. how a lever lifts a load/);
  assert.match(prompt, /runs 0:12\.0 \(12 s\), the end card after the last words at 0:09\.0; about 10 s of narration was asked for/);
  assert.match(prompt, /\[0:00\.3\] A lever turns\.\n\[0:02\.0\] \(the voice pauses 1\.5 s\)\n\[0:05\.3\] Push down\./);
  assert.match(prompt, /200 words a minute/);
  assert.match(prompt, /no voice: the captions carry the words/);
  // Never the passages, the sources or a scene's source.
  assert.doesNotMatch(prompt, /fulcrum|Notes on simple machines|role=title/);
  assert.deepEqual(spokenLines(cut), ["[0:00.3] A lever turns.", "[0:02.0] (the voice pauses 1.5 s)", "[0:05.3] Push down."]);
  // The five lenses, the friend test and no score.
  for (const lens of [/Did it teach\?/, /3 to 5 sentences/, /shown happening on screen, or only told/, /The picture\./, /lower half above the captions/, /Words, voice and picture together/, /Readable and finished on a phone/, /the end card/, /Right and consistent/]) assert.match(VIEWER_SYSTEM, lens);
  assert.match(VIEWER_SYSTEM, /give no score and no verdict/);
});

test("watch_video shows the whole cut about once a second at phone size, on at most 8 sheets; watch_frame gives up to 3 frames at full size", async () => {
  const video = join(folder, "v.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=10:duration=12", "-pix_fmt", "yuv420p", video]);
  const request = { id: "r", title: "Levers", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, style: "flat", passages, limits: {} as never };
  const s: ViewerSession = { request, cut, video, folder: join(folder, "watch"), watched: 0, framesShown: 0 };
  const whole = await viewerCall("watch_video", {}, s);
  assert.ok(!whole.isError, whole.text);
  const frames = whole.text.split("\n").filter((l) => /^\d+\. /.test(l));
  assert.equal(frames.length, 12);
  assert.equal(whole.images!.length, 2);
  assert.match(frames[0]!, /^1\. 0:00\.4: "A lever"/);
  assert.ok(frames.some((l) => /end card/.test(l)));
  const size = (b64: string) => {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", "-"], { input: Buffer.from(b64, "base64") }).toString().trim();
    return Number(out);
  };
  // Three phone-wide frames a row, with their borders.
  assert.equal(size(whole.images![0]!.dataBase64), 3 * (360 + 6));
  // A long video is still seen whole, within the connector's eight pictures an answer.
  const longVideo = join(folder, "long.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=4:duration=110", "-pix_fmt", "yuv420p", longVideo]);
  const long = await viewerCall("watch_video", {}, { ...s, video: longVideo, cut: { ...cut, durationMs: 110_000 }, folder: join(folder, "long") });
  assert.ok(!long.isError, long.text);
  assert.equal(long.text.split("\n").filter((l) => /^\d+\. /.test(l)).length, WATCH.most);
  assert.equal(long.images!.length, 8);
  const close = await viewerCall("watch_frame", { at: [1, 2, 3, 4] }, s);
  assert.equal(close.images!.length, 3);
  assert.equal(size(close.images![0]!.dataBase64), 1080 + 6);
  assert.match(close.text, /0 full-size frames left/);
  assert.equal((await viewerCall("watch_frame", { at: [5] }, s)).isError, true);
  assert.equal((await viewerCall("write_beat", {}, s)).isError, true);
  const sent = await viewerCall("submit_review", good, s);
  assert.ok(!sent.isError);
  assert.match(sent.text, /one fault/);
  assert.deepEqual(s.review, good);
});

test("the maker's notes are a viewer's, to weigh: what it understood, what worked, its faults with their times, and the beats as they stand", () => {
  const draft: Draft = {
    ...emptyDraft(),
    script: { title: "Levers", idea: "x", scenes: [{ id: "s1", narration: "A lever turns.", onScreenText: ["fulcrum"], visual: "a bar", cites: [] }, { id: "s2", narration: "Push down.", onScreenText: [], visual: "a push", cites: [] }] },
    scenes: { s1: { source: "@0\ntext t \"Lever\" role=title", built: true, looked: true, writes: 1, looks: 1 }, s2: { source: "@0\nbox b \"load\"", built: true, looked: false, writes: 1, looks: 0 } },
    sound: { music: [{ scene: "s1", at: 0, name: "calm", level: -6, why: "" }], effects: [] },
  };
  const text = polishText(good, draft, cut);
  assert.match(text, /for you to weigh/);
  assert.match(text, /Keep what worked/);
  assert.match(text, /This is the one round of notes/);
  assert.match(text, /What it took from the video, in its own words: A lever turns/);
  assert.match(text, /1\. 0:02: the label is too small to read \(finish\)/);
  assert.match(text, /The one change it would make: Show the push/);
  assert.match(text, /## s2, 0:05\.0 to 0:09\.0 in cut 1\nNarration: Push down\.\nSource:\n```\n@0\nbox b "load"\n```/);
  assert.match(text, /On screen: fulcrum/);
  assert.match(text, /music calm at s1 @0, -6 dB/);
  const changed = structuredClone(draft);
  changed.scenes.s2!.source = "@0\nbox b \"heavy load\"";
  assert.deepEqual(changedBeats(draft, changed), { beats: ["s2"], sound: false });
  changed.sound = undefined;
  changed.script!.scenes.push({ id: "s3", narration: "More.", onScreenText: [], visual: "y", cites: [] });
  assert.deepEqual(changedBeats(draft, changed), { beats: ["s2", "s3"], sound: true });
});

test("a request may turn the fresh viewer on or off for itself, and nothing else is taken for it", () => {
  const base = { id: "r1", title: "Levers", passages: [{ id: "p1", sourceId: "s", sourceTitle: "t", text: "words" }] };
  const on = readRequest({ ...base, review: true }, ["flat"]);
  assert.ok("request" in on && on.request.review === true);
  const off = readRequest({ ...base, review: false }, ["flat"]);
  assert.ok("request" in off && off.request.review === false);
  const unset = readRequest(base, ["flat"]);
  assert.ok("request" in unset && !("review" in unset.request));
  const wrong = readRequest({ ...base, review: "yes" }, ["flat"]);
  assert.ok("problems" in wrong && wrong.problems.some((p) => p.startsWith("review:")));
});

test("a request may ask to draw faster, and nothing else is taken for it", () => {
  const base = { id: "r1", title: "Levers", passages: [{ id: "p1", sourceId: "s", sourceTitle: "t", text: "words" }] };
  const on = readRequest({ ...base, faster: true }, ["flat"]);
  assert.ok("request" in on && on.request.faster === true);
  for (const off of [readRequest({ ...base, faster: false }, ["flat"]), readRequest(base, ["flat"])]) assert.ok("request" in off && !("faster" in off.request));
  const wrong = readRequest({ ...base, faster: "yes" }, ["flat"]);
  assert.ok("problems" in wrong && wrong.problems.some((p) => p.startsWith("faster:")));
});

test("a turn's own model and effort go over the ones set for videos, and leave them alone when not named", async () => {
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/status")) return Response.json({ agent: "claude", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true }] });
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true, agent: "claude" }, { status: 202 });
  }) as typeof fetch;
  const c = new Connector({ url: "http://127.0.0.1:9", token: "t".repeat(16), model: "video-model", effort: "high" }, fetchImpl);
  const turn = { turnId: "t1", systemPrompt: "s", prompt: "p", tools: [], callback: { url: "http://127.0.0.1:1/turns/t1", token: "x" }, timeoutMs: 0 };
  await c.start(turn);
  await c.start({ ...turn, model: "viewer-model", effort: "low" });
  assert.deepEqual([sent[0].model, sent[0].effort], ["video-model", "high"]);
  assert.deepEqual([sent[1].model, sent[1].effort], ["viewer-model", "low"]);
});
