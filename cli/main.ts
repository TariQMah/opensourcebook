/**
 * `opensourcebook`: starts Open Sourcebook on this computer with one command, and stops it with Ctrl-C (or `opensourcebook stop`).
 *
 *   opensourcebook                     check, install what is missing, make the secrets, set up the database, start every program, open the app
 *   opensourcebook <thing> <action>    every other command, from the table in commands/ (`opensourcebook help` lists them; the paired
 *                                      devices are `opensourcebook device`, from commands/devices.ts)
 *
 * Everything the launcher keeps lives in the state folder, `.opensourcebook/` at the repo root (git-ignored): the
 * secrets, the engine's settings file, what it set up, and a log per program. Where that folder is, and how one from
 * before the rename is found, is state.ts.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { newRunKeys } from "./opener.ts";
import { join } from "node:path";
import { gather, lines, render } from "./check.ts";
import { CHROME_SIZE, downloadChrome, dropSecondCopy, findChrome } from "./chrome.ts";
import { appDataOf, engineState, useAppData } from "./app-data.ts";
import { databaseId, earlierDatabases, earlierLine, migrate, migrationFiles, needsMigrations, pastDatabaseIds, type Applied } from "./database.ts";
import { build, buildFailed, isStale, planBuild, type Plan } from "./build.ts";
import { install, installParts, linkedLine, linkedPackages, missingPackages, took, type Part } from "./install.ts";
import { claimPort, pickPorts } from "./ports.ts";
import { PROGRAMS, type Wiring } from "./programs.ts";
import { carryOldNames } from "./old-names.ts";
import { findLauncher, ownChildren, processStart, readRunning, removeRunning, writeRunning } from "./record.ts";
import { run } from "./runner.ts";
import { loadSecrets, writePrivate } from "./secrets.ts";
import { stateFolder } from "./state.ts";
import { interactive, progress, quiet, say } from "./ui.ts";
import { checkForNewer, ifKnown } from "./update.ts";

export const ROOT = join(import.meta.dirname, "..");
/** The state folder of this start (state.ts), set once by `start` before anything reads it. */
let HOME = "";
const logs = () => join(HOME, "logs");
const stateFile = () => join(HOME, "state.json");
const secretsFile = () => join(HOME, "secrets.json");

export interface Options {
  command: "start" | "check" | "status" | "help" | "devices";
  open: boolean;
  portsFrom?: number;
  /** --phone or --no-phone: turns Open on your phone on or off, and remembers it. Unset keeps the last choice. */
  phone?: boolean;
  /** --dev: the watching dev servers, for people working on Open Sourcebook, instead of the builds. */
  dev?: boolean;
  /** What follows `devices`. */
  rest: string[];
}

/** The door a phone comes in by, and the launcher's control of it on 127.0.0.1 (phone.ts). Not programs: the launcher runs them. */
const PHONE_PORTS = [
  { name: "phone", port: 5180 },
  { name: "phone-control", port: 5181 },
];

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const options: Options = { command: "start", open: !env.CI && env.OPENSOURCEBOOK_NO_OPEN !== "1", rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "devices") {
      options.command = "devices";
      options.rest = argv.slice(i + 1);
      break;
    }
    if (arg === "--phone") options.phone = true;
    else if (arg === "--no-phone") options.phone = false;
    else if (arg === "--dev") options.dev = true;
    else if (arg === "check" || arg === "status" || arg === "start" || arg === "help") options.command = arg;
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--ports-from") {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65000) throw new Error("--ports-from takes a port between 1024 and 65000.");
      options.portsFrom = port;
    } else throw new Error(`"${arg}" is not something opensourcebook knows. Run "opensourcebook help" to see what it takes.`);
  }
  return options;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function check(): Promise<boolean> {
  say("Checking this computer");
  const all = lines(await gather(ROOT));
  say(render(all));
  return !all.some((l) => l.blocks);
}

