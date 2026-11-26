import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAndDownload, compareVersions, firstLine, pendingUpdate, planStart, releaseFrom } from "../src/update.ts";

test("versions compare by number, with or without a v", () => {
  assert.ok(compareVersions("v0.2.1", "0.2.0") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.2.0", "v0.2.0"), 0);
  assert.ok(compareVersions("nonsense", "0.0.1") < 0);
});

const carried = { version: "0.2.0", commit: "aaa" };

test("the first start puts the carried version in place", () => {
  assert.deepEqual(planStart(undefined, carried, undefined), { kind: "carried", version: carried });
});

test("a newer downloaded version is put in place at the next start", () => {
  const pending = { version: "0.2.1" };
  assert.deepEqual(planStart({ ...carried, source: "carried" }, carried, pending), { kind: "pending", version: pending });
  assert.deepEqual(planStart(undefined, carried, pending), { kind: "pending", version: pending });
});

test("nothing changes when what is in place is the newest", () => {
  assert.deepEqual(planStart({ ...carried, source: "carried" }, carried, undefined), { kind: "keep" });
  assert.deepEqual(planStart({ version: "0.2.1", source: "release" }, carried, undefined), { kind: "keep" });
  assert.deepEqual(planStart({ version: "0.2.1", source: "release" }, carried, { version: "0.2.1" }), { kind: "keep" });
});

test("a newer app brings its own newer version, over an older waiting download", () => {
  const newer = { version: "0.3.0", commit: "bbb" };
  assert.deepEqual(planStart({ version: "0.2.1", source: "release" }, newer, { version: "0.2.2" }), { kind: "carried", version: newer });
});

test("an app built again from newer files replaces the same version it put there, never a downloaded one", () => {
  const rebuilt = { version: "0.2.0", commit: "ccc" };
  assert.equal(planStart({ ...carried, source: "carried" }, rebuilt, undefined).kind, "carried");
  assert.equal(planStart({ version: "0.2.0", commit: "zzz", source: "release" }, rebuilt, undefined).kind, "keep");
});

test("a release is read from GitHub's answer: its own archive first, else its source archive", () => {
  const base = { tag_name: "v0.2.1", body: "## What changed\n\n- **Videos** start faster.", tarball_url: "https://api.github.com/repos/o/r/tarball/v0.2.1" };
  assert.deepEqual(releaseFrom(base), { version: "0.2.1", archive: base.tarball_url, notes: "What changed" });
  const withAsset = { ...base, assets: [{ name: "opensourcebook-app.tar.gz", browser_download_url: "https://github.com/o/r/releases/download/v0.2.1/opensourcebook-app.tar.gz" }] };
  assert.equal(releaseFrom(withAsset)?.archive, withAsset.assets[0]!.browser_download_url);
  assert.equal(releaseFrom({ ...base, draft: true }), undefined);
  assert.equal(releaseFrom({ ...base, tag_name: "latest" }), undefined);
  assert.equal(releaseFrom({ ...base, tarball_url: "http://plain" }), undefined);
});

test("the first line of notes says something, without Markdown", () => {
  assert.equal(firstLine("\n# \n- *Faster* `videos`\n"), "Faster videos");
  assert.equal(firstLine(""), undefined);
});

function fakeFetch(release: unknown, archive = "the archive") {
  const asked: string[] = [];
  const impl = (async (url: string | URL) => {
    asked.push(String(url));
    if (String(url).includes("/releases/latest")) return new Response(JSON.stringify(release), { status: 200 });
    return new Response(archive, { status: 200 });
  }) as typeof fetch;
  return { impl, asked };
}

const release = { tag_name: "v0.2.1", body: "Faster videos.", tarball_url: "https://example.test/tarball" };

test("a newer release is downloaded into updates/ and waits there", async () => {
  const updates = join(mkdtempSync(join(tmpdir(), "osb-desktop-")), "updates");
  const { impl, asked } = fakeFetch(release);
  const waiting = await checkAndDownload({ repo: "o/r", updates, installed: { version: "0.2.0" }, fetchImpl: impl });
  assert.deepEqual(waiting, { version: "0.2.1", notes: "Faster videos." });
  assert.deepEqual(asked, ["https://api.github.com/repos/o/r/releases/latest", "https://example.test/tarball"]);
  const pending = pendingUpdate(updates);
  assert.equal(pending?.version, "0.2.1");
  assert.equal(readFileSync(pending!.archive, "utf8"), "the archive");
  assert.ok(!existsSync(join(updates, "next.tar.gz.part")));
  // Asked again, the same version is not downloaded twice.
  const again = fakeFetch(release);
  assert.equal(await checkAndDownload({ repo: "o/r", updates, installed: { version: "0.2.0" }, fetchImpl: again.impl }), undefined);
  assert.equal(again.asked.length, 1);
});

test("nothing is downloaded when the release is not newer, or the answer is not there", async () => {
  const updates = join(mkdtempSync(join(tmpdir(), "osb-desktop-")), "updates");
  const same = fakeFetch(release);
  assert.equal(await checkAndDownload({ repo: "o/r", updates, installed: { version: "0.2.1" }, fetchImpl: same.impl }), undefined);
  assert.equal(same.asked.length, 1);
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(await checkAndDownload({ repo: "o/r", updates, installed: { version: "0.2.0" }, fetchImpl: offline }), undefined);
  assert.equal(pendingUpdate(updates), undefined);
});

test("a waiting note without its archive is no update", () => {
  const updates = mkdtempSync(join(tmpdir(), "osb-desktop-"));
  writeFileSync(join(updates, "next.json"), JSON.stringify({ version: "0.2.1" }));
  assert.equal(pendingUpdate(updates), undefined);
});
