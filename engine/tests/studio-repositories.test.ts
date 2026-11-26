/**
 * Studio repositories against SQLite with every migration file applied, so
 * the SQL, the foreign keys and the unique constraints are the real ones.
 */
import { describe, expect, it } from "vitest";
import { safeRecord } from "../src/providers/usage";
import { createDefaultRegistry } from "../src/studio/default-registry";
import {
  InvalidRecordError,
  PlanLockedError,
  createStudioRepositories,
  type StudioRepositories,
} from "../src/studio/repositories";
import type { SourceEnvelope } from "../src/types";
import { createSqliteD1, migrationFiles, type SqliteD1 } from "./support/sqlite-d1";

function setup(): { db: SqliteD1; repos: StudioRepositories; tick(): void } {
  const db = createSqliteD1();
  let ms = Date.parse("2026-11-10T09:00:00.000Z");
  let id = 0;
  const repos = createStudioRepositories(db, {
    now: () => new Date(ms).toISOString(),
    newId: () => `id-${String(++id).padStart(3, "0")}`,
  });
  return { db, repos, tick: () => void (ms += 1_000) };
}

const envelope: SourceEnvelope = {
  originalText: "",
  originalURL: "https://example.com/paper.pdf",
  kind: "pdf",
  title: "A paper",
  text: "Page one. Page two.",
  references: [{ url: "https://example.com/paper.pdf", label: "source" }],
  metadata: {},
  accessLevel: "full",
  depthCap: "deep",
  limitations: [],
  fetchedAt: "2026-11-10T09:00:00.000Z",
};

async function projectWithSource(repos: StudioRepositories, ownerId = "owner") {
  const project = await repos.projects.create({ ownerId, title: "Calculus" });
  await repos.sources.ensureExtraction("hash-1", "pdf");
  const source = await repos.sources.create({ ownerId, projectId: project.id, contentHash: "hash-1", kind: "pdf", title: "A paper", origin: "upload" });
  return { project, source };
}

describe("migrations", () => {
  it("apply in order on one database, ending with the Studio schema", () => {
    expect(migrationFiles()).toEqual([
      "0001_create_jobs.sql",
      "0002_create_assets.sql",
      "0003_generation_jobs.sql",
      "0004_studio.sql",
      "0005_plan_stages_item_results.sql",
      "0006_plan_budget.sql",
      "0007_chat_turns.sql",
      "0008_usage_error.sql",
      "0009_source_removed.sql",
      "0010_agent_turns.sql",
      "0011_source_file_name.sql",
      "0012_agent_turn_draft.sql",
      "0013_provider_settings.sql",
      "0014_provider_added_favorites.sql",
      "0015_item_progress.sql",
      "0016_plan_direct.sql",
      "0017_plan_stage_dates.sql",
      "0018_agent_picks.sql",
      "0019_agent_picks_off.sql",
      "0020_make_times.sql",
      "0021_owner_settings.sql",
      "0022_agent_turn_pick.sql",
      "0023_folder_sources.sql",
      "0024_project_groups.sql",
    ]);
    const { db } = setup();
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(tables).toEqual([
      "agent_picks",
      "agent_steps",
      "agent_turns",
      "assets",
      "generation_jobs",
      "item_results",
      "jobs",
      "make_times",
      "messages",
      "outputs",
      "owner_settings",
      "plan_edges",
      "plan_node_sources",
      "plan_nodes",
      "plan_stage_dates",
      "plan_stages",
      "plans",
      "project_groups",
      "projects",
      "provider_settings",
      "sessions",
      "source_chunks",
      "source_extractions",
      "sources",
      "usage",
    ]);
  });
});

describe("provider settings", () => {
  it("has no row until something changes, then keeps what was not sent", async () => {
    const { repos } = setup();
    expect(await repos.providerSettings.list("o")).toEqual([]);
    expect(await repos.providerSettings.update("o", "claude", { hiddenModels: ["opus", "opus"] })).toMatchObject({ enabled: true, hiddenModels: ["opus"] });
    expect(await repos.providerSettings.update("o", "claude", { enabled: false })).toMatchObject({ enabled: false, hiddenModels: ["opus"] });
    expect((await repos.providerSettings.get("o", "claude"))?.added).toBeUndefined();
    expect(await repos.providerSettings.update("o", "claude", { added: false, favoriteModels: ["sonnet", "sonnet"] })).toMatchObject({ added: false, enabled: false, favoriteModels: ["sonnet"] });
    expect(await repos.providerSettings.get("o", "claude")).toMatchObject({ added: false, hiddenModels: ["opus"], favoriteModels: ["sonnet"] });
    expect((await repos.providerSettings.list("o")).map((row) => row.providerId)).toEqual(["claude"]);
    expect(await repos.providerSettings.list("other")).toEqual([]);
  });
});

