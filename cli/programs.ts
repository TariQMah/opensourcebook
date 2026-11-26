/**
 * The programs `opensourcebook` starts, and how each is wired to the others. A program is one entry in PROGRAMS: where it lives,
 * its usual port, how it starts, which settings it reads and which route says it is up. Everything else in the
 * launcher reads this list and names no program.
 *
 * Each program is started the way its own README starts it, with node run directly (no npm in between, so stopping
 * reaches the real process). Settings go in through the environment, under the names the programs already read.
 */
import { join } from "node:path";
import { appDataOf, engineState } from "./app-data.ts";
import { formatEnv, namesIn, readEnvFile } from "./envfile.ts";
import { newNameOf, settingOf, underNewNames } from "./old-names.ts";
import { writePrivate, type Secrets } from "./secrets.ts";
import { existsSync, readFileSync } from "node:fs";
import type { RunKeys } from "./opener.ts";
import { engineConfig } from "./database.ts";

export interface Wiring {
  /** The repo root. */
  root: string;
  /** The launcher's own folder (`.opensourcebook/`). */
  home: string;
  /** Port per program id, and per extra port name. */
  ports: Record<string, number>;
  secrets: Secrets;
  /** The launcher's own environment, passed on to every program. */
  env: NodeJS.ProcessEnv;
  /** This run's keys (opener.ts): made at each start, never written to disk. Absent outside a running launcher. */
  keys?: RunKeys;
  /** `--dev`: start each program with its watching dev server (`start`) instead of from its build (`built`). */
  dev?: boolean;
}

/** Where the scenes service keeps its jobs and its video agent's work folders. */
export const scenesData = (w: Wiring) => w.env.SCENES_DATA_DIR?.trim() || join(w.root, "services", "scenes", ".data");

export interface Health {
  path: string;
  token?: string;
}

export interface Program {
  id: string;
  label: string;
  /** What it is for, in a few words a person who has never seen Open Sourcebook can follow. */
  about: string;
  /** Its folder, from the repo root. */
  dir: string;
  /** The port it uses when nobody tells it otherwise. */
  port: number;
  /** More ports it needs besides its own, by name, with the usual one. */
  extraPorts?: Array<{ name: string; port: number }>;
  /** Programs that must answer before this one starts. */
  after?: string[];
  /** How long it may take to answer after it starts. */
  readyWithinMs: number;
  /**
   * Arguments for node (run in its folder) and the settings it gets on top of the launcher's environment. For a
   * program with a `built` way this is its watching dev server, started only with `--dev`.
   */
  start(w: Wiring): { args: string[]; env: Record<string, string> };
  /** How a person runs it: built once (build.ts) into `out`, then started from there with nothing watched. */
  built?: {
    /** Folders and files, from the repo root, that the build is made from: a change in any of them builds it again. */
    inputs: string[];
    /** Node arguments for each step of the build, run in its folder in turn. */
    steps(w: Wiring, out: string): string[][];
    /** Arguments for node (run in its folder) and the settings it gets, to start it from the build in `out`. */
    serve(w: Wiring, out: string): { args: string[]; env: Record<string, string> };
  };
  health(w: Wiring): Health;
  /** One short phrase for the status line once it answers, from the health answer's JSON. */
  describe?(body: unknown): string | undefined;
}

export const url = (w: Wiring, id: string) => `http://127.0.0.1:${w.ports[id]}`;

/**
 * The engine's settings file for `wrangler dev --env-file`: the person's own `engine/.dev.vars` (their model keys, if
 * any), then any setting the engine knows (named in `.dev.vars.example`) that is set in the launcher's environment,
 * then the wiring to the other programs, which always wins. Rewritten at each start, kept in `.opensourcebook/` like the
 * secrets. A setting under its name from before the rename (old-names.ts) is read and written under its new name.
 */
export function engineSettings(w: Wiring): Record<string, string> {
  const engineDir = join(w.root, "engine");
  // A person's own file may still name settings as they were before the rename; what is written has new names only.
  const own = underNewNames(readEnvFile(join(engineDir, ".dev.vars")));
  const example = join(engineDir, ".dev.vars.example");
  const known = existsSync(example) ? namesIn(readFileSync(example, "utf8")) : [];
  const fromShell: Record<string, string> = {};
  for (const listed of known) {
    const name = newNameOf(listed) ?? listed;
    const value = settingOf(w.env, name);
    if (value !== undefined) fromShell[name] = value;
  }
  return {
    ...own,
    ...fromShell,
    OPENSOURCEBOOK_CLIENT_TOKEN: w.secrets.OPENSOURCEBOOK_CLIENT_TOKEN,
    CHAT_AGENT_URL: url(w, "connector"),
    CHAT_AGENT_TOKEN: w.secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN,
    SCENES_SERVICE_URL: url(w, "scenes"),
    SCENES_SERVICE_TOKEN: w.secrets.SCENES_TOKEN,
    // The library and a linked folder's files, which the local runtime cannot read itself (local-files.ts).
    ...(w.ports.files ? { LOCAL_FILES_URL: url(w, "files"), LOCAL_FILES_TOKEN: w.secrets.FILES_TOKEN } : {}),
  };
}

