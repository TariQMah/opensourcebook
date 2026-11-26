/**
 * A backup every week, kept in the library. The engine makes a backup of every project as one zip (GET /v1/backup,
 * the same file Settings › Backups downloads) but runs in the local Workers runtime, which cannot write to the disk,
 * so saving one on a timer is the launcher's: it asks the engine with the client token and saves the file as
 * `<library>/Backups/Open Sourcebook backup <YYYY-MM-DD>.zip`, written beside it under a hidden name first and given
 * its own name only once whole, so a half-written backup never looks like one. It keeps the newest few and deletes
 * the older ones, only files with exactly that name in that folder; nothing else in the library is touched.
 *
 * Off until the person turns it on (Settings › Backups, or `opensourcebook backup` for one now): a backup holds every
 * video made, so each can be large, and the library is the person's own folder, so what is written there every week
 * is theirs to choose. The choice, how many to keep and the last one are kept in the state folder's `backups.json`.
 * While it is on, the launcher looks every hour and backs up when the last one is a week old or there is none, so a
 * computer that was off or asleep catches up at its next start.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { lstat, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { libraryOf } from "./local-files.ts";
import { writePrivate } from "./secrets.ts";

export const BACKUPS_FILE = "backups.json";
export const BACKUPS_FOLDER = "Backups";
export const DEFAULT_KEEP = 4;
export const MAX_KEEP = 52;
export const WEEK_MS = 7 * 24 * 60 * 60_000;
/** How often the launcher looks whether a backup is due. */
const LOOK_EVERY_MS = 60 * 60_000;
/** The first look, a little after the start, so a catch-up does not slow the programs coming up. */
const FIRST_LOOK_MS = 2 * 60_000;
/** After a backup that failed, the next try waits this long, not an hour. */
const AFTER_FAILURE_MS = 6 * 60 * 60_000;

/** A backup's file name, and the only names ever deleted from the Backups folder. */
export const BACKUP_NAME = /^Open Sourcebook backup \d{4}-\d{2}-\d{2}\.zip$/;

/** `Open Sourcebook backup <YYYY-MM-DD>.zip`, on this computer's calendar. */
export function backupName(day: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `Open Sourcebook backup ${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}.zip`;
}

export interface BackupSettings {
  on: boolean;
  keep: number;
  /** When the last backup was saved, and where. */
  last?: string;
  file?: string;
  /** The last try, when it failed after the last saved one. */
  failed?: { at: string; message: string };
}

export function readBackupSettings(state: string): BackupSettings {
  const file = join(state, BACKUPS_FILE);
  let kept: Partial<BackupSettings> = {};
  if (existsSync(file)) {
    try {
      kept = JSON.parse(readFileSync(file, "utf8")) as Partial<BackupSettings>;
    } catch {
      // A damaged file is the usual settings; the next change writes it anew.
    }
  }
  const keep = typeof kept.keep === "number" && Number.isInteger(kept.keep) && kept.keep >= 1 && kept.keep <= MAX_KEEP ? kept.keep : DEFAULT_KEEP;
  const failed = kept.failed && typeof kept.failed.at === "string" && typeof kept.failed.message === "string" ? kept.failed : undefined;
  return {
    on: kept.on === true,
    keep,
    ...(typeof kept.last === "string" ? { last: kept.last } : {}),
    ...(typeof kept.file === "string" ? { file: kept.file } : {}),
    ...(failed ? { failed } : {}),
  };
}

export function writeBackupSettings(state: string, settings: BackupSettings): void {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writePrivate(join(state, BACKUPS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
}

/** How many to keep, as a person may give it; undefined when it is not a whole number from 1 to MAX_KEEP. */
export function keepOf(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_KEEP ? n : undefined;
}

export interface SaveOptions {
  /** The engine's address, e.g. http://127.0.0.1:8787, and its client token. */
  engine: string;
  token: string;
  /** The library folder. */
  library: string;
  keep: number;
  now?: Date;
  fetchImpl?: typeof fetch;
}

/** Saves one backup in `<library>/Backups` and deletes the backups past the newest `keep`. Throws, in plain words, when it could not. */
export async function saveBackup(o: SaveOptions): Promise<{ file: string; removed: string[] }> {
  const folder = join(o.library, BACKUPS_FOLDER);
  const name = backupName(o.now ?? new Date());
  const file = join(folder, name);
  let response: Response;
  try {
    response = await (o.fetchImpl ?? fetch)(new URL("/v1/backup", o.engine), { headers: { "x-client-token": o.token } });
  } catch {
    throw new Error("The engine did not answer.");
  }
  if (!response.ok || !response.body) {
    const said = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
    throw new Error(typeof said?.message === "string" && said.message ? said.message : `The engine answered ${response.status}.`);
  }
  mkdirSync(folder, { recursive: true });
  // Hidden, and this process's own, until it is whole.
  const part = join(folder, `.${name}.${process.pid}.part`);
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), createWriteStream(part, { mode: 0o600 }));
    await rename(part, file);
  } catch (error) {
    await unlink(part).catch(() => undefined);
    throw new Error(`The backup was not saved whole (${error instanceof Error ? error.message : String(error)}).`);
  }
  return { file, removed: await prune(folder, o.keep) };
}