describe("projects", () => {
  it("creates, reads, updates and archives, newest first", async () => {
    const { repos, tick } = setup();
    const first = await repos.projects.create({ ownerId: "o", title: "First", settings: { tone: "plain" } });
    tick();
    const second = await repos.projects.create({ ownerId: "o", title: "Second", icon: "book", colorHex: 0xff8800 });
    await repos.projects.create({ ownerId: "other", title: "Not mine" });
    expect(first).toEqual({
      id: first.id,
      ownerId: "o",
      title: "First",
      settings: { tone: "plain" },
      createdAt: "2026-11-10T09:00:00.000Z",
      updatedAt: "2026-11-10T09:00:00.000Z",
    });
    expect(second).toMatchObject({ icon: "book", colorHex: 0xff8800 });
    expect((await repos.projects.listByOwner("o")).map((project) => project.title)).toEqual(["Second", "First"]);

    tick();
    const updated = await repos.projects.update(first.id, { title: "Renamed", category: "Math", icon: null });
    expect(updated).toMatchObject({ title: "Renamed", category: "Math", updatedAt: "2026-11-10T09:00:02.000Z" });
    expect(updated?.icon).toBeUndefined();

    await repos.projects.archive(second.id);
    expect((await repos.projects.listByOwner("o")).map((project) => project.title)).toEqual(["Renamed"]);
    expect(await repos.projects.listByOwner("o", { includeArchived: true })).toHaveLength(2);
  });

  it("deleting a project sends its sources to the Inbox and removes its chats and plans", async () => {
    const { repos } = setup();
    const { project, source } = await projectWithSource(repos, "o");
    const session = await repos.sessions.create({ ownerId: "o", projectId: project.id });
    const plan = await repos.plans.create({ ownerId: "o", projectId: project.id, sessionId: session.id });
    const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "bits", title: "Intro" });
    const output = await repos.outputs.create({ ownerId: "o", projectId: project.id, nodeId: node.id, type: "bits", schemaVersion: 1, title: "Intro", payload: {} });

    await repos.projects.delete(project.id);

    expect(await repos.sources.get(source.id)).toMatchObject({ id: source.id });
    expect((await repos.sources.get(source.id))?.projectId).toBeUndefined();
    expect((await repos.sources.listInbox("o")).map((entry) => entry.id)).toEqual([source.id]);
    expect(await repos.sessions.get(session.id)).toBeUndefined();
    expect(await repos.plans.get(plan.id)).toBeUndefined();
    expect(await repos.plans.getNode(node.id)).toBeUndefined();
    // An output outlives its plan as a Library item.
    const kept = await repos.outputs.get(output.id);
    expect(kept).toMatchObject({ id: output.id, type: "bits" });
    expect(kept?.projectId).toBeUndefined();
    expect(kept?.nodeId).toBeUndefined();
  });
});

describe("sources", () => {
  it("extracts once per content hash: the second caller reuses the row", async () => {
    const { repos } = setup();
    const a = await repos.sources.ensureExtraction("sha-abc", "pdf");
    const b = await repos.sources.ensureExtraction("sha-abc", "pdf");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.extraction).toEqual(a.extraction);
    expect(a.extraction).toMatchObject({ contentHash: "sha-abc", kind: "pdf", status: "pending" });
  });

  it("stores the envelope and access level when extraction is ready", async () => {
    const { repos } = setup();
    await repos.sources.ensureExtraction("sha-abc", "pdf");
    await repos.sources.updateExtraction("sha-abc", { status: "extracting" });
    const ready = await repos.sources.updateExtraction("sha-abc", { status: "ready", accessLevel: "full", envelope });
    expect(ready).toMatchObject({ status: "ready", accessLevel: "full", envelope });
    const failed = await repos.sources.updateExtraction("sha-abc", { status: "failed", errorMessage: "timeout", envelope: null });
    expect(failed?.envelope).toBeUndefined();
    expect(failed?.errorMessage).toBe("timeout");
    await expect(repos.sources.updateExtraction("sha-abc", { status: "done" as never })).rejects.toBeInstanceOf(InvalidRecordError);
  });

  it("replaces chunks in order with their locators", async () => {
    const { repos } = setup();
    await repos.sources.ensureExtraction("sha-abc", "pdf");
    await repos.sources.replaceChunks("sha-abc", [
      { text: "old", locator: { page: 9 } },
    ]);
    const chunks = await repos.sources.replaceChunks("sha-abc", [
      { text: "Page one.", locator: { page: 1, charStart: 0, charEnd: 9 } },
      { text: "Page two.", locator: { page: 2 } },
      { text: "No locator." },
    ]);
    expect(chunks.map(({ ord, text, locator }) => ({ ord, text, locator }))).toEqual([
      { ord: 0, text: "Page one.", locator: { page: 1, charStart: 0, charEnd: 9 } },
      { ord: 1, text: "Page two.", locator: { page: 2 } },
      { ord: 2, text: "No locator.", locator: undefined },
    ]);
    expect(await repos.sources.listChunks("sha-abc")).toHaveLength(3);
  });

  it("stores hundreds of chunks a few statements at a time, in order", async () => {
    const { db, repos } = setup();
    await repos.sources.ensureExtraction("sha-long", "pdf");
    const bound: number[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        bound.push(values.length);
        return bind(...values);
      };
      return statement;
    };
    const many = Array.from({ length: 350 }, (_, n) => ({ text: `Chunk ${n}.`, locator: { charStart: n * 10, charEnd: n * 10 + 9 } }));
    const chunks = await repos.sources.replaceChunks("sha-long", many);
    expect(chunks.map((chunk) => chunk.text)).toEqual(many.map((chunk) => chunk.text));
    expect(chunks.map((chunk) => chunk.ord)).toEqual(many.map((_, n) => n));
    // D1 allows 100 bound parameters per statement.
    expect(Math.max(...bound)).toBeLessThanOrEqual(100);
    expect(bound.length).toBeLessThan(40);
  });

  it("never stores pasted text twice, and reads it back whole", async () => {
    const { db, repos } = setup();
    await repos.sources.ensureExtraction("text:abc", "text");
    const text = "長い文章。".repeat(80_000);
    const pasted = { ...envelope, originalText: text, text };
    const ready = await repos.sources.updateExtraction("text:abc", { status: "ready", envelope: pasted });
    expect(ready?.envelope).toEqual(pasted);
    const row = await db.prepare("SELECT envelope_json FROM source_extractions WHERE content_hash = ?").bind("text:abc").first<{ envelope_json: string }>();
    // 400,000 characters of three-byte text stay well inside D1's 2 MB row.
    expect(new TextEncoder().encode(row!.envelope_json).length).toBeLessThan(1_300_000);
  });

  it("rolls back a chunk replacement that fails halfway", async () => {
    const { db, repos } = setup();
    await repos.sources.ensureExtraction("sha-abc", "pdf");
    await repos.sources.replaceChunks("sha-abc", [{ text: "kept" }]);
    // Two chunks with the same id violate the primary key on the second insert.
    const sameId = createStudioRepositories(db, { newId: () => "dup" });
    await expect(sameId.sources.replaceChunks("sha-abc", [{ text: "a" }, { text: "b" }])).rejects.toThrow(/UNIQUE|PRIMARY/i);
    expect((await repos.sources.listChunks("sha-abc")).map((chunk) => chunk.text)).toEqual(["kept"]);
  });

  it("needs the extraction to exist, and keeps it when a source is deleted", async () => {
    const { repos } = setup();
    await expect(repos.sources.create({ ownerId: "o", contentHash: "missing", kind: "pdf" })).rejects.toThrow(/FOREIGN KEY/i);
    await repos.sources.ensureExtraction("sha-abc", "pdf");
    const inbox = await repos.sources.create({ ownerId: "o", contentHash: "sha-abc", kind: "pdf", url: "https://example.com/paper.pdf", origin: "link" });
    expect(inbox.projectId).toBeUndefined();
    expect(await repos.sources.findByHash("o", "sha-abc")).toEqual([inbox]);
    await repos.sources.delete(inbox.id);
    expect(await repos.sources.getExtraction("sha-abc")).toBeDefined();
    await expect(repos.sources.create({ ownerId: "o", contentHash: "sha-abc", kind: "pdf", origin: "carrier-pigeon" as never })).rejects.toBeInstanceOf(
      InvalidRecordError,
    );
  });

  it("moves a source between the Inbox and projects", async () => {
    const { repos } = setup();
    const { project, source } = await projectWithSource(repos, "o");
    expect((await repos.sources.listByProject(project.id)).map((entry) => entry.id)).toEqual([source.id]);
    await repos.sources.moveToProject(source.id, null);
    expect(await repos.sources.listByProject(project.id)).toEqual([]);
    expect((await repos.sources.listInbox("o")).map((entry) => entry.id)).toEqual([source.id]);
    expect((await repos.sources.rename(source.id, "Renamed"))?.title).toBe("Renamed");
  });
});

