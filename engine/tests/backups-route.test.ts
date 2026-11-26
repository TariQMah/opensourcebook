/**
 * Backing up every project and restoring them (backup/backup.ts, routes/backups.ts), over the real routes, SQL and
 * an in-memory bucket: a backup made in one engine restores into a fresh one with everything as it was.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { readZipDirectory, readEntry } from "../src/backup/zip";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { FakeFiles } from "./support/fake-files";

const TEXT = "# Tides\n\nThe Moon's pull raises the sea on the side of the Earth facing it. A second bulge forms on the far side.";
const VIDEO = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
const VIDEO_ID = "a".repeat(64);

function engineHere() {
  const engine = createTestEngine({ localFiles: new FakeFiles() });
  const call = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) =>
    handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) }), engine.deps);
  return { engine, call };
}

async function filled() {
  const t = engineHere();
  const ownerId = await ownerIdForToken(CLIENT_TOKEN);
  const repos = t.engine.deps.repos;
  const { group } = await bodyOf(await t.call("/v1/groups", "POST", { title: "Science" }));
  const { project } = await bodyOf(await t.call("/v1/projects", "POST", { title: "Tides" }));
  await t.call(`/v1/projects/${project.id}`, "PATCH", { groupId: group.id });
  t.engine.clock.advance(1000);
  const { project: other } = await bodyOf(await t.call("/v1/projects", "POST", { title: "Second" }));
  const added = await bodyOf(await t.call("/v1/sources", "POST", { text: TEXT, projectId: project.id }));
  const source = (await repos.sources.get(added.source.id))!;
  const [chunk] = await repos.sources.listChunks(source.contentHash);
  const cite = { sourceId: source.id, spot: "passage", chunkId: chunk!.id, quote: "The Moon's pull raises the sea" };
  const chat = await repos.sessions.create({ ownerId, projectId: project.id, title: "What makes tides" });
  await repos.sessions.append(chat.id, { role: "user", content: { text: "What makes tides?" } });
  await repos.sessions.append(chat.id, { role: "assistant", content: { text: "The Moon pulls the sea.", state: "done", cites: [cite] }, citations: [cite as never] });
  const plan = await repos.plans.create({ ownerId, projectId: project.id, sessionId: chat.id, title: "Tides" });
  const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "video", title: "Tides, drawn" });
  await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
  await t.engine.bucket.put(`assets/${VIDEO_ID}`, VIDEO, { httpMetadata: { contentType: "video/mp4" } });
  await repos.outputs.create({ ownerId, projectId: project.id, nodeId: node.id, type: "video", schemaVersion: 1, title: "Tides, drawn", payload: { url: `/v1/assets/${VIDEO_ID}` }, citations: [cite as never], sources: [{ sourceId: source.id }] });
  await repos.plans.updateNode(node.id, { status: "done" });
  await repos.plans.setStatus(plan.id, "running");
  await repos.plans.setStatus(plan.id, "done");
  // A file of a linked folder is read where it is: the backup keeps its path, never the file.
  await t.engine.db.raw.prepare("UPDATE projects SET folder_path = '/Users/me/Notes' WHERE id = ?").run(other.id);
  return { ...t, ownerId, project, other, source, chat, plan, node };
}

async function backupOf(t: { call: (path: string) => Promise<Response> }): Promise<Uint8Array> {
  const response = await t.call("/v1/backup");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="Open Sourcebook backup \d{4}-\d{2}-\d{2}\.zip"$/);
  return new Uint8Array(await response.arrayBuffer());
}

async function upload(t: ReturnType<typeof engineHere>, zip: Uint8Array) {
  const response = await t.call("/v1/backup/restores", "POST", zip, { "content-type": "application/zip" });
  return { status: response.status, body: await bodyOf(response) };
}

describe("GET /v1/backup", () => {
  it("writes every project, its rows, its kept files and a manifest with a version into one zip", async () => {
    const t = await filled();
    const zip = await backupOf(t);
    const readAt = async (offset: number, length: number) => zip.slice(offset, offset + length);
    const entries = await readZipDirectory(zip.length, readAt);
    expect([...entries.keys()].sort()).toEqual(["files/assets/" + VIDEO_ID, "manifest.json", `projects/${t.other.id}.json`, `projects/${t.project.id}.json`].sort());
    const manifest = JSON.parse(new TextDecoder().decode(await readEntry(entries.get("manifest.json")!, readAt)));
    expect(manifest).toMatchObject({ opensourcebook: "backup", version: 1, groups: [{ title: "Science" }] });
    expect(manifest.projects.map((p: any) => [p.title, p.sources, p.outputs, p.chats])).toEqual([
      ["Tides", 1, 1, 1],
      ["Second", 0, 0, 0],
    ]);
    expect(manifest.projects[1].linkedFolder).toBe("/Users/me/Notes");
    expect(manifest.files[`assets/${VIDEO_ID}`]).toMatchObject({ size: VIDEO.length, contentType: "video/mp4" });
    expect(await readEntry(entries.get(`files/assets/${VIDEO_ID}`)!, readAt)).toEqual(VIDEO);
  });

  it("is only for the engine on the person's own computer", async () => {
    const engine = createTestEngine();
    const response = await handleRequest(authed("/v1/backup"), engine.deps);
    expect(response.status).toBe(501);
    expect((await bodyOf(response)).error).toBe("this_computer_only");
  });
});

describe("restoring a backup", () => {
  it("brings every project back into a fresh engine as it was: sources, chats, plans, made things and their files", async () => {
    const t = await filled();
    const zip = await backupOf(t);
    const fresh = engineHere();
    const started = await upload(fresh, zip);
    expect(started.status).toBe(201);
    expect(started.body.restore.projects.map((p: any) => [p.title, p.here])).toEqual([
      ["Tides", undefined],
      ["Second", undefined],
    ]);
    const done = await bodyOf(await fresh.call(`/v1/backup/restores/${started.body.restore.id}`, "POST", {}));
    expect(done.restored.map((r: any) => [r.title, r.as, r.projectId === r.from])).toEqual([
      ["Tides", "added", true],
      ["Second", "added", true],
    ]);
    const repos = fresh.engine.deps.repos;
    const project = (await repos.projects.get(t.project.id))!;
    expect(project.ownerId).toBe(t.ownerId);
    const groups = await repos.groups.listByOwner(t.ownerId);
    expect(groups.map((g) => g.title)).toEqual(["Science"]);
    expect(project.groupId).toBe(groups[0]!.id);
    expect((await repos.projects.get(t.other.id))!.folder).toBe("/Users/me/Notes");
    const [source] = await repos.sources.listByProject(t.project.id);
    expect((await repos.sources.getExtraction(source!.contentHash))!.envelope!.text).toBe(TEXT);
    const messages = await repos.sessions.listMessages(t.chat.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const [output] = await repos.outputs.listByProject(t.project.id);
    expect(output).toMatchObject({ title: "Tides, drawn", payload: { url: `/v1/assets/${VIDEO_ID}` } });
    expect((await repos.plans.get(t.plan.id))!.status).toBe("done");
    const asset = await fresh.call(`/v1/assets/${VIDEO_ID}`);
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(VIDEO);
    // The file kept while choosing is gone once it is done.
    expect([...fresh.engine.bucket.objects.keys()].some((key) => key.startsWith("restores/"))).toBe(false);
  });

  it("asks about a project that is here already, and keeps both or replaces it only as chosen", async () => {
    const t = await filled();
    const zip = await backupOf(t);
    await t.engine.deps.repos.projects.update(t.project.id, { title: "Tides, changed here" });

    const first = await upload(t, zip);
    expect(first.body.restore.projects[0].here).toEqual({ title: "Tides, changed here" });
    const unasked = await t.call(`/v1/backup/restores/${first.body.restore.id}`, "POST", {});
    expect(unasked.status).toBe(409);
    expect((await bodyOf(unasked)).projects.map((p: any) => p.title)).toEqual(["Tides", "Second"]);
    expect((await t.call(`/v1/backup/restores/${first.body.restore.id}`, "POST", { choices: { [t.project.id]: "merge" } })).status).toBe(400);

    const both = await bodyOf(await t.call(`/v1/backup/restores/${first.body.restore.id}`, "POST", { choices: { [t.project.id]: "keep-both", [t.other.id]: "skip" } }));
    expect(both.skipped).toEqual([{ from: t.other.id, title: "Second" }]);
    const [copy] = both.restored;
    expect(copy).toMatchObject({ title: "Tides (from backup)", as: "copy" });
    expect(copy.projectId).not.toBe(t.project.id);
    const repos = t.engine.deps.repos;
    expect((await repos.projects.get(t.project.id))!.title).toBe("Tides, changed here");
    const [copiedSource] = await repos.sources.listByProject(copy.projectId);
    expect(copiedSource!.id).not.toBe(t.source.id);
    const copiedChats = await repos.sessions.listByProject(copy.projectId);
    expect(copiedChats).toHaveLength(1);
    const [, reply] = await repos.sessions.listMessages(copiedChats[0]!.id);
    // The copy's cite names the copy's source, and the passage already read here.
    const [chunk] = await repos.sources.listChunks(copiedSource!.contentHash);
    expect((reply!.content as any).cites[0]).toMatchObject({ sourceId: copiedSource!.id, chunkId: chunk!.id });
    expect((await repos.projects.listByOwner(t.ownerId, { includeArchived: true })).length).toBe(3);

    const second = await upload(t, zip);
    const replaced = await bodyOf(await t.call(`/v1/backup/restores/${second.body.restore.id}`, "POST", { choices: { [t.project.id]: "replace", [t.other.id]: "skip" } }));
    expect(replaced.restored).toEqual([{ from: t.project.id, projectId: t.project.id, title: "Tides", as: "replaced" }]);
    expect((await repos.projects.get(t.project.id))!.title).toBe("Tides");
    expect(await repos.outputs.latestForNode(t.node.id)).toMatchObject({ title: "Tides, drawn" });
    const asset = await t.call(`/v1/assets/${VIDEO_ID}`);
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(VIDEO);
    // The copy kept before is still there.
    expect(await repos.projects.get(copy.projectId)).toBeDefined();
  });

  it("refuses a file that is not a backup, and a restore that is not there", async () => {
    const t = engineHere();
    const junk = await upload(t, new TextEncoder().encode("not a zip at all, sorry"));
    expect(junk.status).toBe(400);
    expect(junk.body.error).toBe("invalid_backup");
    expect([...t.engine.bucket.objects.keys()].some((key) => key.startsWith("restores/"))).toBe(false);
    expect((await t.call("/v1/backup/restores/nope", "POST", {})).status).toBe(404);
    expect((await t.call("/v1/backup/restores/nope", "DELETE")).status).toBe(404);
  });

  it("can be cancelled, and the file kept meanwhile goes", async () => {
    const t = await filled();
    const started = await upload(t, await backupOf(t));
    const cancelled = await t.call(`/v1/backup/restores/${started.body.restore.id}`, "DELETE");
    expect(await bodyOf(cancelled)).toEqual({ id: started.body.restore.id, cancelled: true });
    expect([...t.engine.bucket.objects.keys()].some((key) => key.startsWith("restores/"))).toBe(false);
  });
});