/** Writes the engine's settings file into `.opensourcebook/` (private) and returns its path. */
function writeEngineSettings(w: Wiring): string {
  const settings = join(w.home, "engine.env");
  writePrivate(settings, formatEnv(engineSettings(w), "Made by the launcher at each start (cli/programs.ts). Edit engine/.dev.vars instead."));
  return settings;
}

/**
 * What the web app's Worker proxy reads, the same in the dev server and the build: the engine's address and token,
 * the launcher's phone control, and this run's keys (never written to disk: they go in through the environment).
 */
export function webSettings(w: Wiring): Record<string, string> {
  return {
    OPENSOURCEBOOK_CLIENT_TOKEN: w.secrets.OPENSOURCEBOOK_CLIENT_TOKEN,
    ENGINE_URL: url(w, "engine"),
    // Settings > Phone and letting this computer's browser in: the launcher's control (phone.ts, opener.ts),
    // which the proxy reaches with this token.
    ...(w.ports["phone-control"] ? { PHONE_URL: url(w, "phone-control"), PHONE_TOKEN: w.secrets.PHONE_TOKEN } : {}),
    // The engine only for this run's browser (its cookie) and for what the door passes on (opener.ts).
    ...(w.keys ? { OPENSOURCEBOOK_BROWSER_KEY: w.keys.browser, OPENSOURCEBOOK_DOOR_KEY: w.keys.door } : {}),
  };
}

const node = (dir: string, ...path: string[]) => join(dir, ...path);
/** The launcher's runner for a built Worker (serve-worker.ts), started in the program's own folder. */
const serveWorker = (w: Wiring) => join(w.root, "cli", "serve-worker.ts");
const WRANGLER = node("node_modules", "wrangler", "bin", "wrangler.js");

