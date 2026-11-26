/**
 * This computer's own files, as the launcher reads them for the engine (cli/local-files.ts): the library folder
 * finished videos are copied into, and the files of a folder a project is linked to (#71). The local runtime the
 * engine runs in cannot read the disk; the launcher answers on 127.0.0.1 with the engine's own token. Only reads:
 * nothing here moves, renames or deletes a file.
 */
import { isLoopback } from "./chat/agent/connector";
import type { FetchLike } from "./types";

/** A file of a linked folder: its path from the folder, with `/` between parts. */
export interface FolderFile {
  path: string;
  size: number;
  modifiedMs: number;
}

export interface FolderListing {
  /** The folder as the computer names it (links followed). */
  folder: string;
  files: FolderFile[];
  /** More files were there than are listed. */
  more: boolean;
}

export interface Library {
  folder: string;
  /** The person picked it; otherwise it is the usual one. */
  chosen: boolean;
}

/** A folder or file this computer could not give, with its reason in plain words. */
export class LocalFilesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalFilesError";
  }
}

/** What the engine needs of this computer's files; a fake stands in for it in tests. */
export interface LocalFiles {
  library(): Promise<Library>;
  setLibrary(folder: string | null): Promise<Library>;
  list(folder: string): Promise<FolderListing>;
  read(folder: string, path: string): Promise<ArrayBuffer>;
}

const TIMEOUT_MS = 30_000;

export class LocalFilesClient implements LocalFiles {
  constructor(
    private readonly config: { url: string; token: string },
    private readonly fetchImpl: FetchLike,
  ) {}

  async library(): Promise<Library> {
    return (await this.call("GET", "/library")).json();
  }

  async setLibrary(folder: string | null): Promise<Library> {
    return (await this.call("PUT", "/library", { folder })).json();
  }

  async list(folder: string): Promise<FolderListing> {
    return (await this.call("POST", "/folder/list", { folder })).json();
  }

  async read(folder: string, path: string): Promise<ArrayBuffer> {
    return (await this.call("POST", "/folder/read", { folder, path })).arrayBuffer();
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "x-files-token": this.config.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new LocalFilesError("files_unreachable", "Open Sourcebook's launcher on this computer did not answer; start Open Sourcebook again, then try again.", 503);
    }
    if (response.ok) return response;
    let said: { error?: string; message?: string } = {};
    try {
      said = (await response.json()) as typeof said;
    } catch {
      // Said below in general words.
    }
    throw new LocalFilesError(said.error ?? "files_failed", said.message ?? `This computer's files could not be read (${response.status}).`, response.status >= 500 ? 502 : response.status);
  }
}

/** The launcher's answers about this computer's files, when the engine runs on this computer with it. */
export function localFilesFromEnv(env: { LOCAL_FILES_URL?: string; LOCAL_FILES_TOKEN?: string }, fetchImpl: FetchLike): LocalFiles | undefined {
  const url = env.LOCAL_FILES_URL?.trim();
  const token = env.LOCAL_FILES_TOKEN?.trim();
  if (!url || !token || !isLoopback(url)) return undefined;
  return new LocalFilesClient({ url, token }, fetchImpl);
}

/** A file name's last part, from a path with `/` or `\` between parts. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A path inside a folder, with the folder's own separator. */
export function joinPath(folder: string, path: string): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return [folder.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** The folder a file is in, and its name: what the launcher reads a file by. */
export function splitPath(path: string): { folder: string; name: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { folder: at <= 0 ? path.slice(0, at + 1) || "/" : path.slice(0, at), name: path.slice(at + 1) };
}

/**
 * A project's title as a folder name: the characters no system takes in a name turned into spaces, no dot first, a
 * hundred characters at most; "Project" when nothing is left.
 */
export function folderName(title: string): string {
  const plain = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim()
    .replace(/[. ]+$/, "");
  return plain || "Project";
}
