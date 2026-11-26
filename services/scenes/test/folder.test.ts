/**
 * A video's job folder (src/folder.ts, docs/JOB-FOLDER.md): its note, its sources and what was read from them, the
 * pictures fetched from the engine, the copy to the library, which old jobs are cleaned up, and the service's route
 * that opens the folder. The connector here does not answer, so a job ends at once after its folder is written.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Connector } from "../src/connector.ts";
import { BESIDE_WORK, copyToLibrary, folderName, openCommand, toRemove, writeJobFolder } from "../src/folder.ts";
import { Jobs, type JobRecord } from "../src/jobs.ts";
import { readRequest, type VideoRequest } from "../src/request.ts";
import { createScenesServer } from "../src/server.ts";
import { allStyles, listStyles } from "../src/styles.ts";
import { silentVoice } from "../src/voice.ts";

const root = mkdtempSync(join(tmpdir(), "opensourcebook-folder-"));
after(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");

function request(extra: Record<string, unknown> = {}): VideoRequest {
  const read = readRequest(
    {
      id: "job-1",
      title: "How cells divide",
      brief: "Walk through the stages of cell division.",
      assumes: ["What a cell is"],
      targetSeconds: 120,
      passages: [
        { id: "p1", sourceId: "src/a", sourceTitle: "Chapter 4", locator: "page 2", text: "Cells divide in stages." },
        { id: "p2", sourceId: "src/a", sourceTitle: "Chapter 4", text: "Each stage has a name." },
        { id: "p3", sourceId: "web-1", sourceTitle: "A page", text: "Mitosis ends in two cells." },
      ],
      ...extra,
    },
    listStyles().map((s) => s.id),
  );
  assert.ok("request" in read, JSON.stringify(read));
  return read.request;
}

test("the job folder holds the note, a link to each file on disk, the sources list, the text and the pictures", async () => {
  const folder = join(root, "one");
  mkdirSync(folder);
  const file = join(root, "chapter-4.pdf");
  writeFileSync(file, "%PDF");
  const asked: string[] = [];
  const fetchImpl = (async (url: URL) => {
    asked.push(String(url));
    return String(url).endsWith("/good") ? new Response(PNG, { headers: { "content-type": "image/png" } }) : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const r = request({
    sources: [
      { id: "src/a", title: "Chapter 4", kind: "pdf", path: file, pictures: [{ url: "/v1/assets/good", kind: "figure", caption: "Figure 2", page: 3 }, { url: "/v1/assets/gone", kind: "slide" }, { url: "https://elsewhere.example/x.png", kind: "figure" }] },
      { id: "web-1", title: "A page", kind: "web", url: "https://example.org/page" },
    ],
  });
  await writeJobFolder(folder, r, { engineUrl: "http://127.0.0.1:9", fetch: fetchImpl });

  // Only the engine's own pictures are fetched, from the engine.
  assert.deepEqual(asked, ["http://127.0.0.1:9/v1/assets/good", "http://127.0.0.1:9/v1/assets/gone"]);
  const listed = JSON.parse(readFileSync(join(folder, "sources", "sources.json"), "utf8"));
  assert.deepEqual(listed, [
    { id: "src/a", title: "Chapter 4", kind: "pdf", path: file, extracted: "extracted/src_a", link: "sources/src_a-chapter-4.pdf" },
    { id: "web-1", title: "A page", kind: "web", url: "https://example.org/page", extracted: "extracted/web-1" },
  ]);
  const link = join(folder, "sources", "src_a-chapter-4.pdf");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), file);
  const text = readFileSync(join(folder, "extracted", "src_a", "text.md"), "utf8");
  assert.match(text, /^# Chapter 4\n\n## p1 · page 2\n\nCells divide in stages\.\n\n## p2\n\nEach stage has a name\./);
  assert.match(readFileSync(join(folder, "extracted", "web-1", "text.md"), "utf8"), /## p3\n\nMitosis ends in two cells\./);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, "extracted", "src_a", "pictures.json"), "utf8")), [{ file: "pictures/1.png", kind: "figure", caption: "Figure 2", page: 3 }]);
  assert.deepEqual(readFileSync(join(folder, "extracted", "src_a", "pictures", "1.png")), PNG);
  const note = readFileSync(join(folder, "README.md"), "utf8");
  assert.match(note, /^# How cells divide\n/);
  assert.match(note, /Walk through the stages of cell division\./);
  assert.match(note, /- What a cell is/);
  assert.match(note, /Length: about 2 minutes\./);
  // Each path as the agent reaches it from its own folder, work/, one level down.
  assert.match(note, /- Chapter 4 \(pdf\): `\.\.\/extracted\/src_a\/text\.md`, 2 passages, 1 picture, the original at `\.\.\/sources\/src_a-chapter-4\.pdf`/);
  assert.match(note, /- A page \(web\): `\.\.\/extracted\/web-1\/text\.md`, 1 passage, from https:\/\/example\.org\/page/);
  for (const path of ["../README.md", "../sources/sources.json", "../sources/", "../extracted/<source>/text.md", "../extracted/<source>/pictures/", "work/"]) assert.ok(note.includes(`\`${path}\``), path);
  assert.deepEqual([...BESIDE_WORK], ["README.md", "sources", "extracted"]);
});

test("without sources from the engine the folder is made from the passages alone, and a missing file is no link", async () => {
  const folder = join(root, "two");
  mkdirSync(folder);
  await writeJobFolder(folder, request(), {});
  const listed = JSON.parse(readFileSync(join(folder, "sources", "sources.json"), "utf8"));
  assert.deepEqual(listed.map((s: { id: string; kind: string; title: string }) => [s.id, s.kind, s.title]), [["src/a", "source", "Chapter 4"], ["web-1", "source", "A page"]]);
  assert.ok(!existsSync(join(folder, "extracted", "src_a", "pictures.json")));

  const three = join(root, "three");
  mkdirSync(three);
  const lines: string[] = [];
  await writeJobFolder(three, request({ sources: [{ id: "src/a", title: "Chapter 4", kind: "pdf", path: join(root, "not-there.pdf") }] }), { log: (l) => lines.push(l) });
  assert.equal(JSON.parse(readFileSync(join(three, "sources", "sources.json"), "utf8"))[0].link, undefined);
  assert.equal(lines.length, 1);
});

test("a request's sources are checked", () => {
  const read = readRequest({ id: "x", title: "T", passages: [{ id: "p", sourceId: "s", text: "t" }], sources: [{ id: "s", title: "S", kind: "pdf", path: "relative/file.pdf" }] }, []);
  assert.ok("problems" in read && read.problems.some((p) => p.includes("path")));
  assert.equal(folderName("../a b"), ".._a_b");
  assert.equal(folderName(".."), "_");
});

test("old jobs are cleaned up: kept while among the last ones or recent, never while being made", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const day = 86_400_000;
  const jobs = Array.from({ length: 14 }, (_, i) => ({ id: `j${i}`, updatedAt: new Date(now - (i + 1) * day).toISOString(), busy: i === 13 }));
  const gone = toRemove(jobs, (j) => j.busy, { jobs: 10, days: 7 }, now).map((j) => j.id);
  // j0..j9 are the last ten; j10..j12 are older than a week; j13 is being made.
  assert.deepEqual(gone, ["j10", "j11", "j12"]);
  assert.deepEqual(toRemove(jobs.slice(0, 5), () => false, { jobs: 2, days: 30 }, now), []);
});

test("a finished video is copied to the library under its title, and not at all when there is none", () => {
  const video = join(root, "video.mp4");
  writeFileSync(video, "mp4");
  assert.equal(copyToLibrary(undefined, "Title", video), undefined);
  const library = join(root, "library");
  assert.equal(copyToLibrary(library, "Cells: how/why", video), join(library, "Cells how why.mp4"));
  assert.equal(copyToLibrary(library, "Cells: how/why", video), join(library, "Cells how why 2.mp4"));
  assert.equal(readFileSync(join(library, "Cells how why 2.mp4"), "utf8"), "mp4");
});

test("with a jobs folder of their own, job folders go there and nothing of them in the service's data folder", async () => {
  const dataDir = join(root, "data-apart");
  const jobsDir = join(root, "jobs-apart");
  const connector = new Connector({ url: "http://127.0.0.1:9", token: "connector-token-0123456789" });
  const jobs = new Jobs({ dataDir, jobsDir, connector, voice: silentVoice(), styles: listStyles, callbackBase: () => "http://127.0.0.1:9", log: () => undefined });
  jobs.create({ ...request(), id: "apart-1" });
  for (let i = 0; i < 200 && jobs.get("apart-1")?.state !== "failed"; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(jobs.folder("apart-1"), join(jobsDir, "apart-1"));
  assert.ok(existsSync(join(jobsDir, "apart-1", "job.json")) && existsSync(join(jobsDir, "apart-1", "README.md")));
  assert.ok(!existsSync(join(dataDir, "apart-1")));
  // Read back from the jobs folder when the service starts again.
  assert.equal(new Jobs({ dataDir, jobsDir, connector, voice: silentVoice(), styles: listStyles, callbackBase: () => "", log: () => undefined }).get("apart-1")?.id, "apart-1");
  assert.equal(new Jobs({ dataDir: jobsDir, connector, voice: silentVoice(), styles: listStyles, callbackBase: () => "", log: () => undefined }).jobsDir, jobsDir, "left out, it is the data folder");
});

test("the folder opens in this computer's file manager", () => {
  assert.deepEqual(openCommand("/x", "darwin"), { bin: "open", args: ["/x"] });
  assert.deepEqual(openCommand("C:\\x", "win32"), { bin: "explorer.exe", args: ["C:\\x"] });
  assert.deepEqual(openCommand("/x", "linux"), { bin: "xdg-open", args: ["/x"] });
});

test("a new job gets its folder before the agent is asked, is cleaned up once it ends, and the service opens its folder", async () => {
  const dataDir = join(root, "data");
  // No connector answers on this port: the job fails as soon as it asks, after its folder is written.
  const connector = new Connector({ url: "http://127.0.0.1:9", token: "connector-token-0123456789" });
  const voice = silentVoice();
  const jobs = new Jobs({ dataDir, connector, voice, styles: listStyles, callbackBase: () => "http://127.0.0.1:9", log: () => undefined, keep: { jobs: 1, days: 0 } });
  const shown: string[] = [];
  const server = createScenesServer({ token: "scenes-token-0123456789", jobs, connector, voice, styles: allStyles, dataDir, showFolder: async (f) => void shown.push(f) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: "Bearer scenes-token-0123456789", "content-type": "application/json" } });
  const until = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = jobs.get(id);
      if (job && job.state === "failed") return job;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${id} did not end`);
  };

  const first = request();
  assert.equal((await api("/videos", { method: "POST", body: JSON.stringify(first) })).status, 202);
  await until("job-1");
  const folder = jobs.folder("job-1");
  for (const part of ["README.md", "sources/sources.json", "extracted/src_a/text.md", "extracted/web-1/text.md", "job.json"]) assert.ok(existsSync(join(folder, part)), part);

  const opened = await api("/videos/job-1/show-files", { method: "POST" });
  assert.equal(opened.status, 200);
  assert.deepEqual(shown, [folder]);
  assert.equal((await api("/videos/nobody/show-files", { method: "POST" })).status, 404);

  // A second job that ends leaves room for one: the first, older, is removed; something else in the data folder stays.
  mkdirSync(join(dataDir, "audio"), { recursive: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await api("/videos", { method: "POST", body: JSON.stringify({ ...first, id: "job-2" }) })).status, 202);
  const second: JobRecord = await until("job-2");
  for (let i = 0; i < 100 && existsSync(folder); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(!existsSync(folder), "the older job's folder is removed");
  assert.equal(jobs.get("job-1"), undefined);
  assert.ok(existsSync(jobs.folder(second.id)));
  assert.ok(existsSync(join(dataDir, "audio")));
});

test("job folders go in their own folder when one is set, and the agent reads the rest of its job folder beside its work where the connector opens it", async () => {
  const dataDir = join(root, "service-data");
  const jobsDir = join(root, "jobs-only");
  for (const reads of [true, false]) {
    const starts: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.url === "/status") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agent: "fake", agents: [{ id: "fake", label: "Fake", installed: true, signedIn: true, workspace: true, workspaceAccess: "files", ...(reads ? { workspaceReads: true } : {}) }] }));
      if (req.method === "POST" && req.url === "/turns") {
        const start = JSON.parse(raw);
        starts.push(start);
        res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, agent: "fake", workspace: true }));
        // The agent ends at once, failing, so the job ends after one start.
        await fetch(`${start.callback.url}/finish`, { method: "POST", headers: { authorization: `Bearer ${start.callback.token}`, "content-type": "application/json" }, body: JSON.stringify({ outcome: "failed", problem: "error" }) });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let base = "";
    const connector = new Connector({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "connector-token-0123456789" });
    const jobs = new Jobs({ dataDir, jobsDir, connector, voice: silentVoice(), styles: listStyles, callbackBase: () => base, log: () => undefined, resumeDelaysMs: [60_000] });
    const scenes = createScenesServer({ token: "scenes-token-0123456789", jobs, connector, voice: silentVoice(), styles: allStyles, dataDir });
    await new Promise<void>((resolve) => scenes.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(scenes.address() as AddressInfo).port}`;
    const id = `job-${reads ? "reads" : "alone"}`;
    try {
      jobs.create({ ...request(), id });
      for (let i = 0; i < 200 && !starts.length; i++) await new Promise((r) => setTimeout(r, 25));
      const folder = join(jobsDir, id);
      assert.equal(jobs.folder(id), folder);
      assert.ok(existsSync(join(folder, "job.json")) && !existsSync(join(dataDir, id)), "the job folder is in the jobs folder, not beside the service's files");
      const start = starts[0];
      assert.equal(start.workspace.path, join(folder, "work"));
      if (reads) {
        assert.deepEqual(start.workspace.read, [join(folder, "README.md"), join(folder, "sources"), join(folder, "extracted")]);
        assert.match(start.systemPrompt, /one level up \(`\.\.`\), which you can read but not change: `\.\.\/README\.md` says what is there/);
        assert.match(start.systemPrompt, /Your own file tools work there: read, write/);
      } else {
        assert.equal(start.workspace.read, undefined, "a connector that can't open it read only gets the work folder alone");
        assert.doesNotMatch(start.systemPrompt, /\.\.\/README\.md/);
        assert.match(start.systemPrompt, /Your own file tools work there and only there/);
      }
    } finally {
      // The job ends before the folders go: it fails on the agent's end, or is stopped.
      for (let i = 0; i < 200 && !["failed", "stopped"].includes(jobs.get(id)?.state ?? "failed"); i++) await new Promise((r) => setTimeout(r, 25));
      await jobs.stop(id);
      await new Promise((r) => setTimeout(r, 200));
      scenes.close();
      server.close();
    }
  }
});
