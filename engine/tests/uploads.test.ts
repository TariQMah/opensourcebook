import { describe, expect, it } from "vitest";
import {
  contentTypeForName,
  MAX_UPLOAD_BYTES,
  UPLOAD_TYPES,
  UploadStore,
  normalizeUploadContentType,
  sanitizeUploadFilename,
  uploadKeyForId,
} from "../src/uploads";
import { FakeR2Bucket } from "./support/fake-r2";
import { handleRequest } from "../src/index";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

describe("UploadStore", () => {
  it("stores bytes under uploads/<id> and roundtrips them with metadata", async () => {
    const bucket = new FakeR2Bucket();
    const store = new UploadStore(bucket);
    const record = await store.putUpload(new TextEncoder().encode("hello-upload"), "text/plain", "notes.txt");
    expect(record).toBeDefined();
    expect(record!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record!.contentType).toBe("text/plain");
    expect(record!.filename).toBe("notes.txt");
    expect(record!.byteLength).toBe(12);
    expect(Number.isNaN(Date.parse(record!.uploadedAt))).toBe(false);

    const stored = bucket.objects.get(uploadKeyForId(record!.id));
    expect(stored).toBeDefined();
    expect(stored!.httpMetadata?.contentType).toBe("text/plain");
    expect(stored!.customMetadata).toMatchObject({ filename: "notes.txt", byteLength: "12" });

    const fetched = await store.getUpload(record!.id);
    expect(fetched).toBeDefined();
    expect(new TextDecoder().decode(fetched!.bytes)).toBe("hello-upload");
    expect(fetched!.contentType).toBe("text/plain");
    expect(fetched!.filename).toBe("notes.txt");
  });

  it("generates a fresh random id per upload, even for identical bytes", async () => {
    const store = new UploadStore(new FakeR2Bucket());
    const first = await store.putUpload(new TextEncoder().encode("same"), "text/plain");
    const second = await store.putUpload(new TextEncoder().encode("same"), "text/plain");
    expect(first!.id).not.toBe(second!.id);
  });

  it("omits the filename when none is given and resolves undefined for missing ids", async () => {
    const store = new UploadStore(new FakeR2Bucket());
    const record = await store.putUpload(new TextEncoder().encode("x"), "image/png");
    expect(record!.filename).toBeUndefined();
    const fetched = await store.getUpload(record!.id);
    expect(fetched!.filename).toBeUndefined();
    await expect(store.getUpload("missing")).resolves.toBeUndefined();
  });

  it("degrades to undefined when no bucket is bound", async () => {
    const store = new UploadStore();
    await expect(store.putUpload(new TextEncoder().encode("x"), "text/plain")).resolves.toBeUndefined();
    await expect(store.getUpload("anything")).resolves.toBeUndefined();
  });
});

describe("upload header helpers", () => {
  it("accepts the allow-listed types and strips parameters", () => {
    expect(normalizeUploadContentType("application/pdf")).toBe("application/pdf");
    expect(normalizeUploadContentType("Image/PNG")).toBe("image/png");
    expect(normalizeUploadContentType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeUploadContentType("audio/mpeg")).toBe("audio/mpeg");
    expect(normalizeUploadContentType("video/mp4")).toBe("video/mp4");
    expect(normalizeUploadContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(normalizeUploadContentType("application/msword")).toBe("application/msword");
    expect(normalizeUploadContentType("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
    expect(normalizeUploadContentType("application/vnd.ms-powerpoint")).toBe("application/vnd.ms-powerpoint");
  });

  it("rejects missing or unsupported types", () => {
    expect(normalizeUploadContentType(undefined)).toBeUndefined();
    expect(normalizeUploadContentType("")).toBeUndefined();
    expect(normalizeUploadContentType("application/json")).toBeUndefined();
    expect(normalizeUploadContentType("application/octet-stream")).toBeUndefined();
    // Nothing reads a zip, so it is not taken.
    expect(normalizeUploadContentType("application/zip")).toBeUndefined();
    expect(normalizeUploadContentType("image/")).toBeUndefined();
  });

  it("gives a file name's ending its listed type", () => {
    expect(contentTypeForName("notes.MD")).toBe("text/markdown");
    expect(contentTypeForName("deck.pptx")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(contentTypeForName("photo.jpg")).toBe("image/jpeg");
    expect(contentTypeForName("archive.zip")).toBeUndefined();
    expect(contentTypeForName("README")).toBeUndefined();
    expect(contentTypeForName(undefined)).toBeUndefined();
    // Every ending the list names has an exact type that the list takes.
    for (const type of UPLOAD_TYPES) for (const ending of type.extensions) expect(normalizeUploadContentType(contentTypeForName(`a.${ending}`))).toBeDefined();
  });

  it("sanitizes filenames for metadata storage", () => {
    expect(sanitizeUploadFilename(" report final.pdf ")).toBe("report final.pdf");
    expect(sanitizeUploadFilename("a\r\nb.txt")).toBe("a b.txt");
    expect(sanitizeUploadFilename("")).toBeUndefined();
    expect(sanitizeUploadFilename(undefined)).toBeUndefined();
    expect(sanitizeUploadFilename("x".repeat(300))).toHaveLength(256);
  });
});


describe("GET /v1/uploads/types and POST /v1/uploads agree", () => {
  const post = (engine: ReturnType<typeof createTestEngine>, type: string | undefined, name?: string) =>
    handleRequest(authed("/v1/uploads", { method: "POST", body: new Uint8Array([120]), headers: { ...(type === undefined ? {} : { "content-type": type }), ...(name ? { "x-upload-filename": name } : {}) } }), engine.deps);

  it("lists each type with its endings and group, and the 25 MB cap", async () => {
    const engine = createTestEngine();
    const response = await handleRequest(authed("/v1/uploads/types"), engine.deps);
    expect(response.status).toBe(200);
    const body = (await bodyOf(response)) as { maxBytes: number; types: Array<{ contentType: string; extensions: string[]; group: string }> };
    expect(body.maxBytes).toBe(MAX_UPLOAD_BYTES);
    expect(body.types).toEqual(UPLOAD_TYPES.map(({ contentType, extensions, group }) => ({ contentType, extensions, group })));
    expect([...new Set(body.types.map((type) => type.group))]).toEqual(["PDF", "slides", "docs", "spreadsheets", "images", "audio", "video"]);
    expect((await handleRequest(new Request("https://engine.test/v1/uploads/types"), engine.deps)).status).toBe(401);
  });

  it("takes every listed type and ending, case by case, and refuses others with the file's name", async () => {
    const engine = createTestEngine();
    for (const type of UPLOAD_TYPES) {
      const exact = type.contentType.endsWith("/*") ? `${type.contentType.slice(0, -1)}x-sample` : type.contentType;
      expect((await post(engine, exact)).status).toBe(201);
      for (const ending of type.extensions) {
        // A browser that sends no type, or raw bytes, is read by the name.
        expect((await post(engine, "application/octet-stream", `file.${ending}`)).status).toBe(201);
        expect((await post(engine, undefined, `file.${ending}`)).status).toBe(201);
      }
    }
    const refused = await post(engine, "application/zip", "lecture.zip");
    expect(refused.status).toBe(415);
    const body = (await bodyOf(refused)) as { error: string; message: string };
    expect(body.error).toBe("unsupported_media_type");
    expect(body.message).toBe("lecture.zip: Open Sourcebook doesn't read this kind of file. It takes PDF, slides, docs, spreadsheets, images, audio and video.");
    expect((await post(engine, "application/octet-stream", "data.bin")).status).toBe(415);
  });
});
