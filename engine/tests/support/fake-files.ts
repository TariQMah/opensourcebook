/** This computer's files as the launcher gives them (cli/local-files.ts), held in memory: a folder is a map of files. */
import { LocalFilesError, type FolderListing, type Library, type LocalFiles } from "../../src/local-files";

export class FakeFiles implements LocalFiles {
  /** Folder → path from it → the file's text and change time. */
  readonly folders = new Map<string, Map<string, { text: string; modifiedMs: number }>>();
  chosen?: string;
  reads: string[] = [];
  private clock = 1_000;

  put(folder: string, path: string, text: string): void {
    if (!this.folders.has(folder)) this.folders.set(folder, new Map());
    this.folders.get(folder)!.set(path, { text, modifiedMs: (this.clock += 1000) });
  }

  remove(folder: string, path: string): void {
    this.folders.get(folder)?.delete(path);
  }

  async library(): Promise<Library> {
    return this.chosen ? { folder: this.chosen, chosen: true } : { folder: "/Users/me/Documents/Open Sourcebook", chosen: false };
  }

  async setLibrary(folder: string | null): Promise<Library> {
    if (folder !== null && !folder.startsWith("/")) throw new LocalFilesError("refused_folder", "Give the folder's whole path, from the top of the disk.", 400);
    this.chosen = folder ?? undefined;
    return this.library();
  }

  async list(folder: string): Promise<FolderListing> {
    const files = this.folders.get(folder);
    if (!files) throw new LocalFilesError("no_folder", "That folder is not on this computer, or its disk is not connected.", 404);
    return {
      folder,
      files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, size: new TextEncoder().encode(file.text).byteLength, modifiedMs: file.modifiedMs })),
      more: false,
    };
  }

  async read(folder: string, path: string): Promise<ArrayBuffer> {
    const file = this.folders.get(folder)?.get(path);
    if (!file) throw new LocalFilesError("not_found", "That file is not there any more.", 404);
    this.reads.push(`${folder}/${path}`);
    return new TextEncoder().encode(file.text).buffer as ArrayBuffer;
  }
}
