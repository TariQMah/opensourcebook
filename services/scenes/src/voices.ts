/**
 * The voice services this service has: the one list the app, the choice of a voice (`voice-choice.ts`) and the
 * launcher's check read. Each voice file describes itself (`elevenService` in `eleven.ts`, ...); a new voice is one
 * file and one line here. Nothing outside a voice's own file names it.
 *
 * Hosted services come first, A to Z by label, then the ones that run on this computer. The order is also what a key
 * decides with nothing chosen: the first hosted service whose key is set is the voice.
 *
 * Every service here is a function's answer, not a value made at load, so the voice files can import each other in any
 * order.
 */
import { elevenService } from "./eleven.ts";
import { kokoroService } from "./kokoro.ts";
import { speechifyService } from "./speechify.ts";
import { sayVoice, silentVoice, VoiceDown, type Voice, type VoiceHealth } from "./voice.ts";

/** One voice a person can pick from a service's own list. */
export interface VoiceOption {
  id: string;
  label: string;
  description?: string;
  language?: string;
  /** Whether a sample can be heard (`sample`). */
  sample: boolean;
}

/** Settings a voice is built from: the environment with the private voice file laid over it (`voice-file.ts`). */
export type VoiceSettings = Record<string, string | undefined>;

export interface VoiceService {
  /** Its id, the value of `SCENES_VOICE` that picks it. */
  id: string;
  /** The name on screen; a voice on this computer says so. */
  label: string;
  where: "hosted" | "local";
  /** One plain line on what it is. */
  about: string;
  /** The key it needs: its setting's name (as in `.env`), the words for it, and where a person gets one. */
  key?: { name: string; label: string; helpUrl: string };
  /** The setting that names the voice it speaks with. */
  voiceSetting?: string;
  /** The voices the person's account has. */
  listVoices?(key: string | undefined, signal?: AbortSignal): Promise<VoiceOption[]>;
  /** A short sample of one voice, from the service's own preview (nothing paid for). */
  sample?(voiceId: string, key: string | undefined, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Whether a key is good, read without speaking: refused, out of credits, or no answer. */
  checkKey?(key: string, signal?: AbortSignal): Promise<VoiceHealth>;
  /** Local only: whether it is installed here. */
  installed?(): boolean;
  /** Local only: what a person runs, once, to install it, and in which folder when it matters. */
  install?: { command: string; folder?: string };
  /** False for a voice kept for tests and the no-voice case, never offered to pick in the app. */
  offered: boolean;
  /** The voice, from these settings. */
  build(settings: VoiceSettings, o: { cacheDir?: string }): Voice;
}

/** Every voice service, hosted A to Z by label, then local A to Z. */
export function voiceServices(): VoiceService[] {
  const all = [elevenService(), speechifyService(), kokoroService(), sayService(), silentService()];
  const byLabel = (a: VoiceService, b: VoiceService) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  return [...all.filter((s) => s.where === "hosted").sort(byLabel), ...all.filter((s) => s.where === "local").sort(byLabel)];
}

/** The service with this id, if there is one. */
export function voiceService(id: string, services: VoiceService[] = voiceServices()): VoiceService | undefined {
  return services.find((s) => s.id === id);
}

/** A setting's value, trimmed, or undefined when empty. */
export function setting(settings: VoiceSettings, name: string | undefined): string | undefined {
  const value = name ? settings[name]?.trim() : undefined;
  return value ? value : undefined;
}

/** This computer's own voice (macOS `say`), robotic: a test aid only, never offered. */
function sayService(): VoiceService {
  return {
    id: "say",
    label: "This computer's own voice",
    where: "local",
    about: "The computer's built-in voice, robotic; for a quick test only.",
    offered: false,
    build: (s) => sayVoice({ ...(setting(s, "SCENES_SAY_VOICE") ? { voice: setting(s, "SCENES_SAY_VOICE")! } : {}), ...(Number(s.SCENES_SAY_RATE) > 0 ? { rate: Number(s.SCENES_SAY_RATE) } : {}) }),
  };
}

/** No voice: the video is made without sound, its captions carrying the words. Never offered: it is what "none" gives. */
function silentService(): VoiceService {
  return {
    id: "silent",
    label: "No voice",
    where: "local",
    about: "Videos are made without sound, with captions carrying the words.",
    offered: false,
    build: () => silentVoice(),
  };
}

/** A voice with no sample to hear. */
export class NoSample extends Error {
  constructor(message = "This voice has no sample to hear.") {
    super(message);
    this.name = "NoSample";
  }
}

/**
 * JSON from a hosted voice service's own address, with the key in a header (never in the address, so no error or log
 * line carries it). A refused key, no credits and no answer throw `VoiceDown` in the service's own words (`words`).
 */
export async function readJsonFrom(url: string, headers: Record<string, string>, name: string, words: (status: number, body: string) => string | undefined, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VoiceDown(`${name} could not be reached (${(error as Error).name === "TimeoutError" ? "no answer in 15 seconds" : (error as Error).message}).`, "unreachable");
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const said = words(res.status, text) ?? `${name} answered ${res.status}.`;
    throw new VoiceDown(said, res.status === 402 ? "credits" : res.status === 401 || res.status === 403 ? "refused" : "unreachable");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new VoiceDown(`${name} answered with something that is not its list.`, "unreachable");
  }
}

/**
 * A voice's preview, from the address the service's own list gave for it (https only). Its type is the one the
 * file is served with when that is audio; otherwise it is read from the file's own first bytes, since a service's
 * storage may serve its previews as `text/plain` or `application/octet-stream` (ElevenLabs' previews come as
 * `text/plain`). Anything that is not sound is no sample.
 */
export async function fetchPreview(url: string | undefined, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!url || !/^https:\/\//.test(url)) throw new NoSample();
  let res: Response;
  try {
    res = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VoiceDown(`The sample could not be fetched (${(error as Error).message}).`, "unreachable");
  }
  if (!res.ok) throw new NoSample();
  const bytes = new Uint8Array(await res.arrayBuffer());
  const served = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const contentType = served.startsWith("audio/") ? served : audioTypeOf(bytes);
  if (!contentType || bytes.byteLength === 0) throw new NoSample();
  return { bytes, contentType };
}

/** The audio type a file's first bytes say it is (MP3, Ogg, WAV, FLAC, MP4 audio, WebM), or undefined when they say no sound. */
export function audioTypeOf(bytes: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg";
  // An MPEG audio frame starts with 11 set bits.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (bytes.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac";
  if (bytes.length >= 8 && ascii(4, 8) === "ftyp") return "audio/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  return undefined;
}
