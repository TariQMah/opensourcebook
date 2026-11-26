import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { layout, type Carried } from "../src/paths.ts";
import { prepare } from "../src/prepare.ts";

const INSTALLER = join(import.meta.dirname, "..", "..", "install", "package", "lib");

/** An archive like the payload: one top folder holding package.json and a file. */
function archive(dir: string, name: string, marker: string): string {
  const top = join(dir, `${name}-src`, "opensourcebook");
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, "package.json"), JSON.stringify({ name: "x", bin: { opensourcebook: "cli/opensourcebook.mjs" } }));
  writeFileSync(join(top, "marker.txt"), marker);
  mkdirSync(join(top, "cli"));
  writeFileSync(join(top, "cli", "opensourcebook.mjs"), "");
  const file = join(dir, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", join(dir, `${name}-src`), "opensourcebook"]);
  return file;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "osb-prepare-"));
  const at = layout(join(dir, "data"));
  const payloadInfo = join(dir, "payload.json");
  writeFileSync(payloadInfo, JSON.stringify({ version: "0.2.0", commit: "aaa" }));
  const carried: Carried = { node: process.execPath, installer: INSTALLER, payload: archive(dir, "carried", "carried"), payloadInfo };
  // ffmpeg and ffprobe "on the PATH", so nothing is fetched.
  const tools = join(dir, "tools");
  mkdirSync(tools);
  for (const name of ["ffmpeg", "ffprobe"]) {
    writeFileSync(join(tools, name), "#!/bin/sh\n");
    chmodSync(join(tools, name), 0o755);
  }
  const env = { ...process.env, PATH: `${tools}:/usr/bin:/bin` };
  return { dir, at, carried, env };
}

test("the first start puts the carried programs in app/ and remembers which version they are", async () => {
  const { at, carried, env } = setup();
  let stops = 0;
  const said: string[] = [];
  const ready = await prepare({ at, carried, env, say: (l) => said.push(l), stopRunning: async () => void stops++ });
  assert.equal(readFileSync(join(at.app, "marker.txt"), "utf8"), "carried");
  assert.deepEqual(ready.installed, { version: "0.2.0", commit: "aaa", source: "carried" });
  assert.equal(ready.changed, undefined);
  assert.ok(said.some((l) => /first start/.test(l)));
  // A second start changes nothing.
  const again = await prepare({ at, carried, env, say: () => {}, stopRunning: async () => void stops++ });
  assert.equal(again.changed, undefined);
  assert.equal(stops, 1);
});

test("files that are not whole are put in place again", async () => {
  const { at, carried, env } = setup();
  await prepare({ at, carried, env, say: () => {}, stopRunning: async () => {} });
  rmSync(join(at.app, "cli", "opensourcebook.mjs"));
  await prepare({ at, carried, env, say: () => {}, stopRunning: async () => {} });
  assert.ok(existsSync(join(at.app, "cli", "opensourcebook.mjs")));
});

test("a downloaded update is put in place at the next start, keeping the person's files", async () => {
  const { dir, at, carried, env } = setup();
  await prepare({ at, carried, env, say: () => {}, stopRunning: async () => {} });
  writeFileSync(join(at.app, "my-project.txt"), "mine");
  mkdirSync(at.updates, { recursive: true });
  execFileSync("cp", [archive(dir, "next", "release"), join(at.updates, "next.tar.gz")]);
  writeFileSync(join(at.updates, "next.json"), JSON.stringify({ version: "0.2.1", notes: "Faster." }));
  const ready = await prepare({ at, carried, env, say: () => {}, stopRunning: async () => {} });
  assert.equal(readFileSync(join(at.app, "marker.txt"), "utf8"), "release");
  assert.equal(readFileSync(join(at.app, "my-project.txt"), "utf8"), "mine");
  assert.deepEqual(ready.changed, { version: "0.2.1", notes: "Faster." });
  assert.equal(ready.installed.source, "release");
  assert.ok(!existsSync(join(at.updates, "next.tar.gz")));
});
