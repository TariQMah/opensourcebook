/**
 * A backup of every project, in one zip file, and back (#66; engine/docs/api.md, "Backing up every project"). It holds everything a project needs to
 * open as it was: the project, its sources (the files kept for them; a file of a linked folder is read where it is,
 * so only its path is kept), what was read from them, its chats, its plans and everything made, with the files they
 * kept (a video's, an audio's, pictures). `manifest.json` says what is in it and which version of the file it is.
 *
 *   manifest.json                     { opensourcebook: "backup", version, madeAt, projects, groups, files }
 *   projects/<project id>.json        { id, tables: { <table>: rows } }   every row as stored (project-rows.ts)
 *   files/assets/<id>, files/uploads/<id>   the kept files, byte for byte
 *
 * Restoring adds every project the engine does not have. A project it has already is restored only as the person
 * chooses: kept beside the one there (a copy with new ids), or put in its place. Nothing else is ever deleted.
 */
import { assetIdsIn } from "../assets";
import type { R2BucketLike } from "../types";
import type { StudioRepositories } from "../studio/repositories";
import { OWN_ID_TABLES, PROJECT_TABLES, type Row } from "../studio/repositories/project-rows";
import { entryStart, readEntry, readZipDirectory, ZipError, ZipWriter, type ReadAt, type ZipEntry } from "./zip";

export const BACKUP_VERSION = 1;
const MARK = "opensourcebook";

export interface BackupFile {
  /** Where the file is in the zip. */
  path: string;
  size: number;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

export interface BackupProject {
  id: string;
  title: string;
  archived: boolean;
  /** The folder on Home it was kept in, by the group's id in `groups`. */
  group?: string;
  sources: number;
  outputs: number;
  chats: number;
  /** The folder on the computer it was linked to; its files were not copied, only their paths. */
  linkedFolder?: string;
  /** Sources that are files of the linked folder, kept by their path only. */
  linkedFiles: number;
  /** The kept files (bucket keys) its rows point at. */
  files: string[];
}

export interface BackupManifest {
  opensourcebook: "backup";
  version: number;
  madeAt: string;
  projects: BackupProject[];
  groups: Array<{ id: string; title: string }>;
  /** Every kept file in the zip, by its key in the bucket. */
  files: Record<string, BackupFile>;
}

export class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface BackupDeps {
  repos: StudioRepositories;
  bucket?: R2BucketLike;
}

/** The file name a backup made on this day is offered under. */
export function backupFileName(day: Date): string {
  return `Open Sourcebook backup ${day.toISOString().slice(0, 10)}.zip`;
}

// ---------------------------------------------------------------- making one

/** Writes a backup of every project the owner has into `out`, then closes it. */
export async function writeBackup(deps: BackupDeps, ownerId: string, out: WritableStreamDefaultWriter<Uint8Array>, now = new Date()): Promise<BackupManifest> {
  const zip = new ZipWriter(out);
  const manifest: BackupManifest = { [MARK]: "backup", version: BACKUP_VERSION, madeAt: now.toISOString(), projects: [], groups: [], files: {} };
  const groups = await deps.repos.groups.listByOwner(ownerId);
  manifest.groups = groups.map((g) => ({ id: g.id, title: g.title }));
  const wanted = new Set<string>();
  for (const id of await deps.repos.projectRows.projectIds(ownerId)) {
    const tables = await deps.repos.projectRows.rowsOf(id);
    const assets = assetIdsIn(JSON.stringify(tables));
    tables.assets = await deps.repos.projectRows.assetRows(assets);
    const uploads = [...new Set((tables.sources ?? []).flatMap((s) => (typeof s.upload_id === "string" && s.upload_id ? [s.upload_id] : [])))];
    const files = [...assets.map((a) => `assets/${a}`), ...uploads.map((u) => `uploads/${u}`)];
    for (const key of files) wanted.add(key);
    const project = tables.projects![0]!;
    const sources = tables.sources ?? [];
    manifest.projects.push({
      id,
      title: String(project.title),
      archived: project.archived_at !== null && project.archived_at !== undefined,
      ...(typeof project.group_id === "string" ? { group: project.group_id } : {}),
      sources: sources.filter((s) => !s.removed_at).length,
      outputs: (tables.outputs ?? []).length,
      chats: (tables.sessions ?? []).length,
      ...(typeof project.folder_path === "string" ? { linkedFolder: project.folder_path } : {}),
      linkedFiles: sources.filter((s) => typeof s.file_path === "string").length,
      files,
    });
    await zip.add(`projects/${id}.json`, JSON.stringify({ id, tables }));
  }
  for (const key of wanted) {
    const object = await deps.bucket?.get(key);
    // A file no longer kept is left out; what points at it says so as it does here.
    if (!object?.body) continue;
    const path = `files/${key}`;
    await zip.add(path, object.body);
    manifest.files[key] = {
      path,
      size: object.size ?? 0,
      ...(object.httpMetadata?.contentType ? { contentType: object.httpMetadata.contentType } : {}),
      ...(object.customMetadata && Object.keys(object.customMetadata).length ? { customMetadata: object.customMetadata } : {}),
    };
  }
  for (const project of manifest.projects) project.files = project.files.filter((key) => manifest.files[key]);
  await zip.add("manifest.json", JSON.stringify(manifest, null, 2));
  await zip.finish();
  return manifest;
}

// ---------------------------------------------------------------- reading one

export interface OpenedBackup {
  manifest: BackupManifest;
  entries: Map<string, ZipEntry>;
  readAt: ReadAt;
  /** `length` bytes at `offset`, as a stream read from the bucket. */
  stream(offset: number, length: number): Promise<ReadableStream<Uint8Array>>;
}

/** A backup kept in the bucket under `key`, its manifest read and checked; the rest is read as it is needed. */
export async function openBackup(bucket: R2BucketLike, key: string): Promise<OpenedBackup> {
  const head = await bucket.head(key);
  if (!head) throw new BackupError("restore_not_found", "That backup is no longer here; choose the file again.", 404);
  const readAt: ReadAt = async (offset, length) => {
    if (length === 0) return new Uint8Array(0);
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) throw new BackupError("restore_not_found", "That backup is no longer here; choose the file again.", 404);
    return new Uint8Array(await object.arrayBuffer());
  };
  const stream = async (offset: number, length: number) => {
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object?.body) throw new BackupError("restore_not_found", "That backup is no longer here; choose the file again.", 404);
    return object.body;
  };
  try {
    const entries = await readZipDirectory(head.size ?? 0, readAt);
    const entry = entries.get("manifest.json");
    if (!entry) throw new BackupError("invalid_backup", "This zip is not an Open Sourcebook backup (it has no manifest.json).");
    const manifest = readManifest(JSON.parse(new TextDecoder().decode(await readEntry(entry, readAt))));
    return { manifest, entries, readAt, stream };
  } catch (error) {
    if (error instanceof ZipError) throw new BackupError("invalid_backup", error.message);
    if (error instanceof SyntaxError) throw new BackupError("invalid_backup", "The backup's manifest could not be read.");
    throw error;
  }
}

