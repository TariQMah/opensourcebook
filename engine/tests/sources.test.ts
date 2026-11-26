/**
 * Sources: chunking, "extracted once, cached by hash", and the
 * /v1/sources, /v1/uploads and /v1/assets routes, against SQLite with the
 * real migrations.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { chunkText } from "../src/sources/chunk";
import { PAGE_BREAK } from "../src/types/source";
import { ExtractionBusyError } from "../src/sources/service";
import { CLIENT_TOKEN, FakeExtractor, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { gate } from "./support/job-harness";

describe("chunkText", () => {
  it("keeps short text whole, with its character range", () => {
    expect(chunkText("One paragraph.")).toEqual([{ text: "One paragraph.", locator: { charStart: 0, charEnd: 14 } }]);
  });

  it("packs paragraphs up to the target and never past the maximum", () => {
    const paragraph = "word ".repeat(60).trim(); // 299 chars
    const text = Array(10).fill(paragraph).join("\n\n");
    const chunks = chunkText(text, { targetChars: 600, maxChars: 900 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(900);
      expect(text.slice(chunk.locator!.charStart, chunk.locator!.charEnd)).toBe(chunk.text);
    }
    // Every paragraph lands in exactly one chunk, in order.
    expect(chunks.map((chunk) => chunk.text).join("\n\n")).toBe(text);
  });

  it("cuts an overlong paragraph at sentence ends", () => {
    const text = "This is one sentence. ".repeat(200).trim();
    const chunks = chunkText(text, { targetChars: 500, maxChars: 800 });
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(800);
      expect(chunk.text.endsWith(".")).toBe(true);
    }
  });

  it("returns nothing for blank text", () => {
    expect(chunkText("  \n\n ")).toEqual([]);
  });

  it("gives each chunk its page and never lets one cross a page break", () => {
    const page = (n: number) => `Page ${n} says something. `.repeat(30).trim();
    // Page 3 is empty: its break still counts, so page 4 stays page 4.
    const text = [page(1), page(2), "", page(4)].join(PAGE_BREAK);
    const chunks = chunkText(text, { targetChars: 500, maxChars: 800 });
    expect(new Set(chunks.map((chunk) => chunk.locator!.page))).toEqual(new Set([1, 2, 4]));
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain("\f");
      expect(chunk.text).toContain(`Page ${chunk.locator!.page} says`);
      expect(text.slice(chunk.locator!.charStart, chunk.locator!.charEnd)).toBe(chunk.text);
    }
  });
});

describe("SourceService", () => {
  it("extracts a URL once and shares the result with a second add elsewhere", async () => {
    const engine = createTestEngine();
    const { sources, repos } = engine.deps;
    const project = await repos.projects.create({ ownerId: "owner", title: "Calculus" });

    const first = await sources.add({ ownerId: "owner", url: "https://example.com/a" });
    expect(first.extraction.status).toBe("pending");
    const extracted = await sources.ensureExtracted(first.source);
    expect(extracted.extracted).toBe(true);
    expect(extracted.chunks).toEqual([
      expect.objectContaining({ ord: 0, text: "Text of https://example.com/a", locator: { charStart: 0, charEnd: 29 } }),
    ]);
    expect((await repos.sources.get(first.source.id))?.title).toBe("Title of https://example.com/a");

    const second = await sources.add({ ownerId: "other", projectId: undefined, url: "https://example.com/a" });
    const third = await sources.add({ ownerId: "owner", projectId: project.id, url: "https://example.com/a" });
    expect(second.extraction.status).toBe("ready");
    expect(third.source.id).not.toBe(first.source.id);
    expect(third.source.contentHash).toBe(first.source.contentHash);
    const reused = await sources.ensureExtracted(third.source);
    expect(reused.extracted).toBe(false);
    expect(reused.chunks).toEqual(extracted.chunks);
    expect(engine.extractor.calls).toHaveLength(1);
  });

  it("returns the existing item when the same content is added to the same place", async () => {
    const { sources } = createTestEngine().deps;
    const first = await sources.add({ ownerId: "owner", url: "https://example.com/a" });
    const again = await sources.add({ ownerId: "owner", url: "https://example.com/a" });
    expect(again.existing).toBe(true);
    expect(again.source.id).toBe(first.source.id);
  });

  it("extracts pasted text on the spot, without the extractor", async () => {
    const engine = createTestEngine();
    const added = await engine.deps.sources.add({ ownerId: "owner", text: "  Notes from class.  " });
    expect(added.extraction).toMatchObject({ status: "ready", accessLevel: "full" });
    expect(added.source).toMatchObject({ kind: "text", origin: "paste" });
    expect(added.source.contentHash).toMatch(/^text:[0-9a-f]{64}$/);
    expect(await engine.deps.repos.sources.listChunks(added.source.contentHash)).toHaveLength(1);
    expect(engine.extractor.calls).toHaveLength(0);
  });

  it("hashes uploads by their bytes, so the same file uploaded twice is extracted once", async () => {
    const engine = createTestEngine();
    const bytes = new TextEncoder().encode("same pdf bytes");
    const a = await engine.deps.uploads.putUpload(bytes, "application/pdf", "a.pdf");
    const b = await engine.deps.uploads.putUpload(bytes, "application/pdf", "b.pdf");
    const first = await engine.deps.sources.add({ ownerId: "owner", uploadId: a!.id });
    const second = await engine.deps.sources.add({ ownerId: "other", uploadId: b!.id });
    expect(first.source.kind).toBe("pdf");
    expect(second.source.contentHash).toBe(first.source.contentHash);
    await engine.deps.sources.ensureExtracted(first.source);
    await engine.deps.sources.ensureExtracted(second.source);
    expect(engine.extractor.calls).toHaveLength(1);
    expect(engine.extractor.calls[0].uploadBytes?.contentType).toBe("application/pdf");
  });

  it("keeps a URL and identical pasted text apart", async () => {
    const { sources } = createTestEngine().deps;
    const url = await sources.add({ ownerId: "owner", url: "https://example.com/a" });
    const text = await sources.add({ ownerId: "owner", text: "https://example.com/a" });
    expect(url.source.contentHash).toMatch(/^url:/);
    expect(text.source.contentHash).not.toBe(url.source.contentHash);
  });

  it("lets one caller extract while the other is told to come back", async () => {
    const extractor = new FakeExtractor();
    const engine = createTestEngine({ extractor });
    const held = gate();
    extractor.hold = held.promise;
    const { source } = await engine.deps.sources.add({ ownerId: "owner", url: "https://example.com/slow" });
    const winner = engine.deps.sources.ensureExtracted(source);
    await expect(engine.deps.sources.ensureExtracted(source)).rejects.toBeInstanceOf(ExtractionBusyError);
    held.open();
    await winner;
    expect((await engine.deps.sources.ensureExtracted(source)).extracted).toBe(false);
    expect(extractor.calls).toHaveLength(1);
  });

  it("takes over an extraction abandoned mid-way, and retries a failed one", async () => {
    const engine = createTestEngine();
    const { sources, repos } = engine.deps;
    const { source } = await sources.add({ ownerId: "owner", url: "https://example.com/a" });
    await repos.sources.claimExtraction(source.contentHash, engine.clock.iso());
    engine.clock.advance(11 * 60_000);
    expect((await sources.ensureExtracted(source)).extracted).toBe(true);

    const other = await sources.add({ ownerId: "owner", url: "https://example.com/b" });
    await repos.sources.updateExtraction(other.source.contentHash, { status: "failed", errorMessage: "boom" });
    expect((await sources.ensureExtracted(other.source)).extracted).toBe(true);
    expect(engine.extractor.calls).toHaveLength(2);
  });

  it("refuses requests that are not a source", async () => {
    const { sources } = createTestEngine().deps;
    await expect(sources.add({ ownerId: "o" })).rejects.toMatchObject({ code: "source_required" });
    await expect(sources.add({ ownerId: "o", url: "ftp://example.com" })).rejects.toMatchObject({ code: "invalid_source_url" });
    await expect(sources.add({ ownerId: "o", uploadId: "missing" })).rejects.toMatchObject({ code: "upload_not_found", status: 404 });
    await expect(sources.add({ ownerId: "o", text: "x".repeat(400_001) })).rejects.toMatchObject({ code: "source_too_large" });
  });
});

describe("/v1/sources", () => {
  it("adds a source to the Inbox, extracts it and reads it back", async () => {
    const engine = createTestEngine();
    const created = await handleRequest(authed("/v1/sources", { method: "POST", body: { url: "https://example.com/a" } }), engine.deps);
    expect(created.status).toBe(201);
    const body = await bodyOf(created);
    expect(body.source).toMatchObject({ kind: "web", url: "https://example.com/a", origin: "link", title: "Title of https://example.com/a" });
    expect(body.source.projectId).toBeUndefined();
    expect(body.source.ownerId).toBe(await ownerIdForToken(CLIENT_TOKEN));
    expect(body.extraction).toMatchObject({ status: "ready", accessLevel: "full", text: "Text of https://example.com/a" });
    expect(body.chunkCount).toBe(1);

    const again = await handleRequest(authed("/v1/sources", { method: "POST", body: { url: "https://example.com/a" } }), engine.deps);
    expect(again.status).toBe(200);
    expect((await bodyOf(again)).source.id).toBe(body.source.id);
    expect(engine.extractor.calls).toHaveLength(1);

    const read = await handleRequest(authed(`/v1/sources/${body.source.id}`), engine.deps);
    expect(read.status).toBe(200);
    expect((await bodyOf(read)).source.id).toBe(body.source.id);
  });

  it("reads a quick source in another project while a slow one is still being read, and says the slow one is busy", async () => {
    const extractor = new FakeExtractor();
    const engine = createTestEngine({ extractor });
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    const handbook = await engine.deps.repos.projects.create({ ownerId: owner, title: "Handbook" });
    const other = await engine.deps.repos.projects.create({ ownerId: owner, title: "Other" });
    const slowRead = gate();
    extractor.holdFor["https://example.com/handbook/huge-page"] = slowRead.promise;

    const slow = handleRequest(authed("/v1/sources", { method: "POST", body: { url: "https://example.com/handbook/huge-page", projectId: handbook.id } }), engine.deps);
    const quick = await handleRequest(authed("/v1/sources", { method: "POST", body: { url: "https://example.com/short", projectId: other.id } }), engine.deps);
    expect(quick.status).toBe(201);
    expect((await bodyOf(quick)).extraction).toMatchObject({ status: "ready" });

    const [waiting] = await engine.deps.repos.sources.listByProject(handbook.id);
    expect((await engine.deps.repos.sources.getExtraction(waiting!.contentHash))?.status).toBe("extracting");
    const retried = await handleRequest(authed(`/v1/sources/${waiting!.id}/retry`, { method: "POST" }), engine.deps);
    expect(retried.status).toBe(409);
    expect(await bodyOf(retried)).toMatchObject({ error: "source_busy", message: expect.stringMatching(/^Busy reading this source, please wait\./) });

    slowRead.open();
    expect((await bodyOf(await slow)).extraction).toMatchObject({ status: "ready" });
  });

  it("files a source into a project the caller owns, and refuses anyone else's", async () => {
    const engine = createTestEngine();
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    const mine = await engine.deps.repos.projects.create({ ownerId: owner, title: "Mine" });
    const theirs = await engine.deps.repos.projects.create({ ownerId: "someone-else", title: "Theirs" });
    const filed = await handleRequest(authed("/v1/sources", { method: "POST", body: { text: "Notes", projectId: mine.id } }), engine.deps);
    expect(filed.status).toBe(201);
    expect((await bodyOf(filed)).source.projectId).toBe(mine.id);
    const refused = await handleRequest(authed("/v1/sources", { method: "POST", body: { text: "Notes", projectId: theirs.id } }), engine.deps);
    expect(refused.status).toBe(404);
    expect(await bodyOf(refused)).toMatchObject({ error: "project_not_found" });
  });

  it("answers bad input and bad tokens with August's error shapes", async () => {
    const engine = createTestEngine();
    const empty = await handleRequest(authed("/v1/sources", { method: "POST", body: {} }), engine.deps);
    expect(empty.status).toBe(400);
    expect(await bodyOf(empty)).toMatchObject({ error: "source_required" });
    const noToken = await handleRequest(new Request("https://engine.test/v1/sources", { method: "POST", body: "{}" }), engine.deps);
    expect(noToken.status).toBe(401);
    const wrong = await handleRequest(
      new Request("https://engine.test/v1/sources", { method: "POST", body: "{}", headers: { "x-client-token": "wrong-token-0123456789" } }),
      engine.deps,
    );
    expect(wrong.status).toBe(403);
    const missing = await handleRequest(authed("/v1/sources/nope"), engine.deps);
    expect(missing.status).toBe(404);
  });

  it("adds an uploaded file by its upload id", async () => {
    const engine = createTestEngine();
    const uploaded = await handleRequest(
      authed("/v1/uploads", { method: "POST", body: new TextEncoder().encode("file body"), headers: { "content-type": "text/plain", "x-upload-filename": "n.txt" } }),
      engine.deps,
    );
    expect(uploaded.status).toBe(201);
    const { upload } = await bodyOf(uploaded);
    expect(upload).toMatchObject({ contentType: "text/plain", filename: "n.txt", byteLength: 9 });
    const created = await handleRequest(authed("/v1/sources", { method: "POST", body: { uploadId: upload.id } }), engine.deps);
    expect(created.status).toBe(201);
    expect((await bodyOf(created)).extraction.text).toBe("file body");
  });
});

describe("GET /v1/sources/:id/file", () => {
  async function upload(engine: ReturnType<typeof createTestEngine>, body: Uint8Array, type: string, name: string) {
    const uploaded = await handleRequest(authed("/v1/uploads", { method: "POST", body, headers: { "content-type": type, "x-upload-filename": name } }), engine.deps);
    const { upload: made } = await bodyOf(uploaded);
    const created = await handleRequest(authed("/v1/sources", { method: "POST", body: { uploadId: made.id } }), engine.deps);
    return { uploadId: made.id as string, source: (await bodyOf(created)).source };
  }

  it("serves an uploaded source's own bytes with its type and its name, saved rather than opened when it is not shown in place", async () => {
    const engine = createTestEngine();
    const { source } = await upload(engine, new TextEncoder().encode("file body"), "text/plain", "my notes.txt");
    const file = await handleRequest(authed(`/v1/sources/${source.id}/file`), engine.deps);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("file body");
    expect(file.headers.get("content-type")).toBe("text/plain");
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="my notes.txt"; filename*=UTF-8''my%20notes.txt`);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    expect(file.headers.get("cache-control")).toBe("private, no-store");
  });

  it("opens a PDF in place, and keeps a name that could bend the header safe", async () => {
    const engine = createTestEngine({ extractor: new FakeExtractor() });
    const { source } = await upload(engine, new TextEncoder().encode("%PDF-1.4 x"), "application/pdf", 'Résumé "final"; x.pdf');
    const file = await handleRequest(authed(`/v1/sources/${source.id}/file`), engine.deps);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    const disposition = file.headers.get("content-disposition")!;
    expect(disposition.startsWith('inline; filename="R_sum_ _final__ x.pdf"; ')).toBe(true);
    expect(disposition).toContain(`filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%3B%20x.pdf`);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 for a source with no file of its own, one of someone else's, an unknown one, and one whose file is gone, and asks for the token", async () => {
    const engine = createTestEngine();
    const pasted = (await bodyOf(await handleRequest(authed("/v1/sources", { method: "POST", body: { text: "Pasted words." } }), engine.deps))).source;
    expect((await handleRequest(authed(`/v1/sources/${pasted.id}/file`), engine.deps)).status).toBe(404);
    const { uploadId, source } = await upload(engine, new TextEncoder().encode("mine"), "text/plain", "a.txt");
    const theirs = await engine.deps.repos.sources.create({ ownerId: "client:someone-else", contentHash: (await engine.deps.repos.sources.get(source.id))!.contentHash, kind: "text", uploadId, fileName: "a.txt", origin: "upload" });
    expect((await handleRequest(authed(`/v1/sources/${theirs.id}/file`), engine.deps)).status).toBe(404);
    expect((await handleRequest(authed(`/v1/sources/nope/file`), engine.deps)).status).toBe(404);
    expect((await handleRequest(new Request(`https://engine.test/v1/sources/${source.id}/file`), engine.deps)).status).toBe(401);
    await engine.deps.uploads.deleteUpload(uploadId);
    expect((await handleRequest(authed(`/v1/sources/${source.id}/file`), engine.deps)).status).toBe(404);
  });
});

describe("/v1/uploads and /v1/assets", () => {
  it("refuses an unsupported content type and serves stored assets publicly", async () => {
    const engine = createTestEngine();
    const refused = await handleRequest(
      authed("/v1/uploads", { method: "POST", body: new Uint8Array([1]), headers: { "content-type": "application/x-unknown" } }),
      engine.deps,
    );
    expect(refused.status).toBe(415);

    await engine.bucket.put("assets/abc", new TextEncoder().encode("png"), { httpMetadata: { contentType: "image/png" } });
    const asset = await handleRequest(new Request("https://engine.test/v1/assets/abc"), engine.deps);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("image/png");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await handleRequest(new Request("https://engine.test/v1/assets/none"), engine.deps)).status).toBe(404);
  });

  it("answers 503 on /v1 routes when no database is bound", async () => {
    const response = await handleRequest(authed("/v1/sources", { method: "POST", body: { text: "x" } }), undefined);
    expect(response.status).toBe(503);
  });
});
