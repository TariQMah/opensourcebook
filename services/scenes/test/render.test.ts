/**
 * The render on a small computer: one frame at once really renders, a render that lacks room is tried again with fewer
 * frames at once and says so in plain words, and one that fails for another reason, or is stopped, is not.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { LOW } from "../pipeline/lib/priority.ts";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { renderMedia } from "@remotion/renderer";
import { render, roomWords, WAIT_WORDS, type Drawn } from "../pipeline/stages/render.ts";
import type { Machine } from "../pipeline/lib/frames-at-once.ts";
import { useChrome } from "../src/chrome.ts";
import { buildScene } from "../src/scene.ts";
import { NARRATION, SAMPLE } from "../src/preview.ts";
import { layOut, type Placed } from "../src/timeline.ts";
import { estimate } from "../src/voice.ts";

useChrome();
const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-render-"));
after(() => rmSync(folder, { recursive: true, force: true }));
const saved = { concurrency: process.env.RENDER_CONCURRENCY, cores: process.env.RENDER_CORES };
after(() => {
  for (const [key, value] of [["RENDER_CONCURRENCY", saved.concurrency], ["RENDER_CORES", saved.cores]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Cores and memory the tests state, so the ladder is the same on a two-core runner and on a big Mac.
const BIG: Machine = { cores: 8, memory: 32 * 1024 ** 3 };
const TWO: Machine = { cores: 2, memory: 8 * 1024 ** 3 };
let placed: Placed[];
before(async () => {
  const timing = estimate(NARRATION);
  const built = await buildScene({ title: "Sample", idea: "", brief: "", style: "flat", frame: { width: 1080, height: 1920 }, scene: { id: "s1", narration: NARRATION, onScreenText: [], visual: "A sample", cites: [] }, timing }, SAMPLE, join(folder, "build"));
  assert.ok(built.scene, built.problems.join("; "));
  placed = [{ id: "s1", scene: built.scene!, theme: built.theme, spoken: { id: "s1", seconds: timing.seconds, words: timing.words } }];
});

// A short timeline of the sample scene: its first second.
function timeline() {
  const laid = layOut(placed, "flat", { width: 1080, height: 1920 }, [], [], undefined, true);
  laid.timeline.audio = "";
  laid.timeline.frames = 30;
  laid.timeline.clips[0]!.frames = 30;
  laid.timeline.captions = [];
  return laid.timeline;
}

test("a video renders with one frame at once, as a two-core computer would draw it", async () => {
  process.env.RENDER_CONCURRENCY = "1";
  const dir = join(folder, "one");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const log: string[] = [];
  let drawn: Drawn | undefined;
  let started: { frames: number; concurrency: number } | undefined;
  const out = await render(timeline(), dir, { machine: TWO, log: (l) => log.push(l), onStart: (s) => (started = s), onDrawn: (d) => (drawn = d) });
  assert.ok(existsSync(out.path) && statSync(out.path).size > 1000, "the video is there");
  assert.equal(started?.concurrency, 1);
  assert.equal(started?.frames, 30);
  assert.equal(drawn?.concurrency, 1);
  assert.ok(drawn!.seconds > 0 && drawn!.setupSeconds > 0);
  assert.ok(log.some((l) => /1 frame at once/.test(l)), log.join("\n"));
});

test("a render that lacks room is tried again with fewer frames at once, says so, and finishes", async () => {
  process.env.RENDER_CONCURRENCY = "4";
  const dir = join(folder, "fewer");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const tried: number[] = [];
  const timeouts: number[] = [];
  const notes: string[] = [];
  const renderer = (async (o: { concurrency?: number | null; timeoutInMilliseconds?: number }) => {
    tried.push(o.concurrency!);
    timeouts.push(o.timeoutInMilliseconds!);
    if (tried.length === 1) throw new Error("concurrency is set higher than the amount of CPU cores available");
    if (tried.length === 2) throw new Error("Timed out after 45000ms while delayRender() was called");
    return {} as never;
  }) as unknown as typeof renderMedia;
  let drawn: Drawn | undefined;
  await render(timeline(), dir, { machine: BIG, renderer, onNote: (w) => notes.push(w), onDrawn: (d) => (drawn = d) });
  assert.deepEqual(tried, [4, 2, 1]);
  assert.ok(timeouts[1]! > timeouts[0]! && timeouts[2]! > timeouts[1]!, "each try is given longer");
  assert.deepEqual(notes, [roomWords(4, 2), roomWords(2, 1)]);
  assert.match(notes[0]!, /short of room.*fewer frames at a time \(2 instead of 4\)/);
  assert.equal(drawn?.concurrency, 1, "what it measured is what it used");
});

test("at one frame at once a render that lacks room is tried once more, with more time", async () => {
  process.env.RENDER_CONCURRENCY = "1";
  const dir = join(folder, "once-more");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const tried: number[] = [];
  const notes: string[] = [];
  const renderer = (async (o: { concurrency?: number | null }) => {
    tried.push(o.concurrency!);
    if (tried.length === 1) throw new Error("Target closed");
    return {} as never;
  }) as unknown as typeof renderMedia;
  await render(timeline(), dir, { machine: TWO, renderer, onNote: (w) => notes.push(w) });
  assert.deepEqual(tried, [1, 1]);
  assert.match(notes[0]!, /took too long.*once more.*more time/);
  // And when that fails too, it fails: the error is the renderer's own.
  const failing = (async () => {
    throw new Error("Target closed");
  }) as unknown as typeof renderMedia;
  await assert.rejects(render(timeline(), dir, { machine: TWO, renderer: failing }), /Target closed/);
});

test("on a two-core computer set to two at once the ladder is 2, 1, then 1 again with a longer frame timeout", async () => {
  process.env.RENDER_CONCURRENCY = "2";
  const dir = join(folder, "two-core");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const tried: { c: number; t: number }[] = [];
  const renderer = (async (o: { concurrency?: number | null; timeoutInMilliseconds?: number }) => {
    tried.push({ c: o.concurrency!, t: o.timeoutInMilliseconds! });
    if (tried.length < 3) throw new Error("Target closed");
    return {} as never;
  }) as unknown as typeof renderMedia;
  const notes: string[] = [];
  await render(timeline(), dir, { machine: TWO, renderer, onNote: (w) => notes.push(w) });
  assert.deepEqual(tried.map((x) => x.c), [2, 1, 1]);
  assert.ok(tried[2]!.t > tried[1]!.t);
  assert.deepEqual(notes, [roomWords(2, 1), roomWords(1, 1)]);
});

test("a render that fails for another reason, or is stopped, is not tried again", async () => {
  process.env.RENDER_CONCURRENCY = "4";
  const dir = join(folder, "no-retry");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  let calls = 0;
  const broken = (async () => {
    calls++;
    throw new Error("scene image a.png did not load");
  }) as unknown as typeof renderMedia;
  await assert.rejects(render(timeline(), dir, { machine: BIG, renderer: broken }), /did not load/);
  assert.equal(calls, 1);
  const stop = new AbortController();
  calls = 0;
  const stopped = (async () => {
    calls++;
    stop.abort();
    throw new Error("Target closed");
  }) as unknown as typeof renderMedia;
  await assert.rejects(render(timeline(), dir, { machine: BIG, renderer: stopped, signal: stop.signal }), /Target closed/);
  assert.equal(calls, 1, "a stop is not a lack of room");
});

test("two videos started together never draw at once: the second waits its turn and says so", async () => {
  process.env.RENDER_CONCURRENCY = "1";
  const { mkdirSync } = await import("node:fs");
  const [a, b] = [join(folder, "first"), join(folder, "second")];
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  let open = 0;
  let most = 0;
  const order: string[] = [];
  let finish: () => void = () => undefined;
  const drawer = (name: string, hold?: Promise<void>) =>
    (async () => {
      open++;
      most = Math.max(most, open);
      order.push(`${name} draws`);
      await hold;
      order.push(`${name} done`);
      open--;
      return {} as never;
    }) as unknown as typeof renderMedia;
  const held = new Promise<void>((r) => (finish = r));
  const waits: string[] = [];
  const first = render(timeline(), a, { machine: TWO, renderer: drawer("first", held), onWait: () => waits.push("first") });
  const second = render(timeline(), b, { machine: TWO, renderer: drawer("second"), onWait: () => waits.push("second"), onStart: () => order.push("second starts") });
  assert.deepEqual(waits, ["second"], "only the one that came while another draws waits, and it is told at once");
  await new Promise((r) => setTimeout(r, 2_000));
  assert.ok(!order.includes("second draws"), `the second waits while the first draws: ${order.join(", ")}`);
  finish();
  await Promise.all([first, second]);
  assert.equal(most, 1, "never two at once");
  assert.deepEqual(order, ["first draws", "first done", "second starts", "second draws", "second done"]);
  assert.match(WAIT_WORDS, /^Waiting for the video before it to finish drawing$/);
  // A third, alone, does not wait.
  const alone: string[] = [];
  await render(timeline(), a, { machine: TWO, renderer: drawer("third"), onWait: () => alone.push("third") });
  assert.deepEqual(alone, []);
});

test("drawing is gentle by default, and with more frames at once at normal priority for a person who asked for speed", { skip: process.platform === "win32" }, async () => {
  delete process.env.RENDER_CONCURRENCY;
  const { mkdirSync } = await import("node:fs");
  const dir = join(folder, "faster");
  mkdirSync(dir, { recursive: true });
  const TEN: Machine = { cores: 10, memory: 32 * 1024 ** 3 };
  // The renderer starts a process of its own, as Chrome does, and says what priority it ends up at.
  const seen: { concurrency: number; lowered: boolean; changed: boolean }[] = [];
  const renderer = (async (o: { concurrency?: number | null }) => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    const before = getPriority(child.pid!);
    await new Promise((r) => setTimeout(r, 1_500));
    const after = getPriority(child.pid!);
    seen.push({ concurrency: o.concurrency!, lowered: after === LOW, changed: after !== before });
    child.kill();
    return {} as never;
  }) as unknown as typeof renderMedia;
  await render(timeline(), dir, { machine: TEN, renderer });
  await render(timeline(), dir, { machine: TEN, renderer, faster: true });
  assert.equal(seen[0]!.concurrency, 5);
  assert.ok(seen[0]!.lowered, `gently, the renderer's processes are lowered: ${JSON.stringify(seen)}`);
  assert.equal(seen[1]!.concurrency, 6, "faster: more frames at once");
  assert.equal(seen[1]!.changed, false, "faster: nothing lowered");
});
