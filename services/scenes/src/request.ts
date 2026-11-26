/** What `POST /videos` asks for, read and checked. */
import { readLimits, type Limits, type Passage } from "./script.ts";

export interface VideoRequest {
  id: string;
  title: string;
  brief: string;
  assumes: string[];
  frame: { width: number; height: number };
  targetSeconds?: number;
  style: string;
  /** Which agent, model, and effort write and build this video; omitted picks use defaults. */
  agent?: string;
  model?: string;
  effort?: string;
  passages: Passage[];
  /**
   * The video's sources as the engine knows them, for its job folder (docs/JOB-FOLDER.md): where each came from and the
   * pictures the engine kept from it. Left out by an older engine: the job folder is made from the passages alone.
   */
  sources?: JobSource[];
  limits: Limits;
  /** Skills beyond the service's own, for this video only: a project's packs, sent by name with their files. */
  skills?: ExtraSkill[];
  /** Whether a fresh viewer watches the finished video and its maker gets one round on its notes; the service's setting (SCENES_REVIEW) when left out. */
  review?: boolean;
  /**
   * Who that viewer is: an agent of its own, and a model and effort picked for that agent alone (a model never crosses
   * to another agent). Left out: the video's own agent, with the service's SCENES_REVIEW_MODEL/EFFORT as before.
   */
  reviewAgent?: string;
  reviewModel?: string;
  reviewEffort?: string;
}

/** One source of a video: its id (the passages' `sourceId`), title, kind, and its file on disk or its address. */
export interface JobSource {
  id: string;
  title: string;
  kind: string;
  url?: string;
  /** The original file on this computer, when the source is one: linked from the job folder, never copied. */
  path?: string;
  pictures?: SourcePicture[];
}

/** A picture the engine kept from a source: its own address on the engine (`/v1/assets/<id>`) and what it knows of it. */
export interface SourcePicture {
  url: string;
  kind: string;
  caption?: string;
  page?: number;
  timestampMs?: number;
  width?: number;
  height?: number;
  contentType?: string;
}

const MAX_SOURCES = 200;
const MAX_SOURCE_PICTURES = 200;
const ASSET_PATH = /^\/v1\/assets\/[A-Za-z0-9._~-]+$/;
const PICTURE_KINDS = new Set(["image", "figure", "frame", "slide", "thumbnail"]);

/** The sources of a request, checked: a list of { id, title, kind, url?, path?, pictures? }, pictures only of the engine's own. */
export function readSources(raw: unknown, problems: string[]): JobSource[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SOURCES) {
    problems.push(`sources: a list of at most ${MAX_SOURCES} { id, title, kind, url?, path?, pictures? }.`);
    return [];
  }
  const out: JobSource[] = [];
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  for (const [i, entry] of raw.entries()) {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const id = text(e.id);
    if (!id || id.length > 200 || out.some((s) => s.id === id)) {
      problems.push(`sources[${i}].id: a unique id is required.`);
      continue;
    }
    const path = text(e.path);
    if (path && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) problems.push(`sources[${i}].path: an absolute path, or leave it out.`);
    const pictures: SourcePicture[] = [];
    for (const raw of (Array.isArray(e.pictures) ? e.pictures : []).slice(0, MAX_SOURCE_PICTURES)) {
      const p = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const url = text(p.url);
      const kind = text(p.kind);
      // Only the engine's own pictures, by their address on it: nothing else is fetched.
      if (!ASSET_PATH.test(url) || !PICTURE_KINDS.has(kind)) continue;
      const caption = text(p.caption).slice(0, 500);
      const contentType = text(p.contentType);
      pictures.push({ url, kind, ...(caption ? { caption } : {}), ...(num(p.page) !== undefined ? { page: num(p.page)! } : {}), ...(num(p.timestampMs) !== undefined ? { timestampMs: num(p.timestampMs)! } : {}), ...(num(p.width) ? { width: num(p.width)! } : {}), ...(num(p.height) ? { height: num(p.height)! } : {}), ...(contentType ? { contentType } : {}) });
    }
    const url = text(e.url);
    out.push({ id, title: text(e.title).slice(0, 300) || "Untitled source", kind: text(e.kind).slice(0, 40) || "source", ...(/^https?:\/\//.test(url) ? { url } : {}), ...(path ? { path } : {}), ...(pictures.length ? { pictures } : {}) });
  }
  return out;
}

/** One skill sent with a video: its folder name and its files by their path inside it (`SKILL.md`, `references/x.md`). */
export interface ExtraSkill {
  name: string;
  files: Record<string, string>;
}

const MAX_SKILLS = 8;
const MAX_SKILL_FILES = 40;
const MAX_SKILL_CHARS = 200_000;

/** The extra skills of a request: a plain folder name each, plain relative .md paths, a SKILL.md, within size. */
export function readSkills(raw: unknown, problems: string[]): ExtraSkill[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SKILLS) {
    problems.push(`skills: a list of at most ${MAX_SKILLS} { name, files }.`);
    return [];
  }
  const out: ExtraSkill[] = [];
  for (const [i, entry] of raw.entries()) {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const files = typeof e.files === "object" && e.files !== null && !Array.isArray(e.files) ? (e.files as Record<string, unknown>) : {};
    const paths = Object.keys(files);
    const size = paths.reduce((n, p) => n + (typeof files[p] === "string" ? (files[p] as string).length : 0), 0);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) problems.push(`skills[${i}].name: lower-case letters, digits and -.`);
    else if (out.some((s) => s.name === name)) problems.push(`skills[${i}].name: "${name}" is sent twice.`);
    if (typeof files["SKILL.md"] !== "string") problems.push(`skills[${i}].files: needs a SKILL.md.`);
    if (paths.length > MAX_SKILL_FILES || size > MAX_SKILL_CHARS) problems.push(`skills[${i}].files: at most ${MAX_SKILL_FILES} files and ${MAX_SKILL_CHARS} characters.`);
    if (paths.some((p) => !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md$/.test(p) || p.split("/").includes("..") || typeof files[p] !== "string")) problems.push(`skills[${i}].files: relative .md paths with text.`);
    out.push({ name, files: Object.fromEntries(paths.map((p) => [p, String(files[p])])) });
  }
  return out;
}