describe("sessions and messages", () => {
  it("appends messages at increasing positions and lists them in order", async () => {
    const { repos, tick } = setup();
    const session = await repos.sessions.create({ ownerId: "o", title: "Chat" });
    const first = await repos.sessions.append(session.id, { role: "user", content: { text: "Explain @limits" }, mentions: [{ kind: "output", id: "out-1" }] });
    tick();
    const second = await repos.sessions.append(session.id, {
      role: "assistant",
      content: { text: "A limit is..." },
      citations: [{ sourceId: "src-1", chunkId: "c1", locator: { page: 3 } }],
    });
    expect([first.seq, second.seq]).toEqual([0, 1]);
    expect(first.mentions).toEqual([{ kind: "output", id: "out-1" }]);
    expect(second.citations).toEqual([{ sourceId: "src-1", chunkId: "c1", locator: { page: 3 } }]);
    expect((await repos.sessions.listMessages(session.id)).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect((await repos.sessions.listMessages(session.id, { afterSeq: 0 })).map((message) => message.seq)).toEqual([1]);
    expect((await repos.sessions.get(session.id))?.updatedAt).toBe("2026-11-10T09:00:01.000Z");
    await expect(repos.sessions.append(session.id, { role: "robot" as never, content: "" })).rejects.toBeInstanceOf(InvalidRecordError);
  });

  it("gives concurrent appends consecutive, unique positions", async () => {
    const { repos } = setup();
    const session = await repos.sessions.create({ ownerId: "o" });
    const appended = await Promise.all(
      Array.from({ length: 5 }, (_, index) => repos.sessions.append(session.id, { role: "user", content: `m${index}` })),
    );
    expect(appended.map((message) => message.seq).sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("removes messages with their session and lists a project's chats", async () => {
    const { db, repos } = setup();
    const project = await repos.projects.create({ ownerId: "o", title: "P" });
    const session = await repos.sessions.create({ ownerId: "o", projectId: project.id, settings: { ticked: ["src-1"] } });
    await repos.sessions.append(session.id, { role: "user", content: "hi" });
    expect((await repos.sessions.listByProject(project.id)).map((entry) => entry.settings)).toEqual([{ ticked: ["src-1"] }]);
    expect((await repos.sessions.update(session.id, { title: "Named" }))?.title).toBe("Named");
    await repos.sessions.delete(session.id);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  it("lets one turn at a time hold a chat, and a stale turn be taken over", async () => {
    const { repos, tick } = setup();
    const session = await repos.sessions.create({ ownerId: "o" });
    expect(await repos.sessions.claimTurn(session.id, "2026-11-10T08:55:00.000Z")).toBe(true);
    expect((await repos.sessions.get(session.id))?.busySince).toBe("2026-11-10T09:00:00.000Z");
    expect(await repos.sessions.claimTurn(session.id, "2026-11-10T08:55:00.000Z")).toBe(false);
    tick();
    // A mark from before `staleBefore` is a turn that died; the next one takes it.
    expect(await repos.sessions.claimTurn(session.id, "2026-11-10T09:00:00.500Z")).toBe(true);
    await repos.sessions.releaseTurn(session.id);
    expect((await repos.sessions.get(session.id))?.busySince).toBeUndefined();
  });

  it("counts messages per chat and gives the last few in order", async () => {
    const { repos } = setup();
    const a = await repos.sessions.create({ ownerId: "o" });
    const b = await repos.sessions.create({ ownerId: "o" });
    for (const text of ["one", "two", "three"]) await repos.sessions.append(a.id, { role: "user", content: text });
    expect(await repos.sessions.countMessages([a.id, b.id])).toEqual(new Map([[a.id, 3]]));
    expect((await repos.sessions.recentMessages(a.id, 2)).map((message) => message.content)).toEqual(["two", "three"]);
  });
});

describe("plans", () => {
  it("lists the plans a chat made, newest first", async () => {
    const { repos, tick } = setup();
    const project = await repos.projects.create({ ownerId: "o", title: "P" });
    const chat = await repos.sessions.create({ ownerId: "o", projectId: project.id });
    const older = await repos.plans.create({ ownerId: "o", projectId: project.id, sessionId: chat.id });
    tick();
    const newer = await repos.plans.create({ ownerId: "o", projectId: project.id, sessionId: chat.id });
    await repos.plans.create({ ownerId: "o", projectId: project.id });
    expect((await repos.plans.listBySession(chat.id)).map((plan) => plan.id)).toEqual([newer.id, older.id]);
  });

  it("stores nodes by level and position, with branches, sources and edges", async () => {
    const { repos, tick } = setup();
    const { project, source } = await projectWithSource(repos);
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id, title: "Week 1" });
    expect(plan).toMatchObject({ version: 1, status: "draft", title: "Week 1" });

    const check = await repos.plans.addNode({ planId: plan.id, level: 1, ord: 0, type: "quiz", title: "Check", settings: { questions: 5 } });
    const intro = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 1, type: "video", title: "Intro", prompt: "Open with the picture." });
    const read = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "read", title: "Read", estCostUsd: 0.04 });
    const fix = await repos.plans.addNode({
      planId: plan.id,
      parentId: check.id,
      level: 2,
      ord: 0,
      type: "bits",
      title: "Fix",
      condition: { scoreBelow: 0.7 },
      enabled: false,
    });

    expect((await repos.plans.listNodes(plan.id)).map((node) => node.title)).toEqual(["Read", "Intro", "Check", "Fix"]);
    expect(fix).toMatchObject({ parentId: check.id, condition: { scoreBelow: 0.7 }, enabled: false, status: "pending" });
    expect(intro).toMatchObject({ prompt: "Open with the picture.", settings: {} });
    expect(read.estCostUsd).toBe(0.04);

    await repos.plans.setNodeSources(read.id, [{ sourceId: source.id, range: { page: 3 } }]);
    expect(await repos.plans.listNodeSources(read.id)).toEqual([{ nodeId: read.id, sourceId: source.id, range: { page: 3 } }]);
    await repos.plans.setNodeSources(read.id, [{ sourceId: source.id }]);
    expect(await repos.plans.listNodeSources(read.id)).toEqual([{ nodeId: read.id, sourceId: source.id }]);
    tick();
    await repos.plans.setNodeSources(read.id, [{ sourceId: source.id }]);
    // Changing an item's sources is an edit of the item.
    expect((await repos.plans.getNode(read.id))?.updatedAt).toBe("2026-11-10T09:00:01.000Z");

    await repos.plans.addEdge({ fromNode: intro.id, toNode: check.id, kind: "assumes" });
    await repos.plans.addEdge({ fromNode: check.id, toNode: fix.id, kind: "fix_of" });
    await repos.plans.addEdge({ fromNode: check.id, toNode: fix.id, kind: "fix_of" });
    expect(await repos.plans.listEdges(plan.id)).toEqual(
      expect.arrayContaining([
        { fromNode: intro.id, toNode: check.id, kind: "assumes" },
        { fromNode: check.id, toNode: fix.id, kind: "fix_of" },
      ]),
    );
    expect(await repos.plans.listEdges(plan.id)).toHaveLength(2);
    await repos.plans.removeEdge({ fromNode: intro.id, toNode: check.id, kind: "assumes" });
    expect(await repos.plans.listEdges(plan.id)).toHaveLength(1);

    // Deleting the parent removes its branch, and with it the edge.
    await repos.plans.deleteNode(check.id);
    expect((await repos.plans.listNodes(plan.id)).map((node) => node.title)).toEqual(["Read", "Intro"]);
    expect(await repos.plans.listEdges(plan.id)).toEqual([]);
  });

  it("rejects nodes and edges the plan graph does not allow", async () => {
    const { repos } = setup();
    const { project } = await projectWithSource(repos);
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id });
    const other = await repos.plans.create({ ownerId: "owner", projectId: project.id });
    const base = { planId: plan.id, level: 0, ord: 0, title: "N" };
    await expect(repos.plans.addNode({ ...base, type: "not an id" })).rejects.toThrow(/not a format id/);
    await expect(repos.plans.addNode({ ...base, type: "bits", level: -1 })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repos.plans.addNode({ ...base, type: "bits", title: "  " })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repos.plans.addNode({ ...base, planId: "no-plan", type: "bits" })).rejects.toThrow(/FOREIGN KEY/i);

    const a = await repos.plans.addNode({ ...base, type: "bits" });
    const b = await repos.plans.addNode({ ...base, planId: other.id, type: "bits" });
    await expect(repos.plans.addEdge({ fromNode: a.id, toNode: a.id, kind: "assumes" })).rejects.toThrow(/itself/);
    await expect(repos.plans.addEdge({ fromNode: a.id, toNode: b.id, kind: "assumes" })).rejects.toThrow(/one plan/);
    await expect(repos.plans.addEdge({ fromNode: a.id, toNode: b.id, kind: "not a kind" })).rejects.toThrow(/not an edge kind/);
  });

  it("takes any edge kind of the right shape and reads back whatever kind is stored", async () => {
    const { db, repos } = setup();
    const { project } = await projectWithSource(repos);
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id });
    const a = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "quiz", title: "A" });
    const b = await repos.plans.addNode({ planId: plan.id, level: 1, ord: 0, type: "bits", title: "B" });
    await repos.plans.addEdge({ fromNode: a.id, toNode: b.id, kind: "buildsOn" });
    db.raw.prepare("INSERT INTO plan_edges (from_node, to_node, kind) VALUES (?, ?, ?)").run(a.id, b.id, "Old Kind!");
    expect(await repos.plans.listEdges(plan.id)).toEqual([
      { fromNode: a.id, toNode: b.id, kind: "Old Kind!" },
      { fromNode: a.id, toNode: b.id, kind: "buildsOn" },
    ]);
  });

  it("locks a plan once kicked off: status moves on, the graph does not", async () => {
    const { repos, tick } = setup();
    const { project, source } = await projectWithSource(repos);
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id });
    const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "bits", title: "N" });
    await repos.plans.setStatus(plan.id, "approved");
    tick();
    const running = await repos.plans.setStatus(plan.id, "running");
    expect(running).toMatchObject({ status: "running", kickedOffAt: "2026-11-10T09:00:01.000Z" });
    tick();
    expect((await repos.plans.setStatus(plan.id, "done"))?.kickedOffAt).toBe("2026-11-10T09:00:01.000Z");

    await expect(repos.plans.addNode({ planId: plan.id, level: 0, ord: 1, type: "bits", title: "Late" })).rejects.toBeInstanceOf(PlanLockedError);
    await expect(repos.plans.updateNode(node.id, { title: "Renamed" })).rejects.toBeInstanceOf(PlanLockedError);
    await expect(repos.plans.setNodeSources(node.id, [{ sourceId: source.id }])).rejects.toBeInstanceOf(PlanLockedError);
    await expect(repos.plans.deleteNode(node.id)).rejects.toBeInstanceOf(PlanLockedError);
    expect(await repos.plans.updateNode(node.id, { status: "done", estCostUsd: 0.02 })).toMatchObject({ status: "done", estCostUsd: 0.02 });
    await expect(repos.plans.updateNode(node.id, { status: "finished" as never })).rejects.toBeInstanceOf(InvalidRecordError);

    const next = await repos.plans.create({ ownerId: "owner", projectId: project.id, supersedesPlanId: plan.id });
    expect(next).toMatchObject({ version: 2, supersedesPlanId: plan.id, status: "draft" });
    expect((await repos.plans.listByProject(project.id)).map((entry) => entry.version)).toEqual([1, 2]);
  });
});

