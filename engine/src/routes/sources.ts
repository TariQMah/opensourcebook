/**
 * `POST /v1/sources` adds a source by URL, pasted text or upload id and
 * extracts it once; `GET /v1/sources/:id` reads it back.
 *
 *   POST body: { url? | text? | uploadId?, projectId?, kind?, title? }
 *   201 { source, extraction, chunkCount }  new item
 *   200 { source, extraction, chunkCount }  same content already in that place
 *
 * Without `projectId` the source sits in the Inbox; an archived project
 * takes none (409 project_archived). Extraction runs in the
 * request; a second add of the same content (by anyone) reuses it.
 *
 *   PATCH  /v1/sources/:id         → 200 { source }        { title: string | null }
 *   DELETE /v1/sources/:id         → 200 { sourceId, deleted, changedPlanIds }
 *   POST   /v1/sources/:id/retry   → 200 { source, extraction, chunkCount }
 *   GET    /v1/sources/:id/file    → 200 the uploaded file's bytes, 404 when it has none
 *
 * A removed source (`removedAt`) still reads back with GET, so cites keep
 * opening it; it takes no rename, retry or filing (404).
 */
import { authenticate, errorResponse, json, notFound, optionalString, readJsonObject } from "../http";
import { assetSafetyHeaders } from "./media";
import { ExtractionBusyError, SourceInputError } from "../sources/service";
import { canReadAgain } from "../sources/failure";
import { sourceDetail, type SourceDetail } from "../sources/detail";
import { removeSource } from "../studio/removal";
import type { ListedSource, Source, SourceExtraction } from "../studio/repositories/sources";
import type { SourceKind } from "../types/source";
import type { EngineDeps } from "../wiring";
import { FieldError, clearableText, readFields } from "./fields";

const MAX_TITLE = 200;
/** What a retry of a source still being read is told: it is busy, not broken, and needs nothing but time. */
export const SOURCE_BUSY = "Busy reading this source, please wait. It is ready when the reading finishes; nothing needs doing.";

export async function createSource(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { body } = read;

  const requestedProject = optionalString(body, "projectId");
  const projectId = requestedProject ? await deps.sources.projectFor(auth.ownerId, requestedProject) : undefined;
  if (requestedProject && !projectId) return errorResponse("project_not_found", "Project not found", 404);
  if (projectId && (await deps.repos.projects.get(projectId))?.archivedAt) {
    return errorResponse("project_archived", "An archived project takes no new sources", 409);
  }

  try {
    const added = await deps.sources.add({
      ownerId: auth.ownerId,
      ...(projectId ? { projectId } : {}),
      ...(optionalString(body, "url") ? { url: optionalString(body, "url") } : {}),
      ...(optionalString(body, "text") ? { text: optionalString(body, "text") } : {}),
      ...(optionalString(body, "uploadId") ? { uploadId: optionalString(body, "uploadId") } : {}),
      ...(optionalString(body, "kind") ? { kind: optionalString(body, "kind") as SourceKind } : {}),
      ...(optionalString(body, "title") ? { title: optionalString(body, "title") } : {}),
    });
    let source = added.source;
    if (added.extraction.status !== "ready") {
      try {
        source = (await deps.sources.ensureExtracted(source, { provider: deps.provider(deps.repos.usage.sink({ ownerId: auth.ownerId })) }))
          .source;
      } catch (error) {
        // The source exists either way; its extraction status says what happened.
        if (!(error instanceof ExtractionBusyError)) console.warn(`Source ${source.id}: extraction failed: ${message(error)}`);
      }
    }
    return json(await sourceView(deps, source), added.existing ? 200 : 201);
  } catch (error) {
    if (error instanceof SourceInputError) return errorResponse(error.code, error.message, error.status);
    throw error;
  }
}

export async function getSource(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const source = await deps.repos.sources.get(id);
  if (!source || source.ownerId !== auth.ownerId) return notFound("Source not found");
  return json(await sourceView(deps, source));
}

/**
 * A source's own uploaded file (`GET /v1/sources/:id/file`): its stored
 * bytes with the type it was stored as, for the person who holds the source
 * (a removed one too, while its file is kept). Sent with the same safety
 * headers as an asset, so nothing in it runs on this address; a picture,
 * sound, video or PDF opens in place, anything else is saved, under its own
 * name either way. `404` for a source of someone else's, one that came from
 * a link or pasted text, or one whose file is no longer kept.
 */
export async function getSourceFile(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const source = await deps.repos.sources.get(id);
  if (!source || source.ownerId !== auth.ownerId) return notFound("Source not found");
  const stored = source.uploadId ? await deps.uploads.getUpload(source.uploadId) : undefined;
  if (!stored) return notFound("This source has no file of its own");
  const contentType = stored.contentType;
  const safety = assetSafetyHeaders(contentType);
  const pdf = contentType.split(";")[0]!.trim().toLowerCase() === "application/pdf";
  const name = stored.filename ?? source.title;
  // A PDF is drawn by the browser's own viewer, which a sandboxed page cannot open; it runs nothing on this address.
  const { "content-security-policy": csp, "content-disposition": _how, ...rest } = safety;
  return new Response(stored.bytes, {
    status: 200,
    headers: {
      ...rest,
      ...(pdf ? {} : { "content-security-policy": csp! }),
      "content-type": contentType,
      "cache-control": "private, no-store",
      "content-disposition": contentDisposition(pdf || !safety["content-disposition"] ? "inline" : "attachment", name),
    },
  });
}

