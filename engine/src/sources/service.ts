/**
 * Adding a source and extracting it: "one source, extracted once, cached by
 * hash" (engine/README.md).
 *
 * A source is one user's item (a row in `sources`, in a project or the
 * Inbox). What it points at is identified by a content hash; the extraction
 * and its chunks hang off that hash in `source_extractions` and are shared
 * by every source with the same content. Adding the same content again is a
 * new item at most, never a second extraction.
 *
 * The hash is namespaced by what was hashed, so pasted text that happens to
 * equal a URL is not mistaken for that URL:
 *   url:<sha256 of the normalized URL>
 *   upload:<sha256 of the uploaded bytes>
 *   text:<sha256 of the trimmed text>
 */
import { normalizeURL } from "../extract/html";
import { inferKind, isTextFile } from "../extract/kinds";
import { MAX_SOURCE_CHARS, textEnvelope } from "../extract/context";
import { isHTTPURL, sha256Hex } from "../net";
import type { StudioRepositories } from "../studio/repositories";
import type { Source, SourceExtraction, SourceOrigin } from "../studio/repositories/sources";
import type { SourceChunk } from "../studio/types";
import type { AssetStore } from "../assets";
import { folderContentType, type StoredUpload, type UploadStore } from "../uploads";
import { splitPath, type LocalFiles } from "../local-files";
import type { StructuredProvider } from "../types/provider";
import { SOURCE_KINDS, type ExtractionRequest, type SourceEnvelope, type SourceKind } from "../types/source";
import { chunkEnvelope, type Chunker } from "./chunk";
import { NOTHING_READ } from "./failure";

/** Pasted text longer than this is refused: the same bound as any source (engine/docs/long-sources.md). */
export const MAX_SOURCE_TEXT = MAX_SOURCE_CHARS;
/** An extraction stuck in `extracting` this long is presumed abandoned and may be taken over. */
const STALE_EXTRACTION_MS = 10 * 60_000;

export interface AddSourceInput {
  ownerId: string;
  /** Must be a project this owner has; checked by `projectFor`. Absent = Inbox. */
  projectId?: string;
  url?: string;
  text?: string;
  uploadId?: string;
  kind?: SourceKind;
  title?: string;
  origin?: SourceOrigin;
}

/** A request that cannot become a source. `code` is the wire error. */
export class SourceInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SourceInputError";
  }
}

/** Another caller is extracting this content right now. Retrying later reuses its result. */
export class ExtractionBusyError extends Error {
  constructor(readonly contentHash: string) {
    super(`Source ${contentHash} is being extracted by another request; try again shortly.`);
    this.name = "ExtractionBusyError";
  }
}

export interface AddedSource {
  source: Source;
  extraction: SourceExtraction;
  /** True when this owner already had the same content in the same place; nothing new was written. */
  existing: boolean;
}

export interface ExtractedSource {
  source: Source;
  envelope: SourceEnvelope;
  chunks: SourceChunk[];
  /** True when this call ran the extractor; false when it reused a cached result. */
  extracted: boolean;
}

/** What the service needs of `SourceExtractor`. */
export interface Extractor {
  extract(request: ExtractionRequest): Promise<SourceEnvelope>;
}

export interface SourceServiceOptions {
  repos: StudioRepositories;
  extractor: Extractor;
  uploads: UploadStore;
  assets?: AssetStore;
  /** This computer's files, for a source that is a file in a linked folder (#71); absent, such a source is not read again. */
  localFiles?: LocalFiles;
  chunker?: Chunker;
  now?: () => number;
}

interface Resolved {
  contentHash: string;
  kind: SourceKind;
  url?: string;
  uploadId?: string;
  /** The name the uploaded file came with. */
  fileName?: string;
  text?: string;
  origin: SourceOrigin;
}

export class SourceService {
  private readonly repos: StudioRepositories;
  private readonly chunker: Chunker;
  private readonly now: () => number;

  constructor(private readonly options: SourceServiceOptions) {
    this.repos = options.repos;
    this.chunker = options.chunker ?? chunkEnvelope;
    this.now = options.now ?? Date.now;
  }

