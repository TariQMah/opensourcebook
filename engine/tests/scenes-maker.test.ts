/**
 * The scenes maker over a fake scenes service that speaks the wire
 * contract: a video made end to end with its steps shown, Open Sourcebook's checks as
 * the last gate with one send-back, re-attaching on redelivery, a fresh
 * video on retry, Stop, failures in plain words, what is said before Start,
 * the settings it brings, the routes, and the local-only wiring.
 */
import { PACK_FILES } from "../src/chat/agent/pack-files";
import { afterEach, describe, expect, it } from "vitest";
import { AssetStore } from "../src/assets";
import { videoDefinitionFor, type VideoSettings } from "../src/engines/video/definition";
import { VideoMakerRegistry } from "../src/engines/video/makers";
import { cachedScenesStatus, forgetScenesStatus, refreshScenesStatus, ScenesClient } from "../src/engines/video/scenes/client";
import { createScenesMaker, expectedDone } from "../src/engines/video/scenes/maker";
import { handleRequest } from "../src/index";
import { failureCodeOf, failureWords } from "../src/jobs/failure-words";
import { JobFailure } from "../src/jobs/lifecycle";
import { JobWait } from "../src/jobs/waits";
import { InMemoryUsageSink } from "../src/providers/usage";
import { DRAFT_KEY, FormatRegistry, runEngine } from "../src/studio/registry";
import type { EngineCheckpoint, EngineContext, EngineProgress, JsonValue, NodeSource } from "../src/studio/types";
import type { SourceEnvelope } from "../src/types";
import type { WorkerEnv } from "../src/types";
import { depsForEnv, videoMakersFromEnv, type EngineDeps } from "../src/wiring";
import { createSqliteD1 } from "./support/sqlite-d1";
import { FakeR2Bucket } from "./support/fake-r2";
import { FakeScenesService } from "./support/fake-scenes";
import { authed, createTestEngine } from "./support/engine-harness";

const V1 = "Sunlight scatters off the small molecules of the air, and blue light scatters the most because its waves are short.";
const V2 = "At sunset the light crosses far more air, so the blue is scattered away before it reaches you and the reds remain.";

function envelope(text: string): SourceEnvelope {
  return { originalText: text, kind: "text", title: "Sky notes", text, references: [], metadata: {}, accessLevel: "full", depthCap: "light", limitations: [], fetchedAt: "2026-11-15T09:00:00.000Z" };
}

const source: NodeSource = {
  sourceId: "src-1",
  title: "Sky notes",
  envelope: envelope(`${V1}\n\n${V2}`),
  chunks: [
    { id: "chunk-1", ord: 0, text: V1, locator: { page: 1 } },
    { id: "chunk-2", ord: 1, text: V2, locator: { page: 2 } },
  ],
};

const SERVICE = "http://127.0.0.1:8660";

function memoryCheckpoint(): EngineCheckpoint & { values: Map<string, JsonValue> } {
  const values = new Map<string, JsonValue>();
  return { values, get: (key) => values.get(key), put: async (key, value) => void values.set(key, JSON.parse(JSON.stringify(value))) };
}

