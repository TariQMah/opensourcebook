import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPEN_CODE_LIFE_MS, OpenCodes, askOwnWindow, newRunKeys, openAddress } from "../opener.ts";
import { Phone } from "../phone.ts";

test("opener: a code lets a browser in once, runs out, and only codes the launcher made work", () => {
  let now = 1_000;
  const codes = new OpenCodes(() => now);
  const a = codes.issue();
  const b = codes.issue();
  assert.notEqual(a.code, b.code);
  assert.equal(codes.redeem("not-a-code"), false);
  assert.equal(codes.redeem(undefined), false);
  assert.equal(codes.redeem("x".repeat(500)), false);
  assert.equal(codes.redeem(a.code), true);
  assert.equal(codes.redeem(a.code), false, "a code works once");
  now += OPEN_CODE_LIFE_MS + 1;
  assert.equal(codes.redeem(b.code), false, "and runs out");
  const keys = newRunKeys();
  assert.notEqual(keys.browser, keys.door);
  assert.ok(keys.browser.length >= 43 && keys.door.length >= 43);
});

test("opener: the address shows a path of the app, never another site", () => {
  assert.equal(openAddress("http://127.0.0.1:5173", "c0de", "/projects/p1"), "http://127.0.0.1:5173/api/open?code=c0de&to=%2Fprojects%2Fp1");
  assert.equal(openAddress("http://127.0.0.1:5173/", "c", "//evil.example"), "http://127.0.0.1:5173/api/open?code=c&to=%2F");
  assert.equal(openAddress("http://127.0.0.1:5173", "c", "https://evil.example"), "http://127.0.0.1:5173/api/open?code=c&to=%2F");
});

test("opener: the launcher's control makes and checks codes, only with its token", async () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-open-"));
  const openCodes = new OpenCodes();
  const phone = new Phone({ home, webPort: 1, doorPort: 0, controlPort: 0, token: "phone-token-0123456789", say: () => undefined, ansi: false, listenHost: "127.0.0.1", openCodes });
  try {
    await phone.start(false);
    const base = `http://127.0.0.1:${phone.controlPort}`;
    const post = (path: string, body?: unknown, token = "phone-token-0123456789") =>
      fetch(`${base}${path}`, { method: "POST", headers: { "x-phone-token": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await post("/browser/code", undefined, "wrong-token-0123456789")).status, 401);
    const made = (await (await post("/browser/code")).json()) as { code: string };
    assert.equal((await post("/browser/redeem", { code: made.code }, "wrong-token-0123456789")).status, 401);
    assert.equal((await post("/browser/redeem", { code: "guess" })).status, 403);
    assert.equal((await post("/browser/redeem", { code: made.code })).status, 200);
    assert.equal((await post("/browser/redeem", { code: made.code })).status, 403, "once only");
  } finally {
    await phone.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("an app's own window is asked for a fresh page in its file: the page and when, and no code that lets a browser in", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-window-"));
  try {
    const file = join(dir, "reopen.json");
    assert.equal(askOwnWindow(file, "/projects/p1", new Date("2026-11-26T08:00:00.000Z")), true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { to: "/projects/p1", at: "2026-11-26T08:00:00.000Z" });
    assert.equal(askOwnWindow(join(file, "under-a-file.json"), "/"), false, "a file is no folder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
