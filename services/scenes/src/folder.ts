/**
 * A video's job folder beyond the service's own files (docs/JOB-FOLDER.md): a note for the video agent (`README.md`),
 * the video's sources (`sources/`, a link to each that is a file on disk and `sources.json`), and what the engine already
 * read from them (`extracted/<source>/`: the text, and the pictures it kept). Nothing new is read from a source here.
 * Also what happens to a job folder once its video ends: copied out to the library when one is set, and cleaned up
 * once it is neither among the last jobs nor recent.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { JobSource, SourcePicture, VideoRequest } from "./request.ts";

/** How many pictures of one source are saved, and how big each may be. */
export const MAX_PICTURES = 60;
export const MAX_PICTURE_BYTES = 20_000_000;
const PICTURE_MS = 10_000;

/** A source's id as a folder name: anything but letters, digits, `-`, `_` and `.` turned into `_`. */
export function folderName(id: string): string {
  const name = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return name === "." || name === ".." || !name ? "_" : name;
}

/** The video's sources: the ones the engine sent, then any a passage names that it did not, from the passages alone. */
export function sourcesOf(request: VideoRequest): JobSource[] {
  const out: JobSource[] = [...(request.sources ?? [])];
  const known = new Set(out.map((s) => s.id));
  for (const passage of request.passages) {
    if (known.has(passage.sourceId)) continue;
    known.add(passage.sourceId);
    out.push({ id: passage.sourceId, title: passage.sourceTitle, kind: "source" });
  }
  return out;
}

/** One entry of `sources/sources.json`. */
export interface SourceEntry {
  id: string;
  title: string;
  kind: string;
  path?: string;
  url?: string;
  link?: string;
  extracted: string;
}

/**
 * Writes `sources/` and each source's `extracted/<source>/text.md`, then the pictures (fetched from the engine when its
 * address is known), then `README.md`. A part that cannot be made is left out and said in the log; the video is made
 * anyway. Made again from scratch each time, so a remake's folder is its own.
 */
