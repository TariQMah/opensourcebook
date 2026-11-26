/**
 * The launcher's running part: starts every program, keeps each one up (a program that exits is started again, a few
 * times, instead of taking the rest of Open Sourcebook down), and stops everything on a signal or when a program cannot be kept
 * up. Every way it stops says why, with the time, on the screen and in `.opensourcebook/logs/stops.log`, so an Open Sourcebook that stopped
 * explains itself afterwards.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchArgs } from "./build.ts";
import { releasePorts } from "./ports.ts";
import { OpenCodes, openAddress } from "./opener.ts";
import { BackupSchedule } from "./backups.ts";
import { LocalFiles } from "./local-files.ts";
import { VoiceInstalls } from "./voice.ts";
import { SetupActions, useOwnBins } from "./setup.ts";
import { Phone, phoneChoice, rememberPhone } from "./phone.ts";
import { FRONT, PROGRAMS, startOrder, url, type Program, type Wiring } from "./programs.ts";
import { clearStopRequest, processStart, removeRunning, stamp, stopAskedOf, writeRunning, STOPS_LOG, type ChildRecord } from "./record.ts";
import { signalGroup, startProcess, stopAll, tail, waitUntilUp, type Started } from "./supervisor.ts";
import { quiet, say } from "./ui.ts";

export interface RunOptions {
  open: boolean;
  /** --phone or --no-phone; unset keeps the last choice. */
  phone?: boolean;
}

/** How a program that exits is started again: at most `max` times within `windowMs`, waiting longer each time. */
export interface RestartPolicy {
  max: number;
  windowMs: number;
  backoffMs: number[];
}

/** How often the launcher asks the engine whether it is up, which also lets it look after its jobs. */
const KEEP_ENGINE_MS = 30_000;

export const RESTARTS: RestartPolicy = { max: 4, windowMs: 10 * 60_000, backoffMs: [1_000, 3_000, 9_000, 20_000] };

const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openInBrowser(target: string): boolean {
  const [command, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    // No browser to open; the address is printed anyway.
    return false;
  }
}

/** A word for how a process ended. */
const howEnded = (code: number | null, signal: NodeJS.Signals | null) => (signal ? `signal ${signal}` : `exit code ${code}`);

