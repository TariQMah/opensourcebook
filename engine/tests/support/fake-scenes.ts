/**
 * A stand-in for the scenes service (services/scenes) speaking its wire
 * contract as a fetch function: each read of a video moves it one step on
 * (writing scene by scene, voicing, rendering), and the finished script
 * quotes the passages it was sent word for word. A test can make it fail,
 * write a script Open Sourcebook refuses until it is sent back, stop, or not answer.
 * Tests only.
 */
import type { FetchLike } from "../../src/types/provider";

export interface FakeScenesOptions {
  token?: string;
  styles?: Array<{ id: string; label: string; description: string; offered?: boolean }>;
  agent?: { reachable: boolean; id?: string; label?: string; model?: string; effort?: string; problem?: string };
  /** Scenes in a script, at most one per passage. */
  scenes?: number;
  /** Ends every video this way once writing is done. */
  failWith?: { code: string; message: string; said?: string; limit?: { resetsAt?: string; resets?: string }; voice?: string };
  /** What `GET /voice` answers (default: it can speak). */
  voiceCheck?: { ok: boolean; trouble?: string; message?: string };
  /** An older service: it cannot carry a video on (POST /videos/:id/resume answers 404). */
  noResume?: boolean;
  /** The first script quotes words that are not in its passage; a revise fixes it. */
  badQuoteFirst?: boolean;
  /** What each scene says, in order, in every script (a revise does not change it); else the passage's first words. */
  narrations?: string[];
  /** The voice it says it has (default: a voice that makes sound). With `real: false` it has a `note`, as the real service does with no voice key. */
  voice?: { id: string; label: string; real: boolean; note?: string };
  /** How fast it says this computer draws each style, as the real service does once it has measured. */
  speed?: Record<string, { framesPerSecond: number; setupSeconds: number }>;
  /** How long whole videos took to make here, as the status says it. */
  made?: Array<{ seconds: number; videoSeconds: number; agent?: string; model?: string; effort?: string }>;
  /** Bytes of the finished file. */
  file?: Uint8Array;
  /** Status, start and reads all fail, as if nothing listens. */
  down?: boolean;
  /** Each read waits this long first (the hand-run server makes the steps visible). */
  readDelayMs?: number;
  /** Each read moves the video this many steps on; default 1. */
  stepsPerRead?: number;
  /** A careless service: its voice answers carry the whole key, so the engine's reading of them is what keeps it in. */
  leakKeys?: boolean;
  /** What every video was made from is gone from its data folder: none can have a scene made again. */
  draftGone?: boolean;
}

export const FAKE_SCENES_TOKEN = "fake-scenes-token-0123456789";

interface Video {
  id: string;
  body: Record<string, unknown>;
  at: number;
  state: string;
  steps: Array<{ label: string; at: string }>;
  revised: string[][];
  stopped: boolean;
  style: string;
  /** Times it was carried on from its draft. */
  resumed: number;
  /** Carried on without sound, as the person chose after the voice could not speak. */
  withoutSound?: boolean;
  /** A remake of one beat of another video, copied from it. */
  remake?: { of: string; beat: string; note?: string };
}

/** A small valid mp4 header is not needed by the tests; any bytes stand in for the file. */
const DEFAULT_FILE = new TextEncoder().encode("fake mp4 bytes");

export class FakeScenesService {
  readonly videos = new Map<string, Video>();
  readonly calls: string[] = [];
  /** The videos whose job folder was opened (POST /videos/:id/show-files). */
  readonly shown: string[] = [];
  readonly options: FakeScenesOptions;

  constructor(options: FakeScenesOptions = {}) {
    this.options = {
      styles: [
        { id: "chalkboard", label: "Chalkboard", description: "White chalk lines on a dark green board, one warm accent." },
        { id: "blueprint", label: "Blueprint", description: "Thin white technical lines on deep blue paper." },
        // Kept by the service but not offered: an older item may name it, and nothing lists it to choose.
        { id: "neon", label: "Neon", description: "Glowing lines on a dark night.", offered: false },
      ],
      agent: { reachable: true, id: "claude", label: "Claude Code", model: "sonnet" },
      scenes: 2,
      ...options,
    };
  }

  get token(): string {
    return this.options.token ?? FAKE_SCENES_TOKEN;
  }

  /** The voice as set up through `/voice/...`: the chosen service and the keys it was given, as the real service keeps them. */
  readonly voiceSetup: { service?: string; voice?: string; keys: Record<string, string> } = { keys: {} };

