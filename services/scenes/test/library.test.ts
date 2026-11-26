/** A video's own library folder, sent by the engine for the video's project (docs/JOB-FOLDER.md, "The library"). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readRequest } from "../src/request.ts";

const body = (library?: unknown) => ({
  id: "v1",
  title: "A video",
  passages: [{ id: "p1", sourceId: "s1", sourceTitle: "Notes", text: "Some words." }],
  ...(library !== undefined ? { library } : {}),
});

test("a request may name the folder its finished video is copied into; it must be a whole path", () => {
  const ok = readRequest(body("/Users/me/Documents/Open Sourcebook/Cells"), ["chalkboard"]);
  assert.ok("request" in ok);
  assert.equal(ok.request.library, "/Users/me/Documents/Open Sourcebook/Cells");
  const windows = readRequest(body("C:\\Users\\me\\Documents\\Open Sourcebook\\Cells"), ["chalkboard"]);
  assert.ok("request" in windows && windows.request.library);
  const none = readRequest(body(), ["chalkboard"]);
  assert.ok("request" in none && none.request.library === undefined, "left out, the service's own library is used");
  const bad = readRequest(body("Documents/Cells"), ["chalkboard"]);
  assert.ok("problems" in bad);
  assert.match(bad.problems.join(" "), /library: an absolute path/);
});