async function installMissing(): Promise<boolean> {
  // A node_modules that is a link is never installed into: said plainly, and Open Sourcebook goes on only when its packages answer.
  const linked = linkedPackages(ROOT);
  for (const l of linked) say(linkedLine(PROGRAMS.find((p) => p.dir === l.dir)?.label ?? l.dir, l));
  if (linked.some((l) => !l.answers)) return false;
  const missing = missingPackages(ROOT, HOME);
  if (!missing.length) return true;
  mkdirSync(logs(), { recursive: true });
  const parts: Part[] = missing.map((dir) => {
    const program = PROGRAMS.find((p) => p.dir === dir);
    return { dir, name: program?.label ?? dir, about: program?.about ?? dir };
  });
  const began = Date.now();
  const line = progress(`Installing ${parts.length === 1 ? "a part" : `${parts.length} parts`} of Open Sourcebook (first run, a few minutes)`);
  const results = await installParts(
    parts,
    (part) => install(join(ROOT, part.dir), join(logs(), `install-${part.dir.replace(/[\\/]/g, "-")}.log`), HOME),
    { line: (text) => line.line(text), waiting: (text) => line.update(text) },
    interactive ? {} : { heartbeatMs: 20_000 },
  );
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    line.done(`done in ${took(Math.round((Date.now() - began) / 1000))}`);
    return true;
  }
  line.done("not finished");
  for (const f of failed) say(`  ${f.part.name} could not be installed; npm's own words are in ${relative(join(logs(), `install-${f.part.dir.replace(/[\\/]/g, "-")}.log`))}. Check the network and run this again.`);
  return false;
}

async function ensureChrome(): Promise<void> {
  if (findChrome(ROOT)) {
    dropSecondCopy(ROOT);
    return;
  }
  const line = progress(`Downloading the browser that draws videos (once; ${CHROME_SIZE})`);
  const ok = await downloadChrome(ROOT, join(logs(), "chrome.log"), (percent) => line.update(`${percent}%`));
  if (ok && findChrome(ROOT)) {
    dropSecondCopy(ROOT);
    line.done("done");
  }
  else line.done(`didn't finish, so videos can't be made yet; Open Sourcebook starts anyway and tries again next time (${relative(join(logs(), "chrome.log"))}).`);
}

async function ensureDatabase(): Promise<boolean> {
  const engineDir = join(ROOT, "engine");
  // An older record (`migrations`, one list for whatever database was in use) says nothing about the one in use now.
  const { migrations: _old, ...state } = readJson<{ migrations?: string[]; databases?: Applied }>(stateFile()) ?? {};
  const applied = state.databases ?? {};
  if (!needsMigrations(engineDir, applied)) return true;
  const id = databaseId(engineDir);
  const line = progress("Setting up where your projects are kept (a database on this computer)");
  const log = join(logs(), "database.log");
  if (!(await migrate(engineDir, log))) {
    line.done(`failed; the details are in ${relative(log)}.`);
    return false;
  }
  writePrivate(stateFile(), `${JSON.stringify({ ...state, databases: { ...applied, [id]: migrationFiles(engineDir) } }, null, 2)}\n`);
  line.done("done");
  const earlier = earlierLine(engineDir, ROOT, earlierDatabases(engineDir, [...Object.keys(applied), ...pastDatabaseIds(ROOT)]));
  if (earlier) say(earlier);
  return true;
}

/**
 * Builds each program a person runs from a build, when its build is missing or was made from other files (the first
 * start, and the first after a pull or an update); every other start skips this.
 */
async function ensureBuilds(w: Wiring): Promise<boolean> {
  const plans = PROGRAMS.map((p) => planBuild(w, p)).filter((p): p is Plan => p !== undefined && isStale(w, p));
  if (!plans.length) return true;
  const began = Date.now();
  const line = progress("Getting Open Sourcebook ready (once after each update)");
  const logOf = (plan: Plan) => join(logs(), `build-${plan.program.id}.log`);
  const results = await Promise.all(plans.map(async (plan) => ({ plan, ok: await build(w, plan, logOf(plan)) })));
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    line.done(`done in ${took(Math.round((Date.now() - began) / 1000))}`);
    return true;
  }
  line.done("not finished");
  for (const f of failed) say(buildFailed(f.plan.program.label, relative(logOf(f.plan)), f.plan.program.dir));
  return false;
}

const relative = (path: string) => path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));