  /** Sees every call first; an answer it returns is sent instead of the service's own. */
  intercept?: (method: string, path: string) => Response | undefined;

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    if (this.options.down) throw new TypeError("fetch failed: connection refused");
    const instead = this.intercept?.(method, url.pathname);
    if (instead) return instead;
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${this.token}`) return json({ ok: false, error: "unauthorized" }, 401);
    return this.route(method, url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
  };

  private async route(method: string, path: string, body: Record<string, unknown> | undefined): Promise<Response> {
    if (method === "GET" && path === "/status") {
      return json({
        ok: true,
        maker: { id: "scenes", label: "Drawn scenes", description: "Your own agent writes drawn, moving scenes from the sources and looks at its frames. Takes about 5 to 15 minutes." },
        agent: this.options.agent,
        voice: this.voiceSetup.service ? { id: this.voiceSetup.service, label: this.voiceSetup.service, real: true } : (this.options.voice ?? { id: "elevenlabs", label: "ElevenLabs", real: true }),
        ...(this.voiceSetup.service ? { audio: { ready: true } } : {}),
        styles: this.options.styles,
        ...(this.options.speed ? { speed: this.options.speed } : {}),
        ...(this.options.made ? { made: this.options.made } : {}),
      });
    }
    if (method === "GET" && path === "/voice") return json(this.options.voiceCheck ?? { ok: true });
    if (path.startsWith("/voice/")) return this.voiceRoute(method, path, body);
    const preview = /^\/styles\/([^/]+)\/preview$/.exec(path);
    if (method === "GET" && preview) {
      if (!this.options.styles!.some((style) => style.id === preview[1])) return json({ ok: false }, 404);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });
    }
    if (method === "POST" && path === "/videos") {
      const id = String(body?.id);
      if (!this.videos.has(id)) {
        this.videos.set(id, { id, body: body!, at: 0, state: "writing", steps: [step("Reading the sources")], revised: [], stopped: false, resumed: 0, style: body?.style === "auto" ? "chalkboard" : String(body?.style) });
      }
      return json({ id }, 202);
    }
    const video = /^\/videos\/([^/]+)(?:\/(file|stop|revise|resume|remake-scene|show-files))?$/.exec(path);
    if (!video) return json({ ok: false }, 404);
    const job = this.videos.get(decodeURIComponent(video[1]!));
    if (!job) return json({ ok: false, error: "no such video" }, 404);
    if (method === "POST" && video[2] === "show-files") {
      this.shown.push(job.id);
      return json({ folder: `/jobs/${job.id}` });
    }
    if (method === "POST" && video[2] === "stop") {
      job.stopped = true;
      job.state = "stopped";
      return json({ ok: true });
    }
    if (method === "POST" && video[2] === "resume") {
      if (this.options.noResume) return json({ ok: false }, 404);
      if (job.state !== "failed" && job.state !== "stopped") return json({ ok: false, error: `it is ${job.state}` }, 409);
      // Carried on from its draft: what was written stays, the writing goes on from there.
      job.state = "writing";
      job.stopped = false;
      job.resumed += 1;
      if (body?.withoutSound === true) job.withoutSound = true;
      job.at = Math.max(0, job.at - 2);
      job.steps.push(step("Carrying on"));
      return json(this.view(job));
    }
    if (method === "POST" && video[2] === "remake-scene") {
      const id = String(body?.id);
      const beat = String(body?.beat);
      if (this.videos.has(id)) return json({ id }, 202);
      if (job.state !== "done") return json({ error: "not_done", message: `Only a finished video can have a scene made again; this one is ${job.state}.` }, 409);
      if (this.options.draftGone) return json({ error: "draft_gone", message: "This video's draft is no longer on this computer." }, 409);
      if (!(this.result(job).scenes as Array<{ id: string }>).some((scene) => scene.id === beat)) return json({ error: "no_beat", message: `This video has no beat ${beat}.` }, 404);
      const pick = typeof body?.agent === "string" ? { agent: body.agent, ...(typeof body.model === "string" ? { model: body.model } : {}), ...(typeof body.effort === "string" ? { effort: body.effort } : {}) } : {};
      const { agent: _a, model: _m, effort: _e, ...rest } = job.body;
      this.videos.set(id, { id, body: { ...(typeof body?.agent === "string" ? rest : job.body), ...pick, id }, at: 0, state: "writing", steps: [step("Making one scene again")], revised: [], stopped: false, resumed: 0, style: job.style, remake: { of: job.id, beat, ...(typeof body?.note === "string" ? { note: body.note } : {}) } });
      return json({ id }, 202);
    }
    if (method === "POST" && video[2] === "revise") {
      if (job.state !== "done") return json({ ok: false, error: "not done" }, 409);
      job.revised.push((body?.problems as string[]) ?? []);
      job.state = "writing";
      job.at = 0;
      job.steps.push(step("Fixing what Open Sourcebook found"));
      return json({ ok: true });
    }
    if (method === "GET" && video[2] === "file") {
      if (job.state !== "done") return json({ ok: false }, 409);
      return new Response((this.options.file ?? DEFAULT_FILE) as BodyInit, { headers: { "content-type": "video/mp4" } });
    }
    if (method === "GET" && !video[2]) {
      if (this.options.readDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.readDelayMs));
      for (let moved = 0; moved < (this.options.stepsPerRead ?? 1); moved += 1) this.advance(job);
      return json(this.view(job));
    }
    return json({ ok: false }, 404);
  }

  /** Two services, as the real one lists them: a hosted one with a key, and one on this computer, not installed. */
  private voiceView(): Record<string, unknown> {
    const key = this.voiceSetup.keys.acme;
    const services = [
      { id: "acme", label: "Acme", where: "hosted", about: "A hosted voice.", needsKey: true, keyLabel: "Your Acme key", keyHelpUrl: "https://acme.example/keys", keySteps: ["Make an account.", 7, "Paste the key here."], keySet: !!key, ...(key ? { keyHint: this.options.leakKeys ? key : key.slice(-4) } : {}), ...(key && this.options.leakKeys ? { key } : {}), listsVoices: true, samples: true },
      { id: "home", label: "On this computer", where: "local", about: "A voice here.", needsKey: false, installed: false, install: { command: "npm run voice:home", folder: "services/scenes" }, listsVoices: false, samples: false },
    ];
    return { ...(this.voiceSetup.service ? { service: this.voiceSetup.service } : {}), ...(this.voiceSetup.voice ? { voice: { id: this.voiceSetup.voice, label: "Vee" } } : {}), from: this.voiceSetup.service ? "app" : "none", services };
  }

  private voiceRoute(method: string, path: string, body: Record<string, unknown> | undefined): Response {
    const refuse = (status: number, error: string, message: string) => json({ error, message }, status);
    if (path === "/voice/setup" && method === "GET") return json(this.voiceView());
    if (path === "/voice/setup" && method === "PUT") {
      const service = body?.service;
      if (service === null) {
        delete this.voiceSetup.service;
        return json(this.voiceView());
      }
      if (service === "home") return refuse(409, "voice_not_installed", "Not installed yet: run npm run voice:home in services/scenes.");
      if (service !== "acme") return refuse(400, "unknown_voice_service", `There is no voice service "${String(service)}".`);
      if (!this.voiceSetup.keys.acme) return refuse(409, "voice_needs_key", "Acme needs your key first.");
      this.voiceSetup.service = "acme";
      if (typeof body?.voice === "string") this.voiceSetup.voice = body.voice;
      return json(this.voiceView());
    }
    const key = /^\/voice\/services\/([^/]+)\/key$/.exec(path);
    if (key) {
      if (key[1] !== "acme") return refuse(404, "not_found", "No such voice service with a key.");
      if (method === "DELETE") {
        delete this.voiceSetup.keys.acme;
        if (this.voiceSetup.service === "acme") delete this.voiceSetup.service;
        return json(this.voiceView());
      }
      const given = String(body?.key ?? "");
      if (given.startsWith("bad")) return refuse(422, "key_refused", "Acme did not take this key. Nothing was saved.");
      this.voiceSetup.keys.acme = given;
      const view = (this.voiceView().services as Array<Record<string, unknown>>)[0]!;
      return json({ service: { ...view, health: { ok: true } } });
    }
    const voices = /^\/voice\/services\/([^/]+)\/voices$/.exec(path);
    if (voices) {
      if (voices[1] !== "acme") return refuse(404, "not_found", "That voice service has no voices to list.");
      if (!this.voiceSetup.keys.acme) return refuse(409, "voice_needs_key", "Acme needs your key first.");
      return json({ voices: [{ id: "v1", label: "Vee", description: "calm", language: "English", sample: true, ...(this.options.leakKeys ? { key: this.voiceSetup.keys.acme } : {}) }] });
    }
    const sample = /^\/voice\/services\/([^/]+)\/voices\/([^/]+)\/sample$/.exec(path);
    if (sample) {
      if (sample[1] !== "acme" || sample[2] !== "v1") return refuse(404, "not_found", "No sample for that voice.");
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }
    return refuse(404, "not_found", "Route not found");
  }

  /** The labels a video goes through: one per scene written and looked at, then voice and render. */
  private plan(job: Video): Array<{ state: string; label: string }> {
    const count = this.sceneCount(job);
    const writing = Array.from({ length: count }, (_, at) => [
      { state: "writing", label: `Writing scene ${at + 1} of ${count}` },
      { state: "writing", label: `Looking at the frames of scene ${at + 1}` },
    ]).flat();
    return [...writing, { state: "voicing", label: "Recording the voice" }, { state: "rendering", label: "Rendering the video" }];
  }

  private advance(job: Video): void {
    if (job.state === "done" || job.state === "failed" || job.state === "stopped") return;
    const plan = this.plan(job);
    if (job.at < plan.length) {
      const next = plan[job.at]!;
      job.state = next.state;
      job.steps.push(step(next.label));
      job.at += 1;
      return;
    }
    if (this.options.failWith) {
      job.state = "failed";
      return;
    }
    job.state = "done";
    job.steps.push(step("Done"));
  }

  private sceneCount(job: Video): number {
    const passages = (job.body.passages as unknown[]) ?? [];
    return Math.max(1, Math.min(this.options.scenes ?? 2, passages.length));
  }

  private view(job: Video): Record<string, unknown> {
    const plan = this.plan(job);
    const done = job.state === "done";
    return {
      id: job.id,
      state: job.state,
      progress: done ? 1 : Math.min(0.99, job.at / (plan.length + 1)),
      step: job.steps.at(-1)?.label ?? "",
      steps: job.steps,
      style: job.style,
      ...(job.state === "failed" && this.options.failWith ? { failure: this.options.failWith } : {}),
      ...(job.state === "stopped" ? { failure: { code: "stopped", message: "Stopped." } } : {}),
      ...(done ? { result: this.result(job) } : {}),
      draft: !this.options.draftGone,
      ...(job.remake ? { remakeOf: { id: job.remake.of, beat: job.remake.beat } } : {}),
    };
  }

  private result(job: Video): Record<string, unknown> {
    const passages = (job.body.passages as Array<{ id: string; sourceId: string; text: string }>).slice(0, this.sceneCount(job));
    const wrong = this.options.badQuoteFirst && job.revised.length === 0;
    const scenes = passages.map((passage, at) => {
      const words = passage.text.split(/\s+/).filter(Boolean);
      const quote = wrong && at === 0 ? "words that the passage never says" : words.slice(0, Math.min(8, words.length)).join(" ");
      return {
        id: `s${at + 1}`,
        durationMs: 6000,
        // The beat a remake made again says so; the others are as they were.
        narration: `${this.options.narrations?.[at] ?? words.slice(0, Math.min(12, words.length)).join(" ")}${job.remake?.beat === `s${at + 1}` ? " Made again." : ""}`,
        onScreenText: [`Part ${at + 1}`],
        visual: `A chalk drawing that shows part ${at + 1} of the idea, labelled in plain words.`,
        cites: [{ passageId: passage.id, sourceId: passage.sourceId, quote }],
      };
    });
    return {
      title: String(job.body.title || "A drawn video"),
      idea: "What the sources say, drawn scene by scene.",
      scenes,
      file: { bytes: (this.options.file ?? DEFAULT_FILE).byteLength, durationMs: scenes.length * 6000, width: 1080, height: 1920, contentType: "video/mp4" },
      voice: job.withoutSound
        ? { id: "silent", label: "No voice (made without sound)", real: false, note: "Made without sound, as you chose, because the voice could not speak; the captions carry the words." }
        : (this.options.voice ?? { id: "elevenlabs", label: "ElevenLabs", real: true }),
      by: {
        maker: "scenes",
        agent: typeof job.body.agent === "string" ? job.body.agent : (this.options.agent?.id ?? "claude"),
        ...(typeof job.body.model === "string" ? { model: job.body.model } : this.options.agent?.model ? { model: this.options.agent.model } : {}),
        ...(typeof job.body.effort === "string" ? { effort: job.body.effort } : this.options.agent?.effort ? { effort: this.options.agent.effort } : {}),
        style: job.style,
      },
      // As the real service sums it: the making, and the fresh viewer's own turn apart when it watched.
      timing: {
        makingSeconds: 300 + 60 * job.revised.length,
        ...(job.body.review !== false ? { review: { seconds: 45, agent: typeof job.body.reviewAgent === "string" ? job.body.reviewAgent : typeof job.body.agent === "string" ? job.body.agent : (this.options.agent?.id ?? "claude"), ...(typeof job.body.reviewModel === "string" ? { model: job.body.reviewModel } : {}), ...(typeof job.body.reviewEffort === "string" ? { effort: job.body.reviewEffort } : {}) } } : {}),
      },
    };
  }
}

function step(label: string): { label: string; at: string } {
  return { label, at: new Date().toISOString() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
