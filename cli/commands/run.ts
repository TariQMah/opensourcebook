/** Running Open Sourcebook itself: start, stop, status, check. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { gather, lines } from "../check.ts";
import { PROGRAMS, url, type Wiring } from "../programs.ts";
import { readSecrets, type Secrets } from "../secrets.ts";
import { httpProbe, signalTree, tail } from "../supervisor.ts";
import { alive, askToStop, clearStopRequest, findLauncher, ownChildren, readRunning, removeRunning, stamp, stillTheSame } from "../record.ts";
import { logSize, newerSaidSince } from "../update.ts";
import { findRunning, START_HINT } from "./connect.ts";
import { PRINT_FLAG, Problem, TIMEOUT_FLAG, flagOn, flagString, type Ctx, type Group } from "./table.ts";
import { browserAddress, openUrl } from "./util.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portsFlag(ctx: Ctx): number | undefined {
  const raw = flagString(ctx, "ports-from");
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65000) throw new Problem("bad_arguments", "--ports-from takes a port between 1024 and 65000.");
  return port;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The command's file, and the one it was before the rename: a copy from then has only the second. */
export const COMMAND_FILE = "opensourcebook.mjs";
export const OLD_COMMAND_FILE = "re.mjs";

/** The command of the copy in `root`: the new file when it is there, else the one from before the rename. */
export function commandIn(root: string): string | undefined {
  for (const name of [COMMAND_FILE, OLD_COMMAND_FILE]) if (existsSync(join(root, "cli", name))) return join(root, "cli", name);
  return undefined;
}

