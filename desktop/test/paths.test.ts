import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { appDataRoot, carried, layout } from "../src/paths.ts";

test("the app data folder is the system's own place for it, named Open Sourcebook", () => {
  assert.equal(appDataRoot("darwin", {}, "/Users/ana"), "/Users/ana/Library/Application Support/Open Sourcebook");
  assert.equal(appDataRoot("linux", {}, "/home/ana"), "/home/ana/.local/share/Open Sourcebook");
  assert.equal(appDataRoot("linux", { XDG_DATA_HOME: "/data" }, "/home/ana"), "/data/Open Sourcebook");
  assert.equal(appDataRoot("win32", { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" }, "C:\\Users\\ana"), "C:\\Users\\ana\\AppData\\Roaming\\Open Sourcebook");
  assert.equal(appDataRoot("win32", {}, "C:\\Users\\ana"), "C:\\Users\\ana\\AppData\\Roaming\\Open Sourcebook");
});

test("OPENSOURCEBOOK_APP_DATA names another folder", () => {
  assert.equal(appDataRoot("darwin", { OPENSOURCEBOOK_APP_DATA: " /tmp/osb " }, "/Users/ana"), "/tmp/osb");
});

test("the programs sit in app/ inside the app data folder, the installer's own layout", () => {
  const at = layout("/r");
  assert.equal(at.app, join("/r", "app"));
  assert.equal(at.bin, join("/r", "bin"));
  assert.equal(at.updates, join("/r", "updates"));
  assert.notEqual(at.shell, at.root);
});

test("what the app carries is found in its resources", () => {
  assert.equal(carried("/R", "darwin").node, join("/R", "node", "bin", "node"));
  assert.equal(carried("/R", "win32").node, join("/R", "node", "node.exe"));
  assert.equal(carried("/R").payload, join("/R", "payload", "opensourcebook.tar.gz"));
});
