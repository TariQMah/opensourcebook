/**
 * The scenes maker (docs/DECISIONS.md #54): the person's own agent writes
 * the video in a scene language, builds each scene, looks at its frames and
 * fixes it, all inside the scenes service on their computer (client.ts).
 * Open Sourcebook hands it the item's passages, brief, earlier items, length and style,
 * shows its steps while it works, checks the script it comes back with like
 * any video (quotes word for word, lengths, labels), sends a cite untrue to
 * the sources back once, and keeps the file. It writes with no Open Sourcebook model: Open Sourcebook
 * pays nothing, the person's own subscription does.
 *
 * A video comes back rendered, watched and taken by the agent, which met the
 * same wording and length checks while it wrote (the scenes service answers
 * write_beat with them). So nothing but a cite untrue to the sources holds it
 * back: whatever else Open Sourcebook's checks still find is said in the video's notes,
 * where the person sees it, and the file they were made for is kept.
 *
 *   plan      no call: the passages are checked and the style is kept.
 *   generate  starts the video on the service (or re-attaches to it) and
 *             follows it to the end, its steps shown on the item.
 *   validate  Open Sourcebook's own video checks in code; the agent looked at its frames.
 *             Only a cite untrue to the sources is an error here.
 *   repair    once, for such a cite: it goes back to the agent, which writes again.
 *   produce   the file is fetched and stored; `render.storyboard` is false.
 *
 * Local only for now, like the chat's own agent (#53).
 */
import { packSkills } from "../../../chat/agent/work-skills";
import { buildPassages, type Passage } from "../../../sources/passages";
import type { Citation, CostEstimate, EngineContext, EngineOutput, JsonValue, MakeTiming, NodeSource, OutputEngine, SceneRemakeOf, SourceLocator, ValidationReport } from "../../../studio/types";
import { agentErrorFailure, JobFailure } from "../../../jobs/lifecycle";
import { JobWait, type WaitChoice } from "../../../jobs/waits";
import type { JobFailureCode } from "../../../jobs/failure-words";
import { ASPECTS, VIDEO_LIMITS, VIDEO_SCHEMA_VERSION, type Scene, type SceneCite, type Video, type VideoRender } from "../../../video/contract";
import { PipelineError } from "../../retry";
import type { VideoSettings } from "../definition";
import { workPickFor } from "../../agent-fields";
import { parseVideoAgent } from "../definition";
import { reviewerPickOf, type ReviewerSettings } from "../../agent-fields";
import { checkVideo, keptNotes, keptOver, summarize, type VideoBlueprint } from "../checks";
import { OPEN_PICK, type VideoMaker, type VideoMakerStatus, type VideoMakerStyle } from "../makers";
import {
  cachedScenesStatus,
  rememberScenesStatus,
  ScenesClient,
  ScenesUnreachableError,
  type ScenesFailureCode,
  type ScenesJob,
  type ScenesPassage,
  type ScenesSource,
  type ScenesResult,
  type ScenesStatus,
} from "./client";

export const SCENES_MAKER_ID = "scenes";

/** Its words when the service has not said its own (it is not running, or has not been asked yet). */
const LABEL = "Drawn scenes";
const DESCRIPTION =
  "Your own agent writes drawn, moving scenes from the sources, looks at its frames and fixes them; Open Sourcebook checks every quote. Good when a picture explains it: a process, a mechanism, a comparison. Usually takes 5 to 30 minutes depending on the model and effort.";
/** Always said after its description: what it needs, so neither the person nor the planner picks it where it cannot run. */
const NEEDS = "Works only on this computer, with Open Sourcebook's scene maker and your agent running.";

/** The frame the service renders: tall, the only shape this maker makes. */
const FRAME = { width: 1080, height: 1920 };
const FPS = 30;

export interface ScenesMakerOptions {
  client: ScenesClient;
  /** Wait between reads of a running video. */
  pollMs?: number;
  /**
   * Longest the engine follows one video before it stops it; none by default. A video has no clock (the agent works
   * until it finishes or the person stops it): the scenes service tells a hung agent from a slow one by its tool calls
   * and stops only the hung one, keeping its work, and says so in the failure the engine reads.
   */
  maxMinutes?: number;
  /** Reads in a row that may fail before the service counts as gone. */
  maxMissedReads?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => number;
  /**
   * How long this computer took to make a video on exactly this pick and length (`make_times`: the same agent, model,
   * effort and length bucket), in seconds, or undefined when it never has. Without it nothing is expected before the
   * last drawing. `ownerId` is whose job it is, when the job says.
   */
  madeIn?: (pick: { agent: string; model?: string; effort?: string }, settings: VideoSettings, ownerId?: string) => Promise<number | undefined>;
}

export interface ScenesBlueprint {
  /** The style asked for: one of the service's, or "auto" for the agent's pick. */
  style: string;
}

/** Where a job keeps the id of the video it follows on the service; kept on the job once the output is written too. */
const VIDEO_KEY = "scenes:video";

/** Said when what a video was made from is gone from the scenes service, so one scene of it cannot be made again. */
const DRAFT_GONE = "What this video was made from is no longer on this computer, so one scene of it can't be made again. Make the whole video again instead.";

