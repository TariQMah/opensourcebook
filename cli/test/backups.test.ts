import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackupSchedule, backupName, DEFAULT_KEEP, isDue, keepOf, readBackupSettings, saveBackup, WEEK_MS, writeBackupSettings } from "../backups.ts";
import { LIBRARY_FILE } from "../local-files.ts";
import { Phone } from "../phone.ts";

const DAY = 24 * 60 * 60_000;

/** A stand-in for the engine's GET /v1/backup: a zip's bytes for the right token, sent in two pieces. */
function engine(seen: string[] = [], options: { breakOff?: boolean; status?: number } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const token = new Headers(init?.headers).get("x-client-token") ?? "";
    seen.push(`${url} ${token}`);
    if (options.status) return Response.json({ error: "no", message: "The engine said no." }, { status: options.status });
    if (token !== "client-token") return Response.json({ error: "unauthorized", message: "Wrong token." }, { status: 401 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("PK\u0003\u0004 first part "));
        if (options.breakOff) controller.error(new Error("cut off"));
        else {
          controller.enqueue(new TextEncoder().encode("second part"));
          controller.close();
        }
      },
    });
    return new Response(body, { headers: { "content-type": "application/zip" } });
  }) as typeof fetch;
}

function folders() {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-backups-"));
  const state = join(dir, "state");
  const library = join(dir, "My library");
  mkdirSync(state);
  writeFileSync(join(state, LIBRARY_FILE), JSON.stringify({ folder: library }));
  return { dir, state, library, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a backup's name is the day on this computer's calendar", () => {
  assert.equal(backupName(new Date(2026, 10, 3, 23, 30)), "Open Sourcebook backup 2026-11-03.zip");
});

test("a backup is asked of the engine with the client token and saved whole in the library's Backups folder", async () => {
  const f = folders();
  try {
    const seen: string[] = [];
    const now = new Date(2026, 10, 26, 9);
    const saved = await saveBackup({ engine: "http://127.0.0.1:8787", token: "client-token", library: f.library, keep: 4, now, fetchImpl: engine(seen) });
    assert.deepEqual(seen, ["http://127.0.0.1:8787/v1/backup client-token"]);
    assert.equal(saved.file, join(f.library, "Backups", "Open Sourcebook backup 2026-11-26.zip"));
    assert.equal(readFileSync(saved.file, "utf8"), "PK\u0003\u0004 first part second part");
    assert.deepEqual(readdirSync(join(f.library, "Backups")), ["Open Sourcebook backup 2026-11-26.zip"], "nothing else is left beside it");
  } finally {
    f.done();
  }
});

test("a backup cut off on the way is not saved, and leaves nothing behind; the engine's own words say why it said no", async () => {
  const f = folders();
  try {
    const now = new Date(2026, 10, 26);
    await assert.rejects(saveBackup({ engine: "http://127.0.0.1:1", token: "client-token", library: f.library, keep: 4, now, fetchImpl: engine([], { breakOff: true }) }), /not saved whole/);
    assert.deepEqual(readdirSync(join(f.library, "Backups")), []);
    await assert.rejects(saveBackup({ engine: "http://127.0.0.1:1", token: "client-token", library: f.library, keep: 4, now, fetchImpl: engine([], { status: 501 }) }), /The engine said no\./);
  } finally {
    f.done();
  }
});

test("the newest few are kept, and only files with a backup's exact name are ever deleted", async () => {
  const f = folders();
  try {
    const folder = join(f.library, "Backups");
    mkdirSync(folder, { recursive: true });
    const theirs = ["Open Sourcebook backup 2026-01-01 copy.zip", "notes.txt", "Open Sourcebook backup 2020-01-01.zip.bak"];
    for (const name of [...theirs, "Open Sourcebook backup 2026-10-01.zip", "Open Sourcebook backup 2026-10-08.zip", "Open Sourcebook backup 2026-10-15.zip"]) writeFileSync(join(folder, name), "x");
    mkdirSync(join(folder, "Open Sourcebook backup 2019-01-01.zip"));
    const saved = await saveBackup({ engine: "http://127.0.0.1:1", token: "client-token", library: f.library, keep: 2, now: new Date(2026, 10, 26), fetchImpl: engine() });
    assert.deepEqual(saved.removed.map((p) => p.slice(folder.length + 1)), ["Open Sourcebook backup 2026-10-08.zip", "Open Sourcebook backup 2026-10-01.zip"]);
    assert.deepEqual(readdirSync(folder).sort(), [...theirs, "Open Sourcebook backup 2019-01-01.zip", "Open Sourcebook backup 2026-10-15.zip", "Open Sourcebook backup 2026-11-26.zip"].sort(), "a folder with a backup's name is left too");
  } finally {
    f.done();
  }
});

