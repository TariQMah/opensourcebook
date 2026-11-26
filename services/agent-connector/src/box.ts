/**
 * The box: how an agent's own tools (its shell, files, web) are turned on for a piece of work without reaching the
 * rest of the computer. The agent runs inside macOS's sandbox (Seatbelt, through `sandbox-exec`), which every process it
 * starts inherits, so a shell command, a script or a downloaded tool is held by the same walls as the agent:
 *
 * - It reads and writes freely in the work's own folder, and reads, without changing, what the caller named beside it
 *   (`reachOf`: a video's note, sources and what was read from them, and the exact files its links lead to).
 * - Nothing else in the person's home folder can be read or written (Desktop, Documents, other projects, keys, mail,
 *   other apps' data), nor other drives or shared folders. Only what the agent needs to run is opened: the folders its
 *   own program and the tools on its PATH live in (read only), and a settings folder of its own that is not the person's.
 * - The person's keychains and their agent's login file stay shut whatever else is open: an agent with a shell of its
 *   own never runs on the person's login (it runs on an API key the connector adds outside the box; see the adapter).
 *   The one exception is an agent with no shell and no web of its own (a files-only workspace): it runs on its own
 *   login, so the places its program keeps that login and its own state are opened to it (`own`), and nothing else.
 * - Outside the home folder the system can be read (it has to run programs) but not written, except devices.
 * - The shared temporary folders (/private/tmp, /private/var/folders, /private/var/tmp) are shut, reading and writing:
 *   other programs keep their files and sockets there. The agent has a temporary folder of its own for the turn instead.
 * - It can reach the web, but nothing on this computer's network address except this connector, which serves its turn,
 *   and no Unix socket (an ssh agent's, Docker's) but the system's name lookup.
 *
 * Where there is no such sandbox (anything but macOS), there is no box, and an agent runs with its own tools off as
 * before. The walls are the operating system's, not the agent's settings, so they hold whatever the agent decides.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface BoxSpec {
  /** The work's own folder. */
  workspace: string;
  home: string;
  /** Files and folders opened read only (absolute). */
  read: string[];
  /** Folders opened read and write (absolute), besides the workspace. */
  write: string[];
  /** Files and folders shut for reading and writing whatever else is open (absolute), e.g. a login file. */
  deny?: string[];
  /**
   * Where the agent's own program keeps its login and state (absolute path prefixes, e.g. `~/.claude` matching
   * `~/.claude.json` too), opened read and write after the keychain wall. Only for an agent with no shell and no web
   * of its own, which runs on its own login the way it normally does; Open Sourcebook itself never reads any of it.
   */
  own?: string[];
  /** This connector's port on loopback, the one local address the agent may reach. */
  connectorPort: number;
  /**
   * The agent's own temporary folder for this turn (`boxTemp`), read and write; its TMPDIR. The shared temporary folders
   * (`/private/tmp`, `/private/var/folders`, `/private/var/tmp`) are shut, as other programs keep files and sockets there.
   */
  tmp?: string;
}

/** The shared temporary folders, by their real paths: other programs' files, caches and sockets (an ssh agent's) live there. */
export const SHARED_TEMP = ["/private/tmp", "/private/var/folders", "/private/var/tmp"];

/**
 * The one Unix socket a boxed program may connect to: the system's name lookup, how a program on macOS finds a web
 * address (without it no name resolves). Every other socket (an ssh agent's, Docker's, other tools') stays shut.
 */
export const SYSTEM_SOCKETS = ["/private/var/run/mDNSResponder"];

export interface Box {
  readonly kind: "seatbelt";
  /** The command that runs `bin args` inside the box. */
  wrap(bin: string, args: string[], spec: BoxSpec): { bin: string; args: string[] };
}

/** The box this computer has, if any. */
export function boxForPlatform(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): Box | undefined {
  if (platform !== "darwin" || !exists(SANDBOX_EXEC)) return undefined;
  return { kind: "seatbelt", wrap: (bin, args, spec) => ({ bin: SANDBOX_EXEC, args: ["-p", seatbeltProfile(spec), bin, ...args] }) };
}

const quote = (path: string) => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A Seatbelt regex matching every path that starts with `prefix`. */
export const startsWith = (prefix: string) => `(regex ${quote(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)})`;

