/**
 * Kokoro: a voice that runs on this computer, with no key and nothing paid, on a Mac, Linux and Windows alike. It is
 * Kokoro-82M (its weights under Apache 2.0) run by kokoro-js (Apache 2.0) on ONNX Runtime (MIT), and it reads English.
 * It is not part of Open Sourcebook's own install: a person who wants it presses Install in Settings > Voice or runs
 * `opensourcebook voice install kokoro` (in a clone, `npm run voice:kokoro` in `services/scenes`), which
 * installs it into `voices/kokoro/` and fetches the model once (about 90 MB of the 600 MB, from Hugging Face; no text
 * is ever sent anywhere). After that it works offline. `docs/THIRD-PARTY.md` lists what it brings with it, eSpeak NG among them.
 *
 * Kokoro gives no word times, so it speaks like `say`: each sentence to its own file, measured, and its words share
 * that time by the estimator's weights (`joinSentences`). A sentence too long for the model at once (it reads about
 * 500 sounds) is spoken in phrases. What it spoke is kept by its words and voice, so a rewrite speaks only the
 * sentences that changed.
 */
import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { joinSentences, sentences, type Spoken, type SpokenSentence, type Voice } from "./voice.ts";
import { setting, type VoiceService } from "./voices.ts";

/** Where the person's own install of Kokoro lives (`opensourcebook voice install kokoro`). */
export const KOKORO_HOME = join(import.meta.dirname, "..", "voices", "kokoro");
/** The model and its precision. `voices/kokoro/package.json` fetches the same at install; keep the two alike. */
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";
/** Kokoro's best-graded English voice. `SCENES_KOKORO_VOICE` names another (`af_bella`, `bf_emma`, `am_michael`...). */
export const KOKORO_VOICE = "af_heart";
/**
 * How fast it reads, against the model's own pace. The model's own is brisk for teaching: about 220 words a minute from
 * a scene's first word to its last, as the scene is timed. 0.7 is about 155, near the silent voice's 146 and inside what
 * ElevenLabs measured on real scenes (104 to 164). `SCENES_KOKORO_SPEED` sets another.
 */
export const KOKORO_SPEED = 0.7;
/** Most words given to the model at once: well inside the about 500 sounds it reads before it cuts the rest off. */
const MOST_WORDS = 40;

/** Whether Kokoro is installed on this computer. */
export function kokoroInstalled(home = KOKORO_HOME): boolean {
  return existsSync(join(home, "node_modules", "kokoro-js", "package.json"));
}

/** A sentence cut into phrases the model reads whole: after a comma, colon, semicolon or dash where it can, else by count. */
export function phrases(words: string[], most = MOST_WORDS): string[][] {
  const out: string[][] = [];
  let rest = words;
  while (rest.length > most) {
    let cut = -1;
    for (let i = most - 1; i >= Math.floor(most / 3); i--) {
      if (/[,;:—–]["')\]]*$/.test(rest[i]!) || rest[i + 1] === "—" || rest[i + 1] === "–") {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = most;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest);
  return out;
}

/** What speaks a phrase to a WAV file: the model, or a test's stand-in. */
export type Speaker = (text: string, o: { voice: string; speed: number }, file: string) => Promise<void>;

/**
 * The model, in its own process (`voices/kokoro/speak.mjs`), started on first use and kept while the service runs.
 * Apart, its memory and its speech code (which takes over a process's handling of errors) never touch the service.
 * It holds the service open only while it speaks.
 */
function modelSpeaker(home: string): Speaker {
  let child: ChildProcess | undefined;
  let n = 0;
  const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let said = "";
  const hold = (on: boolean) => {
    if (!child) return;
    const channel = child.channel as { ref(): void; unref(): void } | undefined;
    if (on) (child.ref(), channel?.ref());
    else (child.unref(), channel?.unref());
  };
  const start = (): ChildProcess => {
    const c = fork(join(home, "speak.mjs"), [KOKORO_MODEL, DTYPE], { cwd: home, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    c.stderr!.on("data", (d: Buffer) => (said = (said + d.toString()).slice(-2000)));
    (c.stderr as unknown as { unref(): void }).unref();
    c.on("message", (m: { n: number; error?: string }) => {
      const w = waiting.get(m.n);
      waiting.delete(m.n);
      if (!waiting.size) hold(false);
      if (m.error) w?.reject(new Error(`Kokoro could not speak: ${m.error}`));
      else w?.resolve();
    });
    c.on("exit", (code, sig) => {
      child = undefined;
      const why = new Error(`Kokoro's process ended (${sig ?? code})${said.trim() ? `: ${said.trim().split("\n").at(-1)}` : ""}.`);
      for (const w of waiting.values()) w.reject(why);
      waiting.clear();
    });
    return c;
  };
  return (text, { voice, speed }, file) =>
    new Promise<void>((resolve, reject) => {
      child ??= start();
      const id = ++n;
      waiting.set(id, { resolve, reject });
      hold(true);
      child.send({ n: id, text, voice, speed, file });
    });
}

export function kokoroVoice(o: { voice?: string; speed?: number; cacheDir?: string; home?: string; speaker?: Speaker } = {}): Voice {
  const voice = o.voice ?? KOKORO_VOICE;
  const speed = o.speed ?? KOKORO_SPEED;
  const speaker = o.speaker ?? modelSpeaker(o.home ?? KOKORO_HOME);
  return {
    id: "kokoro",
    label: `Kokoro, a voice on this computer (${voice})`,
    real: true,
    quick: true,
    sound: () => `kokoro:${voice}:${speed}`,
    async speak(segments, folder, signal) {
      mkdirSync(folder, { recursive: true });
      const out: Spoken[] = [];
      for (const seg of segments) {
        const parts: SpokenSentence[] = [];
        for (const [k, sentence] of sentences(seg.text).entries()) {
          for (const [j, words] of phrases(sentence).entries()) {
            signal?.throwIfAborted();
            const text = words.join(" ");
            const file = join(folder, `${seg.id}-${k}-${j}.wav`);
            const kept = o.cacheDir && join(o.cacheDir, `kokoro-${createHash("sha256").update(JSON.stringify([KOKORO_MODEL, DTYPE, voice, speed, text])).digest("hex").slice(0, 32)}.wav`);
            if (kept && existsSync(kept)) copyFileSync(kept, file);
            else {
              await speaker(text, { voice, speed }, file);
              if (kept) {
                mkdirSync(o.cacheDir!, { recursive: true });
                copyFileSync(file, kept);
              }
            }
            parts.push({ file, words });
          }
        }
        out.push(await joinSentences(seg.id, parts, folder, signal));
      }
      return out;
    },
  };
}

/**
 * Kokoro as a voice service: on this computer, no key. It is not installed by the app (a download of a few hundred MB):
 * the person runs its install command once, and the app checks again.
 */
export function kokoroService(): VoiceService {
  return {
    id: "kokoro",
    label: "On this computer",
    where: "local",
    about: "Kokoro, a free voice that runs on this computer with no key and nothing sent anywhere; plainer than the hosted ones. Installed once.",
    voiceSetting: "SCENES_KOKORO_VOICE",
    installed: () => kokoroInstalled(),
    install: { command: "opensourcebook voice install kokoro" },
    offered: true,
    build: (s, o) => {
      const voice = setting(s, "SCENES_KOKORO_VOICE");
      return kokoroVoice({ ...(voice ? { voice } : {}), ...(Number(s.SCENES_KOKORO_SPEED) > 0 ? { speed: Number(s.SCENES_KOKORO_SPEED) } : {}), ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}) });
    },
  };
}