/** The Open Sourcebook folder the command is run inside of (its command in cli/ and engine/ in a folder above it), if any. */
function copyAround(cwd: string): string | undefined {
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    if (commandIn(dir) && existsSync(join(dir, "engine", "package.json"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * `opensourcebook` belongs to the Open Sourcebook folder it was installed from (`npm link` puts one copy of it on the PATH), not to the folder
 * the person is in. Starting or stopping from inside ANOTHER Open Sourcebook folder would act on the first copy and not the one
 * in front of them, so it says so and does nothing.
 */
export function mustBeThisCopy(ctx: Ctx, what: "start" | "stop" | "update"): void {
  const here = copyAround(ctx.cwd);
  if (!here || real(ctx.root) === here) return;
  throw new Problem(
    "other_copy",
    `This "opensourcebook" belongs to the Open Sourcebook in ${ctx.root}, but you are in the Open Sourcebook in ${here}, so "opensourcebook ${what}" here would act on the other one and not on this one. Nothing was done. For this folder run: node "${commandIn(here)}" ${what}`,
  );
}

interface ProgramState {
  id: string;
  label: string;
  up: boolean;
  url: string;
  about?: string;
}

async function programStates(ctx: Ctx): Promise<{ running: ReturnType<typeof findRunning>; programs: ProgramState[] }> {
  const running = findRunning(ctx.home);
  if (!running) return { running, programs: [] };
  // Read as it is, old names and all: a status never writes to a running copy's folder.
  const secrets = readSecrets(join(ctx.home, "secrets.json")) as Secrets | undefined;
  if (!secrets) throw new Problem("not_running", 'Open Sourcebook is running but its secrets file is gone; stop it with "opensourcebook stop" and start it again.');
  const w: Wiring = { root: ctx.root, home: ctx.home, ports: running.ports, secrets, env: ctx.env };
  const programs = await Promise.all(
    PROGRAMS.map(async (p): Promise<ProgramState> => {
      const health = p.health(w);
      // A program busy making something can be slow to answer once; it counts as down only when it misses twice.
      let answer = await httpProbe(`${url(w, p.id)}${health.path}`, health.token);
      if (!answer.ok) answer = await httpProbe(`${url(w, p.id)}${health.path}`, health.token);
      const about = answer.ok ? p.describe?.(answer.body) : undefined;
      return { id: p.id, label: p.label, up: answer.ok, url: url(w, p.id), ...(about ? { about } : {}) };
    }),
  );
  return { running, programs };
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));

export const run: Group = {
  thing: "",
  about: "Running Open Sourcebook itself:",
  commands: [
    {
      thing: "",
      action: "start",
      summary: "start Open Sourcebook: in this terminal until Ctrl-C, or in the background with --background",
      flags: [
        { name: "background", help: "start it in the background and return once it answers (what an agent wants)" },
        { name: "no-open", help: "do not open the app in the browser" },
        { name: "phone", help: "also let phones on this network use Open Sourcebook, each paired once by a QR code (remembered)" },
        { name: "no-phone", help: "listen on this computer only again (the default; remembered)" },
        { name: "ports-from", value: "port", help: "use ports from this one up instead of each program's usual one" },
        { name: "dev", help: "for working on Open Sourcebook: the watching dev servers, which reload when a file changes, instead of the builds" },
        TIMEOUT_FLAG,
      ],
      shape: "{ url: string, pid: number, already: boolean, log?: string, newer?: boolean }",
      more: "The first start installs each program's packages and takes a few minutes, and the first start after each update builds Open Sourcebook once (seconds; later starts reuse the build). With --background the launcher's own words go to .opensourcebook/logs/launcher.log and this command returns once Open Sourcebook answers.",
      async run(ctx) {
        mustBeThisCopy(ctx, "start");
        const running = findLauncher(ctx.home);
        if (running) {
          if (running.ready === false) return { data: { url: running.url, pid: running.pid, already: true }, text: `Open Sourcebook is already starting (process ${running.pid}); "opensourcebook status" says when it answers.` };
          // Started again while it runs (its shortcut clicked again, or a tab left from an earlier run): a fresh page in the browser, as "opensourcebook open" does.
          const show = !ctx.json && !flagOn(ctx, "no-open") && !flagOn(ctx, "background");
          const opened = show ? await browserAddress(ctx, "/").then((entry) => openUrl(ctx, entry), () => false) : false;
          return { data: { url: running.url, pid: running.pid, already: true, ...(opened ? { opened } : {}) }, text: `Open Sourcebook is already running at ${running.url}.${opened ? " It is opened in the browser again." : ""}` };
        }
        const portsFrom = portsFlag(ctx);
        const launcherArgs = [...(flagOn(ctx, "no-open") || flagOn(ctx, "background") ? ["--no-open"] : []), ...(portsFrom ? ["--ports-from", String(portsFrom)] : []), ...(flagOn(ctx, "phone") ? ["--phone"] : []), ...(flagOn(ctx, "no-phone") ? ["--no-phone"] : []), ...(flagOn(ctx, "dev") ? ["--dev"] : [])];
        if (flagOn(ctx, "phone") && flagOn(ctx, "no-phone")) throw new Problem("bad_arguments", "Say --phone or --no-phone, not both.");
        if (!flagOn(ctx, "background")) {
          if (ctx.json) throw new Problem("bad_arguments", 'In the foreground Open Sourcebook talks to the terminal, not in JSON; use "opensourcebook start --background --json".');
          const { parseArgs, start } = await import("../main.ts");
          const code = await start(parseArgs(launcherArgs, ctx.env));
          return { data: {}, text: "", exit: code };
        }
        // A state folder from before the rename takes its new name here, before the log in it is opened; not while
        // programs of a launcher that is gone still run from it (the launcher then says so and starts nothing).
        const left = readRunning(ctx.home);
        const moved: string[] = [];
        const home = left && ownChildren(left).length ? ctx.home : (ctx.settle?.((line) => moved.push(line)) ?? ctx.home);
        mkdirSync(join(home, "logs"), { recursive: true });
        const log = join(home, "logs", "launcher.log");
        // Appended to, never emptied: what the launcher says about why it stopped must outlive the next start.
        const from = logSize(log);
        const out = openSync(log, "a");
        writeSync(out, `\n--- ${stamp()}  opensourcebook start --background, run from ${ctx.cwd}\n`);
        // What became of a folder from before the rename is said to the person and kept in the log.
        for (const line of moved) {
          writeSync(out, `${line}\n`);
          ctx.progress(line.trim());
        }
        // Said once: the loop below repeats the log's last line only when it is a new one.
        let said = moved.at(-1)?.trim() ?? "";
        const child = spawn(process.execPath, [join(ctx.root, "cli", COMMAND_FILE), ...launcherArgs], {
          cwd: ctx.root,
          env: { ...ctx.env, OPENSOURCEBOOK_NO_OPEN: "1", OPENSOURCEBOOK_BACKGROUND: "1" },
          stdio: ["ignore", out, out],
          detached: true,
          windowsHide: true,
        });
        closeSync(out);
        child.unref();
        let exited = false;
        child.once("exit", () => (exited = true));
        const minutes = Number(flagString(ctx, "timeout") ?? 15);
        const until = Date.now() + minutes * 60_000;
        while (Date.now() < until) {
          const now = findRunning(home);
          if (now && now.pid === child.pid && now.ready !== false) {
            const newer = newerSaidSince(log, from);
            return { data: { url: now.url, pid: now.pid, already: false, log: "logs/launcher.log", ...(newer ? { newer: true } : {}) }, text: `Open Sourcebook is running at ${now.url} (in the background; "opensourcebook open" opens it in this computer's browser, "opensourcebook stop" stops it).${newer ? `\n${newer}` : ""}` };
          }
          if (exited || (child.pid !== undefined && !alive(child.pid))) {
            const last = tail(log, 6).join(" / ");
            throw new Problem("start_failed", `Open Sourcebook did not start. The launcher said: ${last || "nothing"}. All of it is in ${log}.`);
          }
          const line = tail(log, 1)[0]?.trim();
          if (line && line !== said) {
            ctx.progress(line);
            said = line;
          }
          await sleep(ctx.pollMs * 2);
        }
        throw new Problem("timeout", `Open Sourcebook did not answer within ${minutes} minutes. What it is doing is in ${log}; "opensourcebook status" says what is up.`);
      },
    },
    {
      thing: "",
      action: "stop",
      summary: "stop the running Open Sourcebook and everything it started",
      shape: "{ stopped: boolean }",
      async run(ctx) {
        mustBeThisCopy(ctx, "stop");
        const record = readRunning(ctx.home);
        if (!record) return { data: { stopped: false }, text: "Open Sourcebook is not running." };
        // Only what this copy recorded, and only while it is still the very process it recorded (same start time).
        const launcher = stillTheSame(record.pid, record.startedAt, true);
        const programs = ownChildren(record);
        if (!launcher && !programs.length) {
          removeRunning(ctx.home);
          const other = alive(record.pid) ? ` Process ${record.pid} is something else now and was left alone.` : "";
          return { data: { stopped: false }, text: `Open Sourcebook is not running (the record of an Open Sourcebook that is gone was removed).${other}` };
        }
        if (launcher) {
          askToStop(ctx.home, { from: ctx.cwd, by: process.pid, target: record.pid, at: new Date().toISOString() });
          if (process.platform === "win32") {
            // Windows has no signal the launcher can catch: it reads the note above itself and stops as it would on
            // one. Only a launcher that does not is ended outright, with everything under it. The process was known
            // as the launcher above, so from here on its going away is enough.
            for (let i = 0; i < 100 && alive(record.pid); i++) await sleep(200);
            if (alive(record.pid)) signalTree(record.pid, "SIGKILL");
            for (let i = 0; i < 50 && alive(record.pid); i++) await sleep(200);
            clearStopRequest(ctx.home);
            if (alive(record.pid)) throw new Problem("stop_failed", `Open Sourcebook (process ${record.pid}) did not stop within 30 seconds; stop it with Ctrl-C in its terminal.`);
          } else {
            try {
              process.kill(record.pid, "SIGTERM");
            } catch {
              // Already gone.
            }
            for (let i = 0; i < 150 && stillTheSame(record.pid, record.startedAt); i++) await sleep(200);
            clearStopRequest(ctx.home);
            if (stillTheSame(record.pid, record.startedAt)) throw new Problem("stop_failed", `Open Sourcebook (process ${record.pid}) did not stop within 30 seconds; stop it with Ctrl-C in its terminal.`);
          }
        }
        // Programs the launcher left behind (it was killed, or crashed): its own recorded ones, nothing else.
        const left = ownChildren(record);
        for (const c of left) signalTree(c.pid, "SIGTERM");
        for (let i = 0; i < 25 && left.some((c) => stillTheSame(c.pid, c.startedAt)); i++) await sleep(200);
        for (const c of left) if (stillTheSame(c.pid, c.startedAt)) signalTree(c.pid, "SIGKILL");
        removeRunning(ctx.home);
        return { data: { stopped: true }, text: "Stopped. Nothing of Open Sourcebook is left running." };
      },
    },
    {
      thing: "",
      action: "status",
      summary: "whether Open Sourcebook is running, and whether each of its programs answers",
      shape: "{ running: boolean, url?: string, programs: [{ id, label, up: boolean, url, about? }] }",
      async run(ctx) {
        const { running, programs } = await programStates(ctx);
        if (!running) return { data: { running: false, programs: [] }, text: `Open Sourcebook is not running. ${START_HINT}`, exit: 1 };
        const width = Math.max(...programs.map((p) => p.label.length)) + 2;
        const text = [`Open Sourcebook is running at ${running.url}`, ...programs.map((p) => `  ${pad(p.label, width)}${p.up ? "up" : "not answering"}  ${p.url}${p.about ? `  (${p.about})` : ""}`)].join("\n");
        return { data: { running: true, url: running.url, programs }, text, exit: programs.every((p) => p.up) ? 0 : 1 };
      },
    },
    {
      thing: "",
      action: "open",
      summary: "show Open Sourcebook in this computer's browser (the browser is let in by an address that works once)",
      flags: [PRINT_FLAG],
      shape: "{ url: string, opened: boolean, open?: string }",
      async run(ctx) {
        const entry = await browserAddress(ctx, "/");
        const plain = new URL(entry).origin;
        const opened = !flagOn(ctx, "print") && openUrl(ctx, entry);
        return { data: { url: plain, opened, ...(opened ? {} : { open: entry }) }, text: opened ? `Opened ${plain} in the browser on this computer.` : `${entry}\n(works once, for ten minutes, in this computer's browser)` };
      },
    },
    {
      thing: "",
      action: "check",
      summary: "what this computer has for Open Sourcebook and what it lacks",
      shape: "{ ready: boolean, lines: [{ status: \"ok\"|\"note\"|\"missing\", text, blocks? }] }",
      async run(ctx) {
        if (!existsSync(join(ctx.root, "engine"))) throw new Problem("not_opensourcebook", "This copy of the command has no Open Sourcebook folder next to it.");
        const all = lines(await gather(ctx.root, ctx.env));
        const mark = { ok: "ok  ", note: "note", missing: "fix " } as const;
        const ready = !all.some((l) => l.blocks);
        const notices = all.filter((l) => l.notice).map((l) => l.text);
        return { data: { ready, lines: all, notices }, text: all.map((l) => `  ${mark[l.status]}  ${l.text}`).join("\n"), exit: ready ? 0 : 1 };
      },
    },
  ],
};