/**
 * A `Content-Disposition` that carries a file's own name safely: an ASCII
 * `filename` with anything that could end or bend the header replaced, and
 * the whole name in UTF-8 as `filename*` (RFC 6266).
 */
export function contentDisposition(how: "inline" | "attachment", name: string): string {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "file";
  const ascii = trimmed.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  const encoded = encodeURIComponent(trimmed).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${how}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Renames a source; `null` clears its title (`PATCH /v1/sources/:id`). */
export async function renameSource(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await liveSource(request, id, deps);
  if ("response" in owned) return owned.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => {
    if (!("title" in read.body)) throw new FieldError("title is required; null clears it");
    return clearableText(read.body, "title", MAX_TITLE)!;
  });
  if ("response" in fields) return fields.response;
  const renamed = (await deps.repos.sources.rename(id, fields.value))!;
  return json({ source: await listedSourceView(deps, renamed) });
}

/**
 * Removes a source from its project or the Inbox (`DELETE /v1/sources/:id`).
 * `deleted` says whether it went for good or is kept hidden because
 * something still points at it; `changedPlanIds` are plans not started yet
 * whose items no longer read it. Removing a removed source checks again.
 */
export async function deleteSource(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const source = await deps.repos.sources.get(id);
  if (!source || source.ownerId !== auth.ownerId) return notFound("Source not found");
  const removal = await removeSource(deps, source);
  return json({ sourceId: id, ...removal });
}

/**
 * Reads a source again whose reading failed (`POST /v1/sources/:id/retry`).
 * The reading is shared by everyone with the same content, so it is read
 * again for all of them.
 */
export async function retrySource(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await liveSource(request, id, deps);
  if ("response" in owned) return owned.response;
  const extraction = await deps.repos.sources.getExtraction(owned.source.contentHash);
  if (extraction?.status === "ready") return errorResponse("source_not_failed", "This source was read; only a source that could not be read is tried again", 409);
  try {
    await deps.sources.ensureExtracted(owned.source, { provider: deps.provider(deps.repos.usage.sink({ ownerId: owned.ownerId })) });
  } catch (error) {
    if (error instanceof ExtractionBusyError) return errorResponse("source_busy", SOURCE_BUSY, 409);
    if (error instanceof SourceInputError) return errorResponse(error.code, error.message, error.status);
    // Failed again: its extraction says why.
    console.warn(`Source ${id}: extraction failed again: ${message(error)}`);
  }
  return json(await sourceView(deps, (await deps.repos.sources.get(id))!));
}

/** The caller's source that has not been removed, or the response to send. */
async function liveSource(request: Request, id: string, deps: EngineDeps): Promise<{ source: Source; ownerId: string } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  const source = await deps.repos.sources.get(id);
  if (!source || source.ownerId !== auth.ownerId || source.removedAt) return { response: notFound("Source not found") };
  return { source, ownerId: auth.ownerId };
}

/** A source as lists show it: no owner or hash, with its extraction's status, access level and, when it failed, why. */
export async function listedSourceView(deps: EngineDeps, source: Source): Promise<Omit<ListedSource, "ownerId" | "contentHash">> {
  const extraction = await deps.repos.sources.getExtraction(source.contentHash);
  const { ownerId: _owner, contentHash: _hash, ...view } = source;
  return {
    ...view,
    status: extraction?.status ?? "pending",
    ...(extraction?.accessLevel ? { accessLevel: extraction.accessLevel } : {}),
    ...(extraction?.status === "failed" && extraction.errorMessage ? { errorMessage: extraction.errorMessage } : {}),
    ...(extraction?.status === "failed" ? { retryable: canReadAgain(source, extraction.errorMessage) } : {}),
    ...withDetail(extraction?.status === "ready" ? sourceDetail(extraction.envelope?.metadata) : undefined),
  };
}

interface SourceView {
  source: Source;
  extraction: Omit<SourceExtraction, "envelope"> & { title?: string; text?: string; limitations?: string[] };
  chunkCount: number;
}

async function sourceView(deps: EngineDeps, source: Source): Promise<SourceView> {
  const extraction = (await deps.repos.sources.getExtraction(source.contentHash))!;
  const chunks = await deps.repos.sources.listChunks(source.contentHash);
  const { envelope, ...rest } = extraction;
  return {
    source,
    extraction: {
      ...rest,
      ...(envelope?.title ? { title: envelope.title } : {}),
      ...(envelope ? { text: envelope.text, limitations: envelope.limitations } : {}),
    },
    chunkCount: chunks.length,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withDetail(detail: SourceDetail | undefined): { detail?: SourceDetail } {
  return detail ? { detail } : {};
}