/** Said when a video's job folder is gone from this computer (cleaned up some days after it was made). */
const FILES_GONE = "This video's files are no longer on this computer: they are cleaned up some days after a video is made.";

/** The scenes service's id of the video a job made: what it kept, else the job's own id, the first one it uses. */
function madeVideoId(from: { madeBy?: string; kept?: Record<string, JsonValue> }): string | undefined {
  const kept = from.kept?.[VIDEO_KEY];
  return typeof kept === "string" && kept ? kept : from.madeBy;
}

/** The service's beat for a scene of the made video, by its place: the engine names scenes s1, s2, ... in playing order. */
function beatOf(job: ScenesJob | undefined, scene: string): string | undefined {
  const at = /^s(\d+)$/.exec(scene);
  const beat = at ? job?.result?.scenes?.[Number(at[1]) - 1]?.id : undefined;
  return typeof beat === "string" && beat ? beat : undefined;
}

export function createScenesMaker(options: ScenesMakerOptions): VideoMaker<ScenesBlueprint> {
  const url = options.client.config.url;
  const heard = () => cachedScenesStatus(url);
  const label = () => heard()?.maker?.label ?? LABEL;
  return {
    id: SCENES_MAKER_ID,
    get label() {
      return label();
    },
    get description() {
      return `${heard()?.maker?.description || DESCRIPTION} ${NEEDS}`;
    },
    about: "drawn, moving scenes your own agent writes and renders on this computer, with a voice when you give a key",
    local: true,
    usesAgent: true,
    engine: new ScenesEngine(options, label),
    maxRepairRounds: 1,
    styles: () => stylesOf(heard()),
    defaultAgent: () => {
      const a = heard()?.agent;
      return a?.id ? { agent: a.id, ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}) } : undefined;
    },
    estimateCost: (input): CostEstimate =>
      input.sourceCount === 0 || input.sourceChars === 0
        ? { usd: 0, basis: "no source text to make a video from" }
        : { usd: 0, basis: "written by your own agent on this computer: no model cost to Open Sourcebook" },
    issues: (settings) => issuesFor(heard(), settings, label()),
    notices: (settings) => noticesOf(heard(), settings),
    status: async (signal) => {
      const status = await options.client.status(signal);
      rememberScenesStatus(url, status);
      return statusFor(status, label());
    },
    preview: (styleId, signal) => options.client.preview(styleId, signal),
    showsFiles: async ({ jobId, kept, signal }) => {
      const id = madeVideoId({ madeBy: jobId, kept });
      if (!id) return FILES_GONE;
      try {
        return (await options.client.showFiles(id, signal)) ? undefined : FILES_GONE;
      } catch (error) {
        if (error instanceof ScenesUnreachableError) return `${label()} needs Open Sourcebook's scene maker running on this computer to show its files. Start it, then try again.`;
        throw error;
      }
    },
    remakesScene: {
      check: async ({ scene, madeBy, kept, signal }) => {
        const id = madeVideoId({ ...(madeBy ? { madeBy } : {}), kept });
        if (!id) return DRAFT_GONE;
        let job: ScenesJob | undefined;
        try {
          job = await options.client.get(id, signal);
        } catch (error) {
          if (error instanceof ScenesUnreachableError) return `${label()} needs Open Sourcebook's scene maker running on this computer to make a scene again. Start it, then try again.`;
          throw error;
        }
        if (!job || job.draft === false || job.state !== "done" || !beatOf(job, scene)) return DRAFT_GONE;
        return undefined;
      },
    },
  };
}

// The styles to choose from: those the service offers. One it keeps but does not offer still makes an item that names it.
function stylesOf(status: ScenesStatus | undefined): VideoMakerStyle[] {
  return (status?.styles ?? []).filter((style) => style.offered).map(({ offered: _offered, ...style }) => ({ ...style, preview: `/v1/video-makers/${SCENES_MAKER_ID}/styles/${encodeURIComponent(style.id)}/preview` }));
}

/** What stops an item from being made now, from what the service last said. Nothing heard yet: nothing said. */
function issuesFor(status: ScenesStatus | undefined, settings: VideoSettings, label: string): string[] {
  const issues: string[] = [];
  if (settings.aspect !== "portrait") issues.push(`${label} makes tall videos only: set its shape to Portrait, or pick another maker`);
  if (!status) return issues;
  if (!status.reachable) return [...issues, `${label} needs Open Sourcebook's scene maker running on this computer: start it, or pick another maker`];
  if (status.agent && !status.agent.reachable) {
    issues.push(`${label} needs your agent, and ${agentProblem(status.agent.problem)}: start it, or pick another maker`);
  }
  const style = settings.style;
  if (style && style !== OPEN_PICK && status.styles.length > 0 && !status.styles.some((known) => known.id === style)) {
    issues.push(`${label} has no style "${style}": pick another style`);
  }
  return issues;
}

/**
 * What a person should know about a video with these settings, from what the service last said: that it will have no
 * sound and what to do for one. How long it takes is said by the times kept from past runs (`GET /v1/make-times`), never
 * guessed here.
 */