describe("stage labels", () => {
  it("labels stages optionally, trims, clears with null or blank, and may change after Start", async () => {
    const { db, repos } = setup();
    const { project } = await projectWithSource(repos);
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id });
    expect(await repos.plans.listStages(plan.id)).toEqual([]);

    await repos.plans.setStageLabel(plan.id, 2, "  Practice ");
    await repos.plans.setStageLabel(plan.id, 0, "Warm-up");
    expect(await repos.plans.listStages(plan.id)).toEqual([
      { planId: plan.id, level: 0, label: "Warm-up" },
      { planId: plan.id, level: 2, label: "Practice" },
    ]);

    await repos.plans.setStatus(plan.id, "running");
    expect(await repos.plans.setStageLabel(plan.id, 0, "Start here")).toContainEqual({ planId: plan.id, level: 0, label: "Start here" });
    await repos.plans.setStageLabel(plan.id, 2, null);
    await repos.plans.setStageLabel(plan.id, 0, "   ");
    expect(await repos.plans.listStages(plan.id)).toEqual([]);

    await expect(repos.plans.setStageLabel(plan.id, -1, "x")).rejects.toBeInstanceOf(InvalidRecordError);
    await repos.plans.setStageLabel(plan.id, 1, "Gone with the plan");
    await repos.plans.delete(plan.id);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM plan_stages").get()).toEqual({ n: 0 });
  });
});