  /** The project, when it exists and belongs to the owner. */
  async projectFor(ownerId: string, projectId: string): Promise<string | undefined> {
    const project = await this.repos.projects.get(projectId);
    return project && project.ownerId === ownerId ? project.id : undefined;
  }

  /**
   * Records a source without extracting it (text is extracted on the spot;
   * it needs no network). A repeat of the same content in the same place
   * returns the existing item.
   */
  async add(input: AddSourceInput): Promise<AddedSource> {
    const resolved = await this.resolve(input);
    const { extraction, created } = await this.repos.sources.ensureExtraction(resolved.contentHash, resolved.kind);

    const same = (await this.repos.sources.findByHash(input.ownerId, resolved.contentHash)).find(
      (source) => (source.projectId ?? null) === (input.projectId ?? null),
    );
    // A source removed from this place comes back, with the cites that still point at it.
    if (same) return { source: same.removedAt ? ((await this.repos.sources.restore(same.id)) ?? same) : same, extraction, existing: true };

    const source = await this.repos.sources.create({
      ownerId: input.ownerId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      contentHash: resolved.contentHash,
      kind: resolved.kind,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(resolved.url ? { url: resolved.url } : {}),
      ...(resolved.uploadId ? { uploadId: resolved.uploadId } : {}),
      ...(resolved.fileName ? { fileName: resolved.fileName } : {}),
      origin: input.origin ?? resolved.origin,
    });
    if (resolved.text !== undefined && (created || extraction.status !== "ready")) {
      const envelope = textEnvelope(resolved.text, resolved.kind, new Date(this.now()).toISOString());
      await this.store(resolved.contentHash, envelope);
      // Text pasted without a title is named by its read title: its own first line or sentence.
      return {
        source: (await this.repos.sources.get(source.id)) ?? source,
        extraction: (await this.repos.sources.getExtraction(resolved.contentHash))!,
        existing: false,
      };
    }
    return { source, extraction, existing: false };
  }

