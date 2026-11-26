/**
 * Video jobs: one folder each under the data folder (job.json, draft.json, the scene builds, stills, voice and the
 * mp4). A job is one turn of the person's agent through the connector, with the skills and Open Sourcebook's tools, for as long as
 * it takes: the agent writes, builds, renders the real video and watches it as it sees fit. When it ends, its last
 * render is the video if nothing changed since; otherwise the job voices, builds every scene on the real word times,
 * and renders. It can be stopped, revised with problems Open Sourcebook's own checker found, and resumed after it failed or was
 * stopped (POST /videos/:id/resume), from its draft. A finished one can have one scene made again as a new job copied
 * from it (POST /videos/:id/remake-scene), the old one left as it is. While the turn runs, the connector is asked every few seconds
 * whether it still does, so a turn the connector dropped is not waited on for ever. A job that was being made when the
 * service stopped, or whose turn was dropped, is carried on from what is on disk: a new turn told what exists, or the
 * voicing and render again (speech already made is never bought again), at most `MAX_RESUMES` times a job, each after
 * a longer wait. Each job's folder also holds a note for the agent, its sources and what was read from them
 * (src/folder.ts, docs/JOB-FOLDER.md). Finished jobs stay a while, then are cleaned up: a job is kept while among the last
 * few or recent, never while being made. When the fresh viewer is on, a finished video is watched once by a blind viewer
 * turn and its maker gets one more turn with the viewer's notes (src/review.ts), never more than once a video.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readLimit, type AgentProblem, type Connector, type LimitReset } from "./connector.ts";
import { BESIDE_WORK, copyToLibrary, KEEP, toRemove, writeJobFolder, type Keep } from "./folder.ts";
import { finalBuild, renderVideo, voiceAll } from "./produce.ts";
import { forVideo, INSTRUCTIONS, systemPrompt, turnPrompt } from "./prompt.ts";
import { writeSkills } from "./skills.ts";
import { tokens } from "./knowledge.ts";
import { makingText, type Making } from "./making.ts";
import { currentCut, makeCut, type Cut } from "./cut.ts";
import { changedBeats, keepCut, polishText, restoreCut, reviewLines, VIEWER_INSTRUCTIONS, VIEWER_MINUTES, VIEWER_SYSTEM, viewerCall, viewerListing, viewerPrompt, reviewFromText, type Review, type ViewerSession } from "./review.ts";
import { clock, reportText } from "./report.ts";
import { speedBook } from "./speed.ts";
import type { VideoRequest } from "./request.ts";
import type { Style } from "./styles.ts";
import type { Toolbox } from "./toolbox/index.ts";
import { callTool, emptyDraft, listing, makingOf, renders, styleOf, unfinished, viewerReportOf, type Draft, type ToolAnswer, type ToolContext } from "./tools.ts";
import { silentVoice, voiceDownOf, voiceNow, type Voice, type VoiceSource, type VoiceTrouble } from "./voice.ts";

export type State = "writing" | "voicing" | "rendering" | "done" | "failed" | "stopped";
/**
 * `agentError`: the agent's turn ended in an error of its own before it called any of Open Sourcebook's tools. `voiceDown`: the voice
 * cannot speak for a reason trying again will not fix (no credits, a refused key, no answer); the draft is kept, and
 * the video is carried on from it once the voice is back, or finished without sound when the person asks.
 */
export type FailureCode = AgentProblem | "agentError" | "scriptRefused" | "voiceDown";

export interface Failure {
  code: FailureCode;
  message: string;
  detail?: string;
  /** With `agentError`: the agent's own words on why, as it reported them, for the person. */
  said?: string;
  /** With `agentLimit`: when the agent said its limit resets, as it said it. */
  limit?: LimitReset;
  /** With `voiceDown`: why the voice cannot speak. */
  voice?: VoiceTrouble;
}

export interface Result {
  title: string;
  idea: string;
  scenes: { id: string; durationMs: number; narration: string; onScreenText: string[]; visual: string; cites: { passageId: string; sourceId: string; quote: string }[] }[];
  file: { bytes: number; durationMs: number; width: number; height: number; contentType: "video/mp4" };
  voice: { id: string; label: string; real: boolean; note?: string };
  by: { maker: "scenes"; agent: string; model?: string; effort?: string; style: string };
  /** How the video was made, step by step, from Open Sourcebook's own record of the agent's calls (src/making.ts). */
  making?: Making;
  /**
   * How long the making took: the agent's turns, the voice, building and drawing (never a wait for a limit, the voice
   * or the person), and the fresh viewer's own turn apart, with the pick it ran on.
   */
  timing: { makingSeconds: number; review?: { seconds: number; agent: string; model?: string; effort?: string } };
}

export interface JobRecord {
  id: string;
  request: VideoRequest;
  state: State;
  progress: number;
  step: string;
  steps: { label: string; at: string }[];
  style?: string;
  failure?: Failure;
  result?: Result;
  /** How the making went, for the log and the report: minutes writing, voice and render times, tool calls. */
  timings: { writingMs: number; voiceMs: number; buildMs: number; renderMs: number; toolCalls: number; turns: number };
  agent?: { id: string; model?: string; effort?: string };
  /** How the video was made so far, step by step, from Open Sourcebook's own record of the agent's calls; written at each turn's end. */
  making?: Making;
  /** How many times this job was carried on by itself, after a restart of this service or a dropped turn. */
  resumes?: number;
  /** The person chose to finish it without sound after the voice could not speak, and why it could not. */
  withoutSound?: { because: string };
  /** The fresh viewer's own turn: how long it took and on what, kept apart from the making's time. */
  reviewed?: { seconds: number; agent: string; model?: string; effort?: string };
  /**
   * A remake of one scene of a finished video: the video it was copied from, the beat the person asked to be made
   * again, and their note in their own words. The video it came from is left as it was.
   */
  remake?: Remake;
  /** Where the finished video was copied in the library, once it was (src/folder.ts). */
  library?: string;
  createdAt: string;
  updatedAt: string;
}

/** What a remake of one scene keeps: the video it was copied from, the beat asked for again, and the person's note. */
export interface Remake {
  of: string;
  beat: string;
  note?: string;
}

