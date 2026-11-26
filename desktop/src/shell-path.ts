/**
 * The PATH the programs get. An app opened from the Finder (or the Dock, or Spotlight) gets the system's bare PATH,
 * /usr/bin:/bin:/usr/sbin:/sbin, so the person's agent (claude, codex and the rest, often in ~/.local/bin, a Homebrew
 * folder or an nvm folder) would not be found. So the person's own login shell is asked once what its PATH is, the
 * usual folders are added after it, and the app's own Node and tools go first.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter as hostDelimiter, join } from "node:path";

const MARK = "__OPENSOURCEBOOK_PATH__";

/** The command that makes a shell print its PATH between two marks, so whatever its start files print is ignored. */
export function printPathArgs(): string[] {
  return ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`];
}

/** The PATH between the marks in what the shell printed, or undefined when it is not there. */
export function parseShellPath(output: string): string | undefined {
  const start = output.indexOf(MARK);
  if (start < 0) return undefined;
  const end = output.indexOf(MARK, start + MARK.length);
  if (end < 0) return undefined;
  const path = output.slice(start + MARK.length, end).trim();
  return path || undefined;
}

/** The usual places an agent or a tool is installed in, after the shell's own. */
export function usualFolders(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === "win32") return [];
  const folders = [join(home, ".local", "bin")];
  if (platform === "darwin") folders.push("/opt/homebrew/bin", "/opt/homebrew/sbin");
  folders.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return folders;
}

/** Joins PATH lists in order, each folder once, empty entries dropped. */
export function mergePath(lists: Array<string | undefined>, delimiter = hostDelimiter): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of (list ?? "").split(delimiter)) {
      const d = dir.trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(delimiter);
}

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>;

/** Runs a shell with no terminal and nothing to read, and resolves with what it printed (empty when it fails or is slow). */
export const runShell: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(shell, args, { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_DISABLE_COMPFIX: "true" } });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out);
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (text: string) => (out += text));
    child.once("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });

/** The person's login shell: $SHELL, else zsh on a Mac and bash elsewhere. */
export function loginShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  run?: ShellRunner;
  timeoutMs?: number;
  /** Folders put before everything else: the app's own Node and its tools. */
  first?: string[];
}

/**
 * The PATH for the programs: the app's own folders, the login shell's PATH, the usual folders, then whatever this
 * process was given. Windows apps get the person's PATH already, so there the shell is not asked.
 */
export async function resolvePath(options: PathOptions = {}): Promise<{ path: string; fromShell: boolean }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const delimiter = platform === "win32" ? ";" : ":";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  let shellPath: string | undefined;
  if (platform !== "win32") {
    const output = await (options.run ?? runShell)(loginShell(env, platform), printPathArgs(), options.timeoutMs ?? 8000);
    shellPath = parseShellPath(output);
  }
  const path = mergePath([(options.first ?? []).join(delimiter), shellPath, usualFolders(platform, options.home ?? homedir()).join(delimiter), env[key]], delimiter);
  return { path, fromShell: shellPath !== undefined };
}
