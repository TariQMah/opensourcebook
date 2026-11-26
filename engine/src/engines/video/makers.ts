/**
 * Video makers (docs/DECISIONS.md #33, #37, #54): what makes a video. Open Sourcebook has
 * one video shape; a maker is one way of making it. Each maker brings its
 * own engine (plan, generate, validate, repair, produce), its words for the
 * form and the planner, its styles if it has any, and its cost estimate.
 * The video format's engine is a dispatcher over this registry: it picks the
 * maker an item asks for (or the default one when the item leaves it to
 * Open Sourcebook), records the pick in the blueprint saved on the job, and runs that
 * maker's steps. A retry or a redelivery reads the pick back, so it makes
 * the same thing.
 *
 * Nothing outside a maker's own module names it: the registry, the
 * dispatcher, the settings and the routes read makers from here.
 */
import type {
  CostEstimate,
  CostEstimateInput,
  EngineContext,
  EngineOutput,
  JsonValue,
  OutputEngine,
  ValidationReport,
} from "../../studio/types";
import { VIDEO_SCHEMA_VERSION, type Video } from "../../video/contract";
import { JobFailure } from "../../jobs/lifecycle";
import type { VideoSettings } from "./definition";

/** One look a maker can give its video, from the maker itself. */
export interface VideoMakerStyle {
  id: string;
  label: string;
  /** One plain line on what it looks like and when it suits. */
  description: string;
  /** A path the clients can load a picture of it from (`GET /v1/video-makers/...`). */
  preview?: string;
}

/** Whether a maker can make videos right now, for Settings and before Start. */
export interface VideoMakerStatus {
  /** True when everything it needs answers. */
  available: boolean;
  /** Why not, in plain words with what to do, when it is not. */
  problem?: string;
  /** Who writes for it, when someone does (the person's own agent). */
  agent?: { id?: string; label?: string; model?: string; effort?: string };
  /** What to know before making a video with it, though it can: a line with what to do (no voice key, so no sound). */
  notice?: string;
}

export interface VideoMaker<Blueprint = unknown> {
  /** Stored in an item's `maker` setting and on the job. Lowercase letters, digits and dashes. */
  readonly id: string;
  /** Short, as the form shows it. */
  readonly label: string;
  /** What it makes, how long it takes and what it needs, for the form and for the planner. */
  readonly description: string;
  /** The clause after "Made here as" in the format's `about`, when it is the only maker. */
  readonly about: string;
  /** True when it works only on the person's computer (a local service), never on the hosted engine. */
  readonly local?: boolean;
  /** True when this maker uses the person's local agent (so the video form offers agent, model, and effort selection). */
  readonly usesAgent?: boolean;
  readonly engine: OutputEngine<VideoSettings, Blueprint, Video>;
  readonly maxRepairRounds: number;
  /** Its styles, read each time a descriptor is built; empty when it has none. */
  styles(): VideoMakerStyle[];
  /** The style it uses when an item leaves the look open and its own way of picking says none; its first style when absent. */
  defaultStyle?(): string | undefined;
  /** The agent, model, and effort it uses by default for work turns, when known. */
  defaultAgent?(): { agent?: string; model?: string; effort?: string } | undefined;
  estimateCost(input: CostEstimateInput<VideoSettings>): CostEstimate;
  /**
   * Why it cannot make an item with these settings right now, each in words
   * that follow the item's title ("needs ... : start it, or pick another
   * maker"). From what it last heard; it does not call out. Empty when it can.
   */
  issues?(settings: VideoSettings): string[];
  /**
   * What a person should know about a video with these settings before it is made, though it can be made: each a
   * line with what to do (it will have no sound, and how to give it one). From what it last heard; it does not call
   * out. Empty when there is nothing to say.
   */
  notices?(settings: VideoSettings): string[];
  /** Asks what it needs whether it is there now. Absent: always available. */
  status?(signal?: AbortSignal): Promise<VideoMakerStatus>;
  /** A picture of one of its styles, or undefined when it has none for that id. */
  preview?(styleId: string, signal?: AbortSignal): Promise<Response | undefined>;
  /**
   * When it can make one scene of a video it made again, the rest kept (its engine reads `EngineContext.remakeOf`):
   * why that scene cannot be made again now, asked before a job starts, or undefined when it can. Absent: it cannot.
   */
  remakesScene?: {
    check(input: { scene: string; madeBy?: string; kept: Record<string, JsonValue>; signal?: AbortSignal }): Promise<string | undefined>;
  };
  /**
   * When it makes a video in a folder on this computer: opens a job's folder in the file manager, from the job's id and
   * what it kept on the job; undefined once open, else why not. Absent: its videos have no folder to open.
   */
  showsFiles?(input: { jobId: string; kept: Record<string, JsonValue>; signal?: AbortSignal }): Promise<string | undefined>;
}

/** The value of `maker` and `style` that leaves the pick to Open Sourcebook. */
export const OPEN_PICK = "auto";

const MAKER_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export function isMakerId(value: unknown): value is string {
  return typeof value === "string" && MAKER_ID_PATTERN.test(value);
}

export class VideoMakerRegistry {
  private readonly makers = new Map<string, VideoMaker>();
  private wantedDefault?: string;

  /** `defaultId`: the maker "auto" picks; the first one registered when absent or unknown. */
  constructor(defaultId?: string) {
    if (defaultId?.trim()) this.wantedDefault = defaultId.trim();
  }

