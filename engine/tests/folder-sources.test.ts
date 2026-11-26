/**
 * A project linked to a folder on this computer (#71, src/sources/folder.ts): its files become sources read where
 * they are, a check picks up what was added, changed and removed, and a cite of a passage that changed says so.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { FakeFiles } from "./support/fake-files";

const FOLDER = "/Users/me/Course";

async function setup(options: { files?: boolean } = {}) {
  const files = new FakeFiles();
  const engine = createTestEngine(options.files === false ? {} : { localFiles: files });
  const call = (path: string, method = "GET", body?: unknown) => handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
  const { project } = await bodyOf(await call("/v1/projects", "POST", { title: "Cells" }));
  const sources = async () => (await bodyOf(await call(`/v1/projects/${project.id}/sources`))).sources as Array<Record<string, any>>;
  return { engine, files, call, project, sources };
}

describe("a project linked to a folder", () => {
  it("takes the folder's files as sources where they are, never copied, and leaves sound, video and empty files alone", async () => {
    const t = await setup();
    t.files.put(FOLDER, "notes.md", "# Cells\n\nA cell is the smallest unit of life.");
    t.files.put(FOLDER, "week 2/reading.txt", "Mitochondria make energy.");
    t.files.put(FOLDER, "Cells.mp4", "a video");
    t.files.put(FOLDER, "empty.txt", "");
    const linked = await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", { path: FOLDER });
    expect(linked.status).toBe(200);
    const body = await bodyOf(linked);
    expect(body.project.folder).toBe(FOLDER);
    expect(body.project.folderCheckedAt).toBeTruthy();
    expect(body.check).toMatchObject({ folder: FOLDER, added: ["notes.md", "week 2/reading.txt"], changed: [], missing: [], unchanged: 0, skipped: 2, failed: [] });

    const sources = await t.sources();
    expect(sources.map((s) => s.filePath).sort()).toEqual([`${FOLDER}/notes.md`, `${FOLDER}/week 2/reading.txt`]);
    expect(sources.every((s) => s.origin === "folder" && s.status === "ready" && !s.uploadId)).toBe(true);
    expect([...t.engine.bucket.objects.keys()].filter((key) => key.startsWith("uploads/"))).toEqual([]);
    const notes = sources.find((s) => s.filePath.endsWith("notes.md"))!;
    const read = await bodyOf(await t.call(`/v1/sources/${notes.id}`));
    expect(read.extraction.text).toContain("smallest unit of life");
  });

  it("a check with nothing changed reads nothing; a changed file is read again, a removed one is marked missing, not deleted", async () => {
    const t = await setup();
    t.files.put(FOLDER, "a.md", "First text of a.");
    t.files.put(FOLDER, "b.md", "Text of b.");
    await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", { path: FOLDER });
    const reads = t.files.reads.length;

    const same = await bodyOf(await t.call(`/v1/projects/${t.project.id}/folder/check`, "POST"));
    expect(same.check).toMatchObject({ added: [], changed: [], missing: [], unchanged: 2 });
    expect(t.files.reads.length).toBe(reads);

    const a = (await t.sources()).find((s) => s.filePath.endsWith("a.md"))!;
    const oldChunks = await t.engine.deps.repos.sources.listChunks((await t.engine.deps.repos.sources.get(a.id))!.contentHash);
    t.files.put(FOLDER, "a.md", "Second text of a, changed.");
    t.files.remove(FOLDER, "b.md");
    t.files.put(FOLDER, "c.txt", "New file c.");
    const again = await bodyOf(await t.call(`/v1/projects/${t.project.id}/folder/check`, "POST"));
    expect(again.check).toMatchObject({ added: ["c.txt"], changed: ["a.md"], missing: ["b.md"], unchanged: 0 });

    const after = await t.sources();
    expect(after).toHaveLength(3);
    const changed = after.find((s) => s.id === a.id)!;
    expect(changed.changedAt).toBeTruthy();
    expect((await bodyOf(await t.call(`/v1/sources/${a.id}`))).extraction.text).toBe("Second text of a, changed.");
    expect(after.find((s) => s.filePath.endsWith("b.md"))!.missingAt).toBeTruthy();

    // A cite made from the old text still opens it, and says its passage has changed.
    const changedChunks = await t.engine.deps.repos.sources.changedChunks(oldChunks.map((chunk) => ({ sourceId: a.id, chunkId: chunk.id })));
    expect([...changedChunks]).toEqual(oldChunks.map((chunk) => chunk.id));

    // The file comes back: it is not missing any more, and nothing is read when it holds what it did.
    t.files.put(FOLDER, "b.md", "Text of b.");
    const back = await bodyOf(await t.call(`/v1/projects/${t.project.id}/folder/check`, "POST"));
    expect(back.check).toMatchObject({ added: [], changed: [], missing: [] });
    expect((await t.sources()).find((s) => s.filePath.endsWith("b.md"))!.missingAt).toBeUndefined();
  });

  it("a made thing's cites of a passage that changed in its file say so", async () => {
    const t = await setup();
    t.files.put(FOLDER, "a.md", "Old words.");
    await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", { path: FOLDER });
    const [a] = await t.sources();
    const repos = t.engine.deps.repos;
    const [chunk] = await repos.sources.listChunks((await repos.sources.get(a!.id))!.contentHash);
    const output = await repos.outputs.create({
      ownerId: await ownerIdForToken(CLIENT_TOKEN),
      projectId: t.project.id,
      type: "flashcards",
      schemaVersion: 1,
      title: "Cards",
      summary: "",
      payload: {},
      citations: [{ sourceId: a!.id, chunkId: chunk!.id, quote: "Old words." }],
      sources: [{ sourceId: a!.id }],
    });
    const before = await bodyOf(await t.call(`/v1/outputs/${output.id}`));
    expect(before.output.changedChunks).toBeUndefined();
    t.files.put(FOLDER, "a.md", "New words.");
    await t.call(`/v1/projects/${t.project.id}/folder/check`, "POST");
    const after = await bodyOf(await t.call(`/v1/outputs/${output.id}`));
    expect(after.output.changedChunks).toEqual([chunk!.id]);
    expect(after.output.citations[0]).toMatchObject({ chunkId: chunk!.id, changed: true });
  });

  it("a file the person removed from the project is not added back by a check", async () => {
    const t = await setup();
    t.files.put(FOLDER, "a.md", "Text of a.");
    await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", { path: FOLDER });
    const [a] = await t.sources();
    const removed = await bodyOf(await t.call(`/v1/sources/${a!.id}`, "DELETE"));
    expect(removed.deleted).toBe(false);
    t.files.put(FOLDER, "a.md", "Text of a, changed.");
    const check = await bodyOf(await t.call(`/v1/projects/${t.project.id}/folder/check`, "POST"));
    expect(check.check).toMatchObject({ added: [], changed: [] });
    expect(await t.sources()).toHaveLength(0);
  });

  it("unlinking keeps the sources; a folder that is not there, or no folder, is said plainly", async () => {
    const t = await setup();
    const gone = await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", { path: "/Users/me/Nowhere" });
    expect(gone.status).toBe(404);
    expect((await bodyOf(gone)).error).toBe("no_folder");
    expect((await t.call(`/v1/projects/${t.project.id}/folder/check`, "POST")).status).toBe(409);
    expect((await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", {})).status).toBe(400);

    t.files.put(FOLDER, "a.md", "Text of a.");
    await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", { path: FOLDER });
    const unlinked = await bodyOf(await t.call(`/v1/projects/${t.project.id}/folder`, "DELETE"));
    expect(unlinked.project.folder).toBeUndefined();
    expect(await t.sources()).toHaveLength(1);
  });

  it("is only for an engine on the person's own computer", async () => {
    const t = await setup({ files: false });
    const response = await t.call(`/v1/projects/${t.project.id}/folder`, "PUT", { path: FOLDER });
    expect(response.status).toBe(501);
    expect((await bodyOf(response)).error).toBe("this_computer_only");
    expect((await t.call("/v1/library")).status).toBe(501);
  });
});

describe("the library", () => {
  it("is the usual folder until one is picked, and goes back to it", async () => {
    const t = await setup();
    expect((await bodyOf(await t.call("/v1/library"))).library).toEqual({ folder: "/Users/me/Documents/Open Sourcebook", chosen: false });
    expect((await bodyOf(await t.call("/v1/library", "PUT", { folder: "/Users/me/Videos" }))).library).toEqual({ folder: "/Users/me/Videos", chosen: true });
    expect((await t.call("/v1/library", "PUT", { folder: "Videos" })).status).toBe(400);
    expect((await t.call("/v1/library", "PUT", {})).status).toBe(400);
    expect((await bodyOf(await t.call("/v1/library", "PUT", { folder: null }))).library.chosen).toBe(false);
  });
});

