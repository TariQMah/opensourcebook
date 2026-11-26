/** `project_groups` (migrations/0024): the folders a person keeps projects in on Home. */
import { all, first, run, type RepositoryContext } from "./shared";

export interface ProjectGroup {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow {
  id: string;
  owner_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export class ProjectGroupRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(input: { ownerId: string; title: string }): Promise<ProjectGroup> {
    const id = this.ctx.newId();
    const now = this.ctx.now();
    await run(this.ctx.db, "INSERT INTO project_groups (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, input.ownerId, input.title, now, now);
    return (await this.get(id))!;
  }

  async get(id: string): Promise<ProjectGroup | undefined> {
    const row = await first<GroupRow>(this.ctx.db, "SELECT * FROM project_groups WHERE id = ?", id);
    return row ? fromRow(row) : undefined;
  }

  /** An owner's groups by name, with how many projects (archived ones too) each holds. */
  async listByOwner(ownerId: string): Promise<Array<ProjectGroup & { projects: number }>> {
    const rows = await all<GroupRow & { projects: number }>(
      this.ctx.db,
      "SELECT g.*, (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id) AS projects FROM project_groups g WHERE g.owner_id = ? ORDER BY g.title COLLATE NOCASE, g.id",
      ownerId,
    );
    return rows.map((row) => ({ ...fromRow(row), projects: Number(row.projects) }));
  }

  async rename(id: string, title: string): Promise<ProjectGroup | undefined> {
    await run(this.ctx.db, "UPDATE project_groups SET title = ?, updated_at = ? WHERE id = ?", title, this.ctx.now(), id);
    return this.get(id);
  }

  /** Puts a project in a group, or back on Home (`null`). Not a change to the project, so its place in lists stays. */
  async place(projectId: string, groupId: string | null): Promise<void> {
    await run(this.ctx.db, "UPDATE projects SET group_id = ? WHERE id = ?", groupId, projectId);
  }

  /** Deletes the group; its projects go back on Home, every one kept. Answers how many moved. */
  async delete(id: string): Promise<number> {
    const moved = await first<{ n: number }>(this.ctx.db, "SELECT COUNT(*) AS n FROM projects WHERE group_id = ?", id);
    await run(this.ctx.db, "UPDATE projects SET group_id = NULL WHERE group_id = ?", id);
    await run(this.ctx.db, "DELETE FROM project_groups WHERE id = ?", id);
    return Number(moved?.n ?? 0);
  }
}

function fromRow(row: GroupRow): ProjectGroup {
  return { id: row.id, ownerId: row.owner_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}