function noticesOf(status: ScenesStatus | undefined, _settings?: VideoSettings): string[] {
  const note = status?.reachable ? status.voice?.note : undefined;
  return note ? [note] : [];
}

/**
 * When a video being made should be done, for the time left on its row, or null when that cannot be known now.
 * While it is drawn for the last time, from how far the drawing is and how long it has taken (drawing goes at an even
 * pace); before that, from when it started and how long this computer took on exactly this pick and length (`making`,
 * from `make_times`); null with no such run, and once it is past what was expected, so a number never grows or
 * promises what this computer has no reason to.
 */
export function expectedDone(input: { now: number; startedAt: number; state: string; progress: number; renderingSince?: number; making?: number }): number | null {
  const { now } = input;
  if (input.state === "rendering" && input.renderingSince !== undefined) {
    const drawn = Math.min(1, Math.max(0, (input.progress - RENDER_FROM) / (1 - RENDER_FROM)));
    const spent = (now - input.renderingSince) / 1000;
    if (drawn >= 0.1 && spent >= 15) return now + ((spent * (1 - drawn)) / drawn) * 1000;
  }
  if (input.making === undefined || !Number.isFinite(input.startedAt)) return null;
  const doneBy = input.startedAt + input.making * 1000;
  // Within the last half minute of what was expected, or past it, the end is not known any more.
  return doneBy - now > 30_000 ? doneBy : null;
}

/** Where the scenes service's progress is when its last render starts (services/scenes, jobs.ts: 0.8 + 0.2 of the frames). */
const RENDER_FROM = 0.8;

function statusFor(status: ScenesStatus, label: string): VideoMakerStatus {
  const agent = status.agent
    ? {
        ...(status.agent.id ? { id: status.agent.id } : {}),
        ...(status.agent.label ? { label: status.agent.label } : {}),
        ...(status.agent.model ? { model: status.agent.model } : {}),
        ...(status.agent.effort ? { effort: status.agent.effort } : {}),
      }
    : undefined;
  if (!status.reachable) return { available: false, problem: `${label} needs Open Sourcebook's scene maker running on this computer. Start it to make videos with it.` };
  if (status.agent && !status.agent.reachable) return { available: false, problem: `${label} needs your agent, and ${agentProblem(status.agent.problem)}.`, ...(agent ? { agent } : {}) };
  const [notice] = noticesOf(status);
  return { available: true, ...(agent ? { agent } : {}), ...(notice ? { notice } : {}) };
}

/** The service's reason the agent is not there, in a clause. */
function agentProblem(problem: string | undefined): string {
  switch (problem) {
    case "agentMissing":
      return "it doesn't look installed";
    case "agentSignedOut":
      return "it isn't signed in";
    case "agentLimit":
      return "its plan has reached its usage limit for now";
    case "agentUnreachable":
    case undefined:
      return "the connector on this computer isn't running";
    default:
      return "it isn't answering";
  }
}

class ScenesEngine implements OutputEngine<VideoSettings, ScenesBlueprint, Video> {
  readonly type = "video";
  readonly schemaVersion = VIDEO_SCHEMA_VERSION;

  constructor(
    private readonly options: ScenesMakerOptions,
    private readonly label: () => string,
  ) {}

  private get client(): ScenesClient {
    return this.options.client;
  }

  async plan(ctx: EngineContext<VideoSettings>): Promise<ScenesBlueprint> {
    requirePassages(ctx);
    if (ctx.node.settings.aspect !== "portrait") {
      throw new JobFailure(`${this.label()} makes tall videos only; this item asks for ${ctx.node.settings.aspect}.`, false, "bad_settings");
    }
    await ctx.services.progress({ stage: "planning", progress: 0.02, step: "Getting the sources ready for your agent" });
    return { style: ctx.node.settings.style ?? OPEN_PICK };
  }

  async generate(ctx: EngineContext<VideoSettings>, blueprint: ScenesBlueprint): Promise<EngineOutput<Video>> {
    const passages = requirePassages(ctx);
    const id = await this.attach(ctx, blueprint, passages);
    const job = await this.follow(ctx, id, 0.05, 0.85);
    return this.toOutput(ctx, job.result!, passages);
  }

  async validate(ctx: EngineContext<VideoSettings>, output: EngineOutput<Video>): Promise<ValidationReport> {
    // The agent built, rendered and watched every scene; Open Sourcebook's own checks in code are the last gate, and only a cite
    // untrue to the sources closes it. The rest is kept over and said in the video's notes (produce).
    const { issues } = keptOver(this.check(ctx, output.payload));
    return { valid: !issues.some((issue) => issue.severity === "error"), issues };
  }

  /** Open Sourcebook's checks on a video this maker rendered: its scenes last as long as their voice, so that is not checked. */
  private check(ctx: EngineContext<VideoSettings>, video: Video) {
    const shape: VideoBlueprint = {
      title: video.title,
      idea: video.idea,
      scenes: video.scenes.map((scene) => ({ does: "", kind: scene.kind, passageIds: [], seconds: scene.durationMs / 1000 })),
      minutes: ctx.node.settings.minutes,
      omittedPassages: 0,
    };
    return checkVideo(video, shape, byId(requirePassages(ctx)), { timedByVoice: true });
  }

