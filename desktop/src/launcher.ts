/**
 * Talking to the launcher in `app/`: the same `opensourcebook` command a person runs in a terminal, run with the app's
 * own Node. `start --background --json` starts the four programs and returns once they answer, saying what it is doing
 * on the way (one line at a time on stderr); `open --print --json` gives the one-time address that lets this window in;
 * `stop --json` stops everything it started.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface Answer {
  code: number;
  /** The last JSON line the command printed, when there is one. */
  json?: Record<string, unknown>;
  /** Its last words on stderr, for an error a person reads. */
  said: string[];
}

/** The last line of `stdout` that is a JSON object. */
export function lastJson(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Not JSON: the next line up.
    }
  }
  return undefined;
}

/**
 * A progress line from the launcher, as a person reads it: no colour codes, no spinner frames, no leading space, and
 * nothing for the log's own heading of a start ("--- <time>  opensourcebook start --background, run from ...").
 */
export function plainLine(line: string): string {
  if (/^\s*--- \d{4}-\d\d-\d\d /.test(line)) return "";
  return line
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+/u, "")
    .trim();
}

export interface RunOptions {
  node: string;
  app: string;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  /** What the command printed on stdout (its JSON answer), for the log. Progress lines go to onLine only. */
  onLog?: (text: string) => void;
}

/** Runs `opensourcebook <args>` from `app/` and resolves with its answer; never rejects. */
export function runLauncher(args: string[], options: RunOptions): Promise<Answer> {
  return new Promise((resolve) => {
    let stdout = "";
    let rest = "";
    const said: string[] = [];
    const child = spawn(options.node, [join(options.app, "cli", "opensourcebook.mjs"), ...args], { cwd: options.app, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
      options.onLog?.(text);
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      const lines = (rest + text).split(/\r?\n|\r/);
      rest = lines.pop() ?? "";
      for (const raw of lines) {
        const line = plainLine(raw);
        if (!line) continue;
        said.push(line);
        if (said.length > 20) said.shift();
        options.onLine?.(line);
      }
    });
    child.once("error", (error) => resolve({ code: 127, said: [...said, error.message] }));
    child.once("close", (code) => {
      const json = lastJson(stdout);
      resolve({ code: code ?? 1, ...(json ? { json } : {}), said });
    });
  });
}

/** The message of a launcher's `{ ok: false, error: { message } }`, else its last few words (a crash's error line among them). */
export function failure(answer: Answer): string {
  const error = answer.json?.error as { message?: unknown } | undefined;
  if (typeof error?.message === "string") return error.message;
  const thrown = answer.said.find((line) => /^\w*Error\b/.test(line));
  const last = answer.said.slice(-3);
  const words = thrown && !last.includes(thrown) ? [thrown, ...last] : last;
  return words.length ? words.join("\n") : `The launcher stopped with code ${answer.code}.`;
}

/**
 * The page the launcher asks the window to show again (`{ to, at }`, written where OPENSOURCEBOOK_REOPEN_FILE says):
 * a path of the web app, else its home page; undefined when there is no request in it.
 */
export function reopenRequest(text: string): { to: string; at: string } | undefined {
  try {
    const asked = JSON.parse(text) as { to?: unknown; at?: unknown };
    if (typeof asked.at !== "string") return undefined;
    const to = typeof asked.to === "string" && asked.to.startsWith("/") && !asked.to.startsWith("//") && !asked.to.includes("\\") ? asked.to : "/";
    return { to, at: asked.at };
  } catch {
    return undefined;
  }
}

/** The one-time address `open --print` gave, made to show `to` once it lets the window in. */
export function openingTo(entry: string, to: string): string {
  const url = new URL(entry);
  url.searchParams.set("to", to);
  return url.toString();
}