function setup(options: { service?: FakeScenesService; settings?: Partial<VideoSettings>; checkpoint?: ReturnType<typeof memoryCheckpoint>; signal?: AbortSignal; clock?: () => number } = {}) {
  const service = options.service ?? new FakeScenesService();
  const client = new ScenesClient({ url: SERVICE, token: service.token }, service.fetch);
  const maker = createScenesMaker({ client, pollMs: 0, sleep: async () => undefined, ...(options.clock ? { clock: options.clock } : {}) });
  const makers = new VideoMakerRegistry().register(maker);
  const definition = videoDefinitionFor(makers);
  const usage = new InMemoryUsageSink();
  const bucket = new FakeR2Bucket();
  const progress: EngineProgress[] = [];
  const checkpoint = options.checkpoint ?? memoryCheckpoint();
  const ctx: EngineContext<VideoSettings> = {
    jobId: "job-1",
    node: { id: "node-1", type: "video", title: "Why the sky is blue", prompt: "Explain the colours of the sky.", settings: { minutes: 0, aspect: "portrait", ...options.settings } },
    sources: [source],
    assumes: [{ nodeId: "n0", outputId: "o0", type: "byte", title: "Light", summary: "What light is." }],
    inputs: [],
    services: {
      provider: { name: "none", generateJSON: async () => Promise.reject(new Error("the scenes maker calls no Open Sourcebook model")) },
      assets: new AssetStore(bucket),
      usage,
      fetch: async () => new Response(null),
      now: () => "2026-11-15T10:00:00.000Z",
      progress: (update) => void progress.push(update),
      checkpoint,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  };
  return { service, client, maker, makers, definition, usage, bucket, progress, checkpoint, ctx };
}

afterEach(() => forgetScenesStatus());

describe("scenes maker: making a video", () => {
  it("sends the project's packs with the video as skills, each by folder with its files, and none when no pack is on", async () => {
    const name = Object.keys(PACK_FILES)[0]!.split("/")[0]!;
    const t = setup({ settings: { style: "blueprint", minutes: 1 } });
    t.ctx.project = { id: "p1", title: "Sky", packs: [name, "no-such-pack"] };
    await refreshScenesStatus(t.client);
    await runEngine(t.definition, t.ctx);
    const sent = t.service.videos.get("job-1")!.body as { skills?: Array<{ name: string; files: Record<string, string> }> };
    expect(sent.skills?.map((skill) => skill.name)).toEqual([name]);
    expect(sent.skills![0]!.files["SKILL.md"]).toBe(PACK_FILES[`${name}/SKILL.md`]);

    const plain = setup({ settings: { style: "blueprint", minutes: 1 } });
    await runEngine(plain.definition, plain.ctx);
    expect(plain.service.videos.get("job-1")!.body).not.toHaveProperty("skills");
  });

  it("sends each source's address and the pictures kept from it, by their path on the engine, for the job folder", async () => {
    const t = setup({ settings: { style: "blueprint", minutes: 1 } });
    t.ctx.sources = [{ ...source, envelope: { ...source.envelope, kind: "pdf", originalURL: "https://example.org/sky.pdf", assets: [
      { id: "a1", kind: "figure", url: "/v1/assets/a1", caption: "Figure 1", page: 2, contentType: "image/png" },
      { id: "a2", kind: "audio", url: "/v1/assets/a2" },
    ] } }];
    await runEngine(t.definition, t.ctx);
    expect(t.service.videos.get("job-1")!.body.sources).toEqual([
      { id: "src-1", title: "Sky notes", kind: "pdf", url: "https://example.org/sky.pdf", pictures: [{ url: "/v1/assets/a1", kind: "figure", caption: "Figure 1", page: 2, contentType: "image/png" }] },
    ]);
  });

  it("sends a linked folder's file by its path, and the folder the finished video is copied into", async () => {
    const t = setup({ settings: { style: "blueprint", minutes: 1 } });
    t.ctx.sources = [{ ...source, path: "/Users/me/Course/sky.md" }];
    t.ctx.services.libraryFolder = async () => "/Users/me/Documents/Open Sourcebook/Sky";
    await runEngine(t.definition, t.ctx);
    const sent = t.service.videos.get("job-1")!.body;
    expect(sent.sources).toEqual([{ id: "src-1", title: "Sky notes", kind: "text", path: "/Users/me/Course/sky.md" }]);
    expect(sent.library).toBe("/Users/me/Documents/Open Sourcebook/Sky");
    const plain = setup({ settings: { style: "blueprint", minutes: 1 } });
    await runEngine(plain.definition, plain.ctx);
    expect(plain.service.videos.get("job-1")!.body).not.toHaveProperty("library");
  });

  it("opens a video's job folder on this computer through the service, by the video the job follows, and says so when it is gone", async () => {
    const t = setup({ settings: { style: "blueprint", minutes: 1 } });
    await runEngine(t.definition, t.ctx);
    const files = t.definition.jobFiles!;
    expect(files.can({ maker: "scenes" })).toBe(true);
    expect(await files.show({ jobId: "job-1", settings: {}, kept: {} })).toBeUndefined();
    expect(await files.show({ jobId: "other", settings: {}, kept: { "scenes:video": "job-1" } })).toBeUndefined();
    expect(t.service.shown).toEqual(["job-1", "job-1"]);
    expect(await files.show({ jobId: "nobody", settings: {}, kept: {} })).toMatch(/no longer on this computer/);
  });

  it("names an agent in every request to the service: the item's own, else the one the job settles", async () => {
    const picked = setup({ settings: { style: "blueprint", minutes: 1, agent: "agent:codex:gpt-6", effort: "high" } });
    await runEngine(picked.definition, picked.ctx);
    expect(picked.service.videos.get("job-1")!.body).toMatchObject({ agent: "codex", model: "gpt-6", effort: "high" });

    const open = setup({ settings: { style: "blueprint", minutes: 1 } });
    const asked: string[] = [];
    open.ctx.services.settlePick = async (scope, pick) => (asked.push(scope), { ...pick, agent: "claude" });
    await runEngine(open.definition, open.ctx);
    expect(new Set(asked)).toEqual(new Set(["video"]));
    expect(open.service.videos.get("job-1")!.body).toMatchObject({ agent: "claude" });
  });

  it("makes a video through the service, its steps shown on the item, checked by Open Sourcebook and kept as a file that is not a storyboard", async () => {
    const t = setup({ settings: { style: "blueprint", minutes: 1 } });
    await refreshScenesStatus(t.client);
    const result = await runEngine(t.definition, t.ctx);

    expect(result.report.valid).toBe(true);
    const sent = t.service.videos.get("job-1")!.body;
    expect(sent).toMatchObject({ id: "job-1", title: "Why the sky is blue", brief: "Explain the colours of the sky.", assumes: ["Light: What light is."], frame: { width: 1080, height: 1920 }, targetSeconds: 60, style: "blueprint" });
    expect(sent.passages).toEqual([
      { id: "chunk-1", label: "P1", sourceId: "src-1", sourceTitle: "Sky notes", locator: "page 1", text: V1 },
      { id: "chunk-2", label: "P2", sourceId: "src-1", sourceTitle: "Sky notes", locator: "page 2", text: V2 },
    ]);
    // The sources go too, for the video's job folder on the service: where each came from, its kept pictures.
    expect(sent.sources).toEqual([{ id: "src-1", title: "Sky notes", kind: "text" }]);
    expect(sent.limits).toMatchObject({ maxScenes: 60, narrationMaxChars: 1200, visualMinChars: 20, visualMaxChars: 700, onScreenTextMax: 4, onScreenChars: 120, cites: 4, quoteChars: 300 });

    const video = result.output.payload;
    expect(video.scenes.map((scene) => [scene.id, scene.durationMs, scene.cites.map((cite) => cite.chunkId)])).toEqual([
      ["s1", 6000, ["chunk-1"]],
      ["s2", 6000, ["chunk-2"]],
    ]);
    expect(video.scenes[0]!.cites[0]).toMatchObject({ sourceId: "src-1", spot: "passage", locator: { page: 1 } });
    expect(video.render).toMatchObject({
      by: "scenes",
      storyboard: false,
      contentType: "video/mp4",
      width: 1080,
      height: 1920,
      durationMs: 12000,
      audio: true,
      captions: true,
      scenes: [
        { id: "s1", startMs: 0, endMs: 6000 },
        { id: "s2", startMs: 6000, endMs: 12000 },
      ],
      maker: { id: "scenes", label: "Drawn scenes", style: { id: "blueprint", label: "Blueprint" }, agent: { id: "claude", label: "Claude Code", model: "sonnet" }, voice: { id: "elevenlabs", real: true } },
    });
    expect(video.render!.url).toBe(`/v1/assets/${video.render!.assetId}`);
    expect(t.bucket.objects.size).toBe(1);
    expect(result.output.citations.filter((citation) => citation.anchor).length).toBe(2);

    // The person sees the service's own words, in order, as the item's step.
    const steps = t.progress.map((update) => update.step).filter(Boolean);
    expect(steps).toEqual(expect.arrayContaining(["Asking your agent to start", "Writing scene 1 of 2", "Looking at the frames of scene 2", "Recording the voice", "Rendering the video", "Saving the video", "Done"]));
    expect(steps.indexOf("Writing scene 1 of 2")).toBeLessThan(steps.indexOf("Rendering the video"));
    const shares = t.progress.map((update) => update.progress);
    expect(shares).toEqual([...shares].sort((a, b) => a - b));

    // One usage row for the agent's work, at no cost to Open Sourcebook.
    expect(t.usage.events).toEqual([expect.objectContaining({ provider: "agent:claude", model: "sonnet", usd: 0, ok: true, jobId: "job-1" })]);
  });

  it("lets the agent pick the style when the item leaves it to Open Sourcebook, and records the one it picked", async () => {
    const t = setup();
    await refreshScenesStatus(t.client);
    const result = await runEngine(t.definition, t.ctx);
    expect(t.service.videos.get("job-1")!.body.style).toBe("auto");
    expect(result.output.payload.render!.maker!.style).toEqual({ id: "chalkboard", label: "Chalkboard" });
  });

  it("sends Open Sourcebook's problems back to the agent once, by scene, and keeps the script it writes again", async () => {
    const t = setup({ service: new FakeScenesService({ badQuoteFirst: true }) });
    const result = await runEngine(t.definition, t.ctx);
    expect(result.report.valid).toBe(true);
    expect(result.repairRounds).toBe(1);
    const revised = t.service.videos.get("job-1")!.revised;
    expect(revised).toHaveLength(1);
    expect(revised[0]).toEqual([expect.stringMatching(/^Scene s1 \(cites\[0\]\.quote\): the quote is not word for word in/)]);
    expect(t.progress.map((update) => update.step)).toContain("Sending Open Sourcebook's checks back to your agent");
  });

  it("fails as not right when the script still does not pass after the one send-back", async () => {
    const service = new FakeScenesService({ badQuoteFirst: true });
    const t = setup({ service });
    // The service will not take the problems back (as for a video that is not done).
    service.intercept = (_method, path) => (path.endsWith("/revise") ? new Response("{}", { status: 409 }) : undefined);
    const result = await runEngine(t.definition, t.ctx);
    expect(result.report.valid).toBe(false);
    expect(result.report.issues.map((issue) => issue.code)).toContain("quote_not_in_passage");
  });

  it("keeps a rendered video whose words use a label word as the subject does, with nothing to say about it", async () => {
    const t = setup({ service: new FakeScenesService({ narrations: ["Final passage needs a simple majority in each chamber.", "Air is the source of the scattered blue light."] }) });
    const result = await runEngine(t.definition, t.ctx);
    expect(result.report.valid).toBe(true);
    expect(result.report.issues).toEqual([]);
    expect(result.output.payload.notes).toBeUndefined();
    expect(t.service.videos.get("job-1")!.revised).toHaveLength(0);
  });

  it("never throws a rendered video away for a wording check: it is kept, not sent back, and what was found is in its notes", async () => {
    const t = setup({ service: new FakeScenesService({ narrations: ["As passage 2 says, blue light scatters the most.", "Sunlight scatters off the small molecules of the air."] }) });
    const result = await runEngine(t.definition, t.ctx);
    expect(result.report.valid).toBe(true);
    expect(result.repairRounds).toBe(0);
    expect(t.service.videos.get("job-1")!.revised).toHaveLength(0);
    expect(result.report.issues).toEqual([expect.objectContaining({ path: "scenes[0].narration", code: "names_prompt_label", severity: "warning" })]);
    expect(result.output.payload.render?.assetId).toBeTruthy();
    expect(result.output.payload.notes).toEqual([`Kept as rendered, though Open Sourcebook's checks found: scene 1's narration: names "passage 2", words only the writer saw.`]);
  });

  it("keeps a cite untrue to the sources strict: it is sent back, and holds the video back when the agent does not fix it", async () => {
    const service = new FakeScenesService({ badQuoteFirst: true, narrations: ["As passage 2 says, blue light scatters the most.", "Sunlight scatters off the small molecules of the air."] });
    const t = setup({ service });
    service.intercept = (_method, path) => (path.endsWith("/revise") ? new Response("{}", { status: 409 }) : undefined);
    const result = await runEngine(t.definition, t.ctx);
    expect(result.report.valid).toBe(false);
    const errors = result.report.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
    expect(errors).toEqual(["quote_not_in_passage"]);
    expect(result.output.payload.render).toBeUndefined();
  });

  it("re-attaches a redelivered job to the video the service is already making", async () => {
    const t = setup();
    await t.client.start({ id: "job-1", title: "x", brief: "", frame: { width: 1080, height: 1920 }, style: "auto", passages: [{ id: "chunk-1", sourceId: "src-1", sourceTitle: "Sky notes", text: V1 }] });
    await t.client.get("job-1");
    t.service.calls.length = 0;
    await runEngine(t.definition, t.ctx);
    expect(t.service.calls.filter((call) => call === "POST /videos")).toHaveLength(0);
    expect(t.checkpoint.values.get("scenes:video")).toBe("job-1");
  });

  it("a video the agent's plan limit stopped waits for the plan, and is carried on from its draft, not made again", async () => {
    const service = new FakeScenesService({ failWith: { code: "agentLimit", message: "Usage limit reached.", limit: { resets: "3pm (Europe/Berlin)" } } });
    const t = setup({ service });
    await refreshScenesStatus(t.client);
    const failure = await runEngine(t.definition, t.ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobWait);
    expect(failure).toMatchObject({ reason: "agent_limit", code: "agent_limit", limit: { resets: "3pm (Europe/Berlin)" } });
    expect(t.usage.events).toEqual([expect.objectContaining({ provider: "agent:claude", usd: 0, ok: false })]);

    service.options.failWith = undefined;
    const again = await runEngine(t.definition, t.ctx, { blueprint: { maker: "scenes", made: { style: "auto" } } });
    expect(again.report.valid).toBe(true);
    expect([...service.videos.keys()]).toEqual(["job-1"]);
    expect(service.videos.get("job-1")!.resumed).toBe(1);
    expect(service.calls).toContain("POST /videos/job-1/resume");
  });

  it("a video whose voice cannot speak waits for the voice, offering to finish it without sound, and is carried on from its draft either way", async () => {
    const voiceDown = { code: "voiceDown", message: "The voice could not speak. What was made is kept.", voice: "credits" };
    const service = new FakeScenesService({ failWith: voiceDown, voiceCheck: { ok: false, trouble: "credits", message: "The ElevenLabs account is out of credits for this narration." } });
    const t = setup({ service });
    await refreshScenesStatus(t.client);
    const failure = await runEngine(t.definition, t.ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobWait);
    expect(failure).toMatchObject({ reason: "voice", code: "voice_down", more: { trouble: "credits", choice: { id: "without_sound", label: "Finish without sound" } } });
    // The engine's check of the voice is free, and reads the service's answer.
    expect(await t.client.voice()).toEqual({ free: false, trouble: "credits" });

    // The person chooses to finish it without sound: carried on with no voice, from the same video.
    service.options.failWith = undefined;
    t.ctx.services.chosen = "without_sound";
    const silent = await runEngine(t.definition, t.ctx, { blueprint: { maker: "scenes", made: { style: "auto" } } });
    expect([...service.videos.keys()]).toEqual(["job-1"]);
    expect(service.videos.get("job-1")!.withoutSound).toBe(true);
    expect(silent.output.payload.render).toMatchObject({ audio: false, maker: { voice: { id: "silent", real: false } } });
    expect(t.progress.map((update) => update.step)).toContain("Finishing it without sound");

    // Without the choice, a video whose voice is back is carried on with the voice.
    const back = new FakeScenesService({ failWith: voiceDown });
    const u = setup({ service: back });
    await runEngine(u.definition, u.ctx).catch(() => undefined);
    back.options.failWith = undefined;
    const voiced = await runEngine(u.definition, u.ctx, { blueprint: { maker: "scenes", made: { style: "auto" } } });
    expect(back.videos.get("job-1")!.withoutSound).toBeUndefined();
    expect(voiced.output.payload.render).toMatchObject({ audio: true });
    expect(await u.client.voice()).toEqual({ free: true });
    expect(await new ScenesClient({ url: SERVICE, token: "x" }, new FakeScenesService({ down: true }).fetch).voice()).toEqual({});
  });

  it("starts a new video when the service cannot carry the old one on", async () => {
    const service = new FakeScenesService({ failWith: { code: "error", message: "It broke." }, noResume: true });
    const t = setup({ service });
    const failure = await runEngine(t.definition, t.ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobFailure);
    service.options.failWith = undefined;
    const again = await runEngine(t.definition, t.ctx, { blueprint: { maker: "scenes", made: { style: "auto" } } });
    expect(again.report.valid).toBe(true);
    expect([...service.videos.keys()]).toEqual(["job-1", "job-1-2"]);
  });

  it("stops the agent on the service when the job is cancelled", async () => {
    const controller = new AbortController();
    const t = setup({ signal: controller.signal });
    let reads = 0;
    t.service.intercept = (method, path) => {
      if (method === "GET" && path === "/videos/job-1" && ++reads === 3) controller.abort(new Error("cancelled"));
      return undefined;
    };
    const failure = await runEngine(t.definition, t.ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("cancelled");
    expect(t.service.calls).toContain("POST /videos/job-1/stop");
    expect(t.service.videos.get("job-1")!.stopped).toBe(true);
  });

  it("stops the agent too when the job learns it was cancelled on a progress write", async () => {
    const controller = new AbortController();
    const t = setup({ signal: controller.signal });
    let writes = 0;
    t.ctx.services.progress = () => {
      if (++writes === 4) {
        // What a job run does when its row was cancelled under it: abort, then throw.
        const lost = new Error("job was cancelled");
        controller.abort(lost);
        throw lost;
      }
    };
    const failure = await runEngine(t.definition, t.ctx).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("job was cancelled");
    expect(t.service.calls).toContain("POST /videos/job-1/stop");
  });

  it("a service that is not running, or whose agent cannot be reached, waits to be carried on as after a restart", async () => {
    const down = setup({ service: new FakeScenesService({ down: true }) });
    const failure = await runEngine(down.definition, down.ctx).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: "restart", code: "maker_unreachable" });
    expect(failureWords({ state: { failure: "maker_unreachable" }, attempt: 1, status: "failed" }, "video")).toBe(
      "The maker this video needs isn't running on this computer, so it was not made. Start it, then try again.",
    );

    const agent = setup({ service: new FakeScenesService({ failWith: { code: "agentUnreachable", message: "The connector did not answer." } }) });
    expect(await runEngine(agent.definition, agent.ctx).catch((error: unknown) => error)).toMatchObject({ reason: "restart", code: "agent_unreachable" });
  });

  it("an agent that stopped with an error of its own before any work fails as that, with its own words for the person", async () => {
    const said = "The 'some-model' model is not supported on this account.";
    const t = setup({ service: new FakeScenesService({ failWith: { code: "agentError", message: "Your agent stopped before it began on the video.", said } }) });
    const failure = await runEngine(t.definition, t.ctx).catch((error: unknown) => error);
    expect(failure).toMatchObject({ failureCode: "agent_error", said });
  });

  it("has no clock of its own: a video that takes hours is followed to its end, never stopped by the engine", async () => {
    let now = 0;
    // Three hours pass between two reads.
    const t = setup({ clock: () => (now += 3 * 60 * 60_000) });
    const output = await runEngine(t.definition, t.ctx);
    expect(output.report.valid).toBe(true);
    expect(t.service.calls.some((call) => call.endsWith("/stop"))).toBe(false);
    // A limit given by hand still stops it at that time, and the service is asked to stop (its draft kept there).
    const service = new FakeScenesService();
    const client = new ScenesClient({ url: SERVICE, token: service.token }, service.fetch);
    let later = 0;
    const limited = createScenesMaker({ client, pollMs: 0, sleep: async () => undefined, maxMinutes: 60, clock: () => (later += 3 * 60 * 60_000) });
    const failure = await runEngine(videoDefinitionFor(new VideoMakerRegistry().register(limited)), t.ctx).catch((error: unknown) => error);
    expect(failure).toMatchObject({ failureCode: "timed_out" });
    expect(service.calls.some((call) => call.endsWith("/stop"))).toBe(true);
  });

  it("calls no Open Sourcebook model, and needs source text", async () => {
    const t = setup();
    const empty = { ...t.ctx, sources: [{ ...source, chunks: [], envelope: { ...source.envelope, text: "", accessLevel: "metadata" as const } }] };
    const failure = await runEngine(t.definition, empty).catch((error: unknown) => error);
    expect(failureCodeOf(failure)).toBe("no_source_text");
  });
});