  async repair(ctx: EngineContext<VideoSettings>, output: EngineOutput<Video>, report: ValidationReport): Promise<EngineOutput<Video>> {
    const id = this.videoId(ctx);
    const problems = report.issues.filter((issue) => issue.severity === "error").map(problemLine);
    await ctx.services.progress({ stage: "repairing", progress: 0.86, step: "Sending Open Sourcebook's checks back to your agent" });
    // A service that will not take them back leaves the video as it is; validation then fails it.
    if (!(await this.call(() => this.client.revise(id, problems, ctx.services.signal)))) return output;
    const job = await this.follow(ctx, id, 0.86, 0.89);
    return this.toOutput(ctx, job.result!, requirePassages(ctx));
  }

  async produce(ctx: EngineContext<VideoSettings>, output: EngineOutput<Video>): Promise<EngineOutput<Video>> {
    const id = this.videoId(ctx);
    await ctx.services.progress({ stage: "producing", progress: 0.92, step: "Saving the video" });
    const job = await this.call(() => this.client.get(id, ctx.services.signal));
    const result = job?.state === "done" ? job.result : undefined;
    if (!result) throw new JobFailure(`The scenes service no longer has video ${id} finished.`, true, "maker_unreachable");
    const file = await this.call(() => this.client.file(id, ctx.services.signal));
    const asset = await ctx.services.assets.putAsset(file.bytes, { kind: "video", contentType: result.file.contentType || file.contentType });
    if (!asset) throw new PipelineError("No asset store is bound, so the video file cannot be kept.", "NO_PRODUCTION");
    await this.recordUsage(ctx, job!, true);
    let at = 0;
    const scenes = output.payload.scenes.map((scene) => {
      const span = { id: scene.id, startMs: at, endMs: at + scene.durationMs };
      at += scene.durationMs;
      return span;
    });
    const styleLabel = cachedScenesStatus(this.client.config.url)?.styles.find((style) => style.id === result.by.style)?.label;
    const cachedAgent = cachedScenesStatus(this.client.config.url)?.agent;
    const agentLabel = cachedAgent?.id === result.by.agent ? cachedAgent.label : undefined;
    const render: VideoRender = {
      by: SCENES_MAKER_ID,
      storyboard: false,
      assetId: asset.id,
      url: asset.url,
      contentType: asset.contentType ?? "video/mp4",
      width: result.file.width,
      height: result.file.height,
      fps: typeof result.file.fps === "number" && result.file.fps > 0 ? result.file.fps : FPS,
      durationMs: result.file.durationMs,
      audio: result.voice.real,
      captions: true,
      scenes,
      renderMs: elapsedMs(job!),
      madeAt: ctx.services.now(),
      maker: {
        id: SCENES_MAKER_ID,
        label: this.label(),
        ...(result.by.style ? { style: { id: result.by.style, label: styleLabel ?? result.by.style } } : {}),
        ...(result.by.agent
          ? {
              agent: {
                id: result.by.agent,
                ...(agentLabel ? { label: agentLabel } : {}),
                ...(result.by.model ? { model: result.by.model } : {}),
                ...(result.by.effort ? { effort: result.by.effort } : {}),
              },
            }
          : {}),
        voice: { id: result.voice.id, label: result.voice.label, real: result.voice.real, ...(result.voice.note ? { note: result.voice.note } : {}) },
      },
    };
    // What Open Sourcebook's checks found and the video was kept over, where the person sees it.
    const notes = keptNotes(keptOver(this.check(ctx, output.payload)).kept);
    await ctx.services.progress({ stage: "produced", progress: 1, step: "Done" });
    // The video's id on the service, kept on the job once its pieces are spent, so one scene of it can be made again.
    return { ...output, payload: { ...output.payload, render, ...(notes.length ? { notes } : {}) }, keep: { ...output.keep, [VIDEO_KEY]: id } };
  }

