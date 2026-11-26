/** Sources: what a project is made from (files, links, pasted text), read once and kept as text. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { connect, projectOf, type Engine } from "./connect.ts";
import { PROJECT_FLAG, Problem, flagString, type Ctx, type Group } from "./table.ts";
import { clip, plural, table } from "./util.ts";

export interface Source {
  id: string;
  projectId?: string;
  kind: string;
  title: string;
  status: string;
  accessLevel?: string;
  errorMessage?: string;
  url?: string;
}

export interface SourceView {
  source: Source;
  extraction: { status: string; text?: string; title?: string; limitations?: string[]; errorMessage?: string };
  chunkCount: number;
}

/** Content types by file ending, for the upload; anything else goes as text when it reads as text. */
const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
};

function contentTypeOf(file: string, bytes: Uint8Array): string | undefined {
  const known = TYPES[extname(file).toLowerCase()];
  if (known) return known;
  // No ending Open Sourcebook knows: plain text when it has no zero bytes.
  return bytes.subarray(0, 4096).includes(0) ? undefined : "text/plain";
}

const isLink = (s: string) => /^https?:\/\//i.test(s);

async function addOne(engine: Engine, projectId: string, what: string, ctx: Ctx, title?: string): Promise<SourceView> {
  if (isLink(what)) return engine.call<SourceView>("POST", "/v1/sources", { json: { url: what, projectId, ...(title ? { title } : {}) } });
  const file = resolve(ctx.cwd, what);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Problem("file_not_found", `"${what}" is not a file here (${ctx.cwd}) or a link starting with http. To add words you have, use --text "<words>" or pipe them into "opensourcebook source add -".`);
  }
  const bytes = new Uint8Array(readFileSync(file));
  const type = contentTypeOf(file, bytes);
  if (!type) throw new Problem("unsupported_file", `Open Sourcebook can't read ${basename(file)}: it is not a PDF, a document, text, a picture or a recording.`);
  ctx.progress(`Reading ${basename(file)}`);
  const { upload } = await engine.call<{ upload: { id: string } }>("POST", "/v1/uploads", { body: bytes, headers: { "content-type": type, "x-upload-filename": basename(file) } });
  return engine.call<SourceView>("POST", "/v1/sources", { json: { uploadId: upload.id, projectId, ...(title ? { title } : {}) } });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function listSources(engine: Engine, projectId: string): Promise<Source[]> {
  const all: Source[] = [];
  let cursor: string | undefined;
  do {
    const page = await engine.call<{ sources: Source[]; nextCursor?: string }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/sources`, { query: { limit: 200, cursor } });
    all.push(...page.sources);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/**
 * A source's text as numbered paragraphs (P1, P2, ...), split at blank lines. These are for reading here; a cite in
 * a reply or a made thing carries its own quote and place.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The outline: headings when the text has them, else each paragraph's opening words. */
export function outline(text: string): Array<{ paragraph: number; line: string; heading: boolean }> {
  const paras = paragraphs(text);
  const out: Array<{ paragraph: number; line: string; heading: boolean }> = [];
  paras.forEach((p, i) => {
    const first = p.split("\n")[0]!.trim();
    const heading = /^#{1,6}\s/.test(first) || (first.length <= 80 && !/[.!?:;,]$/.test(first) && p.split("\n").length > 1);
    out.push({ paragraph: i + 1, line: clip(first.replace(/^#{1,6}\s*/, ""), 90), heading });
  });
  // Headings alone when there are enough of them to find one's way; else every paragraph's opening words.
  return out.filter((o) => o.heading).length >= 3 ? out.filter((o) => o.heading) : out.slice(0, 200);
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Paragraphs ranked by how many of the query's words they hold (each word once), best first. */
export function rank(paras: string[], query: string): Array<{ paragraph: number; score: number }> {
  const wanted = [...new Set(words(query).filter((w) => w.length > 2))];
  if (!wanted.length) return [];
  return paras
    .map((p, i) => {
      const have = new Set(words(p));
      const score = wanted.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w) || w.startsWith(h) && h.length > 3)).length / wanted.length;
      return { paragraph: i + 1, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.paragraph - b.paragraph);
}

/** A single source as read by id carries its state on the extraction; lists carry it on the source. One shape here. */
export function withStatus(view: SourceView): SourceView {
  const e = view.extraction;
  const status = view.source.status ?? e.status;
  const errorMessage = view.source.errorMessage ?? (status === "failed" ? e.errorMessage : undefined);
  return { ...view, source: { ...view.source, status, ...(errorMessage ? { errorMessage } : {}) } };
}

function describe(raw: SourceView): string {
  const view = withStatus(raw);
  const s = view.source;
  const state = s.status === "ready" ? "read" : s.status === "failed" ? `could not be read: ${s.errorMessage ?? view.extraction.errorMessage ?? "no reason given"}` : s.status === "extracting" ? "busy reading, please wait" : s.status;
  return `${s.title}  (${s.id}, ${s.kind}, ${state})`;
}

const SOURCE_ARG = { name: "source", help: "the source's id (\"opensourcebook source list\" shows them)" };

export const sources: Group = {
  thing: "source",
  aliases: ["sources"],
  about: "what a project is made from: files, links and pasted text",
  commands: [
    {
      thing: "source",
      action: "add",
      summary: "add files or links to the project (or pasted words with --text, or - to read them from stdin)",
      args: [{ name: "what", help: "files or links; - reads words from stdin", many: true, optional: true }],
      flags: [PROJECT_FLAG, { name: "text", value: "words", help: "add these words as a source" }, { name: "title", value: "title", help: "your name for it (one source only)" }],
      shape: "{ sources: [{ source: Source, chunkCount: number }] }  (Source: { id, title, kind, status: \"pending\"|\"extracting\"|\"ready\"|\"failed\", errorMessage?, accessLevel? })",
      more: "Each is read while you wait. A source that could not be read says why in its errorMessage.",
      async run(ctx) {
        const engine = connect(ctx);
        const projectId = projectOf(ctx);
        const list = ctx.lists.what ?? [];
        const text = flagString(ctx, "text");
        const title = flagString(ctx, "title");
        if (!list.length && text === undefined) throw new Problem("bad_arguments", 'Say what to add: files, links, --text "<words>", or - to read words from stdin.');
        const added: SourceView[] = [];
        if (text !== undefined) added.push(await engine.call<SourceView>("POST", "/v1/sources", { json: { text, projectId, ...(title ? { title } : {}) } }));
        for (const what of list) {
          if (what === "-") added.push(await engine.call<SourceView>("POST", "/v1/sources", { json: { text: await readStdin(), projectId, ...(title ? { title } : {}) } }));
          else added.push(await addOne(engine, projectId, what, ctx, list.length === 1 ? title : undefined));
        }
        const shown = added.map(withStatus);
        const failed = shown.filter((a) => a.source.status === "failed");
        return {
          data: { sources: shown.map((a) => ({ source: a.source, chunkCount: a.chunkCount })) },
          text: `Added ${plural(added.length, "source")}:\n${added.map((a) => `  ${describe(a)}`).join("\n")}`,
          exit: failed.length ? 1 : 0,
        };
      },
    },
    {
      thing: "source",
      action: "list",
      summary: "the project's sources",
      flags: [PROJECT_FLAG],
      shape: "{ sources: Source[] }",
      async run(ctx) {
        const list = await listSources(connect(ctx), projectOf(ctx));
        return { data: { sources: list }, text: list.length ? table(list.map((s) => [s.id, s.title, s.kind, s.status])) : 'No sources yet. Add some with "opensourcebook source add <files or links>".' };
      },
    },
    {
      thing: "source",
      action: "show",
      summary: "one source: how it was read, what could not be read, and its outline",
      args: [SOURCE_ARG],
      shape: "{ source: Source, limitations: string[], paragraphs: number, characters: number, outline: [{ paragraph, line, heading }] }",
      async run(ctx) {
        const view = withStatus(await connect(ctx).call<SourceView>("GET", `/v1/sources/${encodeURIComponent(ctx.args.source!)}`));
        const text = view.extraction.text ?? "";
        const paras = paragraphs(text);
        const out = outline(text);
        const limitations = view.extraction.limitations ?? [];
        return {
          data: { source: view.source, limitations, paragraphs: paras.length, characters: text.length, outline: out },
          text: [
            describe(view),
            `${plural(paras.length, "paragraph")}, ${text.length.toLocaleString("en-US")} characters`,
            ...(limitations.length ? ["What could not be read:", ...limitations.map((l) => `  ${l}`)] : []),
            ...(out.length ? ["Outline (P = paragraph, for \"opensourcebook source read\"):", ...out.map((o) => `  P${o.paragraph}  ${o.line}`)] : []),
          ].join("\n"),
        };
      },
    },
    {
      thing: "source",
      action: "read",
      summary: "a source's words, paragraph by paragraph",
      args: [SOURCE_ARG],
      flags: [{ name: "from", value: "n", help: "first paragraph (default 1)" }, { name: "to", value: "n", help: "last paragraph (default: as many as fit in about 16,000 characters)" }],
      shape: "{ source: Source, paragraphs: [{ paragraph: number, text: string }], more: boolean }",
      async run(ctx) {
        const view = await connect(ctx).call<SourceView>("GET", `/v1/sources/${encodeURIComponent(ctx.args.source!)}`);
        const paras = paragraphs(view.extraction.text ?? "");
        const from = Math.max(1, Number(flagString(ctx, "from") ?? 1) || 1);
        const toFlag = flagString(ctx, "to");
        const shown: Array<{ paragraph: number; text: string }> = [];
        let used = 0;
        for (let n = from; n <= paras.length; n++) {
          if (toFlag !== undefined && n > Number(toFlag)) break;
          const p = paras[n - 1]!;
          if (toFlag === undefined && shown.length && used + p.length > 16_000) break;
          shown.push({ paragraph: n, text: p });
          used += p.length;
        }
        const last = shown.at(-1)?.paragraph ?? from - 1;
        const more = last < paras.length;
        return {
          data: { source: view.source, paragraphs: shown, more },
          text: shown.length ? `${shown.map((p) => `P${p.paragraph}  ${p.text}`).join("\n\n")}${more ? `\n\n(Paragraphs ${last + 1} to ${paras.length} follow: --from ${last + 1}.)` : ""}` : `${view.source.title} has no paragraph ${from}; it has ${paras.length}.`,
        };
      },
    },
    {
      thing: "source",
      action: "search",
      summary: "paragraphs of the project's sources about something, best first",
      args: [{ name: "query", help: "what to look for, in the words the sources would use", rest: true }],
      flags: [PROJECT_FLAG, { name: "source", value: "id", help: "only this source", many: true }, { name: "limit", value: "n", help: "how many (default 8)" }],
      shape: "{ found: [{ sourceId, title, paragraph: number, score: number, text: string }] }",
      async run(ctx) {
        const engine = connect(ctx);
        const named = Array.isArray(ctx.flags.source) ? ctx.flags.source : [];
        const ids = named.length ? named : (await listSources(engine, projectOf(ctx))).filter((s) => s.status === "ready").map((s) => s.id);
        const found: Array<{ sourceId: string; title: string; paragraph: number; score: number; text: string }> = [];
        for (const id of ids) {
          const view = await engine.call<SourceView>("GET", `/v1/sources/${encodeURIComponent(id)}`);
          const paras = paragraphs(view.extraction.text ?? "");
          for (const r of rank(paras, ctx.args.query!)) found.push({ sourceId: id, title: view.source.title, paragraph: r.paragraph, score: Math.round(r.score * 100) / 100, text: paras[r.paragraph - 1]! });
        }
        found.sort((a, b) => b.score - a.score);
        const top = found.slice(0, Number(flagString(ctx, "limit") ?? 8) || 8);
        return { data: { found: top }, text: top.length ? top.map((f) => `${f.title} P${f.paragraph}  (${f.sourceId})\n  ${clip(f.text.replace(/\s+/g, " "), 300)}`).join("\n\n") : `Nothing in the sources matches "${ctx.args.query}". Try other words.` };
      },
    },
    {
      thing: "source",
      action: "rename",
      summary: "give a source your own name",
      args: [SOURCE_ARG, { name: "title", help: "the new name", rest: true }],
      shape: "{ source: Source }",
      async run(ctx) {
        const { source } = await connect(ctx).call<{ source: Source }>("PATCH", `/v1/sources/${encodeURIComponent(ctx.args.source!)}`, { json: { title: ctx.args.title } });
        return { data: { source }, text: `Renamed to "${source.title}".` };
      },
    },
    {
      thing: "source",
      action: "remove",
      summary: "take a source out of its project (kept hidden while something made still cites it)",
      args: [SOURCE_ARG],
      shape: "{ sourceId: string, deleted: boolean, changedPlanIds: string[] }",
      async run(ctx) {
        const answer = await connect(ctx).call<{ sourceId: string; deleted: boolean; changedPlanIds: string[] }>("DELETE", `/v1/sources/${encodeURIComponent(ctx.args.source!)}`);
        return { data: answer, text: answer.deleted ? "Removed." : "Removed from the project; kept hidden because something made from it still points at it." };
      },
    },
    {
      thing: "source",
      action: "retry",
      summary: "read a source that failed once more",
      args: [SOURCE_ARG],
      shape: "{ source: Source, chunkCount: number }",
      async run(ctx) {
        const view = withStatus(await connect(ctx).call<SourceView>("POST", `/v1/sources/${encodeURIComponent(ctx.args.source!)}/retry`));
        return { data: { source: view.source, chunkCount: view.chunkCount }, text: describe(view), exit: view.source.status === "failed" ? 1 : 0 };
      },
    },
  ],
};
