/**
 * What the engine may ask of this computer's own files: where the library is, and the files of a folder a project is
 * linked to. The engine runs in the local Workers runtime, which cannot read the disk, so the launcher answers for it
 * on 127.0.0.1, only with the engine's own FILES_TOKEN (programs.ts gives it to the engine and nothing else).
 *
 *   GET  /library                  { folder, chosen }: the library folder, and whether the person picked it
 *   PUT  /library                  { folder: string | null } picks it (null goes back to the usual one)
 *   POST /folder/list              { folder } -> { folder, files: [{ path, size, modifiedMs }], more }
 *   POST /folder/read              { folder, path } -> the file's bytes
 *
 * The library is the person's own folder: finished videos are copied into it, and nothing here moves, renames or
 * deletes anything in it or in a linked folder. Only reads. A folder is listed a few levels deep, its hidden files
 * and folders left out, and a file is read only when it is inside the folder it was listed from, however a link in
 * it points. The usual library is `Documents/Open Sourcebook` in the home folder; the choice is kept in the state
 * folder's `library.json`.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writePrivate } from "./secrets.ts";

export const LIBRARY_FILE = "library.json";
/** The same bound as a file added to a project (engine/src/uploads.ts). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** How deep a linked folder is looked into, and how many files at most. */
export const MAX_DEPTH = 6;
export const MAX_FILES = 1000;
/** Folders no person keeps their own files in, left out wherever they are. */
const SKIPPED = new Set(["node_modules", "__pycache__", "$RECYCLE.BIN", "System Volume Information"]);

/** The usual library: `Documents/Open Sourcebook` in the home folder. */
export function defaultLibrary(home: string = homedir()): string {
  return join(home, "Documents", "Open Sourcebook");
}

/** The library folder, and whether the person picked it (else the usual one). */
export function libraryOf(state: string, home: string = homedir()): { folder: string; chosen: boolean } {
  const file = join(state, LIBRARY_FILE);
  if (existsSync(file)) {
    try {
      const folder = (JSON.parse(readFileSync(file, "utf8")) as { folder?: unknown }).folder;
      if (typeof folder === "string" && isAbsolute(folder)) return { folder, chosen: true };
    } catch {
      // A damaged file is the usual library; picking again writes it anew.
    }
  }
  return { folder: defaultLibrary(home), chosen: false };
}

/** Why a folder cannot be the library or be linked, in plain words; undefined when it can. */
export function refusedFolder(folder: string, home: string = homedir()): string | undefined {
  if (!isAbsolute(folder)) return "Give the folder's whole path, from the top of the disk.";
  const plain = resolve(folder);
  if (plain === resolve("/") || /^[A-Za-z]:\\?$/.test(plain)) return "Pick a folder, not the whole disk.";
  if (plain.split(sep).some((part) => part.startsWith("."))) return "A hidden folder can't be used; pick one of your own folders.";
  if (process.platform === "darwin" && (plain === join(home, "Library") || plain.startsWith(join(home, "Library") + sep))) return "The system's Library folder can't be used; pick one of your own folders.";
  return undefined;
}

export interface ListedFile {
  /** From the folder, with `/` between parts. */
  path: string;
  size: number;
  modifiedMs: number;
}

/** A folder's files, hidden ones left out, a few levels deep; `more` when there were more than MAX_FILES. */
export async function listFolder(folder: string): Promise<{ folder: string; files: ListedFile[]; more: boolean }> {
  const top = await realpath(folder);
  if (!(await stat(top)).isDirectory()) throw new FilesError(404, "not_a_folder", "That is a file, not a folder.");
  const files: ListedFile[] = [];
  let more = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
    } catch {
      return; // A folder it may not read is left out.
    }
    for (const name of names) {
      if (name.startsWith(".") || SKIPPED.has(name)) continue;
      if (files.length >= MAX_FILES) {
        more = true;
        return;
      }
      const full = join(dir, name);
      let info = await lstat(full).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        // A linked file inside the folder is read; a linked folder is not walked, so a link can never loop, and a
        // link out of the folder is left out (it would not be read).
        const target = await realpath(full).catch(() => undefined);
        if (!target || !target.startsWith(top + sep)) continue;
        info = await stat(full).catch(() => undefined);
        if (info?.isDirectory()) continue;
      }
      if (!info) continue;
      if (info.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (info.isFile()) {
        files.push({ path: relative(top, full).split(sep).join("/"), size: info.size, modifiedMs: Math.round(info.mtimeMs) });
      }
    }
  };
  await walk(top, 1);
  return { folder: top, files, more };
}

