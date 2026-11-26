/** The voice services' list (src/voices.ts): what the app offers and how a voice is chosen from it. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseVoice } from "../src/voice-choice.ts";
import { voiceFromEnv } from "../src/voice.ts";
import { elevenOption, elevenService } from "../src/eleven.ts";
import { speechifyOption, speechifyService } from "../src/speechify.ts";
import { layered, readVoiceFile, voiceFileNames, voiceFilePath, writeVoiceFile } from "../src/voice-file.ts";
import { audioTypeOf, fetchPreview, NoSample, voiceServices } from "../src/voices.ts";

test("hosted services come A to Z by label, then local ones; the test voice and no voice are not offered", () => {
  const all = voiceServices();
  const where = all.map((s) => s.where);
  assert.deepEqual(where, [...where].sort((a, b) => (a === b ? 0 : a === "hosted" ? -1 : 1)), "hosted before local");
  const hosted = all.filter((s) => s.where === "hosted").map((s) => s.label);
  assert.deepEqual(hosted, [...hosted].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  assert.deepEqual(all.filter((s) => !s.offered).map((s) => s.id).sort(), ["say", "silent"]);
  for (const s of all) {
    assert.ok(s.id && s.label && s.about, s.id);
    if (s.where === "hosted" && s.offered) assert.ok(s.key?.name && s.key.label && /^https:\/\//.test(s.key.helpUrl), `${s.id} says what key it needs and where to get one`);
    if (s.where === "local" && s.offered) assert.ok(s.install?.command && s.installed, `${s.id} says how to install it`);
  }
  assert.equal(new Set(all.map((s) => s.id)).size, all.length);
});

test("with nothing named, the first hosted service in the list whose key is set is the voice", () => {
  const hosted = voiceServices().filter((s) => s.offered && s.key);
  assert.ok(hosted.length >= 2);
  const both = Object.fromEntries(hosted.map((s) => [s.key!.name, "k"]));
  assert.equal(chooseVoice(both).kind, hosted[0]!.id);
  assert.equal(chooseVoice({ [hosted[1]!.key!.name]: "k" }).kind, hosted[1]!.id);
  assert.equal(chooseVoice({ ...both, SCENES_VOICE: hosted[1]!.id }).kind, hosted[1]!.id);
  for (const s of hosted) assert.throws(() => chooseVoice({ SCENES_VOICE: s.id }), new RegExp(`needs ${s.key!.name}`));
});

test("a local service asked for and not installed says how to install it", () => {
  for (const s of voiceServices().filter((x) => x.offered && x.install)) {
    assert.throws(() => chooseVoice({ SCENES_VOICE: s.id }, { [s.id]: false }), new RegExp(s.install!.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(voiceFromEnv({ SCENES_VOICE: s.id }, undefined, { [s.id]: true }).id, s.id);
  }
});

test("a service's own list is read as voices to pick, with whether each has a sample", () => {
  assert.deepEqual(elevenOption({ voice_id: "v1", name: "Ada", labels: { description: "calm", use_case: "narration", language: "en" }, preview_url: "https://x/a.mp3" }), { id: "v1", label: "Ada", description: "calm, narration", language: "en", sample: true });
  assert.deepEqual(elevenOption({ voice_id: "v2", name: "Bo" }), { id: "v2", label: "Bo", sample: false });
  assert.equal(elevenOption({ name: "no id" }), undefined);
  assert.deepEqual(speechifyOption({ id: "george", display_name: "George", locale: "en-US", tags: ["timbre:deep", "use-case:audiobook"], models: [{ name: "simba-3.5", languages: [{ locale: "en-US", preview_audio: "https://x/g.mp3" }] }] }), { id: "george", label: "George", description: "deep, audiobook", language: "en-US", sample: true });
});

test("the private voice file is laid over the environment, keeps only voice names, and is written for its owner alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-voice-file-"));
  try {
    const services = voiceServices();
    const names = voiceFileNames(services);
    const hosted = services.filter((s) => s.offered && s.key);
    const [first, second] = [hosted[0]!, hosted[1]!];
    assert.equal(voiceFilePath({}, dir), join(dir, "voice.json"));
    assert.equal(voiceFilePath({ SCENES_VOICE_FILE: " /x/v.json " }, dir), "/x/v.json");
    const file = join(dir, "private", "voice.json");
    assert.deepEqual(readVoiceFile(file, names), {});
    writeVoiceFile(file, { SCENES_VOICE: second.id, [second.key!.name]: "file-key" });
    // Windows has no POSIX file modes (a file there reads as 0o666), so who may read it is not a mode to check.
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "private")).mode & 0o777, 0o700);
    }
    // The file wins over the environment: the app's choice overrides a .env that names another voice.
    const env = { [first.key!.name]: "env-key", SCENES_VOICE: first.id };
    const settings = layered(env, readVoiceFile(file, names));
    assert.equal(chooseVoice(settings).kind, second.id);
    assert.equal(settings[first.key!.name], "env-key", "a .env key keeps working");
    // Names that are not the voice's are not read from it.
    writeFileSync(file, JSON.stringify({ SCENES_TOKEN: "x", PATH: "/nowhere", SCENES_VOICE: " silent ", [first.key!.name]: 7 }));
    assert.deepEqual(readVoiceFile(file, names), { SCENES_VOICE: "silent" });
    writeFileSync(file, "not json");
    assert.deepEqual(readVoiceFile(file, names), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 1, 2, 3]);
const served = (bytes: Uint8Array, type: string, status = 200) => async () => new Response(bytes as unknown as BodyInit, { status, headers: { "content-type": type } });

test("a preview served as text or bytes of no type is heard by what its own first bytes say it is", async () => {
  // ElevenLabs' preview files are served as text/plain though they are MP3.
  assert.deepEqual(await fetchPreview("https://store.example/a.mp3", undefined, served(MP3, "text/plain")), { bytes: MP3, contentType: "audio/mpeg" });
  const ogg = new Uint8Array([...Buffer.from("OggS"), 0, 2]);
  assert.equal((await fetchPreview("https://store.example/a.ogg", undefined, served(ogg, "application/octet-stream"))).contentType, "audio/ogg");
  // A served audio type is kept as it is.
  assert.equal((await fetchPreview("https://store.example/a.wav", undefined, served(MP3, "audio/x-wav; charset=binary"))).contentType, "audio/x-wav");
  for (const fetcher of [served(new TextEncoder().encode("<html>no</html>"), "text/html"), served(MP3, "audio/mpeg", 404), served(new Uint8Array(), "text/plain")]) {
    await assert.rejects(fetchPreview("https://store.example/x", undefined, fetcher), NoSample);
  }
  await assert.rejects(fetchPreview("http://store.example/a.mp3", undefined, served(MP3, "audio/mpeg")), NoSample);
  assert.equal(audioTypeOf(new Uint8Array([0xff, 0xfb, 0x90])), "audio/mpeg");
  assert.equal(audioTypeOf(new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")])), "audio/wav");
  assert.equal(audioTypeOf(new Uint8Array([...Buffer.from("fLaC")])), "audio/flac");
  assert.equal(audioTypeOf(new TextEncoder().encode("hello")), undefined);
});

/** Runs `work` with the global fetch answering as a fake hosted service would, by address. */
async function withFetch(answer: (url: string, init?: RequestInit) => Response, work: () => Promise<void>): Promise<string[]> {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    return answer(url, init);
  }) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = real;
  }
  return asked;
}

