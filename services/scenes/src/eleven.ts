/**
 * ElevenLabs, the hosted voice: the text-to-speech call with timestamps,
 * whose character times become word times, so captions and every scene moment land on what is really said. A scene
 * is one request, read with the scenes around it as context (not billed). Its speech is cut out of the quiet the
 * request leaves at either end and set between LEAD and TAIL like every other voice, and no word is timed outside the
 * measured speech. Each request is kept on disk by its words and voice, so a script rewrite pays only for the scenes
 * whose words changed, and a job that stops part way never pays twice.
 *
 * The voice per style comes from the style file's `voice` block (`{ id, model }`); a setting can
 * override it for every style.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "./ffmpeg.ts";
import { wordsOf } from "./script.ts";
import type { Word } from "./scene.ts";
import { styleFile } from "./styles.ts";
import { LEAD, spread, TAIL, VoiceDown, type Spoken, type Voice, type VoiceHealth, type VoiceTrouble } from "./voice.ts";
import { fetchPreview, readJsonFrom, setting, type VoiceOption, type VoiceService } from "./voices.ts";

export type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
export type TtsRequest = { text: string; previous_text?: string; next_text?: string };
export type TtsResult = { audio: Uint8Array; alignment: Alignment };
export type Tts = (voice: { id: string; model: string }, req: TtsRequest, signal?: AbortSignal) => Promise<TtsResult>;

const SR = 44100; // ElevenLabs mp3_44100_128 is mono at this rate
const SPEECH_DB = -50; // a 10 ms window louder than this is speech; the narrator's own pauses sit near -78 dB
const PAD = 0.03; // seconds of the request's own quiet kept at each cut, so no onset or release is clipped
const FADE = 0.005;
const CONCURRENCY = 3;
const ATTEMPTS = 3;
/** The voice every style file names. */
export const DEFAULT_VOICE = { id: "JBFqnCBsd6RMkjVDRZzb", model: "eleven_v4" };

// Punctuation gets its own time slot, so only letters and digits extend a word's end.
export function toWords(a: Alignment): Word[] {
  const words: Word[] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push({ text: cur, start, end });
      cur = "";
      return;
    }
    if (!cur) start = a.character_start_times_seconds[i]!;
    cur += ch;
    if (/[\p{L}\p{N}]/u.test(ch)) end = a.character_end_times_seconds[i]!;
  });
  if (cur) words.push({ text: cur, start, end });
  return words;
}

// First and last sample of speech: where a 10 ms window first and last rises above SPEECH_DB.
export function speechEdges(pcm: Float32Array, sr = SR): [number, number] | null {
  const win = Math.round(sr * 0.01);
  const floor = 10 ** (SPEECH_DB / 20);
  const loud = (i: number) => {
    let s = 0;
    for (let j = i; j < Math.min(i + win, pcm.length); j++) s += pcm[j]! * pcm[j]!;
    return Math.sqrt(s / win) > floor;
  };
  let a = -1;
  for (let i = 0; i < pcm.length; i += win) if (loud(i)) { a = i; break; }
  if (a < 0) return null;
  let b = a;
  for (let i = Math.floor((pcm.length - 1) / win) * win; i >= a; i -= win) if (loud(i)) { b = Math.min(pcm.length, i + win); break; }
  return [a, b];
}

/**
 * One scene's speech set on the scene's clock: LEAD of quiet, the speech (PAD of its own quiet kept each side, faded at
 * the cut), then quiet to TAIL after the speech. Word times move with the speech and are kept inside it, since at the
 * end of a request ElevenLabs stretches the last word to the end of the audio.
 */
export function placeSpeech(pcm: Float32Array, timed: Word[], sr = SR): { pcm: Float32Array; words: Word[]; seconds: number } {
  const edges = speechEdges(pcm, sr);
  if (!edges) throw new Error("the voice came back with no speech in it");
  const [a, b] = edges;
  const pad = Math.round(PAD * sr);
  const from = Math.max(0, a - pad);
  const to = Math.min(pcm.length, b + pad);
  const cut = pcm.slice(from, to);
  const fade = Math.min(Math.round(FADE * sr), cut.length);
  for (let k = 0; k < fade; k++) {
    cut[k]! *= k / fade;
    cut[cut.length - 1 - k]! *= k / fade;
  }
  const lead = Math.max(0, Math.round(LEAD * sr) - (a - from));
  const total = Math.round(LEAD * sr) + (b - a) + Math.round(TAIL * sr);
  const out = new Float32Array(Math.max(total, lead + cut.length));
  out.set(cut, lead);
  const shift = LEAD - a / sr;
  const [sa, sb] = [a / sr, b / sr];
  const words = timed.map((w) => {
    const start = Math.min(Math.max(w.start, sa), sb);
    return { text: w.text, start: +(start + shift).toFixed(3), end: +(Math.max(start, Math.min(w.end, sb)) + shift).toFixed(3) };
  });
  return { pcm: out, words, seconds: +(out.length / sr).toFixed(3) };
}