describe("scenes maker: what it says before Start, and its settings", () => {
  it("brings the service's words and styles, with a picture path for each style", async () => {
    const t = setup();
    expect(t.maker.styles()).toEqual([]);
    await refreshScenesStatus(t.client);
    expect(t.maker.label).toBe("Drawn scenes");
    expect(t.maker.description).toContain("Takes about 5 to 15 minutes.");
    expect(t.maker.description).toContain("Works only on this computer, with Open Sourcebook's scene maker and your agent running.");
    expect(t.maker.styles().map((style) => [style.id, style.preview])).toEqual([
      ["chalkboard", "/v1/video-makers/scenes/styles/chalkboard/preview"],
      ["blueprint", "/v1/video-makers/scenes/styles/blueprint/preview"],
    ]);
    // Only offered styles are choices: the service's kept-but-not-offered one is not among them.
    const choices = new FormatRegistry().register(videoDefinitionFor(t.makers)).descriptor("video")!.settings.find((field) => field.key === "style")!;
    expect(choices.kind === "choice" ? choices.options.map((option) => option.value) : []).not.toContain("neon");
    // The descriptor built now carries them; a registry accepts it.
    const descriptor = new FormatRegistry().register(videoDefinitionFor(t.makers)).descriptor("video")!;
    expect(descriptor.settings.map((field) => field.key)).toEqual(["minutes", "aspect", "style", "agent", "reviewer"]);
    expect(descriptor.settings[2]!.showWhen).toBeUndefined();
    expect(t.definition.estimateCost({ settings: { minutes: 2, aspect: "portrait" }, sourceChars: 5000, sourceCount: 1 })).toEqual({
      usd: 0,
      basis: "written by your own agent on this computer: no model cost to Open Sourcebook",
    });
  });

  it("says nothing before it has heard from the service, then what stops an item, with what to do", async () => {
    const settings = (extra: Partial<VideoSettings> = {}): VideoSettings => ({ minutes: 0, aspect: "portrait", ...extra });
    const ok = setup();
    expect(ok.definition.itemIssues!(settings())).toEqual([]);
    await refreshScenesStatus(ok.client);
    expect(ok.definition.itemIssues!(settings())).toEqual([]);
    expect(ok.definition.itemIssues!(settings({ style: "gone" }))).toEqual(['Drawn scenes has no style "gone": pick another style']);
    // A style the service keeps but no longer offers still makes the item that names it.
    expect(ok.definition.itemIssues!(settings({ style: "neon" }))).toEqual([]);
    expect(ok.definition.itemIssues!(settings({ aspect: "landscape" }))).toEqual(["Drawn scenes makes tall videos only: set its shape to Portrait, or pick another maker"]);
    forgetScenesStatus();

    const down = setup({ service: new FakeScenesService({ down: true }) });
    await refreshScenesStatus(down.client);
    expect(down.definition.itemIssues!(settings())).toEqual(["Drawn scenes needs Open Sourcebook's scene maker running on this computer: start it, or pick another maker"]);
    forgetScenesStatus();

    const signedOut = setup({ service: new FakeScenesService({ agent: { reachable: false, problem: "agentSignedOut" } }) });
    await refreshScenesStatus(signedOut.client);
    expect(signedOut.definition.itemIssues!(settings())).toEqual(["Drawn scenes needs your agent, and it isn't signed in: start it, or pick another maker"]);
  });
});

