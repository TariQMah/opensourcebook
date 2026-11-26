/**
 * The video format's registry entry: descriptor, settings and cost estimate
 * (engine/docs/video.md; docs/DECISIONS.md #48, #54, #69).
 *
 * The format's engine is a dispatcher over the video makers the engine is
 * given (makers.ts). The estimate and the repair rounds are the picked
 * maker's. With no maker set up, video is not registered at all: it stays
 * declared and is never made by anything else.
 *
 * Settings say how long, what shape, which maker and which of its styles
 * (the last two left open unless the item picks). What the video is about, what kinds
 * of scene and picture it uses and how many scenes it has come from the
 * brief and the sources, never from a setting.
 */
import type {
  Glimpse,
  FormatDefinition,
  FormatDescriptor,
  JsonValue,
  PicksByScope,
  SettingField,
  SettingOption,
  SettingsResult,
  ValidationIssue,
} from "../../studio/types";
import { plainLine } from "../../studio/glimpse";
import { playingSize } from "../../studio/size";
import { AUTO_LENGTH_KEY } from "../../studio/timing";
import {
  AGENT_SETTING_KEYS,
  agentField,
  agentPickOf,
  readAgentFields,
  readReviewerFields,
  REVIEWER_SETTING_KEYS,
  reviewerField,
  settleAgentPick,
  settleReviewerPick,
} from "../agent-fields";
import { videoAnchor } from "./anchor";
import { ASPECT_NAMES, VIDEO_LIMITS, type AspectName, type Video } from "../../video/contract";
import { OPEN_MAKER_LABEL, openMakerWords } from "../makers";
import { OPEN_PICK, VideoMakerRegistry, VideoMakersEngine, type MadeBlueprint, type VideoMaker } from "./makers";

export interface VideoSettings {
  /** Target length; 0 lets the brief and the sources decide. */
  minutes: number;
  /** The length `settle` filled in for minutes left on Auto (0), so its time is kept under "auto" (studio/timing.ts). */
  autoLength?: number;
  aspect: AspectName;
  /** The maker's id, or "auto" (absent) for the one Open Sourcebook picks (makers.ts). */
  maker?: string;
  /** One of the maker's styles, or "auto" (absent) for the maker's own pick. */
  style?: string;
  /** Agent/model pick ("agent", "agent:<provider>", or "agent:<provider>:<model>"); absent/"auto" uses the maker's default. */
  agent?: string;
  /** Thinking effort for the picked agent; absent/"auto" uses the work default. */
  effort?: string;
  /** Who reads the made video fresh: "auto" (the default: on, with the video's own pick), "off", or a pick id (agent-fields.ts). */
  reviewer?: string;
  /** That reviewer's thinking effort; "auto" or absent for its default. */
  reviewEffort?: string;
}

export interface VideoDefinitionOptions {
  /** The makers, in the order the form lists them. */
  makers: VideoMaker[];
  /** The maker "auto" picks (VIDEO_MAKER_DEFAULT); the first registered when absent or unknown. */
  defaultMaker?: string;
}

/**
 * Makers Open Sourcebook had and took out (DECISIONS #69): the storyboard maker, which
 * made white frames with each scene's plan written on them. An item that
 * still names one is made by the maker "auto" picks, and a job one of
 * them planned is planned again by it; nothing is made by a maker that is
 * gone. A maker that is only switched off here (a local service not running)
 * is not in this list: an item asking for it says so instead.
 */
export const RETIRED_VIDEO_MAKERS: readonly string[] = ["storyboard"];

export type VideoDefinition = FormatDefinition<VideoSettings, MadeBlueprint, Video>;

