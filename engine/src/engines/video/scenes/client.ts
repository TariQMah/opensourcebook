/**
 * The engine's side of the scenes service (services/scenes; docs/DECISIONS.md
 * #54): a service on the person's computer that has their own agent write a
 * video in a scene language, looks at its frames with it, voices it and
 * renders it. The engine starts a video, reads how it is going, may stop it
 * or send problems back once, and fetches the file. The service talks to
 * the agent connector itself; the engine never holds the connector's token.
 *
 * Local only for now: a service URL that is not this machine is refused
 * (wiring.ts), like the chat's agent connector.
 *
 * Wire contract (the service is authoritative):
 *   GET  /status                    { ok, maker, agent, voice, styles, audio }
 *   GET  /styles/:id/preview        image/jpeg
 *   POST /videos                    202 { id }       same id again: the same video
 *   GET  /videos/:id                { id, state, progress, step, steps, style?, failure?, result? }
 *   GET  /videos/:id/file           video/mp4
 *   POST /videos/:id/stop
 *   POST /videos/:id/revise         { problems }
 *   POST /videos/:id/resume         { withoutSound? }
 *   POST /videos/:id/remake-scene   { id, beat, note?, agent?, model?, effort? }   202 { id }: a new video copied from this one
 *   GET  /voice                     { ok, trouble?, message? }
 *   GET  /voice/setup               the voice as set up: service, voice, where from, the services
 *   PUT  /voice/setup               { service, voice? }
 *   PUT  /voice/services/:id/key    { key }       → { service } with its health; the key itself never comes back
 *   DELETE /voice/services/:id/key
 *   GET  /voice/services/:id/voices → { voices }
 *   GET  /voice/services/:id/voices/:voiceId/sample   audio/*
 */
import { readTrouble, type VoiceTrouble } from "../../../jobs/waits";
import { isRecord } from "../../../net";
import type { FetchLike } from "../../../types/provider";

export interface ScenesConfig {
  /** The service, e.g. http://127.0.0.1:8660. */
  url: string;
  token: string;
}

export interface ScenesStyle {
  id: string;
  label: string;
  description: string;
  /**
   * Whether the service offers it for choosing. A style it keeps but does not offer still makes the videos that name
   * it (an older plan's), and is left out of every list a person or an agent picks from.
   */
  offered: boolean;
}

export interface ScenesStatus {
  /** The service answered. */
  reachable: boolean;
  maker?: { id: string; label: string; description: string };
  agent?: { reachable: boolean; id?: string; label?: string; model?: string; effort?: string; problem?: string };
  /** The voice videos get. `real` is whether it makes sound; `note` is what a person should know, in a line with what to do (no key, so no sound). */
  voice?: { id: string; label: string; real?: boolean; note?: string };
  styles: ScenesStyle[];
  /** Whether the service can voice audio now (engines/audio), and when not, why in its own words. Absent from a service without audio. */
  audio?: { ready: boolean; problem?: string };
  /**
   * How fast this computer draws a video in each style, from what it measured: frames a second, and the seconds a
   * render takes to start. A style it has not measured is absent, and nothing is said about its time.
   */
  speed?: Record<string, ScenesSpeed>;
  /**
   * How long whole videos took to make on this computer, the newest few: seconds of making (the agent's writing,
   * the voice and the drawing) and seconds of video. Absent until one was made here.
   */
  made?: ScenesMade[];
}

export interface ScenesMade {
  seconds: number;
  videoSeconds: number;
  agent?: string;
  model?: string;
  effort?: string;
}

export interface ScenesSpeed {
  framesPerSecond: number;
  setupSeconds: number;
}

export type ScenesState = "writing" | "voicing" | "rendering" | "done" | "failed" | "stopped";
export type ScenesFailureCode = "agentUnreachable" | "agentMissing" | "agentSignedOut" | "agentLimit" | "agentError" | "timedOut" | "stopped" | "scriptRefused" | "voiceDown" | "error";

export interface ScenesCite {
  passageId: string;
  sourceId: string;
  quote: string;
}

export interface ScenesScene {
  id: string;
  durationMs: number;
  narration: string;
  onScreenText: string[];
  visual: string;
  cites: ScenesCite[];
  /** What the scene does, in a word or two, when the script says. */
  kind?: string;
}