  /** The id of the video this job follows: the one an earlier delivery started, or a new one. */
  private async attach(ctx: EngineContext<VideoSettings>, blueprint: ScenesBlueprint, passages: Passage[]): Promise<string> {
    const kept = ctx.services.checkpoint?.get(VIDEO_KEY);
    let id = typeof kept === "string" ? kept : ctx.jobId;
    const existing = await this.call(() => this.client.get(id, ctx.services.signal));
    if (existing && existing.state !== "failed" && existing.state !== "stopped") {
      // A redelivery or a retry after the write was lost: follow the video already being made.
      await ctx.services.checkpoint?.put(VIDEO_KEY, id);
      return id;
    }
    // A video that ended (the agent's limit, a restart, a Stop, a failure) is carried on from its draft when the service can.
    if (existing) {
      // The person chose to finish it without sound while it waited for the voice: carried on with no voice.
      const withoutSound = ctx.services.chosen === WITHOUT_SOUND.id;
      await ctx.services.progress({ stage: "writing", progress: 0.04, step: withoutSound ? "Finishing it without sound" : existing.failure?.code === "voiceDown" ? "Carrying on with the voice" : "Asking your agent to carry on" });
      if (await this.call(() => this.client.resume(id, ctx.services.signal, { withoutSound }))) {
        await ctx.services.checkpoint?.put(VIDEO_KEY, id);
        return id;
      }
      // One it cannot carry on is made again as a new video.
      id = nextId(ctx.jobId, id);
    }
    await ctx.services.checkpoint?.put(VIDEO_KEY, id);
    // The scenes service hands the turn to the connector, which runs only a turn that names an agent.
    const picked = await workPickFor(ctx);
    if (ctx.remakeOf) {
      await this.remake(ctx, id, ctx.remakeOf, picked);
      return id;
    }
    await ctx.services.progress({ stage: "writing", progress: 0.04, step: "Asking your agent to start" });
    // The project's packs go with the video, so the agent that makes it reads them as the byte and quiz makers do.
    const packs = packSkills(ctx.project?.packs ?? []);
    // Where the finished video is copied: the project's linked folder, else its folder in the library.
    const library = await ctx.services.libraryFolder?.();
    await this.call(() =>
      this.client.start(
        {
          id,
          title: ctx.node.title,
          brief: ctx.node.prompt,
          ...(ctx.assumes.length > 0 ? { assumes: ctx.assumes.map((prior) => `${prior.title}: ${prior.summary}`) } : {}),
          frame: FRAME,
          ...(ctx.node.settings.minutes > 0 ? { targetSeconds: Math.round(ctx.node.settings.minutes * 60) } : {}),
          style: blueprint.style,
          ...(picked.agent ? { agent: picked.agent } : {}),
          ...(picked.model ? { model: picked.model } : {}),
          ...(picked.effort ? { effort: picked.effort } : {}),
          ...reviewOf(ctx.node.settings, picked.agent),
          passages: passages.map(toWirePassage),
          sources: readSources(ctx.sources).map(toWireSource),
          ...(library ? { library } : {}),
          ...(packs.length > 0 ? { skills: packs } : {}),
          limits: {
            maxScenes: VIDEO_LIMITS.maxScenes,
            minScenes: 1,
            narrationMaxChars: VIDEO_LIMITS.narration,
            visualMinChars: VIDEO_LIMITS.visualMin,
            visualMaxChars: VIDEO_LIMITS.visualMax,
            onScreenTextMax: VIDEO_LIMITS.onScreenEntries,
            onScreenChars: VIDEO_LIMITS.onScreenChars,
            cites: VIDEO_LIMITS.cites,
            quoteChars: VIDEO_LIMITS.quote,
          },
        },
        ctx.services.signal,
      ),
    );
    return id;
  }

  /**
   * A remake of one scene: a new video on the service, copied there from the finished one with that beat to make
   * again in the person's words, so the finished one stays and plays until this one is done. What it was made from
   * being gone fails the job plainly; it cannot come back by trying again.
   */
  private async remake(ctx: EngineContext<VideoSettings>, id: string, remake: SceneRemakeOf, picked: { agent?: string; model?: string; effort?: string }): Promise<void> {
    const from = madeVideoId(remake);
    const old = from ? await this.call(() => this.client.get(from, ctx.services.signal)) : undefined;
    const beat = beatOf(old, remake.scene);
    if (!from || !beat || old?.draft === false) throw new JobFailure(DRAFT_GONE, false, "draft_gone");
    await ctx.services.progress({ stage: "writing", progress: 0.04, step: "Asking your agent to make one scene again" });
    const asked = await this.call(() =>
      this.client.remakeScene(
        from,
        {
          id,
          beat,
          ...(remake.note?.trim() ? { note: remake.note.trim() } : {}),
          ...(picked.agent ? { agent: picked.agent } : {}),
          ...(picked.model ? { model: picked.model } : {}),
          ...(picked.effort ? { effort: picked.effort } : {}),
        },
        ctx.services.signal,
      ),
    );
    if ("refused" in asked) {
      if (asked.code === "draft_gone" || asked.code === "no_beat") throw new JobFailure(DRAFT_GONE, false, "draft_gone");
      throw new JobFailure(asked.refused, false);
    }
  }

  /** Reads the video until it is done, showing its steps; stops it when the job is cancelled. */
  private async follow(ctx: EngineContext<VideoSettings>, id: string, from: number, to: number): Promise<ScenesJob & { result: ScenesResult }> {
    try {
      return await this.following(ctx, id, from, to);
    } catch (error) {
      // However the job was lost (a Stop seen on a progress write, a cancel, a takeover), the agent stops too.
      if (ctx.services.signal?.aborted) await this.client.stop(id);
      throw error;
    }
  }

