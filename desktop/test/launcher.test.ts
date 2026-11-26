import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, lastJson, plainLine } from "../src/launcher.ts";

test("the launcher's answer is its last JSON line", () => {
  assert.deepEqual(lastJson('starting\n{"ok":true,"url":"http://127.0.0.1:5173"}\n'), { ok: true, url: "http://127.0.0.1:5173" });
  assert.equal(lastJson("no json\n[1,2]"), undefined);
});

test("progress lines lose colour codes and spinner frames", () => {
  assert.equal(plainLine("  \x1b[2mInstalling 4 parts\x1b[0m"), "Installing 4 parts");
  assert.equal(plainLine("⠋ Downloading the browser 40%"), "Downloading the browser 40%");
  assert.equal(plainLine("  --- 2026-11-26 03:59:55  opensourcebook start --background, run from /x"), "");
});

test("a failure is the launcher's own message, else its last words", () => {
  assert.equal(failure({ code: 1, json: { ok: false, error: { code: "start_failed", message: "Port in use." } }, said: [] }), "Port in use.");
  assert.equal(failure({ code: 1, said: ["one", "two"] }), "one\ntwo");
  const crash = ["node:internal/modules/cjs/loader:1568", "throw err;", "Error: Cannot find module '/x/cli/opensourcebook.mjs'", "at Module._load", "code: 'MODULE_NOT_FOUND'", "}", "Node.js v24.22.3"];
  assert.match(failure({ code: 1, said: crash }), /^Error: Cannot find module/);
  assert.match(failure({ code: 3, said: [] }), /code 3/);
});