  /**
   * The source's extraction and chunks, extracting first if no one has yet.
   * Throws `ExtractionBusyError` while another caller holds the extraction.
   * `contextText` is a caption shared with a link; it reaches the extractor
   * only on the first extraction of that content.
   */
  async ensureExtracted(source: Source, options: ExtractOptions = {}): Promise<ExtractedSource> {
    const cached = await this.repos.sources.getExtraction(source.contentHash);
    if (cached?.status === "ready" && cached.envelope) {
      return { source, envelope: cached.envelope, chunks: await this.repos.sources.listChunks(source.contentHash), extracted: false };
    }
    const staleBefore = new Date(this.now() - STALE_EXTRACTION_MS).toISOString();
    const claimed = await this.repos.sources.claimExtraction(source.contentHash, staleBefore);
    if (!claimed) {
      const again = await this.repos.sources.getExtraction(source.contentHash);
      if (again?.status === "ready" && again.envelope) {
        return { source, envelope: again.envelope, chunks: await this.repos.sources.listChunks(source.contentHash), extracted: false };
      }
      throw new ExtractionBusyError(source.contentHash);
    }

    try {
      const envelope = await this.extract(source, options);
      if (envelope.accessLevel === "none" && !envelope.text.trim()) {
        // Nothing was read (the page could not be fetched, the file held no
        // text): a source with nothing in it is a failed one, not a ready one.
        throw new Error(nothingReadMessage(envelope));
      }
      const chunks = await this.store(source.contentHash, envelope);
      // The read title names the source from here on, for everyone who added this content (sources/title.ts).
      return { source: (await this.repos.sources.get(source.id)) ?? source, envelope, chunks, extracted: true };
    } catch (error) {
      await this.repos.sources.updateExtraction(source.contentHash, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async extract(source: Source, options: ExtractOptions): Promise<SourceEnvelope> {
    const kind = isSourceKind(source.kind) ? source.kind : "unknown";
    const sourceText = options.contextText?.trim() ?? "";
    const common = {
      sourceText,
      sourceKind: kind,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(this.options.assets ? { assetStore: this.options.assets } : {}),
      now: () => new Date(this.now()).toISOString(),
    };
    if (options.file) return this.options.extractor.extract({ ...common, uploadBytes: options.file });
    if (source.filePath && !source.uploadId) {
      // A file in a linked folder is read where it is, never copied into the store.
      if (!this.options.localFiles) throw new SourceInputError("files_unavailable", "This source is a file on the computer Open Sourcebook runs on, and can be read again only there.", 409);
      const { folder, name } = splitPath(source.filePath);
      const bytes = await this.options.localFiles.read(folder, name);
      return this.options.extractor.extract({ ...common, uploadBytes: { bytes, contentType: fileContentType(name), filename: name } });
    }
    if (source.uploadId) {
      const upload = await this.options.uploads.getUpload(source.uploadId);
      if (!upload) throw new SourceInputError("upload_not_found", `Upload ${source.uploadId} does not exist.`, 404);
      return this.options.extractor.extract({ ...common, uploadBytes: upload });
    }
    if (source.url) return this.options.extractor.extract({ ...common, sourceURL: source.url });
    throw new SourceInputError("source_unextractable", `Source ${source.id} has neither a URL nor an upload to extract.`);
  }

  private async store(contentHash: string, envelope: SourceEnvelope): Promise<SourceChunk[]> {
    const chunks = await this.repos.sources.replaceChunks(contentHash, this.chunker(envelope));
    await this.repos.sources.updateExtraction(contentHash, {
      status: "ready",
      accessLevel: envelope.accessLevel,
      envelope,
      errorMessage: null,
    });
    return chunks;
  }

  /** Picks what is hashed: an upload, else a URL, else pasted text (August's precedence). */
  private async resolve(input: AddSourceInput): Promise<Resolved> {
    if (input.kind !== undefined && !isSourceKind(input.kind)) {
      throw new SourceInputError("invalid_source_kind", `sourceKind must be one of ${SOURCE_KINDS.join(", ")}`);
    }
    const uploadId = input.uploadId?.trim();
    if (uploadId) {
      const upload = await this.options.uploads.getUpload(uploadId);
      if (!upload) throw new SourceInputError("upload_not_found", `Upload ${uploadId} does not exist.`, 404);
      const kind = fileKind(upload.contentType, upload.filename, input.kind);
      return {
        contentHash: `upload:${await sha256Hex(upload.bytes)}`,
        kind,
        uploadId,
        ...(upload.filename ? { fileName: upload.filename } : {}),
        origin: "upload",
      };
    }

    const rawURL = input.url?.trim();
    if (rawURL) {
      const url = isHTTPURL(rawURL) ? normalizeURL(rawURL) : undefined;
      if (!url) throw new SourceInputError("invalid_source_url", "url must be an absolute HTTP(S) URL");
      return { contentHash: `url:${await sha256Hex(url)}`, kind: inferKind(input.kind ?? "web", url), url, origin: "link" };
    }

    const text = input.text?.trim();
    if (text) {
      if (text.length > MAX_SOURCE_TEXT) {
        throw new SourceInputError("source_too_large", `text must be at most ${MAX_SOURCE_TEXT} characters`);
      }
      return { contentHash: `text:${await sha256Hex(text)}`, kind: input.kind ?? "text", text, origin: "paste" };
    }
    throw new SourceInputError("source_required", "A url, text or uploadId is required");
  }
}

/** How a source is read and named. `file`: the bytes already in hand (a check of a linked folder just read them). */
export interface ExtractOptions {
  provider?: StructuredProvider;
  contextText?: string;
  file?: StoredUpload;
}

/** The kind of source a file is, from its type and name, unless one was asked for. */
export function fileKind(contentType: string, filename: string | undefined, asked?: SourceKind): SourceKind {
  return contentType === "application/pdf" ? "pdf" : (asked ?? (isTextFile(contentType, filename) ? "text" : "unknown"));
}

/** The type a linked folder's file is read as, by its name (the same list uploads are checked against). */
function fileContentType(name: string): string {
  return folderContentType(name) ?? "application/octet-stream";
}

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

/** Why nothing was read, in plain words, from the extraction's own first limitation. */
function nothingReadMessage(envelope: SourceEnvelope): string {
  const why = envelope.limitations.find((line) => line.trim())?.replace(/;.*$/, "").trim();
  return why ? `${NOTHING_READ} ${why}.`.replace(/\.\.$/, ".") : NOTHING_READ;
}