  private async following(ctx: EngineContext<VideoSettings>, id: string, from: number, to: number): Promise<ScenesJob & { result: ScenesResult }> {
    const signal = ctx.services.signal;
    const clock = this.options.clock ?? Date.now;
    const sleep = this.options.sleep ?? wait;
    const deadline = this.options.maxMinutes ? clock() + this.options.maxMinutes * 60_000 : Number.POSITIVE_INFINITY;
    const maxMissed = this.options.maxMissedReads ?? 15;
    let missed = 0;
    let last = "";
    let lastState = "";
    let lastProgress = -1;
    let lastDoneBy: number | null | undefined;
    let renderingSince: number | undefined;
    // The pick the video runs on: the item's own, else the one the job settled for it when it started.
    const settled = parseVideoAgent(ctx.node.settings).agent ? undefined : await workPickFor(ctx).catch(() => undefined);
    const pick = this.pickOf(ctx, undefined, settled);
    const making = pick && this.options.madeIn ? await this.options.madeIn(pick, ctx.node.settings, ctx.ownerId).catch(() => undefined) : undefined;
    for (;;) {
      signal?.throwIfAborted();
      let job: ScenesJob | undefined;
      try {
        job = await this.client.get(id, signal);
        missed = 0;
      } catch (error) {
        if (signal?.aborted) continue;
        missed += 1;
        if (missed >= maxMissed) throw unreachable(error);
      }
      // A service that forgot the video (its folder is gone) makes it again on the next try.
      if (job === undefined && missed === 0) throw new JobWait(`The scenes service has no video ${id}; it may have been restarted.`, "restart", "maker_unreachable");
      if (job) {
        const words = job.step || last;
        const progress = from + (to - from) * job.progress;
        if (job.state === "rendering") renderingSince ??= clock();
        else renderingSince = undefined;
        const startedAt = Date.parse(job.steps[0]?.at ?? "");
        const doneBy = job.state === "done" ? null : expectedDone({ now: clock(), startedAt, state: job.state, progress: job.progress, ...(renderingSince !== undefined ? { renderingSince } : {}), ...(making !== undefined ? { making } : {}) });
        // A new end time is said when it moves by more than half a minute, or becomes known or unknown.
        const doneByMoved = lastDoneBy === undefined || (doneBy === null) !== (lastDoneBy === null) || (doneBy !== null && lastDoneBy !== null && Math.abs(doneBy - lastDoneBy) > 30_000);
        // Written when something a person would see changed, not on every read.
        if (words !== last || job.state !== lastState || progress - lastProgress >= 0.01 || doneByMoved) {
          last = words;
          lastState = job.state;
          lastProgress = progress;
          if (doneByMoved) lastDoneBy = doneBy;
          await ctx.services.progress({ stage: job.state, progress, ...(words ? { step: words } : {}), ...(doneByMoved ? { doneBy: doneBy === null ? null : new Date(doneBy).toISOString() } : {}) });
        }
        if (job.state === "done") {
          if (!job.result) throw new JobFailure(`The scenes service finished video ${id} without its script.`, false, "script_refused");
          return job as ScenesJob & { result: ScenesResult };
        }
        if (job.state === "failed" || job.state === "stopped") {
          await this.recordUsage(ctx, job, false);
          throw failureOf(job);
        }
      }
      if (clock() > deadline) {
        await this.client.stop(id);
        throw new JobFailure(`Video ${id} ran past ${this.options.maxMinutes} minutes, so Open Sourcebook stopped it; its draft is kept on the scenes service.`, false, "timed_out");
      }
      await sleep(this.options.pollMs ?? 2_000, signal).catch(() => undefined);
    }
  }

  private videoId(ctx: EngineContext<VideoSettings>): string {
    const kept = ctx.services.checkpoint?.get(VIDEO_KEY);
    return typeof kept === "string" ? kept : ctx.jobId;
  }

