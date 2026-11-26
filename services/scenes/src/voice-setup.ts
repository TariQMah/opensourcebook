/**
 * The voice as the app sets it up: which service speaks, its key and which of its voices. It holds the voice this
 * service speaks with now and builds it again after every change (the environment with the private voice file laid
 * over it, `voice-file.ts`), so a change takes effect at once; a video or an audio already being voiced keeps the voice
 * it started with (`jobs.ts`, `audio.ts`).
 *
 * A key never leaves: every answer says only whether one is set and its last four characters, nothing here logs one,
 * and a service's own words about a key are cleaned of it before they are passed on. A key the service refuses is not
 * kept; one that is good but out of credits is kept, and its health says so.
 */
import { chooseVoice, installHow, installedFacts } from "./voice-choice.ts";
import { layered, readVoiceFile, voiceFileNames, writeVoiceFile } from "./voice-file.ts";
import { silentVoice, voiceDownOf, type Voice, type VoiceHealth } from "./voice.ts";
import { NoSample, setting, voiceServices, type VoiceOption, type VoiceService, type VoiceSettings } from "./voices.ts";

/** A service as the app shows it: never its key, only whether one is set and its last four characters. */
export interface VoiceServiceView {
  id: string;
  label: string;
  where: "hosted" | "local";
  about: string;
  needsKey: boolean;
  keyLabel?: string;
  keyHelpUrl?: string;
  keySet?: boolean;
  keyHint?: string;
  installed?: boolean;
  install?: { command: string; folder?: string };
  listsVoices: boolean;
  /** Whether the service offers a sample of its voices to hear; when not, every voice in its list says `sample: false`. */
  samples: boolean;
  health?: VoiceHealth;
}

export interface VoiceSetupView {
  /** The chosen service; absent when there is none (videos without sound). */
  service?: string;
  voice?: { id: string; label: string };
  /** Where the choice comes from: the app's file, `services/scenes/.env`, or nothing. */
  from: "app" | "env" | "none";
  /** The plain line to show (no voice: what happens). */
  note?: string;
  services: VoiceServiceView[];
}

/** A change the setup will not make, with its HTTP status and code. */
export class VoiceSetupError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "VoiceSetupError";
  }
}

export interface VoiceSetupOptions {
  /** The environment (with `services/scenes/.env` read into it). */
  env: Record<string, string | undefined>;
  /** The private voice file. */
  file: string;
  /** Where spoken words are kept so they are never paid for twice. */
  cacheDir?: string;
  /** The voice services; the real list by default (tests give their own). */
  services?: () => VoiceService[];
  /** What is installed here, by local service; each service's own check by default. */
  installed?: () => Record<string, boolean | undefined>;
}

/** A key is hinted at by its last four characters only when it is long enough that four say little. */
const HINT_FROM = 12;
const MOST_KEY = 400;
const MOST_VOICE_ID = 200;
/** How long a service's list of voices is kept for naming the chosen one. */
const LIST_KEPT_MS = 5 * 60_000;

export class VoiceSetup {
  private voice: Voice;
  private readonly lists = new Map<string, { at: number; key: string; voices: VoiceOption[] }>();
  private readonly o: VoiceSetupOptions;

  constructor(o: VoiceSetupOptions) {
    this.o = o;
    this.voice = this.build();
  }

  /** The voice to speak with now. */
  current(): Voice {
    return this.voice;
  }

  /** The environment with the file over it: what the voice is built from. */
  settings(): VoiceSettings {
    return layered(this.o.env, this.file());
  }

  private services(): VoiceService[] {
    return (this.o.services ?? voiceServices)();
  }

  private file(): Record<string, string> {
    return readVoiceFile(this.o.file, voiceFileNames(this.services()));
  }

  private installed(): Record<string, boolean | undefined> {
    return this.o.installed ? this.o.installed() : installedFacts(this.services());
  }

  /** Builds the voice again from the settings. A setting that names no usable voice gives no sound, and says why. */
  private build(): Voice {
    const settings = this.settings();
    try {
      const choice = chooseVoice(settings, this.installed(), this.services());
      const service = this.services().find((s) => s.id === choice.kind);
      if (!service || choice.kind === "silent") return silentVoice(choice.note);
      const voice = service.build(settings, { ...(this.o.cacheDir ? { cacheDir: this.o.cacheDir } : {}) });
      return choice.note ? { ...voice, note: choice.note } : voice;
    } catch (error) {
      return silentVoice(`The voice setting is wrong: ${(error as Error).message} Videos are made without sound until it is fixed.`);
    }
  }