/** What `remakeScene` is asked: the new video's id, the beat, the person's note, and another pick when one is named. */
export interface RemakeAsk {
  id: string;
  beat: string;
  note?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

/** How often, and for how long, a running turn is checked on (`Connector.running`). */
export interface Heartbeat {
  /** Between two checks. */
  everyMs: number;
  /** The connector not answering this long means the turn is gone. */
  silentMs: number;
  /** The connector saying the turn no longer runs, this long with no end arriving, means it is gone. */
  endedMs: number;
  /** A gap between two checks longer than this is the computer sleeping: it is not counted. */
  sleptMs: number;
  /**
   * The agent calling none of Open Sourcebook's tools for this long, with none running, means it hung: its turn is stopped and its
   * work kept. Time asleep is not counted. 0 never stops it.
   */
  idleMs: number;
}

export interface JobsOptions {
  /** The service's own data folder. */
  dataDir: string;
  /**
   * Where the job folders are, one per video and nothing else of the service's (SCENES_JOBS_DIR): `dataDir` itself when
   * left out, as a clone keeps them (docs/JOB-FOLDER.md).
   */
  jobsDir?: string;
  connector: Connector;
  /** The voice, or what gives the voice of the moment; a video keeps the voice it started a run with. */
  voice: VoiceSource;
  styles: () => Style[];
  /** This service's own address, for the turn's callback. */
  callbackBase: () => string;
  /** The longest the agent's turn may run, in minutes; none (the default) lets it work until it finishes or is stopped. */
  turnMinutes?: number;
  /**
   * How long the agent may call none of Open Sourcebook's tools before its turn counts as hung and is stopped, its work kept, in
   * minutes (SCENES_IDLE_MINUTES; `IDLE_MINUTES` by default, 0 for never). A slow agent that keeps calling is never stopped.
   */
  idleMinutes?: number;
  /** What the agent can reach beyond the scene language (src/toolbox); none gives it only the video tools. */
  toolbox?: Toolbox;
  /** False keeps the agent's own tools off even where the connector could box them (SCENES_AGENT_WORKSPACE=off). */
  workspace?: boolean;
  /** False gives the agent only the index of skills, not their pages whole (SCENES_AGENT_KNOWLEDGE=index), to compare. */
  knowledge?: boolean;
  /** Override whether work turns keep the agent's built-in prompt; unset lets the adapter's `replacesWorkPrompt` decide. */
  keepAgentPrompt?: boolean;
  /**
   * The fresh viewer (src/review.ts): `on` has a blind viewer watch each finished video once, and its maker go over the
   * notes in one more turn; a request's own `review` wins. Its model and effort are the video's unless named. Off when
   * left out (main.ts turns it on from SCENES_REVIEW).
   */
  review?: { on: boolean; model?: string; effort?: string };
  log?: (line: string) => void;
  /** The waits before each carry-on of a job, the first, second and third; the last repeats. */
  resumeDelaysMs?: number[];
  /** How a carry-on waits for a connector that does not answer: a check every `everyMs`, for at most `forMs`. */
  connectorWait?: { everyMs: number; forMs: number };
  heartbeat?: Partial<Heartbeat>;
  /** The clock the heartbeat reads (tests move it to play a sleep). */
  now?: () => number;
  /** The engine's address, where the pictures of a video's sources are fetched from for its job folder; none fetches none. */
  engineUrl?: string;
  /** How the job folder's pictures are fetched (tests answer them). */
  fetch?: typeof fetch;
  /** The library folder a finished video is copied into; none copies nothing. */
  libraryDir?: string;
  /** How many jobs, and how many days of them, are kept after they end (src/folder.ts, `KEEP` by default). */
  keep?: Keep;
}

/** The most a job is carried on by itself; the person's or the engine's resume does not count. */
export const MAX_RESUMES = 3;
const RESUME_DELAYS_MS = [2_000, 15_000, 60_000];
const CONNECTOR_WAIT = { everyMs: 5_000, forMs: 180_000 };
/** No call to any of Open Sourcebook's tools for this long is a hung agent, not a slow one: slow ones call every few minutes. */
export const IDLE_MINUTES = 30;
const HEARTBEAT: Heartbeat = { everyMs: 5_000, silentMs: 30_000, endedMs: 15_000, sleptMs: 60_000, idleMs: IDLE_MINUTES * 60_000 };
const CARRYING_ON = "Carrying on after a restart";
const CUT_OFF = `This video was cut off ${MAX_RESUMES} times while it was being made. What was made is kept: try again to carry on from there.`;

/**
 * How a turn ended: its report, or gone without one (the connector silent, or saying it no longer runs), or `idle`:
 * the agent called none of Open Sourcebook's tools for `Heartbeat.idleMs`.
 */
type TurnOutcome = { report: TurnReport } | { gone: "silent" | "ended" } | { idle: number };

/** What one turn of writing came to. */
type Written = "written" | "failed" | { gone: "silent" | "ended" };

interface Turn {
  id: string;
  jobId: string;
  token: string;
  ended: (report: TurnReport) => void;
  /** A fresh viewer's turn: its tools answer from this, not from the maker's draft. */
  view?: ViewerSession;
}

export interface TurnReport {
  outcome: "done" | "failed";
  problem?: AgentProblem;
  text?: string;
  model?: string;
  effort?: string;
  tokensIn?: number;
  firstTokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  /** With `agentLimit`: when the agent said its limit resets. */
  limit?: LimitReset;
  /** With a failed turn: the agent's own words on why, from its own error (the connector's `said`). */
  said?: string;
}

/** Why a carry-on turn's last turn was cut off, in a few words for the agent, by what failed or stopped it. */
const CUT_BECAUSE: Partial<Record<FailureCode, string>> = {
  agentLimit: "your agent's plan reached its limit",
  agentUnreachable: "the agent connector could not be reached",
  agentSignedOut: "your agent was signed out",
  agentMissing: "your agent could not run",
  agentError: "your agent stopped with an error of its own",
  timedOut: "your last turn was stopped: it reached its time limit, or called none of Open Sourcebook's tools for a long time",
  stopped: "the person stopped it",
  voiceDown: "the voice could not speak, and it can now",
};

const WORDS: Record<FailureCode, string> = {
  agentUnreachable: "Your agent could not be reached: the agent connector is not running on this computer.",
  agentMissing: "Your agent is not installed on this computer, or cannot run here.",
  agentError: "Your agent stopped with an error of its own before it did any work on the video.",
  agentSignedOut: "Your agent is signed out. Sign in to it on this computer and try again.",
  agentLimit: "Your agent has reached its usage limit for now. Try again later.",
  timedOut: "Your agent's turn reached the time limit set for it (SCENES_TURN_MINUTES), so Open Sourcebook stopped it. What it made is kept: try again to carry on from there.",
  stopped: "Stopped.",
  scriptRefused: "Your agent ended without a script Open Sourcebook could take.",
  voiceDown: "The voice could not speak. What was made is kept: the video carries on once the voice can speak again, or it can be finished without sound.",
  error:"Something went wrong while making this video. Try again.",
};

export class Jobs {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly drafts = new Map<string, Draft>();
  private readonly turns = new Map<string, Turn>();
  private readonly running = new Map<string, { turnId?: string; abort: AbortController }>();
  /** The voice each running video started with. */
  private readonly pinned = new Map<string, Voice>();
  /** Per job: when the agent last called one of Open Sourcebook's tools, and how many of its calls are running now. */
  private readonly activity = new Map<string, { at: number; open: number }>();
  private readonly o: JobsOptions;
  private readonly log: (line: string) => void;

  private readonly beat: Heartbeat;
  private readonly now: () => number;

  constructor(o: JobsOptions) {
    this.o = o;
    this.log = o.log ?? ((line) => console.log(line));
    this.beat = { ...HEARTBEAT, ...(o.idleMinutes !== undefined ? { idleMs: o.idleMinutes * 60_000 } : {}), ...o.heartbeat };
    this.now = o.now ?? Date.now;
    mkdirSync(this.jobsDir, { recursive: true });
    this.load();
    this.cleanUp();
  }

  /**
   * Removes the folders of jobs that ended and are neither among the last `keep.jobs` changed nor changed in the last
   * `keep.days` days. A job being made is never removed, and nothing in the data folder but a job's folder is touched.
   */
  cleanUp(): string[] {
    const busy = (job: JobRecord) => this.running.has(job.id) || job.state === "writing" || job.state === "voicing" || job.state === "rendering";
    const gone = toRemove([...this.jobs.values()], busy, this.o.keep ?? KEEP, Date.now());
    for (const job of gone) {
      try {
        rmSync(this.folder(job.id), { recursive: true, force: true });
        this.jobs.delete(job.id);
        this.drafts.delete(job.id);
      } catch (e) {
        this.log(`job ${job.id}: its folder could not be removed (${(e as Error).message})`);
      }
    }
    if (gone.length) this.log(`removed ${gone.length} old job folder${gone.length === 1 ? "" : "s"}: ${gone.map((j) => j.id).join(", ")}`);
    return gone.map((j) => j.id);
  }

  /** Writes the job folder's note, sources and what was read from them; a part that cannot be made is only logged. */
  private async prepare(job: JobRecord): Promise<void> {
    try {
      await writeJobFolder(this.folder(job.id), job.request, { ...(this.o.engineUrl ? { engineUrl: this.o.engineUrl } : {}), ...(this.o.fetch ? { fetch: this.o.fetch } : {}), log: (line) => this.log(`job ${job.id}: ${line}`) });
    } catch (e) {
      this.log(`job ${job.id}: its folder's sources could not be written (${(e as Error).message})`);
    }
  }

