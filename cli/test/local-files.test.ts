import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultLibrary, libraryOf, listFolder, LocalFiles, readInFolder, refusedFolder } from "../local-files.ts";
import { engineSettings, type Wiring } from "../programs.ts";
import { SECRET_NAMES, type Secrets } from "../secrets.ts";

const TOKEN = "files-token-0123456789";

async function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "x-files-token": TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.startsWith("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

test("local files: a folder is listed a few levels deep with its hidden files left out, and read only inside it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-files-"));
  try {
    const folder = join(dir, "Notes");
    mkdirSync(join(folder, "week 1"), { recursive: true });
    mkdirSync(join(folder, ".hidden"));
    writeFileSync(join(folder, "a.md"), "# A\n");
    writeFileSync(join(folder, "week 1", "b.txt"), "bee");
    writeFileSync(join(folder, ".secret"), "no");
    writeFileSync(join(folder, ".hidden", "c.txt"), "no");
    writeFileSync(join(dir, "outside.txt"), "outside");
    symlinkSync(join(dir, "outside.txt"), join(folder, "link.txt"));
    symlinkSync(dir, join(folder, "loop"));
    symlinkSync(join(folder, "a.md"), join(folder, "same.md"));

    const listed = await listFolder(folder);
    assert.deepEqual(listed.files.map((f) => f.path), ["a.md", "same.md", "week 1/b.txt"]);
    assert.equal(listed.files[0]!.size, 4);
    assert.equal(listed.more, false);

    assert.equal((await readInFolder(folder, "week 1/b.txt")).toString(), "bee");
    await assert.rejects(readInFolder(folder, "../outside.txt"), /inside the folder/);
    await assert.rejects(readInFolder(folder, "link.txt"), /inside the folder/, "a link that points out of the folder is not followed");
    await assert.rejects(readInFolder(folder, ".secret"), /inside the folder/);
    await assert.rejects(readInFolder(folder, "gone.txt"), /not there/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local files: the library is Documents/Open Sourcebook until the person picks one, kept in the state folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-files-"));
  const state = join(dir, "state");
  mkdirSync(state);
  const files = new LocalFiles({ state, port: 0, token: TOKEN, home: dir });
  await files.start();
  try {
    const port = files.port;
    assert.equal((await call(port, "GET", "/library", undefined, { "x-files-token": "wrong-token-0123456789" })).status, 401);
    const wrongHost = await new Promise<number>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/library", headers: { host: `evil.example:${port}`, "x-files-token": TOKEN } }, (res) => {
        res.resume();
        done(res.statusCode!);
      });
      req.on("error", fail);
      req.end();
    });
    assert.equal(wrongHost, 421);
    assert.deepEqual((await call(port, "GET", "/library")).body, { folder: defaultLibrary(dir), chosen: false });

    const mine = join(dir, "My videos");
    assert.deepEqual((await call(port, "PUT", "/library", { folder: mine })).body, { folder: mine, chosen: true });
    assert.deepEqual(libraryOf(state, dir), { folder: mine, chosen: true });
    assert.equal((await call(port, "PUT", "/library", { folder: "relative/path" })).status, 400);
    assert.equal((await call(port, "PUT", "/library", { folder: join(dir, ".dot") })).status, 400);
    assert.deepEqual((await call(port, "PUT", "/library", { folder: null })).body, { folder: defaultLibrary(dir), chosen: false });

    const folder = join(dir, "Course");
    mkdirSync(folder);
    writeFileSync(join(folder, "one.md"), "one");
    const list = await call(port, "POST", "/folder/list", { folder });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.files.map((f: { path: string }) => f.path), ["one.md"]);
    const read = await call(port, "POST", "/folder/read", { folder, path: "one.md" });
    assert.equal(read.status, 200);
    assert.equal(read.body.toString(), "one");
    assert.equal((await call(port, "POST", "/folder/read", { folder, path: "../state/library.json" })).status, 403);
    assert.equal((await call(port, "POST", "/folder/list", { folder: join(dir, "not here") })).status, 404);
  } finally {
    await files.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local files: a hidden folder, the whole disk and the system Library are refused", () => {
  assert.match(refusedFolder("/", "/Users/me")!, /whole disk/);
  assert.match(refusedFolder("/Users/me/.ssh", "/Users/me")!, /hidden/);
  assert.match(refusedFolder("notes", "/Users/me")!, /whole path/);
  assert.equal(refusedFolder("/Users/me/Documents/Course", "/Users/me"), undefined);
  if (process.platform === "darwin") assert.match(refusedFolder("/Users/me/Library/Mail", "/Users/me")!, /Library/);
});

test("local files: the engine is told where to ask and with which token, only when the launcher answers", () => {
  const secrets = Object.fromEntries(SECRET_NAMES.map((n) => [n, `${n.toLowerCase()}-0123456789`])) as Secrets;
  const base: Wiring = { root: "/nowhere", home: "/nowhere/.opensourcebook", ports: { engine: 1, connector: 2, scenes: 3 }, secrets, env: {} };
  assert.equal(engineSettings(base).LOCAL_FILES_URL, undefined);
  const s = engineSettings({ ...base, ports: { ...base.ports, files: 5182 } });
  assert.equal(s.LOCAL_FILES_URL, "http://127.0.0.1:5182");
  assert.equal(s.LOCAL_FILES_TOKEN, secrets.FILES_TOKEN);
});