test("the weekly backup is off until turned on; then it is due with none yet, a week after the last, and a few hours after a failure", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  assert.equal(isDue({ on: false, keep: 4 }, now), false);
  assert.equal(isDue({ on: true, keep: 4 }, now), true);
  assert.equal(isDue({ on: true, keep: 4, last: new Date(now - 6 * DAY).toISOString() }, now), false);
  assert.equal(isDue({ on: true, keep: 4, last: new Date(now - WEEK_MS).toISOString() }, now), true);
  assert.equal(isDue({ on: true, keep: 4, last: new Date(now - 8 * DAY).toISOString(), failed: { at: new Date(now - 60_000).toISOString(), message: "x" } }, now), false);
  assert.equal(isDue({ on: true, keep: 4, last: new Date(now - 8 * DAY).toISOString(), failed: { at: new Date(now - DAY).toISOString(), message: "x" } }, now), true);
  assert.equal(keepOf("4"), 4);
  assert.equal(keepOf("0"), undefined);
  assert.equal(keepOf("53"), undefined);
  assert.equal(keepOf(2.5), undefined);
});

test("the schedule backs up when due, keeps when and where, says a failure in plain words, and does nothing while off", async () => {
  const f = folders();
  try {
    let now = Date.parse("2026-11-26T12:00:00Z");
    const seen: string[] = [];
    const said: string[] = [];
    let fetchImpl = engine(seen);
    const schedule = new BackupSchedule({ state: f.state, engine: "http://127.0.0.1:8787", token: "client-token", say: (l) => said.push(l), now: () => now, fetchImpl: (...a) => fetchImpl(...a) });
    assert.deepEqual(readBackupSettings(f.state), { on: false, keep: DEFAULT_KEEP });
    await schedule.look();
    assert.equal(seen.length, 0, "off: nothing is asked");
    schedule.set({ on: true, keep: 3 });
    await schedule.look();
    assert.equal(seen.length, 1, "turned on with none yet: one now");
    const view = schedule.view();
    assert.equal(view.on, true);
    assert.equal(view.keep, 3);
    assert.equal(view.last, new Date(now).toISOString());
    assert.equal(view.folder, join(f.library, "Backups"));
    assert.ok(view.file && existsSync(view.file));
    now += DAY;
    await schedule.look();
    assert.equal(seen.length, 1, "not again within the week");
    now += WEEK_MS;
    fetchImpl = engine(seen, { status: 503 });
    await schedule.look();
    assert.equal(schedule.view().failed?.message, "The engine said no.");
    assert.match(said.at(-1)!, /did not work: The engine said no\./);
    now += 7 * 60 * 60_000;
    fetchImpl = engine(seen);
    await schedule.look();
    assert.equal(schedule.view().failed, undefined, "a backup that worked clears the failure");
    schedule.set({ on: false });
    now += 2 * WEEK_MS;
    const before = seen.length;
    await schedule.look();
    assert.equal(seen.length, before);
  } finally {
    f.done();
  }
});

test("a damaged settings file is the usual settings", () => {
  const f = folders();
  try {
    writeFileSync(join(f.state, "backups.json"), "{ not json");
    assert.deepEqual(readBackupSettings(f.state), { on: false, keep: DEFAULT_KEEP });
    writeBackupSettings(f.state, { on: true, keep: 99 });
    assert.equal(readBackupSettings(f.state).keep, DEFAULT_KEEP, "a count past the most is the usual one");
  } finally {
    f.done();
  }
});

function call(port: number, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, "x-phone-token": "phone-token-0123456789" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("Settings › Backups reaches the schedule through the launcher's control: its view, on and off, and how many are kept", async () => {
  const f = folders();
  const schedule = new BackupSchedule({ state: f.state, engine: "http://127.0.0.1:1", token: "client-token", fetchImpl: engine() });
  const phone = new Phone({ home: f.state, webPort: 1, doorPort: 0, controlPort: 0, token: "phone-token-0123456789", say: () => undefined, ansi: false, listenHost: "127.0.0.1", backups: schedule });
  try {
    await phone.start(false);
    const port = phone.controlPort;
    const first = await call(port, "GET", "/launcher/backups");
    assert.equal(first.status, 200);
    assert.equal(first.body.on, false);
    assert.equal(first.body.folder, join(f.library, "Backups"));
    assert.equal((await call(port, "POST", "/launcher/backups/keep/6")).body.keep, 6);
    assert.equal((await call(port, "POST", "/launcher/backups/keep/0")).status, 400);
    assert.equal((await call(port, "POST", "/launcher/backups/on")).body.on, true);
    await schedule.look();
    assert.equal((await call(port, "POST", "/launcher/backups/off")).body.on, false);
    assert.ok(readBackupSettings(f.state).last, "turning it on made the first one");
  } finally {
    await phone.stop();
    f.done();
  }
});
