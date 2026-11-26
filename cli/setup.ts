/**
 * What Get set up's buttons ask the launcher to do, for a person who never opens a terminal (the web app's
 * `web/src/setup/`): install a coding agent, start its own sign-in and watch it finish, and fetch ffmpeg. Each agent says
 * in its own adapter how it is installed and signed in (`AgentSetup` in services/agent-connector/src/agents/types.ts);
 * nothing here names one.
 *
 * - An agent is installed with npm, the Node Open Sourcebook runs on first on the PATH (the desktop app's own, or the
 *   one-line install's), from the package its adapter names, into Open Sourcebook's own folder: `agents/` in the app
 *   data folder, else in the state folder. That folder's programs are put first on the PATH of every program the
 *   launcher starts, so the connector finds an agent installed while it runs at its next check.
 * - A sign-in is the agent's own command, which opens the browser at the provider's login. The launcher only starts it
 *   and asks the agent, as the connector does, whether it is signed in yet. The login is made between the agent and its
 *   provider: Open Sourcebook never reads, holds or passes it on. The only thing passed on is the address of the
 *   provider's login page the agent prints, for when the browser did not open.
 * - ffmpeg is fetched the way the installer does it (install/package/lib/tools.mjs), into `tools/` with links in `bin/`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { appDataOf } from "./app-data.ts";
import { withOwnNode, type InstallState } from "./voice.ts";

/** The folder Open Sourcebook keeps the programs it fetched for the person in: the app data folder, else the state folder. */
export const ownFolder = (env: NodeJS.ProcessEnv, home: string) => appDataOf(env) ?? home;

/** npm's prefix for the agents a button installs. */
export const agentsPrefix = (env: NodeJS.ProcessEnv, home: string) => join(ownFolder(env, home), "agents");

/** Where npm puts the programs of a global install under `prefix`. */
export const prefixBin = (prefix: string, platform: NodeJS.Platform = process.platform) => (platform === "win32" ? prefix : join(prefix, "bin"));