describe("item results", () => {
  async function planWithNode(repos: StudioRepositories) {
    const { project } = await projectWithSource(repos);
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id });
    const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "quiz", title: "Check" });
    return { project, plan, node };
  }

  it("ticks done, keeps the first tick, un-ticks without losing the result", async () => {
    const { repos, tick } = setup();
    const { plan, node } = await planWithNode(repos);
    expect(await repos.results.get(node.id)).toBeUndefined();

    const done = await repos.results.set(node.id, { done: true, result: { score: 0.6, missed: ["q2"] } });
    expect(done).toEqual({
      nodeId: node.id,
      doneAt: "2026-11-10T09:00:00.000Z",
      result: { score: 0.6, missed: ["q2"] },
      createdAt: "2026-11-10T09:00:00.000Z",
      updatedAt: "2026-11-10T09:00:00.000Z",
    });
    tick();
    expect((await repos.results.set(node.id, { done: true }))).toMatchObject({ doneAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:00:01.000Z" });

    const undone = await repos.results.set(node.id, { done: false });
    expect(undone.doneAt).toBeUndefined();
    expect(undone.result).toEqual({ score: 0.6, missed: ["q2"] });
    expect(undone.createdAt).toBe("2026-11-10T09:00:00.000Z");

    expect((await repos.results.set(node.id, { result: null })).result).toBeUndefined();
    expect(await repos.results.listByPlan(plan.id)).toHaveLength(1);
  });

  it("loses neither field when a tick and a result are written at the same time", async () => {
    const { repos } = setup();
    const { node } = await planWithNode(repos);
    await Promise.all([repos.results.set(node.id, { done: true }), repos.results.set(node.id, { result: { score: 0.9 } })]);
    expect(await repos.results.get(node.id)).toMatchObject({ doneAt: "2026-11-10T09:00:00.000Z", result: { score: 0.9 } });

    await Promise.all([repos.results.set(node.id, { done: false }), repos.results.set(node.id, { result: null })]);
    const cleared = await repos.results.get(node.id);
    expect(cleared?.doneAt).toBeUndefined();
    expect(cleared?.result).toBeUndefined();
  });

  it("holds a result without a tick, points at the output gone through, and goes with its node", async () => {
    const { db, repos } = setup();
    const { project, plan, node } = await planWithNode(repos);
    const output = await repos.outputs.create({ ownerId: "owner", projectId: project.id, nodeId: node.id, type: "quiz", schemaVersion: 1, title: "Check", payload: {} });

    const answered = await repos.results.set(node.id, { result: { answer: true }, outputId: output.id });
    expect(answered).toMatchObject({ result: { answer: true }, outputId: output.id });
    expect(answered.doneAt).toBeUndefined();
    await expect(repos.results.set("no-node", { done: true })).rejects.toThrow(/FOREIGN KEY/i);

    db.raw.prepare("DELETE FROM outputs WHERE id = ?").run(output.id);
    expect((await repos.results.get(node.id))?.outputId).toBeUndefined();
    await repos.plans.delete(plan.id);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM item_results").get()).toEqual({ n: 0 });
  });
});

