/**
 * Finding the running Open Sourcebook and talking to its engine. A running launcher writes `.opensourcebook/running.json` in its clone (its
 * process, the web app's address and every program's port); the shared client token is in `.opensourcebook/secrets.json`. The
 * command reads both from the clone it belongs to, so it works from any folder. No secret is ever printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alive, findLauncher, type Running } from "../record.ts";
import { readSecrets, writePrivate } from "../secrets.ts";
import { pickNeededLine } from "./picks.ts";
import { Problem, flagString, type Ctx } from "./table.ts";

export const START_HINT = 'Start it first: open Open Sourcebook with its shortcut, or run "opensourcebook start --background" (or "npm start" in its folder). Then run this again.';

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export { alive, type Running };

/** The running Open Sourcebook of this clone, or undefined when none is running (a record whose process is not the launcher any more does not count). */
export function findRunning(home: string): Running | undefined {
  const running = findLauncher(home);
  if (!running || !running.ports || running.ready === false) return undefined;
  return running;
}

export interface Engine {
  base: string;
  web: string;
  call<T = Record<string, unknown>>(method: string, path: string, options?: CallOptions): Promise<T>;
  /** Raw bytes of a route (an asset), for saving a file. */
  bytes(path: string): Promise<{ data: Uint8Array; type: string }>;
}

export interface CallOptions {
  json?: unknown;
  query?: Record<string, string | number | undefined>;
  body?: Uint8Array;
  headers?: Record<string, string>;
}

/** Connects to the running Open Sourcebook, or says plainly that it is not running and how to start it. */
export function connect(ctx: Pick<Ctx, "home">): Engine {
  const running = findRunning(ctx.home);
  if (!running) throw new Problem("not_running", `Open Sourcebook is not running. ${START_HINT}`);
  const secrets = readSecrets(join(ctx.home, "secrets.json"));
  if (!secrets?.OPENSOURCEBOOK_CLIENT_TOKEN) throw new Problem("not_running", "Open Sourcebook is running but its secrets file is gone; stop it with \"opensourcebook stop\" and start it again.");
  const port = running.ports.engine;
  if (!port) throw new Problem("not_running", "Open Sourcebook is running but did not say where its engine is; stop it with \"opensourcebook stop\" and start it again.");
  return engineAt(`http://127.0.0.1:${port}`, running.url, secrets.OPENSOURCEBOOK_CLIENT_TOKEN);
}

/** How long a call waits for the engine's answer. Adding or retrying a large source is read while the call waits. */
export const CALL_WAIT_MS = 120_000;

export function engineAt(base: string, web: string, token: string, waitMs = CALL_WAIT_MS): Engine {
  const unreachable = () => new Problem("engine_unreachable", `Open Sourcebook's engine did not answer at ${base}. Run "opensourcebook status" to see what is up; if Open Sourcebook stopped, ${START_HINT.charAt(0).toLowerCase()}${START_HINT.slice(1)}`);
  // The engine took the call and is still at it, most often reading a large source: busy, not unreachable.
  const busy = () => new Problem("engine_busy", `Open Sourcebook's engine is busy reading, please wait. It took this and is still working on it (a large source can take a few minutes to read); check in a minute with "opensourcebook source list".`);
  const go = async (method: string, path: string, options: CallOptions = {}): Promise<Response> => {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { "x-client-token": token, ...(options.headers ?? {}) };
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.body) body = options.body as unknown as BodyInit;
    try {
      return await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(waitMs) });
    } catch (error) {
      throw (error as { name?: string } | undefined)?.name === "TimeoutError" ? busy() : unreachable();
    }
  };
  return {
    base,
    web,
    async call<T>(method: string, path: string, options?: CallOptions): Promise<T> {
      const response = await go(method, path, options);
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = undefined;
      }
      if (!response.ok) throw engineProblem(response.status, parsed);
      if (parsed === undefined) throw new Problem("engine_error", `Open Sourcebook's engine answered ${path} with something that is not JSON.`);
      return parsed as T;
    },
    async bytes(path: string) {
      const response = await go("GET", path);
      if (!response.ok) throw engineProblem(response.status, undefined);
      return { data: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") ?? "" };
    },
  };
}

/** The engine's `{ error, message, issues? }` as one plain problem, keeping its code. */
export function engineProblem(status: number, body: unknown): Problem {
  const b = (body ?? {}) as { error?: string; message?: string; issues?: unknown[]; scope?: unknown; scopes?: unknown };
  const code = typeof b.error === "string" ? b.error : status === 404 ? "not_found" : "engine_error";
  // Who should make it is the person's to pick: one line naming what needs a pick and the command that sets it.
  if (code === "pick_needed") {
    const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s): s is string => typeof s === "string") : typeof b.scope === "string" ? [b.scope] : [];
    return new Problem(code, pickNeededLine(scopes));
  }
  let message = typeof b.message === "string" && b.message ? b.message : `Open Sourcebook's engine answered ${status}.`;
  if (!/[.!?]$/.test(message)) message += ".";
  const issues = Array.isArray(b.issues) ? b.issues.map((i) => (typeof i === "string" ? i : (i as { message?: string })?.message)).filter(Boolean) : [];
  if (issues.length) message += ` ${issues.join(" ")}${/[.!?]$/.test(String(issues.at(-1))) ? "" : "."}`;
  if (code === "not_found") message += " Check the id (the list commands show them).";
  return new Problem(code, message);
}

/** The project used last by this clone's command, kept in `.opensourcebook/command.json`. */
export function rememberProject(ctx: Pick<Ctx, "home">, projectId: string): void {
  if (!existsSync(ctx.home)) return;
  writePrivate(join(ctx.home, "command.json"), `${JSON.stringify({ project: projectId }, null, 2)}\n`);
}

export function lastProject(ctx: Pick<Ctx, "home">): string | undefined {
  return readJson<{ project?: string }>(join(ctx.home, "command.json"))?.project;
}

/** The project a command is about: `--project`, else the one used last; says how to pick one when there is none. A command that works with `--project` keeps it as the one used last (`runCommand`). */
export function projectOf(ctx: Ctx): string {
  const id = flagString(ctx, "project") ?? lastProject(ctx);
  if (!id) throw new Problem("no_project", 'No project picked. Make one with "opensourcebook project make <title>", or name one with --project <id> ("opensourcebook project list" shows them).');
  return id;
}