export interface ScenesResult {
  title: string;
  idea: string;
  scenes: ScenesScene[];
  file: { bytes: number; durationMs: number; width: number; height: number; contentType: string; fps?: number };
  voice: { id: string; label: string; real: boolean; note?: string };
  by: { maker: string; agent: string; model?: string; effort?: string; style: string };
  /** How long the making took on the service: the agent's turns, the voice and the drawing (never a wait), and the fresh viewer's own turn apart. */
  timing?: { makingSeconds: number; review?: { seconds: number; agent: string; model?: string; effort?: string } };
}

export interface ScenesJob {
  id: string;
  state: ScenesState;
  progress: number;
  step: string;
  steps: Array<{ label: string; at: string }>;
  style?: string;
  /**
   * `limit`: when the agent's plan limit stopped it, when the agent said it resets (only if it said so). `voice`: with
   * `voiceDown`, why the voice cannot speak.
   */
  failure?: { code: ScenesFailureCode; message: string; detail?: string; said?: string; limit?: { resetsAt?: string; resets?: string }; voice?: VoiceTrouble };
  result?: ScenesResult;
  /** Whether what it was made from is still on the service (its draft), so one scene of it can be made again. Absent from an older service. */
  draft?: boolean;
}

/** One scene of a finished video asked to be made again, as a new video on the service. */
export interface ScenesRemake {
  /** The new video's id. */
  id: string;
  /** The service's id for the beat. */
  beat: string;
  /** The person's words about it. */
  note?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

export interface ScenesPassage {
  id: string;
  /** The label Open Sourcebook's own writers cite it by (P3): never shown to the agent, sent so the service's label check reads it too. */
  label?: string;
  sourceId: string;
  sourceTitle: string;
  locator?: string;
  text: string;
}

/**
 * One source of a video, for its job folder on the service (docs/JOB-FOLDER.md): its id (the passages' `sourceId`),
 * title, kind, where it came from, and the pictures the engine kept from it, by their `/v1/assets/<id>` path here.
 */
export interface ScenesSource {
  id: string;
  title: string;
  kind: string;
  url?: string;
  /** The original file on this computer, when the source is one (a file of a linked folder); none for an upload kept only in the engine. */
  path?: string;
  pictures?: Array<{ url: string; kind: string; caption?: string; page?: number; timestampMs?: number; width?: number; height?: number; contentType?: string }>;
}

export interface ScenesLimits {
  maxScenes: number;
  minScenes: number;
  narrationMaxChars: number;
  visualMinChars: number;
  visualMaxChars: number;
  onScreenTextMax: number;
  /** Open Sourcebook's own numbers for an on-screen entry, a scene's cites and a quote, so the service refuses what Open Sourcebook would. */
  onScreenChars: number;
  cites: number;
  quoteChars: number;
}

export interface NewScenesVideo {
  id: string;
  title: string;
  brief: string;
  assumes?: string[];
  frame: { width: number; height: number };
  targetSeconds?: number;
  style: string;
  agent?: string;
  model?: string;
  effort?: string;
  passages: ScenesPassage[];
  /** The sources the passages are from, for the video's job folder; an older service ignores them. */
  sources?: ScenesSource[];
  /** The folder the finished video is copied into: the project's linked folder, else its folder in the library. */
  library?: string;
  limits?: ScenesLimits;
  /** Skills for the video agent beyond the service's own: the project's packs, each by folder name with its files. */
  skills?: Array<{ name: string; files: Record<string, string> }>;
  /** The fresh viewer: false turns it off; left out, the service's own setting. Its agent, and a model and effort only with that agent. */
  review?: boolean;
  reviewAgent?: string;
  reviewModel?: string;
  reviewEffort?: string;
  /** Draw with most of the computer at normal priority (the person asked for speed); left out, gently. */
  faster?: boolean;
}

/** A voice service as the app shows it (the scenes service's `voices.ts`). Never a key: whether one is set, and its last four characters. */
export interface VoiceServiceView {
  id: string;
  label: string;
  where: "hosted" | "local";
  about: string;
  needsKey: boolean;
  keyLabel?: string;
  keyHelpUrl?: string;
  /** The steps to getting a key, in the service's own words. */
  keySteps?: string[];
  keySet?: boolean;
  keyHint?: string;
  installed?: boolean;
  install?: { command: string; folder?: string };
  listsVoices: boolean;
  /** Whether it offers a sample of its voices to hear; when not, each of its voices says `sample: false`. */
  samples: boolean;
  health?: { ok: true } | { ok: false; trouble: VoiceTrouble; message: string };
}

export interface VoiceSetup {
  /** The chosen service; absent when there is none (videos without sound). */
  service?: string;
  voice?: { id: string; label: string };
  from: "app" | "env" | "none";
  note?: string;
  /** Hosted A to Z, then local, as the service lists them. */
  services: VoiceServiceView[];
}

export interface VoiceOption {
  id: string;
  label: string;
  description?: string;
  language?: string;
  sample: boolean;
}

/** The scenes service would not make a voice change, in its own code and words (`unknown_voice_service`, `voice_needs_key`, ...). */
export class ScenesVoiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScenesVoiceError";
  }
}