/** Each frame shape in words. */
const ASPECT_OPTIONS: Record<AspectName, Omit<SettingOption, "value">> = {
  portrait: { label: "Portrait (9:16)", description: "Tall, for a phone held upright. Open Sourcebook videos are this shape unless asked otherwise." },
  landscape: { label: "Landscape (16:9)", description: "Wide, for a screen or a phone turned on its side." },
  square: { label: "Square (1:1)", description: "As wide as it is tall." },
};

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = { minutes: 0, aspect: "portrait" };

/** Reads the concrete agent, model, and effort from video settings (ignoring open/"auto" values); agent-fields.ts. */
export function parseVideoAgent(settings: Pick<VideoSettings, "agent" | "effort">): { agent?: string; model?: string; effort?: string } {
  return agentPickOf(settings);
}

function isPickId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

/** The descriptor clients and the planner read, built from the makers registered now. */
export function videoDescriptor(makers?: VideoMakerRegistry): FormatDescriptor {
  return {
    id: "video",
    label: "video",
    plural: "videos",
    colorSlot: 1,
    icon: "play",
    about: `Something to watch: a tall 9:16 reel with nothing sideways, scenes with what is seen and what is said, grounded in the sources. Suits what is clearer seen than read: a process or a change over time, a structure or a shape, a picture or a derivation built up piece by piece, an idea explained the way a good teacher would at a board. Its length sets how far it goes, from under a minute on one idea to many minutes teaching a whole topic thoroughly.${madeHere(makers)}`,
    blurb: "an explainer to watch, drawn scene by scene",
    settings: [
      {
        key: "minutes",
        label: "Length",
        help: "Target length in minutes, which is how far it goes: under a minute for one idea, ten or more for a thorough lesson.",
        kind: "number",
        min: 0,
        max: VIDEO_LIMITS.maxMinutes,
        step: 0.5,
        unit: "min",
        specialValues: [{ value: 0, means: "auto", label: "Fit to the brief", description: "Timed when it is made, as long as the brief and the sources need." }],
      },
      { key: "aspect", label: "Shape", kind: "choice", options: ASPECT_NAMES.map((value) => ({ value, ...ASPECT_OPTIONS[value] })) },
      ...makerAndAgentFields(makers),
    ],
    defaults: { ...DEFAULT_VIDEO_SETTINGS, ...makerDefaults(makers) },
    // Making times are kept apart by length (engine/docs/api.md, "Making times"); it is spoken by the computer's voice.
    timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] },
    voiced: true,
  };
}

/**
 * The maker and style settings, from the makers themselves. The maker is
 * offered only when there is more than one; the style only when some maker
 * has styles, and then only while the maker picked (or the one Open Sourcebook picks)
 * is one that has them. Both start open ("auto").
 */
function makerFields(makers: VideoMakerRegistry | undefined): SettingField[] {
  const list = makers?.list() ?? [];
  const fields: SettingField[] = [];
  const fallback = makers?.default();
  if (list.length > 1 && fallback) {
    fields.push({
      key: "maker",
      label: "Maker",
      help: "What makes the video.",
      kind: "choice",
      options: [
        { value: OPEN_PICK, label: OPEN_MAKER_LABEL, description: openMakerWords(fallback.label) },
        ...list.map((maker) => ({ value: maker.id, label: maker.label, description: maker.description })),
      ],
    });
  }
  const styled = list.filter((maker) => maker.styles().length > 0);
  if (styled.length === 0) return fields;
  const options = new Map<string, SettingOption>();
  for (const maker of styled) {
    for (const style of maker.styles()) {
      if (!options.has(style.id)) options.set(style.id, { value: style.id, label: style.label, description: style.description, ...(style.preview ? { preview: style.preview } : {}) });
    }
  }
  const when = [...(fallback && styled.includes(fallback) ? [OPEN_PICK] : []), ...styled.map((maker) => maker.id)];
  fields.push({
    key: "style",
    label: "Style",
    help: "How the video looks.",
    kind: "choice",
    options: [{ value: OPEN_PICK, label: "Maker's pick", description: "The maker picks the look that suits the brief and the sources when it makes it." }, ...options.values()],
    ...(list.length > 1 ? { showWhen: { key: "maker", in: when } } : {}),
  });
  return fields;
}

