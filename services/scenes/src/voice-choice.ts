/**
 * Which voice a video gets, and the words that tell the person. One place decides both, so the service's status, the
 * launcher's check and everything that shows a maker say the same thing. It reads the voice services' own list
 * (`voices.ts`) and names none of them; the launcher reads it before the service is running.
 *
 * `SCENES_VOICE` names a service. With none named, the first hosted service whose key is set is the voice (the list's
 * order: A to Z by label); with no key, the video is made without sound, on every system, and its captions carry the
 * words. Nothing falls back to a voice by itself: a voice on this computer is there once a person installs it and picks
 * it, and this computer's own robotic voice (`say`) is only for a person's own quick test.
 *
 * The settings read here are the environment with the private voice file laid over it (`voice-file.ts`), so a choice
 * made in the app wins over `services/scenes/.env`.
 */
import { setting, voiceServices, type VoiceService } from "./voices.ts";

export type VoiceKind = string;

export interface VoiceChoice {
  /** The id of the voice service. */
  kind: VoiceKind;
  /** What a person should know about it, in a line with what to do; absent when it is the voice they want. */
  note?: string;
}

/** What this computer has installed that a voice needs, by service id; unknown counts as there. */
export type VoiceFacts = Record<string, boolean | undefined>;

/** What a person does for a voice. */
export const VOICE_HOW = "pick one in Settings, under Voice";

export const NO_KEY_NOTE = `No voice set up: videos are made without sound, with captions carrying the words. For a voice, ${VOICE_HOW}.`;
const OFF_NOTE = "Videos are made without sound (SCENES_VOICE=silent), with captions carrying the words.";
const SAY_NOTE = `Videos use this computer's own voice, which is robotic, because SCENES_VOICE=say is set as a quick test. For a real voice, ${VOICE_HOW}.`;

/** What a person runs to install a voice on this computer. */
export function installHow(service: VoiceService): string {
  if (!service.install) return "install it";
  return `run ${service.install.command}${service.install.folder ? ` in ${service.install.folder}` : ""}`;
}

/** The hosted service a key picks when none is named: the first in the list whose key is set. */
function keyed(settings: Record<string, string | undefined>, services: VoiceService[]): VoiceService | undefined {
  return services.find((s) => s.offered && s.key && setting(settings, s.key.name));
}

/** The voice these settings give. Throws for a name that is no voice, a service asked for with no key, or one not installed. */
export function chooseVoice(settings: Record<string, string | undefined>, has: VoiceFacts = {}, services: VoiceService[] = voiceServices()): VoiceChoice {
  const wanted = setting(settings, "SCENES_VOICE") || keyed(settings, services)?.id || "silent";
  if (wanted === "silent") return { kind: "silent", note: keyed(settings, services) ? OFF_NOTE : NO_KEY_NOTE };
  if (wanted === "say") return { kind: "say", note: SAY_NOTE };
  const service = services.find((s) => s.id === wanted);
  if (!service) throw new Error(`SCENES_VOICE=${wanted} is not a voice this service has (${services.map((s) => s.id).join(", ")}).`);
  if (service.key && !setting(settings, service.key.name)) throw new Error(`SCENES_VOICE=${wanted} needs ${service.key.name}.`);
  if (service.install && has[service.id] === false) throw new Error(`SCENES_VOICE=${wanted} needs it installed on this computer: ${installHow(service)}.`);
  return { kind: service.id };
}

/** What each local service's install says now, for `chooseVoice`. */
export function installedFacts(services: VoiceService[] = voiceServices()): VoiceFacts {
  return Object.fromEntries(services.filter((s) => s.installed).map((s) => [s.id, s.installed!()]));
}