describe("outputs", () => {
  it("keeps every generation and serves the newest per node", async () => {
    const { repos, tick } = setup();
    const { project, source } = await projectWithSource(repos);
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id });
    const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "read", title: "Read" });
    const first = await repos.outputs.create({
      ownerId: "owner",
      projectId: project.id,
      nodeId: node.id,
      type: "read",
      schemaVersion: 1,
      title: "Read v1",
      summary: "First pass.",
      payload: { blocks: [{ type: "text", text: "v1" }] },
      citations: [{ sourceId: source.id }],
      prompt: "Brief",
      settings: { depth: "standard" },
      sources: [{ sourceId: source.id, range: { page: 2 } }],
      costUsd: 0.03,
    });
    tick();
    const second = await repos.outputs.create({ ownerId: "owner", projectId: project.id, nodeId: node.id, type: "read", schemaVersion: 1, title: "Read v2", payload: { v: 2 } });

    expect(first).toMatchObject({
      summary: "First pass.",
      payload: { blocks: [{ type: "text", text: "v1" }] },
      citations: [{ sourceId: source.id }],
      prompt: "Brief",
      settings: { depth: "standard" },
      sources: [{ sourceId: source.id, range: { page: 2 } }],
      costUsd: 0.03,
    });
    expect(second).toMatchObject({ summary: "", citations: [], sources: [] });
    expect(second.settings).toBeUndefined();
    expect((await repos.outputs.latestForNode(node.id))?.id).toBe(second.id);
    expect((await repos.outputs.listByProject(project.id)).map((output) => output.title)).toEqual(["Read v1", "Read v2"]);

    await repos.outputs.archive(second.id);
    expect((await repos.outputs.latestForNode(node.id))?.id).toBe(first.id);
    await repos.outputs.setCost(first.id, 0.05);
    await repos.outputs.setCategory(first.id, "Math");
    expect(await repos.outputs.get(first.id)).toMatchObject({ costUsd: 0.05, category: "Math" });
  });

  it("lists the Library newest first, by type, and refuses ids that are not format ids", async () => {
    const { repos, tick } = setup();
    await repos.outputs.create({ ownerId: "o", type: "bits", schemaVersion: 1, title: "Single bits", payload: {} });
    tick();
    await repos.outputs.create({ ownerId: "o", type: "read", schemaVersion: 1, title: "Single read", payload: {} });
    expect((await repos.outputs.listByOwner("o")).map((output) => output.title)).toEqual(["Single read", "Single bits"]);
    expect((await repos.outputs.listByOwner("o", { type: "bits" })).map((output) => output.title)).toEqual(["Single bits"]);
    await expect(repos.outputs.create({ ownerId: "o", type: "not an id", schemaVersion: 1, title: "x", payload: {} })).rejects.toBeInstanceOf(
      InvalidRecordError,
    );
    await expect(repos.outputs.create({ ownerId: "o", type: "bits", schemaVersion: 0, title: "x", payload: {} })).rejects.toBeInstanceOf(
      InvalidRecordError,
    );
  });

  it("takes a format no registry knows yet, and reads any stored id back as it is", async () => {
    const { db, repos } = setup();
    const future = await repos.outputs.create({ ownerId: "o", type: "podcast", schemaVersion: 1, title: "Later format", payload: {} });
    expect((await repos.outputs.get(future.id))?.type).toBe("podcast");
    db.raw.prepare("UPDATE outputs SET type = ? WHERE id = ?").run("old-slides", future.id);
    expect((await repos.outputs.get(future.id))?.type).toBe("old-slides");
    expect((await repos.outputs.listByOwner("o")).map((output) => output.type)).toEqual(["old-slides"]);

    const { project } = await projectWithSource(repos, "o");
    const plan = await repos.plans.create({ ownerId: "o", projectId: project.id });
    const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: 0, type: "read", title: "Old id" });
    db.raw.prepare("UPDATE plan_nodes SET type = ? WHERE id = ?").run("slides", node.id);
    expect((await repos.plans.listNodes(plan.id)).map((row) => row.type)).toEqual(["slides"]);
  });
});