/** Runs Open Sourcebook in the foreground until it is stopped. Never returns: every way out is `stop`, which exits the process. */
export async function run(w: Wiring, options: RunOptions, programs: Program[] = PROGRAMS, policy: RestartPolicy = RESTARTS, front: string = FRONT): Promise<number> {
  const logs = join(w.home, "logs");
  mkdirSync(logs, { recursive: true });
  // What Open Sourcebook fetched for the person (ffmpeg, an agent a button installed) is found by every program it starts.
  useOwnBins(w.env, w.home);
  const setup = new SetupActions({ root: w.root, home: w.home, env: w.env });
  const relative = (path: string) => (path.startsWith(w.root) ? path.slice(w.root.length + 1) : path);
  /** One line about a start, restart or stop: on the screen and kept in stops.log, with the time. */
  const note = (line: string) => {
    say(`${stamp()}  ${line}`);
    try {
      appendFileSync(join(w.home, STOPS_LOG), `${stamp()}  ${line}\n`);
    } catch {
      // The log is a help, never a reason to fail.
    }
  };

  const started: Started[] = [];
  const children: ChildRecord[] = [];
  const parent = process.ppid;
  const frontUrl = url(w, front);
  const me = { pid: process.pid, startedAt: processStart(process.pid), root: w.root, url: frontUrl, ports: w.ports };
  let isReady = false;
  const record = () => writeRunning(w.home, { ...me, ready: isReady, children });
  record();

  let phone: Phone | undefined;
  let files: LocalFiles | undefined;
  let backups: BackupSchedule | undefined;
  const openCodes = new OpenCodes();
  let stopping = false;
  const stop = async (code: number, why: string) => {
    if (stopping) return;
    stopping = true;
    note(`Stopping Open Sourcebook: ${why}`);
    setup.stop();
    backups?.stop();
    await phone?.stop();
    await files?.stop();
    await stopAll(started);
    removeRunning(w.home, process.pid);
    releasePorts(w.ports);
    clearStopRequest(w.home);
    note("Stopped. Nothing of Open Sourcebook is left running.");
    process.exit(code);
  };

  /** Why a signal came, from what this launcher can know: it never learns who sent it, so it says what it can tell. */
  const reasonFor = (signal: NodeJS.Signals): string => {
    const asked = stopAskedOf(w.home, process.pid);
    if (asked) return `asked to stop by "opensourcebook stop" run from ${asked.from} (process ${asked.by})`;
    const parentNow = process.ppid;
    const orphan = parentNow !== parent ? `its parent (process ${parent}) is gone` : `its parent (process ${parent}) is still there`;
    const terminal = process.stdout.isTTY ? "in a terminal" : "with no terminal";
    if (signal === "SIGINT") return process.stdout.isTTY ? "Ctrl-C (signal SIGINT) in this terminal" : `signal SIGINT, not from a Ctrl-C in a terminal of this copy (${terminal}, ${orphan}); something sent it`;
    if (signal === "SIGHUP") return `signal SIGHUP: the terminal or program that started this one closed or went away (${terminal}, ${orphan})`;
    return `signal ${signal} from outside this copy's own "opensourcebook stop" (${terminal}, ${orphan}); a kill, a tool or shell that ended, or another program sent it`;
  };
  const background = process.env.OPENSOURCEBOOK_BACKGROUND === "1";
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (signal === "SIGHUP" && background) {
        // Started with --background: no terminal belongs to it, so a hang-up is not a request to stop.
        note("Ignored signal SIGHUP (started with --background; \"opensourcebook stop\" stops it).");
        return;
      }
      void stop(0, reasonFor(signal));
    });
  }
  // Windows has no signal "opensourcebook stop" can send that a program can catch, so there the launcher looks for its note.
  if (process.platform === "win32") {
    setInterval(() => {
      if (stopAskedOf(w.home, process.pid)) void stop(0, reasonFor("SIGTERM"));
    }, 300).unref();
  }
  // A dead terminal or pipe must not take the launcher down, or its programs would be left running unwatched.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  const crashed = (what: string) => (error: unknown) => void stop(1, `the launcher itself failed (${what}): ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 3).join(" / ") : String(error)}`);
  process.on("uncaughtException", crashed("uncaught exception"));
  process.on("unhandledRejection", crashed("unhandled rejection"));

  say();
  say("Starting");
  // The engine asks the launcher for the library and a linked folder's files (local-files.ts); without it, it says so.
  if (w.ports.files && w.secrets.FILES_TOKEN) {
    files = new LocalFiles({ state: w.home, port: w.ports.files, token: w.secrets.FILES_TOKEN });
    try {
      await files.start();
    } catch (error) {
      files = undefined;
      say(`  Linking a project to a folder could not start (${error instanceof Error ? error.message : String(error)}); the rest of Open Sourcebook runs as usual.`);
    }
  }
  const width = Math.max(...programs.map((p) => p.label.length)) + 2;
  const launch = (p: Program, again: boolean): Started => {
    const { args, env } = launchArgs(w, p);
    const s = startProcess(p.id, process.execPath, args, { cwd: join(w.root, p.dir), env: { ...w.env, ...env }, log: join(logs, `${p.id}.log`), append: again });
    const index = started.findIndex((x) => x.id === p.id);
    if (index >= 0) started[index] = s;
    else started.push(s);
    const at = children.findIndex((c) => c.id === p.id);
    const entry: ChildRecord = { id: p.id, pid: s.child.pid ?? 0, ...(s.child.pid ? { startedAt: processStart(s.child.pid) } : {}) };
    if (at >= 0) children[at] = entry;
    else children.push(entry);
    record();
    return s;
  };
  const upWithin = (p: Program, s: Started) => {
    const health = p.health(w);
    return waitUntilUp(s, `${url(w, p.id)}${health.path}`, health.token, p.readyWithinMs);
  };
  const lastLines = (s: Started) => {
    for (const line of tail(s.log)) quiet(`      ${line}`);
  };

  /** After a program has been up: whenever it exits, start it again (waiting longer each time), until it cannot be kept up. */
  const keepUp = async (p: Program, first: Started) => {
    const times: number[] = [];
    let s = first;
    for (;;) {
      const { code, signal } = await s.exited;
      if (stopping) return;
      const how = howEnded(code, signal);
      note(`${p.label} exited on its own (${how}). The last lines of ${relative(s.log)}:`);
      lastLines(s);
      const now = Date.now();
      while (times.length && now - times[0]! > policy.windowMs) times.shift();
      if (times.length >= policy.max) {
        await stop(1, `${p.label} exited with ${how} and could not be restarted (${policy.max} restarts within ${Math.round(policy.windowMs / 60_000)} minutes)`);
        return;
      }
      times.push(now);
      const wait = policy.backoffMs[Math.min(times.length - 1, policy.backoffMs.length - 1)] ?? 1_000;
      note(`  Restarting ${p.label} in ${Math.round(wait / 100) / 10} seconds (restart ${times.length} of ${policy.max}); the rest of Open Sourcebook keeps running.`);
      await sleep(wait);
      if (stopping) return;
      // What the program left behind (a runtime holding its port) goes with it, just this program's own group.
      signalGroup(s.child, "SIGKILL");
      s = launch(p, true);
      const answer = await upWithin(p, s);
      if (stopping) return;
      if (answer.up) note(`  ${pad(p.label, width)}is back  ${url(w, p.id)}`);
      else {
        note(`  ${p.label} did not come back (${answer.why === "exited" ? "it exited again" : `no answer within ${Math.round(p.readyWithinMs / 1000)} seconds`}).`);
        lastLines(s);
        signalGroup(s.child, "SIGKILL");
      }
    }
  };

  const ready = new Map<string, Promise<boolean>>();
  const startOne = async (p: Program): Promise<boolean> => {
    for (const id of p.after ?? []) if (!(await ready.get(id))) return false;
    if (stopping) return false;
    const s = launch(p, false);
    const answer = await upWithin(p, s);
    if (!answer.up) {
      if (stopping) return false;
      const why = answer.why === "exited" ? "stopped before it was ready" : `did not answer within ${Math.round(p.readyWithinMs / 1000)} seconds`;
      say(`  ${pad(p.label, width)}${why}. The last lines of ${relative(s.log)}:`);
      lastLines(s);
      return false;
    }
    const about = p.describe?.(answer.body);
    say(`  ${pad(p.label, width)}ready  ${url(w, p.id)}${about ? `  (${about})` : ""}`);
    void keepUp(p, s);
    return true;
  };
  for (const p of startOrder(programs)) ready.set(p.id, startOne(p));
  const all = await Promise.all(ready.values());
  if (!all.every(Boolean)) {
    await stop(1, "a program did not start; fix what is said above and run this again");
    return 1;
  }

  isReady = true;
  record();
  say();
  say(`Open Sourcebook is running at ${frontUrl}`);
  if (options.phone !== undefined) rememberPhone(w.home, options.phone);
  const ansi = Boolean(process.stdout.isTTY) && !process.env.CI;
  // The weekly backup into the library, when the person turned it on (cli/backups.ts); a catch-up a little after the start.
  if (w.ports.engine && w.secrets.OPENSOURCEBOOK_CLIENT_TOKEN) {
    backups = new BackupSchedule({ state: w.home, engine: url(w, "engine"), token: w.secrets.OPENSOURCEBOOK_CLIENT_TOKEN, say: note });
    backups.start();
  }
  if (w.ports.phone && w.ports["phone-control"] && w.ports.web) {
    phone = new Phone({ home: w.home, webPort: w.ports.web, doorPort: w.ports.phone, controlPort: w.ports["phone-control"], token: w.secrets.PHONE_TOKEN, say, ansi, openCodes, voices: new VoiceInstalls({ root: w.root, home: w.home }), setup, ...(backups ? { backups } : {}), reopen: (to) => openInBrowser(openAddress(frontUrl, openCodes.issue().code, to)), ...(w.keys ? { keys: w.keys } : {}) });
    try {
      await phone.start(options.phone ?? phoneChoice(w.home));
    } catch (error) {
      say(`  Open on your phone could not start (${error instanceof Error ? error.message : String(error)}); Open Sourcebook runs on this computer only.`);
    }
  }
  say();
  // The browser on this computer is let in by a one-time address (opener.ts); typing the plain address shows how.
  const opening = openAddress(frontUrl, openCodes.issue().code);
  if (options.open) openInBrowser(opening);
  else say(`  To use Open Sourcebook, open this address in this computer's browser (it works once, for ten minutes; "opensourcebook open" makes another):\n  ${opening}`);
  say("Press Ctrl-C to stop everything.");
  // The engine looks after the jobs it is making on its own requests (engine/src/jobs/keeper.ts); with nothing open,
  // this check every half minute is such a request, so a job a restart or a sleep left behind is carried on by itself.
  const engine = programs.find((p) => p.id === "engine");
  if (engine) {
    const keep = setInterval(() => void fetch(`${url(w, engine.id)}${engine.health(w).path}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined), KEEP_ENGINE_MS);
    keep.unref();
  }
  await new Promise(() => undefined);
  return 0;
}
