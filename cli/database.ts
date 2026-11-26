/**
 * The engine's local database: its migrations (engine/migrations) applied with wrangler, on this computer only, on
 * the first start and again whenever a migration file appears that the last run did not apply. Never `--remote`.
 *
 * Local D1 keeps each database in a file named after its database id, so the record of what was applied is kept per
 * id: when the id changes (the settings file's placeholder, a `wrangler.local.toml` added or taken away) the
 * migrations run on the database now in use, and a database whose file is not there is never taken as set up. Old
 * database files are never moved or deleted.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { appDataOf, engineState } from "./app-data.ts";

/** The migration files, in the order wrangler applies them. */
export function migrationFiles(engineDir: string): string[] {
  const dir = join(engineDir, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

/**
 * The engine's settings file: `wrangler.local.toml` when there is one (git-ignored, for a person who deploys the
 * engine under their own Cloudflare names and ids), else the committed `wrangler.toml`. The local database is kept by
 * the database id the file names, so a copy that has one keeps using it.
 */
export function engineConfig(engineDir: string): string {
  return existsSync(join(engineDir, "wrangler.local.toml")) ? "wrangler.local.toml" : "wrangler.toml";
}

/** The database name the engine's settings file binds (its `database_name`). */
export function databaseName(engineDir: string): string {
  const toml = readFileSync(join(engineDir, engineConfig(engineDir)), "utf8");
  const match = /^\s*database_name\s*=\s*"([^"]+)"/m.exec(toml);
  if (!match) throw new Error(`engine/${engineConfig(engineDir)} names no D1 database_name.`);
  return match[1]!;
}

/** The database id the engine's settings file gives its D1 database: `preview_database_id` (what local D1 uses) or `database_id`. */
export function databaseIdIn(toml: string): string | undefined {
  const block = toml.split(/^\s*\[\[d1_databases\]\]\s*$/m)[1]?.split(/^\s*\[/m)[0] ?? "";
  return /^\s*preview_database_id\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? /^\s*database_id\s*=\s*"([^"]+)"/m.exec(block)?.[1];
}

export function databaseId(engineDir: string): string {
  const id = databaseIdIn(readFileSync(join(engineDir, engineConfig(engineDir)), "utf8"));
  if (!id) throw new Error(`engine/${engineConfig(engineDir)} names no D1 database_id.`);
  return id;
}

/** Where wrangler keeps the local database: its default beside the engine, or the app data folder's `data/` (app-data.ts). */
export const localStateDir = (engineDir: string) => join(engineState(engineDir), "v3", "d1");

/** The folder of local D1's database files. */
export const databaseFiles = (engineDir: string) => join(localStateDir(engineDir), "miniflare-D1DatabaseObject");

/**
 * The file local D1 keeps a database id in. Each database is a storage object of the local Workers runtime, named
 * from the id the way the runtime names any object from a name: an HMAC-SHA256 of the name under the SHA-256 of its
 * class's key, the first 16 bytes, then an HMAC of those, the first 16 bytes. The file name is the data a person has,
 * so the runtime keeps it the same from version to version.
 */
export function databaseFile(engineDir: string, id: string): string {
  const key = createHash("sha256").update("miniflare-D1DatabaseObject").digest();
  const first = createHmac("sha256", key).update(id).digest().subarray(0, 16);
  const second = createHmac("sha256", key).update(first).digest().subarray(0, 16);
  return join(databaseFiles(engineDir), `${Buffer.concat([first, second]).toString("hex")}.sqlite`);
}

/** What `.opensourcebook/state.json` keeps about the database: the migrations applied, per database id. */
export type Applied = Record<string, string[]>;

/**
 * True when the database now in use needs its migrations: its file is not there (a new id, or never set up), or a
 * migration file is not in the list applied to that id.
 */
export function needsMigrations(engineDir: string, applied: Applied): boolean {
  const id = databaseId(engineDir);
  if (!existsSync(databaseFile(engineDir, id))) return true;
  return migrationFiles(engineDir).some((f) => !(applied[id] ?? []).includes(f));
}