function makerAndAgentFields(makers: VideoMakerRegistry | undefined): SettingField[] {
  const list = makers?.list() ?? [];
  const fields = makerFields(makers);
  const agentMakers = list.filter((maker) => maker.usesAgent === true);
  if (agentMakers.length > 0) {
    const fallback = makers?.default();
    const when = [...(fallback && agentMakers.includes(fallback) ? [OPEN_PICK] : []), ...agentMakers.map((maker) => maker.id)];
    const showWhen = list.length > 1 && agentMakers.length < list.length ? { key: "maker", in: when } : undefined;
    fields.push(agentField("work", showWhen, "Which agent, model, and thinking effort write and check the video."));
    // The agent's makers have a fresh viewer read the drawn video once (docs/DECISIONS.md #106): who that is, or off.
    fields.push(reviewerField("work", showWhen, "Which agent, model, and thinking effort watch the finished video fresh and say what to fix, or off. Auto is the video's own."));
  }
  return fields;
}

function makerDefaults(makers: VideoMakerRegistry | undefined): Record<string, JsonValue> {
  const keys = makerFields(makers).map((field) => field.key);
  return Object.fromEntries(keys.map((key) => [key, OPEN_PICK]));
}

/** Why an item with these settings cannot be made now: its maker is not set up, or says it cannot. */
function makerIssues(makers: VideoMakerRegistry, settings: VideoSettings): string[] {
  const resolved = makers.resolve(settings);
  if ("missing" in resolved) {
    return resolved.missing === OPEN_PICK ? ["no video maker is set up here"] : [`its maker "${resolved.missing}" is not set up here: pick another maker`];
  }
  return resolved.maker.issues?.(settings) ?? [];
}

/**
 * What a video item leaves open, decided as it would be now: the maker an
 * open pick gets, that maker's default look when it has looks, and a length
 * from the size of the sources (the same guess the estimate makes).
 */
function settleVideo(
  makers: VideoMakerRegistry,
  settings: VideoSettings,
  sourceChars: number,
  picks?: PicksByScope,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const resolved = makers.resolve(settings);
  if (!("maker" in resolved)) return out;
  const { maker } = resolved;
  if (!settings.maker || settings.maker === OPEN_PICK) out.maker = maker.id;
  const styles = maker.styles();
  if (styles.length > 0 && (!settings.style || settings.style === OPEN_PICK)) {
    const style = maker.defaultStyle?.() ?? styles[0]!.id;
    if (styles.some((known) => known.id === style)) out.style = style;
  }
  if (maker.usesAgent) Object.assign(out, settleAgentPick("video", settings, picks), settleReviewerPick("video", settings, picks));
  if (settings.minutes === 0 && sourceChars > 0) out.minutes = Math.max(0.5, Math.round(guessedSeconds(sourceChars) / 30) / 2);
  return out;
}

/** A video item in a few words: who makes it, its look, how long. */
function describeVideo(makers: VideoMakerRegistry, settings: VideoSettings): string[] {
  const resolved = makers.resolve(settings);
  if (!("maker" in resolved)) return ["No video maker set up here"];
  const { maker } = resolved;
  const words = [maker.label];
  const styles = maker.styles();
  if (styles.length > 0) words.push(styles.find((style) => style.id === settings.style)?.label ?? "Look fits the brief");
  words.push(settings.minutes > 0 ? `about ${minutesText(settings.minutes)}` : "Length fits the brief");
  return words;
}

/**
 * A length from the size of the sources when nobody set one: a short explainer watched on a phone, a minute for a
 * short source and a little more for each further 600 characters, at most three minutes (a 1,500-word paper comes to
 * about 75 seconds, a long chapter to three minutes). A default for "nothing said", not a limit: a longer video is
 * one the person asks for, and the planner sets it.
 */