export async function writeJobFolder(folder: string, request: VideoRequest, o: { engineUrl?: string; fetch?: typeof fetch; log?: (line: string) => void } = {}): Promise<SourceEntry[]> {
  const log = o.log ?? (() => {});
  for (const part of ["README.md", "sources", "extracted"]) rmSync(join(folder, part), { recursive: true, force: true });
  const sourcesDir = join(folder, "sources");
  mkdirSync(sourcesDir, { recursive: true });
  const entries: SourceEntry[] = [];
  const pictures = new Map<string, number>();
  const passages = new Map<string, number>();
  for (const source of sourcesOf(request)) {
    const name = folderName(source.id);
    const extracted = join(folder, "extracted", name);
    mkdirSync(extracted, { recursive: true });
    const entry: SourceEntry = { id: source.id, title: source.title, kind: source.kind, ...(source.path ? { path: source.path } : {}), ...(source.url ? { url: source.url } : {}), extracted: `extracted/${name}` };
    if (source.path) {
      const link = `${name}-${basename(source.path)}`;
      try {
        if (!isAbsolute(source.path) || !statSync(source.path).isFile()) throw new Error("not a file");
        symlinkSync(source.path, join(sourcesDir, link));
        entry.link = `sources/${link}`;
      } catch (e) {
        log(`job folder: no link to ${source.id}'s file (${(e as Error).message})`);
      }
    }
    const own = request.passages.filter((p) => p.sourceId === source.id);
    passages.set(source.id, own.length);
    const text = [`# ${source.title}`, "", ...own.flatMap((p) => [`## ${p.id}${p.locator ? ` · ${p.locator}` : ""}`, "", p.text.trim(), ""])].join("\n");
    writeFileSync(join(extracted, "text.md"), text);
    if (source.pictures?.length && o.engineUrl) pictures.set(source.id, await savePictures(extracted, source.pictures, o.engineUrl, o.fetch ?? fetch, log));
    entries.push(entry);
  }
  writeFileSync(join(sourcesDir, "sources.json"), JSON.stringify(entries, null, 1));
  writeFileSync(join(folder, "README.md"), readme(request, entries, passages, pictures));
  return entries;
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" };

/** Fetches a source's pictures from the engine into `pictures/`, lists the ones saved in `pictures.json`, and says how many. */
async function savePictures(dir: string, list: SourcePicture[], engineUrl: string, fetchImpl: typeof fetch, log: (line: string) => void): Promise<number> {
  const saved: Record<string, unknown>[] = [];
  for (const picture of list.slice(0, MAX_PICTURES)) {
    try {
      const response = await fetchImpl(new URL(picture.url, engineUrl), { signal: AbortSignal.timeout(PICTURE_MS) });
      const type = (picture.contentType ?? response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const ext = EXTENSIONS[type];
      if (!response.ok || !ext) throw new Error(response.ok ? `not a picture (${type || "no type"})` : `answered ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_PICTURE_BYTES) throw new Error("too big");
      const file = `pictures/${saved.length + 1}.${ext}`;
      mkdirSync(join(dir, "pictures"), { recursive: true });
      writeFileSync(join(dir, file), bytes);
      saved.push({ file, kind: picture.kind, ...(picture.caption ? { caption: picture.caption } : {}), ...(picture.page !== undefined ? { page: picture.page } : {}), ...(picture.timestampMs !== undefined ? { timestampMs: picture.timestampMs } : {}), ...(picture.width ? { width: picture.width } : {}), ...(picture.height ? { height: picture.height } : {}) });
    } catch (e) {
      log(`job folder: a picture at ${picture.url} was not saved (${(e as Error).message})`);
    }
  }
  if (saved.length) writeFileSync(join(dir, "pictures.json"), JSON.stringify(saved, null, 1));
  return saved.length;
}

function length(seconds: number | undefined): string | undefined {
  if (!seconds) return undefined;
  return seconds < 90 ? `about ${Math.round(seconds)} seconds` : `about ${Math.round(seconds / 60)} minutes`;
}

/** The note for the video agent: what the video is and where its files are. Knowledge, no rules. */
function readme(request: VideoRequest, entries: SourceEntry[], passages: Map<string, number>, pictures: Map<string, number>): string {
  const long = length(request.targetSeconds);
  const lines = [`# ${request.title}`, "", "This folder is one video being made, with its sources and what was read from them.", ""];
  if (request.brief) lines.push("## What it is about", "", request.brief, "");
  if (request.assumes.length) lines.push("The viewer already knows:", "", ...request.assumes.map((a) => `- ${a}`), "");
  const facts = [long ? `Length: ${long}.` : "", request.style !== "auto" ? `Style: ${request.style}.` : "", `Frame: ${request.frame.width} by ${request.frame.height}.`].filter(Boolean);
  lines.push(facts.join(" "), "", "## Where its files are", "");
  lines.push("- `sources/sources.json`: every source of this video, with where it came from.");
  if (entries.some((e) => e.link)) lines.push("- `sources/`: a link to each source that is a file on this computer, the original itself.");
  lines.push("- `extracted/<source>/text.md`: each source's text as it was read, one heading per passage; a cite names the passage by the id in its heading.");
  if ([...pictures.values()].some((n) => n > 0)) lines.push("- `extracted/<source>/pictures/`: the pictures kept from a source, listed with their captions and pages in its `pictures.json`.");
  lines.push("- `work/`: the agent's own folder for this video.", "", "## Sources", "");
  for (const e of entries) {
    const count = pictures.get(e.id) ?? 0;
    lines.push(`- ${e.title} (${e.kind}): \`${e.extracted}/text.md\`, ${passages.get(e.id) ?? 0} passages${count ? `, ${count} pictures` : ""}${e.url ? `, from ${e.url}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Copies a finished video into the library folder as `<title>.mp4` (with ` 2`, ` 3` when the name is taken) and says
 * where; does nothing and says nothing when no library is set or the video is not there.
 */
export function copyToLibrary(library: string | undefined, title: string, video: string): string | undefined {
  if (!library || !existsSync(video)) return undefined;
  mkdirSync(library, { recursive: true });
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Video";
  let to = join(library, `${base}.mp4`);
  for (let n = 2; existsSync(to); n++) to = join(library, `${base} ${n}.mp4`);
  copyFileSync(video, to);
  return to;
}

/** How many jobs are kept whatever their age, and for how many days any job is kept. */
export interface Keep {
  jobs: number;
  days: number;
}

export const KEEP: Keep = { jobs: 10, days: 7 };

/**
 * The jobs to remove: those neither among the last `keep.jobs` changed nor changed in the last `keep.days` days, never
 * one being made (`busy`).
 */
export function toRemove<J extends { id: string; updatedAt: string }>(jobs: J[], busy: (job: J) => boolean, keep: Keep, now: number): J[] {
  const newest = [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const since = now - keep.days * 86_400_000;
  return newest.filter((job, i) => i >= keep.jobs && !(Date.parse(job.updatedAt) >= since) && !busy(job));
}

/** The command that opens a folder in this computer's file manager: Finder, Explorer, or the desktop's own. */
export function openCommand(folder: string, platform: NodeJS.Platform = process.platform): { bin: string; args: string[] } {
  if (platform === "darwin") return { bin: "open", args: [folder] };
  if (platform === "win32") return { bin: "explorer.exe", args: [folder] };
  return { bin: "xdg-open", args: [folder] };
}

/** Opens a folder in the file manager on this computer; settles once the opener started, or failed to. */
export function openFolder(folder: string): Promise<void> {
  const { bin, args } = openCommand(folder);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