/** Deletes the backups past the newest `keep` (by the day in their names): files with a backup's exact name only. */
export async function prune(folder: string, keep: number): Promise<string[]> {
  const names = (await readdir(folder).catch(() => [] as string[])).filter((n) => BACKUP_NAME.test(n)).sort().reverse();
  const removed: string[] = [];
  for (const name of names.slice(Math.max(1, keep))) {
    const path = join(folder, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    await unlink(path).then(
      () => removed.push(path),
      () => undefined,
    );
  }
  return removed;
}

/** Whether a backup is due now: on, and none saved this past week (a failed try waits a few hours before the next). */
export function isDue(settings: BackupSettings, now: number): boolean {
  if (!settings.on) return false;
  if (settings.failed && now - Date.parse(settings.failed.at) < AFTER_FAILURE_MS) return false;
  return !settings.last || !(now - Date.parse(settings.last) < WEEK_MS);
}

/** What Settings › Backups shows of the weekly backup. */
export interface BackupView extends BackupSettings {
  /** Where they are saved. */
  folder: string;
  /** A backup is being saved now. */
  saving: boolean;
}

export interface ScheduleOptions {
  /** The state folder. */
  state: string;
  /** The engine's address and token. */
  engine: string;
  token: string;
  say?: (line: string) => void;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** For tests: the home folder the usual library is in. */
  home?: string;
}

/** The weekly backup while Open Sourcebook runs: a look every hour, the setting, and one backup now. */
export class BackupSchedule {
  private timers: NodeJS.Timeout[] = [];
  private saving: Promise<void> | undefined;
  private readonly o: ScheduleOptions;

  constructor(options: ScheduleOptions) {
    this.o = options;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private library(): string {
    return libraryOf(this.o.state, this.o.home).folder;
  }

  view(): BackupView {
    return { ...readBackupSettings(this.o.state), folder: join(this.library(), BACKUPS_FOLDER), saving: this.saving !== undefined };
  }

  start(firstLookMs = FIRST_LOOK_MS, lookEveryMs = LOOK_EVERY_MS): void {
    const first = setTimeout(() => void this.look(), firstLookMs);
    const every = setInterval(() => void this.look(), lookEveryMs);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Backs up when one is due; resolves once that is done. */
  async look(): Promise<void> {
    if (this.saving) return this.saving;
    if (!isDue(readBackupSettings(this.o.state), this.now())) return;
    return this.backUp();
  }

  /** Turns the weekly backup on or off, and sets how many are kept; turning it on backs up now when one is due. */
  set(change: { on?: boolean; keep?: number }): BackupView {
    const settings = readBackupSettings(this.o.state);
    const next: BackupSettings = { ...settings, ...(change.on !== undefined ? { on: change.on } : {}), ...(change.keep !== undefined ? { keep: change.keep } : {}) };
    if (change.on === true && !settings.on) delete next.failed;
    writeBackupSettings(this.o.state, next);
    if (change.on === true) void this.look();
    return this.view();
  }

  /** One backup now, whatever the setting; resolves when it is saved or has failed (said in backups.json). */
  backUp(): Promise<void> {
    if (this.saving) return this.saving;
    this.saving = (async () => {
      const at = new Date(this.now());
      try {
        const saved = await saveBackup({ engine: this.o.engine, token: this.o.token, library: this.library(), keep: readBackupSettings(this.o.state).keep, now: at, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) });
        recordSaved(this.o.state, saved.file, at);
        this.o.say?.(`  Backed up every project to ${saved.file}${saved.removed.length ? ` (${saved.removed.length} older backup${saved.removed.length === 1 ? "" : "s"} deleted)` : ""}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const settings = readBackupSettings(this.o.state);
        writeBackupSettings(this.o.state, { ...settings, failed: { at: at.toISOString(), message } });
        this.o.say?.(`  The weekly backup did not work: ${message} It is tried again in a few hours.`);
      } finally {
        this.saving = undefined;
      }
    })();
    return this.saving;
  }
}

/** Keeps when and where the last backup was saved, so the weekly one counts from it. */
export function recordSaved(state: string, file: string, at: Date): void {
  const settings = readBackupSettings(state);
  delete settings.failed;
  writeBackupSettings(state, { ...settings, last: at.toISOString(), file });
}