/**
 * The timed words as the scene's own words. ElevenLabs times the characters it was sent, so the count matches the
 * script's; if it ever does not, the script's words share the measured speech by the estimator's weights instead, so
 * scene moments (@N) still count the script's words.
 */
export function asSceneWords(timed: Word[], text: string): Word[] {
  const words = wordsOf(text);
  if (timed.length === words.length) return timed.map((w, i) => ({ ...w, text: words[i]! }));
  const start = timed[0]?.start ?? LEAD;
  const end = timed.at(-1)?.end ?? start + 0.5;
  return spread(words, start, Math.max(0.1, end - start));
}

async function decode(mp3: Uint8Array, signal?: AbortSignal): Promise<Float32Array> {
  const raw = (await ffmpeg(["-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"], { input: mp3, signal })).stdout;
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}

async function writeWav(pcm: Float32Array, out: string, signal?: AbortSignal) {
  await ffmpeg(["-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", "pipe:0", "-ar", "48000", "-ac", "1", out], { input: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), signal });
}

/** Plain words for what went wrong with the ElevenLabs account, since the person reads them. */
export function trouble(status: number, body: string): string {
  // ElevenLabs answers 401 for more than a wrong key (an empty quota, unusual activity), and 400 for a malformed key,
  // so its own words decide, at any status.
  const said = elevenSaid(body);
  const detail = said.message || said.status || "";
  if (status === 402 || /quota|credits/i.test(body)) return "The ElevenLabs account is out of credits for this narration.";
  if (keyRefused(body) || (status === 401 && !body)) {
    return `ElevenLabs refused the API key (ELEVENLABS_API_KEY)${said.message ? `: ${said.message.replace(/\.+$/, "")}` : ""}. Fix the key in services/scenes/.env, or remove it to make videos without sound.`;
  }
  if (status === 429) return "ElevenLabs is busy (too many requests); try again in a minute.";
  if (status === 401) return `ElevenLabs turned the request down: ${(detail || body.slice(0, 200)).replace(/\.+$/, "")}.`;
  return `ElevenLabs answered ${status}: ${body.slice(0, 300)}`;
}

/** ElevenLabs' own fields in an error answer (`{ detail: { type, code, status, message } }`), each when it gave it. */
export function elevenSaid(body: string): { type?: string; code?: string; status?: string; message?: string } {
  try {
    const j = JSON.parse(body) as { detail?: unknown };
    const d = j.detail;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const r = d as Record<string, unknown>;
      const pick = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
      return { ...(pick("type") ? { type: pick("type")! } : {}), ...(pick("code") ? { code: pick("code")! } : {}), ...(pick("status") ? { status: pick("status")! } : {}), ...(pick("message") ? { message: pick("message")! } : {}) };
    }
    if (typeof d === "string" && d.trim()) return { message: d.trim() };
  } catch {
    // Not JSON: nothing of its own fields to read.
  }
  return {};
}

/**
 * Whether ElevenLabs says the key or the sign-in is the problem, by its own fields (`authentication_error`,
 * `invalid_api_key` and its kin such as `invalid_api_key_prefix`), whatever the status code. A key that is fine but may
 * not do this one thing (`missing_permissions`) is not a refused key.
 */
export function keyRefused(body: string): boolean {
  const s = elevenSaid(body);
  const fields = [s.type, s.code, s.status].filter((x): x is string => !!x);
  if (fields.length) return fields.some((f) => /authentication|invalid_api_key|api_key_(?:invalid|revoked|expired)|unauthori[sz]ed/i.test(f));
  return /authentication_error|invalid_api_key/i.test(body);
}

/**
 * Whether an answer means the voice cannot speak until something changes: no credits (402, or a quota in its words),
 * the key or account refused (401, or ElevenLabs' own words at any status), or the service itself failing (5xx, which
 * is tried again first). A busy answer (429) or anything about what was sent is not: it passes.
 */
export function troubleOf(status: number, body: string): VoiceTrouble | undefined {
  if (status === 402 || /quota|credits/i.test(body)) return "credits";
  if (status === 401 || keyRefused(body)) return "refused";
  if (status >= 500) return "unreachable";
  return undefined;
}

/** An error from the voice call, with whether trying again can help (`final`) and what kind of trouble it is. */
type TtsError = Error & { final?: boolean; trouble?: VoiceTrouble };