test("every hosted service that offers previews plays a listed voice's sample, served as text by its storage", async () => {
  const preview = "https://storage.example/premade/v1/preview.mp3";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fake = (url: string, init?: RequestInit) => {
    if (url === preview) {
      assert.equal(new Headers(init?.headers).get("xi-api-key"), null, "the key is never sent to the preview's storage");
      return new Response(MP3 as unknown as BodyInit, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.startsWith("https://api.elevenlabs.io/v1/voices/v1")) return json({ voice_id: "v1", name: "Ada", preview_url: preview });
    if (url.startsWith("https://api.elevenlabs.io/v1/voices")) return json({ voices: [{ voice_id: "v1", name: "Ada", preview_url: preview }] });
    if (url.includes("speechify")) return json([{ id: "v1", display_name: "Ada", locale: "en-US", models: [{ name: "simba", languages: [{ locale: "en-US", preview_audio: preview }] }] }]);
    return new Response("not found", { status: 404 });
  };
  const services = [elevenService(), speechifyService()];
  assert.deepEqual(services.map((s) => s.id).sort(), voiceServices().filter((s) => s.offered && s.where === "hosted" && s.sample).map((s) => s.id).sort(), "every hosted service with previews is tried here");
  for (const service of services) {
    await withFetch(fake, async () => {
      const listed = await service.listVoices!("key-0123456789", undefined);
      assert.deepEqual(listed.map((v) => [v.id, v.sample]), [["v1", true]], service.id);
      const heard = await service.sample!("v1", "key-0123456789", undefined);
      assert.equal(heard.contentType, "audio/mpeg", service.id);
      assert.deepEqual([...heard.bytes], [...MP3], service.id);
    });
  }
});