/** Checks, installs, sets up and starts every program, in the foreground until Ctrl-C: the launcher itself. */
export async function start(options: Options): Promise<number> {
  if (!existsSync(join(ROOT, "engine", "package.json"))) {
    say("This folder does not look like the Open Sourcebook folder (the engine folder is missing next to cli).");
    return 1;
  }
  // Looked for where it is first, moving nothing: a copy that is running keeps its folder under it.
  HOME = stateFolder(ROOT);
  const earlier = readRunning(HOME);
  const there = earlier && earlier.pid !== process.pid ? findLauncher(HOME) : undefined;
  if (there) {
    say(`Open Sourcebook is already ${there.ready === false ? "starting" : "running"} at ${there.url} (process ${there.pid}). Stop it with "opensourcebook stop" (or Ctrl-C in its terminal) first.`);
    return 1;
  }
  const left = earlier && !there ? ownChildren(earlier) : [];
  if (left.length) {
    say(`An Open Sourcebook that is gone left its programs running (${left.map((c) => `${c.id} ${c.pid}`).join(", ")}). Run "opensourcebook stop" to stop those, then start again.`);
    return 1;
  }
  // Nothing of this copy is running, so a folder from before the rename takes its new name now, in one step.
  HOME = stateFolder(ROOT, process.env, { settle: true, say });
  // Claimed at once, so a second start in this folder sees it while this one checks and installs.
  writeRunning(HOME, { pid: process.pid, ...(processStart(process.pid) ? { startedAt: processStart(process.pid) } : {}), root: ROOT, url: "", ports: {}, ready: false, children: [] });
  try {
    return await startClaimed(options);
  } finally {
    removeRunning(HOME, process.pid);
  }
}

async function startClaimed(options: Options): Promise<number> {
  // Whether a newer version is out: asked while the rest starts, said in one quiet line before the programs start
  // when the answer is in by then, and nothing when offline or slow.
  const newer = checkForNewer(ROOT);
  if (!(await check())) return 1;
  mkdirSync(logs(), { recursive: true });
  if (!(await installMissing())) return 1;
  const { secrets, created } = loadSecrets(secretsFile());
  if (created.length) say(`  Made the passwords Open Sourcebook's programs use to talk to each other, once. They are kept in ${relative(secretsFile())}, which only you can read and which is never committed.`);
  await ensureChrome();
  if (!(await ensureDatabase())) return 1;

  const wishes = [...PROGRAMS.flatMap((p) => [{ name: p.id, port: p.port }, ...(p.extraPorts ?? [])]), ...PHONE_PORTS].map((w, i) => (options.portsFrom ? { name: w.name, port: options.portsFrom + i } : w));
  const ports = await pickPorts(wishes, undefined, claimPort);
  const moved = PROGRAMS.filter((p) => !options.portsFrom && ports[p.id] !== p.port);
  for (const p of moved) quiet(`  ${p.label}: port ${p.port} is already in use by something else, so Open Sourcebook uses ${ports[p.id]} instead.`);

  keepPrivate(ROOT);
  const wiring: Wiring = { root: ROOT, home: HOME, ports, secrets, env: process.env, keys: newRunKeys(), ...(options.dev ? { dev: true } : {}) };
  if (options.dev) quiet(`  Started with --dev: ${PROGRAMS.filter((p) => p.built).map((p) => p.label).join(" and ")} run in their watching dev servers and reload when their files change.`);
  else if (!(await ensureBuilds(wiring))) return 1;
  const newerLine = await ifKnown(newer);
  if (newerLine) quiet(newerLine);
  return run(wiring, options);
}

/**
 * The folders where Open Sourcebook keeps a person's projects on disk (the engine's local database and files, the scenes
 * service's jobs) are made readable by that person only, like `.opensourcebook/`, wherever the copy of Open Sourcebook sits.
 */
export function keepPrivate(root: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const dir of [appDataOf(env) ? engineState(join(root, "engine"), env) : join(root, "engine", ".wrangler"), env.SCENES_DATA_DIR?.trim() || join(root, "services", "scenes", ".data")]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    } catch {
      // A folder that cannot be changed is left as it is; the programs still start.
    }
  }
}

/**
 * The `opensourcebook` command: with no words, or only the launcher's own flags, it starts Open Sourcebook in the foreground as before; every
 * other command comes from the table in commands/.
 */
export async function main(argv: string[]): Promise<number> {
  // Settings a person still has under their names from before the rename are read as the new ones from here on.
  carryOldNames(process.env);
  // The desktop app names one folder for everything of the person's: state, the engine's data and the video jobs.
  useAppData(process.env);
  const { runCommand } = await import("./commands/index.ts");
  return runCommand(argv);
}
