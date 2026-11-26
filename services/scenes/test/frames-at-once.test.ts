/**
 * How many frames are drawn at once follows the computer: a share of its cores and memory, never more than the renderer
 * allows, with the person's own setting winning; and a render that lacks room tries again with fewer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpus } from "node:os";
import { fewerAtOnce, framesAtOnce, lackedRoom, thisMachine, MOST_AT_ONCE } from "../pipeline/lib/frames-at-once.ts";

const GB = 1024 ** 3;

test("with nothing set, frames at once are about half the cores, one at least, never past the renderer's most", () => {
  const at = (cores: number, memory = 32 * GB) => framesAtOnce({ cores, memory }, {}).frames;
  assert.equal(at(1), 1);
  assert.equal(at(2), 1, "a two-core computer draws one at a time: the renderer refuses more than it has, and Open Sourcebook's other programs need a core");
  assert.equal(at(4), 2);
  assert.equal(at(8), 4);
  assert.equal(at(10), 5);
  assert.equal(at(12), 6);
  assert.equal(at(64), MOST_AT_ONCE);
  // About half the machine stays free for the person's own apps.
  for (const cores of [1, 2, 3, 4, 6, 8, 12, 16, 32]) assert.ok(at(cores) >= 1 && at(cores) <= Math.max(1, cores / 2), `${cores} cores`);
});

test("low memory brings it down, however many cores there are: a quarter of the memory at most", () => {
  const at = (memoryGb: number) => framesAtOnce({ cores: 12, memory: memoryGb * GB }, {}).frames;
  assert.equal(at(32), 6);
  assert.equal(at(16), 5, "an 8-core, 16 GB Mac draws with about 4 GB of its memory");
  assert.equal(at(8), 2);
  assert.equal(at(4), 1);
  assert.equal(at(2), 1);
  assert.equal(at(0.5), 1, "never none");
});

test("a person who asked for speed gets most of the computer: more frames at once, the same limits", () => {
  const at = (cores: number, memoryGb = 32) => framesAtOnce({ cores, memory: memoryGb * GB }, {}, { faster: true }).frames;
  assert.equal(at(2), 1);
  assert.equal(at(4), 2);
  assert.equal(at(8), 4);
  assert.equal(at(10), 6, "a ten-core Mac draws 6 at once, where gently it draws 5");
  assert.equal(framesAtOnce({ cores: 10, memory: 32 * GB }, {}).frames, 5);
  assert.equal(at(64), MOST_AT_ONCE);
  assert.equal(at(12, 8), 5, "memory still brings it down, at half of it");
  assert.equal(framesAtOnce({ cores: 2, memory: 16 * GB }, { RENDER_CONCURRENCY: "2" }, { faster: true }).frames, 2, "RENDER_CONCURRENCY still wins");
});

test("RENDER_CONCURRENCY sets it by hand, but not above the cores, which the renderer would refuse", () => {
  const machine = { cores: 2, memory: 16 * GB };
  assert.equal(framesAtOnce(machine, { RENDER_CONCURRENCY: "2" }).frames, 2);
  assert.equal(framesAtOnce(machine, { RENDER_CONCURRENCY: "1" }).frames, 1);
  const over = framesAtOnce(machine, { RENDER_CONCURRENCY: "4" });
  assert.equal(over.frames, 2);
  assert.match(over.why, /refuses/);
  // A setting that is not a whole number of at least one is ignored, as if it were not set.
  for (const bad of ["", "0", "-1", "two", "1.5"]) assert.equal(framesAtOnce(machine, { RENDER_CONCURRENCY: bad }).frames, 1, bad);
});

test("RENDER_CORES counts fewer cores than there are, for trying a smaller computer; never more", () => {
  const real = cpus().length;
  assert.equal(thisMachine({ RENDER_CORES: "1" }).cores, 1);
  assert.equal(thisMachine({ RENDER_CORES: String(real + 10) }).cores, real);
  assert.equal(thisMachine({ RENDER_CORES: "nonsense" }).cores, real);
  assert.ok(thisMachine({}).memory > 0);
});

test("fewer frames at once halves down to one", () => {
  assert.deepEqual(fewerAtOnce(6), [6, 3, 1]);
  assert.deepEqual(fewerAtOnce(4), [4, 2, 1]);
  assert.deepEqual(fewerAtOnce(2), [2, 1]);
  assert.deepEqual(fewerAtOnce(1), [1]);
  assert.deepEqual(fewerAtOnce(0), [1]);
});

test("a render that lacked room is told from one that failed for another reason", () => {
  for (const words of ["concurrency is set higher than the amount of CPU cores available", "Timed out after 28000ms while delayRender() was called", "Target closed", "Page crashed!", "spawn ENOMEM", "browser was closed"]) {
    assert.ok(lackedRoom(new Error(words)), words);
  }
  for (const words of ["scene image a.png did not load", "no such composition", "render stopped"]) assert.ok(!lackedRoom(new Error(words)), words);
});
