/**
 * A project linked to a folder on this computer (#71): the folder's files are the project's sources, read where they
 * are and never copied into the store.
 *
 * A check looks at the folder again: a file new to it becomes a source; a file whose size or change time differs is
 * read again when what it holds changed, and the source points at the new reading from then on (what was read before
 * stays, so a cite made from it still opens, and says its passage has changed); a file no longer there is marked
 * missing, never deleted. A file the person removed from the project stays removed. Nothing in the folder is ever
 * written, moved or deleted. The web app checks when the project is opened and when the person asks.
 */
import { sha256Hex } from "../net";
import { MAX_UPLOAD_BYTES, folderContentType } from "../uploads";
import { baseName, joinPath, type LocalFiles } from "../local-files";
import type { StudioRepositories } from "../studio/repositories";
import type { Project } from "../studio/repositories/projects";
import type { Source } from "../studio/repositories/sources";
import type { StructuredProvider } from "../types/provider";
import { ExtractionBusyError, fileKind, type SourceService } from "./service";

/** What one check of a linked folder found, by each file's path from the folder. */
export interface FolderCheck {
  folder: string;
  added: string[];
  /** Read again: what the file holds changed. */
  changed: string[];
  /** Not in the folder any more; their sources stay, marked missing. */
  missing: string[];
  /** Files that were already read and have not changed. */
  unchanged: number;
  /** Files that could not be read, and why. Their sources say so too. */
  failed: Array<{ path: string; message: string }>;
  /** Files of kinds a project does not take, or too large. */
  skipped: number;
  /** The folder held more files than one check looks at. */
  more: boolean;
}

export interface FolderDeps {
  repos: StudioRepositories;
  sources: SourceService;
  files: LocalFiles;
  provider?: StructuredProvider;
}

/** One check at a time per project: a second one asked for while one runs gets the same answer. */
const running = new Map<string, Promise<FolderCheck>>();

export function checkFolder(deps: FolderDeps, project: Project & { folder: string }): Promise<FolderCheck> {
  const now = running.get(project.id);
  if (now) return now;
  const check = look(deps, project).finally(() => running.delete(project.id));
  running.set(project.id, check);
  return check;
}

async function look(deps: FolderDeps, project: Project & { folder: string }): Promise<FolderCheck> {
  const { repos, files } = deps;
  const listing = await files.list(project.folder);
  const known = await repos.sources.listFiles(project.id);
  const byPath = new Map(known.map((source) => [source.filePath!, source]));
  const found: FolderCheck = { folder: listing.folder, added: [], changed: [], missing: [], unchanged: 0, failed: [], skipped: 0, more: listing.more };
  const seen = new Set<string>();

  for (const file of listing.files) {
    const contentType = folderContentType(file.path);
    if (!contentType || file.size > MAX_UPLOAD_BYTES || file.size === 0) {
      found.skipped += 1;
      continue;
    }
    const path = joinPath(listing.folder, file.path);
    seen.add(path);
    const source = byPath.get(path) ?? byPath.get(joinPath(project.folder, file.path));
    if (source?.filePath) seen.add(source.filePath);
    if (source?.removedAt) continue;
    if (source && source.fileSize === file.size && source.fileModifiedMs === file.modifiedMs && !source.missingAt) {
      found.unchanged += 1;
      continue;
    }
    try {
      const bytes = await files.read(listing.folder, file.path);
      const contentHash = `upload:${await sha256Hex(bytes)}`;
      const name = baseName(file.path);
      const kind = fileKind(contentType, name);
      let current: Source;
      if (source && source.contentHash === contentHash) {
        // Touched, or back where it was, but holding the same: nothing to read again.
        await repos.sources.updateFile(source.id, { fileSize: file.size, fileModifiedMs: file.modifiedMs });
        found.unchanged += 1;
        continue;
      }
      await repos.sources.ensureExtraction(contentHash, kind);
      if (source) {
        current = (await repos.sources.updateFile(source.id, { contentHash, fileSize: file.size, fileModifiedMs: file.modifiedMs, changed: true }))!;
        found.changed.push(file.path);
      } else {
        current = await repos.sources.create({
          ownerId: project.ownerId,
          projectId: project.id,
          contentHash,
          kind,
          fileName: name,
          origin: "folder",
          filePath: path,
          fileSize: file.size,
          fileModifiedMs: file.modifiedMs,
        });
        found.added.push(file.path);
      }
      try {
        await deps.sources.ensureExtracted(current, { ...(deps.provider ? { provider: deps.provider } : {}), file: { bytes, contentType, filename: name } });
      } catch (error) {
        // The source is there either way; its reading says what happened.
        if (!(error instanceof ExtractionBusyError)) found.failed.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
      }
    } catch (error) {
      found.failed.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // With more files than one check looks at, a file not listed may still be there: none is called missing.
  if (!listing.more) {
    for (const source of known) {
      if (seen.has(source.filePath!) || source.missingAt || source.removedAt) continue;
      await repos.sources.markMissing(source.id);
      found.missing.push(relativeTo(project.folder, listing.folder, source.filePath!));
    }
  }
  await repos.projects.folderChecked(project.id);
  return found;
}

/** A source's path from the folder, when it is inside it; else its whole path. */
function relativeTo(folder: string, real: string, path: string): string {
  for (const top of [real, folder]) {
    const base = top.replace(/[\\/]+$/, "");
    if (path.startsWith(base) && /[\\/]/.test(path.charAt(base.length))) return path.slice(base.length + 1).replace(/\\/g, "/");
  }
  return path;
}
