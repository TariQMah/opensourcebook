import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadSecrets, newSecret, readSecrets, SECRET_NAMES } from "../secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-secrets-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("makes every secret once, in a file only the person can read", () => {
  const file = join(dir, "a", ".opensourcebook", "secrets.json");
  const first = loadSecrets(file);
  assert.deepEqual(first.created, [...SECRET_NAMES]);
  for (const name of SECRET_NAMES) assert.ok(first.secrets[name].length >= 40);
  assert.equal(new Set(Object.values(first.secrets)).size, SECRET_NAMES.length, "each secret is its own");
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "a", ".opensourcebook")).mode & 0o777, 0o700);
  }
});

test("a second start reuses the same secrets and does not rewrite the file", () => {
  const file = join(dir, "b.json");
  const first = loadSecrets(file);
  const before = statSync(file).mtimeMs;
  const second = loadSecrets(file, () => assert.fail("no new secret should be made"));
  assert.deepEqual(second.secrets, first.secrets);
  assert.deepEqual(second.created, []);
  assert.equal(statSync(file).mtimeMs, before);
});

test("a name the file lacks is added, the others kept", () => {
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify({ OPENSOURCEBOOK_CLIENT_TOKEN: "kept-kept-kept-kept-kept", SOMETHING_ELSE: "x" }));
  const { secrets, created } = loadSecrets(file, () => "made-made-made-made-made");
  assert.equal(secrets.OPENSOURCEBOOK_CLIENT_TOKEN, "kept-kept-kept-kept-kept");
  assert.deepEqual(created, SECRET_NAMES.filter((n) => n !== "OPENSOURCEBOOK_CLIENT_TOKEN"));
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  assert.equal(stored.SOMETHING_ELSE, "x");
  assert.equal(stored.SCENES_TOKEN, "made-made-made-made-made");
});

test("a secret too short to be one is made again", () => {
  const file = join(dir, "d.json");
  writeFileSync(file, JSON.stringify({ OPENSOURCEBOOK_CLIENT_TOKEN: "short" }));
  assert.ok(loadSecrets(file).created.includes("OPENSOURCEBOOK_CLIENT_TOKEN"));
});

test("a broken file says what to do in one sentence", () => {
  const file = join(dir, "e.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => loadSecrets(file), /Delete that file and start again/);
});

test("secrets are random and safe in env files and headers", () => {
  const a = newSecret();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newSecret());
});

test("a file from before the rename keeps its tokens: carried to the new names, never made again", () => {
  const file = join(dir, "old.json");
  const old = { RE_CLIENT_TOKEN: "client-client-client-client", RE_CONNECTOR_TOKEN: "connector-connector-connector", SCENES_CONNECTOR_TOKEN: "scenes-connector-token-x", SCENES_TOKEN: "scenes-scenes-scenes-scenes", PHONE_TOKEN: "phone-phone-phone-phone", FILES_TOKEN: "files-files-files-files" };
  writeFileSync(file, JSON.stringify(old));
  // A status or any other command reads them under the new names and writes nothing.
  const read = readSecrets(file);
  assert.equal(read?.OPENSOURCEBOOK_CLIENT_TOKEN, old.RE_CLIENT_TOKEN);
  assert.equal(read?.OPENSOURCEBOOK_CONNECTOR_TOKEN, old.RE_CONNECTOR_TOKEN);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old, "reading changes nothing");
  // A start carries them over and writes the new names beside the old ones.
  const { secrets, created } = loadSecrets(file, () => assert.fail("no token is made again"));
  assert.deepEqual(created, []);
  assert.equal(secrets.OPENSOURCEBOOK_CLIENT_TOKEN, old.RE_CLIENT_TOKEN);
  assert.equal(secrets.OPENSOURCEBOOK_CONNECTOR_TOKEN, old.RE_CONNECTOR_TOKEN);
  assert.equal(secrets.PHONE_TOKEN, old.PHONE_TOKEN);
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  assert.equal(stored.OPENSOURCEBOOK_CLIENT_TOKEN, old.RE_CLIENT_TOKEN);
  assert.equal(stored.OPENSOURCEBOOK_CONNECTOR_TOKEN, old.RE_CONNECTOR_TOKEN);
  assert.equal(stored.RE_CLIENT_TOKEN, old.RE_CLIENT_TOKEN, "the old name stays, so a launcher from before the rename reads what it always did");
  // And the start after that has nothing left to do.
  const before = statSync(file).mtimeMs;
  assert.deepEqual(loadSecrets(file, () => assert.fail("no token is made again")).secrets, secrets);
  assert.equal(statSync(file).mtimeMs, before);
});

test("when a file holds a token under both names, the new name is the one used", () => {
  const file = join(dir, "both.json");
  writeFileSync(file, JSON.stringify({ RE_CLIENT_TOKEN: "old-old-old-old-old-old", OPENSOURCEBOOK_CLIENT_TOKEN: "new-new-new-new-new-new" }));
  assert.equal(readSecrets(file)?.OPENSOURCEBOOK_CLIENT_TOKEN, "new-new-new-new-new-new");
  assert.equal(readSecrets(join(dir, "not-there.json")), undefined);
});
