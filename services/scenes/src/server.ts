/**
 * The scenes service's HTTP server, on this computer only (127.0.0.1).
 *
 *   GET  /status                    the maker, whether the person's agent can run, the voice, the styles, and how fast
 *                                   this computer draws each (`speed`, once measured)
 *   GET  /voice                     whether the voice can speak now, without speaking   → { ok, trouble?, message? }
 *   GET  /voice/setup               the voice as set up: the service, its voice, where the choice comes from, every
 *                                   service offered (src/voice-setup.ts); a key is never in an answer
 *   PUT  /voice/setup               { service: id | null, voice?: id | null }   → the setup
 *   PUT  /voice/services/:id/key    { key }: checked with the service, kept when taken   → { service } with its health
 *   DELETE /voice/services/:id/key  forgets the app's key   → the setup
 *   GET  /voice/services/:id/voices the voices on the person's account   → { voices }
 *   GET  /voice/services/:id/voices/:voiceId/sample   the voice's own preview (audio)
 *   GET  /styles/:id/preview        a JPEG of a sample scene in that style
 *   POST /videos                    start a video (idempotent by id)          → 202 { id }
 *   GET  /videos/:id                its state, progress, steps, failure or result
 *   GET  /videos/:id/file           the mp4
 *   POST /videos/:id/stop           stop it
 *   POST /videos/:id/revise         a new writing round with Open Sourcebook's checker's problems
 *   POST /videos/:id/remake-scene   { id, beat, note?, agent?, model?, effort? }: a new video, copied from this finished
 *                                   one, with that beat made again as the person asks   → 202 { id }, 409 { error, message }
 *   POST /videos/:id/show-files     opens the video's job folder in this computer's file manager   → 200 { folder }
 *   POST /videos/:id/resume         carry a failed or stopped video on from its draft   → 200 the job, 409 { error }
 *                                   { withoutSound: true }: finished with no voice, after the voice could not speak
 *   POST /audio                     start voicing an audio (idempotent by id)  → 202 { id }
 *   GET  /audio/:id                 its state, progress, step, failure or result
 *   GET  /audio/:id/file            the m4a
 *   POST /audio/:id/stop            stop it
 *   POST /turns/:turnId/tools       a tool call from the agent's turn (the connector forwards it)
 *   POST /turns/:turnId/finish      the turn's end (from the connector)
 *
 * All but the turn routes take the service's token (`Authorization: Bearer`). The turn routes take the turn's own token, which
 * only that turn's connector call has.
 */
import { audioStatus, audioView, readAudioRequest, type AudioJobs } from "./audio.ts";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Connector } from "./connector.ts";
import { view, type Jobs } from "./jobs.ts";
import { openFolder } from "./folder.ts";
import { stylePreview } from "./preview.ts";
import { readRequest } from "./request.ts";
import type { SpeedBook } from "./speed.ts";
import { framesAtOnce, thisMachine } from "../pipeline/lib/frames-at-once.ts";
import type { Style } from "./styles.ts";
import { voiceNow, type VoiceSource } from "./voice.ts";
import { VoiceSetupError, type VoiceSetup } from "./voice-setup.ts";

export interface ServerOptions {
  token: string;
  jobs: Jobs;
  /** The audio jobs; without them the audio routes are not found (`/status` still says whether audio could be voiced). */
  audio?: AudioJobs;
  connector: Connector;
  /** The voice, or what gives the voice of the moment. */
  voice: VoiceSource;
  /** The voice as set up in the app; without it the /voice/setup routes are not found. */
  setup?: VoiceSetup;
  /** Every style, offered or not: /status lists them with `offered`, and a video may name any of them. */
  styles: () => Style[];
  dataDir: string;
  /** How fast this computer has drawn each style (src/speed.ts); /status says it. None: /status says nothing about time. */
  speed?: SpeedBook;
  log?: (line: string) => void;
  /** Opens a folder in the file manager (src/folder.ts, `openFolder`, by default); tests watch it. */
  showFolder?: (folder: string) => Promise<void>;
}

export const MAKER = {
  id: "scenes",
  label: "Drawn scenes",
  // Only what it makes and how long it takes: Open Sourcebook's engine adds where it runs and what it needs.
  description: "Your own agent writes the video as drawn, animated scenes in a style you pick, checks every scene's frames and fixes them; then this computer renders it, with a voice when you have given a key and without sound when not. Usually takes 5 to 30 minutes depending on the model and effort.",
};

const MAX_BODY = 8_000_000;

