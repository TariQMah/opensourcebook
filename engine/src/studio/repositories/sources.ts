/**
 * `source_extractions`, `source_chunks` and `sources` (migrations/0004).
 * An extraction is shared by content hash; a source is one user's item
 * pointing at it, in a project or in the Inbox.
 */
import { withAccessExplained } from "../../extract/limits";
import { withPlainLimitations } from "../../extract/stored-limitations";
import type { AccessLevel, SourceEnvelope } from "../../types/source";
import { ACCESS_LEVELS } from "../../types/source";
import { sourceTitle } from "../../sources/title";
import { canReadAgain } from "../../sources/failure";
import { metadataFromJson, sourceDetail, type SourceDetail } from "../../sources/detail";
import type { SourceChunk, SourceLocator } from "../types";
import {
  afterKey,
  all,
  assignments,
  compact,
  first,
  fromJson,
  nullable,
  oneOf,
  opt,
  run,
  runAll,
  toJson,
  toPage,
  type Page,
  type PageQuery,
  type RepositoryContext,
} from "./shared";

/** Five values per chunk row; D1 allows 100 bound parameters per statement. */
const CHUNK_ROWS_PER_INSERT = 20;

export const EXTRACTION_STATUSES = ["pending", "extracting", "ready", "failed"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const SOURCE_ORIGINS = ["upload", "link", "paste", "share", "discover", "note", "folder"] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

export interface SourceExtraction {
  contentHash: string;
  kind: string;
  status: ExtractionStatus;
  accessLevel?: AccessLevel;
  envelope?: SourceEnvelope;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionPatch {
  status?: ExtractionStatus;
  accessLevel?: AccessLevel | null;
  envelope?: SourceEnvelope | null;
  errorMessage?: string | null;
}

export interface Source {
  id: string;
  ownerId: string;
  /** Absent while the source sits in the Inbox. */
  projectId?: string;
  contentHash: string;
  kind: string;
  /**
   * The name a person sees (sources/title.ts): their own name for it, else
   * the title read from it, else a plain fallback. Always set.
   */
  title: string;
  url?: string;
  uploadId?: string;
  origin?: SourceOrigin;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when the person removed it while something still points at it (a
   * plan item, something made from it, a cite in a chat reply). Lists,
   * chats and new plan items leave it out; what points at it keeps working.
   */
  removedAt?: string;
  /** A file in the project's linked folder, read where it is (#71): its whole path on this computer. */
  filePath?: string;
  /** The file's size and change time when it was last read; a check reads it again when either differs. */
  fileSize?: number;
  fileModifiedMs?: number;
  /** The file was not in the folder at the last check. The source stays, with what was read from it. */
  missingAt?: string;
  /** When it was last read again because the file changed. */
  changedAt?: string;
}

/** What a check of a linked folder found of one file (`updateFile`). */
export interface FilePatch {
  contentHash?: string;
  fileSize: number;
  fileModifiedMs: number;
  /** It was read again because it changed. */
  changed?: boolean;
}

/** A source with its extraction's status, as lists show it. */
export interface ListedSource extends Source {
  status: ExtractionStatus;
  /** How much of it could be read, once read: `metadata` means only a title and description. */
  accessLevel?: AccessLevel;
  /** Why it could not be read, in plain words; only while `status` is `failed`. */
  errorMessage?: string;
  /** Only while `status` is `failed`: whether reading it again could end differently. */
  retryable?: boolean;
  /** How long it is, from what reading it found (a PDF's pages, a deck's slides, a video's minutes); absent when unknown. */
  detail?: SourceDetail;
}

export interface NewSource {
  ownerId: string;
  projectId?: string;
  contentHash: string;
  kind: string;
  title?: string;
  url?: string;
  uploadId?: string;
  /** The name an uploaded file came with. */
  fileName?: string;
  origin?: SourceOrigin;
  /** A file in a linked folder: its whole path, size and change time. */
  filePath?: string;
  fileSize?: number;
  fileModifiedMs?: number;
}

export interface NewChunk {
  text: string;
  locator?: SourceLocator;
}

interface ExtractionRow {
  content_hash: string;
  kind: string;
  status: string;
  access_level: string | null;
  envelope_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  content_hash: string;
  ord: number;
  text: string;
  locator_json: string | null;
}

interface SourceRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  content_hash: string;
  kind: string;
  title: string | null;
  url: string | null;
  upload_id: string | null;
  file_name: string | null;
  origin: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  file_path: string | null;
  file_size: number | null;
  file_modified_ms: number | null;
  missing_at: string | null;
  changed_at: string | null;
  /** The extraction's read title (`SOURCE_SELECT`). */
  read_title: string | null;
}

/**
 * Every source read goes through this, so each one carries its extraction's
 * read title and is named the same way everywhere (`sourceTitle`).
 */
const SOURCE_SELECT =
  "SELECT s.*, json_extract(e.envelope_json, '$.title') AS read_title FROM sources s LEFT JOIN source_extractions e ON e.content_hash = s.content_hash";

/** What `purge` freed beyond the source row. */
export interface PurgedSource {
  /** The extraction and its chunks went too: no other source had the same content. */
  extractionDeleted: boolean;
}

export class SourceRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  /**
   * The extraction row for a hash, created as pending if new. `created` says
   * whether this caller should extract it; everyone else reuses the result.
   */
  async ensureExtraction(contentHash: string, kind: string): Promise<{ extraction: SourceExtraction; created: boolean }> {
    const now = this.ctx.now();
    const inserted = await this.ctx.db
      .prepare(
        "INSERT INTO source_extractions (content_hash, kind, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (content_hash) DO NOTHING RETURNING *",
      )
      .bind(contentHash, kind, now, now)
      .first<ExtractionRow>();
    if (inserted) return { extraction: extractionFromRow(inserted), created: true };
    return { extraction: (await this.getExtraction(contentHash))!, created: false };
  }

  /**
   * Takes the right to extract a hash: a pending or failed extraction, or one
   * stuck in `extracting` since before `staleBefore` (its extractor died),
   * moves to `extracting`. Exactly one caller wins; the rest get undefined
   * and reuse the result once it is ready.
   */
  async claimExtraction(contentHash: string, staleBefore: string): Promise<SourceExtraction | undefined> {
    const row = await this.ctx.db
      .prepare(
        "UPDATE source_extractions SET status = 'extracting', error_message = NULL, updated_at = ? " +
          "WHERE content_hash = ? AND (status IN ('pending', 'failed') OR (status = 'extracting' AND updated_at < ?)) RETURNING *",
      )
      .bind(this.ctx.now(), contentHash, staleBefore)
      .first<ExtractionRow>();
    return row ? extractionFromRow(row) : undefined;
  }

  async getExtraction(contentHash: string): Promise<SourceExtraction | undefined> {
    const row = await first<ExtractionRow>(this.ctx.db, "SELECT * FROM source_extractions WHERE content_hash = ?", contentHash);
    return row ? extractionFromRow(row) : undefined;
  }

  async updateExtraction(contentHash: string, patch: ExtractionPatch): Promise<SourceExtraction | undefined> {
    if (patch.status) oneOf(patch.status, EXTRACTION_STATUSES, "status");
    if (patch.accessLevel) oneOf(patch.accessLevel, ACCESS_LEVELS, "accessLevel");
    const set = assignments(patch, {
      status: ["status"],
      accessLevel: ["access_level"],
      envelope: ["envelope_json", (envelope: SourceEnvelope | null) => (envelope ? toJson(storedEnvelope(envelope)) : null)],
      errorMessage: ["error_message"],
    });
    await run(
      this.ctx.db,
      `UPDATE source_extractions SET ${[...set.sql, "updated_at = ?"].join(", ")} WHERE content_hash = ?`,
      ...set.values,
      this.ctx.now(),
      contentHash,
    );
    return this.getExtraction(contentHash);
  }

  /**
   * Replaces every chunk of an extraction, in one transaction where the
   * binding allows. Rows go in `CHUNK_ROWS_PER_INSERT` to a statement, so a
   * source at the size bound (about 350 chunks) is a few dozen statements,
   * well inside D1's per-statement parameter limit.
   */
  async replaceChunks(contentHash: string, chunks: NewChunk[]): Promise<SourceChunk[]> {
    const db = this.ctx.db;
    const inserts = [];
    for (let start = 0; start < chunks.length; start += CHUNK_ROWS_PER_INSERT) {
      const rows = chunks.slice(start, start + CHUNK_ROWS_PER_INSERT);
      const values = rows.flatMap((chunk, offset) => [this.ctx.newId(), contentHash, start + offset, chunk.text, chunk.locator ? toJson(chunk.locator) : null]);
      inserts.push(
        db
          .prepare(`INSERT INTO source_chunks (id, content_hash, ord, text, locator_json) VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`)
          .bind(...values),
      );
    }
    await runAll(db, [db.prepare("DELETE FROM source_chunks WHERE content_hash = ?").bind(contentHash), ...inserts]);
    return this.listChunks(contentHash);
  }

  async listChunks(contentHash: string): Promise<SourceChunk[]> {
    const rows = await all<ChunkRow>(this.ctx.db, "SELECT * FROM source_chunks WHERE content_hash = ? ORDER BY ord", contentHash);
    return rows.map((row) =>
      compact({ id: row.id, ord: row.ord, text: row.text, locator: row.locator_json ? fromJson<SourceLocator>(row.locator_json, {}) : undefined }),
    );
  }

  async create(input: NewSource): Promise<Source> {
    if (input.origin) oneOf(input.origin, SOURCE_ORIGINS, "origin");
    const id = this.ctx.newId();
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      "INSERT INTO sources (id, owner_id, project_id, content_hash, kind, title, url, upload_id, file_name, origin, file_path, file_size, file_modified_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.ownerId,
      nullable(input.projectId),
      input.contentHash,
      input.kind,
      nullable(input.title),
      nullable(input.url),
      nullable(input.uploadId),
      nullable(input.fileName),
      nullable(input.origin),
      nullable(input.filePath),
      nullable(input.fileSize),
      nullable(input.fileModifiedMs),
      now,
      now,
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Source | undefined> {
    const row = await first<SourceRow>(this.ctx.db, `${SOURCE_SELECT} WHERE s.id = ?`, id);
    return row ? sourceFromRow(row) : undefined;
  }

  /** The project's sources the person has not removed. */
  async listByProject(projectId: string): Promise<Source[]> {
    return (
      await all<SourceRow>(this.ctx.db, `${SOURCE_SELECT} WHERE s.project_id = ? AND s.removed_at IS NULL ORDER BY s.created_at, s.id`, projectId)
    ).map(sourceFromRow);
  }

  /** Every source row of the project, removed ones too (deleting the project). */
  async listAllByProject(projectId: string): Promise<Source[]> {
    return (await all<SourceRow>(this.ctx.db, `${SOURCE_SELECT} WHERE s.project_id = ? ORDER BY s.created_at, s.id`, projectId)).map(sourceFromRow);
  }

  /** Sources not in any project yet. */
  async listInbox(ownerId: string): Promise<Source[]> {
    return (
      await all<SourceRow>(
        this.ctx.db,
        `${SOURCE_SELECT} WHERE s.owner_id = ? AND s.project_id IS NULL AND s.removed_at IS NULL ORDER BY s.created_at DESC, s.id`,
        ownerId,
      )
    ).map(sourceFromRow);
  }

  /** The owner's removed sources still kept because something pointed at them. */
  async listRemoved(ownerId: string): Promise<Source[]> {
    return (
      await all<SourceRow>(this.ctx.db, `${SOURCE_SELECT} WHERE s.owner_id = ? AND s.removed_at IS NOT NULL ORDER BY s.removed_at, s.id`, ownerId)
    ).map(sourceFromRow);
  }

  /** One page of a project's sources, oldest first, with extraction status. */
  async pageByProject(projectId: string, query: PageQuery): Promise<Page<ListedSource>> {
    return this.pageWhere("s.project_id = ?", [projectId], "ASC", query);
  }

  /** One page of an owner's Inbox, newest first, with extraction status. */
  async pageInbox(ownerId: string, query: PageQuery): Promise<Page<ListedSource>> {
    return this.pageWhere("s.owner_id = ? AND s.project_id IS NULL", [ownerId], "DESC", query);
  }

  private async pageWhere(where: string, values: unknown[], direction: "ASC" | "DESC", query: PageQuery): Promise<Page<ListedSource>> {
    const after = afterKey("s.created_at", "s.id", direction, query.after);
    const rows = await all<SourceRow & { extraction_status: string; extraction_access: string | null; extraction_error: string | null; read_metadata: string | null }>(
      this.ctx.db,
      `SELECT s.*, json_extract(e.envelope_json, '$.title') AS read_title, json_extract(e.envelope_json, '$.metadata') AS read_metadata, ` +
        `e.status AS extraction_status, e.access_level AS extraction_access, e.error_message AS extraction_error ` +
        `FROM sources s JOIN source_extractions e ON e.content_hash = s.content_hash ` +
        `WHERE ${where} AND s.removed_at IS NULL${after.sql} ORDER BY s.created_at ${direction}, s.id ${direction} LIMIT ?`,
      ...values,
      ...after.values,
      query.limit + 1,
    );
    const listed = rows.map((row) =>
      compact({
        ...sourceFromRow(row),
        status: oneOf(row.extraction_status, EXTRACTION_STATUSES, "status"),
        accessLevel: row.extraction_access === null ? undefined : oneOf(row.extraction_access, ACCESS_LEVELS, "access_level"),
        errorMessage: row.extraction_status === "failed" ? opt(row.extraction_error) : undefined,
        retryable: row.extraction_status === "failed" ? canReadAgain({ url: row.url }, row.extraction_error) : undefined,
        detail: row.extraction_status === "ready" ? sourceDetail(metadataFromJson(row.read_metadata)) : undefined,
      }),
    );
    return toPage(listed, query.limit, (source) => [source.createdAt, source.id]);
  }

  /** This owner's existing sources for the same content, so a re-add can be spotted. */
  async findByHash(ownerId: string, contentHash: string): Promise<Source[]> {
    return (
      await all<SourceRow>(this.ctx.db, `${SOURCE_SELECT} WHERE s.owner_id = ? AND s.content_hash = ? ORDER BY s.created_at, s.id`, ownerId, contentHash)
    ).map(sourceFromRow);
  }

  /** `null` sends it back to the Inbox. */
  async moveToProject(id: string, projectId: string | null): Promise<Source | undefined> {
    await run(this.ctx.db, "UPDATE sources SET project_id = ?, updated_at = ? WHERE id = ?", projectId, this.ctx.now(), id);
    return this.get(id);
  }

  async rename(id: string, title: string | null): Promise<Source | undefined> {
    await run(this.ctx.db, "UPDATE sources SET title = ?, updated_at = ? WHERE id = ?", title, this.ctx.now(), id);
    return this.get(id);
  }

  /** Removes the user's item; the shared extraction stays for anyone else using it. */
  async delete(id: string): Promise<void> {
    await run(this.ctx.db, "DELETE FROM sources WHERE id = ?", id);
  }

  /** Every source of the project that is a file in a linked folder, removed ones too, so a check never adds one back. */
  async listFiles(projectId: string): Promise<Source[]> {
    return (await all<SourceRow>(this.ctx.db, `${SOURCE_SELECT} WHERE s.project_id = ? AND s.file_path IS NOT NULL ORDER BY s.created_at, s.id`, projectId)).map(sourceFromRow);
  }

  /**
   * What a check found of a file that is there: its size and change time, and when it changed, the hash of what it
   * holds now. The source points at the new content from here on; what was read before stays for the cites made
   * from it. A file that was missing is not any more.
   */
  async updateFile(id: string, patch: FilePatch): Promise<Source | undefined> {
    const now = this.ctx.now();
    await run(
      this.ctx.db,
      "UPDATE sources SET content_hash = COALESCE(?, content_hash), file_size = ?, file_modified_ms = ?, missing_at = NULL, " +
        "changed_at = CASE WHEN ? THEN ? ELSE changed_at END, updated_at = ? WHERE id = ?",
      nullable(patch.contentHash),
      patch.fileSize,
      patch.fileModifiedMs,
      patch.changed ? 1 : 0,
      now,
      now,
      id,
    );
    return this.get(id);
  }

  /** The file was not in the folder: the source stays, said to be missing. Keeps the first time. */
  async markMissing(id: string): Promise<Source | undefined> {
    const now = this.ctx.now();
    await run(this.ctx.db, "UPDATE sources SET missing_at = COALESCE(missing_at, ?), updated_at = ? WHERE id = ?", now, now, id);
    return this.get(id);
  }

  /**
   * Of these chunks, the ones no longer part of their source's text: the source now points at other content (its
   * file changed and was read again). A cite of one says its passage has changed. A chunk or source not found is
   * left out, never guessed.
   */
  async changedChunks(cites: Array<{ sourceId: string; chunkId: string }>): Promise<Set<string>> {
    const changed = new Set<string>();
    const chunkIds = [...new Set(cites.map((cite) => cite.chunkId))];
    const sourceIds = [...new Set(cites.map((cite) => cite.sourceId))];
    if (chunkIds.length === 0) return changed;
    const chunkHash = new Map<string, string>();
    const sourceHash = new Map<string, string>();
    for (let start = 0; start < chunkIds.length; start += 90) {
      const ids = chunkIds.slice(start, start + 90);
      for (const row of await all<{ id: string; content_hash: string }>(this.ctx.db, `SELECT id, content_hash FROM source_chunks WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids)) {
        chunkHash.set(row.id, row.content_hash);
      }
    }
    for (let start = 0; start < sourceIds.length; start += 90) {
      const ids = sourceIds.slice(start, start + 90);
      for (const row of await all<{ id: string; content_hash: string }>(this.ctx.db, `SELECT id, content_hash FROM sources WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids)) {
        sourceHash.set(row.id, row.content_hash);
      }
    }
    for (const cite of cites) {
      const was = chunkHash.get(cite.chunkId);
      const now = sourceHash.get(cite.sourceId);
      if (was && now && was !== now) changed.add(cite.chunkId);
    }
    return changed;
  }

  /** Hides a source the person removed but something still points at. Keeps the first time. */
  async markRemoved(id: string): Promise<Source | undefined> {
    const now = this.ctx.now();
    await run(this.ctx.db, "UPDATE sources SET removed_at = COALESCE(removed_at, ?), updated_at = ? WHERE id = ?", now, now, id);
    return this.get(id);
  }

  /** Brings a removed source back (the same content was added again in the same place). */
  async restore(id: string): Promise<Source | undefined> {
    await run(this.ctx.db, "UPDATE sources SET removed_at = NULL, updated_at = ? WHERE id = ? AND removed_at IS NOT NULL", this.ctx.now(), id);
    return this.get(id);
  }

  /**
   * Whether anything still points at the source: an item of a plan, an
   * output made from it or citing it, or a chat message that cites or
   * mentions it. A message that only had it ticked does not count. Ids are
   * matched as quoted JSON strings in the stored JSON.
   */
  async isReferenced(source: Pick<Source, "id" | "ownerId">): Promise<boolean> {
    const quoted = `%${likeEscape(JSON.stringify(source.id))}%`;
    const row = await first<{ used: number }>(
      this.ctx.db,
      "SELECT (EXISTS (SELECT 1 FROM plan_node_sources WHERE source_id = ?) " +
        "OR EXISTS (SELECT 1 FROM outputs WHERE owner_id = ? AND (sources_json LIKE ? ESCAPE '\\' OR citations_json LIKE ? ESCAPE '\\')) " +
        "OR EXISTS (SELECT 1 FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.owner_id = ? " +
        "AND ((m.role = 'assistant' AND m.content_json LIKE ? ESCAPE '\\') OR m.citations_json LIKE ? ESCAPE '\\' OR m.mentions_json LIKE ? ESCAPE '\\'))) AS used",
      source.id,
      source.ownerId,
      quoted,
      quoted,
      source.ownerId,
      quoted,
      quoted,
      quoted,
    );
    return row?.used === 1;
  }

  /**
   * Deletes the source row for good, and its extraction and chunks when no
   * other source (anyone's) has the same content. The caller checks
   * `isReferenced` first; a plan item that still listed it loses the link.
   */
  async purge(source: Pick<Source, "id" | "contentHash">): Promise<PurgedSource> {
    const db = this.ctx.db;
    const unused = "NOT EXISTS (SELECT 1 FROM sources WHERE content_hash = ?)";
    await runAll(db, [
      db.prepare("DELETE FROM sources WHERE id = ?").bind(source.id),
      db.prepare(`DELETE FROM source_chunks WHERE content_hash = ? AND ${unused}`).bind(source.contentHash, source.contentHash),
      db.prepare(`DELETE FROM source_extractions WHERE content_hash = ? AND ${unused}`).bind(source.contentHash, source.contentHash),
    ]);
    return { extractionDeleted: !(await this.getExtraction(source.contentHash)) };
  }

  /**
   * Whether an uploaded file is still needed: another source row was made
   * from it, or a job that has not finished was asked to read it.
   */
  async uploadInUse(uploadId: string): Promise<boolean> {
    const row = await first<{ used: number }>(
      this.ctx.db,
      "SELECT (EXISTS (SELECT 1 FROM sources WHERE upload_id = ?) " +
        "OR EXISTS (SELECT 1 FROM generation_jobs WHERE status IN ('queued', 'running', 'failed') AND input_json LIKE ? ESCAPE '\\')) AS used",
      uploadId,
      `%${likeEscape(JSON.stringify(uploadId))}%`,
    );
    return row?.used === 1;
  }
}

/** Escapes LIKE's wildcards (with `\` as the escape character). */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function extractionFromRow(row: ExtractionRow): SourceExtraction {
  return compact({
    contentHash: row.content_hash,
    kind: row.kind,
    status: oneOf(row.status, EXTRACTION_STATUSES, "status"),
    accessLevel: row.access_level === null ? undefined : oneOf(row.access_level, ACCESS_LEVELS, "access_level"),
    envelope: row.envelope_json === null ? undefined : readEnvelope(fromJson<StoredEnvelope>(row.envelope_json, {} as StoredEnvelope)),
    errorMessage: opt(row.error_message),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * An envelope as stored: when `originalText` is the text itself (pasted
 * text), it is left out and restored on read, so the row never holds the
 * same text twice (engine/docs/long-sources.md).
 */
type StoredEnvelope = Omit<SourceEnvelope, "originalText"> & { originalText?: string };

function storedEnvelope(envelope: SourceEnvelope): StoredEnvelope {
  if (envelope.originalText !== envelope.text) return envelope;
  const { originalText: _same, ...rest } = envelope;
  return rest;
}

/**
 * Limitations stored before they were plain words read back as plain words
 * (extract/stored-limitations.ts); a reading stored as partial or metadata
 * with no line saying why gets the plain one (extract/limits.ts).
 */
function readEnvelope(stored: StoredEnvelope): SourceEnvelope {
  return withAccessExplained(withPlainLimitations({ ...stored, originalText: stored.originalText ?? stored.text }));
}

function sourceFromRow(row: SourceRow): Source {
  return compact({
    id: row.id,
    ownerId: row.owner_id,
    projectId: opt(row.project_id),
    contentHash: row.content_hash,
    kind: row.kind,
    title: sourceTitle({ own: row.title, read: row.read_title, kind: row.kind, url: row.url, fileName: row.file_name, origin: row.origin }),
    url: opt(row.url),
    uploadId: opt(row.upload_id),
    origin: row.origin === null ? undefined : oneOf(row.origin, SOURCE_ORIGINS, "origin"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: opt(row.removed_at),
    filePath: opt(row.file_path),
    fileSize: opt(row.file_size),
    fileModifiedMs: opt(row.file_modified_ms),
    missingAt: opt(row.missing_at),
    changedAt: opt(row.changed_at),
  });
}
