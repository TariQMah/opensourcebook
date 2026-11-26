-- A project linked to a folder on the person's own computer (#71): its files
-- are sources read where they are, never copied. folder_path is the folder,
-- folder_checked_at when it was last looked at. library_name is the name of
-- the project's folder in the library, kept from the first video copied
-- there, so renaming the project never renames that folder. NULL for a
-- project with none. Additive only.
ALTER TABLE projects ADD COLUMN folder_path TEXT;
ALTER TABLE projects ADD COLUMN folder_checked_at TEXT;
ALTER TABLE projects ADD COLUMN library_name TEXT;

-- A source that is a file in a linked folder: its whole path, and the size
-- and change time it had when it was last read, so a check reads again only
-- what changed. missing_at: the file was not there at the last check (the
-- source stays, with what was read from it). changed_at: when it was last
-- read again because the file changed. NULL for every other source.
ALTER TABLE sources ADD COLUMN file_path TEXT;
ALTER TABLE sources ADD COLUMN file_size INTEGER;
ALTER TABLE sources ADD COLUMN file_modified_ms INTEGER;
ALTER TABLE sources ADD COLUMN missing_at TEXT;
ALTER TABLE sources ADD COLUMN changed_at TEXT;
CREATE INDEX sources_project_file ON sources (project_id, file_path);