/** The Seatbelt profile for one piece of work. Later rules win over earlier ones. */
export function seatbeltProfile(spec: BoxSpec): string {
  const subpaths = (paths: string[]) => [...new Set(paths)].map((p) => `(subpath ${quote(p)})`).join(" ");
  // The sandbox sees real paths (/private/var/folders, not /var/folders), so every path is named by its real one.
  const home = realPath(spec.home);
  const workspace = realPath(spec.workspace);
  const read = spec.read.map(realPath);
  const write = [...spec.write, ...(spec.tmp ? [spec.tmp] : [])].map(realPath);
  const opened = [workspace, ...read, ...write];
  const lines = [
    "(version 1)",
    "(allow default)",
    "; Nothing in the home folder, on other drives or in shared folders, unless opened below.",
    `(deny file-read* file-write* (subpath ${quote(home)}) (subpath "/Volumes") (subpath "/Users/Shared"))`,
    "; Nor the shared temporary folders, where other programs keep their files and sockets; the agent has its own.",
    `(deny file-read* file-write* ${subpaths(SHARED_TEMP)})`,
    "; No writes anywhere on the system either, unless opened below.",
    '(deny file-write* (subpath "/"))',
    "; Programs may still see that the home folder, the temporary folders and the folders above what is opened below",
    "; exist (not what is in them), as many check them before they start: Node resolves a real path folder by folder.",
    `(allow file-read-metadata ${["/Users", home, ...SHARED_TEMP, ...ancestors(opened, home), ...SHARED_TEMP.flatMap((t) => ancestors(opened, t))].map((p) => `(literal ${quote(p)})`).join(" ")})`,
    ...(read.length ? ["; The agent's own program and the tools on its PATH, read only.", `(allow file-read* ${subpaths(read)})`] : []),
    "; The work's own folder, the agent's own temporary folder, and its own settings and logs.",
    `(allow file-read* file-write* ${subpaths([workspace, ...write])})`,
    "; Devices (/dev/null, /dev/tty and the like).",
    '(allow file-write* (subpath "/dev"))',
    "; The person's keychains, and any login file named here, stay shut whatever is open above.",
    `(deny file-read* file-write* ${subpaths([join(home, "Library", "Keychains"), ...(spec.deny ?? []).map(realPath)])})`,
    ...(spec.own?.length ? ["; An agent with no shell and no web of its own reaches its own login and state the way it normally does.", `(allow file-read* file-write* ${spec.own.map(realPath).map(startsWith).join(" ")})`] : []),
    "; No other program's socket on this computer (an ssh agent's, Docker's), except the system's name lookup.",
    "(deny network-outbound (remote unix-socket))",
    `(allow network-outbound ${SYSTEM_SOCKETS.map((p) => `(remote unix-socket (path-literal ${quote(p)}))`).join(" ")})`,
    "; The web, but nothing on this computer's own address except this connector.",
    '(deny network-outbound (remote ip "localhost:*"))',
    `(allow network-outbound (remote ip "localhost:${spec.connectorPort}"))`,
  ];
  return lines.join("\n");
}

/** `path` by its real path, as far as it exists (the rest kept as given): /var/folders/… becomes /private/var/folders/…. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/**
 * A fresh temporary folder of the agent's own for one turn (0700, in this user's temporary folder, by its real path),
 * opened in the box as its TMPDIR while the shared ones stay shut. The caller removes it when the turn ends.
 */
export async function boxTemp(parent: string = tmpdir()): Promise<string> {
  return realpathSync(await mkdtemp(join(parent, "opensourcebook-box-tmp-")));
}

/** The environment that points a boxed program at its own temporary folder. */
export function tempEnv(tmp: string | undefined): NodeJS.ProcessEnv {
  return tmp ? { TMPDIR: `${tmp}/`, TMP: tmp, TEMP: tmp } : {};
}

/** The folders between the home folder and each of `paths` (inside it), not counting either end. */
export function ancestors(paths: string[], home: string): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    if (!within(path, home) || path === home) continue;
    for (let dir = dirname(path); dir !== home && within(dir, home); dir = dirname(dir)) found.add(dir);
  }
  return [...found].sort();
}

