/**
 * The check before starting (also `opensourcebook check` on its own): what this computer has and what it lacks, one plain line
 * each, with what to do about anything missing. Gathering the facts (gather) is kept apart from the wording (lines),
 * so the wording is tested without this computer.
 */
import { carryOldNames } from "./old-names.ts";
import { stateFolder } from "./state.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHROME_SIZE, findChrome } from "./chrome.ts";
import { readEnvFile } from "./envfile.ts";
import { missingPackages } from "./install.ts";
import { PROGRAMS } from "./programs.ts";

export interface AgentFacts {
  id: string;
  label: string;
  installed: boolean;
  version?: string;
  signedIn?: boolean;
  unavailable?: string;
  signIn?: string;
  /** Not signed in, but it answers with an API key the person gave the connector. */
  apiKey?: boolean;
  /** How it answers, in the adapter's own words, when that is worth saying. */
  note?: string;
}

/** It can answer the chat: installed, nothing in the way, and signed in, or on a key, or with no sign-in to ask about. */
const canAnswer = (a: AgentFacts) => a.installed && !a.unavailable && (a.signedIn !== false || !!a.apiKey);

export interface Facts {
  platform: NodeJS.Platform;
  node: string;
  ffmpeg: string | null;
  agents: AgentFacts[] | { error: string };
  /** What the scenes service would say about its voice (`services/scenes/src/voice-choice.ts`): no note when it is the voice a person wants. */
  voice: { note?: string; problem?: string; kind?: string };
  chrome: string | null;
  missingPackages: string[];
  webDevVars: boolean;
}

export type Status = "ok" | "note" | "missing";
export interface Line {
  status: Status;
  text: string;
  /** True when Open Sourcebook cannot start at all without it. */
  blocks?: boolean;
  /** Set when the line is something to know about what Open Sourcebook will make, not a thing that is missing (a video without sound). */
  notice?: boolean;
}

export const NODE_MAJOR = 24;

export function nodeLine(version: string): Line {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (major >= NODE_MAJOR) return { status: "ok", text: `Node ${version.replace(/^v/, "")}` };
  return { status: "missing", blocks: true, text: `Node ${version.replace(/^v/, "")} is too old: install Node ${NODE_MAJOR} from nodejs.org (or run \`nvm install ${NODE_MAJOR}\`), check it with \`node --version\`, and run this again.` };
}

export function ffmpegLine(version: string | null, platform: NodeJS.Platform): Line {
  if (version) return { status: "ok", text: `ffmpeg ${version}` };
  const how = platform === "darwin" ? "`brew install ffmpeg` (Homebrew is at brew.sh; without it, download ffmpeg from ffmpeg.org/download.html)" : platform === "win32" ? "`winget install ffmpeg` (or download it from ffmpeg.org/download.html)" : "`sudo apt install ffmpeg` (or your system's package manager, or ffmpeg.org/download.html)";
  return { status: "missing", text: `ffmpeg is missing, so videos can't be made: install it with ${how}, then start again. \`ffmpeg -version\` says whether it is there.` };
}

/** "A", "A and B", "A, B and C". */
const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export function agentLines(agents: AgentFacts[] | { error: string }): Line[] {
  if (!Array.isArray(agents)) return [{ status: "missing", text: `Couldn't ask which coding agents are installed (${agents.error}); the chat may not answer.` }];
  const ready = agents.filter(canAnswer);
  const lines: Line[] = agents.filter((a) => a.installed).map((a): Line => {
    const name = `${a.label}${a.version ? ` ${a.version}` : ""}`;
    if (a.unavailable) return { status: "note", text: `${name} is installed; Open Sourcebook can't answer the chat with it yet.` };
    if (!canAnswer(a)) return { status: ready.length ? "note" : "missing", text: `${name} is installed but not signed in: run \`${a.signIn ?? `${a.id} login`}\` in a terminal.` };
    return { status: "ok", text: a.signedIn && !a.apiKey ? `${name}, signed in` : `${name}: ${a.note ?? "ready"}` };
  });
  // The agents this computer doesn't have are one line, not one each: they are choices, not problems.
  const absent = agents.filter((a) => !a.installed).map((a) => a.label);
  if (absent.length) {
    const text = agents.some((a) => a.installed)
      ? `Open Sourcebook also works with ${listed(absent)}, ${absent.length === 1 ? "which isn't" : "which aren't"} installed here.`
      : `Open Sourcebook works with ${listed(absent)}; none is installed here.`;
    lines.push({ status: "note", text });
  }
  if (!ready.length) {
    const usable = agents.find((a) => !a.unavailable);
    const installedNotSignedIn = agents.some((a) => a.installed && !a.unavailable && !canAnswer(a));
    if (usable && !installedNotSignedIn) lines.push({ status: "missing", text: `No coding agent is ready, so the chat can't answer: install ${usable.label} and sign in with \`${usable.signIn ?? `${usable.id} login`}\`.` });
  }
  return lines;
}

/** The voice's line, in the scenes service's own words: the same wording its status gives the engine, the web and the `opensourcebook` answers. */
export function voiceLine(voice: Facts["voice"]): Line {
  if (voice.problem) return { status: "missing", text: `The voice setting is wrong: ${voice.problem}` };
  if (voice.kind === "kokoro") return { status: "ok", text: "Voice: Kokoro, on this computer" };
  if (voice.kind === "speechify") return { status: "ok", text: "Voice key set (Speechify)" };
  if (!voice.note) return { status: "ok", text: "Voice key set (ElevenLabs)" };
  return { status: "note", notice: true, text: voice.note };
}

