/**
 * The voice set up in the app, through the engine (routes/voice.ts): each call reaches the scenes service and its
 * answer comes back read field by field, so a key never reaches the browser even from a careless service; refusals
 * keep their code and words; and after a change audio's readiness follows at once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { AudioVoiceClient } from "../src/engines/audio/voice-client";
import { cachedScenesStatus, forgetScenesStatus, ScenesClient } from "../src/engines/video/scenes/client";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { FakeScenesService } from "./support/fake-scenes";

const URL_ = "http://127.0.0.1:8660";
const KEY = "acme-secret-key-0123456789abcd";

function setup(options: ConstructorParameters<typeof FakeScenesService>[0] = {}) {
  const scenes = new FakeScenesService(options);
  const engine = createTestEngine();
  engine.deps.scenes = new ScenesClient({ url: URL_, token: scenes.token }, scenes.fetch);
  const call = async (path: string, init: Parameters<typeof authed>[1] = {}) => {
    const response = await handleRequest(authed(path, init), engine.deps);
    const text = response.headers.get("content-type")?.startsWith("application/json") ? await response.clone().text() : "";
    return { response, text, body: text ? JSON.parse(text) : undefined };
  };
  return { scenes, engine, call };
}

afterEach(() => forgetScenesStatus());

describe("the voice routes", () => {
  it("answer the setup, take a key and never send it back, even when the service does", async () => {
    const logs = vi.spyOn(console, "log");
    const warns = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");
    const { call, scenes } = setup({ leakKeys: true });
    const first = await call("/v1/voice");
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({ from: "none", services: [{ id: "acme", needsKey: true, keySet: false, keySteps: ["Make an account.", "Paste the key here."], listsVoices: true, samples: true }, { id: "home", where: "local", samples: false, installed: false, install: { command: "npm run voice:home", folder: "services/scenes" } }] });

    const put = await call("/v1/voice/services/acme/key", { method: "PUT", body: { key: KEY } });
    expect(put.response.status).toBe(200);
    expect(put.body.service).toMatchObject({ id: "acme", keySet: true, health: { ok: true } });
    expect(scenes.voiceSetup.keys.acme).toBe(KEY);
    const after = await call("/v1/voice");
    const voices = await call("/v1/voice/services/acme/voices");
    expect(voices.body).toEqual({ voices: [{ id: "v1", label: "Vee", description: "calm", language: "English", sample: true }] });
    for (const answer of [put, after, voices]) {
      expect(answer.text).not.toContain(KEY);
      expect(answer.text).not.toContain(KEY.slice(0, 8));
    }
    // A hint is four characters at most; a careless service's whole key is dropped.
    expect(after.body.services[0].keyHint).toBeUndefined();
    const logged = [...logs.mock.calls, ...warns.mock.calls, ...errors.mock.calls].flat().map(String).join("\n");
    expect(logged).not.toContain(KEY);
  });

  it("pass on the service's refusals with their codes, and check what they send", async () => {
    const { call } = setup();
    expect((await call("/v1/voice", { method: "PUT", body: { service: "acme" } })).body.error).toBe("voice_needs_key");
    expect((await call("/v1/voice", { method: "PUT", body: { service: "home" } })).response.status).toBe(409);
    const unknown = await call("/v1/voice", { method: "PUT", body: { service: "nobody" } });
    expect([unknown.response.status, unknown.body.error]).toEqual([400, "unknown_voice_service"]);
    const refused = await call("/v1/voice/services/acme/key", { method: "PUT", body: { key: "bad-key-0123456789" } });
    expect([refused.response.status, refused.body.error]).toEqual([422, "key_refused"]);
    expect((await call("/v1/voice/services/nobody/key", { method: "PUT", body: { key: KEY } })).response.status).toBe(404);
    expect((await call("/v1/voice/services/acme/key", { method: "PUT", body: { key: "" } })).body.error).toBe("invalid_request");
    expect((await call("/v1/voice/services/acme/key", { method: "PUT", body: { key: "x".repeat(401) } })).body.error).toBe("invalid_request");
    expect((await call("/v1/voice", { method: "PUT", body: { service: 3 } })).body.error).toBe("invalid_request");
    expect((await call("/v1/voice/services/acme/voices")).body.error).toBe("voice_needs_key");
  });

  it("pass a sample on as audio the browser may keep a while", async () => {
    const { call } = setup();
    await call("/v1/voice/services/acme/key", { method: "PUT", body: { key: KEY } });
    const sample = await call("/v1/voice/services/acme/voices/v1/sample");
    expect(sample.response.status).toBe(200);
    expect(sample.response.headers.get("content-type")).toBe("audio/mpeg");
    expect(sample.response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect([...new Uint8Array(await sample.response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await call("/v1/voice/services/acme/voices/v9/sample")).response.status).toBe(404);
  });

  it("make audio ready as soon as a voice is chosen, and not ready once it is gone", async () => {
    const { call, scenes } = setup({ voice: { id: "silent", label: "No voice", real: false, note: "No voice set up." } });
    const audio = new AudioVoiceClient({ url: URL_, token: scenes.token }, scenes.fetch);
    await call("/v1/voice/services/acme/key", { method: "PUT", body: { key: KEY } });
    const chosen = await call("/v1/voice", { method: "PUT", body: { service: "acme", voice: "v1" } });
    expect(chosen.body).toMatchObject({ service: "acme", voice: { id: "v1", label: "Vee" }, from: "app" });
    expect(audio.heard()).toEqual({ ready: true });
    expect(cachedScenesStatus(URL_)?.voice?.id).toBe("acme");
    const cleared = await call("/v1/voice/services/acme/key", { method: "DELETE" });
    expect(cleared.body.service).toBeUndefined();
    expect(cachedScenesStatus(URL_)?.voice?.id).toBe("silent");
  });

  it("say plainly when there is no scenes service, or it does not answer", async () => {
    const engine = createTestEngine();
    const none = await handleRequest(authed("/v1/voice"), engine.deps);
    expect([none.status, (await bodyOf(none)).error]).toEqual([503, "voice_unavailable"]);
    const { call } = setup({ down: true });
    expect((await call("/v1/voice")).body.error).toBe("voice_unavailable");
    const anon = await handleRequest(new Request("https://engine.test/v1/voice"), setup().engine.deps);
    expect(anon.status).toBe(401);
  });
});
