/** Finding an agent's program that was installed after the connector started, or in a folder never added to PATH. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { firstLine } from "../src/agents/process.ts";
import { programOf } from "../src/agents/locate.ts";

const has = (paths: string[]) => (p: string) => paths.includes(p);

test("a name on the PATH is kept as it is, and one with a folder is never looked for", () => {
  const env = { PATH: "/usr/bin:/home/ann/.local/bin" };
  assert.equal(programOf("claude", [], { env, platform: "linux", home: "/home/ann", exists: has(["/home/ann/.local/bin/claude"]) }), "claude");
  assert.equal(programOf("/opt/x/claude", [], { env, platform: "linux", home: "/home/ann", exists: has([]) }), "/opt/x/claude");
});

test("on macOS and Linux a program off the PATH is found in the usual install folders, then the adapter's own", () => {
  const env = { PATH: "/usr/bin:/bin" };
  const at = (paths: string[], places: string[] = []) => programOf("claude", places, { env, platform: "darwin", home: "/Users/ann", exists: has(paths) });
  assert.equal(at(["/Users/ann/.local/bin/claude"]), "/Users/ann/.local/bin/claude");
  assert.equal(at(["/opt/homebrew/bin/claude"]), "/opt/homebrew/bin/claude");
  assert.equal(at(["/Users/ann/.claude/local/claude"], [".claude/local"]), "/Users/ann/.claude/local/claude");
  assert.equal(at(["/Users/ann/.claude/local/claude"]), "claude", "an adapter's own place is only looked in for that adapter");
  assert.equal(at([]), "claude", "nowhere: the bare name, reported missing as before");
});

test("on Windows claude.exe in .local\\bin is found though that folder is not on PATH, and a PATH saved after the start is read again", () => {
  const env = { Path: "C:\\Windows\\system32", PATHEXT: ".COM;.EXE;.BAT;.CMD", APPDATA: "C:\\Users\\ann\\AppData\\Roaming" };
  const home = "C:\\Users\\ann";
  const exe = "C:\\Users\\ann\\.local\\bin\\claude.exe";
  assert.equal(programOf("claude", [], { env, platform: "win32", home, exists: has([exe]), savedPath: () => undefined }), exe);
  const npm = "C:\\Users\\ann\\AppData\\Roaming\\npm\\copilot.cmd";
  assert.equal(programOf("copilot", [], { env, platform: "win32", home, exists: has([npm]), savedPath: () => undefined }), npm);
  const elsewhere = "D:\\Tools\\codex\\codex.exe";
  let reads = 0;
  const saved = () => {
    reads += 1;
    return "C:\\Windows\\system32;D:\\Tools\\codex";
  };
  assert.equal(programOf("codex", [], { env, platform: "win32", home, exists: has([elsewhere]), savedPath: saved }), elsewhere);
  assert.equal(programOf("codex", [], { env, platform: "win32", home, exists: has([]), savedPath: saved }), "codex");
  assert.equal(reads, 2, "read again at each look");
  assert.equal(programOf("whoami", [], { env, platform: "win32", home, exists: has(["C:\\Windows\\system32\\whoami.exe"]), savedPath: () => assert.fail("not read when PATH has it") }), "whoami");
});

test("a program installed in ~/.local/bin after the start answers a check", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-locate-"));
  try {
    const env = { PATH: "/usr/bin:/bin" };
    assert.equal((await firstLine(programOf("fake-agent", [], { env, home }), ["--version"])).missing, true);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const file = join(home, ".local", "bin", "fake-agent");
    writeFileSync(file, "#!/bin/sh\necho 1.2.3\n");
    chmodSync(file, 0o755);
    assert.deepEqual(await firstLine(programOf("fake-agent", [], { env, home }), ["--version"]), { text: "1.2.3", missing: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