  private save(values: Record<string, string>): void {
    writeVoiceFile(this.o.file, values);
    this.voice = this.build();
  }

  private offered(id: string): VoiceService | undefined {
    return this.services().find((s) => s.id === id && s.offered);
  }

  private view(s: VoiceService, settings: VoiceSettings): VoiceServiceView {
    const key = s.key ? setting(settings, s.key.name) : undefined;
    return {
      id: s.id,
      label: s.label,
      where: s.where,
      about: s.about,
      needsKey: !!s.key,
      ...(s.key ? { keyLabel: s.key.label, keyHelpUrl: s.key.helpUrl, keySet: !!key } : {}),
      ...(key && key.length >= HINT_FROM ? { keyHint: key.slice(-4) } : {}),
      ...(s.installed ? { installed: s.installed() } : {}),
      ...(s.install ? { install: { ...s.install } } : {}),
      listsVoices: !!s.listVoices,
      samples: !!s.listVoices && !!s.sample,
    };
  }

  /** The setup as the app shows it. */
  async setup(signal?: AbortSignal): Promise<VoiceSetupView> {
    const settings = this.settings();
    const file = this.file();
    const services = this.services();
    let kind = "silent";
    try {
      kind = chooseVoice(settings, this.installed(), services).kind;
    } catch {
      // A setting that names no usable voice: no voice, and the note says why.
    }
    const service = services.find((s) => s.id === kind && s.offered);
    const fromApp = !!file.SCENES_VOICE || !!(service?.key && file[service.key.name]);
    const from = fromApp ? "app" : service ? "env" : "none";
    const voiceId = service?.voiceSetting ? setting(settings, service.voiceSetting) : undefined;
    const label = service && voiceId ? await this.voiceLabel(service, voiceId, settings, signal) : undefined;
    const note = this.voice.note;
    return {
      ...(service ? { service: service.id } : {}),
      ...(voiceId ? { voice: { id: voiceId, label: label ?? voiceId } } : {}),
      from,
      ...(note ? { note } : {}),
      services: services.filter((s) => s.offered).map((s) => this.view(s, settings)),
    };
  }

  /** The chosen voice's name, from the service's list when it can be read; else nothing. */
  private async voiceLabel(service: VoiceService, voiceId: string, settings: VoiceSettings, signal?: AbortSignal): Promise<string | undefined> {
    if (!service.listVoices) return undefined;
    const key = service.key ? setting(settings, service.key.name) : undefined;
    if (service.key && !key) return undefined;
    const list = await this.list(service, key, signal).catch(() => undefined);
    return list?.find((v) => v.id === voiceId)?.label;
  }

  private async list(service: VoiceService, key: string | undefined, signal?: AbortSignal): Promise<VoiceOption[]> {
    const kept = this.lists.get(service.id);
    if (kept && kept.key === (key ?? "") && Date.now() - kept.at < LIST_KEPT_MS) return kept.voices;
    const listed = await service.listVoices!(key, signal);
    // A service with no previews says so on every voice, so no play button is shown for one.
    const voices = service.sample ? listed : listed.map((voice) => ({ ...voice, sample: false }));
    this.lists.set(service.id, { at: Date.now(), key: key ?? "", voices });
    return voices;
  }

  /** Chooses the service (null: none, videos without sound) and, when given, its voice (null: the service's own). */
  async choose(input: unknown, signal?: AbortSignal): Promise<VoiceSetupView> {
    const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if (!("service" in body) || (body.service !== null && typeof body.service !== "string")) throw new VoiceSetupError(400, "invalid_request", "service: a voice service's id, or null for none.");
    if (body.voice !== undefined && body.voice !== null && (typeof body.voice !== "string" || !body.voice.trim() || body.voice.length > MOST_VOICE_ID)) throw new VoiceSetupError(400, "invalid_request", `voice: a voice id of 1 to ${MOST_VOICE_ID} characters, or null.`);
    const file = this.file();
    if (body.service === null) {
      this.save({ ...file, SCENES_VOICE: "silent" });
      return this.setup(signal);
    }
    const service = this.offered(body.service);
    if (!service) throw new VoiceSetupError(400, "unknown_voice_service", `There is no voice service "${body.service}".`);
    const settings = this.settings();
    if (service.key && !setting(settings, service.key.name)) throw new VoiceSetupError(409, "voice_needs_key", `${service.label} needs your key first.`);
    if (service.installed && !service.installed()) throw new VoiceSetupError(409, "voice_not_installed", `${service.label} is not installed yet: ${installHow(service)}, then check again.`);
    const next: Record<string, string> = { ...file, SCENES_VOICE: service.id };
    if (body.voice !== undefined) {
      if (!service.voiceSetting) throw new VoiceSetupError(400, "invalid_request", `${service.label} has no voices to pick from.`);
      if (body.voice === null) delete next[service.voiceSetting];
      else next[service.voiceSetting] = (body.voice as string).trim();
    }
    this.save(next);
    return this.setup(signal);
  }