function readManifest(value: unknown): BackupManifest {
  if (!isRecord(value) || value[MARK] !== "backup") throw new BackupError("invalid_backup", "This zip is not an Open Sourcebook backup.");
  if (typeof value.version !== "number" || value.version > BACKUP_VERSION) {
    throw new BackupError("backup_too_new", `This backup was made by a newer Open Sourcebook (version ${String(value.version)}); update, then restore it.`);
  }
  if (!Array.isArray(value.projects) || !value.projects.every((p) => isRecord(p) && typeof p.id === "string" && typeof p.title === "string")) {
    throw new BackupError("invalid_backup", "The backup's list of projects could not be read.");
  }
  return {
    ...(value as unknown as BackupManifest),
    groups: Array.isArray(value.groups) ? (value.groups as BackupManifest["groups"]) : [],
    files: isRecord(value.files) ? (value.files as unknown as BackupManifest["files"]) : {},
  };
}

/** One project of a backup as the person sees it before restoring: whether a project with its id is here already. */
export interface RestoreProject {
  id: string;
  title: string;
  archived: boolean;
  sources: number;
  outputs: number;
  chats: number;
  linkedFolder?: string;
  linkedFiles: number;
  /** A project with this id is here: restoring it needs the person's choice. */
  here?: { title: string };
}

