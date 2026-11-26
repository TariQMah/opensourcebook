import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runCommand } from "../commands/index.ts";
import { Phone } from "../phone.ts";
import { VoiceInstalls, installVoice, localVoices, withOwnNode } from "../voice.ts";

/** A copy of Open Sourcebook with two voice folders (one without a package.json) and an npm that says what it was run with. */
function copy(npmExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "opensourcebook-voice-"));
  const voices = join(root, "services", "scenes", "voices");
  mkdirSync(join(voices, "calm"), { recursive: true });
  writeFileSync(join(voices, "calm", "package.json"), "{}\n");
  mkdirSync(join(voices, "notes"), { recursive: true });
  const npm = join(root, "fake-npm");
  writeFileSync(npm, `#!/bin/sh\necho "npm $*"\necho "PATH=$PATH"\npwd > ran-here\nexit ${npmExit}\n`);
  chmodSync(npm, 0o755);
  return { root, home: join(root, ".opensourcebook"), npm, remove: () => rmSync(root, { recursive: true, force: true }) };
}

const posixOnly = { skip: process.platform === "win32" ? "the fake npm is a shell script" : false };

test("the voices that can be installed are the voice folders with a package.json", () => {
  const c = copy();
  try {
    assert.deepEqual(localVoices(c.root), ["calm"]);
    assert.deepEqual(localVoices(join(c.root, "nowhere")), []);
  } finally {
    c.remove();
  }
});

test("npm runs with the Node of this run first on the PATH, so a computer with no npm of its own can install", () => {
  assert.equal(withOwnNode({ PATH: "/usr/bin" }, "/home/ann/.opensourcebook/node/bin/node").PATH, `/home/ann/.opensourcebook/node/bin${process.platform === "win32" ? ";" : ":"}/usr/bin`);
  assert.deepEqual(Object.keys(withOwnNode({ Path: "C:\\Windows" }, "C:\\node\\node.exe")), ["Path"], "the PATH keeps its own spelling");
});

test("a voice is installed in its own folder, npm's words in the log; one that fails says so; a name that is no voice is refused", posixOnly, async () => {
  const c = copy();
  const bad = copy(1);
  try {
    const log = join(c.home, "logs", "voice-calm.log");
    const done = await installVoice(c.root, "calm", log, { npm: c.npm, env: { PATH: "/usr/bin:/bin" } });
    assert.deepEqual(done, { ok: true, log });
    const said = readFileSync(log, "utf8");
    assert.match(said, /^npm ci --no-audit --no-fund|^npm install --no-audit --no-fund/m);
    assert.ok(said.includes(`PATH=${dirname(process.execPath)}:/usr/bin:/bin`));
    assert.equal(readFileSync(join(c.root, "services", "scenes", "voices", "calm", "ran-here"), "utf8").trim().endsWith(join("voices", "calm")), true);
    assert.equal((await installVoice(bad.root, "calm", join(bad.home, "v.log"), { npm: bad.npm })).ok, false);
    assert.throws(() => installVoice(c.root, "notes", log), /"notes" is not a voice that runs on this computer; there are calm\./);
  } finally {
    c.remove();
    bad.remove();
  }
});

function call(port: number, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, "x-phone-token": "phone-token-0123456789" } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the voice screen's button: the launcher starts an install, says it is installing, then done", posixOnly, async () => {
  const c = copy();
  mkdirSync(c.home, { recursive: true });
  const phone = new Phone({ home: c.home, webPort: 1, doorPort: 0, controlPort: 0, token: "phone-token-0123456789", say: () => undefined, ansi: false, listenHost: "127.0.0.1", voices: new VoiceInstalls({ root: c.root, home: c.home, npm: c.npm }) });
  try {
    await phone.start(false);
    const port = phone.controlPort;
    assert.deepEqual((await call(port, "GET", "/launcher/voices/calm")).body, { voice: "calm", state: "idle" });
    const started = await call(port, "POST", "/launcher/voices/calm/install");
    assert.equal(started.status, 202);
    assert.equal(started.body.state, "installing");
    let now = started.body;
    for (let i = 0; i < 50 && now.state === "installing"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      now = (await call(port, "GET", "/launcher/voices/calm")).body;
    }
    assert.deepEqual(now, { voice: "calm", state: "done" });
    assert.equal((await call(port, "POST", "/launcher/voices/notes/install")).status, 404);
  } finally {
    await phone.stop();
    c.remove();
  }
});

test("opensourcebook voice install names the voices there are when asked for one that is not", async () => {
  const c = copy();
  const out: string[] = [];
  try {
    const code = await runCommand(["voice", "install", "loud"], { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env: {}, cwd: c.root, root: c.root, home: c.home, pollMs: 1 });
    assert.equal(code, 1);
    assert.match(out.join("\n"), /"loud" is not a voice that runs on this computer\. There is calm\./);
  } finally {
    c.remove();
  }
});
