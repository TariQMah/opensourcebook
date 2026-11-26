/**
 * Drawing runs at low priority: ffmpeg is lowered as it starts, and while a render runs every process started under
 * the service (the drawing browser, its tabs, the encoder) is lowered as it appears. A person who asked for speed
 * gets normal priority.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants, getPriority } from "node:os";
import { test } from "node:test";
import { LOW, lower, lowWhile, processes, under } from "../pipeline/lib/priority.ts";
import { ffmpeg } from "../src/ffmpeg.ts";

test("low is below normal: nice 10 on macOS and Linux, the below-normal class on Windows", () => {
  assert.equal(LOW, constants.priority.PRIORITY_BELOW_NORMAL);
  assert.ok(LOW > constants.priority.PRIORITY_NORMAL);
});

test("the processes under one are its children and theirs, never its parent or a neighbour", () => {
  const pairs: [number, number][] = [[10, 1], [11, 10], [12, 11], [13, 10], [20, 1], [21, 20]];
  assert.deepEqual(under(10, pairs).sort(), [11, 12, 13]);
  assert.deepEqual(under(99, pairs), []);
});

test("while a render runs, every process that appears under the service is asked for low priority once", async () => {
  const asked: [number, number][] = [];
  let pairs: [number, number][] = [[500, 1], [501, 500]];
  await lowWhile(
    async () => {
      await new Promise((r) => setTimeout(r, 30));
      pairs = [...pairs, [502, 501], [503, 500]]; // the browser opens a tab, the encoder starts
      await new Promise((r) => setTimeout(r, 60));
    },
    { root: 500, list: async () => pairs, set: (pid, priority) => void asked.push([pid, priority]), everyMs: 10 },
  );
  assert.deepEqual(asked.map(([pid]) => pid).sort(), [501, 502, 503]);
  assert.ok(asked.every(([, priority]) => priority === LOW));
});

test("a person who asked for speed draws at normal priority: nothing is lowered", async () => {
  const asked: number[] = [];
  await lowWhile(async () => new Promise((r) => setTimeout(r, 30)), { gentle: false, root: 500, list: async () => [[501, 500]], set: (pid) => void asked.push(pid), everyMs: 5 });
  assert.deepEqual(asked, []);
});

test("a process that already ended is no error", () => {
  assert.equal(lower(undefined), false);
  assert.equal(lower(123, () => { throw new Error("ESRCH"); }), false);
});

test("a real child of this process is lowered while a render runs", { skip: process.platform === "win32" }, async () => {
  const child = spawn("sleep", ["5"], { stdio: "ignore" });
  try {
    assert.ok((await processes()).some(([pid]) => pid === child.pid), "ps lists it");
    await lowWhile(async () => new Promise((r) => setTimeout(r, 400)), { everyMs: 50 });
    assert.equal(getPriority(child.pid!), LOW);
  } finally {
    child.kill();
  }
});

test("ffmpeg is started at low priority", { skip: process.platform === "win32" }, async () => {
  const seen: number[] = [];
  // This process's ffmpeg children and their priority, as ps tells them.
  const watch = setInterval(() => {
    execFile("ps", ["-A", "-o", "ppid=,nice=,comm="], (error, stdout) => {
      if (error) return;
      for (const line of stdout.split("\n")) {
        const [ppid, nice, ...comm] = line.trim().split(/\s+/);
        if (Number(ppid) === process.pid && /ffmpeg/.test(comm.join(" "))) seen.push(Number(nice));
      }
    });
  }, 20);
  try {
    // A second of silence read at its own pace, so it lives long enough to be seen.
    await ffmpeg(["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "1", "-f", "null", "-"]);
  } catch (e) {
    if (/ENOENT/.test(String(e))) return; // no ffmpeg on this computer
    throw e;
  } finally {
    clearInterval(watch);
  }
  assert.ok(seen.length > 0, "ffmpeg was seen running");
  assert.ok(seen.every((p) => p === LOW), `priorities seen: ${seen.join(", ")}`);
});