/** The real ElevenLabs call. previous_text and next_text carry the neighbouring scenes for continuity. */
export function elevenlabs(key: string): Tts {
  return async (v, req, signal) => {
    let res: Response;
    try {
      res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.id)}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ ...req, model_id: v.model }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3 * 60_000)]) : AbortSignal.timeout(3 * 60_000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // No answer at all (no network, the service down, three minutes with nothing back): tried again, then the voice is out.
      throw Object.assign(new Error(`ElevenLabs could not be reached (${(error as Error).message}).`), { trouble: "unreachable" as const });
    }
    const body = await res.text();
    if (!res.ok) {
      const e: TtsError = new Error(trouble(res.status, body));
      const kind = troubleOf(res.status, body);
      // No credits or a refused key: the same request again meets the same answer.
      e.final = res.status === 402 || kind === "credits" || kind === "refused";
      if (kind) e.trouble = kind;
      throw e;
    }
    const j = JSON.parse(body);
    return { audio: Buffer.from(j.audio_base64, "base64"), alignment: j.alignment };
  };
}

export function voiceOfStyle(style: string | undefined, override?: { id?: string; model?: string }): { id: string; model: string } {
  let v = DEFAULT_VOICE;
  try {
    const file = style ? (styleFile(style) as { voice?: { id?: string; model?: string } }) : undefined;
    if (file?.voice?.id && file.voice.model) v = { id: file.voice.id, model: file.voice.model };
  } catch {
    // An unknown style keeps the default voice.
  }
  return { id: override?.id ?? v.id, model: override?.model ?? v.model };
}

/**
 * Whether the ElevenLabs account can speak now, without speaking: its subscription (free to read) says whether any
 * characters are left; a refused key and no answer say themselves. Anything unclear (a key allowed to speak but not to
 * read the account) is taken as able: the next narration is then the check.
 */
export function elevenlabsCheck(key: string): (signal?: AbortSignal) => Promise<VoiceHealth> {
  return async (signal) => {
    let res: Response;
    try {
      res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch (error) {
      return { ok: false, trouble: "unreachable", message: `ElevenLabs could not be reached (${(error as Error).message}).` };
    }
    const body = await res.text().catch(() => "");
    if (res.ok) {
      try {
        const j = JSON.parse(body) as { character_count?: unknown; character_limit?: unknown };
        if (typeof j.character_count === "number" && typeof j.character_limit === "number" && j.character_count >= j.character_limit) return { ok: false, trouble: "credits", message: trouble(402, body) };
      } catch {
        // An answer it cannot read says nothing against speaking.
      }
      return { ok: true };
    }
    if (keyRefused(body)) return { ok: false, trouble: "refused", message: trouble(res.status, body) };
    if (res.status >= 500) return { ok: false, trouble: "unreachable", message: trouble(res.status, body) };
    return { ok: true };
  };
}

export function elevenVoice(o: { key?: string; tts?: Tts; check?: (signal?: AbortSignal) => Promise<VoiceHealth>; retryMs?: number; voiceId?: string; model?: string; cacheDir?: string }): Voice {
  const tts = o.tts ?? elevenlabs(o.key ?? "");
  const check = o.check ?? (o.tts ? undefined : elevenlabsCheck(o.key ?? ""));
  const override = { ...(o.voiceId ? { id: o.voiceId } : {}), ...(o.model ? { model: o.model } : {}) };
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    real: true,
    // Paid, but kept by its words: a rewrite pays only for the scenes it changed, and scenes are then written on the
    // times that play.
    quick: true,
    sound: (style) => {
      const v = voiceOfStyle(style, override);
      return `elevenlabs:${v.id}:${v.model}`;
    },
    ...(check ? { check } : {}),
    async speak(segments, folder, signal, style) {
      mkdirSync(folder, { recursive: true });
      const v = voiceOfStyle(style, override);
      const out: Spoken[] = new Array(segments.length);
      const one = async (i: number) => {
        const seg = segments[i]!;
        const req: TtsRequest = { text: wordsOf(seg.text).join(" "), ...(seg.previous ? { previous_text: seg.previous } : {}), ...(seg.next ? { next_text: seg.next } : {}) };
        // Kept by the words and the voice only, so new neighbours never make the same words paid for again.
        const cache = o.cacheDir && join(o.cacheDir, createHash("sha256").update(JSON.stringify([v.id, v.model, req.text])).digest("hex").slice(0, 32));
        let result: TtsResult | undefined;
        if (cache && existsSync(`${cache}.json`) && existsSync(`${cache}.mp3`)) {
          result = { audio: readFileSync(`${cache}.mp3`), alignment: JSON.parse(readFileSync(`${cache}.json`, "utf8")).alignment };
        }
        for (let attempt = 1; !result; attempt++) {
          try {
            const r = await tts(v, req, signal);
            if (!toWords(r.alignment).length) throw new Error("no timed words came back");
            result = r;
            if (cache) {
              mkdirSync(o.cacheDir!, { recursive: true });
              writeFileSync(`${cache}.mp3`, r.audio);
              writeFileSync(`${cache}.json`, JSON.stringify({ alignment: r.alignment, voice: v, text: req.text }));
            }
          } catch (e) {
            const err = e as TtsError;
            if (signal?.aborted) throw new Error(`The voice could not speak ${seg.id}: ${err.message}`);
            // Out of credits, refused, or no answer through every try: trying again will not help, and it says so.
            if (err.trouble && (err.final || attempt >= ATTEMPTS)) throw new VoiceDown(err.message, err.trouble);
            if (err.final || attempt >= ATTEMPTS) throw new Error(`The voice could not speak ${seg.id}: ${err.message}`);
            await new Promise((r) => setTimeout(r, (o.retryMs ?? 2000) * attempt));
          }
        }
        const placed = placeSpeech(await decode(result.audio, signal), toWords(result.alignment));
        const wav = join(folder, `${seg.id}.wav`);
        await writeWav(placed.pcm, wav, signal);
        out[i] = { id: seg.id, audio: wav, words: asSceneWords(placed.words, seg.text), seconds: placed.seconds };
      };
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, async () => {
        while (next < segments.length) await one(next++);
      }));
      return out;
    },
  };
}

