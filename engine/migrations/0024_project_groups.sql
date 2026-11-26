-- Folders on Home (#66): a person's own grouping of projects. In code a
-- group, so it is never mistaken for the folder on disk a project may be
-- linked to (projects.folder_path). A project is in one group or none (Home).
-- Deleting a group puts its projects back on Home; it never deletes one.
-- Additive only.
CREATE TABLE project_groups (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX project_groups_owner ON project_groups (owner_id, title);

ALTER TABLE projects ADD COLUMN group_id TEXT REFERENCES project_groups (id) ON DELETE SET NULL;
CREATE INDEX projects_group ON projects (group_id);