/** A file's bytes, when it is inside the folder (however links point), not hidden and not too large. */
export async function readInFolder(folder: string, path: string): Promise<Buffer> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part.startsWith("."))) {
    throw new FilesError(403, "outside_folder", "Only a file inside the folder is read.");
  }
  const top = await realpath(folder);
  const real = await realpath(join(top, path)).catch(() => undefined);
  if (!real) throw new FilesError(404, "not_found", "That file is not there any more.");
  if (real !== top && !real.startsWith(top + sep)) throw new FilesError(403, "outside_folder", "Only a file inside the folder is read.");
  const info = await stat(real);
  if (!info.isFile()) throw new FilesError(404, "not_found", "That is not a file.");
  if (info.size > MAX_FILE_BYTES) throw new FilesError(413, "too_large", `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const handle = await open(real, "r");
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export class FilesError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface LocalFilesOptions {
  /** The state folder, where `library.json` is kept. */
  state: string;
  /** The port on 127.0.0.1 (0 picks one, for tests). */
  port: number;
  token: string;
  /** For tests: the home folder the usual library is in. */
  home?: string;
}

export class LocalFiles {
  private server: Server | undefined;
  private readonly o: LocalFilesOptions;
  port = 0;

  constructor(options: LocalFilesOptions) {
    this.o = options;
  }

  start(): Promise<void> {
    const server = createServer((req, res) => void this.answer(req, res));
    return new Promise((done, fail) => {
      server.once("error", fail);
      server.listen({ host: "127.0.0.1", port: this.o.port }, () => {
        const a = server.address();
        if (a && typeof a === "object") this.port = a.port;
        this.server = server;
        done();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    return new Promise((done) => (server ? server.close(() => done()) : done()));
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reply(421, { error: "wrong_host", message: "This address is not this computer." });
    if (!sameToken(req.headers["x-files-token"], this.o.token)) return reply(401, { error: "unauthorized", message: "The files token is missing or wrong." });
    const path = (req.url ?? "/").split("?")[0]!;
    try {
      if (req.method === "GET" && path === "/library") return reply(200, libraryOf(this.o.state, this.o.home));
      const body = req.method === "GET" ? {} : await readJson(req);
      if (req.method === "PUT" && path === "/library") {
        const folder = body.folder;
        if (folder === null) {
          writePrivate(join(this.o.state, LIBRARY_FILE), `${JSON.stringify({}, null, 2)}\n`);
          return reply(200, libraryOf(this.o.state, this.o.home));
        }
        if (typeof folder !== "string" || !folder.trim()) return reply(400, { error: "bad_request", message: "Send { folder }: the folder's whole path, or null for the usual one." });
        const refused = refusedFolder(folder.trim(), this.o.home);
        if (refused) return reply(400, { error: "refused_folder", message: refused });
        writePrivate(join(this.o.state, LIBRARY_FILE), `${JSON.stringify({ folder: resolve(folder.trim()) }, null, 2)}\n`);
        return reply(200, libraryOf(this.o.state, this.o.home));
      }
      const folder = typeof body.folder === "string" ? body.folder.trim() : "";
      if (req.method === "POST" && (path === "/folder/list" || path === "/folder/read")) {
        const refused = refusedFolder(folder, this.o.home);
        if (refused) return reply(400, { error: "refused_folder", message: refused });
        if (!existsSync(folder)) return reply(404, { error: "no_folder", message: "That folder is not on this computer, or its disk is not connected." });
        if (path === "/folder/list") return reply(200, await listFolder(folder));
        const bytes = await readInFolder(folder, typeof body.path === "string" ? body.path : "");
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": bytes.byteLength });
        res.end(bytes);
        return;
      }
      return reply(404, { error: "not_found", message: "No such route." });
    } catch (error) {
      if (error instanceof FilesError) return reply(error.status, { error: error.code, message: error.message });
      return reply(500, { error: "files_failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await new Promise<string>((done, fail) => {
    let t = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      t += chunk;
      if (t.length > 16_384) {
        fail(new FilesError(413, "too_large", "The request is too large."));
        req.destroy();
      }
    });
    req.on("end", () => done(t));
    req.on("error", fail);
  });
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Answered below.
  }
  throw new FilesError(400, "bad_request", "Send a JSON object.");
}

function sameToken(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