const ELEVEN_API = "https://api.elevenlabs.io";

/** A voice as ElevenLabs lists it, read as one to pick: its name, what its labels say of it, its language. */
export function elevenOption(v: Record<string, unknown>): VoiceOption | undefined {
  const id = typeof v.voice_id === "string" ? v.voice_id : "";
  if (!id) return undefined;
  const labels = (typeof v.labels === "object" && v.labels !== null ? v.labels : {}) as Record<string, unknown>;
  const word = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  const description = [word(labels.description) ?? word(labels.descriptive), word(labels.use_case)?.replace(/_/g, " ")].filter(Boolean).join(", ") || word(v.description);
  const language = word(labels.language) ?? word(labels.accent);
  return { id, label: word(v.name) ?? id, ...(description ? { description } : {}), ...(language ? { language } : {}), sample: !!word(v.preview_url) };
}

/** ElevenLabs as a voice service: the person's own key, their account's voices, and each voice's own preview. */
export function elevenService(): VoiceService {
  const headers = (key: string | undefined) => ({ "xi-api-key": key ?? "" });
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    where: "hosted",
    about: "A hosted voice on your own ElevenLabs account, with real word times; the most natural of these.",
    key: {
      name: "ELEVENLABS_API_KEY",
      label: "Your ElevenLabs key",
      helpUrl: "https://elevenlabs.io/app/settings/api-keys",
      steps: [
        "Make an account at elevenlabs.io. Its free plan gives a small amount of speech each month, enough to try it; its paid plans give more, as its pricing page says.",
        "Open Where to get a key, below, and press Create API key.",
        "If it asks what the key may use, allow Text to Speech, and reading Voices and User.",
        "Copy the key and paste it here.",
      ],
    },
    voiceSetting: "SCENES_ELEVENLABS_VOICE",
    offered: true,
    async listVoices(key, signal) {
      const body = await readJsonFrom(`${ELEVEN_API}/v1/voices`, headers(key), "ElevenLabs", (status, text) => (troubleOf(status, text) ? trouble(status, text) : undefined), signal);
      const list = Array.isArray((body as { voices?: unknown }).voices) ? ((body as { voices: unknown[] }).voices) : [];
      return list.flatMap((v) => (typeof v === "object" && v !== null ? [elevenOption(v as Record<string, unknown>)].filter((o): o is VoiceOption => !!o) : []));
    },
    async sample(voiceId, key, signal) {
      const body = (await readJsonFrom(`${ELEVEN_API}/v1/voices/${encodeURIComponent(voiceId)}`, headers(key), "ElevenLabs", (status, text) => (troubleOf(status, text) ? trouble(status, text) : undefined), signal)) as { preview_url?: unknown };
      return fetchPreview(typeof body.preview_url === "string" ? body.preview_url : undefined, signal);
    },
    checkKey: (key, signal) => elevenlabsCheck(key)(signal),
    build: (s, o) => {
      const voiceId = setting(s, "SCENES_ELEVENLABS_VOICE");
      const model = setting(s, "SCENES_ELEVENLABS_MODEL");
      return elevenVoice({ key: setting(s, "ELEVENLABS_API_KEY") ?? "", ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}), ...(voiceId ? { voiceId } : {}), ...(model ? { model } : {}) });
    },
  };
}