  /** Checks a key with its service and keeps it when the service takes it (out of credits counts: the key is good). */
  async setKey(id: string, input: unknown, signal?: AbortSignal): Promise<{ service: VoiceServiceView }> {
    const service = this.offered(id);
    if (!service?.key) throw new VoiceSetupError(404, "not_found", "No such voice service with a key.");
    const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>).key : undefined;
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || key.length > MOST_KEY || /\s/.test(key)) throw new VoiceSetupError(400, "invalid_request", `key: the key as the service gave it, 1 to ${MOST_KEY} characters, no spaces.`);
    const checked = service.checkKey ? await service.checkKey(key, signal).catch((e: Error) => ({ ok: false as const, trouble: "unreachable" as const, message: e.message })) : ({ ok: true } as const);
    const health: VoiceHealth = checked.ok ? { ok: true } : { ok: false, trouble: checked.trouble, message: clean(checked.message, key) };
    if (!health.ok && health.trouble === "refused") throw new VoiceSetupError(422, "key_refused", `${service.label} did not take this key. Check it was copied whole, or make a new one. Nothing was saved.`);
    this.save({ ...this.file(), [service.key.name]: key });
    this.lists.delete(service.id);
    return { service: { ...this.view(service, this.settings()), health } };
  }

  /** Forgets the app's key for a service. A key in `services/scenes/.env` still counts. */
  async clearKey(id: string, signal?: AbortSignal): Promise<VoiceSetupView> {
    const service = this.offered(id);
    if (!service?.key) throw new VoiceSetupError(404, "not_found", "No such voice service with a key.");
    const next = { ...this.file() };
    delete next[service.key.name];
    // Chosen in the app and now with no key anywhere: the choice goes too, so the voice is what the rest says.
    if (next.SCENES_VOICE === service.id && !setting(this.o.env, service.key.name)) delete next.SCENES_VOICE;
    this.save(next);
    this.lists.delete(service.id);
    return this.setup(signal);
  }

  /** The voices on the person's account with this service. */
  async voices(id: string, signal?: AbortSignal): Promise<VoiceOption[]> {
    const service = this.offered(id);
    if (!service?.listVoices) throw new VoiceSetupError(404, "not_found", "That voice service has no voices to list.");
    const key = this.keyFor(service);
    try {
      return await this.list(service, key, signal);
    } catch (error) {
      throw unreachable(service, error, key);
    }
  }

  /** A short sample of one voice, from the service's own preview. */
  async sample(id: string, voiceId: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
    const service = this.offered(id);
    if (!service?.sample || !voiceId || voiceId.length > MOST_VOICE_ID) throw new VoiceSetupError(404, "not_found", "No sample for that voice.");
    const key = this.keyFor(service);
    try {
      return await service.sample(voiceId, key, signal);
    } catch (error) {
      if (error instanceof NoSample) throw new VoiceSetupError(404, "not_found", "No sample for that voice.");
      throw unreachable(service, error, key);
    }
  }

  private keyFor(service: VoiceService): string | undefined {
    const key = service.key ? setting(this.settings(), service.key.name) : undefined;
    if (service.key && !key) throw new VoiceSetupError(409, "voice_needs_key", `${service.label} needs your key first.`);
    return key;
  }
}

/** A service's words with the key taken out, whatever it echoed back. */
function clean(message: string, key: string | undefined): string {
  return key ? message.split(key).join("(your key)") : message;
}

function unreachable(service: VoiceService, error: unknown, key: string | undefined): VoiceSetupError {
  const down = voiceDownOf(error);
  const message = clean(down?.message ?? `${service.label} could not be read: ${(error as Error).message}`, key);
  return new VoiceSetupError(502, "voice_service_unreachable", message);
}