export function guessedSeconds(sourceChars: number): number {
  return Math.min(180, Math.max(60, Math.round(60 + sourceChars / 600)));
}

/** 8 min, 1 h 30 min, 30 s. */
function minutesText(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} s`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes - hours * 60) * 2) / 2;
  return hours > 0 ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${rest} min`;
}

/** The sentence on how this engine makes videos: the one maker's own words, or that there are several. */
function madeHere(makers: VideoMakerRegistry | undefined): string {
  const list = makers?.list() ?? [];
  if (list.length === 0) return "";
  if (list.length === 1) return ` Made here as ${list[0]!.about}.`;
  return ` Made here by one of ${list.length} makers; each video can pick its maker.`;
}

/** The makers an engine has, in the order given. */
export function videoMakers(options: VideoDefinitionOptions): VideoMakerRegistry {
  const registry = new VideoMakerRegistry(options.defaultMaker);
  for (const maker of options.makers) registry.register(maker);
  return registry;
}

export function createVideoDefinition(options: VideoDefinitionOptions): VideoDefinition {
  return videoDefinitionFor(videoMakers(options));
}

/** The video format over a maker registry: every step, the estimate and the repair rounds are the picked maker's. */
export function videoDefinitionFor(makers: VideoMakerRegistry): VideoDefinition {
  const engine = new VideoMakersEngine(makers);
  return {
    descriptor: videoDescriptor(makers),
    engine,
    maxRepairRounds: Math.max(0, ...makers.list().map((maker) => maker.maxRepairRounds)),
    // A maker on this computer draws every frame here, in several browser tabs at once: one video at a time.
    ...(makers.list().some((maker) => maker.local) ? { heavy: true } : {}),
    repairRoundsFor: (blueprint) => engine.repairRounds(blueprint),
    keepsBlueprint: (blueprint) => engine.keeps(blueprint, RETIRED_VIDEO_MAKERS),
    parseSettings: parseVideoSettings,
    itemIssues: (settings) => makerIssues(makers, settings),
    madeNotices: (video) => (video.render && !video.render.storyboard && video.render.audio === false ? [video.render.maker?.voice?.note ?? "This video was made without sound; its captions carry the words."] : []),
    itemNotices: (settings) => {
      const resolved = makers.resolve(settings);
      return "maker" in resolved ? (resolved.maker.notices?.(settings) ?? []) : [];
    },
    settle: (settings, input) => settleVideo(makers, settings, input.sourceChars, input.picks),
    describe: (settings) => describeVideo(makers, settings),
    glimpse: videoGlimpse,
    // How long its file plays, end card included; not said before it is rendered.
    size: (video) => playingSize(video?.render?.durationMs),
    describeAnchor: videoAnchor,
    remakeScene: {
      // Only a video whose maker can make one of its scenes again, the rest kept: today the one that drew it.
      scenes: (video) => (remakerOf(makers, video) ? (video.scenes ?? []).map((scene) => scene.id) : []),
      madeWith: (video) => {
        const agent = video?.render?.maker?.agent;
        return agent?.id ? { agent: agent.id, ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) } : undefined;
      },
      check: async ({ payload, scene, madeBy, kept, signal }) => {
        const maker = remakerOf(makers, payload);
        if (!maker?.remakesScene) return "A scene of this video can't be made again: the way it was made has no way to.";
        return maker.remakesScene.check({ scene, ...(madeBy ? { madeBy } : {}), kept, ...(signal ? { signal } : {}) });
      },
    },
    jobFiles: {
      can: (settings) => !!filesMakerOf(makers, settings),
      show: async ({ jobId, settings, kept, signal }) => {
        const maker = filesMakerOf(makers, settings);
        if (!maker?.showsFiles) return "This video has no files on this computer to show.";
        return maker.showsFiles({ jobId, kept, ...(signal ? { signal } : {}) });
      },
    },
    estimateCost: (input) => {
      const resolved = makers.resolve(input.settings);
      if ("missing" in resolved) return { unpriced: true, basis: `video maker "${resolved.missing}" is not set up here` };
      return resolved.maker.estimateCost(input);
    },
  };
}