const MAX_PASSAGES = 200;
const MAX_PASSAGE_CHARS = 60_000;

export function readRequest(body: unknown, styles: string[]): { request: VideoRequest } | { problems: string[] } {
  const problems: string[] = [];
  if (typeof body !== "object" || body === null) return { problems: ["The body must be a JSON object."] };
  const b = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const id = text(b.id);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) problems.push("id: letters, digits, - and _, up to 100.");
  const title = text(b.title);
  if (!title) problems.push("title is required.");
  const brief = text(b.brief);
  const assumes = (Array.isArray(b.assumes) ? b.assumes : []).map(text).filter(Boolean).slice(0, 20);
  const f = (b.frame ?? { width: 1080, height: 1920 }) as Record<string, unknown>;
  const width = Number(f.width);
  const height = Number(f.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 320 || width > 3840 || height > 3840 || width % 2 || height % 2) problems.push("frame: even width and height, 320 to 3840.");
  const target = b.targetSeconds === undefined || b.targetSeconds === null ? undefined : Number(b.targetSeconds);
  if (target !== undefined && (!Number.isFinite(target) || target < 5 || target > 1800)) problems.push("targetSeconds: 5 to 1800, or leave it out.");
  const style = text(b.style) || "auto";
  if (style !== "auto" && !styles.includes(style)) problems.push(`style: "auto" or one of ${styles.join(", ")}.`);
  const list = Array.isArray(b.passages) ? b.passages : [];
  if (!list.length) problems.push("passages: at least one, each { id, sourceId, sourceTitle, text }.");
  if (list.length > MAX_PASSAGES) problems.push(`passages: at most ${MAX_PASSAGES}.`);
  const seen = new Set<string>();
  const passages: Passage[] = [];
  for (const [i, raw] of list.slice(0, MAX_PASSAGES).entries()) {
    const p = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const passage: Passage = { id: text(p.id), ...(text(p.label) ? { label: text(p.label).slice(0, 40) } : {}), sourceId: text(p.sourceId), sourceTitle: text(p.sourceTitle) || "Untitled source", ...(text(p.locator) ? { locator: text(p.locator) } : {}), text: typeof p.text === "string" ? p.text : "" };
    if (!passage.id || seen.has(passage.id)) problems.push(`passages[${i}]: a unique id is required.`);
    if (!passage.sourceId) problems.push(`passages[${i}]: sourceId is required.`);
    if (!passage.text.trim()) problems.push(`passages[${i}]: text is required.`);
    if (passage.text.length > MAX_PASSAGE_CHARS) problems.push(`passages[${i}]: at most ${MAX_PASSAGE_CHARS} characters.`);
    seen.add(passage.id);
    passages.push(passage);
  }
  const skills = readSkills(b.skills, problems);
  const sources = readSources(b.sources, problems);
  const optText = (key: string): string | undefined => {
    const raw = b[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string" || !raw.trim()) {
      problems.push(`${key}: a non-empty string, or leave it out.`);
      return undefined;
    }
    return raw.trim();
  };
  const agent = optText("agent");
  const model = optText("model");
  const effort = optText("effort");
  if (b.review !== undefined && b.review !== null && typeof b.review !== "boolean") problems.push("review: true or false, or leave it out.");
  const review = typeof b.review === "boolean" ? b.review : undefined;
  const reviewAgent = optText("reviewAgent");
  const reviewModel = optText("reviewModel");
  const reviewEffort = optText("reviewEffort");
  if ((reviewModel || reviewEffort) && !reviewAgent) problems.push("reviewModel, reviewEffort: only with reviewAgent, the agent they were picked for.");
  if (problems.length) return { problems };
  return { request: { id, title, brief, assumes, frame: { width, height }, ...(target !== undefined ? { targetSeconds: target } : {}), style, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), passages, ...(sources.length ? { sources } : {}), limits: readLimits(b.limits), ...(skills.length ? { skills } : {}), ...(review !== undefined ? { review } : {}), ...(reviewAgent ? { reviewAgent } : {}), ...(reviewModel ? { reviewModel } : {}), ...(reviewEffort ? { reviewEffort } : {}) } };
}