describe("usage", () => {
  it("records provider calls through the D1 sink and sums them per job, node, plan and project", async () => {
    const { repos } = setup();
    const scope = { ownerId: "o", jobId: "job-1", projectId: "p-1", planId: "plan-1", nodeId: "node-1" };
    const sink = repos.usage.sink(scope);
    await sink.record({ provider: "openrouter", model: "m", task: "planning", tokensIn: 1_000, tokensOut: 200, usd: 0.0012, latencyMs: 812.4, ok: true });
    await sink.record({ provider: "openrouter", model: "m", task: "section", tokensIn: 2_000, tokensOut: 800, usd: 0.0031, latencyMs: 1500, ok: true });
    await sink.record({ provider: "deepseek", model: "d", task: "section", latencyMs: 60_000, ok: false, error: "timeout" });
    await repos.usage.sink({ ownerId: "o", sessionId: "s-1" }).record({ provider: "gemini", model: "g", tokensIn: 10, tokensOut: 5, usd: 0.00001, latencyMs: 90, ok: true });

    const expected = { calls: 3, failedCalls: 1, unpricedCalls: 0, timedOutCalls: 1, tokensIn: 3_000, tokensOut: 1_000, usd: 0.0043 };
    expect(await repos.usage.totals("job", "job-1")).toEqual(expected);
    expect(await repos.usage.totals("node", "node-1")).toEqual(expected);
    expect(await repos.usage.totals("plan", "plan-1")).toEqual(expected);
    expect(await repos.usage.totals("project", "p-1")).toEqual(expected);
    expect(await repos.usage.totals("session", "s-1")).toEqual({ calls: 1, failedCalls: 0, unpricedCalls: 0, timedOutCalls: 0, tokensIn: 10, tokensOut: 5, usd: 0.00001 });
    expect(await repos.usage.totals("job", "none")).toEqual({ calls: 0, failedCalls: 0, unpricedCalls: 0, timedOutCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 });
  });

  it("prefers the event's job id over the scope's", async () => {
    const { repos } = setup();
    await repos.usage.sink({ ownerId: "o", jobId: "scope-job" }).record({ provider: "x", model: "m", latencyMs: 1, ok: true, jobId: "event-job" });
    expect((await repos.usage.totals("job", "event-job")).calls).toBe(1);
    expect((await repos.usage.totals("job", "scope-job")).calls).toBe(0);
  });

  it("never fails a provider call when the write fails", async () => {
    const { db, repos } = setup();
    db.raw.exec("DROP TABLE usage");
    expect(() =>
      safeRecord(repos.usage.sink({ ownerId: "o" }), { provider: "x", model: "m", latencyMs: 1, ok: true }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("default registry", () => {
  it("makes flashcards and quiz, declares video, has audio and the guide say why they cannot be made, and nothing else (DECISIONS #33)", () => {
    const registry = createDefaultRegistry();
    expect(registry.ready()).toEqual(["flashcards", "quiz"]);
    expect(registry.views().map((view) => [view.id, view.ready])).toEqual([
      ["video", false],
      ["flashcards", true],
      ["quiz", true],
      ["audio", false],
      ["guide", false],
    ]);
    expect(registry.views().find((view) => view.id === "audio")?.problem).toMatch(/scene maker/);
    expect(registry.views().find((view) => view.id === "guide")?.problem).toMatch(/your own agent/);
    expect(registry.get("video")).toBeUndefined();
    expect(registry.has("slides")).toBe(false);
    for (const gone of ["guidedWork", "hwRedo"]) expect(registry.has(gone)).toBe(false);
    for (const old of ["byte", "bits", "read", "cards"]) expect(registry.resolve(old)).toBe("flashcards");
    expect(registry.resolve("check")).toBe("quiz");
    const slots = registry.views().map((view) => view.colorSlot);
    expect(new Set(slots).size).toBe(slots.length);
    const read = registry.require("read");
    expect(read.parseSettings({})).toMatchObject({ ok: true, settings: { cards: 0, exemplarSummaries: [] } });
    expect(read.estimateCost({ settings: { cards: 20, kinds: [], exemplarSummaries: [] }, sourceChars: 8_000, sourceCount: 1 }).basis).toMatch(
      /^medium depth/,
    );
  });

  it("passes engine options through to the flashcards definition, also when reached by an old id", () => {
    const registry = createDefaultRegistry({ flashcards: { price: { inputPerMillion: 1, outputPerMillion: 1 } } });
    for (const type of ["byte", "bits", "read"]) {
      expect(registry.require(type).estimateCost({ settings: { cards: 8, kinds: [], exemplarSummaries: [] }, sourceChars: 4_000, sourceCount: 1 }).usd).toBeGreaterThan(0);
    }
  });
});

describe("agent turns", () => {
  it("records a turn's steps in order, ends it once, and rewrites its reply", async () => {
    const { repos, tick } = setup();
    const { project } = await projectWithSource(repos);
    const chat = await repos.sessions.create({ ownerId: "owner", projectId: project.id });
    const reply = await repos.sessions.append(chat.id, { role: "assistant", content: { text: "", pieces: [], state: "running" } });
    const turn = await repos.agentTurns.create({
      sessionId: chat.id,
      messageId: reply.id,
      ownerId: "owner",
      projectId: project.id,
      agent: "claude",
      tokenHash: "hash",
      request: { text: "hi" },
    });
    expect(turn).toMatchObject({ state: "running", agent: "claude", request: { text: "hi" } });
    expect(await repos.agentTurns.byMessage(reply.id)).toEqual(turn);
    expect(await repos.agentTurns.running(chat.id)).toEqual([turn]);

    const first = await repos.agentTurns.addStep(turn.id, { tool: "search_passages", label: "Searching A paper" });
    tick();
    const second = await repos.agentTurns.addStep(turn.id, { tool: "reply", label: "Writing the reply" });
    await repos.agentTurns.endStep(first.id, "done");
    await repos.agentTurns.endStep(second.id, "done", { parts: [] });
    const steps = await repos.agentTurns.steps(turn.id);
    expect(steps.map((step) => [step.seq, step.tool, step.state])).toEqual([
      [0, "search_passages", "done"],
      [1, "reply", "done"],
    ]);
    expect(steps[1].result).toEqual({ parts: [] });

    expect(await repos.agentTurns.finish(turn.id, "done")).toBe(true);
    expect(await repos.agentTurns.finish(turn.id, "stopped")).toBe(false);
    expect((await repos.agentTurns.get(turn.id))?.state).toBe("done");
    expect(await repos.agentTurns.running(chat.id)).toEqual([]);

    const written = await repos.sessions.updateContent(reply.id, { text: "Hello", pieces: [{ kind: "text", text: "Hello", cites: [] }] });
    expect(written?.content).toEqual({ text: "Hello", pieces: [{ kind: "text", text: "Hello", cites: [] }] });
    expect(written?.seq).toBe(reply.seq);
  });
});

describe("agent_picks repository", () => {
  it("stores, updates, and clears remembered agent/model/effort picks by scope", async () => {
    const { repos } = setup();
    expect(await repos.providerSettings.listPicks("o")).toEqual([]);
    expect(await repos.providerSettings.getPick("o", "video")).toBeUndefined();

    const first = await repos.providerSettings.setPick("o", "video", { agent: "claude", model: "sonnet", effort: "high" });
    expect(first).toMatchObject({ scope: "video", agent: "claude", model: "sonnet", effort: "high" });
    expect(await repos.providerSettings.listPicks("o")).toEqual([first!]);

    const updated = await repos.providerSettings.setPick("o", "video", { model: "opus", effort: "max" });
    expect(updated).toMatchObject({ scope: "video", agent: "claude", model: "opus", effort: "max" });

    // Clearing all fields removes the row completely.
    expect(await repos.providerSettings.setPick("o", "video", { agent: null, model: "", effort: null })).toBeUndefined();
    expect(await repos.providerSettings.getPick("o", "video")).toBeUndefined();
    expect(await repos.providerSettings.listPicks("o")).toEqual([]);

    await expect(repos.providerSettings.setPick("o", "bad scope!", { agent: "claude" })).rejects.toThrow(/Invalid agent pick scope/);
  });

  it("keeps a reviewer off on a review scope only", async () => {
    const { repos } = setup();
    const off = await repos.providerSettings.setPick("o", "video.review", { off: true });
    expect(off).toMatchObject({ scope: "video.review", off: true });
    expect(await repos.providerSettings.getPick("o", "video.review")).toMatchObject({ off: true });
    // Picking a reviewer keeps off until it is cleared; clearing off with nothing else removes the row.
    expect(await repos.providerSettings.setPick("o", "video.review", { agent: "claude", off: false })).toMatchObject({ agent: "claude" });
    expect((await repos.providerSettings.getPick("o", "video.review"))?.off).toBeUndefined();
    await repos.providerSettings.setPick("o", "video.review", { agent: null, off: true });
    expect(await repos.providerSettings.setPick("o", "video.review", { off: null })).toBeUndefined();
    await expect(repos.providerSettings.setPick("o", "video", { off: true })).rejects.toThrow(/Only a reviewer can be off/);
    expect(await repos.providerSettings.getPick("o", "video")).toBeUndefined();
  });
});
