/**
 * Everything before the programs start: the right version of them in `app/` (update.ts says which) and ffmpeg. The
 * files are put in place and ffmpeg is fetched by the one-line install's own library (install/package/lib), which the
 * app carries, so the app and the install keep one way of doing both.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Carried, Layout } from "./paths.ts";
import { compareVersions, dropPending, pendingUpdate, planStart, readJson, writeJson, type Installed, type Version } from "./update.ts";

interface InstallerLib {
  updateApp(options: { home: string; archive: string; run: unknown; fetchImpl?: unknown; say?: (line: string) => void; beforeChange?: () => Promise<void> }): Promise<{ files: number; removed: number }>;
  ensureTools(options: { home: string; run: unknown; env: NodeJS.ProcessEnv; execPath: string; say?: (line: string) => void }): Promise<{ fetched: string[]; warning?: string }>;
  runProcess: unknown;
}

async function loadInstaller(dir: string): Promise<InstallerLib> {
  const load = (file: string) => import(pathToFileURL(join(dir, file)).href);
  const [archive, tools, run] = await Promise.all([load("archive.mjs"), load("tools.mjs"), load("run.mjs")]);
  return { updateApp: archive.updateApp, ensureTools: tools.ensureTools, runProcess: run.runProcess };
}

export interface PrepareOptions {
  at: Layout;
  carried: Carried;
  env: NodeJS.ProcessEnv;
  say: (line: string) => void;
  /** Stops a copy of the programs that may still run from `app/` (one left by an app that did not quit cleanly). */
  stopRunning: () => Promise<void>;
}

/** Puts the right version in `app/` and makes sure ffmpeg is there. Resolves with what is in place and any warning. */
export async function prepare(options: PrepareOptions): Promise<{ installed: Installed; changed?: Version; warning?: string }> {
  const { at, carried } = options;
  mkdirSync(at.root, { recursive: true });
  const lib = await loadInstaller(carried.installer);
  const carriedVersion = readJson<Version>(carried.payloadInfo);
  if (!carriedVersion) throw new Error(`The app is missing its own copy of Open Sourcebook (${carried.payloadInfo}).`);
  let installed = readJson<Installed>(at.installed);
  // Files that are not whole (a start cut off midway, a file removed by hand) are put in place again.
  if (installed && !(readJson(join(at.app, "package.json")) && existsSync(join(at.app, "cli", "opensourcebook.mjs")))) installed = undefined;
  const pending = pendingUpdate(at.updates);
  const plan = planStart(installed, carriedVersion, pending);
  let changed: Version | undefined;
  if (plan.kind !== "keep") {
    const first = !installed;
    options.say(first ? "Putting Open Sourcebook in place (first start)" : `Updating Open Sourcebook to ${plan.version.version}`);
    const archive = plan.kind === "pending" ? pending!.archive : carried.payload;
    await lib.updateApp({ home: at.root, archive, run: lib.runProcess, beforeChange: options.stopRunning });
    const { archive: _archive, ...version } = plan.version as Version & { archive?: string };
    installed = { ...version, source: plan.kind === "pending" ? "release" : "carried" };
    writeJson(at.installed, installed);
    if (!first) changed = version;
  }
  if (pending && compareVersions(pending.version, installed!.version) <= 0) dropPending(at.updates);
  const tools = await lib.ensureTools({ home: at.root, run: lib.runProcess, env: options.env, execPath: carried.node, say: options.say });
  return { installed: installed!, ...(changed ? { changed } : {}), ...(tools.warning ? { warning: tools.warning } : {}) };
}
