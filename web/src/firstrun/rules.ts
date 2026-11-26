import type { Provider, SetupState } from "../api/types";

/**
 * Whether the first-time steps are still to do: setup is not marked done, and
 * the person has not already connected an agent and passed the voice step,
 * by choosing a voice or by skipping it (someone who set Open Sourcebook up
 * before the steps existed never sees them).
 */
export function needsSetup(state: SetupState): boolean {
  return !state.done && !(state.providers.connected > 0 && voicePassed(state));
}

/** The voice step is behind the person: a voice is chosen, or they skipped it. */
export function voicePassed(state: SetupState): boolean {
  return state.voice.set || state.voice.skipped;
}

/** Which step a person is on: the first one still to do. */
export function firstStep(state: SetupState): "setup" | "voice" | "try" {
  if (state.providers.connected === 0) return "setup";
  return state.voice.skipped && !state.voice.set ? "try" : "voice";
}

/** Connected is in the person's list and turned on; that, and nothing else, is what Next waits for. */
export const isConnected = (p: Provider) => p.added && p.enabled;

/** A to Z by name, whatever order the engine listed them in. */
export function byName(list: Provider[]): Provider[] {
  return [...list].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/** "2 providers connected · no voice yet", from what the engine says is set. */
export function summaryLine(connected: number, voiceSet: boolean): string {
  const agents = `${connected} ${connected === 1 ? "provider" : "providers"} connected`;
  return `${agents} · ${voiceSet ? "voice set" : "no voice yet"}`;
}
