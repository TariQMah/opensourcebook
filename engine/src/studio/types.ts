/**
 * Formats and the engine contract (docs/VISION.md "What it makes", "How it is built";
 * docs/DECISIONS.md #24). Every output Open Sourcebook makes, whatever its format, is
 * produced by an `OutputEngine` running the same four steps: plan → generate
 * → validate → repair, and an optional produce step once it is valid. Cost is not returned by the engine; every provider call reports to
 * `services.usage`, and the runner sums it per job.
 *
 * "plan" here is the engine's own blueprint for ONE output (a section
 * outline, a scene script). The project plan, the graph of items, lives in
 * the `plans` / `plan_nodes` tables and is not an engine concern.
 */
import type { AssetStore } from "../assets";
import type { FetchLike, StructuredProvider, UsageSink } from "../types/provider";
import type { AssetRef, SourceEnvelope } from "../types/source";

/**
 * A format id: any string a registry declares (`FormatRegistry`). There is
 * no closed list; rows store the id as written, and an id no registry knows
 * is kept and shown neutrally, never rejected on read.
 */
export type FormatId = string;

/** The shape a new id must have: camelCase, letters and digits. */
const FORMAT_ID_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;

export function isFormatId(value: unknown): value is FormatId {
  return typeof value === "string" && FORMAT_ID_PATTERN.test(value);
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Where a passage sits inside a source. All fields optional; a source kind
 * fills the ones that mean something for it (PDF: page; video: ms; sheet: cell).
 * A span is `page`..`endPage` or `slide`..`endSlide`, both inclusive; without
 * an end it is the one page or slide.
 */
export interface SourceLocator {
  page?: number;
  endPage?: number;
  slide?: number;
  endSlide?: number;
  startMs?: number;
  endMs?: number;
  charStart?: number;
  charEnd?: number;
  cell?: string;
}

/** One citable passage of an extracted source (`source_chunks` row). */
export interface SourceChunk {
  id: string;
  ord: number;
  text: string;
  locator?: SourceLocator;
}

/** A source as one item sees it: the whole extraction, or only `range` of it. */
export interface NodeSource {
  sourceId: string;
  /** The source's title as the person sees it (theirs, or the one read from it). */
  title?: string;
  envelope: SourceEnvelope;
  chunks: SourceChunk[];
  range?: SourceLocator;
  /** The file on this computer it is read from, for a file of a linked folder (#71). */
  path?: string;
}

/** Grounding for one claim. `anchor` says where in the payload it applies (engine-defined path). */
export interface Citation {
  sourceId: string;
  chunkId?: string;
  locator?: SourceLocator;
  quote?: string;
  anchor?: string;
}

/** An earlier output this item may assume the learner has already seen. */
export interface PriorOutput {
  nodeId: string;
  outputId: string;
  type: FormatId;
  title: string;
  summary: string;
}

/**
 * A non-file input: an earlier item's output and result. `kind` names the
 * edge (`plan_edges.kind`, any kind but `assumes`, e.g. `fix_of`). `result`
 * is what the person recorded on that item (`item_results.result_json`),
 * present once they have; any format may take one, not only a fix.
 */
export interface NodeInput {
  kind: string;
  nodeId: string;
  outputId?: string;
  type: FormatId;
  result?: JsonValue;
}

/** The plan item being generated, with its settings already parsed. */
export interface EngineNode<Settings> {
  id: string;
  type: FormatId;
  title: string;
  /** Written by the planning agent from the whole plan; editable by the user. */
  prompt: string;
  settings: Settings;
}

export interface EngineProgress {
  stage: string;
  /** 0...1 within this job. */
  progress: number;
  /**
   * What is happening now in plain words for the person ("Writing scene 2
   * of 5"), when the engine has them. Kept on the job and shown on the
   * running item; `stage` stays a short code.
   */
  step?: string;
  /**
   * When the engine expects to be done (ISO time), from what this computer has
   * actually done before; `null` when that cannot be known now (its work has no
   * known end yet, or it is past what was expected). Shown as the time left on
   * the running item; `null` shows none. Absent leaves what was said before.
   */
  doneBy?: string | null;
}

/** Everything an engine may touch. Nothing else is imported from the worker. */
export interface EngineServices {
  provider: StructuredProvider;
  assets: AssetStore;
  usage: UsageSink;
  /** For Open Sourcebook's own programs and the model services it is set up with. */
  fetch: FetchLike;
  /** For addresses a source or a model gave (a link in a card): each checked before it is opened (`../guard.ts`). */
  sourceFetch?: FetchLike;
  now(): string;
  /** Aborted when the job is cancelled. Engines pass it down and stop. */
  signal?: AbortSignal;
  progress(update: EngineProgress): void | Promise<void>;
  /**
   * Work this job's earlier attempts finished, kept on the job, so a retry
   * or a queue redelivery continues from it instead of paying for it again.
   * Absent when nothing keeps it (a direct `runEngine` in a test).
   */
  checkpoint?: EngineCheckpoint;
  /**
   * The way on the person chose while this job waited (a `WaitChoice` id its
   * maker offered with `JobWait`, such as finishing a video without sound).
   */
  chosen?: string;
  /**
   * The agent, model and effort a turn of `scope` (a format id) runs on when
   * the item names no agent: the scope's default from Settings, else the only
   * provider that can (chat/providers.ts, `resolvePick`). Fails the job in
   * plain words when none can or several could. Absent when nothing settles
   * it here (a direct `runEngine` in a test): the pick is sent as it is.
   */
  settlePick?(scope: string, pick: { agent?: string; model?: string; effort?: string }): Promise<{ agent?: string; model?: string; effort?: string }>;
  /**
   * The folder on this computer a finished file of this job is copied into (docs/JOB-FOLDER.md, "The library"): the
   * project's linked folder, else the project's own folder in the library. Undefined when there is none here (no
   * project, or an engine not on the person's computer). Nothing is made on disk by asking.
   */
  libraryFolder?(): Promise<string | undefined>;
}

/**
 * Finished pieces of one job's work, by key. Keys are the engine's own
 * (`section:intro`, `question:3`); values are plain JSON. A value saved
 * belongs to the blueprint saved on the same job, so an engine only reads
 * keys for the blueprint it is running.
 */
export interface EngineCheckpoint {
  get(key: string): JsonValue | undefined;
  put(key: string, value: JsonValue): Promise<void>;
}

export interface EngineContext<Settings = unknown> {
  jobId: string;
  /** Whose job it is, for what a maker looks up for the person (their times on this computer). */
  ownerId?: string;
  node: EngineNode<Settings>;
  sources: NodeSource[];
  /** Outputs of earlier levels. Same-level items never appear here. */
  assumes: PriorOutput[];
  inputs: NodeInput[];
  /** `packs`: the packs on for the project (its settings), whose skills the maker may read. */
  project?: { id: string; title: string; packs?: string[] };
  /** Stop spending once the job's usage passes this. */
  budgetUSD?: number;
  /**
   * A remake of one scene of a made output (`FormatDefinition.remakeScene`): the output, the scene the person asked
   * to be made again, their note in their own words, and how to find what made it: the job that made it and what its
   * maker kept on that job (`EngineOutput.keep`). Absent: the item is made as usual.
   */
  remakeOf?: SceneRemakeOf;
  services: EngineServices;
}

/** What a remake job is asked (`EngineContext.remakeOf`, the job's `input.remakeOf`). */
export interface SceneRemakeOf {
  outputId: string;
  /** The scene's id in the output's payload. */
  scene: string;
  /** The person's words about it, passed on as they wrote them. */
  note?: string;
  /** The job that made the output. */
  madeBy?: string;
  /** What its maker kept on that job once the output was written. */
  kept?: Record<string, JsonValue>;
}

/** What an engine hands back. `payload` is the format-specific artifact. */
export interface EngineOutput<Payload = unknown> {
  title: string;
  /** Two or three sentences later items receive as `PriorOutput.summary`. */
  summary: string;
  payload: Payload;
  citations: Citation[];
  assets?: AssetRef[];
  /** How long making it took and on what, for the times said before making (`make_times`). Absent when the maker does not know. */
  timing?: MakeTiming;
  /**
   * What the maker keeps on its job once the output is written, to find its own work again later (the id of a video
   * on the scenes service, so one scene of it can be made again). Kept as the job's `state.kept`. Absent: nothing.
   */
  keep?: Record<string, JsonValue>;
}

/** How long one thing took to make, and the pick it was made on (the key `make_times` keeps it under). */
export interface MakeTiming {
  /** Seconds of making: the agent's turns and the maker's own work, never a wait for a limit, the voice or the person. */
  seconds: number;
  agent: string;
  model?: string;
  effort?: string;
  /** For a reviewed thing: the review's own time and pick. */
  review?: { seconds: number; agent: string; model?: string; effort?: string };
}

/** One remembered pick (`agent_picks`), as a format's `settle` reads it. `off` only on a review scope ("<format>.review"). */
export interface ScopePick {
  agent?: string;
  model?: string;
  effort?: string;
  off?: boolean;
}

/** Remembered picks by scope: "chat", a format id, or "<format>.review". */
export type PicksByScope = Record<string, ScopePick>;

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationReport {
  /** False when at least one issue is an error. Warnings never block. */
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * One engine per format.
 *
 * - `Blueprint` must be JSON-serializable: the runner saves it on the job so a
 *   redelivered job skips `plan`. Every later step receives it, so an engine
 *   keeps no state of its own between steps.
 * - `generate` and `repair` return the whole output; `repair` gets the report
 *   it must clear and should change as little as possible.
 * - `validate` is pure with respect to the output: no provider spend beyond
 *   what checking needs (URL checks are fine, rewriting is not).
 */
export interface OutputEngine<Settings = unknown, Blueprint = unknown, Payload = unknown> {
  readonly type: FormatId;
  /** Version of `Payload`; stored on the output row so players can branch. */
  readonly schemaVersion: number;
  plan(ctx: EngineContext<Settings>): Promise<Blueprint>;
  generate(ctx: EngineContext<Settings>, blueprint: Blueprint): Promise<EngineOutput<Payload>>;
  validate(ctx: EngineContext<Settings>, output: EngineOutput<Payload>, blueprint: Blueprint): Promise<ValidationReport>;
  repair(
    ctx: EngineContext<Settings>,
    output: EngineOutput<Payload>,
    report: ValidationReport,
    blueprint: Blueprint,
  ): Promise<EngineOutput<Payload>>;
  /**
   * Optional fifth step: makes what a valid output needs beyond its payload
   * (a video's file, docs/DECISIONS.md #48) and returns the output with it.
   * The runner calls it once, only after validation passes; an output that
   * never validates is never produced.
   */
  produce?(ctx: EngineContext<Settings>, output: EngineOutput<Payload>, blueprint: Blueprint): Promise<EngineOutput<Payload>>;
}

export type SettingsResult<Settings> =
  | { ok: true; settings: Settings }
  | { ok: false; issues: ValidationIssue[] };

export interface CostEstimateInput<Settings> {
  settings: Settings;
  /** Total characters of the item's sources, after ranges are applied. */
  sourceChars: number;
  sourceCount: number;
}

export interface CostEstimate {
  /**
   * Dollars, when the model that would do the work has a known price (or the
   * work needs no model). Absent when it has none: an unknown cost is never
   * reported as $0.
   */
  usd?: number;
  /** True when no price is known for the model, so `usd` is absent. */
  unpriced?: true;
  /** One line shown next to the number, e.g. "3 min video, 12 scenes". */
  basis: string;
}

/**
 * One setting a format declares, for clients to render a form from. Values
 * are checked by the format's `parseSettings`; the schema says what to show.
 * A client that meets a `kind` it does not know leaves that field out.
 *
 * `choice` stores one option's `value`; `choices` stores a list of them
 * (at least `minItems`, at most `maxItems`). The values are codes; clients
 * show each option's `label` and `description`, never the code.
 */
export type SettingField =
  | (SettingFieldBase & { kind: "choice"; options: SettingOption[] })
  | (SettingFieldBase & { kind: "choices"; options: SettingOption[]; minItems?: number; maxItems?: number })
  | (SettingFieldBase & { kind: "number"; min?: number; max?: number; step?: number; unit?: string; specialValues?: SettingNumberValue[] })
  | (SettingFieldBase & { kind: "toggle" })
  | (SettingFieldBase & { kind: "text"; maxLength?: number })
  | (SettingFieldBase & { kind: "textList"; maxItems?: number; maxLength?: number })
  | (SettingFieldBase & {
      kind: "agent";
      /** The setting that holds the thinking effort picked with it. */
      effortKey?: string;
      turnKind?: "chat" | "work";
      /** "make": who makes the thing (absent reads as "make"); "review": who reads it fresh once it is made. */
      role?: "make" | "review";
      /** The value that turns this agent off (a reviewer's "off"); absent when it cannot be off. */
      offValue?: string;
    });

/** One value a `choice` or `choices` setting offers, in words. */
export interface SettingOption {
  /** What is stored. */
  value: string;
  /** Short, as the form shows it. */
  label: string;
  /** One line on what picking it does, for the form and for the planner. */
  description: string;
  /**
   * A picture of what picking it gives (a style's look), as a path on this
   * engine (`/v1/...`) a client loads with its own credentials. A client may
   * show the options of a setting whose options have one as pictures.
   */
  preview?: string;
}

/**
 * A value of a `number` setting that does not mean the number itself (a
 * quiz's 0 questions: Open Sourcebook decides how many). A client shows its `label`
 * instead of the number when it is the value.
 */
export interface SettingNumberValue {
  value: number;
  /**
   * What the value stands for, so a client need not read it from the words:
   * `auto`, the brief and the sources decide the number when it is made (a
   * video's length 0); `none`, there is no such limit (a quiz's time limit 0).
   */
  means: "auto" | "none";
  /** Short, as the form shows it in place of the number. */
  label: string;
  /** One line on what it does, for the form and for the planner. */
  description: string;
}

export interface SettingFieldBase {
  key: string;
  label: string;
  help?: string;
  /** Set by Open Sourcebook itself (quick mode, the planner); clients do not show it. */
  hidden?: boolean;
  /**
   * Shown, and read, only while another setting of the same format (`key`)
   * holds one of these values (its default counts when the item sets none).
   * A client that does not know it shows the field always.
   */
  showWhen?: SettingCondition;
}

/** "While setting `key` is one of `in`." */
export interface SettingCondition {
  key: string;
  in: string[];
}

/** One number a format's player reports in an item's result. */
export interface ReportedMetric {
  /** The key in the result, and what a branch condition names. */
  metric: string;
  /** Its name in sentence case, as a client shows it ("Right answers"). */
  label: string;
  /** What it means, for the planner. */
  about: string;
  /**
   * How to show the number: `share` is 0 to 1, shown as a percentage;
   * `count` is a whole number shown as it is. Absent: shown as it is.
   */
  unit?: MetricUnit;
}

export const METRIC_UNITS = ["share", "count"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * What a format says about itself, served by `GET /v1/formats` so the web
 * and the phone never list formats of their own.
 */
export interface FormatDescriptor {
  id: FormatId;
  /** The word on screen, lower case as in docs/GLOSSARY.md; clients capitalize where a sentence needs it. */
  label: string;
  /** The word for more than one ("quizzes"), for counts such as a plan's size; `label` + "s" when absent. */
  plural?: string;
  /** The words for one, in a sentence ("set of flashcards"), when the label itself reads as many; `label` when absent. */
  singular?: string;
  /** Which of the neutral format colour slots its badge uses (1 to 8; tokens.css `--fmt-N-*`). */
  colorSlot: number;
  /** A name from Open Sourcebook's shared icon set; each client maps it to its own glyph. */
  icon: string;
  /** Older ids stored rows may carry; they resolve to this format. */
  aliases?: FormatId[];
  /** What it is, in a sentence, for the planner and for clients that explain formats. */
  about?: string;
  /**
   * What it is in a few plain words, for a person meeting the word for the
   * first time ("a short read you swipe through"). Clients show it beside the
   * label where the format is first offered or planned.
   */
  blurb?: string;
  /**
   * Numbers its player reports in an item's result, which a branch
   * condition (`metric`) or a later item can read. Absent when it reports none.
   */
  reports?: ReportedMetric[];
  settings: SettingField[];
  /** The settings an item gets when it sets none; `parseSettings` accepts them. */
  defaults: Record<string, JsonValue>;
  /**
   * How making times are kept apart by length: the number `setting` that
   * holds the length and the `edges` (ascending) of its buckets. Absent:
   * one time per pick, whatever the length.
   */
  timing?: { setting: string; edges: number[] };
  /** True when the thing is spoken by the voice set up on this computer, so clients show the voice beside it. */
  voiced?: true;
}

/** A format with an engine: its descriptor, engine, settings parser and cost. */
export interface FormatDefinition<Settings = unknown, Blueprint = unknown, Payload = unknown> {
  readonly descriptor: FormatDescriptor;
  readonly engine: OutputEngine<Settings, Blueprint, Payload>;
  /** Repair rounds the runner allows before it gives up. */
  readonly maxRepairRounds: number;
  /**
   * True when making one uses most of this computer for many minutes
   * (frames drawn in several browser tabs at once). Such items are made one
   * after another in a line of their own, so two never draw at once, and
   * nothing quick waits behind them (`jobs/lanes.ts`). Absent: made in the
   * line every other item shares.
   */
  readonly heavy?: boolean;
  /**
   * False when a blueprint saved on a job belongs to a way of making this
   * format no longer has (a maker taken out of Open Sourcebook); the output runner then
   * plans the item again instead of continuing it. Absent: every saved
   * blueprint is continued.
   */
  keepsBlueprint?(blueprint: unknown): boolean;
  /** Repair rounds for one saved blueprint, when they depend on it; falls back to `maxRepairRounds`. */
  repairRoundsFor?(blueprint: Blueprint): number | undefined;
  /** Turns an item's raw `settings_json` into typed settings with defaults. */
  parseSettings(raw: unknown): SettingsResult<Settings>;
  estimateCost(input: CostEstimateInput<Settings>): CostEstimate;
  /**
   * Why an item with these settings cannot be made right now, so the plan
   * can say it before Start (a maker that needs a service on this computer
   * that is not running). Each reason is words that follow the item's title,
   * with what to do. From what the format last heard; it never calls out.
   */
  itemIssues?(settings: Settings): string[];
  /**
   * What a person should know about an item with these settings before it is
   * made, though it can be made: each a line with what to do (a video that
   * will have no sound, and how to give it one). From what the format last
   * heard; it never calls out. Quiet: shown beside the item, never a reason
   * it cannot start.
   */
  itemNotices?(settings: Settings): string[];
  /** The same of a made output, from the thing itself (a video that has no sound, and why). */
  madeNotices?(payload: Payload): string[];
  /**
   * Why nothing of this format can be made on this computer now, whatever
   * an item's settings, in a sentence with what to do (audio with no voice
   * set up). From what the format last heard; it never calls out. A format
   * that says so is served `ready: false` with these words as `problem`,
   * is kept out of plans and makes nothing, and its command answers with
   * them. Undefined when it can be made.
   */
  unavailable?(): string | undefined;
  /**
   * Serves a payload stored at an older schema version in the current shape,
   * at read time; the stored row is never rewritten. Undefined when the
   * payload is already current or the format cannot read it.
   */
  upgrade?(payload: unknown, schemaVersion: number): StoredPayload | undefined;
  /**
   * A small look at a made output for lists (the Library, Home): a line of
   * what it says first and, when it has one, a picture or the video itself to
   * take a frame from. Each format decides what of its own payload shows.
   * Undefined when it has nothing to show beyond its title.
   */
  glimpse?(payload: Payload): Glimpse | undefined;
  /**
   * How big a made output is, in the format's own unit, for lists ("3 min",
   * "12 cards", "2 pages"): what was made, never what was asked for.
   * Undefined when the payload does not say (a video not rendered yet).
   */
  size?(payload: Payload): MadeSize | undefined;
  /**
   * What an item's settings leave open, decided now the way it would be
   * when the item is made (the maker it would get, that maker's default
   * look, a length from the size of its sources), so a planned item says
   * what it will be. Only the keys it decides; empty when nothing is open.
   */
  settle?(
    settings: Settings,
    input: { sourceChars: number; sourceCount: number; picks?: PicksByScope },
  ): Record<string, JsonValue>;
  /**
   * What an item with these settings will be, in a few short words a plan
   * row shows joined ("Drawn scenes", "Chalkboard", "about 8 min"), in the
   * format's own words. What the settings still leave open is said as such.
   */
  describe?(settings: Settings): string[];
  /**
   * What a made output of this item is, in the same few words as `describe`
   * but true of what was made ("18 cards", "6 questions of 8 planned"), so a
   * plan row and a player never say a size the thing does not have.
   */
  describeMade?(payload: Payload, settings: Settings): string[];
  /**
   * A spot in a made output, as its player reports where the person is
   * (the item's kept progress, in the player's own shape: a time, a bit, a
   * question and the answers given), said in words: a short `label` a
   * thread shows beside a message ("at 0:42", "question 3, you answered
   * B"), and the `facts` of that spot for the agent answering about it
   * (what is said and shown then, the question with its options and the
   * right answer). Undefined when the spot is not one this format can
   * read; a thread then keeps it as given, with no words of its own.
   */
  describeAnchor?(payload: Payload, at: JsonValue): AnchorWords | undefined;
  /**
   * Lays a change the person made by hand over a made output (a guide's
   * words, sections and points), from the whole thing as they now have it,
   * in the format's own shape: the payload to keep, its citations again and
   * its title, or what is wrong in plain sentences. Absent: the format is
   * not changed by hand, and `PUT /v1/outputs/:id/payload` refuses it.
   */
  edit?(payload: Payload, edited: unknown, now: string): EditResult<Payload>;
  /**
   * Making one scene of a made output again, the rest of it kept, as a new output (`POST /v1/outputs/:id/scenes/:scene/remake`).
   * Absent: the format remakes no part of what it made, and the route refuses it.
   */
  remakeScene?: SceneRemake<Payload>;
  /**
   * The folder on this computer a job of this format works in, opened in the file manager for the person
   * (`POST /v1/jobs/:id/files/show`). Absent: its jobs have no such folder, and the app offers none.
   */
  jobFiles?: JobFiles;
}

/** How a format opens the folder one of its jobs works in (`FormatDefinition.jobFiles`). */
export interface JobFiles {
  /** Whether a job with these settings (the job's own, unparsed) works in a folder on this computer that can be opened. */
  can(settings: unknown): boolean;
  /** Opens it: undefined once it is open, else why not in a sentence with what to do. */
  show(input: { jobId: string; settings: unknown; kept: Record<string, JsonValue>; signal?: AbortSignal }): Promise<string | undefined>;
}

/** How a format makes one scene of a made output again (`FormatDefinition.remakeScene`). */
export interface SceneRemake<Payload = unknown> {
  /** The ids of the scenes of this made output that can be made again; empty when this one cannot (its maker cannot). */
  scenes(payload: Payload): string[];
  /** Who made it (agent, model and effort), so its remake is made the same way unless the person names another. */
  madeWith?(payload: Payload): { agent: string; model?: string; effort?: string } | undefined;
  /**
   * Why that scene of it cannot be made again now, in a sentence with what to do (what it was made from is gone from
   * this computer, or the maker is not running), asked before anything starts; undefined when it can.
   */
  check(input: { payload: Payload; scene: string; madeBy?: string; kept: Record<string, JsonValue>; signal?: AbortSignal }): Promise<string | undefined>;
}

/** What `FormatDefinition.edit` answers. */
export type EditResult<Payload> = { ok: true; payload: Payload; citations: Citation[]; title: string } | { ok: false; problems: string[] };

/** A spot in a made output in words (`FormatDefinition.describeAnchor`). */
export interface AnchorWords {
  /** A few words a person reads beside a message about this spot, in lower case ("at 0:42"). */
  label: string;
  /** Plain lines of what is there, for the agent: each a fact, none an instruction. */
  facts: string[];
}

/** What a list shows of a made output besides its title (`FormatDefinition.glimpse`). */
export interface Glimpse {
  /** A line of what it says first, plain words. */
  text?: string;
  /** A picture, or a video whose frame the list shows. */
  media?: { kind: "image" | "video"; url: string };
}

/** How big a made output is (`FormatDefinition.size`): a list shows `${count} ${unit}`. */
export interface MadeSize {
  /** A whole number, except a guide's pages, which go by halves. */
  count: number;
  /** The unit as a list shows it after the count, already singular or plural to suit it ("card", "cards", "min"). */
  unit: string;
}

/** A payload with the schema version it is in. */
export interface StoredPayload {
  payload: unknown;
  schemaVersion: number;
}
