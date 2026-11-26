/**
 * Finding an agent's program that is not on the PATH the connector started with. A program installed while Open
 * Sourcebook runs is not on that PATH, and some installers put their program in a folder they never add to PATH at
 * all (on Windows, `%USERPROFILE%\.local\bin`). So when the bare name is not found, the folders programs are usually
 * installed in are looked in, then the folders the adapter names as its own install places, and on Windows the
 * person's PATH as it is saved now, which a new install may have changed. When none has it, the bare name is kept
 * and the program is reported missing as before.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { findOnWindows } from "./command.ts";

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
  /** The person's PATH as it is saved now (Windows), read again at each look; undefined when it cannot be read. */
  savedPath?: () => string | undefined;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Folders under the home folder where installers commonly put programs, for any agent. */
const HOME_FOLDERS = [".local/bin", "bin", ".npm-global/bin", ".bun/bin", ".volta/bin", ".yarn/bin"];
/** System folders a program may be in when the connector's PATH is short (a start from a shortcut gets a short one). */
const SYSTEM_FOLDERS = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];

function envOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** `env` with its PATH (in whatever spelling) set to `value`. */
function withPath(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== "PATH")), PATH: value };
}

/** The folders looked in, in order, for a program that is not on the PATH: common ones, then the adapter's own (`places`, under the home folder). */
export function installFolders(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, places: readonly string[] = []): string[] {
  if (platform === "win32") {
    const appData = envOf(env, "APPDATA");
    const local = envOf(env, "LOCALAPPDATA");
    return [
      ...HOME_FOLDERS.map((f) => win32.join(home, ...f.split("/"))),
      ...(appData ? [win32.join(appData, "npm")] : []),
      ...(local ? [win32.join(local, "Microsoft", "WinGet", "Links")] : []),
      ...places.map((f) => win32.join(home, ...f.split("/"))),
    ];
  }
  return [...HOME_FOLDERS.map((f) => posix.join(home, f)), ...SYSTEM_FOLDERS, ...places.map((f) => posix.join(home, f))];
}

/** Where `name` is on this PATH (POSIX), or undefined. */
function onPath(name: string, pathVar: string | undefined, exists: (path: string) => boolean): string | undefined {
  return (pathVar ?? "").split(":").filter(Boolean).map((d) => posix.join(d, name)).find(exists);
}

/** The person's PATH as Windows keeps it now, the person's own then the computer's, with `%VARS%` filled in. */
export function savedWindowsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const read = (key: string) => {
    try {
      const out = execFileSync("reg", ["query", key, "/v", "Path"], { encoding: "utf8", timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      return /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(out)?.[1]?.trim();
    } catch {
      return undefined;
    }
  };
  const parts = [read("HKCU\\Environment"), read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")].filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(";").replace(/%([^%]+)%/g, (whole, name: string) => envOf(env, name.toUpperCase()) ?? whole);
}

/**
 * Where to start `name`: the name itself when it is on the PATH or has a folder, else the first install place that
 * has it, else the name (missing). `places` are the adapter's own install folders, relative to the home folder.
 */
export function programOf(name: string, places: readonly string[] = [], options: LocateOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const home = options.home ?? homedir();
  const hasFolder = /[\\/]/.test(name) || (platform === "win32" ? win32.isAbsolute(name) : posix.isAbsolute(name));
  if (hasFolder) return name;
  if (platform === "win32") {
    if (findOnWindows(name, env, exists)) return name;
    const folders = installFolders(platform, env, home, places).join(";");
    const inPlace = findOnWindows(name, withPath(env, folders), exists);
    if (inPlace) return inPlace;
    const saved = (options.savedPath ?? (() => savedWindowsPath(env)))();
    return (saved && findOnWindows(name, withPath(env, saved), exists)) || name;
  }
  if (onPath(name, envOf(env, "PATH"), exists)) return name;
  return onPath(name, installFolders(platform, env, home, places).join(":"), exists) ?? name;
}