export function createScenesServer(o: ServerOptions): Server {
  const server = createServer((request, response) => {
    void handle(request, response).catch((e) => {
      o.log?.(`error: ${(e as Error).message}`);
      if (!response.headersSent) send(response, 500, { error: "internal_error" });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const turn = /^\/turns\/([^/]+)\/(tools|finish)$/.exec(path);
    if (turn) {
      if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
      const body = await readJson(request);
      const id = decodeURIComponent(turn[1]!);
      if (turn[2] === "tools") {
        const answer = await o.jobs.toolCall(id, header(request, "authorization"), body);
        return answer ? send(response, 200, answer) : send(response, 404, { error: "not_found" });
      }
      return o.jobs.turnEnded(id, header(request, "authorization"), body) ? send(response, 200, { ok: true }) : send(response, 404, { error: "not_found" });
    }

    const bearer = header(request, "authorization");
    if (!bearer?.startsWith("Bearer ") || !safeEqual(bearer.slice(7).trim(), o.token)) return send(response, 401, { error: "unauthorized" });

    const voice = voiceNow(o.voice);
    if (path.startsWith("/voice/")) return voiceRoutes(request, response, path);
    if (request.method === "GET" && path === "/status") {
      const agent = await o.connector.status();
      // How fast this computer draws each style, from what it measured; a style it has not measured is left out.
      const speed = o.speed ? o.speed.view(o.styles().map((s) => s.id), framesAtOnce(thisMachine()).frames) : {};
      return send(response, 200, {
        ok: true, maker: MAKER, agent,
        voice: { id: voice.id, label: voice.label, real: voice.real, ...(voice.note ? { note: voice.note } : {}) },
        styles: o.styles(),
        ...(Object.keys(speed).length ? { speed } : {}),
        // How long whole videos took to make here (writing, voice and drawing), the newest few per pick: nothing when none was made.
        ...(o.speed && o.speed.made().length ? { made: o.speed.made().map(({ seconds, videoSeconds, agent, model, effort }) => ({ seconds, videoSeconds, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) })) } : {}),
        // Whether this computer can voice audio now, and if not why.
        audio: audioStatus(voice),
      });
    }
    if (request.method === "GET" && path === "/voice") {
      // Asked by the engine for videos waiting on the voice: a free look, never a narration paid for.
      const health = voice.check ? await voice.check().catch((e: Error) => ({ ok: false as const, trouble: "unreachable" as const, message: e.message })) : { ok: true as const };
      return send(response, 200, health);
    }
    const preview = /^\/styles\/([^/]+)\/preview$/.exec(path);
    if (request.method === "GET" && preview) {
      const style = decodeURIComponent(preview[1]!);
      if (!o.styles().some((s) => s.id === style)) return send(response, 404, { error: "not_found" });
      const file = await stylePreview(style, o.dataDir);
      return sendFile(response, file, "image/jpeg");
    }
    if (request.method === "POST" && path === "/videos") {
      const read = readRequest(await readJson(request), o.styles().map((s) => s.id));
      if ("problems" in read) return send(response, 400, { error: "bad_request", problems: read.problems });
      const job = o.jobs.create(read.request);
      return send(response, 202, { id: job.id });
    }
    const video = /^\/videos\/([^/]+)(?:\/(file|stop|revise|resume|remake-scene|show-files))?$/.exec(path);
    if (video) {
      const id = decodeURIComponent(video[1]!);
      const what = video[2];
      if (!what && request.method === "GET") {
        const job = o.jobs.get(id);
        // `draft`: whether what it was made from is still in the data folder, so one scene of it can be made again.
        return job ? send(response, 200, { ...view(job), draft: existsSync(join(o.jobs.folder(id), "draft.json")) }) : send(response, 404, { error: "not_found" });
      }
      if (what === "remake-scene" && request.method === "POST") {
        const body = (await readJson(request)) as Record<string, unknown> | undefined;
        const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
        const problems: string[] = [];
        const newId = str(body?.id) ?? "";
        const beat = str(body?.beat) ?? "";
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(newId)) problems.push("id: the new video's id, letters, digits, - and _, up to 100.");
        if (!beat) problems.push("beat: the id of the beat to make again.");
        if (body?.note !== undefined && typeof body.note !== "string") problems.push("note: the person's words, as text.");
        if (problems.length) return send(response, 400, { error: "bad_request", problems });
        const r = o.jobs.remakeScene(id, { id: newId, beat, ...(str(body?.note) ? { note: str(body?.note)! } : {}), ...(str(body?.agent) ? { agent: str(body?.agent)! } : {}), ...(str(body?.model) ? { model: str(body?.model)! } : {}), ...(str(body?.effort) ? { effort: str(body?.effort)! } : {}) });
        if (r.refused) return send(response, r.refused.code === "no_beat" ? 404 : 409, { error: r.refused.code, message: r.refused.message });
        if (!r.job) return send(response, 404, { error: "not_found" });
        return send(response, 202, { id: r.job.id });
      }
      if (what === "show-files" && request.method === "POST") {
        const folder = o.jobs.folder(id);
        if (!o.jobs.get(id) || !existsSync(folder)) return send(response, 404, { error: "not_found", message: "This video's files are no longer on this computer." });
        try {
          await (o.showFolder ?? openFolder)(folder);
        } catch (e) {
          return send(response, 500, { error: "cannot_open", message: `The folder could not be opened: ${(e as Error).message}` });
        }
        return send(response, 200, { folder });
      }
      if (what === "file" && request.method === "GET") {
        const job = o.jobs.get(id);
        if (!job) return send(response, 404, { error: "not_found" });
        if (job.state !== "done") return send(response, 409, { error: "not_ready", state: job.state });
        return sendFile(response, join(o.jobs.folder(id), "video.mp4"), "video/mp4");
      }
      if (what === "stop" && request.method === "POST") {
        const job = await o.jobs.stop(id);
        return job ? send(response, 200, view(job)) : send(response, 404, { error: "not_found" });
      }
      if (what === "revise" && request.method === "POST") {
        const body = (await readJson(request)) as { problems?: unknown } | undefined;
        const problems = Array.isArray(body?.problems) ? body.problems.map(String).filter((p) => p.trim()) : [];
        if (!problems.length) return send(response, 400, { error: "bad_request", problems: ["problems: a list of what Open Sourcebook's checker found."] });
        const r = o.jobs.revise(id, problems);
        if (!r.job) return send(response, 404, { error: "not_found" });
        if (r.refused) return send(response, 409, { error: "not_revisable", message: r.refused });
        return send(response, 202, { id });
      }
      if (what === "resume" && request.method === "POST") {
        const body = (await readJson(request)) as { withoutSound?: unknown } | undefined;
        const r = o.jobs.resume(id, { withoutSound: body?.withoutSound === true });
        if (!r.job) return send(response, 404, { error: "not_found" });
        if (r.refused) return send(response, 409, { error: r.refused });
        return send(response, 200, view(r.job));
      }
    }
    // Audio: voiced from the parts the engine sends (engine/docs/audio.md, "The scenes service's audio calls").
    if (o.audio && request.method === "POST" && path === "/audio") {
      const ready = audioStatus(voice);
      if (!ready.ready) return send(response, 409, { error: "no_voice", message: ready.problem });
      const read = readAudioRequest(await readJson(request));
      if ("problems" in read) return send(response, 400, { error: "bad_request", problems: read.problems });
      const job = o.audio.create(read.request);
      return send(response, 202, { id: job.id });
    }
    const audio = /^\/audio\/([^/]+)(?:\/(file|stop))?$/.exec(path);
    if (o.audio && audio) {
      const id = decodeURIComponent(audio[1]!);
      const job = o.audio.get(id);
      if (!job) return send(response, 404, { error: "not_found" });
      if (!audio[2] && request.method === "GET") return send(response, 200, audioView(job));
      if (audio[2] === "file" && request.method === "GET") {
        if (job.state !== "done") return send(response, 409, { error: "not_ready", state: job.state });
        return sendFile(response, o.audio.file(id), "audio/mp4");
      }
      if (audio[2] === "stop" && request.method === "POST") return send(response, 200, audioView(o.audio.stop(id) ?? job));
    }
    return send(response, 404, { error: "not_found" });
  }

  /** The voice set up in the app. A refusal answers `{ error, message }`; a key is never in an answer or a log line. */
  async function voiceRoutes(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const setup = o.setup;
    if (!setup) return send(response, 404, { error: "not_found" });
    try {
      if (path === "/voice/setup") {
        if (request.method === "GET") return send(response, 200, await setup.setup());
        if (request.method === "PUT") return send(response, 200, await setup.choose(await readJson(request)));
      }
      const key = /^\/voice\/services\/([^/]+)\/key$/.exec(path);
      if (key) {
        const id = decodeURIComponent(key[1]!);
        if (request.method === "PUT") return send(response, 200, await setup.setKey(id, await readJson(request)));
        if (request.method === "DELETE") return send(response, 200, await setup.clearKey(id));
      }
      const voices = /^\/voice\/services\/([^/]+)\/voices$/.exec(path);
      if (voices && request.method === "GET") return send(response, 200, { voices: await setup.voices(decodeURIComponent(voices[1]!)) });
      const sample = /^\/voice\/services\/([^/]+)\/voices\/([^/]+)\/sample$/.exec(path);
      if (sample && request.method === "GET") {
        const heard = await setup.sample(decodeURIComponent(sample[1]!), decodeURIComponent(sample[2]!));
        response.writeHead(200, { "content-type": heard.contentType, "content-length": String(heard.bytes.byteLength), "cache-control": "private, max-age=3600" }).end(Buffer.from(heard.bytes));
        return;
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof VoiceSetupError) return send(response, error.status, { error: error.code, message: error.message });
      throw error;
    }
  }

  return server;
}

function safeEqual(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sendFile(response: ServerResponse, file: string, type: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return send(response, 404, { error: "not_found" });
  }
  response.writeHead(200, { "content-type": type, "content-length": String(size), "cache-control": "no-store" });
  createReadStream(file).pipe(response);
}