/** Whether `child` is `parent` or inside it. */
export function within(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
}

/**
 * Folders anywhere under the home folder where an agent, a tool or a program keeps its own settings, logins or keys
 * (~/.ssh, ~/.claude, a project's .claude): never a workspace, not even inside a folder the connector was set up with.
 */
const SETTINGS = /(^|[\\/])\.(claude|codex|gemini|cursor|copilot|ssh|gnupg|aws|config|netrc|docker|kube|azure|gcloud)([\\/]|$)/;

/**
 * The workspace a caller asked for, checked: an existing folder, by its real path, at least two levels inside the home
 * folder or inside a temporary folder (this user's own, or /private/tmp), and never the home folder, a folder above it,
 * or a place a program keeps its own state: not ~/Library (the apps' own data) unless inside one of `roots`, no agent's or tool's settings folder at
 * any depth (`SETTINGS`), and no dot folder at the top of the home folder (~/.kube, ~/.local, any of them: where tools
 * keep settings and logins) unless the workspace is inside one of `roots`. Those are the work folders this connector
 * was set up with in its own environment, never by a request (the scenes service's, OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS):
 * an installed copy keeps them in `~/.opensourcebook/app/services/scenes/.data`, the desktop app in its data folder,
 * `~/Library/Application Support/Open Sourcebook/jobs` (docs/JOB-FOLDER.md). Under ~/Library only a workspace inside
 * such a root is allowed, and a root there counts only three levels down or deeper; the rest of ~/Library stays refused. A dot folder deeper inside a project is
 * fine: Open Sourcebook's video maker works in `services/scenes/.data/<job>/work`.
 */
export function checkWorkspace(path: unknown, home: string = homedir(), temp: string = tmpdir(), roots: readonly string[] = []): { path: string } | { problem: string } {
  if (typeof path !== "string" || !isAbsolute(path)) return { problem: "workspace.path must be an absolute path." };
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isDirectory()) return { problem: "workspace.path must be a folder." };
  } catch {
    return { problem: "workspace.path does not exist." };
  }
  const realHome = existsSync(home) ? realpathSync(home) : home;
  return judgeWorkspace(real, realHome, [realPath(temp), "/private/tmp"], roots.map(realPath));
}

/**
 * `checkWorkspace`'s judgement of a folder already named by its real path, against the real paths of the home folder,
 * the temporary folders and the connector's own work folders (`roots`).
 */
export function judgeWorkspace(real: string, home: string, temps: readonly string[], roots: readonly string[] = []): { path: string } | { problem: string } {
  const own = "workspace.path must be a folder of its own, inside the home folder or a temporary folder.";
  if (within(home, real)) return { problem: own };
  if (within(real, home)) {
    const inside = relative(home, real);
    const parts = inside.split(sep);
    if (parts.length < 2) return { problem: own };
    // A root is trusted only inside the home folder and below it, never the home folder itself, and under ~/Library only
    // as an app's own folder there or deeper (~/Library/Application Support/Open Sourcebook/jobs), never ~/Library itself.
    const rooted = (root: string) => within(root, home) && root !== home && (relative(home, root).split(sep)[0] !== "Library" || relative(home, root).split(sep).length >= 3);
    const inRoot = roots.some((root) => rooted(root) && within(real, root) && real !== root);
    if (SETTINGS.test(inside) || (parts[0] === "Library" && !inRoot)) return { problem: "workspace.path can't be inside an agent's, a tool's or an app's own settings." };
    if (parts[0]!.startsWith(".") && !inRoot) return { problem: `workspace.path can't be inside ${parts[0]} at the top of the home folder, where programs keep their own settings, unless it is inside one of the work folders this connector was set up with.` };
    return { path: real };
  }
  // A temporary folder: this user's own (not other users' or the system's caches beside it in /private/var/folders), or /private/tmp.
  return temps.some((t) => within(real, t) && real !== t) ? { path: real } : { problem: own };
}

/** Folders in the home folder whose contents are the person's own, never opened for a tool. */
const PERSONAL = /^(Desktop|Documents|Downloads|Library|Movies|Music|Pictures|Public)$/;
/** Folders that hold logins and keys, never opened for a tool. */
const SECRET = /(^|[\\/])\.(ssh|gnupg|aws|config|netrc|docker|kube|azure|gcloud)([\\/]|$)/;