  /**
   * Reads every job on disk. One that was mid-way when the service stopped is carried on from what is on disk, in the
   * background after a wait, unless it was already carried on `MAX_RESUMES` times: then it fails in plain words.
   */
  private load(): void {
    const carry: JobRecord[] = [];
    for (const id of readdirSync(this.jobsDir)) {
      const file = join(this.jobsDir, id, "job.json");
      if (!existsSync(file)) continue;
      try {
        const job = JSON.parse(readFileSync(file, "utf8")) as JobRecord;
        this.jobs.set(job.id, job);
        if (job.state === "writing" || job.state === "voicing" || job.state === "rendering") carry.push(job);
      } catch {
        this.log(`job ${id}: job.json could not be read; left as it is`);
      }
    }
    for (const job of carry) {
      const wait = this.carryOn(job, `was ${job.state} when the service stopped`);
      if (wait === undefined) continue;
      let draft: Draft;
      try {
        draft = this.draft(job);
      } catch {
        this.fail(job, { code: "error", message: WORDS.error, detail: "draft.json could not be read after a restart" });
        continue;
      }
      // Writing goes on in a new turn unless the agent had finished; a voicing or render is made again.
      const produce = !unfinished(draft).length && (job.state !== "writing" || !!draft.finished);
      void this.make(job, { delayMs: wait, ...(produce ? { produce: true } : { carry: "the service restarted" }) });
    }
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /** Where the job folders are (`JobsOptions.jobsDir`). */
  get jobsDir(): string {
    return this.o.jobsDir ?? this.o.dataDir;
  }

  folder(id: string): string {
    return join(this.jobsDir, id);
  }

  /** Starts a job, or returns the one with this id (the engine's job id makes a start idempotent). */
  create(request: VideoRequest): JobRecord {
    const known = this.jobs.get(request.id);
    if (known) return known;
    const now = new Date().toISOString();
    const job: JobRecord = { id: request.id, request, state: "writing", progress: 0, step: "Starting your agent", steps: [{ label: "Starting your agent", at: now }], ...(request.style !== "auto" ? { style: request.style } : {}), timings: { writingMs: 0, voiceMs: 0, buildMs: 0, renderMs: 0, toolCalls: 0, turns: 0 }, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    mkdirSync(this.folder(job.id), { recursive: true });
    this.drafts.set(job.id, emptyDraft());
    this.save(job);
    void this.make(job, { prepare: true });
    return job;
  }

  async stop(id: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.state === "done" || job.state === "failed" || job.state === "stopped") return job;
    const run = this.running.get(id);
    job.state = "stopped";
    job.failure = { code: "stopped", message: WORDS.stopped };
    this.stepTo(job, "Stopped");
    this.save(job);
    run?.abort.abort();
    if (run?.turnId) await this.o.connector.stop(run.turnId);
    return job;
  }

  /** A new writing round with problems Open Sourcebook's checker found. Only after a video is done, or after a refused script. */
  revise(id: string, problems: string[]): { job?: JobRecord; refused?: string } {
    const job = this.jobs.get(id);
    if (!job) return {};
    if (!(job.state === "done" || (job.state === "failed" && job.failure?.code === "scriptRefused"))) return { job, refused: `A video can be revised once it is done, or after its script was refused; this one is ${job.state}.` };
    job.state = "writing";
    job.progress = 0;
    delete job.failure;
    delete job.result;
    this.stepTo(job, "Fixing a few things in the video");
    this.save(job);
    void this.make(job, { revise: problems.map(String).filter(Boolean).slice(0, 40) });
    return { job };
  }

  /**
   * A new video that makes one beat of a finished one again, as the person asked, with their note: the finished job's
   * folder and draft are copied into a new job, so the old video stays as it is and plays until the new one is done.
   * The copy keeps every beat, its picture and its voice (speech for a beat whose words do not change is never made
   * again); the cut, the finish and the fresh viewer's round are left behind, since they were of the old video. Its
   * writing is a new turn told which beat to make again, in the person's words. The same new id again is the same
   * remake. Refused while the video is not done, and when its draft is gone from the data folder.
   */
  remakeScene(id: string, ask: RemakeAsk): { job?: JobRecord; refused?: { code: "not_done" | "draft_gone" | "no_beat" | "taken"; message: string } } {
    const known = this.jobs.get(ask.id);
    if (known) return known.remake?.of === id && known.remake.beat === ask.beat ? { job: known } : { refused: { code: "taken", message: `There is already a video with the id ${ask.id}.` } };
    const old = this.jobs.get(id);
    if (!old) return {};
    if (old.state !== "done") return { job: old, refused: { code: "not_done", message: `Only a finished video can have a scene made again; this one is ${old.state}.` } };
    const from = this.folder(id);
    let draft: Draft;
    try {
      draft = JSON.parse(readFileSync(join(from, "draft.json"), "utf8")) as Draft;
    } catch {
      return { job: old, refused: { code: "draft_gone", message: "This video's draft is no longer on this computer, so one scene of it cannot be made again. Make the whole video again instead." } };
    }
    if (!draft.script?.scenes.some((s) => s.id === ask.beat)) return { job: old, refused: { code: "no_beat", message: `This video has no beat ${ask.beat}.` } };
    const to = this.folder(ask.id);
    // Everything the agent made (builds, stills, voice, pictures, its folder), but not the old video's own record or file.
    const left = new Set(["job.json", "job.json.tmp", "draft.json", "draft.json.tmp", "video.mp4", "README.md", "sources", "extracted"]);
    cpSync(from, to, { recursive: true, filter: (path) => {
      const inside = relative(from, path);
      const top = inside.split(sep)[0]!;
      return !left.has(top) && top !== "review";
    } });
    // Paths into the old folder (the voice's files) point into the copy.
    const quoted = (path: string) => JSON.stringify(`${path}${sep}`).slice(1, -1);
    const copy = JSON.parse(JSON.stringify(draft).split(quoted(from)).join(quoted(to))) as Draft;
    for (const key of ["finished", "finishAnswered", "cut", "seenCut", "watchedCut", "report", "renderReport", "review", "voiceDown", "made"] as const) delete copy[key];
    copy.toolCalls = 0;
    copy.watched = 0;
    // Another agent named: its model and effort go with it, and no model crosses from the old one.
    const pick = ask.agent ? { agent: ask.agent, ...(ask.model ? { model: ask.model } : {}), ...(ask.effort ? { effort: ask.effort } : {}) } : { ...(old.request.agent ? { agent: old.request.agent } : {}), ...(ask.model ?? old.request.model ? { model: ask.model ?? old.request.model } : {}), ...(ask.effort ?? old.request.effort ? { effort: ask.effort ?? old.request.effort } : {}) };
    const { agent: _agent, model: _model, effort: _effort, ...rest } = old.request;
    const request: VideoRequest = { ...rest, ...pick, id: ask.id, ...(old.request.style === "auto" && (draft.style ?? draft.script.style) ? { style: draft.style ?? draft.script.style! } : {}) };
    const now = new Date().toISOString();
    const note = ask.note?.trim().slice(0, 2_000);
    const job: JobRecord = {
      id: ask.id,
      request,
      state: "writing",
      progress: 0,
      step: "Making one scene again",
      steps: [{ label: "Making one scene again", at: now }],
      ...(old.style ? { style: old.style } : {}),
      timings: { writingMs: 0, voiceMs: 0, buildMs: 0, renderMs: 0, toolCalls: 0, turns: 0 },
      remake: { of: id, beat: ask.beat, ...(note ? { note } : {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.drafts.set(job.id, copy);
    this.saveDraft(job.id, copy);
    this.save(job);
    this.log(`job ${job.id}: a remake of ${ask.beat} in ${id}${note ? `, the person's note: ${note.slice(0, 200)}` : ", with no note"}`);
    void this.make(job, { prepare: true });
    return { job };
  }

  /**
   * Carries a failed or stopped job on from its draft: a new turn told what exists when the writing was not finished,
   * else the voicing and render again. Asked for by the engine (after a usage limit, or its own restart), so it does
   * not count among the job's own carry-ons, which start afresh. `withoutSound`, after the voice could not speak: the
   * video is finished with no voice, its captions carrying the words, as a video with no voice key is made.
   */
  resume(id: string, o: { withoutSound?: boolean } = {}): { job?: JobRecord; refused?: string } {
    const job = this.jobs.get(id);
    if (!job) return {};
    if (job.state !== "failed" && job.state !== "stopped") return { job, refused: `Only a video that failed or was stopped can be carried on; this one is ${job.state}.` };
    let draft: Draft;
    try {
      draft = this.draft(job);
    } catch {
      return { job, refused: "This video's draft could not be read, so there is nothing to carry on from." };
    }
    const why = job.failure ? CUT_BECAUSE[job.failure.code] : undefined;
    if (o.withoutSound && !job.withoutSound) {
      job.withoutSound = { because: draft.voiceDown?.message ?? "" };
    }
    // The voice is asked again on every carry-on: it may be back. Without sound, nothing asks it.
    if (draft.voiceDown) {
      delete draft.voiceDown;
      this.saveDraft(job.id, draft);
    }
    const produce = !!draft.finished && !unfinished(draft).length;
    job.state = produce ? "voicing" : "writing";
    delete job.failure;
    delete job.result;
    job.resumes = 0;
    this.stepTo(job, "Carrying on");
    this.save(job);
    this.log(`job ${id}: resumed${job.withoutSound ? " without sound" : ""}${produce ? ", to voice and render" : `, a new turn${why ? ` (${why})` : ""}`}`);
    void this.make(job, produce ? { produce: true } : { carry: why ?? "" });
    return { job };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The agent's turn: its tool calls and its end come back here, with the turn's own token.

  async toolCall(turnId: string, authorization: string | undefined, body: unknown): Promise<ToolAnswer | undefined> {
    const turn = this.authorized(turnId, authorization);
    if (!turn) return undefined;
    const job = this.jobs.get(turn.jobId);
    if (!job || job.state !== "writing") return { text: "This video is no longer being written; stop now.", isError: true };
    const b = (typeof body === "object" && body !== null ? body : {}) as { name?: unknown; arguments?: unknown };
    if (turn.view) {
      const t0 = Date.now();
      const answer = await viewerCall(String(b.name ?? ""), b.arguments ?? {}, turn.view);
      this.log(`job ${job.id}: viewer ${String(b.name)} ${answer.isError ? "refused" : "ok"} in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${answer.text.split("\n")[0]!.slice(0, 160)}`);
      return answer;
    }
    const ctx = this.context(job, this.running.get(job.id)?.abort.signal);
    const t0 = Date.now();
    const seen = this.activity.get(job.id) ?? { at: this.now(), open: 0 };
    this.activity.set(job.id, seen);
    seen.at = this.now();
    seen.open += 1;
    let answer: ToolAnswer;
    try {
      answer = await callTool(String(b.name ?? ""), b.arguments ?? {}, ctx);
    } finally {
      seen.open -= 1;
      seen.at = this.now();
    }
    job.timings.toolCalls += 1;
    const args = (b.arguments ?? {}) as Record<string, unknown>;
    const which = typeof args.scene === "string" ? args.scene : typeof args.beat === "string" ? args.beat : "";
    // A refusal is logged with its reasons, so a run can be read back; finish's answer whole, since it is Open Sourcebook's record
    // of what was skipped; any other answer that was taken, by its first line.
    const said = answer.isError
      ? answer.text.split("\n").slice(0, 4).join(" | ").slice(0, 400)
      : String(b.name) === "finish"
        ? answer.text.split("\n").join(" | ")
        : answer.text.split("\n")[0]!.slice(0, 120);
    this.log(`job ${job.id}: ${String(b.name)}${which ? ` ${which}` : ""} ${answer.isError ? "refused" : "ok"} in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${said}`);
    this.progressFromDraft(job, ctx.draft);
    this.save(job);
    return answer;
  }

  turnEnded(turnId: string, authorization: string | undefined, body: unknown): boolean {
    const turn = this.authorized(turnId, authorization);
    if (!turn) return false;
    this.turns.delete(turnId);
    turn.ended((typeof body === "object" && body !== null ? body : { outcome: "failed", problem: "error" }) as TurnReport);
    return true;
  }

  private authorized(turnId: string, authorization: string | undefined): Turn | undefined {
    const turn = this.turns.get(turnId);
    const given = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!turn || !given) return undefined;
    const [a, b] = [Buffer.from(given), Buffer.from(turn.token)];
    return a.length === b.length && timingSafeEqual(a, b) ? turn : undefined;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Making one video.

  /**
   * Makes a video: the writing, then the voicing and render. `carry` (why the last turn was cut off, "" when not known)
   * makes the first turn a carry-on told what exists; `produce` skips the writing; `delayMs` waits first.
   */
  private async make(job: JobRecord, o: { revise?: string[]; carry?: string; produce?: boolean; delayMs?: number; prepare?: boolean }): Promise<void> {
    const abort = new AbortController();
    this.running.set(job.id, { abort });
    // The voice of this run: a change of voice while it is made reaches the next video, not this one.
    const voice = voiceNow(this.o.voice);
    this.pinned.set(job.id, voice);
    try {
      if (o.prepare) await this.prepare(job);
      if (o.delayMs) await pause(o.delayMs, abort.signal);
      if (abort.signal.aborted) return;
      if (!o.produce) {
        const written = await this.write(job, abort, o.revise, undefined, o.carry);
        if (!written || abort.signal.aborted) return;
        // A fresh viewer's one round, after the writing (not after a revise from Open Sourcebook's checker).
        if (!o.revise) await this.reviewRound(job, abort);
        if (abort.signal.aborted || job.state === "stopped") return;
      }
      await this.produce(job, abort, false);
    } catch (e) {
      const down = voiceDownOf(e);
      // The voice went out while the video was voiced: it waits for the voice, its draft kept.
      if (down && !abort.signal.aborted) {
        const draft = this.draft(job);
        draft.voiceDown = { trouble: down.trouble, message: down.message, at: new Date().toISOString() };
        this.saveDraft(job.id, draft);
        this.fail(job, voiceDownFailure(down.message, down.trouble));
      } else if (!abort.signal.aborted) this.fail(job, { code: "error", message: WORDS.error, detail: (e as Error).message.slice(0, 500) });
    } finally {
      // A stopped run can end after a resume started the next one: only its own entry goes.
      if (this.running.get(job.id)?.abort === abort) this.running.delete(job.id);
      if (this.pinned.get(job.id) === voice) this.pinned.delete(job.id);
      // A job that ended makes room: old ones are cleaned up.
      if (!this.running.has(job.id)) this.cleanUp();
    }
  }

  /**
   * Counts one carry-on of a job by itself and returns the wait before it, or fails the job when it was carried on
   * `MAX_RESUMES` times already and returns undefined.
   */
  private carryOn(job: JobRecord, detail: string): number | undefined {
    const done = job.resumes ?? 0;
    if (done >= MAX_RESUMES) {
      this.fail(job, { code: "error", message: CUT_OFF, detail });
      return undefined;
    }
    job.resumes = done + 1;
    this.stepTo(job, CARRYING_ON);
    this.save(job);
    const delays = this.o.resumeDelaysMs?.length ? this.o.resumeDelaysMs : RESUME_DELAYS_MS;
    const wait = delays[Math.min(done, delays.length - 1)]!;
    this.log(`job ${job.id}: carrying on (${job.resumes} of ${MAX_RESUMES}) in ${(wait / 1000).toFixed(0)} s; ${detail}`);
    return wait;
  }

  /**
   * The writing: one turn of the agent, and while its turn is dropped and something of the draft exists, a new turn
   * that carries on, after a wait, as often as the job may be carried on. True when it ended with every scene built.
   */
  private async write(job: JobRecord, abort: AbortController, revise?: string[], repair?: Record<string, string[]>, carry?: string): Promise<boolean> {
    let why = carry;
    for (;;) {
      const written = await this.writeTurn(job, abort, revise, repair, why);
      if (written === "written") return true;
      if (written === "failed" || abort.signal.aborted || job.state === "stopped") return false;
      const draft = this.draft(job);
      if (!draft.script && !draft.style) {
        if (written.gone === "silent") return this.fail(job, { code: "agentUnreachable", message: WORDS.agentUnreachable, detail: "the connector stopped answering during the turn" }), false;
        return this.fail(job, { code: "error", message: WORDS.error, detail: "the agent's turn ended without word, before anything was written" }), false;
      }
      why = written.gone === "silent" ? "the agent connector stopped answering" : "your agent's turn ended";
      const wait = this.carryOn(job, `its turn was dropped: ${why}`);
      if (wait === undefined) return false;
      await pause(wait, abort.signal);
      if (abort.signal.aborted) return false;
    }
  }

  /** Waits, on a carry-on, for a connector that does not answer: true once it does, false when it never did in time. */
  private async connectorBack(signal: AbortSignal): Promise<boolean> {
    const wait = this.o.connectorWait ?? CONNECTOR_WAIT;
    const until = Date.now() + wait.forMs;
    while (Date.now() < until) {
      await pause(wait.everyMs, signal);
      if (signal.aborted) return false;
      if ((await this.o.connector.status(true)).reachable) return true;
    }
    return false;
  }

  /** One turn of the agent: written (every scene built), failed (the job failed or was stopped), or gone without an end. */
  private async writeTurn(job: JobRecord, abort: AbortController, revise?: string[], repair?: Record<string, string[]>, carry?: string, polish?: string): Promise<Written> {
    let status = await this.o.connector.status(carry !== undefined, job.request.agent);
    // A carry-on waits a while for a connector that is starting again, and for this service's own address.
    if (carry !== undefined && !status.reachable && (await this.connectorBack(abort.signal))) status = await this.o.connector.status(true, job.request.agent);
    if (abort.signal.aborted) return "failed";
    if (!status.reachable || status.problem) return this.fail(job, { code: status.problem ?? "agentUnreachable", message: WORDS[status.problem ?? "agentUnreachable"] }), "failed";
    for (let i = 0; !this.o.callbackBase() && i < 100 && !abort.signal.aborted; i++) await pause(100, abort.signal);
    const draft = this.draft(job);
    const styles = this.o.styles();
    const turnId = `${job.id}-${++job.timings.turns}`;
    const token = randomBytes(24).toString("hex");
    const ended = new Promise<TurnReport>((resolve) => this.turns.set(turnId, { id: turnId, jobId: job.id, token, ended: resolve }));
    this.running.get(job.id)!.turnId = turnId;
    abort.signal.addEventListener("abort", () => this.turns.get(turnId)?.ended({ outcome: "failed", problem: "stopped" }), { once: true });
    const problems = repair ? Object.entries(repair).map(([id, list]) => `${id} no longer builds on the voice's word times: ${list.slice(0, 6).join(" | ")}`) : revise;
    // A folder of this video's own for the agent, with as many of its own tools as the connector offers (`status.access`).
    const work = status.workspace && this.o.workspace !== false ? join(this.folder(job.id), "work") : undefined;
    const style = job.request.style === "auto" ? (draft.style ?? styles[0]!.id) : job.request.style;
    const video = forVideo(job.request, style);
    if (work) {
      mkdirSync(work, { recursive: true });
      // The skills as files in the agent's own folder, the scene language written for this video's style.
      writeSkills(join(work, "skills"), video);
    }
    // The pages that bear on every video, whole, with the instructions; the index alone with SCENES_AGENT_KNOWLEDGE=index.
    // The rest of the job folder (its note, sources and what was read from them), to read beside the work, where the connector can open it so.
    const beside = work && status.reads ? BESIDE_WORK.map((part) => join(this.folder(job.id), part)) : undefined;
    const system = systemPrompt(work ? (status.access ?? "full") : undefined, job.request.skills ?? [], this.o.knowledge !== false ? { video, style, open: job.request.style === "auto" && !draft.style } : undefined, !!beside);
    // A remake's ask goes with every writing turn of it (a carry-on too), never with a polish, a repair or a revise.
    const remake = job.remake && !polish && !repair && !revise ? { beat: job.remake.beat, ...(job.remake.note ? { note: job.remake.note } : {}), draft } : undefined;
    const prompt = turnPrompt(job.request, styles, problems, carry !== undefined ? { ...(carry ? { why: carry } : {}), draft } : undefined, polish, remake);
    this.log(`job ${job.id}: turn ${turnId} gives the agent a system prompt of about ${tokens(system)} tokens (${system.length} characters${this.o.knowledge !== false ? ", the skills' pages given whole" : ", the index of skills only"}) and a first message of about ${tokens(prompt)} tokens (${prompt.length} characters)`);
    const keepAgentPrompt = this.o.keepAgentPrompt ?? !status.replacesWorkPrompt;
    const started = await this.o.connector.start({
      turnId,
      systemPrompt: system,
      prompt,
      tools: listing(this.o.toolbox),
      callback: { url: `${this.o.callbackBase()}/turns/${encodeURIComponent(turnId)}`, token },
      instructions: INSTRUCTIONS,
      // No clock unless one is set: the agent works until it finishes, or the person stops it.
      timeoutMs: this.o.turnMinutes ? this.o.turnMinutes * 60_000 : 0,
      keepAgentPrompt,
      ...(job.request.agent ? { agent: job.request.agent } : {}),
      ...(job.request.model ? { model: job.request.model } : {}),
      ...(job.request.effort ? { effort: job.request.effort } : {}),
      target: { type: "video", id: job.id },
      ...(work ? { workspace: { path: work, ...(beside ? { read: beside } : {}) } } : {}),
    });
    if (!started.ok) {
      this.turns.delete(turnId);
      return this.fail(job, { code: started.problem, message: WORDS[started.problem], detail: started.message, ...(started.limit ? { limit: started.limit } : {}) }), "failed";
    }
    const askedModel = job.request.model ?? status.model;
    const pickedModel = started.model ?? askedModel;
    const pickedEffort = started.effort ?? job.request.effort ?? status.effort;
    job.agent = { id: started.agent, ...(pickedModel ? { model: pickedModel } : {}), ...(pickedEffort ? { effort: pickedEffort } : {}) };
    this.stepTo(job, repair ? "Your agent is fixing a scene" : polish ? "Your agent is going over a viewer's notes" : "Your agent is writing");
    this.save(job);
    this.log(`job ${job.id}: turn ${turnId} started (${started.agent}${pickedModel ? `, ${pickedModel}` : ", its own default model"}${pickedEffort ? `, ${pickedEffort}` : ""}${started.workspace ? (status.access === "files" ? ", its file tools only in its folder" : ", own tools on in its boxed folder") : ""})`);
    const t0 = Date.now();
    const callsBefore = draft.toolCalls;
    // The end, or the turn gone without one: the heartbeat stops as soon as either is known.
    const beating = new AbortController();
    let arrived: TurnReport | undefined;
    void ended.then((report) => (arrived = report));
    this.activity.set(job.id, { at: this.now(), open: 0 });
    let outcome: TurnOutcome = await Promise.race([ended.then((report) => ({ report })), this.heartbeat(turnId, beating.signal, job.id)]);
    beating.abort();
    // An end that arrived meanwhile wins over the heartbeat.
    if (!("report" in outcome) && arrived) outcome = { report: arrived };
    this.turns.delete(turnId);
    job.timings.writingMs += Date.now() - t0;
    if ("idle" in outcome) {
      // Hung, not slow: nothing called for that long. The turn is stopped like a cut-off one: the draft is kept, the
      // job says plainly what happened, and trying again carries the writing on in a new turn told what exists.
      const minutes = Math.round(outcome.idle / 60_000);
      this.log(`job ${job.id}: turn ${turnId} stopped: no call to Open Sourcebook's tools for ${minutes} min, after ${((Date.now() - t0) / 60_000).toFixed(1)} min and ${draft.toolCalls} tool calls so far`);
      void this.o.connector.stop(turnId);
      job.making = makingOf(draft);
      this.save(job);
      if (abort.signal.aborted || job.state === "stopped") return "failed";
      const kept = draft.script?.scenes.length ? ` What it made (${draft.script.scenes.length === 1 ? "one beat" : `${draft.script.scenes.length} beats`}) is kept: try again to carry on from there.` : " Try again.";
      return this.fail(job, { code: "timedOut", message: `Your agent did nothing for ${minutes} minutes (no call to Open Sourcebook's tools), so Open Sourcebook stopped its turn as hung.${kept}`, detail: `no tool call for ${minutes} min (SCENES_IDLE_MINUTES)` }), "failed";
    }
    if ("gone" in outcome) {
      this.log(`job ${job.id}: turn ${turnId} gone without an end (${outcome.gone === "silent" ? "the connector stopped answering" : "the connector says it no longer runs"}) after ${((Date.now() - t0) / 60_000).toFixed(1)} min, ${draft.toolCalls} tool calls so far`);
      void this.o.connector.stop(turnId);
      this.save(job);
      if (abort.signal.aborted || job.state === "stopped") return "failed";
      return outcome;
    }
    const report = outcome.report;
    if (report.model || report.effort) {
      const m = report.model ?? job.agent.model;
      const e = report.effort ?? job.agent.effort;
      job.agent = { id: job.agent.id, ...(m ? { model: m } : {}), ...(e ? { effort: e } : {}) };
    }
    this.log(`job ${job.id}: turn ${turnId} ${report.outcome}${report.problem ? ` (${report.problem})` : ""} after ${((Date.now() - t0) / 60_000).toFixed(1)} min, ${draft.toolCalls} tool calls so far${report.firstTokensIn !== undefined ? `, first call ${report.firstTokensIn} in` : ""}${report.tokensIn !== undefined ? `, ${report.tokensIn} tokens in` : ""}${draft.finished?.note ? `; its note: ${draft.finished.note}` : ""}`);
    job.making = makingOf(draft);
    this.save(job);
    this.log(`job ${job.id}: turn ${turnId}, how it was made so far: ${makingText(job.making)}`);
    if (abort.signal.aborted || job.state === "stopped") return "failed";
    // An agent that ended its turn itself without calling finish still made the video when every scene builds. A turn
    // cut off from outside (a usage limit, a sign-out, an error) did not: the agent never judged that draft done, may
    // not have seen it, and was mid-way through changing it. Its draft is kept and the job fails with why, so a resume
    // (the engine's, once the limit resets) carries the writing on in a new turn instead of delivering unseen work.
    if (draft.script && !unfinished(draft).length && (report.outcome === "done" || draft.finished)) return "written";
    if (report.outcome === "failed" && report.problem && report.problem !== "error") {
      const limit = report.problem === "agentLimit" ? readLimit(report.limit) : undefined;
      return this.fail(job, { code: report.problem, message: WORDS[report.problem], ...(report.text ? { detail: report.text.slice(0, 500) } : {}), ...(limit ? { limit } : {}) }), "failed";
    }
    // The voice went out while the agent wrote, and it ended before the video was done: what it made waits for the voice.
    if (draft.voiceDown) return this.fail(job, voiceDownFailure(draft.voiceDown.message, draft.voiceDown.trouble, unfinished(draft).join(" "))), "failed";
    // The agent ended in an error of its own before it called any of Open Sourcebook's tools (a model its account does not offer, a
    // setting it refused): it did no work, so its script was never refused. Said as that, with its own words.
    if (report.outcome === "failed" && draft.toolCalls === callsBefore) {
      const said = typeof report.said === "string" && report.said.trim() ? report.said.trim().slice(0, 300) : undefined;
      return this.fail(job, { code: "agentError", message: agentErrorWords(said, askedModel, Boolean(job.request.model)), ...(said ? { said } : {}), detail: `the turn failed before any tool call${said ? `: ${said}` : ""}` }), "failed";
    }
    if (!draft.script) return this.fail(job, { code: "scriptRefused", message: WORDS.scriptRefused, ...(report.text ? { detail: report.text.slice(0, 500) } : {}) }), "failed";
    const built = !unfinished(draft).length;
    return this.fail(job, { code: "error", message: built ? "Your agent's turn ended in an error before it finished the video. What it made is kept: carry on to pick it up." : "Your agent stopped before every scene of the video was built and checked. Try again.", detail: `${unfinished(draft).join(" ")} ${report.text ?? ""}`.slice(0, 500) }), "failed";
  }

  /**
   * Asks the connector, every `everyMs`, whether the turn still runs; resolves when it is gone: the connector has not
   * answered for `silentMs`, or has said it no longer runs for `endedMs`. A gap between checks longer than `sleptMs`
   * is the computer sleeping: it is not counted, and the checks start over. Never resolves once `signal` is aborted
   * (the end arrived, which always wins).
   */
  private async heartbeat(turnId: string, signal: AbortSignal, jobId?: string): Promise<TurnOutcome> {
    const never = new Promise<never>(() => undefined);
    const h = this.beat;
    let last = this.now();
    let heard = last;
    let notRunningSince: number | undefined;
    // Quiet time awake: how long the agent has called none of Open Sourcebook's tools, with none running, not counting sleep.
    let quiet = 0;
    let lastCall = jobId ? this.activity.get(jobId)?.at : undefined;
    for (;;) {
      await pause(h.everyMs, signal);
      if (signal.aborted) return never;
      const now = this.now();
      const seen = jobId ? this.activity.get(jobId) : undefined;
      if (now - last > h.sleptMs) {
        last = heard = now;
        notRunningSince = undefined;
        lastCall = seen?.at;
        continue;
      }
      if (seen) {
        if (seen.open > 0 || seen.at !== lastCall) quiet = 0;
        else quiet += now - last;
        lastCall = seen.at;
        if (h.idleMs > 0 && quiet >= h.idleMs) return { idle: quiet };
      }
      const r = await this.o.connector.running(turnId);
      if (signal.aborted) return never;
      const at = this.now();
      if (at - last > h.sleptMs) {
        last = heard = at;
        notRunningSince = undefined;
        continue;
      }
      last = at;
      if (!r.reachable) {
        notRunningSince = undefined;
        if (at - heard >= h.silentMs) return { gone: "silent" };
        continue;
      }
      heard = at;
      if (r.running === false) {
        notRunningSince ??= at;
        if (at - notRunningSince >= h.endedMs) return { gone: "ended" };
      } else notRunningSince = undefined;
    }
  }

  /** Whether a fresh viewer watches this job's video: the request's own say, else the service's setting. */
  private reviewOn(job: JobRecord): boolean {
    return job.request.review ?? this.o.review?.on ?? false;
  }

  /**
   * The fresh viewer's one round (src/review.ts), once the maker's writing is done: the cut as it stands (rendered once
   * when the maker's last render is not of it), watched by a blind viewer turn; with faults named, one more maker turn
   * with the notes. Recorded in the draft before anything runs, so a restart or a resume never starts a second round.
   * Whatever goes wrong (no cut, the viewer cut off or silent, the polish turn cut off), the finished first cut is kept
   * and the job carries on to hand it over: this round never costs the person their video.
   */
  private async reviewRound(job: JobRecord, abort: AbortController): Promise<void> {
    if (!this.reviewOn(job)) return;
    const draft = this.draft(job);
    if (draft.review || draft.voiceDown || unfinished(draft).length) return;
    // The writing is done: taken as finished, so a restart from here hands over this video rather than writing more.
    draft.finished ??= {};
    draft.review = { round: 1, state: "watching", at: new Date().toISOString() };
    this.saveDraft(job.id, draft);
    const record = draft.review;
    const end = (state: NonNullable<Draft["review"]>["state"], why?: string) => {
      const d = this.draft(job);
      d.review = { ...(d.review ?? record), state, ...(why ? { why } : {}) };
      this.saveDraft(job.id, d);
      job.making = makingOf(d);
      this.save(job);
      this.log(`job ${job.id}: fresh viewer: ${state}${why ? ` (${why})` : ""}`);
    };
    const ctx = this.context(job, abort.signal);
    let cut = currentCut(ctx);
    if (!cut || !existsSync(join(this.folder(job.id), cut.file))) {
      this.stepTo(job, "Rendering the video for a fresh viewer");
      this.save(job);
      const t0 = Date.now();
      let made;
      try {
        made = await makeCut(ctx);
      } catch (e) {
        // The voice going away waits for the voice, as a render after the turn would; anything else, the render after the turn tries again.
        if (voiceDownOf(e) || abort.signal.aborted) throw e;
        return end("skipped", `the cut could not be rendered: ${(e as Error).message.slice(0, 160)}`);
      } finally {
        job.timings.renderMs += Date.now() - t0;
      }
      if (abort.signal.aborted) return;
      if ("broken" in made) return end("skipped", "a beat does not build on the real word times");
      cut = made.cut;
    }
    const kept = keepCut(this.folder(job.id), cut);
    if (!kept) return end("skipped", "the cut's file is missing");
    record.cut = cut.number;
    record.firstCut = kept;
    this.saveDraft(job.id, draft);
    this.setProgress(job, 0.7);
    const seen = await this.viewerTurn(job, abort, ctx, cut, kept);
    if (abort.signal.aborted || job.state === "stopped") return;
    if (!seen.review) return end("failed", seen.why);
    record.review = seen.review;
    if (seen.model) record.model = seen.model;
    this.log(`job ${job.id}: fresh viewer on cut ${cut.number}${seen.review.via === "text" ? " (read from its words)" : ""}: ${reviewLines(seen.review).join(" | ").slice(0, 1500)}`);
    if (!seen.review.faults.length) return end("noFaults");

    // One polish turn: the maker hears the notes and changes what it agrees with. If that turn is cut off, the draft as
    // it was and the first cut are put back, so the person gets the video that was finished.
    const before = structuredClone(draft);
    record.state = "polishing";
    delete draft.finished;
    this.saveDraft(job.id, draft);
    const written = await this.writeTurn(job, abort, undefined, undefined, undefined, polishText(seen.review, draft, cut));
    // Stopped by the person while it polished: stopped it stays (the state changes while the turn runs).
    if (abort.signal.aborted || (job.state as State) === "stopped") return;
    const after = this.draft(job);
    if (written === "written") {
      const changed = changedBeats(before, after);
      const polished = currentCut(this.context(job));
      after.review = { ...record, state: "polished", changed: changed.beats, soundChanged: changed.sound, ...(polished && polished.number !== cut.number ? { polishedCut: polished.number } : {}) };
      this.saveDraft(job.id, after);
      job.making = makingOf(after);
      this.save(job);
      this.log(`job ${job.id}: fresh viewer: polished; beats changed: ${changed.beats.join(", ") || "none"}${changed.sound ? ", the sound changed" : ""}${polished ? `; cut ${polished.number} is the video as it stands` : "; rendered after the turn"}`);
      return;
    }
    // Cut off: the first cut is the video. A render still running for the polish is let finish before it is put back.
    await renders.get(this.folder(job.id))?.done.catch(() => undefined);
    const why = job.failure ? `${job.failure.code}${job.failure.detail ? `: ${job.failure.detail.slice(0, 120)}` : ""}` : typeof written === "object" ? `its turn was dropped (${written.gone})` : "its turn did not end well";
    before.review = { ...record, state: "keptFirst", why, changed: changedBeats(before, after).beats };
    this.drafts.set(job.id, before);
    this.saveDraft(job.id, before);
    restoreCut(this.folder(job.id), cut, kept);
    renders.delete(this.folder(job.id));
    delete job.failure;
    job.state = "writing";
    job.making = makingOf(before);
    this.stepTo(job, "Keeping the finished video");
    this.save(job);
    this.log(`job ${job.id}: fresh viewer: the polish turn was cut off (${why}); the first cut is kept`);
  }

  /**
   * The fresh viewer's turn: no folder and none of its own tools, only Open Sourcebook's three to watch and answer, a first message
   * of what a viewer has (src/review.ts), and a time limit. Its answer, from submit_review or read from its last words;
   * or why there is none.
   */
  private async viewerTurn(job: JobRecord, abort: AbortController, ctx: ToolContext, cut: Cut, kept: string): Promise<{ review?: Review; why?: string; model?: string }> {
    // The viewer's own pick when the request names one (its model and effort go with that agent alone), else the
    // video's agent with the service's review model and effort when that agent is the service's own.
    const own = job.request.reviewAgent ? { agent: job.request.reviewAgent, ...(job.request.reviewModel ? { model: job.request.reviewModel } : {}), ...(job.request.reviewEffort ? { effort: job.request.reviewEffort } : {}) } : undefined;
    const viewerAgent = own?.agent ?? job.request.agent;
    const status = await this.o.connector.status(false, viewerAgent);
    if (abort.signal.aborted) return { why: "stopped" };
    if (!status.reachable || status.problem) return { why: status.problem ?? "agentUnreachable" };
    const defaultStatus = !own && job.request.agent && !this.o.connector.config.agent ? await this.o.connector.status() : undefined;
    const reviewMatchesAgent = !own && (!job.request.agent || job.request.agent === (this.o.connector.config.agent ?? defaultStatus?.id));
    const folder = this.folder(job.id);
    const report = cut.facts && existsSync(join(folder, cut.facts)) ? await viewerReportOf(ctx, cut).catch(() => undefined) : undefined;
    const session: ViewerSession = {
      request: job.request,
      cut,
      video: join(folder, kept),
      folder: join(folder, "review", `cut-${cut.number}`),
      ...(report ? { report: reportText(report, `Measured in cut ${cut.number} (${clock(cut.durationMs / 1000)}).`) } : {}),
      watched: 0,
      framesShown: 0,
    };
    const turnId = `${job.id}-viewer-${++job.timings.turns}`;
    const token = randomBytes(24).toString("hex");
    const ended = new Promise<TurnReport>((resolve) => this.turns.set(turnId, { id: turnId, jobId: job.id, token, ended: resolve, view: session }));
    this.running.get(job.id)!.turnId = turnId;
    abort.signal.addEventListener("abort", () => this.turns.get(turnId)?.ended({ outcome: "failed", problem: "stopped" }), { once: true });
    const prompt = viewerPrompt(session);
    const r = this.o.review;
    const started = await this.o.connector.start({
      turnId,
      systemPrompt: VIEWER_SYSTEM,
      prompt,
      tools: viewerListing(),
      callback: { url: `${this.o.callbackBase()}/turns/${encodeURIComponent(turnId)}`, token },
      instructions: VIEWER_INSTRUCTIONS,
      timeoutMs: VIEWER_MINUTES * 60_000,
      keepAgentPrompt: this.o.keepAgentPrompt ?? !status.replacesWorkPrompt,
      ...(viewerAgent ? { agent: viewerAgent } : {}),
      target: { type: "video-review", id: job.id },
      ...(own?.model ? { model: own.model } : reviewMatchesAgent && r?.model ? { model: r.model } : {}),
      ...(own?.effort ? { effort: own.effort } : reviewMatchesAgent && r?.effort ? { effort: r.effort } : {}),
    });
    if (!started.ok) {
      this.turns.delete(turnId);
      return { why: `${started.problem}: ${started.message.slice(0, 160)}` };
    }
    this.stepTo(job, "A fresh viewer is watching the video");
    this.save(job);
    const vModel = started.model ?? own?.model ?? (reviewMatchesAgent ? r?.model : undefined) ?? status.model;
    const vEffort = started.effort ?? own?.effort ?? (reviewMatchesAgent ? r?.effort : undefined) ?? status.effort;
    this.log(`job ${job.id}: turn ${turnId} started: a fresh viewer on cut ${cut.number} (${started.agent}${vModel ? `, ${vModel}` : ""}${vEffort ? `, ${vEffort}` : ""}), a first message of about ${tokens(prompt)} tokens`);
    const t0 = Date.now();
    const beating = new AbortController();
    let arrived: TurnReport | undefined;
    void ended.then((report) => (arrived = report));
    let outcome: TurnOutcome = await Promise.race([ended.then((report) => ({ report })), this.heartbeat(turnId, beating.signal)]);
    beating.abort();
    if (!("report" in outcome) && arrived) outcome = { report: arrived };
    this.turns.delete(turnId);
    // The viewer's own time, kept apart from the making: it is the review's, said beside the maker's.
    job.reviewed = { seconds: +(((job.reviewed?.seconds ?? 0) * 1000 + Date.now() - t0) / 1000).toFixed(1), agent: started.agent, ...(vModel ? { model: vModel } : {}), ...(vEffort ? { effort: vEffort } : {}) };
    const minutes = ((Date.now() - t0) / 60_000).toFixed(1);
    if (!("report" in outcome)) {
      void this.o.connector.stop(turnId);
      this.log(`job ${job.id}: turn ${turnId} gone without an end after ${minutes} min`);
      return session.review ? { review: session.review } : { why: "the viewer's turn was dropped" };
    }
    const end = outcome.report;
    this.log(`job ${job.id}: turn ${turnId} ${end.outcome}${end.problem ? ` (${end.problem})` : ""} after ${minutes} min: watched ${session.watched} time${session.watched === 1 ? "" : "s"}, ${session.framesShown} full-size frame${session.framesShown === 1 ? "" : "s"}${end.tokensIn !== undefined ? `, ${end.tokensIn} tokens in` : ""}`);
    const model = end.model;
    if (session.review) return { review: session.review, ...(model ? { model } : {}) };
    const fromText = end.text ? reviewFromText(end.text) : undefined;
    if (fromText) return { review: fromText, ...(model ? { model } : {}) };
    return { why: end.outcome === "failed" ? `the viewer's turn ended: ${end.problem ?? "error"}` : "the viewer gave no review", ...(model ? { model } : {}) };
  }

  /** Voice, final build (one repair turn when a scene breaks on the real times), render. */
  private async produce(job: JobRecord, abort: AbortController, repaired: boolean): Promise<void> {
    const ctx = this.context(job, abort.signal);
    job.style = styleOf(ctx);
    // The agent's last render is the video when nothing changed since: the person gets the file it watched.
    const cut = currentCut(ctx);
    if (cut && existsSync(join(this.folder(job.id), cut.file))) {
      const script = ctx.draft.script!;
      const passages = new Map(job.request.passages.map((p) => [p.id, p]));
      this.take(job, script, passages, cut.spans, { bytes: cut.bytes, durationMs: cut.durationMs }, cut.voice, cut.number);
      this.log(`job ${job.id}: done with the agent's cut ${cut.number}, ${(cut.durationMs / 1000).toFixed(1)} s; writing ${(job.timings.writingMs / 60_000).toFixed(1)} min, ${job.timings.toolCalls} tool calls`);
      return;
    }
    job.state = "voicing";
    this.setProgress(job, 0.72);
    this.stepTo(job, "Recording the voice");
    this.save(job);
    let t0 = Date.now();
    const spoken = await voiceAll(ctx);
    job.timings.voiceMs += Date.now() - t0;
    this.stepTo(job, "Timing the scenes to the voice");
    this.setProgress(job, 0.76);
    this.save(job);
    t0 = Date.now();
    const { placed, broken } = await finalBuild(ctx, spoken);
    job.timings.buildMs += Date.now() - t0;
    if (abort.signal.aborted) return;
    if (Object.keys(broken).length) {
      if (repaired) return this.fail(job, { code: "error", message: "A scene of this video does not work with the voice's timing, even after your agent fixed it. Try again.", detail: JSON.stringify(broken).slice(0, 500) });
      job.state = "writing";
      this.save(job);
      const ok = await this.write(job, abort, undefined, broken);
      if (ok && !abort.signal.aborted) await this.produce(job, abort, true);
      return;
    }
    job.state = "rendering";
    this.stepTo(job, "Rendering the video");
    this.save(job);
    t0 = Date.now();
    // One video draws at a time (pipeline/stages/render.ts): this one's voice and scenes go on while another draws,
    // and only its drawing waits, saying so in its step.
    const out = await renderVideo(ctx, placed, spoken, (p) => this.setProgress(job, 0.8 + 0.2 * p, false));
    job.timings.renderMs += Date.now() - t0;
    if (abort.signal.aborted) return;
    const script = ctx.draft.script!;
    const passages = new Map(job.request.passages.map((p) => [p.id, p]));
    const voice = this.voiceOf(job);
    this.take(job, script, passages, out.laid.spans, out, { id: voice.id, label: voice.label, real: voice.real, ...(voice.note ? { note: voice.note } : {}) });
    const t = job.timings;
    this.log(`job ${job.id}: done, ${(out.durationMs / 1000).toFixed(1)} s video; writing ${(t.writingMs / 60_000).toFixed(1)} min, voice ${(t.voiceMs / 1000).toFixed(1)} s, build ${(t.buildMs / 1000).toFixed(1)} s, render ${(t.renderMs / 1000).toFixed(1)} s, ${t.toolCalls} tool calls in ${t.turns} turn${t.turns === 1 ? "" : "s"}${out.sound ? `; sound: ${out.sound.music.join(", ") || "no music"}, ${out.sound.effects.length} effect${out.sound.effects.length === 1 ? "" : "s"}, ${out.sound.lufs} LUFS` : ""}`);
  }

  /** Marks a job done with its video: the script, where each beat is, the file and the voice it was made with. */
  private take(job: JobRecord, script: NonNullable<Draft["script"]>, passages: Map<string, VideoRequest["passages"][number]>, spans: { id: string; startMs: number; endMs: number }[], file: { bytes: number; durationMs: number }, voice: Result["voice"], cut?: number): void {
    job.result = {
      title: script.title,
      idea: script.idea,
      scenes: script.scenes.map((s) => {
        const span = spans.find((x) => x.id === s.id)!;
        return { id: s.id, durationMs: span.endMs - span.startMs, narration: s.narration, onScreenText: s.onScreenText, visual: s.visual, cites: s.cites.map((c) => ({ passageId: c.passageId, sourceId: passages.get(c.passageId)!.sourceId, quote: c.quote })) };
      }),
      file: { bytes: file.bytes, durationMs: file.durationMs, width: job.request.frame.width, height: job.request.frame.height, contentType: "video/mp4" },
      voice,
      by: { maker: "scenes", agent: job.agent?.id ?? "agent", ...(job.agent?.model ? { model: job.agent.model } : {}), ...(job.agent?.effort ? { effort: job.agent.effort } : {}), style: job.style ?? "" },
      // Which render the person got (the agent's cut, or one made after its turn), so the record says whether it was seen.
      making: (job.making = makingOf(this.draft(job), cut ?? "after")),
      timing: { makingSeconds: +((job.timings.writingMs + job.timings.voiceMs + job.timings.buildMs + job.timings.renderMs) / 1000).toFixed(1), ...(job.reviewed && job.reviewed.seconds > 0 ? { review: job.reviewed } : {}) },
    };
    this.log(`job ${job.id}: how it was made: ${makingText(job.making)}`);
    // How long a whole video takes here, for the next one's estimate: the making itself, never a wait for a limit.
    const t = job.timings;
    speedBook()?.recordMade({
      seconds: (t.writingMs + t.voiceMs + t.buildMs + t.renderMs) / 1000,
      videoSeconds: file.durationMs / 1000,
      ...(job.agent?.id ? { agent: job.agent.id } : {}),
      ...(job.agent?.model ? { model: job.agent.model } : {}),
      ...(job.agent?.effort ? { effort: job.agent.effort } : {}),
    });
    job.state = "done";
    this.setProgress(job, 1);
    this.stepTo(job, "Done");
    this.toLibrary(job);
    this.save(job);
  }

  /** The finished video copied out to the library (the request's, else the service's), once per job; nothing when neither is set. */
  private toLibrary(job: JobRecord): void {
    if (job.library && existsSync(job.library)) return;
    try {
      const to = copyToLibrary(job.request.library ?? this.o.libraryDir, job.result?.title || job.request.title, join(this.folder(job.id), "video.mp4"));
      if (to) job.library = to;
    } catch (e) {
      this.log(`job ${job.id}: the video could not be copied to the library (${(e as Error).message})`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------

  private context(job: JobRecord, signal?: AbortSignal): ToolContext {
    const draft = this.draft(job);
    return {
      request: job.request,
      draft,
      folder: this.folder(job.id),
      styles: this.o.styles(),
      voice: this.voiceOf(job),
      step: (label) => this.stepTo(job, label),
      save: () => this.saveDraft(job.id, draft),
      ...(signal ? { signal } : {}),
      ...(this.o.toolbox ? { toolbox: this.o.toolbox } : {}),
    };
  }

  /** The voice this job speaks with: the service's, or none when the person chose to finish it without sound. */
  private voiceOf(job: JobRecord): Voice {
    return job.withoutSound ? silentVoice(withoutSoundNote(job.withoutSound.because)) : (this.pinned.get(job.id) ?? voiceNow(this.o.voice));
  }

  private draft(job: JobRecord): Draft {
    let draft = this.drafts.get(job.id);
    if (!draft) {
      const file = join(this.folder(job.id), "draft.json");
      draft = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Draft) : emptyDraft();
      this.drafts.set(job.id, draft);
    }
    return draft;
  }

  /** Writing progress from the draft: the script, then scenes built, then scenes looked at. */
  private progressFromDraft(job: JobRecord, draft: Draft): void {
    const scenes = draft.script?.scenes ?? [];
    if (!scenes.length) return this.setProgress(job, 0.03);
    const built = scenes.filter((s) => draft.scenes[s.id]?.built).length;
    const looked = scenes.filter((s) => draft.scenes[s.id]?.looked).length;
    this.setProgress(job, 0.1 + 0.35 * (built / scenes.length) + 0.25 * (looked / scenes.length));
  }

  /** Progress never goes back within a round (a revise starts a new round from 0). */
  private setProgress(job: JobRecord, value: number, save = true): void {
    const next = Math.round(Math.min(1, Math.max(job.progress, value)) * 1000) / 1000;
    const before = job.progress;
    if (next === before) return;
    job.progress = next;
    // While rendering, written to disk at each twentieth; GET reads the job in memory either way.
    if (save || Math.floor(next * 20) !== Math.floor(before * 20)) this.save(job);
  }

  private stepTo(job: JobRecord, label: string): void {
    if (job.step === label) return;
    job.step = label;
    job.steps.push({ label, at: new Date().toISOString() });
    if (job.steps.length > 300) job.steps.splice(0, job.steps.length - 300);
  }

  private fail(job: JobRecord, failure: Failure): void {
    if (job.state === "stopped") return;
    job.state = "failed";
    job.failure = failure;
    this.stepTo(job, "Failed");
    this.save(job);
    this.log(`job ${job.id}: failed (${failure.code})${failure.detail ? `: ${failure.detail.slice(0, 200)}` : ""}`);
  }

  private save(job: JobRecord): void {
    job.updatedAt = new Date().toISOString();
    writeAtomic(join(this.folder(job.id), "job.json"), JSON.stringify(job, null, 1));
  }

  private saveDraft(id: string, draft: Draft): void {
    writeAtomic(join(this.folder(id), "draft.json"), JSON.stringify(draft, null, 1));
  }
}

/**
 * What a person reads when their agent stopped with an error of its own before any work: that, its own words, and what
 * to do. When a model was asked for by name, that the model is set for videos, and that left empty the agent uses its own.
 */
export function agentErrorWords(said: string | undefined, model: string | undefined, fromRequest = false): string {
  const its = said ? ` It said: "${said.replace(/[.\s]+$/, "")}."` : "";
  const todo = model
    ? fromRequest
      ? ` Open Sourcebook asked it for the model "${model}": pick another model, or let Open Sourcebook pick the default, then try again.`
      : ` Open Sourcebook asked it for the model "${model}" (SCENES_AGENT_MODEL): set one your agent offers, or leave it empty for its own default, then try again.`
    : " Check that it runs on its own on this computer, then try again.";
  return `${WORDS.agentError}${its}${todo}`;
}

/** A video that waits for the voice: why it cannot speak, in the voice's own words, and what is kept. */
export function voiceDownFailure(message: string, trouble: VoiceTrouble, unbuilt = ""): Failure {
  return { code: "voiceDown", message: WORDS.voiceDown, detail: [message, unbuilt].filter(Boolean).join(" ").slice(0, 500), voice: trouble };
}

/**
 * What a video finished without sound says about its voice, as a video with no voice key does: that it has none and
 * why, that captions carry the words, and what gives the full video.
 */
export function withoutSoundNote(because: string): string {
  const why = because.trim() ? ` because the voice could not speak (${because.trim().replace(/\.+$/, "")})` : " because the voice could not speak";
  return `Made without sound, as you chose,${why}; the captions carry the words. Once the voice can speak again, make it again for the full video with sound.`;
}

/** Waits `ms`, or less when `signal` is aborted first. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** What GET /videos/:id answers: the job without its request or the making's own numbers. */
export function view(job: JobRecord) {
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    step: job.step,
    steps: job.steps,
    ...(job.style ? { style: job.style } : {}),
    ...(job.failure ? { failure: job.failure } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.making && !job.result ? { making: job.making } : {}),
    ...(job.remake ? { remakeOf: { id: job.remake.of, beat: job.remake.beat } } : {}),
  };
}