  /** A call to the service; one that does not answer fails the item as "not running", never as a generic error. */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ScenesUnreachableError) throw unreachable(error);
      throw error;
    }
  }

  private toOutput(ctx: EngineContext<VideoSettings>, result: ScenesResult, passages: Passage[]): EngineOutput<Video> {
    const known = byId(passages);
    const scenes: Scene[] = (Array.isArray(result.scenes) ? result.scenes : []).map((scene, at) => ({
      id: `s${at + 1}`,
      kind: clip(str(scene.kind) ?? "scene", VIDEO_LIMITS.kind),
      durationMs: Math.round(Number(scene.durationMs) || 0),
      visual: { kind: "drawn scene", description: str(scene.visual) ?? "" },
      narration: str(scene.narration) ?? "",
      onScreenText: (Array.isArray(scene.onScreenText) ? scene.onScreenText : []).map(str).filter((line): line is string => line !== undefined),
      cites: (Array.isArray(scene.cites) ? scene.cites : []).map((cite) => toCite(cite, known)),
    }));
    const payload: Video = {
      schemaVersion: VIDEO_SCHEMA_VERSION,
      title: clip(str(result.title) ?? ctx.node.title, VIDEO_LIMITS.title),
      idea: clip(str(result.idea) ?? "", VIDEO_LIMITS.idea),
      aspect: { ...ASPECTS.portrait },
      scenes,
    };
    const citations: Citation[] = scenes.flatMap((scene, at) =>
      scene.cites.map((cite) => ({
        sourceId: cite.sourceId,
        ...(cite.chunkId ? { chunkId: cite.chunkId } : {}),
        ...(cite.locator ? { locator: cite.locator } : {}),
        ...(cite.quote ? { quote: cite.quote } : {}),
        anchor: `scenes[${at}]`,
      })),
    );
    const cited = new Set(citations.map((citation) => citation.sourceId));
    for (const source of ctx.sources) if (!cited.has(source.sourceId)) citations.push({ sourceId: source.sourceId });
    const timing = this.timingOf(ctx, result);
    return { title: payload.title, summary: summarize(payload), payload, citations, ...(timing ? { timing } : {}) };
  }

  /** The pick this item runs on, as the picker names it: the item's own, else the agent the service runs by itself. */
  private pickOf(ctx: EngineContext<VideoSettings>, by?: ScenesResult["by"], settled?: { agent?: string; model?: string; effort?: string }): { agent: string; model?: string; effort?: string } | undefined {
    const own = parseVideoAgent(ctx.node.settings);
    const picked = own.agent ? own : (settled ?? own);
    const heard = cachedScenesStatus(this.client.config.url)?.agent;
    const agent = picked.agent ?? by?.agent ?? heard?.id;
    if (!agent) return undefined;
    const same = (other: string | undefined) => other === agent;
    const model = picked.model ?? (same(by?.agent) ? by?.model : undefined) ?? (same(heard?.id) ? heard?.model : undefined);
    const effort = picked.effort ?? (same(by?.agent) ? by?.effort : undefined) ?? (same(heard?.id) ? heard?.effort : undefined);
    return { agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  /** How long the making took, from the service's own sums, under the pick it ran on (and its review's). */
  private timingOf(ctx: EngineContext<VideoSettings>, result: ScenesResult): MakeTiming | undefined {
    const seconds = result.timing?.makingSeconds;
    const pick = this.pickOf(ctx, result.by);
    if (!pick || typeof seconds !== "number" || !(seconds > 0)) return undefined;
    const review = result.timing?.review;
    return { seconds, ...pick, ...(review && review.agent && review.seconds > 0 ? { review: { seconds: review.seconds, agent: review.agent, ...(review.model ? { model: review.model } : {}), ...(review.effort ? { effort: review.effort } : {}) } } : {}) };
  }

  /** One usage row for the agent's work, at cost 0: the person's own subscription paid for it. */
  private async recordUsage(ctx: EngineContext<VideoSettings>, job: ScenesJob, ok: boolean): Promise<void> {
    const agent = job.result?.by.agent ?? cachedScenesStatus(this.client.config.url)?.agent?.id ?? "agent";
    await ctx.services.usage.record({
      provider: `agent:${agent}`,
      model: job.result?.by.model ?? cachedScenesStatus(this.client.config.url)?.agent?.model ?? agent,
      task: "section",
      usd: 0,
      latencyMs: elapsedMs(job),
      ok,
      jobId: ctx.jobId,
    });
  }
}

/**
 * Who watches the finished video fresh, as the scenes request says it: nothing for "auto" (the service's own
 * setting: on, with the video's own pick), `review: false` for "off", and for a pick its agent, model and effort. A
 * model or effort goes only with the agent it was picked for (#91): a pick without an agent is the video's own agent.
 */
export function reviewOf(settings: VideoSettings, videoAgent: string | undefined): { review?: boolean; reviewAgent?: string; reviewModel?: string; reviewEffort?: string } {
  const pick = reviewerPickOf(settings as VideoSettings & ReviewerSettings);
  if (pick === "off") return { review: false };
  if (pick === "auto") return {};
  const agent = pick.agent ?? videoAgent;
  if (!agent) return { review: true };
  return { review: true, reviewAgent: agent, ...(pick.model ? { reviewModel: pick.model } : {}), ...(pick.effort ? { reviewEffort: pick.effort } : {}) };
}

/** The service's reason a video ended, as the job's failure code; the service's own message stays technical. */
const FAILURE_CODES: Record<ScenesFailureCode, JobFailureCode | undefined> = {
  agentUnreachable: "agent_unreachable",
  agentMissing: "agent_missing",
  agentSignedOut: "agent_signed_out",
  agentLimit: "agent_limit",
  agentError: "agent_error",
  timedOut: "timed_out",
  stopped: "stopped",
  scriptRefused: "script_refused",
  voiceDown: "voice_down",
  error: undefined,
};

/** The way on a video waiting for its voice offers the person: finished now, made as a video with no voice key is. */
export const WITHOUT_SOUND: WaitChoice = { id: "without_sound", label: "Finish without sound", words: "finish it now without sound, with the captions carrying the words" };

/**
 * How a video that ended without being done goes on: stopped by the agent's
 * plan limit it waits for the plan, cut off from the agent it waits and is
 * carried on from its draft, with no voice that can speak it waits for the
 * voice (or for the person to finish it without sound); anything else fails.
 */
function failureOf(job: ScenesJob): JobFailure | JobWait {
  const code: ScenesFailureCode = job.failure?.code ?? (job.state === "stopped" ? "stopped" : "error");
  const message = [job.failure?.message, job.failure?.detail].filter(Boolean).join(" ") || `The scenes service ended video ${job.id} as ${job.state}.`;
  if (code === "agentLimit") return new JobWait(message, "agent_limit", "agent_limit", job.failure?.limit ?? {});
  if (code === "voiceDown") return new JobWait(message, "voice", "voice_down", {}, { ...(job.failure?.voice ? { trouble: job.failure.voice } : {}), choice: WITHOUT_SOUND });
  if (code === "agentUnreachable") return new JobWait(message, "restart", "agent_unreachable");
  if (code === "agentError") return agentErrorFailure(message, job.failure?.said);
  return new JobFailure(message, false, FAILURE_CODES[code], job.failure?.said);
}

/** The service stopped answering: the video waits and is followed again (or carried on) once it is back. */
function unreachable(error: unknown): JobWait {
  return new JobWait(error instanceof Error ? error.message : String(error), "restart", "maker_unreachable");
}

/** An Open Sourcebook check as the agent reads it: the scene by its id, then what is wrong. */
function problemLine(issue: { path: string; message: string; code: string }): string {
  const where = /^scenes\[(\d+)\](.*)$/.exec(issue.path);
  const at = where ? `Scene s${Number(where[1]) + 1}${where[2] ? ` (${where[2].replace(/^\./, "")})` : ""}` : issue.path === "$" ? "The video" : issue.path.replace(/^\$\./, "");
  return `${at}: ${issue.message}`;
}

/** The next video id for a job whose last video ended: `<job>-2`, `<job>-3`, ... */
function nextId(jobId: string, last: string): string {
  const match = new RegExp(`^${jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`).exec(last);
  return `${jobId}-${match ? Number(match[1]) + 1 : 2}`;
}

function elapsedMs(job: ScenesJob): number {
  const times = job.steps.map((step) => Date.parse(step.at)).filter(Number.isFinite);
  return times.length >= 2 ? Math.max(0, Math.max(...times) - Math.min(...times)) : 0;
}

function toWirePassage(passage: Passage): ScenesPassage {
  const where = locatorWords(passage.locator);
  return { id: passage.id, label: passage.label, sourceId: passage.sourceId, sourceTitle: passage.sourceTitle ?? "Source", ...(where ? { locator: where } : {}), text: passage.text };
}

/** The kinds of a source's kept media that are pictures, for the video's job folder. */
const PICTURE_KINDS: ReadonlySet<string> = new Set(["image", "figure", "frame", "slide", "thumbnail"]);

/** A source as the scenes service's job folder takes it: where it came from and the pictures already kept from it. */
function toWireSource(source: NodeSource): ScenesSource {
  const envelope = source.envelope;
  const url = envelope.originalURL ?? envelope.canonicalURL;
  const pictures = (envelope.assets ?? [])
    .filter((asset) => PICTURE_KINDS.has(asset.kind))
    .map((asset) => ({
      url: asset.url,
      kind: asset.kind,
      ...(asset.caption ? { caption: asset.caption } : {}),
      ...(asset.page !== undefined ? { page: asset.page } : {}),
      ...(asset.timestampMs !== undefined ? { timestampMs: asset.timestampMs } : {}),
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    }));
  return {
    id: source.sourceId,
    title: source.title ?? envelope.title ?? "Source",
    kind: envelope.kind,
    ...(url && /^https?:\/\//.test(url) ? { url } : {}),
    ...(source.path ? { path: source.path } : {}),
    ...(pictures.length > 0 ? { pictures } : {}),
  };
}

/** Where a passage sits, in a few words for the agent. */
function locatorWords(locator: SourceLocator | undefined): string | undefined {
  if (!locator) return undefined;
  if (locator.page !== undefined) return locator.endPage && locator.endPage !== locator.page ? `pages ${locator.page}-${locator.endPage}` : `page ${locator.page}`;
  if (locator.slide !== undefined) return locator.endSlide && locator.endSlide !== locator.slide ? `slides ${locator.slide}-${locator.endSlide}` : `slide ${locator.slide}`;
  if (locator.startMs !== undefined) return `at ${clockTime(locator.startMs)}`;
  if (locator.cell) return `cell ${locator.cell}`;
  return undefined;
}

function clockTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function toCite(cite: { passageId?: unknown; sourceId?: unknown; quote?: unknown }, passages: Map<string, Passage>): SceneCite {
  const passage = typeof cite.passageId === "string" ? passages.get(cite.passageId) : undefined;
  const quote = str(cite.quote) ?? "";
  if (!passage) {
    // Kept as written, so Open Sourcebook's check says which cite names no passage of this item.
    return { sourceId: str(cite.sourceId) ?? "", spot: "passage", ...(typeof cite.passageId === "string" ? { chunkId: cite.passageId } : {}), quote };
  }
  return {
    sourceId: passage.sourceId,
    spot: passage.locator?.cell ? "cell" : "passage",
    ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
    ...(passage.locator ? { locator: passage.locator } : {}),
    quote,
  };
}

/** The sources whose text was read; one that gave only its title and details has nothing to draw on. */
function readSources(sources: NodeSource[]): NodeSource[] {
  return sources.filter((source) => source.envelope.accessLevel !== "metadata" && source.envelope.accessLevel !== "none");
}

function requirePassages(ctx: EngineContext<VideoSettings>): Passage[] {
  const passages = buildPassages(readSources(ctx.sources));
  if (passages.length === 0) throw new PipelineError("A video needs source text to draw on; this item has none that could be read.", "NO_SOURCE_TEXT");
  return passages;
}

function byId(passages: Passage[]): Map<string, Passage> {
  return new Map(passages.map((passage) => [passage.id, passage]));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return text.slice(0, cut > 0 ? cut : max).trim();
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