export async function restoreProjects(deps: BackupDeps, ownerId: string, manifest: BackupManifest): Promise<RestoreProject[]> {
  const out: RestoreProject[] = [];
  for (const p of manifest.projects) {
    const here = await deps.repos.projectRows.projectOwner(p.id);
    out.push({
      id: p.id,
      title: p.title,
      archived: Boolean(p.archived),
      sources: p.sources ?? 0,
      outputs: p.outputs ?? 0,
      chats: p.chats ?? 0,
      ...(p.linkedFolder ? { linkedFolder: p.linkedFolder } : {}),
      linkedFiles: p.linkedFiles ?? 0,
      ...(here && here.ownerId === ownerId ? { here: { title: here.title } } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- restoring one

/** What to do with a project of the backup: add it (one not here), keep it beside the one here, put it in its place, or leave it. */
export type RestoreChoice = "add" | "keep-both" | "replace" | "skip";

export interface RestoredProject {
  /** The project's id in the backup. */
  from: string;
  /** Its id here. */
  projectId: string;
  title: string;
  as: "added" | "copy" | "replaced";
}

export interface RestoreDeps extends BackupDeps {
  /** Deletes the project here that a restored one replaces (studio/removal.ts), after the person chose it. */
  replace(projectId: string): Promise<void>;
  newId?: () => string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Restores one project of an opened backup. `choice` was checked by the caller: `replace` and `keep-both` only for one here. */
export async function restoreProject(deps: RestoreDeps, ownerId: string, backup: OpenedBackup, from: string, choice: Exclude<RestoreChoice, "skip">): Promise<RestoredProject> {
  const summary = backup.manifest.projects.find((p) => p.id === from);
  const entry = backup.entries.get(`projects/${from}.json`);
  if (!summary || !entry) throw new BackupError("invalid_backup", `The backup has no project ${from}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readEntry(entry, backup.readAt)));
  } catch (error) {
    if (error instanceof ZipError || error instanceof SyntaxError) throw new BackupError("invalid_backup", `The backup's project "${summary.title}" could not be read.`);
    throw error;
  }
  const tables = isRecord(parsed) && isRecord(parsed.tables) ? (parsed.tables as unknown as Record<string, Row[]>) : undefined;
  const projectRow = tables?.projects?.[0];
  if (!tables || !projectRow || projectRow.id !== from) throw new BackupError("invalid_backup", `The backup's project "${summary.title}" could not be read.`);

  if (choice === "replace") await deps.replace(from);

  // Ids the copy takes: all new when it is kept beside the one here, or when any of them is taken here already
  // (a source kept hidden after its project was deleted, say). Passages already read here are used as they are.
  const map = new Map<string, string>();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let fresh = choice === "keep-both";
  if (!fresh) {
    for (const table of OWN_ID_TABLES) {
      const ids = (tables[table] ?? []).map((row) => String(row.id));
      if (ids.length && (await deps.repos.projectRows.existing(table, ids)).size) {
        fresh = true;
        break;
      }
    }
  }
  if (fresh) for (const table of OWN_ID_TABLES) for (const row of tables[table] ?? []) map.set(String(row.id), newId());
  const keptHashes = new Set<string>();
  for (const extraction of tables.source_extractions ?? []) {
    const hash = String(extraction.content_hash);
    const kept = await deps.repos.projectRows.keptChunks(hash);
    if (!kept) continue;
    keptHashes.add(hash);
    for (const chunk of tables.source_chunks ?? []) {
      const here = chunk.content_hash === hash ? kept.get(Number(chunk.ord)) : undefined;
      if (here) map.set(String(chunk.id), here);
    }
  }
  const remap = (value: string | number | null): string | number | null => (typeof value === "string" && map.size ? value.replace(UUID, (id) => map.get(id.toLowerCase()) ?? id) : value);

  // The folder on Home it was in: the one here of the same name, made when there is none.
  let groupId: string | null = null;
  const group = backup.manifest.groups.find((g) => g.id === summary.group);
  if (group) {
    const here = (await deps.repos.groups.listByOwner(ownerId)).find((g) => g.title.toLowerCase() === group.title.toLowerCase());
    groupId = here ? here.id : (await deps.repos.groups.create({ ownerId, title: group.title })).id;
  }

  const rows = (table: string): Row[] =>
    (tables[table] ?? []).map((row) => {
      const out: Row = {};
      for (const [column, value] of Object.entries(row)) out[column] = column === "owner_id" ? ownerId : remap(value);
      return out;
    });
  const ids = (list: Row[]) => new Set(list.map((row) => String(row.id)));

  const project = rows("projects").slice(0, 1);
  project[0]!.group_id = groupId;
  if (choice === "keep-both") project[0]!.title = `${String(project[0]!.title)} (from backup)`.slice(0, 200);
  const sessions = rows("sessions").map((row) => ({ ...row, busy_since: null }));
  const plans = rows("plans");
  const planIds = ids(plans);
  const sessionIds = ids(sessions);
  for (const plan of plans) {
    if (plan.session_id !== null && plan.session_id !== undefined && !sessionIds.has(String(plan.session_id))) plan.session_id = null;
    if (plan.supersedes_plan_id !== null && plan.supersedes_plan_id !== undefined && !planIds.has(String(plan.supersedes_plan_id))) plan.supersedes_plan_id = null;
    // Nothing is being made here: a plan running when it was backed up comes back stopped.
    if (plan.status === "running") plan.status = "cancelled";
  }
  const nodes = parentsFirst(rows("plan_nodes")).map((node) => (node.status === "running" || node.status === "queued" ? { ...node, status: "cancelled" } : node));
  const nodeIds = ids(nodes);
  const outputs = rows("outputs").map((row) => (row.node_id !== null && row.node_id !== undefined && !nodeIds.has(String(row.node_id)) ? { ...row, node_id: null } : row));
  const outputIds = ids(outputs);
  const results = rows("item_results").map((row) => (row.output_id !== null && row.output_id !== undefined && !outputIds.has(String(row.output_id)) ? { ...row, output_id: null } : row));
  const turns = rows("agent_turns").map((row) => (row.state === "running" ? { ...row, state: "stopped" } : row));

  // The kept files first, so nothing written points at a file that is not there yet. A file is kept by what it is
  // (or by its upload's id), so one here already is the same and is left as it is.
  for (const key of summary.files ?? []) await restoreFile(deps, backup, key);

  const byTable: Record<string, Row[]> = {
    projects: project,
    source_extractions: rows("source_extractions"),
    source_chunks: rows("source_chunks").filter((row) => !keptHashes.has(String(row.content_hash))),
    sources: rows("sources"),
    sessions,
    messages: rows("messages"),
    agent_turns: turns,
    agent_steps: rows("agent_steps"),
    plans,
    plan_nodes: nodes,
    outputs,
    item_results: results,
  };
  await deps.repos.projectRows.insert([
    { table: "assets", rows: rows("assets") },
    ...PROJECT_TABLES.map(({ table }) => ({ table, rows: byTable[table] ?? rows(table) })),
  ]);
  const projectId = String(project[0]!.id);
  return { from, projectId, title: String(project[0]!.title), as: choice === "keep-both" ? "copy" : choice === "replace" ? "replaced" : "added" };
}

async function restoreFile(deps: BackupDeps, backup: OpenedBackup, key: string): Promise<void> {
  const file = backup.manifest.files[key];
  if (!deps.bucket || !file || !/^(assets|uploads)\/[A-Za-z0-9._~-]+$/.test(key)) return;
  if (await deps.bucket.head(key)) return;
  const entry = backup.entries.get(file.path);
  if (!entry || entry.method !== 0) return;
  const start = await entryStart(entry, backup.readAt);
  const options = { ...(file.contentType ? { httpMetadata: { contentType: file.contentType } } : {}), ...(file.customMetadata ? { customMetadata: file.customMetadata } : {}) };
  // Read from the backup as it is written: a video is never held whole.
  await deps.bucket.put(key, entry.size ? await backup.stream(start, entry.size) : new Uint8Array(0), options);
}

/** Items in an order where each one's parent comes before it; a parent not in the project is let go. */
function parentsFirst(nodes: Row[]): Row[] {
  const known = new Set(nodes.map((node) => String(node.id)));
  for (const node of nodes) if (node.parent_id !== null && node.parent_id !== undefined && !known.has(String(node.parent_id))) node.parent_id = null;
  const placed = new Set<string>();
  const out: Row[] = [];
  let left = nodes;
  while (left.length) {
    const ready = left.filter((node) => node.parent_id === null || node.parent_id === undefined || placed.has(String(node.parent_id)));
    // Parents that point at each other, which the database never holds: written as they are.
    for (const node of ready.length ? ready : left) {
      placed.add(String(node.id));
      out.push(node);
    }
    left = left.filter((node) => !placed.has(String(node.id)));
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