  register(maker: VideoMaker): this {
    if (!isMakerId(maker.id) || maker.id === OPEN_PICK) throw new Error(`"${maker.id}" is not a valid video maker id.`);
    if (this.makers.has(maker.id)) throw new Error(`Video maker "${maker.id}" is already registered.`);
    if (!maker.label.trim() || !maker.description.trim()) throw new Error(`Video maker "${maker.id}" needs a label and a description.`);
    this.makers.set(maker.id, maker as VideoMaker);
    return this;
  }

  get(id: string): VideoMaker | undefined {
    return this.makers.get(id);
  }

  list(): VideoMaker[] {
    return [...this.makers.values()];
  }

  get size(): number {
    return this.makers.size;
  }

  /** The maker "auto" picks now. */
  default(): VideoMaker | undefined {
    return (this.wantedDefault ? this.makers.get(this.wantedDefault) : undefined) ?? this.list()[0];
  }

  /** True when the default was asked for by id and no maker has that id. */
  get defaultMissing(): string | undefined {
    return this.wantedDefault && !this.makers.has(this.wantedDefault) ? this.wantedDefault : undefined;
  }

  /** The maker an item's settings ask for: theirs, or the default when they leave it to Open Sourcebook. */
  resolve(settings: Pick<VideoSettings, "maker">): { maker: VideoMaker } | { missing: string } {
    const wanted = settings.maker && settings.maker !== OPEN_PICK ? settings.maker : undefined;
    if (wanted) {
      const maker = this.makers.get(wanted);
      return maker ? { maker } : { missing: wanted };
    }
    const fallback = this.default();
    return fallback ? { maker: fallback } : { missing: OPEN_PICK };
  }
}

/** What the dispatcher saves on the job: the maker it picked, and that maker's own blueprint. */
export interface MadeBlueprint {
  maker: string;
  made: unknown;
}

/** The video format's engine: every step is the picked maker's. */
export class VideoMakersEngine implements OutputEngine<VideoSettings, MadeBlueprint, Video> {
  readonly type = "video";
  readonly schemaVersion = VIDEO_SCHEMA_VERSION;

  constructor(readonly makers: VideoMakerRegistry) {}

  async plan(ctx: EngineContext<VideoSettings>): Promise<MadeBlueprint> {
    const maker = this.pick(ctx.node.settings);
    const made = await maker.engine.plan(this.forMaker(ctx, maker));
    return { maker: maker.id, made };
  }

  async generate(ctx: EngineContext<VideoSettings>, blueprint: MadeBlueprint): Promise<EngineOutput<Video>> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.generate(this.forMaker(ctx, maker), made);
  }

  async validate(ctx: EngineContext<VideoSettings>, output: EngineOutput<Video>, blueprint: MadeBlueprint): Promise<ValidationReport> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.validate(this.forMaker(ctx, maker), output, made);
  }

  async repair(ctx: EngineContext<VideoSettings>, output: EngineOutput<Video>, report: ValidationReport, blueprint: MadeBlueprint): Promise<EngineOutput<Video>> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.repair(this.forMaker(ctx, maker), output, report, made);
  }

  async produce(ctx: EngineContext<VideoSettings>, output: EngineOutput<Video>, blueprint: MadeBlueprint): Promise<EngineOutput<Video>> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.produce ? maker.engine.produce(this.forMaker(ctx, maker), output, made) : output;
  }

  /** Repair rounds for the maker a blueprint names. */
  repairRounds(blueprint: MadeBlueprint): number | undefined {
    return this.found(blueprint)?.maker.maxRepairRounds;
  }

  /**
   * False for a saved blueprint no maker here can continue because the way
   * of making it is gone: one saved before makers existed (it was the
   * storyboard maker's), or one naming a maker in `retired`. The item is
   * then planned again by the maker it resolves to now.
   */
  keeps(blueprint: unknown, retired: readonly string[]): boolean {
    return isMadeBlueprint(blueprint) && !retired.includes(blueprint.maker);
  }

  private pick(settings: VideoSettings): VideoMaker {
    const resolved = this.makers.resolve(settings);
    if ("missing" in resolved) throw missingMaker(resolved.missing);
    return resolved.maker;
  }

  private saved(blueprint: MadeBlueprint): { maker: VideoMaker; made: unknown } {
    const found = this.found(blueprint);
    if (!found) throw missingMaker(isMadeBlueprint(blueprint) ? blueprint.maker : OPEN_PICK);
    return found;
  }

  /** The maker a saved blueprint names. */
  private found(blueprint: MadeBlueprint): { maker: VideoMaker; made: unknown } | undefined {
    if (!isMadeBlueprint(blueprint)) return undefined;
    const maker = this.makers.get(blueprint.maker);
    return maker ? { maker, made: blueprint.made } : undefined;
  }

  /** The item's settings with the pick filled in, so a maker never has to resolve "auto" for the maker. */
  private forMaker(ctx: EngineContext<VideoSettings>, maker: VideoMaker): EngineContext<VideoSettings> {
    if (ctx.node.settings.maker === maker.id) return ctx;
    return { ...ctx, node: { ...ctx.node, settings: { ...ctx.node.settings, maker: maker.id } } };
  }
}

function isMadeBlueprint(value: unknown): value is MadeBlueprint {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { maker?: unknown }).maker === "string" && "made" in value;
}

/** A stored item whose maker is not set up here fails with that said, never as another maker. */
export function missingMaker(id: string): JobFailure {
  return id === OPEN_PICK
    ? new JobFailure("No video maker is set up on this engine.", false, "no_production")
    : new JobFailure(`Video maker "${id}" is not set up on this engine.`, false, "maker_missing");
}