const NO_SOUND = "No voice set up: videos are made without sound, with captions carrying the words. For a voice, pick one in Settings, under Voice.";
const settings = (extra: Partial<VideoSettings> = {}): VideoSettings => ({ minutes: 0, aspect: "portrait", ...extra });
const SILENT = { id: "silent", label: "No voice (made without sound)", real: false, note: NO_SOUND };

describe("scenes maker: no voice key, no sound", () => {
  it("the service's own line reaches the maker's status, the makers list, the item's notices and the video's own mark", async () => {
    const t = setup({ service: new FakeScenesService({ voice: SILENT }) });
    await refreshScenesStatus(t.client);
    const maker = t.makers.get("scenes")!;
    expect(await maker.status!()).toMatchObject({ available: true, notice: NO_SOUND });
    expect(t.definition.itemNotices!(settings())).toEqual([NO_SOUND]);
    const engine = createTestEngine();
    engine.deps.videoMakers = t.makers;
    const list = (await (await handleRequest(authed("/v1/video-makers"), engine.deps)).json()) as { makers: Array<Record<string, unknown>> };
    expect(list.makers[0]).toMatchObject({ available: true, notice: NO_SOUND });
  });

  it("says no time from guesses: no drawing speed, no other runs, nothing before a run on this very pick", async () => {
    const speed = { chalkboard: { framesPerSecond: 20, setupSeconds: 10 } };
    const made = [{ seconds: 840, videoSeconds: 556, agent: "claude", model: "sonnet", effort: "high" }];
    const t = setup({ service: new FakeScenesService({ speed, made }) });
    await refreshScenesStatus(t.client);
    for (const minutes of [0, 1.25, 10]) {
      expect(t.definition.itemNotices!(settings({ minutes, style: "chalkboard" }))).toEqual([]);
      expect(t.definition.itemNotices!({ minutes, aspect: "portrait", agent: "agent:claude:sonnet", effort: "high" })).toEqual([]);
    }
  });

  it("says when a video should be done only while that can be known, from what was measured here", () => {
    const start = Date.parse("2026-11-19T18:32:00.000Z");
    const at = (minutes: number) => start + minutes * 60_000;
    // No video made here yet: while the agent writes, no end is known.
    expect(expectedDone({ now: at(1), startedAt: start, state: "writing", progress: 0.3 })).toBeNull();
    // A fast run: expected in 6 minutes, said as such, and the same end time as it goes (it never grows).
    expect(expectedDone({ now: at(1), startedAt: start, state: "writing", progress: 0.3, making: 360 })).toBe(at(6));
    expect(expectedDone({ now: at(4), startedAt: start, state: "writing", progress: 0.6, making: 360 })).toBe(at(6));
    // A slow run past what was expected: no number any more.
    expect(expectedDone({ now: at(5.6), startedAt: start, state: "writing", progress: 0.7, making: 360 })).toBeNull();
    expect(expectedDone({ now: at(9), startedAt: start, state: "writing", progress: 0.7, making: 360 })).toBeNull();
    // Drawing for the last time goes at an even pace: a quarter drawn in a minute leaves about three.
    const drawing = at(10);
    expect(expectedDone({ now: drawing + 60_000, startedAt: start, state: "rendering", progress: 0.85, renderingSince: drawing, making: 360 })).toBe(drawing + 60_000 + 180_000);
    // Too little drawn yet to say: back to what was expected, here already past.
    expect(expectedDone({ now: drawing + 5_000, startedAt: start, state: "rendering", progress: 0.801, renderingSince: drawing, making: 360 })).toBeNull();
  });

  it("says nothing when the voice makes sound, and not before the service has answered", async () => {
    const t = setup();
    expect(t.definition.itemNotices!(settings())).toEqual([]);
    await refreshScenesStatus(t.client);
    expect(t.definition.itemNotices!(settings())).toEqual([]);
    expect(await t.makers.get("scenes")!.status!()).not.toHaveProperty("notice");
  });

  it("a finished silent video says it has no sound, with the maker's words", () => {
    const render = { by: "scenes", storyboard: false, audio: false, maker: { id: "scenes", label: "Drawn scenes", voice: SILENT } };
    const made = (r: object) => ({ idea: "x", scenes: [], render: r }) as never;
    expect(setup().definition.madeNotices!(made(render))).toEqual([NO_SOUND]);
    expect(setup().definition.madeNotices!(made({ ...render, audio: true }))).toEqual([]);
    expect(setup().definition.madeNotices!(made({ ...render, audio: false, maker: undefined }))).toEqual(["This video was made without sound; its captions carry the words."]);
  });
});