/** The maker a job with these settings is made by, when it makes it in a folder on this computer that can be opened. */
function filesMakerOf(makers: VideoMakerRegistry, raw: unknown): VideoMaker | undefined {
  const parsed = parseVideoSettings(raw);
  const resolved = parsed.ok ? makers.resolve(parsed.settings) : undefined;
  return resolved && "maker" in resolved && resolved.maker.showsFiles ? resolved.maker : undefined;
}

/** The maker that made a video, when it can make one of its scenes again. */
function remakerOf(makers: VideoMakerRegistry, video: Video | undefined): VideoMaker | undefined {
  const by = video?.render?.by;
  const maker = typeof by === "string" && !video?.render?.storyboard ? makers.get(by) : undefined;
  return maker?.remakesScene ? maker : undefined;
}

const PICK_KEYS = ["maker", "style"] as const;
const MARK_KEYS: readonly string[] = [AUTO_LENGTH_KEY];

export function parseVideoSettings(raw: unknown): SettingsResult<VideoSettings> {
  const settings: VideoSettings = { ...DEFAULT_VIDEO_SETTINGS };
  if (raw === undefined || raw === null) return { ok: true, settings };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: [issue("$", "type", "Settings must be an object")] };
  const record = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!(key in settings) && !(PICK_KEYS as readonly string[]).includes(key) && !MARK_KEYS.includes(key) && !AGENT_SETTING_KEYS.includes(key) && !REVIEWER_SETTING_KEYS.includes(key)) {
      issues.push(issue(`$.${key}`, "unknown_key", `Unknown setting "${key}"`));
    }
  }
  // A maker or a style is checked by shape only: one that is not set up here
  // now (a local service off, a style taken away) is said before Start and
  // when the item runs, never by refusing the stored item.
  for (const key of PICK_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    // A maker Open Sourcebook took out reads as "auto" (the stored row is not rewritten).
    if (key === "maker" && typeof value === "string" && RETIRED_VIDEO_MAKERS.includes(value)) continue;
    if (value === OPEN_PICK || isPickId(value)) settings[key] = value as string;
    else issues.push(issue(`$.${key}`, "format", `${key} must be "${OPEN_PICK}" or an id of lowercase letters, digits and dashes`));
  }
  Object.assign(settings, readAgentFields(record, issues), readReviewerFields(record, issues));
  if (record.minutes !== undefined) {
    const value = record.minutes;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= VIDEO_LIMITS.maxMinutes) settings.minutes = value;
    else issues.push(issue("$.minutes", "range", `minutes must be a number from 0 to ${VIDEO_LIMITS.maxMinutes}`));
  }
  const autoLength = record[AUTO_LENGTH_KEY];
  if (typeof autoLength === "number" && Number.isFinite(autoLength) && autoLength > 0) settings.autoLength = autoLength;
  if (record.aspect !== undefined) {
    if (typeof record.aspect === "string" && (ASPECT_NAMES as string[]).includes(record.aspect)) settings.aspect = record.aspect as AspectName;
    else issues.push(issue("$.aspect", "enum", `aspect must be one of ${ASPECT_NAMES.join(", ")}`));
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings };
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}

/** A video's glimpse: the one idea it carries, and its file, so a list can show a frame from it. */
export function videoGlimpse(video: Video): Glimpse | undefined {
  const text = plainLine(video?.idea);
  const url = video?.render?.url;
  const media = typeof url === "string" && url ? { kind: "video" as const, url } : undefined;
  return text || media ? { ...(text ? { text } : {}), ...(media ? { media } : {}) } : undefined;
}
