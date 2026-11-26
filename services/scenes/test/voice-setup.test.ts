/**
 * The voice set up in the app (src/voice-setup.ts) and its routes on the service: a key is checked and kept in the
 * private file, never in an answer or a log line; a refused key is not kept; a change speaks the next video at once.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Connector } from "../src/connector.ts";
import { Jobs } from "../src/jobs.ts";
import { createScenesServer } from "../src/server.ts";
import { listStyles, allStyles } from "../src/styles.ts";
import { silentVoice, type Voice } from "../src/voice.ts";
import { VoiceSetup, VoiceSetupError } from "../src/voice-setup.ts";
import type { VoiceService } from "../src/voices.ts";

const KEY = "acme-secret-key-0123456789abcd";
const BAD = "bad-secret-key-0123456789wxyz";
const POOR = "poor-secret-key-0123456789lmno";
const dirs: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeVoice(id: string, voice?: string): Voice {
  return { ...silentVoice(), id, label: `${id}${voice ? ` (${voice})` : ""}`, real: true };
}

function fakeServices(local: { installed: boolean }): () => VoiceService[] {
  const acme: VoiceService = {
    id: "acme",
    label: "Acme",
    where: "hosted",
    about: "A hosted voice for tests.",
    key: { name: "ACME_KEY", label: "Your Acme key", helpUrl: "https://acme.example/keys", steps: ["Make an account.", "Paste the key here."] },
    voiceSetting: "ACME_VOICE",
    offered: true,
    listVoices: async (key) => {
      assert.ok(key);
      return [{ id: "v1", label: "Vee", sample: true }, { id: "v2", label: "Wu", sample: false }];
    },
    sample: async (voiceId) => {
      if (voiceId !== "v1") throw new (await import("../src/voices.ts")).NoSample();
      return { bytes: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg" };
    },
    // A service that echoes the key back in its words, as some do: the setup must clean it out.
    checkKey: async (key) => (key === BAD ? { ok: false, trouble: "refused", message: `key ${key} refused` } : key === POOR ? { ok: false, trouble: "credits", message: `account of ${key} has no credits` } : { ok: true }),
    build: (s) => fakeVoice("acme", s.ACME_VOICE),
  };
  const home: VoiceService = { id: "home", label: "On this computer", where: "local", about: "A local voice for tests.", installed: () => local.installed, install: { command: "npm run voice:home", folder: "services/scenes" }, offered: true, build: () => fakeVoice("home") };
  const say: VoiceService = { id: "say", label: "Say", where: "local", about: "test only", offered: false, build: () => fakeVoice("say") };
  return () => [acme, home, say];
}

function setupIn(env: Record<string, string | undefined> = {}, local = { installed: false }) {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-voice-setup-"));
  dirs.push(dir);
  const file = join(dir, "state", "voice.json");
  return { setup: new VoiceSetup({ env, file, services: fakeServices(local), installed: () => ({ home: local.installed }) }), file, dir, local };
}

async function refused(work: Promise<unknown>, status: number, code: string): Promise<VoiceSetupError> {
  const error = await work.then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof VoiceSetupError, `expected ${code}, got ${String(error)}`);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return error;
}

test("a refused key is not kept; a good one and one out of credits are, in a file for its owner alone, and never come back", async () => {
  const { setup, file } = setupIn();
  assert.equal((await setup.setup()).from, "none");
  const no = await refused(setup.setKey("acme", { key: BAD }), 422, "key_refused");
  assert.ok(!no.message.includes(BAD));
  assert.throws(() => statSync(file), "nothing written for a refused key");

  const poor = await setup.setKey("acme", { key: POOR });
  assert.deepEqual(poor.service.health, { ok: false, trouble: "credits", message: "account of (your key) has no credits" });
  assert.ok(!JSON.stringify(poor).includes(POOR));
  const good = await setup.setKey("acme", { key: KEY });
  assert.equal(good.service.keySet, true);
  assert.equal(good.service.keyHint, KEY.slice(-4));
  assert.deepEqual(good.service.health, { ok: true });
  assert.ok(!JSON.stringify(good).includes(KEY));
  // Windows has no POSIX file modes (a file there reads as 0o666), so who may read it is not a mode to check.
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).ACME_KEY, KEY);

  // With its key kept the service is the voice, chosen by the app's key.
  const view = await setup.setup();
  assert.equal(view.service, "acme");
  assert.equal(view.from, "app");
  assert.ok(!JSON.stringify(view).includes(KEY));
  assert.deepEqual(view.services.map((s) => s.id), ["acme", "home"], "only offered services");
  await refused(setup.setKey("acme", { key: "has space" }), 400, "invalid_request");
  await refused(setup.setKey("home", { key: KEY }), 404, "not_found");
});

test("a service that needs a key says the steps to getting one, in its own words", async () => {
  const { setup } = setupIn();
  const services = (await setup.setup()).services;
  assert.deepEqual(services.find((s) => s.id === "acme")!.keySteps, ["Make an account.", "Paste the key here."]);
  assert.equal(services.find((s) => s.id === "home")!.keySteps, undefined);
});

test("choosing a service checks what it needs, and the voice changes at once; none means no sound", async () => {
  const { setup, local } = setupIn();
  await refused(setup.choose({ service: "nobody" }), 400, "unknown_voice_service");
  await refused(setup.choose({ service: "say" }), 400, "unknown_voice_service");
  await refused(setup.choose({ service: "acme" }), 409, "voice_needs_key");
  const notYet = await refused(setup.choose({ service: "home" }), 409, "voice_not_installed");
  assert.match(notYet.message, /npm run voice:home/);
  assert.equal((await setup.setup()).services.find((s) => s.id === "home")!.installed, false);
  local.installed = true;
  assert.equal((await setup.choose({ service: "home" })).service, "home");
  assert.equal(setup.current().id, "home");

  await setup.setKey("acme", { key: KEY });
  assert.equal(setup.current().id, "home", "a key does not undo a choice made in the app");
  const chosen = await setup.choose({ service: "acme", voice: "v1" });
  assert.deepEqual(chosen.voice, { id: "v1", label: "Vee" });
  assert.equal(setup.current().label, "acme (v1)");
  await refused(setup.choose({ service: "home", voice: "v1" }), 400, "invalid_request");

  const none = await setup.choose({ service: null });
  assert.equal(none.service, undefined);
  assert.equal(none.from, "app");
  assert.equal(setup.current().real, false);
});

test("the file wins over the environment; forgetting the app's key leaves a .env key working", async () => {
  const { setup } = setupIn({ ACME_KEY: "env-key-0123456789-efgh", SCENES_VOICE: "acme" }, { installed: true });
  assert.deepEqual([(await setup.setup()).from, setup.current().id], ["env", "acme"]);
  await setup.choose({ service: "home" });
  assert.equal(setup.current().id, "home");
  await setup.setKey("acme", { key: KEY });
  assert.equal((await setup.setup()).services[0]!.keyHint, KEY.slice(-4));
  const after = await setup.clearKey("acme");
  assert.equal(after.services[0]!.keyHint, "efgh", "the .env key still counts");
});

test("forgetting the key of the service chosen in the app goes back to no voice when nothing else has one", async () => {
  const { setup } = setupIn();
  await setup.setKey("acme", { key: KEY });
  await setup.choose({ service: "acme" });
  const after = await setup.clearKey("acme");
  assert.equal(after.service, undefined);
  assert.equal(after.services[0]!.keySet, false);
  assert.equal(setup.current().real, false);
});

test("the routes answer the setup and voices, never with the key, and log no key; the status says a new voice at once", async () => {
  const { setup, dir } = setupIn({}, { installed: true });
  const lines: string[] = [];
  const connector = new Connector({ url: "http://127.0.0.1:9", token: "connector-token-0123456789" });
  const voice = () => setup.current();
  const jobs = new Jobs({ dataDir: dir, connector, voice, styles: listStyles, callbackBase: () => "", log: (l) => lines.push(l) });
  const server = createScenesServer({ token: "scenes-token-0123456789", jobs, connector, voice, setup, styles: allStyles, dataDir: dir, log: (l) => lines.push(l) });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bodies: string[] = [];
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer scenes-token-0123456789", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = r.headers.get("content-type")?.startsWith("application/json") ? await r.text() : "";
    bodies.push(text);
    return { status: r.status, json: text ? JSON.parse(text) : undefined, r };
  };
  assert.equal((await fetch(`${base}/voice/setup`)).status, 401);
  assert.equal((await api("/voice/setup")).json.from, "none");
  assert.equal((await api("/voice/services/acme/voices")).status, 409);
  assert.equal((await api("/voice/services/acme/key", "PUT", { key: BAD })).json.error, "key_refused");
  const put = await api("/voice/services/acme/key", "PUT", { key: KEY });
  assert.equal(put.status, 200);
  assert.equal(put.json.service.keyHint, KEY.slice(-4));
  assert.deepEqual((await api("/voice/services/acme/voices")).json.voices.map((v: { id: string }) => v.id), ["v1", "v2"]);
  const sample = await fetch(`${base}/voice/services/acme/voices/v1/sample`, { headers: { authorization: "Bearer scenes-token-0123456789" } });
  assert.equal(sample.headers.get("content-type"), "audio/mpeg");
  assert.equal(sample.headers.get("cache-control"), "private, max-age=3600");
  assert.deepEqual([...new Uint8Array(await sample.arrayBuffer())], [1, 2, 3]);
  assert.equal((await api("/voice/services/acme/voices/v2/sample")).status, 404);
  assert.equal((await api("/voice/setup", "PUT", { service: "home" })).json.service, "home");
  assert.equal((await api("/status")).json.voice.id, "home", "the status says the new voice at once");
  assert.equal((await api("/voice/services/acme/key", "DELETE")).json.services[0].keySet, false);
  assert.equal((await api("/voice/services/nobody/key", "DELETE")).status, 404);
  for (const text of [...bodies, ...lines]) for (const secret of [KEY, BAD]) assert.ok(!text.includes(secret), "no key in an answer or a log line");
});

test("a service with no previews says so, in its view and on every voice in its list, and has no sample to hear", async () => {
  const plain: VoiceService = {
    id: "plain",
    label: "Plain",
    where: "hosted",
    about: "A hosted voice with no previews, for tests.",
    key: { name: "PLAIN_KEY", label: "Your Plain key", helpUrl: "https://plain.example/keys" },
    voiceSetting: "PLAIN_VOICE",
    offered: true,
    // Its own list says a sample: with no previews to hear, the setup says none.
    listVoices: async () => [{ id: "p1", label: "Pea", sample: true }],
    build: (s) => fakeVoice("plain", s.PLAIN_VOICE),
  };
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-voice-setup-"));
  dirs.push(dir);
  const setup = new VoiceSetup({ env: { ACME_KEY: KEY, PLAIN_KEY: KEY }, file: join(dir, "voice.json"), services: () => [...fakeServices({ installed: false })(), plain], installed: () => ({ home: false }) });
  const views = Object.fromEntries((await setup.setup()).services.map((s) => [s.id, s.samples]));
  assert.deepEqual(views, { acme: true, plain: false, home: false });
  assert.deepEqual((await setup.voices("plain")).map((v) => [v.id, v.sample]), [["p1", false]]);
  assert.deepEqual((await setup.voices("acme")).map((v) => [v.id, v.sample]), [["v1", true], ["v2", false]]);
  await refused(setup.sample("plain", "p1"), 404, "not_found");
});