describe("scenes maker: routes and wiring", () => {
  it("says who can make videos here and whether each can now, and passes on a style's picture", async () => {
    const t = setup();
    await refreshScenesStatus(t.client);
    const engine = createTestEngine();
    engine.deps.videoMakers = t.makers;
    const list = await handleRequest(authed("/v1/video-makers"), engine.deps);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      makers: [
        expect.objectContaining({ id: "scenes", label: "Drawn scenes", local: true, default: true, styles: 2, available: true, agent: { id: "claude", label: "Claude Code", model: "sonnet" } }),
      ],
    });
    const picture = await handleRequest(authed("/v1/video-makers/scenes/styles/chalkboard/preview"), engine.deps);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect((await handleRequest(authed("/v1/video-makers/scenes/styles/nope/preview"), engine.deps)).status).toBe(404);
    expect((await handleRequest(new Request("https://engine.test/v1/video-makers"), engine.deps)).status).toBe(401);

    t.service.options.down = true;
    const off = (await (await handleRequest(authed("/v1/video-makers"), engine.deps)).json()) as { makers: Array<Record<string, unknown>> };
    expect(off.makers[0]).toMatchObject({ available: false, problem: "Drawn scenes needs Open Sourcebook's scene maker running on this computer. Start it to make videos with it." });
  });

  it("sets the maker up only with a token and a service on this machine", () => {
    const fetch = async () => new Response(null);
    expect(videoMakersFromEnv({}, fetch)).toEqual([]);
    expect(videoMakersFromEnv({ SCENES_SERVICE_URL: SERVICE }, fetch)).toEqual([]);
    expect(videoMakersFromEnv({ SCENES_SERVICE_URL: "https://scenes.example.com", SCENES_SERVICE_TOKEN: "t" }, fetch)).toEqual([]);
    expect(videoMakersFromEnv({ SCENES_SERVICE_URL: SERVICE, SCENES_SERVICE_TOKEN: "t" }, fetch).map((maker) => maker.id)).toEqual(["scenes"]);
  });

  it("makes video ready with the scenes maker, the one the open pick takes, and never with a setting left from the storyboard maker or the mock mode", () => {
    const scenes = { SCENES_SERVICE_URL: SERVICE, SCENES_SERVICE_TOKEN: "t" };
    // Settings an older .dev.vars may still carry; none of them makes anything now.
    const leftOver = { VIDEO_PROVIDERS: "storyboard", RENDER_SERVICE_URL: "http://127.0.0.1:8080", RENDER_SERVICE_TOKEN: "r", RE_ENGINE_MODE: "mock", GENERATION_PROVIDER: "offline", VIDEO_MAKER_DEFAULT: "storyboard" } as unknown as Partial<WorkerEnv>;
    const env = (extra: Partial<WorkerEnv>): WorkerEnv => ({ OPENSOURCEBOOK_JOB_DB: createSqliteD1(), ...extra });
    const keys = (deps: EngineDeps | undefined) => deps!.registry.descriptor("video")!.settings.map((field) => field.key);

    for (const extra of [{}, leftOver]) {
      const deps = depsForEnv(env({ ...scenes, ...extra }))!;
      expect(deps.registry.ready()).toContain("video");
      expect(deps.videoMakers!.list().map((maker) => maker.id)).toEqual(["scenes"]);
      expect(deps.videoMakers!.default()!.id).toBe("scenes");
      expect(keys(deps)).toEqual(["minutes", "aspect", "agent", "reviewer"]);
      // No model key, no stand-in: there is no provider to make anything with.
      expect(deps.provider({ record: () => undefined })).toBeUndefined();
    }
    const none = depsForEnv(env(leftOver))!;
    expect(none.videoMakers).toBeUndefined();
    expect(none.registry.ready()).not.toContain("video");
  });

  it("keeps the draft so a redelivery after the file was kept writes the output without asking again", async () => {
    const t = setup();
    await runEngine(t.definition, t.ctx, { onBlueprint: () => undefined });
    expect(t.checkpoint.values.get(DRAFT_KEY)).toMatchObject({ produced: true });
  });

  it("sends who watches the finished video: nothing for auto, off as off, and a pick with its own agent, model and effort", async () => {
    const posted = async (extra: Record<string, unknown>) => {
      forgetScenesStatus();
      const t = setup();
      t.ctx.node.settings = { minutes: 1, aspect: "portrait", style: "chalkboard", agent: "agent:claude:sonnet", ...extra } as VideoSettings;
      await runEngine(t.definition, t.ctx);
      const body = t.service.videos.get("job-1")!.body;
      return Object.fromEntries(["review", "reviewAgent", "reviewModel", "reviewEffort"].filter((k) => k in body).map((k) => [k, body[k]]));
    };
    expect(await posted({})).toEqual({});
    expect(await posted({ reviewer: "auto" })).toEqual({});
    expect(await posted({ reviewer: "off" })).toEqual({ review: false });
    expect(await posted({ reviewer: "agent:codex:gpt-6", reviewEffort: "low" })).toEqual({ review: true, reviewAgent: "codex", reviewModel: "gpt-6", reviewEffort: "low" });
    // A reviewer that names no agent watches on the video's own agent; no model crosses to it.
    expect(await posted({ reviewer: "agent", reviewEffort: "high" })).toEqual({ review: true, reviewAgent: "claude", reviewEffort: "high" });
  });

  it("keeps how long the making took, and its review's, under the pick it ran on, through a send-back and the saving", async () => {
    const t = setup({ service: new FakeScenesService({ badQuoteFirst: true }) });
    await refreshScenesStatus(t.client);
    t.ctx.node.settings = { minutes: 1, aspect: "portrait", style: "chalkboard", agent: "agent:codex:gpt-6", effort: "max", reviewer: "agent:claude:haiku" } as VideoSettings;
    const result = await runEngine(t.definition, t.ctx);
    expect(t.service.videos.get("job-1")!.revised).toHaveLength(1);
    expect(result.output.timing).toEqual({ seconds: 360, agent: "codex", model: "gpt-6", effort: "max", review: { seconds: 45, agent: "claude", model: "haiku" } });
    // Nothing picked: the agent the service runs, with its own model.
    forgetScenesStatus();
    const auto = setup();
    await refreshScenesStatus(auto.client);
    expect((await runEngine(auto.definition, auto.ctx)).output.timing).toMatchObject({ seconds: 300, agent: "claude", model: "sonnet" });
  });

  it("expects an end only from a run on this very pick and length, and asks for nothing else", async () => {
    const asked: unknown[] = [];
    const service = new FakeScenesService();
    const client = new ScenesClient({ url: SERVICE, token: service.token }, service.fetch);
    const maker = createScenesMaker({ client, pollMs: 0, sleep: async () => undefined, madeIn: async (pick, s) => (asked.push([pick, s.minutes]), undefined) });
    const t = setup({ service });
    const definition = videoDefinitionFor(new VideoMakerRegistry().register(maker));
    t.ctx.node.settings = { minutes: 4, aspect: "portrait", style: "chalkboard", agent: "agent:codex:gpt-6", effort: "max" };
    await runEngine(definition, t.ctx);
    expect(asked).toEqual([[{ agent: "codex", model: "gpt-6", effort: "max" }, 4]]);
    expect(t.progress.some((p) => typeof p.doneBy === "string")).toBe(false);
  });

  it("looks the expected end up for the job's owner, under the pick the job settled when the item names none", async () => {
    const asked: unknown[] = [];
    const service = new FakeScenesService();
    const client = new ScenesClient({ url: SERVICE, token: service.token }, service.fetch);
    const maker = createScenesMaker({ client, pollMs: 0, sleep: async () => undefined, madeIn: async (pick, _s, ownerId) => (asked.push([pick, ownerId]), undefined) });
    const t = setup({ service });
    const definition = videoDefinitionFor(new VideoMakerRegistry().register(maker));
    t.ctx.ownerId = "owner-1";
    t.ctx.services.settlePick = async (_scope, pick) => ({ ...pick, agent: "codex", model: "gpt-6" });
    t.ctx.node.settings = { minutes: 4, aspect: "portrait", style: "chalkboard", effort: "max" };
    await runEngine(definition, t.ctx);
    expect(asked).toEqual([[{ agent: "codex", model: "gpt-6", effort: "max" }, "owner-1"]]);
  });

  it("forwards picked agent, model, and effort to scenes and records effort on render.maker.agent", async () => {
    const t = setup();
    await refreshScenesStatus(t.client);
    t.ctx.node.settings = { minutes: 1, aspect: "portrait", style: "chalkboard", agent: "agent:codex:gpt-6", effort: "max" };
    const result = await runEngine(t.definition, t.ctx);
    const posted = t.service.videos.get("job-1")!.body;
    expect([posted.agent, posted.model, posted.effort]).toEqual(["codex", "gpt-6", "max"]);
    expect(result.output.payload.render?.maker?.agent).toEqual({ id: "codex", model: "gpt-6", effort: "max" });
  });

});