/** Whether a path under the home folder may be opened read only for a tool: not a personal or secret folder, and not the home folder itself. */
function openable(path: string, home: string): boolean {
  if (!within(path, home) || path === home) return false;
  const inside = relative(home, path);
  return !PERSONAL.test(inside.split(sep)[0]!) && !SECRET.test(inside);
}

/**
 * Where a program found under the home folder lives, as narrowly as it can run from: the package it belongs to (the
 * nearest folder above it with a package.json, as npm installs it), else the folder above its `bin`, else its own folder.
 * Never a first-level folder of the home folder as a whole (~/.npm-global, ~/.local): then only the file itself.
 */
export function installOf(file: string, home: string, exists: (path: string) => boolean = existsSync): string | undefined {
  if (!openable(file, home)) return undefined;
  const depth = (p: string) => relative(home, p).split(sep).length;
  let dir = dirname(file);
  while (depth(dir) >= 2) {
    if (exists(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  const own = dirname(file);
  const root = own.endsWith(`${sep}bin`) ? dirname(own) : own;
  return depth(root) >= 2 && openable(root, home) ? root : file;
}

export interface ToolFs {
  exists(path: string): boolean;
  /** The entries of a folder, empty when it can't be read. */
  list(dir: string): string[];
  /** Where a link points, by its real path; undefined when it is not a link. */
  link(path: string): string | undefined;
}

const realFs: ToolFs = {
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  link: (path) => {
    try {
      return lstatSync(path).isSymbolicLink() ? realpathSync(path) : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * What the tools on PATH need of the home folder, read only: each PATH folder under it itself (~/.npm-global/bin, not
 * ~/.npm-global), the install of each program linked from there (`installOf`), and a Homebrew kept in the home folder
 * as a whole (the folder that holds its `Cellar`). Personal and secret folders are never opened.
 */
export function toolReads(pathVar: string | undefined, home: string, fs: ToolFs = realFs): string[] {
  const reads = new Set<string>();
  for (const entry of (pathVar ?? "").split(":")) {
    if (!entry || !isAbsolute(entry) || !openable(entry, home)) continue;
    reads.add(entry);
    const prefix = dirname(entry);
    if (prefix !== home && fs.exists(join(prefix, "Cellar"))) {
      reads.add(prefix);
      continue;
    }
    for (const name of fs.list(entry)) {
      const target = fs.link(join(entry, name));
      const install = target && installOf(target, home, fs.exists);
      if (install && !within(install, entry)) reads.add(install);
    }
  }
  return dropNested([...reads]);
}

/** The install of the agent's own program (resolving links), read only, when it lives under the home folder. */
export function programReads(bin: string, pathVar: string | undefined, home: string): string[] {
  const found = isAbsolute(bin) ? (existsSync(bin) ? bin : undefined) : (pathVar ?? "").split(":").map((d) => join(d, bin)).find((p) => existsSync(p));
  if (!found) return [];
  const install = installOf(realpathSync(found), home);
  return install ? [install] : [];
}

/** The paths that are not inside another one of them. */
function dropNested(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && within(p, q)));
}

/** The only parts of the connector's environment a boxed agent gets, besides its own settings. Nothing else (keys, the connector's token) passes. */
export const PLAIN_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"];

export function plainEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(PLAIN_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/**
 * What an agent may reach in files for one piece of work, by real paths, on any computer: it reads and writes in
 * `write` (its workspace) and only reads `folders` and `files`, nothing else of the person's. On a Mac the box holds
 * it (`withReach`), and the agent's own rules too where they can say it; on Linux and Windows there is no box yet, and
 * a sandbox there is meant to take this same list.
 */
export interface Reach {
  write: string[];
  /** Folders beside the workspace opened read only, as the caller named them (a job folder's `sources/`, `extracted/`). */
  folders: string[];
  /**
   * Files opened read only: the ones the caller named beside the workspace (a job folder's `README.md`), and the exact
   * file each link in the named folders leads to (a source's original, wherever the person keeps it), never the folder
   * that holds it.
   */
  files: string[];
}

/** Everything a reach opens read only. */
export const readsOf = (reach: Reach | undefined): string[] => (reach ? [...reach.folders, ...reach.files] : []);

/** How many links in the named folders are followed, at most. */
export const MAX_LINKED = 500;

/**
 * The reach of a workspace with `named` opened beside it, read only, or why not. Each named path must be inside the
 * folder that holds the workspace (a video's job folder around its `work/`), and that folder must itself be one a
 * workspace could be (`judgeWorkspace`, with the same `roots`), so nothing outside the caller's own folders is named.
 * A named path that does not exist is left out (`missing`). A link among them, or in a named folder at any depth,
 * opens the one file it leads to when that is a file and not in a place programs keep their settings or keys
 * (`linkable`); a link to a folder opens nothing.
 */
export function reachOf(workspace: string, named: readonly unknown[], home: string = homedir(), temp: string = tmpdir(), roots: readonly string[] = []): { reach: Reach; missing: string[] } | { problem: string } {
  const work = realPath(workspace);
  const around = dirname(work);
  const realHome = realPath(home);
  const judged = judgeWorkspace(around, realHome, [realPath(temp), "/private/tmp"], roots.map(realPath));
  if ("problem" in judged || around === work) return { problem: "workspace.read can only name what is in the folder that holds the workspace, and that folder must be one of the caller's own." };
  const reach: Reach = { write: [work], folders: [], files: [] };
  const missing: string[] = [];
  const linked = new Set<string>();
  const follow = (link: string) => {
    const target = linkTarget(link);
    if (target && !within(target, around) && linked.size < MAX_LINKED && linkable(target, realHome)) linked.add(target);
  };
  for (const entry of named) {
    if (typeof entry !== "string" || !isAbsolute(entry)) return { problem: "workspace.read must be a list of absolute paths." };
    // The folders on the way by their real paths; the last part as it is, so a link there is seen as a link.
    const path = join(realPath(dirname(entry)), basename(entry));
    if (!within(path, around) || path === around) return { problem: "workspace.read can only name what is in the folder that holds the workspace." };
    if (within(path, work)) continue;
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      missing.push(entry);
      continue;
    }
    if (stat.isSymbolicLink()) follow(path);
    else if (stat.isDirectory()) {
      reach.folders.push(path);
      for (const link of linksIn(path)) follow(link);
    } else if (stat.isFile()) reach.files.push(path);
  }
  reach.files.push(...linked);
  reach.folders = dropNested([...new Set(reach.folders)]);
  reach.files = [...new Set(reach.files)].filter((f) => !reach.folders.some((d) => within(f, d)));
  return { reach, missing };
}

/** Where a link leads, by its real path, when that is a file; undefined for a link to a folder or to nothing. */
function linkTarget(link: string): string | undefined {
  try {
    const target = realpathSync(link);
    return statSync(target).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

/** The links in `dir` at any depth (at most `max` entries looked at), not followed into. */
export function linksIn(dir: string, max = 20_000): string[] {
  const found: string[] = [];
  const queue = [dir];
  let seen = 0;
  while (queue.length && seen < max) {
    const here = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(here);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++seen > max) break;
      const path = join(here, name);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) found.push(path);
        else if (stat.isDirectory()) queue.push(path);
      } catch {
        // gone meanwhile
      }
    }
  }
  return found;
}

/**
 * Whether a file a link leads to may be opened read only: not the home folder's keychains, not in a dot folder at the
 * top of the home folder (where tools keep settings and logins), and not in any agent's, tool's or login's own folder
 * at any depth (`SETTINGS`).
 */
export function linkable(target: string, home: string): boolean {
  if (SETTINGS.test(target)) return false;
  if (!within(target, home)) return true;
  const first = relative(home, target).split(sep)[0]!;
  return !first.startsWith(".") && !within(target, join(home, "Library", "Keychains"));
}

/**
 * The box with a reach's read-only paths opened in it for every agent alike, whatever else its adapter opens: the one
 * place they are added, so each adapter's own box rules stay as they are.
 */
export function withReach(box: Box, reach: Reach | undefined): Box {
  const extra = readsOf(reach);
  if (!extra.length) return box;
  return { kind: box.kind, wrap: (bin, args, spec) => box.wrap(bin, args, { ...spec, read: [...spec.read, ...extra] }) };
}