/** The folders of programs Open Sourcebook fetched (ffmpeg's links, the agents' programs), first on the PATH. */
export function ownBins(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string[] {
  return [join(ownFolder(env, home), "bin"), prefixBin(agentsPrefix(env, home), platform)];
}

/** Puts `ownBins` first on `env`'s PATH (in whatever spelling it has), each once. */
export function useOwnBins(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): void {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = platform === "win32" ? ";" : ":";
  const bins = ownBins(env, home, platform);
  const rest = (env[key] ?? "").split(sep).filter((d) => d && !bins.includes(d));
  env[key] = [...bins, ...rest].join(sep);
}

/** What the launcher needs of an agent: the connector's adapter, as its registry makes it. */
export interface SetupAgent {
  id: string;
  label: string;
  setup?: { npm?: string; signIn?: readonly string[] };
  program?(): string;
  info(): Promise<{ installed: boolean; signedIn?: boolean }>;
}

/** The agents of the connector's registry, with where each program is from `<ID>_BIN` as the connector reads it. */
export async function registryAgents(root: string, env: NodeJS.ProcessEnv = process.env): Promise<SetupAgent[]> {
  const registry = (await import(pathToFileURL(join(root, "services", "agent-connector", "src", "agents", "registry.ts")).href)) as {
    createDefaultAgents(bins?: Record<string, string>): { list(): SetupAgent[] };
    agentBins(env: NodeJS.ProcessEnv): Record<string, string>;
  };
  return registry.createDefaultAgents(registry.agentBins(env)).list();
}

/** Where a sign-in stands: started (with the login page's address once the agent printed it), done, or failed. */
export type SignInState = { state: "idle" } | { state: "signingIn"; since: string; url?: string } | { state: "done" } | { state: "failed"; message: string };

/** What Get set up reads of one agent: whether a button can install it or sign in to it, and how that is going. */
export interface AgentSetupView {
  id: string;
  label: string;
  canInstall: boolean;
  canSignIn: boolean;
  install: InstallState;
  signIn: SignInState;
}

export interface SetupView {
  agents: AgentSetupView[];
  ffmpeg: { found: boolean; fetch: InstallState };
}

/** The first web address in what a program printed, without what usually ends a sentence. */
export function firstUrl(text: string): string | undefined {
  return /https:\/\/[^\s"'<>]+/.exec(text)?.[0]?.replace(/[).,;:]+$/, "");
}

export interface SetupOptions {
  root: string;
  /** The launcher's state folder; its `logs/` holds each install's words. */
  home: string;
  env?: NodeJS.ProcessEnv;
  /** The npm to run; `npm` on the PATH (its own Node's first) by default. */
  npm?: string;
  /** The agents; the connector's registry by default. */
  agents?: () => Promise<SetupAgent[]>;
  /** How often a sign-in asks the agent whether it is signed in yet. */
  pollMs?: number;
  /** How long a sign-in may wait for the person before it is stopped. */
  signInMs?: number;
  /** Whether ffmpeg is there now, and fetching it; the installer's own by default. */
  ffmpeg?: { found(): Promise<boolean>; fetch(): Promise<{ ok: boolean; message?: string }> };
}

/** The installs and sign-ins the launcher runs for Get set up: one of each per agent at a time, and one ffmpeg fetch. */
export class SetupActions {
  private readonly installs = new Map<string, InstallState>();
  private readonly signIns = new Map<string, { state: SignInState; child?: ChildProcess }>();
  private fetching: InstallState = { state: "idle" };
  private readonly o: SetupOptions;

  constructor(options: SetupOptions) {
    this.o = options;
  }

  private env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  private agents(): Promise<SetupAgent[]> {
    return (this.o.agents ?? (() => registryAgents(this.o.root, this.env())))();
  }

  private async agent(id: string): Promise<SetupAgent | undefined> {
    return (await this.agents()).find((a) => a.id === id);
  }

  async view(): Promise<SetupView> {
    const agents = (await this.agents()).map((a) => ({
      id: a.id,
      label: a.label,
      canInstall: !!a.setup?.npm,
      canSignIn: !!a.setup?.signIn && !!a.program,
      install: this.installs.get(a.id) ?? { state: "idle" as const },
      signIn: this.signIns.get(a.id)?.state ?? { state: "idle" as const },
    }));
    const found = await this.ffmpeg().found().catch(() => false);
    return { agents, ffmpeg: { found, fetch: this.fetching } };
  }

  /** Whether `id` is one of the registry's agents. */
  async has(id: string): Promise<boolean> {
    return !!(await this.agent(id));
  }

  /** Installs agent `id` from its npm package unless it is installing already; answers with its state. */
  async install(id: string): Promise<InstallState> {
    const agent = await this.agent(id);
    if (!agent?.setup?.npm) return { state: "failed", message: `${agent?.label ?? id} can't be installed from here; install it from its own page.` };
    const now = this.installs.get(id);
    if (now?.state === "installing") return now;
    const started: InstallState = { state: "installing", since: new Date().toISOString() };
    this.installs.set(id, started);
    const prefix = agentsPrefix(this.env(), this.o.home);
    const log = join(this.o.home, "logs", `agent-${id}.log`);
    npmRun(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", agent.setup.npm], { cwd: dirname(prefix), log, env: this.env(), ...(this.o.npm ? { npm: this.o.npm } : {}) })
      .then((ok) => this.installs.set(id, ok ? { state: "done" } : { state: "failed", message: `It did not finish. What it said is in ${log}.` }))
      .catch((error: unknown) => this.installs.set(id, { state: "failed", message: error instanceof Error ? error.message : String(error) }));
    return started;
  }

  /**
   * Starts agent `id`'s own sign-in and watches it: done once the agent says it is signed in, failed when its sign-in
   * ends without that or the person does not finish in time. A sign-in already going is started again.
   */
  async signIn(id: string): Promise<SignInState> {
    const agent = await this.agent(id);
    const args = agent?.setup?.signIn;
    if (!agent || !args || !agent.program) return { state: "failed", message: `${agent?.label ?? id} is signed in to in a terminal; this button can't do it.` };
    this.signIns.get(id)?.child?.kill();
    const since = new Date().toISOString();
    const entry: { state: SignInState; child?: ChildProcess } = { state: { state: "signingIn", since } };
    this.signIns.set(id, entry);
    const set = (state: SignInState) => {
      if (this.signIns.get(id) === entry) entry.state = state;
    };
    const current = () => this.signIns.get(id) === entry && entry.state.state === "signingIn";
    let child: ChildProcess;
    try {
      // Its stdin stays open, so a sign-in that waits for the person's answer in the browser is not cut short.
      child = spawn(agent.program(), [...args], { env: this.env(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
    } catch (error) {
      set({ state: "failed", message: error instanceof Error ? error.message : String(error) });
      return entry.state;
    }
    entry.child = child;
    const heard = (chunk: Buffer) => {
      const url = firstUrl(chunk.toString());
      if (url && entry.state.state === "signingIn" && !entry.state.url) set({ state: "signingIn", since, url });
    };
    child.stdout?.on("data", heard);
    child.stderr?.on("data", heard);
    const signedIn = async () => {
      try {
        return (await agent.info()).signedIn === true;
      } catch {
        return false;
      }
    };
    const finish = (state: SignInState) => {
      clearInterval(poll);
      clearTimeout(limit);
      set(state);
      if (child.exitCode === null) child.kill();
    };
    let asking = false;
    const poll = setInterval(() => {
      if (asking || !current()) return;
      asking = true;
      void signedIn().then((yes) => {
        asking = false;
        if (yes && current()) finish({ state: "done" });
      });
    }, this.o.pollMs ?? 2_000);
    const limit = setTimeout(() => {
      if (current()) finish({ state: "failed", message: `${agent.label} was not signed in within ${Math.round((this.o.signInMs ?? 10 * 60_000) / 60_000)} minutes. Press Sign in to try again.` });
    }, this.o.signInMs ?? 10 * 60_000);
    child.once("error", (error) => {
      if (current()) finish({ state: "failed", message: error.message });
    });
    child.once("close", () => {
      if (!current()) return;
      // Its sign-in ended by itself: asked once more, as it may have signed in just before it closed.
      void signedIn().then((yes) => {
        if (current()) finish(yes ? { state: "done" } : { state: "failed", message: `${agent.label}'s sign-in closed before it finished. Press Sign in to try again.` });
      });
    });
    return entry.state;
  }

  /** Stops every sign-in still going (the launcher is stopping). */
  stop(): void {
    for (const entry of this.signIns.values()) if (entry.child && entry.child.exitCode === null) entry.child.kill();
  }

  private ffmpeg(): NonNullable<SetupOptions["ffmpeg"]> {
    return this.o.ffmpeg ?? installerTools(this.o.root, ownFolder(this.env(), this.o.home), this.env());
  }

  /** Fetches ffmpeg unless it is being fetched already; answers with how that is going. */
  fetchFfmpeg(): InstallState {
    if (this.fetching.state === "installing") return this.fetching;
    this.fetching = { state: "installing", since: new Date().toISOString() };
    this.ffmpeg()
      .fetch()
      .then((r) => (this.fetching = r.ok ? { state: "done" } : { state: "failed", message: r.message ?? "ffmpeg could not be fetched." }))
      .catch((error: unknown) => (this.fetching = { state: "failed", message: error instanceof Error ? error.message : String(error) }));
    return this.fetching;
  }
}

/** ffmpeg as the installer finds and fetches it, into `home`'s `tools/` with links in its `bin/`. */
function installerTools(root: string, home: string, env: NodeJS.ProcessEnv): NonNullable<SetupOptions["ffmpeg"]> {
  const lib = (name: string) => import(pathToFileURL(join(root, "install", "package", "lib", name)).href);
  type Tools = {
    TOOLS: Array<{ name: string }>;
    onPath(name: string, env: NodeJS.ProcessEnv): string | undefined;
    ensureTools(o: { home: string; run: unknown; env: NodeJS.ProcessEnv }): Promise<{ fetched: string[]; warning?: string }>;
  };
  return {
    found: async () => {
      const tools = (await lib("tools.mjs")) as Tools;
      // A program named in FFMPEG_PATH is the one the scenes service uses.
      if (env.FFMPEG_PATH?.trim()) return true;
      return tools.TOOLS.every((t) => !!tools.onPath(t.name, env));
    },
    fetch: async () => {
      const tools = (await lib("tools.mjs")) as Tools;
      const { runProcess } = (await lib("run.mjs")) as { runProcess: unknown };
      const r = await tools.ensureTools({ home, run: runProcess, env });
      return r.warning ? { ok: false, message: r.warning } : { ok: true };
    },
  };
}

/** Runs npm with `args` in `cwd`, its words to `log`; resolves with whether it worked. */
function npmRun(args: string[], o: { cwd: string; log: string; env: NodeJS.ProcessEnv; npm?: string }): Promise<boolean> {
  mkdirSync(o.cwd, { recursive: true });
  mkdirSync(dirname(o.log), { recursive: true });
  const out = createWriteStream(o.log, { flags: "w" });
  const npm = o.npm ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd: o.cwd, env: withOwnNode(o.env), stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => out.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => out.write(chunk));
    child.once("error", (error) => out.end(`\n${error.message}\n`, () => resolve(false)));
    child.once("close", (code) => out.end(() => resolve(code === 0)));
  });
}
