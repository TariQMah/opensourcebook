/**
 * A project's rows exactly as they are stored, every table that holds part of it, for a backup of every project
 * (backup/backup.ts), and written back in an order the foreign keys take. Rows are plain column → value records, so a
 * backup made by an older engine restores into a newer one: a column the database no longer has is left out, one it
 * gained takes its default.
 */
import type { D1PreparedStatementLike } from "../../types/bindings";
import { all, first, runAll, type RepositoryContext } from "./shared";

export type Row = Record<string, string | number | null>;

const SESSIONS = "SELECT id FROM sessions WHERE project_id = ?1";
const PLANS = "SELECT id FROM plans WHERE project_id = ?1";
const NODES = `SELECT id FROM plan_nodes WHERE plan_id IN (${PLANS})`;
const HASHES = "SELECT content_hash FROM sources WHERE project_id = ?1";

/**
 * Every table that holds part of a project, in the order rows are written back, and which of its rows are the
 * project's. Usage, jobs and making times stay out: they are the record of what was spent here, not the project.
 */
export const PROJECT_TABLES: ReadonlyArray<{ table: string; where: string; order: string }> = [
  { table: "projects", where: "id = ?1", order: "id" },
  { table: "source_extractions", where: `content_hash IN (${HASHES})`, order: "content_hash" },
  { table: "source_chunks", where: `content_hash IN (${HASHES})`, order: "content_hash, ord" },
  { table: "sources", where: "project_id = ?1", order: "created_at, id" },
  { table: "sessions", where: "project_id = ?1", order: "created_at, id" },
  { table: "messages", where: `session_id IN (${SESSIONS})`, order: "session_id, seq" },
  { table: "agent_turns", where: `session_id IN (${SESSIONS})`, order: "started_at, id" },
  { table: "agent_steps", where: `turn_id IN (SELECT id FROM agent_turns WHERE session_id IN (${SESSIONS}))`, order: "turn_id, seq" },
  { table: "plans", where: "project_id = ?1", order: "created_at, id" },
  { table: "plan_nodes", where: `plan_id IN (${PLANS})`, order: "plan_id, level, ord, id" },
  { table: "plan_node_sources", where: `node_id IN (${NODES}) AND source_id IN (SELECT id FROM sources WHERE project_id = ?1)`, order: "node_id, source_id" },
  { table: "plan_edges", where: `from_node IN (${NODES}) AND to_node IN (${NODES})`, order: "from_node, to_node, kind" },
  { table: "plan_stages", where: `plan_id IN (${PLANS})`, order: "plan_id, level" },
  { table: "plan_stage_dates", where: `plan_id IN (${PLANS})`, order: "plan_id, level" },
  { table: "outputs", where: "project_id = ?1", order: "created_at, id" },
  { table: "item_results", where: `node_id IN (${NODES})`, order: "node_id" },
];

/** The tables whose `id` is the project's own and is made new when a copy is kept beside the one there. */
export const OWN_ID_TABLES = ["projects", "sources", "sessions", "messages", "agent_turns", "agent_steps", "plans", "plan_nodes", "outputs"] as const;

/** Rows that may be shared with other projects: written only when not there already. */
const SHARED = new Set(["source_extractions", "source_chunks", "assets"]);

/** D1 binds at most 100 values a statement. */
const IDS_PER_QUERY = 90;

export class ProjectRowsRepository {
  private readonly columns = new Map<string, Set<string>>();

  constructor(private readonly ctx: RepositoryContext) {}

  /** The ids of every project the owner has, archived ones too, oldest first. */
  async projectIds(ownerId: string): Promise<string[]> {
    return (await all<{ id: string }>(this.ctx.db, "SELECT id FROM projects WHERE owner_id = ? ORDER BY created_at, id", ownerId)).map((row) => row.id);
  }

  /** Every row of the project, by table. */
  async rowsOf(projectId: string): Promise<Record<string, Row[]>> {
    const out: Record<string, Row[]> = {};
    for (const spec of PROJECT_TABLES) out[spec.table] = await all<Row>(this.ctx.db, `SELECT * FROM ${spec.table} WHERE ${spec.where} ORDER BY ${spec.order}`, projectId);
    return out;
  }

  /** The `assets` rows of these kept files, the ones there are. */
  async assetRows(ids: string[]): Promise<Row[]> {
    const rows: Row[] = [];
    for (let at = 0; at < ids.length; at += IDS_PER_QUERY) {
      const part = ids.slice(at, at + IDS_PER_QUERY);
      rows.push(...(await all<Row>(this.ctx.db, `SELECT * FROM assets WHERE id IN (${part.map(() => "?").join(", ")}) ORDER BY id`, ...part)));
    }
    return rows;
  }

  /** Which of these ids a table already has. */
  async existing(table: (typeof OWN_ID_TABLES)[number], ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let at = 0; at < ids.length; at += IDS_PER_QUERY) {
      const part = ids.slice(at, at + IDS_PER_QUERY);
      for (const row of await all<{ id: string }>(this.ctx.db, `SELECT id FROM ${table} WHERE id IN (${part.map(() => "?").join(", ")})`, ...part)) found.add(row.id);
    }
    return found;
  }

  /** The project's owner, when a project has this id. */
  async projectOwner(id: string): Promise<{ ownerId: string; title: string } | undefined> {
    const row = await first<{ owner_id: string; title: string }>(this.ctx.db, "SELECT owner_id, title FROM projects WHERE id = ?", id);
    return row ? { ownerId: row.owner_id, title: row.title } : undefined;
  }

  /** The passages already kept for a content hash, by their place, when its reading is kept here. */
  async keptChunks(contentHash: string): Promise<Map<number, string> | undefined> {
    const kept = await first<{ content_hash: string }>(this.ctx.db, "SELECT content_hash FROM source_extractions WHERE content_hash = ?", contentHash);
    if (!kept) return undefined;
    const chunks = await all<{ id: string; ord: number }>(this.ctx.db, "SELECT id, ord FROM source_chunks WHERE content_hash = ?", contentHash);
    return new Map(chunks.map((chunk) => [Number(chunk.ord), chunk.id]));
  }

  /** Writes rows, table by table in the order given, as one transaction. */
  async insert(tables: Array<{ table: string; rows: Row[] }>): Promise<void> {
    const statements: D1PreparedStatementLike[] = [];
    for (const { table, rows } of tables) {
      const known = await this.columnsOf(table);
      for (const row of rows) {
        const columns = Object.keys(row).filter((column) => known.has(column));
        if (!columns.length) continue;
        statements.push(
          this.ctx.db
            .prepare(`INSERT${SHARED.has(table) ? " OR IGNORE" : ""} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
            .bind(...columns.map((column) => row[column] ?? null)),
        );
      }
    }
    await runAll(this.ctx.db, statements);
  }

  private async columnsOf(table: string): Promise<Set<string>> {
    let known = this.columns.get(table);
    if (!known) {
      known = new Set((await all<{ name: string }>(this.ctx.db, `PRAGMA table_info(${table})`)).map((row) => row.name));
      this.columns.set(table, known);
    }
    return known;
  }
}
