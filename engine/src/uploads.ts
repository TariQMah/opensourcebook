import type { R2BucketLike } from "./types";

const UPLOAD_KEY_PREFIX = "uploads/";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FILENAME = 256;

/**
 * A kind of file Open Sourcebook takes as an upload: its content type (`image/*` for
 * every type under `image/`), the file name endings it comes with, and the
 * plain word for its group, which is how the adder says what it takes
 * (`GET /v1/uploads/types`). This list is the one `POST /v1/uploads`
 * checks, so what is offered and what is taken never differ.
 */
export interface UploadType {
  contentType: string;
  extensions: string[];
  group: string;
  /**
   * False when a file of this kind in a linked folder is not taken as a source (#71): sound and video are long to
   * read, and a finished video is copied into the linked folder itself.
   */
  inFolder?: false;
}

export const UPLOAD_TYPES: readonly UploadType[] = [
  { contentType: "application/pdf", extensions: ["pdf"], group: "PDF" },
  { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extensions: ["pptx"], group: "slides" },
  { contentType: "application/vnd.ms-powerpoint", extensions: ["ppt"], group: "slides" },
  { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: ["docx"], group: "docs" },
  { contentType: "application/msword", extensions: ["doc"], group: "docs" },
  { contentType: "text/*", extensions: ["txt", "md", "markdown", "csv", "tsv"], group: "docs" },
  { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: ["xlsx"], group: "spreadsheets" },
  { contentType: "application/vnd.ms-excel", extensions: ["xls"], group: "spreadsheets" },
  { contentType: "image/*", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"], group: "images" },
  { contentType: "audio/*", extensions: ["mp3", "m4a", "wav", "aac", "ogg", "flac"], group: "audio", inFolder: false },
  { contentType: "video/*", extensions: ["mp4", "mov", "m4v", "webm"], group: "video", inFolder: false },
];

/** Whether a content type (no parameters, lower case) is one of the list's. */
function listed(value: string): boolean {
  return UPLOAD_TYPES.some((type) => (type.contentType.endsWith("/*") ? value.startsWith(type.contentType.slice(0, -1)) && value.length > type.contentType.length - 1 : value === type.contentType));
}

/**
 * The content type a file name's ending says, when a browser or a server
 * sends none or only `application/octet-stream`: the one listed type with
 * that ending, or undefined. A wildcard type gives no exact one.
 */
export function contentTypeForName(filename: string | undefined): string | undefined {
  const ending = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ending) return undefined;
  const type = UPLOAD_TYPES.find((entry) => entry.extensions.includes(ending));
  if (!type) return undefined;
  if (!type.contentType.endsWith("/*")) return type.contentType;
  return NAMED_TYPES[ending];
}

/**
 * The content type a file in a linked folder is read as, by its name's ending, when it is a kind taken from a folder;
 * undefined for any other file, which a check of the folder leaves alone.
 */
export function folderContentType(filename: string): string | undefined {
  const ending = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const type = ending ? UPLOAD_TYPES.find((entry) => entry.extensions.includes(ending)) : undefined;
  if (!type || type.inFolder === false) return undefined;
  return contentTypeForName(filename) ?? (type.contentType.endsWith("/*") ? undefined : type.contentType);
}

/** Exact types for the endings listed under a wildcard type. */
const NAMED_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
};

export interface UploadRecord {
  id: string;
  contentType: string;
  filename?: string;
  byteLength: number;
  uploadedAt: string;
}

export interface StoredUpload {
  bytes: ArrayBuffer;
  contentType: string;
  filename?: string;
}

/**
 * Client-uploaded file store backed by the assets R2 bucket, keyed under
 * the uploads/ prefix so it never collides with content-addressed asset keys.
 * Unlike assets, upload ids are random (crypto.randomUUID) — uploading the
 * same file twice stores two copies. With no bucket bound every call resolves
 * undefined so the route can answer 503 uploads_disabled.
 */
export class UploadStore {
  constructor(private readonly bucket?: R2BucketLike) {}

  async putUpload(
    bytes: ArrayBuffer | ArrayBufferView,
    contentType: string,
    filename?: string,
  ): Promise<UploadRecord | undefined> {
    if (!this.bucket) return undefined;
    const buffer = toArrayBuffer(bytes);
    const id = crypto.randomUUID();
    const customMetadata: Record<string, string> = { byteLength: String(buffer.byteLength) };
    if (filename) customMetadata.filename = filename;
    await this.bucket.put(uploadKeyForId(id), buffer, {
      httpMetadata: { contentType },
      customMetadata,
    });
    return {
      id,
      contentType,
      ...(filename ? { filename } : {}),
      byteLength: buffer.byteLength,
      uploadedAt: new Date().toISOString(),
    };
  }

  /** Deletes an uploaded file; false when there is no bucket or it cannot delete. */
  async deleteUpload(id: string): Promise<boolean> {
    if (!this.bucket?.delete) return false;
    await this.bucket.delete(uploadKeyForId(id));
    return true;
  }

  async getUpload(id: string): Promise<StoredUpload | undefined> {
    if (!this.bucket) return undefined;
    const object = await this.bucket.get(uploadKeyForId(id));
    if (!object) return undefined;
    const filename = object.customMetadata?.filename;
    return {
      bytes: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
      ...(filename ? { filename } : {}),
    };
  }
}

export function uploadKeyForId(id: string): string {
  return `${UPLOAD_KEY_PREFIX}${id}`;
}

/**
 * Normalizes a content-type header (drops parameters, lowercases) and returns
 * it only when it matches the upload allow-list; otherwise undefined.
 */
export function normalizeUploadContentType(header: string | null | undefined): string | undefined {
  const value = header?.split(";")[0]?.trim().toLowerCase();
  if (!value) return undefined;
  return listed(value) ? value : undefined;
}

/** Trims an x-upload-filename header into a safe metadata string, or undefined when absent/empty. */
export function sanitizeUploadFilename(header: string | null | undefined): string | undefined {
  const value = header?.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_UPLOAD_FILENAME);
  return value ? value : undefined;
}

function toArrayBuffer(bytes: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