export const PROGRAMS: Program[] = [
  {
    id: "connector",
    label: "Agent connector",
    about: "runs your own coding agent for the chat",
    dir: "services/agent-connector",
    port: 8650,
    readyWithinMs: 30_000,
    start: (w) => ({
      args: ["--env-file-if-exists=.env", "src/main.ts"],
      env: {
        OPENSOURCEBOOK_CONNECTOR_TOKEN: w.secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN,
        OPENSOURCEBOOK_CONNECTOR_PORT: String(w.ports.connector),
        OPENSOURCEBOOK_USAGE_LOG: join(w.home, "logs", "usage.jsonl"),
        // The scenes service holds a narrower token: turns only in its own folder, and only its own turns.
        OPENSOURCEBOOK_CONNECTOR_SCENES_TOKEN: w.secrets.SCENES_CONNECTOR_TOKEN,
        OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS: scenesData(w),
      },
    }),
    health: (w) => ({ path: "/status", token: w.secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN }),
    describe: (body) => {
      const agents = (body as { agents?: Array<{ label?: string; installed?: boolean; signedIn?: boolean; unavailable?: string }> })?.agents ?? [];
      const ready = agents.filter((a) => a.installed && a.signedIn && !a.unavailable).map((a) => a.label);
      return ready.length ? `chat answered by ${ready.join(", ")}` : "no signed-in agent, the chat can't answer";
    },
  },
  {
    id: "scenes",
    label: "Video scenes",
    about: "draws and renders videos",
    dir: "services/scenes",
    port: 8670,
    after: ["connector"],
    readyWithinMs: 60_000,
    start: (w) => ({
      args: ["--experimental-strip-types", "--no-warnings", "src/main.ts"],
      env: {
        SCENES_TOKEN: w.secrets.SCENES_TOKEN,
        SCENES_CONNECTOR_TOKEN: w.secrets.SCENES_CONNECTOR_TOKEN,
        SCENES_CONNECTOR_URL: url(w, "connector"),
        SCENES_PORT: String(w.ports.scenes),
        // Where a video's job folder fetches the pictures the engine kept from its sources (docs/JOB-FOLDER.md).
        SCENES_ENGINE_URL: url(w, "engine"),
        // The voice chosen in the app and its key: a private file in Open Sourcebook's own folder, never in git.
        SCENES_VOICE_FILE: w.env.SCENES_VOICE_FILE?.trim() || join(w.home, "voice.json"),
      },
    }),
    health: (w) => ({ path: "/status", token: w.secrets.SCENES_TOKEN }),
    describe: (body) => {
      const voice = (body as { voice?: { label?: string } })?.voice?.label;
      return voice ? `voice: ${voice}` : undefined;
    },
  },
  {
    id: "engine",
    label: "Engine",
    about: "keeps your projects and makes the plans",
    dir: "engine",
    port: 8787,
    // Reserved so `--ports-from` gives every program the same port each time; the debugger listens on it only with
    // OPENSOURCEBOOK_ENGINE_INSPECTOR=1 (engine/scripts/dev.ts).
    extraPorts: [{ name: "engine-inspector", port: 9230 }],
    readyWithinMs: 90_000,
    built: {
      inputs: ["engine", "skills", "packs"],
      steps: (w, out) => {
        const config = engineConfig(join(w.root, "engine"));
        return [
          // Bundles once, exactly as a deploy would (the skills as text modules), and stops: nothing is sent anywhere.
          [WRANGLER, "deploy", "--dry-run", "--config", config, "--outdir", join(out, "worker"), "--compatibility-flags", "nodejs_compat"],
          [serveWorker(w), "prepare", "--config", config, "--script", join(out, "worker", "index.js"), "--out", join(out, "runtime.json")],
        ];
      },
      serve: (w, out) => ({
        args: [
          "--no-warnings",
          serveWorker(w),
          "serve",
          "--runtime", join(out, "runtime.json"),
          "--ip", "127.0.0.1",
          "--port", String(w.ports.engine),
          "--env-file", writeEngineSettings(w),
          // Where `wrangler dev` and the launcher's migrations keep the local database, the queue and the files.
          "--persist-to", appDataOf(w.env) ? engineState(join(w.root, "engine"), w.env) : join(".wrangler", "state"),
          "--compatibility-flags", "nodejs_compat",
          // The debugger stays shut unless the person developing Open Sourcebook asks for it, as with the dev server.
          ...(w.env.OPENSOURCEBOOK_ENGINE_INSPECTOR === "1" ? ["--inspector-port", String(w.ports["engine-inspector"])] : []),
        ],
        env: {},
      }),
    },
    start: (w) => {
      const settings = writeEngineSettings(w);
      return {
        args: [
          // `wrangler dev` through wrangler's own API, so the engine's debugger port stays shut unless the person
          // developing Open Sourcebook sets OPENSOURCEBOOK_ENGINE_INSPECTOR=1.
          node("scripts", "dev.ts"),
          "--ip", "127.0.0.1",
          "--port", String(w.ports.engine),
          "--inspector-port", String(w.ports["engine-inspector"]),
          "--env-file", settings,
          "--config", engineConfig(join(w.root, "engine")),
          // A package the engine uses imports node:buffer; wrangler.toml does not turn Node's modules on yet, so
          // `npm run dev` alone stops at start (the engine README's run line needs the same flag).
          "--compatibility-flags", "nodejs_compat",
          // The app data folder's `data/` when the desktop app names one; else wrangler's own place beside the engine.
          ...(appDataOf(w.env) ? ["--persist-to", engineState(join(w.root, "engine"), w.env)] : []),
        ],
        env: { WRANGLER_SEND_METRICS: "false" },
      };
    },
    health: () => ({ path: "/health" }),
  },
  {
    id: "web",
    label: "Web app",
    about: "the pages you open in your browser",
    dir: "web",
    port: 5173,
    after: ["engine"],
    readyWithinMs: 90_000,
    built: {
      inputs: ["web", "examples"],
      steps: (w, out) => [
        // The app and its Worker proxy, as a deploy would build them (no type check: that is the web's own `npm run build`).
        [node("node_modules", "vite", "bin", "vite.js"), "build", "--outDir", join(out, "app"), "--emptyOutDir", "--logLevel", "warn"],
        [serveWorker(w), "prepare", "--find-config", join(out, "app"), "--out", join(out, "runtime.json")],
      ],
      serve: (w, out) => {
        const settings = webSettings(w);
        // Through the environment, never a file: this run's keys stay off the disk.
        return {
          args: ["--no-warnings", serveWorker(w), "serve", "--runtime", join(out, "runtime.json"), "--ip", "127.0.0.1", "--port", String(w.ports.web), "--bindings-from-env", Object.keys(settings).join(",")],
          env: settings,
        };
      },
    },
    start: (w) => ({
      args: [node("node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(w.ports.web), "--strictPort"],
      // The Worker proxy reads these from the environment when web/.dev.vars is not there (main.ts says so when it is).
      env: {
        ...webSettings(w),
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
        WRANGLER_SEND_METRICS: "false",
      },
    }),
    // Through the proxy to the engine: proves the web app, the token and the database together. The proxy lets in a
    // caller that already holds the engine's own token (it could call the engine itself), so the launcher can ask.
    health: (w) => ({ path: "/api/v1/projects", token: w.secrets.OPENSOURCEBOOK_CLIENT_TOKEN }),
  },
];

/** The program the person opens. */
export const FRONT = "web";

/** Programs in an order where each comes after the ones it waits for. */
export function startOrder(programs: Program[] = PROGRAMS): Program[] {
  const done = new Set<string>();
  const out: Program[] = [];
  const visit = (p: Program, seen: Set<string>) => {
    if (done.has(p.id)) return;
    if (seen.has(p.id)) throw new Error(`Programs wait for each other in a circle at ${p.id}.`);
    seen.add(p.id);
    for (const id of p.after ?? []) {
      const dep = programs.find((q) => q.id === id);
      if (dep) visit(dep, seen);
    }
    done.add(p.id);
    out.push(p);
  };
  for (const p of programs) visit(p, new Set());
  return out;
}
