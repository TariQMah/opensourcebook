import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { KOKORO_VOICE, kokoroInstalled, kokoroVoice, phrases } from "../src/kokoro.ts";
import { chooseVoice, NO_KEY_NOTE } from "../src/voice-choice.ts";
import { LEAD, TAIL, voiceFromEnv } from "../src/voice.ts";
import { audioStatus } from "../src/audio.ts";

const run = promisify(execFile);
const ordered = (words: { start: number; end: number }[]) => words.every((w, i) => w.end > w.start && (i === 0 || w.start >= words[i - 1]!.end - 1e-6));

/** A stand-in for the model, for these tests only: a tone a quarter second a word, with quiet before and after. */
async function tone(text: string, _o: unknown, file: string) {
  const speech = text.split(" ").length * 0.25;
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:duration=${speech}`, "-af", "adelay=120,apad=pad_dur=0.2", "-ar", "24000", "-ac", "1", file]);
}

test("a long sentence is read in phrases, cut after a comma where there is one, and no word is lost", () => {
  const words = Array.from({ length: 95 }, (_, i) => (i === 29 ? "thirty," : `w${i}`));
  const parts = phrases(words, 40);
  assert.deepEqual(parts.flat(), words);
  assert.ok(parts.every((p) => p.length <= 40));
  assert.equal(parts[0]!.at(-1), "thirty,", "cut after the comma, not at the count");
  assert.deepEqual(phrases(["A", "short", "one."]), [["A", "short", "one."]]);
});

test("Kokoro is chosen only when a person turns it on, and asked for without its install it says how to get it", () => {
  assert.deepEqual(chooseVoice({ SCENES_VOICE: "kokoro" }, { kokoro: true }), { kind: "kokoro" });
  assert.throws(() => chooseVoice({ SCENES_VOICE: "kokoro" }, { kokoro: false }), /SCENES_VOICE=kokoro needs it installed on this computer: run opensourcebook voice install kokoro\./);
  // Installed but not turned on: no key still means no sound, as before; a key still means ElevenLabs.
  assert.equal(chooseVoice({}, { kokoro: true }).kind, "silent");
  assert.equal(chooseVoice({}, { kokoro: true }).note, NO_KEY_NOTE);
  assert.equal(chooseVoice({ ELEVENLABS_API_KEY: "k" }, { kokoro: true }).kind, "elevenlabs");
  const voice = voiceFromEnv({ SCENES_VOICE: "kokoro", SCENES_KOKORO_VOICE: "bf_emma" }, undefined, { kokoro: true });
  assert.equal(voice.real, true);
  assert.equal(voice.note, undefined, "the voice the person asked for needs no note");
  assert.equal(voice.sound("flat"), "kokoro:bf_emma:0.7");
  assert.deepEqual(audioStatus(voice), { ready: true }, "with Kokoro, audio can be made without a key");
});

test("Kokoro speaks each scene to one file that holds every word in order, and speaks words it has spoken before only once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-kokoro-"));
  try {
    const said: string[] = [];
    const voice = kokoroVoice({ cacheDir: join(dir, "kept"), speaker: async (text, v, file) => (said.push(text), tone(text, v, file)) });
    const segments = [{ id: "s1", text: "A lever is a stiff bar. It turns on one point." }, { id: "s2", text: "Push down far from it." }];
    const spoken = await voice.speak(segments, join(dir, "a"));
    assert.deepEqual(said, ["A lever is a stiff bar.", "It turns on one point.", "Push down far from it."]);
    for (const [i, s] of spoken.entries()) {
      assert.equal(s.id, segments[i]!.id);
      assert.ok(s.audio && existsSync(s.audio));
      assert.equal(s.words.map((w) => w.text).join(" "), segments[i]!.text);
      assert.ok(ordered(s.words));
      assert.ok(Math.abs(s.words[0]!.start - LEAD) < 0.02, `first word at ${s.words[0]!.start}`);
      assert.ok(s.words.at(-1)!.end <= s.seconds - TAIL + 0.05, `${s.id}: last word ends ${s.words.at(-1)!.end}, file ${s.seconds}`);
    }
    // The tone is a quarter second a word: the quiet around each sentence is cut, so the scene is its speech, two breaths and the lead and tail.
    assert.ok(Math.abs(spoken[0]!.seconds - (11 * 0.25 + 0.18 + LEAD + TAIL)) < 0.1, `s1 is ${spoken[0]!.seconds} s`);
    // A rewrite of one scene speaks only its new sentence.
    said.length = 0;
    await voice.speak([{ id: "s1", text: "A lever is a stiff bar. It turns on a pivot." }], join(dir, "b"));
    assert.deepEqual(said, ["It turns on a pivot."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Kokoro stops between sentences when the video is stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-kokoro-"));
  try {
    const stop = new AbortController();
    const voice = kokoroVoice({ speaker: async (text, v, file) => (stop.abort(), tone(text, v, file)) });
    await assert.rejects(voice.speak([{ id: "s1", text: "One sentence. Another one." }], dir, stop.signal), { name: "AbortError" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The real model, where a person has installed it (npm run voice:kokoro).
test("the real Kokoro speaks a scene at a natural pace", { skip: !kokoroInstalled() && "Kokoro is not installed here" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-kokoro-"));
  try {
    const text = "A lever is a stiff bar that turns on one point, the fulcrum. Push down far from it and a small push lifts a heavy load.";
    const [s] = await kokoroVoice().speak([{ id: "s1", text }], dir);
    assert.ok(s!.audio && existsSync(s!.audio));
    assert.equal(s!.words.length, text.split(" ").length);
    assert.ok(ordered(s!.words));
    const wpm = (s!.words.length / (s!.words.at(-1)!.end - s!.words[0]!.start)) * 60;
    // Near the silent voice's pace (146) and inside ElevenLabs's measured range: a teaching pace, not the model's brisk own.
    assert.ok(wpm > 120 && wpm < 175, `${wpm.toFixed(0)} words a minute`);
    assert.equal(KOKORO_VOICE, "af_heart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