/** The service did not answer, or answered with something that is not the contract. */
export class ScenesUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenesUnreachableError";
  }
}

const STATUS_TIMEOUT_MS = 4_000;
const CALL_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 120_000;

export class ScenesClient {
  constructor(
    readonly config: ScenesConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  async status(signal?: AbortSignal): Promise<ScenesStatus> {
    const response = await this.call("GET", "/status", undefined, STATUS_TIMEOUT_MS, signal).catch(() => undefined);
    if (!response?.ok) return { reachable: false, styles: [] };
    const body: unknown = await response.json().catch(() => undefined);
    if (!isRecord(body)) return { reachable: false, styles: [] };
    return readStatus(body);
  }

  /** Starts a video; the same id again is the same video, so a redelivery re-attaches. */
  async start(video: NewScenesVideo, signal?: AbortSignal): Promise<void> {
    const response = await this.call("POST", "/videos", video, CALL_TIMEOUT_MS, signal);
    if (response.status !== 202 && response.status !== 200) throw await refused(response, "start a video");
  }

  /** The video, or undefined when the service has no video with that id. */
  async get(id: string, signal?: AbortSignal): Promise<ScenesJob | undefined> {
    const response = await this.call("GET", `/videos/${encodeURIComponent(id)}`, undefined, CALL_TIMEOUT_MS, signal);
    if (response.status === 404) return undefined;
    if (!response.ok) throw await refused(response, "read a video");
    const body: unknown = await response.json().catch(() => undefined);
    const job = readJob(body);
    if (!job) throw new ScenesUnreachableError("The scenes service answered with a video it did not describe.");
    return job;
  }

  async file(id: string, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const response = await this.call("GET", `/videos/${encodeURIComponent(id)}/file`, undefined, FILE_TIMEOUT_MS, signal);
    if (!response.ok) throw await refused(response, "send the video file");
    return { bytes: await response.arrayBuffer(), contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4" };
  }

  /** Stops the agent and any render. Best effort: a service that is gone has nothing to stop. */
  /** Opens a video's job folder in this computer's file manager (`POST /videos/:id/show-files`); false when the service no longer has it. */
  async showFiles(id: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.call("POST", `/videos/${encodeURIComponent(id)}/show-files`, {}, CALL_TIMEOUT_MS, signal);
    if (response.ok) return true;
    if (response.status === 404 || response.status === 405) return false;
    throw await refused(response, "open the video's folder");
  }

  async stop(id: string): Promise<void> {
    await this.call("POST", `/videos/${encodeURIComponent(id)}/stop`, {}, STATUS_TIMEOUT_MS).catch(() => undefined);
  }

  /**
   * Carries a video that ended (failed or stopped) on from its draft, with a
   * new turn of the agent told what exists. False when the service will not
   * (it no longer has the video, or it is an older service without it).
   */
  async resume(id: string, signal?: AbortSignal, options: { withoutSound?: boolean } = {}): Promise<boolean> {
    const response = await this.call("POST", `/videos/${encodeURIComponent(id)}/resume`, options.withoutSound ? { withoutSound: true } : {}, CALL_TIMEOUT_MS, signal);
    if (response.ok) return true;
    if (response.status === 409 || response.status === 404 || response.status === 405) return false;
    throw await refused(response, "carry the video on");
  }

  /**
   * Whether the service's voice can speak now, read without speaking (`GET /voice`): free, so a video waiting on the
   * voice costs nothing to check. Nothing could be told (the service is down or older): `{}`.
   */
  async voice(signal?: AbortSignal): Promise<{ free: boolean; trouble?: VoiceTrouble } | { free?: undefined }> {
    const response = await this.call("GET", "/voice", undefined, CALL_TIMEOUT_MS, signal).catch(() => undefined);
    if (!response?.ok) return {};
    const body: unknown = await response.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.ok !== "boolean") return {};
    const trouble = readTrouble(body.trouble);
    return body.ok ? { free: true } : { free: false, ...(trouble ? { trouble } : {}) };
  }

  /** The voice as set up on this computer. */
  async voiceSetup(signal?: AbortSignal): Promise<VoiceSetup> {
    return readVoiceSetup(await this.voiceCall("GET", "/voice/setup", undefined, signal));
  }

  /** Chooses the voice service (null: none) and, when given, its voice (null: the service's own). */
  async setVoice(input: { service: string | null; voice?: string | null }, signal?: AbortSignal): Promise<VoiceSetup> {
    return readVoiceSetup(await this.voiceCall("PUT", "/voice/setup", input, signal));
  }

  /** Hands a key to the service, which checks it and keeps it on this computer when it is taken. */
  async setVoiceKey(service: string, key: string, signal?: AbortSignal): Promise<{ service: VoiceServiceView }> {
    const body = await this.voiceCall("PUT", `/voice/services/${encodeURIComponent(service)}/key`, { key }, signal);
    const view = isRecord(body) ? readServiceView(body.service) : undefined;
    if (!view) throw new ScenesUnreachableError("The scenes service answered a key with something it did not describe.");
    return { service: view };
  }

  async clearVoiceKey(service: string, signal?: AbortSignal): Promise<VoiceSetup> {
    return readVoiceSetup(await this.voiceCall("DELETE", `/voice/services/${encodeURIComponent(service)}/key`, undefined, signal));
  }

  /** The voices on the person's account with that service. */
  async voiceOptions(service: string, signal?: AbortSignal): Promise<VoiceOption[]> {
    const body = await this.voiceCall("GET", `/voice/services/${encodeURIComponent(service)}/voices`, undefined, signal);
    return (isRecord(body) && Array.isArray(body.voices) ? body.voices : []).flatMap((v) => {
      const one = readVoiceOption(v);
      return one ? [one] : [];
    });
  }

  /** A voice's sample as the service sends it (audio), or undefined when there is none. */
  async voiceSample(service: string, voiceId: string, signal?: AbortSignal): Promise<Response | undefined> {
    const response = await this.call("GET", `/voice/services/${encodeURIComponent(service)}/voices/${encodeURIComponent(voiceId)}/sample`, undefined, CALL_TIMEOUT_MS * 2, signal);
    if (response.ok) return response;
    if (response.status === 404) return undefined;
    throw await voiceRefused(response);
  }

  private async voiceCall(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.call(method, path, body, CALL_TIMEOUT_MS, signal);
    if (!response.ok) throw await voiceRefused(response);
    const read: unknown = await response.json().catch(() => undefined);
    if (read === undefined) throw new ScenesUnreachableError(`The scenes service answered ${method} ${path} with something that is not JSON.`);
    return read;
  }

  /**
   * Starts a new video that makes one beat of a finished one again, copied from it, so the finished one stays as it
   * is. `refused` with the service's own words when it will not: the video is not done, its draft is gone, it has no
   * such beat, or it is an older service without remakes.
   */
  async remakeScene(id: string, remake: ScenesRemake, signal?: AbortSignal): Promise<{ ok: true } | { refused: string; code: string }> {
    const response = await this.call("POST", `/videos/${encodeURIComponent(id)}/remake-scene`, remake, CALL_TIMEOUT_MS, signal);
    if (response.ok) return { ok: true };
    if (response.status >= 500 || response.status === 401 || response.status === 403) throw await refused(response, "make a scene again");
    const body: unknown = await response.json().catch(() => undefined);
    const code = isRecord(body) ? (text(body.error) ?? "refused") : "refused";
    return { refused: (isRecord(body) ? text(body.message) : undefined) ?? (response.status === 404 ? "The scenes service no longer has this video." : `The scenes service would not make a scene again (HTTP ${response.status}).`), code: response.status === 404 && code === "not_found" ? "draft_gone" : code };
  }

  /** Sends Open Sourcebook's problems back to the agent; false when the service will not take them for this video. */
  async revise(id: string, problems: string[], signal?: AbortSignal): Promise<boolean> {
    const response = await this.call("POST", `/videos/${encodeURIComponent(id)}/revise`, { problems }, CALL_TIMEOUT_MS, signal);
    if (response.ok) return true;
    if (response.status === 409 || response.status === 404) return false;
    throw await refused(response, "take the problems back");
  }

  /** A style's picture as the service sends it, or undefined when it has none for that id. */
  async preview(styleId: string, signal?: AbortSignal): Promise<Response | undefined> {
    const response = await this.call("GET", `/styles/${encodeURIComponent(styleId)}/preview`, undefined, CALL_TIMEOUT_MS * 3, signal).catch(() => undefined);
    return response?.ok ? response : undefined;
  }

  private async call(method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(`${this.config.url.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.config.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ScenesUnreachableError(`The scenes service at ${this.config.url} did not answer ${method} ${path}: ${String(error)}`);
    }
  }
}

async function refused(response: Response, what: string): Promise<Error> {
  const text = await response.text().catch(() => "");
  const message = `The scenes service would not ${what} (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`;
  return response.status >= 500 || response.status === 401 || response.status === 403 ? new ScenesUnreachableError(message) : new Error(message);
}

/** A voice change refused in the service's own code and words; a service with no voice setup (older) or that failed is unreachable. */
async function voiceRefused(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const code = isRecord(body) ? text(body.error) : undefined;
  const message = isRecord(body) ? text(body.message) : undefined;
  if (response.status >= 500 && response.status !== 502) return new ScenesUnreachableError(`The scenes service failed a voice call (HTTP ${response.status}).`);
  if (response.status === 401 || response.status === 403 || !code) return new ScenesUnreachableError(`The scenes service has no voice setup to answer (HTTP ${response.status}).`);
  return new ScenesVoiceError(response.status, code, message ?? code);
}

const TROUBLES: readonly VoiceTrouble[] = ["credits", "refused", "unreachable"];

/** A service view, field by field: anything else the service sent (never a key) is left behind. */
function readServiceView(value: unknown): VoiceServiceView | undefined {
  if (!isRecord(value) || !text(value.id) || !text(value.label)) return undefined;
  const install = isRecord(value.install) && text(value.install.command) ? { command: text(value.install.command)!, ...(text(value.install.folder) ? { folder: text(value.install.folder)! } : {}) } : undefined;
  const health = isRecord(value.health)
    ? value.health.ok === true
      ? { ok: true as const }
      : TROUBLES.includes(value.health.trouble as VoiceTrouble)
        ? { ok: false as const, trouble: value.health.trouble as VoiceTrouble, message: text(value.health.message) ?? "" }
        : undefined
    : undefined;
  const hint = text(value.keyHint);
  // A few short plain sentences at most.
  const keySteps = Array.isArray(value.keySteps) ? value.keySteps.flatMap((step) => (typeof step === "string" && step.trim() && step.length <= 400 ? [step.trim()] : [])).slice(0, 8) : [];
  return {
    id: text(value.id)!,
    label: text(value.label)!,
    where: value.where === "local" ? "local" : "hosted",
    about: text(value.about) ?? "",
    needsKey: value.needsKey === true,
    ...(text(value.keyLabel) ? { keyLabel: text(value.keyLabel)! } : {}),
    ...(text(value.keyHelpUrl) && /^https:\/\//.test(text(value.keyHelpUrl)!) ? { keyHelpUrl: text(value.keyHelpUrl)! } : {}),
    ...(keySteps.length ? { keySteps } : {}),
    ...(typeof value.keySet === "boolean" ? { keySet: value.keySet } : {}),
    // Four characters at most, whatever was sent: the browser never sees more of a key.
    ...(hint && hint.length <= 4 ? { keyHint: hint } : {}),
    ...(typeof value.installed === "boolean" ? { installed: value.installed } : {}),
    ...(install ? { install } : {}),
    listsVoices: value.listsVoices === true,
    samples: value.samples === true,
    ...(health ? { health } : {}),
  };
}

function readVoiceSetup(body: unknown): VoiceSetup {
  if (!isRecord(body) || !Array.isArray(body.services)) throw new ScenesUnreachableError("The scenes service answered with a voice setup it did not describe.");
  const voice = isRecord(body.voice) && text(body.voice.id) ? { id: text(body.voice.id)!, label: text(body.voice.label) ?? text(body.voice.id)! } : undefined;
  return {
    ...(text(body.service) ? { service: text(body.service)! } : {}),
    ...(voice ? { voice } : {}),
    from: body.from === "app" || body.from === "env" ? body.from : "none",
    ...(text(body.note) ? { note: text(body.note)! } : {}),
    services: body.services.flatMap((s) => {
      const view = readServiceView(s);
      return view ? [view] : [];
    }),
  };
}

function readVoiceOption(value: unknown): VoiceOption | undefined {
  if (!isRecord(value) || !text(value.id)) return undefined;
  return {
    id: text(value.id)!,
    label: text(value.label) ?? text(value.id)!,
    ...(text(value.description) ? { description: text(value.description)! } : {}),
    ...(text(value.language) ? { language: text(value.language)! } : {}),
    sample: value.sample === true,
  };
}

const STATES: readonly ScenesState[] = ["writing", "voicing", "rendering", "done", "failed", "stopped"];
const FAILURES: readonly ScenesFailureCode[] = ["agentUnreachable", "agentMissing", "agentSignedOut", "agentLimit", "agentError", "timedOut", "stopped", "scriptRefused", "voiceDown", "error"];

function readStatus(body: Record<string, unknown>): ScenesStatus {
  const maker = isRecord(body.maker) && typeof body.maker.id === "string" ? body.maker : undefined;
  const agent = isRecord(body.agent) ? body.agent : undefined;
  const voice = isRecord(body.voice) && typeof body.voice.id === "string" ? body.voice : undefined;
  const styles = (Array.isArray(body.styles) ? body.styles : [])
    .filter(isRecord)
    .filter((style) => typeof style.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(style.id))
    .map((style) => ({ id: style.id as string, label: text(style.label) ?? (style.id as string), description: text(style.description) ?? "", offered: style.offered !== false }))
    .filter((style) => style.description);
  const speed: Record<string, ScenesSpeed> = {};
  if (isRecord(body.speed)) {
    for (const [id, value] of Object.entries(body.speed)) {
      if (isRecord(value) && typeof value.framesPerSecond === "number" && value.framesPerSecond > 0 && Number.isFinite(value.framesPerSecond)) {
        speed[id] = { framesPerSecond: value.framesPerSecond, setupSeconds: typeof value.setupSeconds === "number" && value.setupSeconds >= 0 ? value.setupSeconds : 0 };
      }
    }
  }
  const made = (Array.isArray(body.made) ? body.made : [])
    .filter(isRecord)
    .flatMap((one) =>
      typeof one.seconds === "number" && one.seconds > 0 && Number.isFinite(one.seconds) && typeof one.videoSeconds === "number" && one.videoSeconds > 0 && Number.isFinite(one.videoSeconds)
        ? [
            {
              seconds: one.seconds,
              videoSeconds: one.videoSeconds,
              ...(text(one.agent) ? { agent: text(one.agent)! } : {}),
              ...(text(one.model) ? { model: text(one.model)! } : {}),
              ...(text(one.effort) ? { effort: text(one.effort)! } : {}),
            },
          ]
        : [],
    );
  return {
    reachable: true,
    ...(maker ? { maker: { id: maker.id as string, label: text(maker.label) ?? (maker.id as string), description: text(maker.description) ?? "" } } : {}),
    ...(agent
      ? {
          agent: {
            reachable: agent.reachable === true,
            ...(text(agent.id) ? { id: text(agent.id)! } : {}),
            ...(text(agent.label) ? { label: text(agent.label)! } : {}),
            ...(text(agent.model) ? { model: text(agent.model)! } : {}),
            ...(text(agent.effort) ? { effort: text(agent.effort)! } : {}),
            ...(text(agent.problem) ? { problem: text(agent.problem)! } : {}),
          },
        }
      : {}),
    ...(voice ? { voice: { id: voice.id as string, label: text(voice.label) ?? (voice.id as string), ...(typeof voice.real === "boolean" ? { real: voice.real } : {}), ...(text(voice.note) ? { note: text(voice.note)! } : {}) } } : {}),
    styles,
    ...(isRecord(body.audio) ? { audio: { ready: body.audio.ready === true, ...(text(body.audio.problem) ? { problem: text(body.audio.problem)! } : {}) } } : {}),
    ...(Object.keys(speed).length ? { speed } : {}),
    ...(made.length ? { made } : {}),
  };
}

function readJob(body: unknown): ScenesJob | undefined {
  if (!isRecord(body) || typeof body.id !== "string" || !STATES.includes(body.state as ScenesState)) return undefined;
  const failure = isRecord(body.failure) ? body.failure : undefined;
  return {
    id: body.id,
    state: body.state as ScenesState,
    progress: typeof body.progress === "number" && Number.isFinite(body.progress) ? Math.min(1, Math.max(0, body.progress)) : 0,
    step: text(body.step) ?? "",
    steps: (Array.isArray(body.steps) ? body.steps : []).filter(isRecord).map((step) => ({ label: text(step.label) ?? "", at: text(step.at) ?? "" })),
    ...(text(body.style) ? { style: text(body.style)! } : {}),
    ...(failure
      ? {
          failure: {
            code: FAILURES.includes(failure.code as ScenesFailureCode) ? (failure.code as ScenesFailureCode) : "error",
            message: text(failure.message) ?? "",
            ...(text(failure.detail) ? { detail: text(failure.detail)! } : {}),
            ...(text(failure.said) ? { said: text(failure.said)!.slice(0, 300) } : {}),
            ...limitOf(failure.limit),
            ...(readTrouble(failure.voice) ? { voice: readTrouble(failure.voice)! } : {}),
          },
        }
      : {}),
    ...(isRecord(body.result) ? { result: body.result as unknown as ScenesResult } : {}),
    ...(typeof body.draft === "boolean" ? { draft: body.draft } : {}),
  };
}

function limitOf(value: unknown): { limit?: { resetsAt?: string; resets?: string } } {
  if (!isRecord(value)) return {};
  const resetsAt = typeof value.resetsAt === "string" && Number.isFinite(Date.parse(value.resetsAt)) ? value.resetsAt : undefined;
  const resets = text(value.resets)?.slice(0, 80);
  return resetsAt || resets ? { limit: { ...(resetsAt ? { resetsAt } : {}), ...(resets ? { resets } : {}) } } : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * What the service last said, per service URL, so descriptors (built on
 * every request) and the checks before Start read it without calling out.
 * A good answer is kept a little while, a missing one only briefly, so a
 * service just started shows up within seconds.
 */
const statusCache = new Map<string, { at: number; status: ScenesStatus }>();
const FRESH_MS = 20_000;
const FRESH_WHEN_DOWN_MS = 3_000;

export function cachedScenesStatus(url: string): ScenesStatus | undefined {
  return statusCache.get(url)?.status;
}

/** Asks the service again unless what it said is still fresh. */
export async function refreshScenesStatus(client: ScenesClient, now: number = Date.now()): Promise<ScenesStatus> {
  const kept = statusCache.get(client.config.url);
  if (kept && now - kept.at < (kept.status.reachable ? FRESH_MS : FRESH_WHEN_DOWN_MS)) return kept.status;
  const status = await client.status();
  statusCache.set(client.config.url, { at: now, status });
  return status;
}

/** Asks the service now, whatever is kept, and keeps the answer (after a change of voice, so readiness follows at once). */
export async function refreshScenesStatusNow(client: Pick<ScenesClient, "config" | "status">, now: number = Date.now()): Promise<ScenesStatus> {
  const status = await client.status();
  statusCache.set(client.config.url, { at: now, status });
  return status;
}

/** Keeps a status just read (a direct status call) for the next readers. */
export function rememberScenesStatus(url: string, status: ScenesStatus, now: number = Date.now()): void {
  statusCache.set(url, { at: now, status });
}

/** For tests: forget what every service said. */
export function forgetScenesStatus(): void {
  statusCache.clear();
}
