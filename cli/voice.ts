/**
 * Installing a voice that runs on this computer: each is a folder of its own in `services/scenes/voices/<id>/` with a
 * `package.json`, installed with npm into that folder only. The npm used is the one beside the Node running this, put
 * first on the PATH, so a computer whose Node came with the one-line install (no npm of its own on the PATH) can
 * install it too. Used by `opensourcebook voice install <id>` and by the voice screen's button through the launcher.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Where the voices that run on this computer are, in a copy of Open Sourcebook. */
export const voicesFolder = (root: string) => join(root, "services", "scenes", "voices");

/** The voices that can be installed here: each folder of `voicesFolder` with a `package.json`. */
export function localVoices(root: string): string[] {
  try {
    return readdirSync(voicesFolder(root), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(voicesFolder(root), d.name, "package.json")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** The environment npm runs in: the folder of the Node running this first on the PATH, so npm and its scripts find it. */
export function withOwnNode(env: NodeJS.ProcessEnv, node: string = process.execPath): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const rest = env[key];
  return { ...env, [key]: rest ? `${dirname(node)}${delimiter}${rest}` : dirname(node) };
}

export interface VoiceInstall {
  ok: boolean;
  /** Where npm's output went. */
  log: string;
}

/**
 * Installs voice `id` into its folder (`npm ci`, or `npm install` without a lockfile), npm's output to `log`, each line
 * also to `onLine`. Resolves with whether it worked; a name that is not a voice folder is refused before anything runs.
 */
export function installVoice(root: string, id: string, log: string, options: { env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; npm?: string } = {}): Promise<VoiceInstall> {
  if (!localVoices(root).includes(id)) throw new Error(`"${id}" is not a voice that runs on this computer; there are ${localVoices(root).join(", ") || "none"}.`);
  const dir = join(voicesFolder(root), id);
  mkdirSync(dirname(log), { recursive: true });
  const out = createWriteStream(log, { flags: "w" });
  const args = existsSync(join(dir, "package-lock.json")) ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
  const npm = options.npm ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd: dir, env: withOwnNode(options.env ?? process.env), stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
    let rest = "";
    const lines = (chunk: Buffer) => {
      out.write(chunk);
      rest += chunk.toString();
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) options.onLine?.(line.trim());
    };
    child.stdout.on("data", lines);
    child.stderr.on("data", lines);
    // Answered once the log is written out, so whoever reads it next sees all of it.
    child.once("error", (error) => {
      out.end(`\n${error.message}\n`, () => resolve({ ok: false, log }));
    });
    child.once("close", (code) => {
      if (rest.trim()) options.onLine?.(rest.trim());
      out.end(() => resolve({ ok: code === 0, log }));
    });
  });
}

/** What the voice screen's button sees of an install the launcher runs: one at a time per voice. */
export type InstallState = { state: "idle" } | { state: "installing"; since: string } | { state: "done" } | { state: "failed"; message: string };

/** The installs the launcher runs for the voice screen, one per voice at a time. */
export class VoiceInstalls {
  private readonly states = new Map<string, InstallState>();
  private readonly o: { root: string; home: string; env?: NodeJS.ProcessEnv; npm?: string };

  constructor(options: { root: string; home: string; env?: NodeJS.ProcessEnv; npm?: string }) {
    this.o = options;
  }

  has(id: string): boolean {
    return localVoices(this.o.root).includes(id);
  }

  state(id: string): InstallState {
    return this.states.get(id) ?? { state: "idle" };
  }

  /** Starts installing `id` unless it is installing already; answers with its state. */
  start(id: string): InstallState {
    const now = this.state(id);
    if (now.state === "installing") return now;
    const started: InstallState = { state: "installing", since: new Date().toISOString() };
    this.states.set(id, started);
    const log = join(this.o.home, "logs", `voice-${id}.log`);
    installVoice(this.o.root, id, log, { ...(this.o.env ? { env: this.o.env } : {}), ...(this.o.npm ? { npm: this.o.npm } : {}) })
      .then((r) => this.states.set(id, r.ok ? { state: "done" } : { state: "failed", message: `It did not finish. What it said is in ${r.log}.` }))
      .catch((error: unknown) => this.states.set(id, { state: "failed", message: error instanceof Error ? error.message : String(error) }));
    return started;
  }
}