/** How many projects each database file holds (0 when it has no projects table), read without changing anything. */
export function projectCounts(files: string[]): Record<string, number> {
  if (!files.length) return {};
  // In a child with warnings off: Node's SQLite says it is experimental on stderr, which is not for the person.
  const script = `const { DatabaseSync } = require("node:sqlite"); const out = {};
for (const f of JSON.parse(process.argv[1])) { try { const d = new DatabaseSync(f, { readOnly: true });
  const has = d.prepare("select 1 from sqlite_master where type = 'table' and name = 'projects'").get();
  out[f] = has ? Number(d.prepare("select count(*) as n from projects").get().n) : 0; d.close(); } catch { out[f] = 0; } }
process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--no-warnings", "-e", script, JSON.stringify(files)], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  try {
    return JSON.parse(r.stdout) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The database ids this copy's engine settings file has had in its history, newest first (from git, when there is one). */
export function pastDatabaseIds(root: string): string[] {
  const r = spawnSync("git", ["-C", root, "log", "--format=", "-p", "--", "engine/wrangler.toml"], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const ids = [...(r.stdout ?? "").matchAll(/^[-+]\s*(?:preview_)?database_id\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!);
  return [...new Set(ids)];
}

/** Another local database that holds projects, beside the empty one in use, and its id when it can be told. */
export interface Earlier {
  file: string;
  id?: string;
  projects: number;
}

/**
 * The local databases other than the one in use that hold projects, when the one in use holds none: what a person
 * whose database id changed is missing. `ids` are the ids that file names are checked against.
 */
export function earlierDatabases(engineDir: string, ids: string[], counts: (files: string[]) => Record<string, number> = projectCounts): Earlier[] {
  const dir = databaseFiles(engineDir);
  if (!existsSync(dir)) return [];
  const current = databaseFile(engineDir, databaseId(engineDir));
  // The one used most recently first: the database a person was using before the id changed.
  const used = (f: string) => Math.max(...[f, `${f}-wal`].map((x) => (existsSync(x) ? statSync(x).mtimeMs : 0)));
  const others = readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite").map((f) => join(dir, f)).filter((f) => f !== current).sort((a, b) => used(b) - used(a));
  if (!others.length) return [];
  const n = counts([current, ...others]);
  if ((n[current] ?? 0) > 0) return [];
  const byFile = new Map(ids.map((id) => [databaseFile(engineDir, id), id]));
  return others.filter((f) => (n[f] ?? 0) > 0).map((file) => ({ file, projects: n[file]!, ...(byFile.has(file) ? { id: byFile.get(file)! } : {}) }));
}

/** The one plain line a person gets when Open Sourcebook starts on a new, empty database while their earlier projects are in another. */
export function earlierLine(engineDir: string, root: string, earlier: Earlier[]): string | undefined {
  const first = earlier[0];
  if (!first) return undefined;
  const config = engineConfig(engineDir);
  const one = first.projects === 1;
  const where = first.id ? `the database with id ${first.id}` : `another database file (${relative(root, first.file)})`;
  const back = first.id
    ? `to go back to ${one ? "it" : "them"}, put database_id = "${first.id}" in engine/wrangler.local.toml (a copy of engine/wrangler.toml) and start Open Sourcebook again`
    : `to go back to ${one ? "it" : "them"}, put the database_id you used before in engine/wrangler.local.toml (a copy of engine/wrangler.toml) and start Open Sourcebook again`;
  return `  Open Sourcebook is using a new, empty database (the database_id in engine/${config}). Your earlier ${one ? "project is" : "projects are"} kept as ${one ? "it was" : "they were"} in ${where}; ${back}.`;
}

/** The arguments for wrangler: apply every migration to the local database. Never remote. */
export function migrateArgs(engineDir: string): string[] {
  return [join("node_modules", "wrangler", "bin", "wrangler.js"), "d1", "migrations", "apply", databaseName(engineDir), "--local", "--config", engineConfig(engineDir), ...(appDataOf(process.env) ? ["--persist-to", engineState(engineDir)] : [])];
}

/** Applies the migrations. Resolves with whether it worked; wrangler's output goes to the log. */
export function migrate(engineDir: string, log: string): Promise<boolean> {
  const out = createWriteStream(log, { flags: "w" });
  return new Promise((resolve) => {
    // CI=1: wrangler applies without asking "Ok to proceed?".
    const child = spawn(process.execPath, migrateArgs(engineDir), {
      cwd: engineDir,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => {
      out.end();
      resolve(code === 0);
    });
  });
}