export function chromeLine(path: string | null): Line {
  if (path) return { status: "ok", text: "The browser that draws videos is downloaded" };
  return { status: "note", text: `The browser that draws videos is not downloaded yet; starting Open Sourcebook downloads it once (${CHROME_SIZE}).` };
}

export function packagesLine(missing: string[]): Line | undefined {
  if (!missing.length) return undefined;
  const names = missing.map((dir) => PROGRAMS.find((p) => p.dir === dir)?.label ?? dir);
  return { status: "note", text: `What the ${names.join(", ")} need${names.length === 1 ? "s" : ""} is not installed yet; starting Open Sourcebook installs it once (a few minutes).` };
}

export function webDevVarsLine(present: boolean): Line | undefined {
  if (!present) return undefined;
  return { status: "note", text: "web/.dev.vars is there, so with --dev the web app reads it instead of the launcher's settings (and does not keep the engine to the browser Open Sourcebook opens); move it away if the app can't reach the engine or says to start Open Sourcebook." };
}

export function lines(f: Facts): Line[] {
  return [
    nodeLine(f.node),
    ffmpegLine(f.ffmpeg, f.platform),
    ...agentLines(f.agents),
    voiceLine(f.voice),
    chromeLine(f.chrome),
    packagesLine(f.missingPackages),
    webDevVarsLine(f.webDevVars),
  ].filter((l): l is Line => Boolean(l));
}

const MARK: Record<Status, string> = { ok: "ok  ", note: "note", missing: "fix " };

export function render(all: Line[]): string {
  return all.map((l) => `  ${MARK[l.status]}  ${l.text}`).join("\n");
}

/** The first line a command prints, or null when it can't be run. */
export function firstLineOf(command: string, args: string[]): string | null {
  const run = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (run.error || run.status !== 0) return null;
  return (run.stdout || run.stderr).split(/\r?\n/)[0]?.trim() || null;
}

/** What the connector's registry says about each agent: the same code the connector runs for its status route. */
async function agentFacts(root: string, env: NodeJS.ProcessEnv): Promise<AgentFacts[] | { error: string }> {
  try {
    const registry = (await import(pathToFileURL(join(root, "services", "agent-connector", "src", "agents", "registry.ts")).href)) as {
      agentBins(env: NodeJS.ProcessEnv): Record<string, string | undefined>;
      createDefaultAgents(bins: Record<string, string | undefined>): { list(): Array<{ id: string; label: string; signIn?: string; info(): Promise<Omit<AgentFacts, "id" | "label" | "signIn">> }> };
    };
    const agents = registry.createDefaultAgents(registry.agentBins(env)).list();
    return await Promise.all(agents.map(async (a) => ({ id: a.id, label: a.label, ...(a.signIn ? { signIn: a.signIn } : {}), ...(await a.info()) })));
  } catch (error) {
    return { error: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
}

/** The voice these settings give, asked of the scenes service's own code, so the words are never written twice. */
async function voiceFacts(root: string, env: Record<string, string | undefined>, installed?: Record<string, boolean | undefined>): Promise<Facts["voice"]> {
  try {
    const scenes = join(root, "services", "scenes", "src");
    type Settings = Record<string, string | undefined>;
    const choice = (await import(pathToFileURL(join(scenes, "voice-choice.ts")).href)) as { chooseVoice(env: Settings, has: Record<string, boolean | undefined>): { kind: string; note?: string }; installedFacts(): Record<string, boolean | undefined> };
    const file = (await import(pathToFileURL(join(scenes, "voice-file.ts")).href)) as { readVoiceFile(file: string, names: Set<string>): Record<string, string>; voiceFileNames(services: unknown[]): Set<string>; layered(env: Settings, file: Record<string, string>): Settings };
    const list = (await import(pathToFileURL(join(scenes, "voices.ts")).href)) as { voiceServices(): unknown[] };
    // The voice chosen in the app is kept in a private file laid over the settings, as the service reads it.
    const path = env.SCENES_VOICE_FILE?.trim() || join(stateFolder(root, env), "voice.json");
    const settings = file.layered(env, file.readVoiceFile(path, file.voiceFileNames(list.voiceServices())));
    const { kind, note } = choice.chooseVoice(settings, installed ?? choice.installedFacts());
    return note ? { note } : kind === "kokoro" || kind === "speechify" ? { kind } : {};
  } catch (error) {
    return { problem: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
}

export interface GatherOptions {
  /** For tests: what each voice that runs on this computer says of its install, instead of asking it. */
  voicesInstalled?: Record<string, boolean | undefined>;
}

export async function gather(root: string, env: NodeJS.ProcessEnv = process.env, options: GatherOptions = {}): Promise<Facts> {
  const ffmpeg = firstLineOf(env.FFMPEG_PATH || "ffmpeg", ["-version"]);
  const scenesEnv = readEnvFile(join(root, "services", "scenes", ".env"));
  return {
    platform: process.platform,
    node: process.versions.node,
    ffmpeg: ffmpeg ? (/ffmpeg version (\S+)/.exec(ffmpeg)?.[1] ?? ffmpeg) : null,
    agents: await agentFacts(root, env),
    voice: await voiceFacts(root, carryOldNames({ ...scenesEnv, ...env }), options.voicesInstalled),
    chrome: findChrome(root, env),
    missingPackages: missingPackages(root, stateFolder(root, env)),
    webDevVars: existsSync(join(root, "web", ".dev.vars")),
  };
}
