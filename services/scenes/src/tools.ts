/**
 * The agent's tools for making one video: read the passages, read a skill, write a beat (its words and its scene, with
 * the specs of the things it draws as themselves), look at a beat, render the real video and watch it, place the
 * sound, and finish. Each takes what the agent sends and the job's draft, does the work in code, and answers in plain words (and
 * pictures, for look and watch). What they say back is measured, never a verdict: how the video is made is the
 * agent's call. The draft is the job's state; it is saved after every change, so a revise round starts from it.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { leansText } from "../engine/language/author.ts";
import { answerDepiction, emptyToolbox, wantedIn, type Toolbox, type Wanted } from "../engine/language/toolbox.ts";
import type { PropSpec } from "../engine/design/depict/spec.ts";
import { themeFrom } from "../engine/render/theme.ts";
import { kitKinds } from "../pipeline/stages/scene.ts";
import { readSkill, skillFiles, skills } from "./skills.ts";
import { forVideo } from "./prompt.ts";
import { currentCut, cutKey, makeCut, momentOf, phoneSheets, PHONE_TILE, sheetOf, timesOver, type Cut, type CutResult } from "./cut.ts";
import { VIEWER, clock, motionOf, observe, reportText, sampleScenes, silencesOf, type Facts, type Report } from "./report.ts";
import { readFileSync } from "node:fs";
import { spokenAs, speakBeats, type Timed } from "./beats.ts";
export { segmentsOf } from "./beats.ts";
import { renderStills } from "../pipeline/stages/scene.ts";
import type { Scene } from "../engine/core/types.ts";
import { checkScene, FIXED, withPauses, type Script } from "./script.ts";
import { buildScene, forStills, jpegBase64, lookAt, stillsFolder, stripOf, type SceneContext, type SceneTiming } from "./scene.ts";
import type { VideoRequest } from "./request.ts";
import type { Style } from "./styles.ts";
import { estimate, voiceDownOf, type Segment, type Voice, type VoiceDown, type VoiceTrouble } from "./voice.ts";
import { EFFECT_GAP, EFFECT_LEVELS, KIT, kitText, MUSIC_LEVELS, type SoundPlan } from "./sound.ts";
import type { Toolbox as PictureToolbox } from "./toolbox/index.ts";
import type { Pictures } from "./toolbox/assets.ts";
import { boxTools, BOX_TOOLS } from "./toolbox/tools.ts";
import { SHELF_TOOLS, nearestPieceLines, sheetImage, shelfForIdea } from "./shelf-tools.ts";
import { shelf } from "./shelf.ts";
import { FACTS_HEAD, emptyMaking, noteCall, piecesIn, reviewSummary, seenByCut, withDefaults, type Making, type MakingLog, type Seen } from "./making.ts";
import type { ReviewRecord } from "./review.ts";

export interface SceneDraft {
  source?: string;
  /** The source builds on the scene's current timing. */
  built: boolean;
  /** Stills were looked at since the source last changed. */
  looked: boolean;
  /** What the last build measured that a viewer would notice (a subset of open). */
  serious?: string[];
  writes: number;
  looks: number;
  /** What the last build said is worth fixing. */
  open?: string[];
}

export interface Draft {
  script?: Script;
  style?: string;
  scenes: Record<string, SceneDraft>;
  /** Word times per scene, from the voice when it is quick, else estimated; keyed by the narration they time. */
  timings: Record<string, Timed>;
  finished?: { note?: string };
  /** The music and effects the agent placed with the sound tool; none chosen yet when undefined. */
  sound?: SoundPlan;
  /** Why the narration is shorter than the length asked for, when the agent says so. */
  short?: string;
  /** How many times the agent watched the whole video back. */
  watched?: number;
  /** The number of the last cut the agent saw (watch of the render, or its viewer report). */
  seenCut?: number;
  /** The number of the last cut the agent watched with watch (a render, not the builds). */
  watchedCut?: number;
  /** The last viewer report the agent read: of which cut, how many things it listed, and the scenes as they were then. */
  report?: { cut: number; things: number; scenes: string };
  /** The viewer report findings shown by render itself: of which cut, how many actionable things it listed, and the scenes as they were then. */
  renderReport?: { cut: number; things: number; scenes: string };
  /** finish answered once with the steps Open Sourcebook's record shows were skipped; the next finish goes through. */
  finishAnswered?: boolean;
  /** How the video is being made, call by call, as Open Sourcebook answered them (src/making.ts). */
  made?: MakingLog;
  /** The things drawn as themselves, with the specs the agent answered as the depicter; shared by every scene. */
  toolbox?: Toolbox;
  toolCalls: number;
  /** The pictures the toolbox showed the agent and the ones it kept for the video. */
  pictures?: Pictures;
  /** The last real video rendered while the agent worked (render), and what it was made from. */
  cut?: Cut;
  /**
   * The voice could not speak, for a reason trying again will not fix (src/voice.ts `VoiceDown`): the beats are timed
   * by the estimate from then on, and the video waits for the voice when the writing ends. Cleared when it is carried on.
   */
  voiceDown?: { trouble: VoiceTrouble; message: string; at: string };
  /** The beat whose answer carried the picture of the whole shelf, the first time a beat's picture was only words and plain shapes. */
  shelfShown?: string;
  /** The fresh viewer's one round on this video (src/review.ts): set once it starts, so it never runs twice. */
  review?: ReviewRecord;
  /**
   * How many beats the video had when it was last put together whole (a render, or finish): the total a step may say
   * ("scene 2 of 4"). Beats are written one at a time, so until then the total is not known; adding or removing a
   * beat makes it unknown again.
   */
  sceneCount?: number;
}

export const emptyDraft = (): Draft => ({ scenes: {}, timings: {}, toolCalls: 0 });

export interface ToolContext {
  request: VideoRequest;
  draft: Draft;
  folder: string;
  styles: Style[];
  voice: Voice;
  /** A plain-words step for the person, e.g. "Writing scene 2 of 5". */
  step(label: string): void;
  save(): void;
  signal?: AbortSignal;
  /** What the agent can reach beyond the scene language; none means only the video tools. */
  toolbox?: PictureToolbox;
}

export interface ToolAnswer {
  text: string;
  isError?: boolean;
  images?: { mimeType: string; dataBase64: string }[];
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolAnswer>;
}

const run = promisify(execFile);
const fail = (text: string): ToolAnswer => ({ text, isError: true });

/**
 * The voice could not speak for a reason trying again will not fix: kept on the draft, so Open Sourcebook stops asking it for this
 * video, and the words the agent reads once, as a fact: why, that trying again will not help, and what happens next.
 */
export function voiceWentDown(ctx: ToolContext, down: VoiceDown): string {
  ctx.draft.voiceDown = { trouble: down.trouble, message: down.message, at: new Date().toISOString() };
  ctx.save();
  return [
    `The voice cannot speak: ${down.message.replace(/\.+$/, "")}. Trying again will not help, so Open Sourcebook has stopped asking it for this video; nothing you wrote is lost.`,
    "From now on every beat is timed by the estimate and its scene builds on those times: keep writing and building the video as you would, and judge the beats with look. render needs the voice, so it cannot run until the voice is back.",
    "When you finish, the video waits for the voice and the person is told why. Once the voice is back, Open Sourcebook voices it, builds every scene again on the real word times and renders it (you may be asked to fix a scene that no longer fits them); or the person may choose to finish it without sound, with captions carrying the words.",
  ].join("\n");
}

/** What a tool that needs the voice answers once it is out (the agent was told why when it went). */
const voiceOut = (ctx: ToolContext) =>
  `The voice cannot speak for now (${ctx.draft.voiceDown!.message.replace(/\.+$/, "")}), so no render can be made. Keep writing and building beats; finish when they are ready, and the video waits for the voice.`;

/**
 * How the spoken length sits against the length asked for, in words the agent weighs: never a refusal. The person
 * asked for about that long; what the passages support and what the video needs decide.
 */
export function lengthNote(seconds: number, target: number, words: number): string {
  const perSecond = words / Math.max(1, seconds);
  const off = Math.round((seconds - target) * perSecond);
  const spoken = `The narration comes to ${Math.round(seconds)} s; about ${Math.round(target)} s was asked for`;
  if (Math.abs(seconds - target) <= target * 0.1) return `${spoken}.`;
  const share = Math.round((Math.abs(seconds - target) / target) * 100);
  if (off > 0) return `${spoken}: ${share}% longer, about ${off} words more than that length at this voice's pace (${perSecond.toFixed(1)} words a second).`;
  return `${spoken}: ${share}% shorter, about ${-off} words fewer than that length at this voice's pace (${perSecond.toFixed(1)} words a second). If it is shorter because the passages say too little, say so in short and the person is told.`;
}

/** The beats whose voice is out of date: their words or pauses changed, or the voice sounds different for this style. */
export function staleBeats(ctx: ToolContext, script: Script, style: string): string[] {
  const sound = ctx.voice.sound(style);
  return script.scenes.filter((s) => {
    const t = ctx.draft.timings[s.id];
    return !t || t.narration !== spokenAs(s) || (ctx.voice.quick && !t.estimated && t.sound !== sound);
  }).map((s) => s.id);
}

/** The style the video is drawn in: the request's, else the agent's pick, else the first style. */
export function styleOf(ctx: ToolContext): string {
  if (ctx.request.style !== "auto") return ctx.request.style;
  return ctx.draft.style ?? ctx.draft.script?.style ?? ctx.styles[0]!.id;
}

export function sceneContext(ctx: ToolContext, id: string): SceneContext | undefined {
  const script = ctx.draft.script;
  const scene = script?.scenes.find((s) => s.id === id);
  const timed = ctx.draft.timings[id];
  if (!script || !scene || !timed) return undefined;
  return { title: script.title, idea: script.idea, brief: ctx.request.brief, style: styleOf(ctx), frame: ctx.request.frame, scene, timing: timed.timing, toolbox: (ctx.draft.toolbox ??= emptyToolbox()), assets: assetsOf(ctx) };
}

/** The kept pictures a scene can show, by name, as files in the job's folder. */
export function assetsOf(ctx: ToolContext): { root: string; files: Record<string, string> } {
  return { root: ctx.folder, files: Object.fromEntries(Object.values(ctx.draft.pictures?.assets ?? {}).map((a) => [a.name, a.file])) };
}

const sceneNumber = (ctx: ToolContext, id: string) => `${(ctx.draft.script?.scenes.findIndex((s) => s.id === id) ?? -1) + 1} of ${ctx.draft.script?.scenes.length ?? "?"}`;

/**
 * A scene's number in the person's step: "3" while the beats are still being written, "3 of 5" once the whole
 * video's count is fixed (`Draft.sceneCount`), so a step never reads as if each new scene were the last.
 */
export function stepNumber(draft: Draft, id: string): string {
  const scenes = draft.script?.scenes ?? [];
  const n = scenes.findIndex((s) => s.id === id) + 1;
  return draft.sceneCount !== undefined && draft.sceneCount === scenes.length ? `${n} of ${draft.sceneCount}` : `${n}`;
}

const readPassages: Tool = {
  name: "read_passages",
  description: "Read the full text of passages by id. The video must stand on these words: every scene cites at least one of them word for word.",
  inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Passage ids from the list you were given." } }, required: ["ids"] },
  async run(input, ctx) {
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
    if (!ids.length) return fail("Give the ids of the passages to read.");
    ctx.step("Reading the sources");
    const byId = new Map(ctx.request.passages.map((p) => [p.id, p]));
    const out = ids.slice(0, 40).map((id) => {
      const p = byId.get(id);
      return p ? `[${p.id}] ${p.sourceTitle}${p.locator ? `, ${p.locator}` : ""}\n${p.text.trim()}` : `[${id}] There is no passage with this id.`;
    });
    return { text: out.join("\n\n") };
  },
};

const readSkillTool: Tool = {
  name: "read_skill",
  description: `Read a skill, or one of its files, when it helps: its SKILL.md first, and the files it points to when you want more. The skills:\n${skills().map((x) => `- ${x.name}: ${x.description}`).join("\n")}`,
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "The skill's name." },
      file: { type: "string", description: "A file inside the skill, e.g. references/scene-language.md; its SKILL.md when left out." },
    },
    required: ["skill"],
  },
  async run(input, ctx) {
    const skill = String(input.skill ?? "");
    const file = typeof input.file === "string" && input.file.trim() ? input.file : undefined;
    const video = forVideo(ctx.request, styleOf(ctx));
    const text = readSkill(skill, file, video);
    if (text === undefined) return fail(`There is no ${file ? `file "${file}" in the skill "${skill}"` : `skill "${skill}"`}. There are:\n${skillFiles(video).map((f) => `- ${f}`).join("\n")}`);
    return { text };
  },
};

const aboutVideo: Tool = {
  name: "about_video",
  description:
    "Say what the video is, whenever you know or change your mind: its title, its idea (what the viewer understands by the end), its style when the style is yours to pick, and short when it is shorter than asked because the passages say too little. Each field you leave out stays as it was.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      idea: { type: "string", description: "One or two sentences: what the viewer understands by the end." },
      style: { type: "string", description: "A style id from the list, when the style is yours to pick." },
      styleWhy: { type: "string", description: "Why that style suits this subject and these viewers, if you want it on record." },
      short: { type: "string", description: "Why the video is shorter than asked, when the passages do not say enough for more. The person is told. Empty clears it." },
    },
  },
  async run(input, ctx) {
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
    const script = (ctx.draft.script ??= { title: ctx.request.title, idea: "", scenes: [] });
    const problems: string[] = [];
    const title = text(input.title);
    const idea = text(input.idea);
    const style = text(input.style);
    if (title !== undefined) title && title.length <= FIXED.titleChars ? (script.title = title) : problems.push(`title: 1 to ${FIXED.titleChars} characters.`);
    if (idea !== undefined) idea.length <= FIXED.ideaChars ? (script.idea = idea) : problems.push(`idea: at most ${FIXED.ideaChars} characters.`);
    if (text(input.styleWhy)) script.styleWhy = text(input.styleWhy)!;
    const short = text(input.short);
    if (short !== undefined) short ? (ctx.draft.short = short.slice(0, 300)) : delete ctx.draft.short;
    let restyled = false;
    if (style !== undefined && ctx.request.style === "auto") {
      if (!ctx.styles.some((x) => x.id === style)) problems.push(`style: "${style}" is not one of ${ctx.styles.map((x) => x.id).join(", ")}.`);
      else if (style !== styleOf(ctx)) {
        restyled = Object.keys(ctx.draft.scenes).length > 0;
        script.style = style;
        ctx.draft.style = style;
        for (const d of Object.values(ctx.draft.scenes)) Object.assign(d, { built: false, looked: false, serious: [] });
      } else script.style = style;
    }
    delete ctx.draft.finished;
    const now = styleOf(ctx);
    const shelfView = !problems.length && idea && script.scenes.length === 0 && !ctx.draft.shelfShown ? await shelfForIdea(ctx.folder) : undefined;
    if (shelfView) ctx.draft.shelfShown = "about_video";
    ctx.save();
    return {
      ...(problems.length ? { isError: true } : {}),
      ...(shelfView?.images.length ? { images: shelfView.images } : {}),
      text: [
        ...(problems.length ? ["Not taken:", ...problems.map((p) => `- ${p}`)] : []),
        `The video: "${script.title}"${script.idea ? `, ${script.idea}` : ", no idea said yet"}. Style: ${now}${ctx.request.style === "auto" ? (script.style ? " (your pick)" : " (none picked yet, so the first style)") : " (set by the request)"}.${leansText(themeFrom(now))}`,
        ...(restyled ? ["The style changed, so every beat with a picture is built again the next time you write it (write_beat with its beat id rebuilds it as it is)."] : []),
        ...(ctx.draft.short ? [`Shorter because: ${ctx.draft.short}`] : []),
        ...(shelfView ? [shelfView.text] : []),
      ].join("\n"),
    };
  },
};

/** Keeps the depicter's answers the agent sent with a scene. Returns the problems with them, in words. */
function takeDepictions(input: unknown, source: string, ctx: ToolContext): { taken: string[]; problems: string[] } {
  const list = Array.isArray(input) ? input : [];
  const box = (ctx.draft.toolbox ??= emptyToolbox());
  const theme = themeFrom(styleOf(ctx));
  const wanted = wantedIn(source, kitKinds());
  const taken: string[] = [];
  const problems: string[] = [];
  for (const item of list) {
    const d = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const id = String(d.id ?? "").trim();
    const desc = String(d.desc ?? "").trim();
    const spec = d.spec as PropSpec | undefined;
    if (!id || !desc || typeof spec !== "object" || spec === null) {
      problems.push(`A depiction needs id, desc (the words on its depict line) and spec (a PropSpec object).`);
      continue;
    }
    const norm = (x: string) => x.replace(/\s+/g, " ").toLowerCase();
    const w: Wanted = wanted.find((x) => x.id === id && norm(x.desc) === norm(desc)) ?? { id, desc, verbs: [], states: [], relations: [], company: [], parts: [] };
    const wrong = answerDepiction(box, w, spec, theme);
    if (wrong.length) problems.push(...wrong);
    else taken.push(id);
  }
  return { taken, problems };
}

/** A beat's words, numbered, with when each is said and where the voice waits: what its scene's moments are. */
function timedWords(t: Timed): string {
  const holds = new Map((t.timing.holds ?? []).map((h) => [h.afterWord, h]));
  return t.timing.words
    .map((w, i) => {
      const h = holds.get(i);
      return `@${i} ${w.text} ${w.start.toFixed(1)}${h ? ` [pause ${h.seconds} = @${h.id} ${h.start.toFixed(1)} to @${h.id}.end ${(h.start + h.seconds).toFixed(1)}]` : ""}`;
    })
    .join("  ");
}

const writeBeat: Tool = {
  name: "write_beat",
  description:
    "Write one beat of the video: what the voice says and what the picture does while it says it, together. A beat is one scene, cut to from the one before. Send what you are writing or changing; every field you leave out stays as it was. With no beat, a new beat is added (after the beat you name in after, else at the end). The narration may hold pauses where the voice waits for the picture, written [pause 1.5] (seconds) after a word: the scene reaches each as a hold, @h1 when the silence starts and @h1.end when the voice comes back. The voice speaks the words at once and the answer gives every word's number and time, so you can move the picture to the words or the words to the picture and send the beat again. source is the beat's scene in the scene language, with this beat's own word numbers (@0 is its first word); it is built at once, with what the engine cannot build past, or what it measured. For each depict line you are the depicter: send the thing's spec in depictions. remove deletes the beat.",
  inputSchema: {
    type: "object",
    properties: {
      beat: { type: "string", description: "The beat to change, as the answers name it (s1, s2, …). Leave out to add a new one." },
      after: { type: "string", description: "For a new beat: the beat it comes after, or start. Else it goes at the end." },
      narration: { type: "string", description: "What the voice says in this beat, with [pause N] where it waits for the picture." },
      cites: { type: "array", items: { type: "object", properties: { passageId: { type: "string" }, quote: { type: "string" } }, required: ["passageId", "quote"] }, description: "The passages this beat stands on, each with a quote copied word for word." },
      visual: { type: "string", description: "What is on screen, in plain words, for someone who cannot see it." },
      onScreenText: { type: "array", items: { type: "string" }, description: "The few words drawn on screen, if any." },
      emphasis: { type: "array", items: { type: "string" }, description: "Words of this beat's narration the captions light in the accent color as they are said, or none." },
      source: { type: "string", description: "The beat's whole scene, in the scene language." },
      depictions: {
        type: "array",
        description: 'For each `depict ID "words"` line the engine cannot draw yet: your answer as the depicter. A spec is kept for the whole video; send it again only to change it.',
        items: { type: "object", properties: { id: { type: "string" }, desc: { type: "string", description: "The quoted words of its depict line, exactly." }, spec: { type: "object", description: 'A PropSpec (the make-a-video skill, references/depicting.md).' } }, required: ["id", "desc", "spec"] },
      },
      remove: { type: "boolean", description: "Delete this beat." },
    },
  },
  async run(input, ctx) {
    const script = (ctx.draft.script ??= { title: ctx.request.title, idea: "", scenes: [] });
    const id = typeof input.beat === "string" ? input.beat.trim() : "";
    const was = id ? script.scenes.find((s) => s.id === id) : undefined;
    if (id && !was) return fail(`There is no beat "${id}"${script.scenes.length ? ` (there are ${script.scenes.map((s) => s.id).join(", ")})` : ""}. Leave beat out to add a new one.`);
    if (input.remove === true) {
      if (!was) return fail("Name the beat to remove.");
      script.scenes = script.scenes.filter((s) => s !== was);
      delete ctx.draft.sceneCount;
      delete ctx.draft.scenes[was.id];
      delete ctx.draft.timings[was.id];
      delete ctx.draft.finished;
      ctx.save();
      return { text: `Removed ${was.id}. The beats now: ${script.scenes.map((s) => s.id).join(", ") || "none"}.` };
    }
    // The beat as it will be: what was sent over what it was.
    const fields = ["narration", "cites", "visual", "onScreenText", "emphasis"] as const;
    const given = Object.fromEntries(fields.filter((f) => input[f] !== undefined).map((f) => [f, input[f]]));
    const base = was ? { narration: withPauses(was), cites: was.cites, visual: was.visual, onScreenText: was.onScreenText, emphasis: was.emphasis ?? [] } : {};
    if (!was && given.narration === undefined) return fail("A new beat needs its narration (and its cites and visual).");
    const beatId = was?.id ?? `s${Math.max(0, ...script.scenes.map((s) => Number(s.id.slice(1)) || 0)) + 1}`;
    const problems: string[] = [];
    const notes: string[] = [];
    const count = script.scenes.length + (was ? 0 : 1);
    if (count > ctx.request.limits.maxScenes) problems.push(`the video would have ${count} beats; at most ${ctx.request.limits.maxScenes}. Change or remove a beat instead.`);
    // The ids the writer sees (its beats') and the ones Open Sourcebook numbers the scenes by in the finished video (s1, s2, … in order).
    const beats = [...new Set([...script.scenes.map((s) => s.id), beatId, ...Array.from({ length: count }, (_, i) => `s${i + 1}`)])];
    const beat = checkScene({ ...base, ...given }, beatId, beatId, ctx.request.passages, ctx.request.limits, problems, notes, beats);
    if (problems.length) return fail(`${beatId} was not taken. Fix these and send it again:\n- ${problems.join("\n- ")}`);
    if (was) script.scenes[script.scenes.indexOf(was)] = beat;
    else {
      const after = typeof input.after === "string" ? input.after.trim() : "";
      const at = after === "start" ? 0 : after && script.scenes.some((s) => s.id === after) ? script.scenes.findIndex((s) => s.id === after) + 1 : script.scenes.length;
      script.scenes.splice(at, 0, beat);
      delete ctx.draft.sceneCount;
    }
    ctx.step(`Drawing scene ${stepNumber(ctx.draft, beatId)}`);
    // The voice speaks the beat when its words or pauses changed.
    const style = styleOf(ctx);
    const respoken = staleBeats(ctx, script, style).includes(beatId);
    // With the voice out, the beat is timed by the estimate, as a slow voice's is; the agent hears why once, here.
    let wentDown = "";
    if (respoken) {
      const speak = (voice: Voice) => speakBeats(script, [beatId], voice, { folder: ctx.folder, style, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      try {
        Object.assign(ctx.draft.timings, await speak(ctx.draft.voiceDown ? { ...ctx.voice, quick: false } : ctx.voice));
      } catch (e) {
        const down = voiceDownOf(e);
        if (!down) throw e;
        wentDown = voiceWentDown(ctx, down);
        Object.assign(ctx.draft.timings, await speak({ ...ctx.voice, quick: false }));
      }
    }
    const d = (ctx.draft.scenes[beatId] ??= { built: false, looked: false, writes: 0, looks: 0 });
    delete ctx.draft.finished;
    const source = typeof input.source === "string" ? input.source.replace(/^```[a-z]*\s*$/gm, "") : d.source;
    const depicted = source ? takeDepictions(input.depictions, source, ctx) : { taken: [], problems: [] };
    const timed = ctx.draft.timings[beatId]!;
    const estimated = ctx.draft.voiceDown ? " by the estimate (the voice cannot speak for now)" : " by the estimate (the voice speaks it when the video renders)";
    const head = [
      ...(wentDown ? [wentDown, ""] : []),
      `${beatId} (${sceneNumber(ctx, beatId)}), ${timed.timing.seconds.toFixed(1)} s${timed.estimated ? estimated : ""}${respoken && !ctx.draft.voiceDown ? (was ? ", spoken again" : ", spoken") : ""}:`,
      timedWords(timed),
      ...notes,
    ];
    if (!source?.trim()) {
      ctx.save();
      return { text: [...head, `No picture yet: send source when you write it. ${videoSoFar(ctx)}`].join("\n") };
    }
    if (typeof input.source === "string" || respoken || !d.built) {
      if (typeof input.source === "string") {
        d.source = source;
        d.writes += 1;
      }
      d.looked = false;
      const built = await buildScene(sceneContext(ctx, beatId)!, source, join(ctx.folder, "build"));
      d.built = built.ok;
      d.open = built.ok ? built.warnings : [];
      d.serious = built.serious;
      ctx.save();
      const took = depicted.taken.length ? `Kept the depictions of ${depicted.taken.join(", ")}.` : "";
      const wrong = depicted.problems.length ? [`These depictions were not kept; fix them and send them again:`, ...depicted.problems.map((p) => `- ${p}`)] : [];
      if (!built.ok) {
        const why = built.undepicted?.length ? `Its picture draws things that are not depicted yet.` : `Its picture does not build${typeof input.source === "string" ? "" : " on these word times"}. ${built.problems.length} problem${built.problems.length === 1 ? "" : "s"} (line numbers count the source's lines, from 1):`;
        return fail([...head, took, ...wrong, why, ...built.problems.slice(0, 25).map((p) => `- ${p}`), ...(built.warnings.length ? ["Also:", ...built.warnings.map((w) => `- ${w}`)] : []), "Send the beat again with what it needs (only the fields that change)."].filter(Boolean).join("\n"));
      }
      // What it drew, over the whole beat, as the person who draws sees it: frames with the words said over them.
      const strip = built.scene ? await stripOf(sceneContext(ctx, beatId)!, { ...built, scene: built.scene }, 0, built.scene.frames / built.scene.fps, join(stillsFolder(ctx.folder, beatId), `w${d.writes}-strip`)).catch(() => undefined) : undefined;
      const beside = built.warnings.some(onlyPlain) ? await shelfBeside(ctx, beatId, Boolean(strip), beat.visual) : undefined;
      if (beside?.image) ctx.save();
      const images = [...(strip ? [{ mimeType: "image/jpeg", dataBase64: jpegBase64(strip.file) }] : []), ...(beside?.image ? [beside.image] : [])];
      return {
        ...(images.length ? { images } : {}),
        text: [
          ...head,
          took,
          ...wrong,
          `Its picture builds: ${built.seconds.toFixed(1)} s.`,
          ...(built.serious.length ? ["Measured, and a viewer would notice:", ...built.serious.map((w) => `- ${w}`)] : []),
          ...(strip ? [`What it draws over its ${built.seconds.toFixed(1)} s is in the ${strip.lines.length} small frames below, left to right and down; look with from and to gives each frame's words.`, ...(strip.still.length ? ["Where the picture stands still:", ...strip.still.map((x) => `- ${x}`)] : [])] : []),
          ...(built.scene ? namedFirst(beatId, built.scene, timed.timing) : []),
          ...(built.warnings.length > built.serious.length ? ["Also measured:", ...built.warnings.filter((w) => !built.serious.includes(w)).map((w) => `- ${w}`)] : []),
          ...built.notes,
          ...(beside ? [beside.text] : []),
          `look shows it as the viewer will. ${videoSoFar(ctx)}`,
        ].filter(Boolean).join("\n"),
      };
    }
    ctx.save();
    return { text: [...head, `Its picture is as it was and still builds. ${videoSoFar(ctx)}`].join("\n") };
  },
};

/** A build's finding that the picture is only words and plain shapes, or programs that draw only rectangles and circles. */
const onlyPlain = (w: string) => /^(Only words and plain shapes|Blocks):/.test(w);

/**
 * What is on the shelf, said beside a beat whose picture is only words and plain shapes: the first time in a video, the
 * picture of every piece with its name; after that, a line on where that picture was. It says what is there, never
 * which to use or that one should be.
 */
export async function shelfBeside(ctx: ToolContext, beatId: string, afterStrip: boolean, visual = ""): Promise<{ text: string; image?: { mimeType: string; dataBase64: string } } | undefined> {
  const pieces = shelf();
  if (!pieces.length) return undefined;
  const what = `The shelf has ${pieces.length} pieces that draw themselves in this video's style and follow the voice`;
  const nearest = visual ? nearestPieceLines(visual, 3) : [];
  const nearText = nearest.length ? `\nPieces on the shelf whose names or tags share words with this beat's visual (find_piece with a name gives one's settings and program):\n${nearest.join("\n")}` : "";
  if (ctx.draft.shelfShown) return { text: `${what}; the picture of all of them came with ${ctx.draft.shelfShown}'s answer, and find_piece with no want shows it again.${nearText}` };
  const image = await sheetImage(pieces, ctx.folder);
  if (!image) return { text: `${what}; find_piece with no want lists them.${nearText}` };
  ctx.draft.shelfShown = beatId;
  return { text: `${what}: the ${afterStrip ? "second picture" : "picture"} below shows each as its own small scene ends, with its name under it (find_piece with a name gives one's settings and program).${nearText}`, image };
}

/**
 * The things a built beat draws well after its voice names them, read as the viewer report reads a render, so a beat is
 * seen this way before any render. Empty when every thing named is there by its word.
 */
function namedFirst(id: string, scene: Scene, timing: SceneTiming): string[] {
  const facts = sampleScenes([{ id, scene, offset: 0 }]);
  const heard = { durationMs: (scene.frames / scene.fps) * 1000, spans: [{ id, startMs: 0, endMs: (scene.frames / scene.fps) * 1000 }], words: timing.words.map((w) => ({ ...w, beat: id })), holds: [], voice: { real: true } };
  return observe(facts, heard).observations.filter((o) => o.kind === "named-first").map((o) => o.text);
}

/** The whole video so far in a line: its beats, and its spoken length against the length asked for. */
function videoSoFar(ctx: ToolContext): string {
  const script = ctx.draft.script!;
  const total = script.scenes.reduce((sum, x) => sum + (ctx.draft.timings[x.id]?.timing.seconds ?? 0), 0);
  const words = script.scenes.reduce((n, x) => n + (ctx.draft.timings[x.id]?.timing.words.length ?? 0), 0);
  const target = ctx.request.targetSeconds;
  const state = (id: string) => {
    const d = ctx.draft.scenes[id];
    if (!d?.source) return " (no picture)";
    if (!d.built) return " (does not build)";
    const facts = [d.serious?.length ? `${d.serious.length} measured that a viewer would notice` : "", d.looked ? "" : "not looked at"].filter(Boolean);
    return facts.length ? ` (${facts.join(", ")})` : "";
  };
  let repeated = "";
  if (script.scenes.length >= VIEWER.samePieceMinBeats) {
    const shelfNames = shelf().map((p) => p.name);
    const byPiece = new Map<string, number>();
    for (const s of script.scenes) {
      for (const piece of piecesIn([ctx.draft.scenes[s.id]?.source ?? ""], shelfNames)) {
        byPiece.set(piece, (byPiece.get(piece) ?? 0) + 1);
      }
    }
    const notes = [...byPiece]
      .filter(([, count]) => count >= VIEWER.samePieceMinBeats && count > script.scenes.length / 2)
      .map(([piece, count]) => `${count === script.scenes.length ? `All ${count}` : `${count} of ${script.scenes.length}`} beats so far use the same piece, ${piece}.`);
    if (notes.length) repeated = ` (${notes.join(" ")})`;
  }
  return `The video so far: ${script.scenes.map((s) => `${s.id} ${(ctx.draft.timings[s.id]?.timing.seconds ?? 0).toFixed(1)} s${state(s.id)}`).join(", ")}; ${Math.round(total)} s spoken.${target ? ` ${lengthNote(total, target, words)}` : ""}${repeated}`;
}

const look: Tool = {
  name: "look",
  description:
    "See a beat's picture as a viewer on a phone would. Either up to 4 stills at the moments you name (word numbers of that beat; each is taken just after the word, once things have settled), or, when you name none, how it opens, its middle and how it ends: each with what the voice says then, the words on screen, what was measured and the instruments' readings. Or, with from and to (seconds into the beat), the beat over time: a strip of small frames every half second or so, each with the word being said and whether anything changed since the frame before, and the stretches where the picture stands still under the voice.",
  inputSchema: {
    type: "object",
    properties: {
      scene: { type: "string", description: "The beat: s1, s2, …" },
      at: { type: "array", items: { type: "number" }, description: "Word numbers of the beat, at most 4." },
      from: { type: "number", description: "Seconds into the beat where a strip starts (0 is its first frame)." },
      to: { type: "number", description: "Seconds into the beat where a strip ends (at most 18 frames between)." },
    },
    required: ["scene"],
  },
  async run(input, ctx) {
    const id = String(input.scene ?? "");
    const c = sceneContext(ctx, id);
    const d = ctx.draft.scenes[id];
    if (!c || !d?.source) return fail(`Write ${id || "the beat"}'s picture first (write_beat with source).`);
    if (!d.built) return fail(`${id}'s picture does not build yet; fix it with write_beat first.`);
    ctx.step(`Checking scene ${stepNumber(ctx.draft, id)}`);
    const built = await buildScene(c, d.source, join(ctx.folder, "build"));
    if (!built.ok || !built.scene) return fail(`${id} no longer builds:\n- ${built.problems.join("\n- ")}`);
    d.open = built.warnings;
    d.serious = built.serious;
    const scene = built.scene;
    if (input.from !== undefined || input.to !== undefined) {
      const seconds = scene.frames / scene.fps;
      const from = Math.max(0, Number(input.from ?? 0) || 0);
      const to = Math.min(seconds, Number(input.to ?? seconds) || seconds);
      const strip = await stripOf(c, { ...built, scene }, from, Math.max(from, to), join(stillsFolder(ctx.folder, id), `${d.looks + 1}-strip`));
      d.looks += 1;
      d.looked = true;
      ctx.save();
      return {
        text: [
          `${id} from ${from.toFixed(1)} to ${Math.max(from, to).toFixed(1)} s of ${seconds.toFixed(1)}: ${strip.lines.length} frames in one picture below, left to right and down.`,
          ...strip.lines,
          ...(strip.still.length ? ["Where the picture stands still:", ...strip.still.map((x) => `- ${x}`)] : []),
        ].join("\n"),
        images: [{ mimeType: "image/jpeg", dataBase64: jpegBase64(strip.file) }],
      };
    }
    const at = Array.isArray(input.at) ? input.at.map(Number).filter((n) => Number.isFinite(n)) : undefined;
    const stills = await lookAt(c, d.source, { ...built, scene }, at, join(stillsFolder(ctx.folder, id), String(d.looks + 1)));
    d.looks += 1;
    d.looked = true;
    ctx.save();
    return {
      text: [
        `${id}: ${stills.length} still${stills.length === 1 ? "" : "s"}, in order below.`,
        ...stills.map((s) => s.text),
        ...(built.serious.length ? [`Measured, and a viewer would notice: ${built.serious.join(" | ")}`] : []),
      ].join("\n\n"),
      images: stills.map((s) => ({ mimeType: "image/jpeg", dataBase64: jpegBase64(s.file) })),
    };
  },
};

/** Renders running in the background while the agent works, by job folder: at most one each. */
export const renders = new Map<string, { started: number; progress: number; done: Promise<void>; result?: CutResult; error?: string; voiceDown?: boolean }>();

/**
 * How long `render` waits before returning so it can finish, measure the report, and render phone sheets well inside the
 * connector's 120 s tool-call limit.
 */
export const RENDER_INITIAL_WAIT_MS = 80_000;

/**
 * How long watch and viewer_report wait for a render still running before they answer: as long as the agent connector
 * lets one tool call run (two minutes), less a margin. A report that gave up sooner, at 90 s, was read by agents as the
 * end of looking, and they finished without having seen their video.
 */
export const RENDER_WAIT_MS = 110_000;

/** A render still running, in plain words: how far it is, about how long it has left at its pace, and that it is unseen. */
function stillRendering(folder: string, what: string): ToolAnswer {
  const r = renders.get(folder)!;
  const took = (Date.now() - r.started) / 1000;
  const left = r.progress > 0.02 ? Math.round((took / r.progress) * (1 - r.progress)) : undefined;
  return { text: `Still rendering after waiting ${Math.round(RENDER_WAIT_MS / 1000)} s: ${Math.round(r.progress * 100)}% of its frames, started ${Math.round(took)} s ago${left !== undefined ? `, about ${left} s more at this pace` : ""}. Nothing of this render has been seen yet. Call ${what} again and it waits for the render again, up to ${Math.round(RENDER_WAIT_MS / 1000)} s each time.` };
}

/** Waits for a job's render, at most `ms`. True when it is done (or there is none). */
async function settled(folder: string, ms: number): Promise<boolean> {
  const r = renders.get(folder);
  if (!r) return true;
  let late: NodeJS.Timeout | undefined;
  const over = await Promise.race([r.done.then(() => false), new Promise<boolean>((resolve) => (late = setTimeout(() => resolve(true), ms)))]);
  clearTimeout(late);
  return !over;
}

/** What a finished render says: the video's length, where each beat is, the voice, the sound, and whether it is current. */
function aboutCut(ctx: ToolContext, cut: Cut): string {
  const target = ctx.request.targetSeconds;
  const spoken = cut.spans.length ? cut.spans.at(-1)!.endMs / 1000 : 0;
  return [
    `Cut ${cut.number}: ${(cut.durationMs / 1000).toFixed(1)} s with the end card, ${spoken.toFixed(1)} s spoken. Rendered in ${Math.round(cut.renderMs / 1000)} s.${target ? ` ${lengthNote(spoken, target, cut.words.length)}` : ""}`,
    `Beats: ${cut.spans.map((x) => `${x.id} ${(x.startMs / 1000).toFixed(1)} to ${(x.endMs / 1000).toFixed(1)} s`).join(", ")}.`,
    `Voice: ${cut.voice.label}${cut.voice.real ? "" : " (no sound: the captions carry the words)"}. ${cut.sound ? `Sound: ${cut.sound.music.length ? `music ${cut.sound.music.join(", ")}` : "no music"}, ${cut.sound.effects.length} effect${cut.sound.effects.length === 1 ? "" : "s"}, mastered to ${cut.sound.lufs} LUFS.` : "No sound under it."}`,
    cut.key === cutKey(ctx) ? "It is the video as it stands (finish would give the person this file)." : "The video has changed since this cut; render again to see the changes.",
  ].join("\n");
}

const render: Tool = {
  name: "render",
  description:
    "Make the real video, as the person will get it: the voice for every beat (spoken again where it changed), every scene built on its real word times, the music and effects, captions and the end card, mixed and rendered to the mp4. When it finishes within about 80 seconds, the answer carries phone-size frames of the cut and the top viewer-report findings; if it takes longer, it continues in the background while you keep working and watch or viewer_report waits for it. A beat that no longer builds on the real times is named with its problems, and no video is made.",
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx) {
    const why = unfinished(ctx.draft);
    if (why.length) return fail(`Not yet:\n- ${why.join("\n- ")}`);
    if (ctx.draft.voiceDown) return fail(voiceOut(ctx));
    const running = renders.get(ctx.folder);
    if (running && !running.result && !running.error) return { text: `A render is already running (${Math.round(running.progress * 100)}% of its frames, started ${Math.round((Date.now() - running.started) / 1000)} s ago). watch waits for it and shows it.` };
    const current = currentCut(ctx);
    if (current && existsSync(join(ctx.folder, current.file))) return { text: `Nothing changed since the last render.\n${aboutCut(ctx, current)}` };
    ctx.draft.sceneCount = ctx.draft.script?.scenes.length ?? 0;
    ctx.save();
    ctx.step("Making a first cut for your agent to watch");
    const entry: { started: number; progress: number; done: Promise<void>; result?: CutResult; error?: string; voiceDown?: boolean } ={ started: Date.now(), progress: 0, done: Promise.resolve() };
    // One video draws at a time on this computer: a render that comes while another draws waits for its turn.
    entry.done = makeCut(ctx, (p) => (entry.progress = p)).then(
      (result) => void (entry.result = result),
      (e: Error) => {
        const down = voiceDownOf(e);
        // The voice went out while this render voiced the video: said once, as write_beat would say it.
        entry.error = down ? voiceWentDown(ctx, down) : e.message.slice(0, 400);
        if (down) entry.voiceDown = true;
      },
    );
    renders.set(ctx.folder, entry);
    if (!(await settled(ctx.folder, RENDER_INITIAL_WAIT_MS))) return { text: `Rendering in the background (${Math.round(entry.progress * 100)}% of its frames so far). Keep working if you like; watch waits for it and shows it.` };
    return renderAnswer(ctx, true);
  },
};

/** Phone-size frames (up to 8, at PHONE_TILE px wide) and top viewer-report findings for a finished cut. */
async function cutInspection(ctx: ToolContext, cut: Cut, tag: string) {
  const report = cut.facts && existsSync(join(ctx.folder, cut.facts)) ? await viewerReportOf(ctx, cut).catch(() => undefined) : undefined;
  const seconds = cut.durationMs / 1000;
  const end = Math.max(0.4, seconds - 0.1);
  const times = timesOver(0.4, end, Math.max(1.5, seconds / 8), 8);
  const frameLines = times.map((t, i) => {
    const m = momentOf(cut, t);
    return `${i + 1}. ${t.toFixed(1)} s, ${m.beat} +${m.into.toFixed(1)} s: ${m.said}`;
  });
  const images = await phoneSheets(join(ctx.folder, cut.file), times, ctx.request.frame, join(ctx.folder, "watch", tag))
    .then((sheets) => sheets.map((f) => ({ mimeType: "image/jpeg", dataBase64: jpegBase64(f) })))
    .catch(() => []);
  const findings = report?.observations ?? [];
  const findingsLines = !report
    ? []
    : findings.length
      ? [
          `A viewer of this render would notice ${findings.length === 1 ? "one thing" : `${findings.length} things`}; the most noticeable:`,
          ...findings.slice(0, 6).map((o) => `- ${o.text}`),
          findings.length > 6 ? `…and ${findings.length - 6} more (viewer_report gives all of them).` : "viewer_report gives the numbers and what reads fine.",
        ]
      : ["viewer_report finds nothing in this render that a viewer would notice."];
  return { report, findingsLines, frameLines, images };
}

/** Viewer-report observations the agent can address by editing scenes (excludes environment facts such as no-voice). */
const actionableFindings = (r: Report) => r.observations.filter((o) => o.kind !== "no-voice").length;

/** The answer once a render ended: the cut, its phone frames and top findings, the beats that broke on the real times, or what failed. */
async function renderAnswer(ctx: ToolContext, heads = false): Promise<ToolAnswer> {
  const r = renders.get(ctx.folder);
  if (r?.error && r.voiceDown) return fail(r.error);
  if (r?.error) return fail(`The render failed: ${r.error}. Render again; if it fails the same way, change what it names.`);
  if (r?.result && "broken" in r.result) {
    return fail(["These beats do not build on the voice's real word times, so no video was made:", ...Object.entries(r.result.broken).map(([id, list]) => `- ${id}: ${list.slice(0, 6).join(" | ")}`), "Fix them with write_beat, then render again."].join("\n"));
  }
  const cut = ctx.draft.cut;
  if (!cut) return fail("No video was made.");
  const [first, ...rest] = aboutCut(ctx, cut).split("\n");
  if (!heads || !existsSync(join(ctx.folder, cut.file))) {
    return { text: [first, ...rest, "watch shows it; watch with phone: true at the size a phone does."].filter(Boolean).join("\n") };
  }
  const insp = await cutInspection(ctx, cut, `render-${cut.number}`);
  if (insp.images.length > 0 || insp.report !== undefined) {
    ctx.draft.seenCut = cut.number;
    if (insp.report) ctx.draft.renderReport = { cut: cut.number, things: actionableFindings(insp.report), scenes: scenesKey(ctx.draft) };
    ctx.save();
  }
  return {
    text: [
      first,
      ...insp.findingsLines,
      ...rest,
      ...(insp.images.length ? [`${insp.frameLines.length} frames of cut ${cut.number} below at phone size (${PHONE_TILE} pixels wide), left to right and down:`, ...insp.frameLines] : []),
      insp.images.length ? "watch shows more moments; viewer_report gives the full report." : "watch shows it; viewer_report gives the full report.",
    ]
      .filter(Boolean)
      .join("\n"),
    ...(insp.images.length ? { images: insp.images } : {}),
  };
}

const watch: Tool = {
  name: "watch",
  description:
    `Watch the last rendered video (render makes it): frames of the real mp4 over the whole video, or every half second over the stretch you name with from and to (seconds of the video), or the one moment at, each with its time, its beat and the seconds into it, and what the voice says then or the pause it is in. With phone, the frames are ${PHONE_TILE} pixels wide, the size a phone held upright shows the video, so small writing is as small as a viewer sees it: four a sheet, as many sheets as it takes. Waits for a render that is still running. Before any render, it shows each beat's opening and end from its build instead.`,
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "number", description: "Seconds into the video where to start; the start when left out." },
      to: { type: "number", description: "Seconds into the video where to end; the end when left out." },
      at: { type: "number", description: "One moment of the video, in seconds, to see alone." },
      phone: { type: "boolean", description: `Frames at phone size (${PHONE_TILE} pixels wide) instead of small ones.` },
    },
  },
  async run(input, ctx) {
    const script = ctx.draft.script;
    if (!script) return fail("Write a beat first (write_beat).");
    if (!(await settled(ctx.folder, RENDER_WAIT_MS))) return stillRendering(ctx.folder, "watch");
    const r = renders.get(ctx.folder);
    if (r && (r.error || (r.result && "broken" in r.result))) {
      renders.delete(ctx.folder);
      return await renderAnswer(ctx);
    }
    const cut = ctx.draft.cut;
    if (!cut || !existsSync(join(ctx.folder, cut.file))) return builtSheets(ctx, "Nothing is rendered yet (render makes the real video).");
    ctx.step("Your agent is watching the video");
    const seconds = cut.durationMs / 1000;
    const phone = input.phone === true;
    const at = typeof input.at === "number" && Number.isFinite(input.at) ? Math.max(0, Math.min(seconds - 0.05, input.at)) : undefined;
    const whole = at === undefined && input.from === undefined && input.to === undefined;
    const from = Math.max(0, Math.min(seconds, Number(input.from ?? 0) || 0));
    const to = Math.max(from, Math.min(seconds - 0.05, Number(input.to ?? seconds) || seconds));
    // At phone size a sheet holds four frames, so the whole video is seen in fewer, larger frames.
    const most = phone ? 16 : 24;
    const times = at !== undefined ? [Math.round(at * 100) / 100] : whole ? timesOver(0.4, seconds - 0.1, Math.max(1.5, seconds / most), most) : timesOver(from, to, 0.5, most);
    ctx.draft.watched = (ctx.draft.watched ?? 0) + 1;
    ctx.draft.seenCut = cut.number;
    ctx.draft.watchedCut = cut.number;
    ctx.save();
    const folder = join(ctx.folder, "watch", String(ctx.draft.watched));
    const sheets = phone ? await phoneSheets(join(ctx.folder, cut.file), times, ctx.request.frame, folder) : [await sheetOf(join(ctx.folder, cut.file), times, ctx.request.frame, folder, at !== undefined ? { tile: 540 } : {})];
    const lines = times.map((t, i) => {
      const m = momentOf(cut, t);
      return `${i + 1}. ${t.toFixed(1)} s, ${m.beat} +${m.into.toFixed(1)} s: ${m.said}`;
    });
    const measured = script.scenes.flatMap((s) => (ctx.draft.scenes[s.id]?.serious ?? []).map((w) => `${s.id}: ${w}`));
    return {
      text: [
        aboutCut(ctx, cut),
        phone
          ? `${times.length === 1 ? "One frame" : `${times.length} frames`} of the mp4 below at phone size (${PHONE_TILE} pixels wide, as a phone held upright shows it)${sheets.length > 1 ? `, four a sheet on ${sheets.length} sheets` : ""}, left to right and down${whole || at !== undefined ? "" : `, from ${from.toFixed(1)} to ${to.toFixed(1)} s`}:`
          : `${times.length === 1 ? "One frame" : `${times.length} frames`} of the mp4 below, left to right and down${whole || at !== undefined ? "" : `, from ${from.toFixed(1)} to ${to.toFixed(1)} s`}:`,
        ...lines,
        ...(measured.length ? ["Measured in the builds, that a viewer would notice:", ...measured.slice(0, 16).map((w) => `- ${w}`)] : []),
      ].join("\n"),
      images: sheets.map((f) => ({ mimeType: "image/jpeg", dataBase64: jpegBase64(f) })),
    };
  },
};

/** The viewer report of a cut: the scenes as sampled at its render, and the mp4's change and silences. */
export async function viewerReportOf(ctx: ToolContext, cut: Cut): Promise<Report> {
  const facts = JSON.parse(readFileSync(join(ctx.folder, cut.facts!), "utf8")) as Facts;
  const video = join(ctx.folder, cut.file);
  const [motion, silences] = await Promise.all([motionOf(video, ctx.request.frame).catch(() => undefined), silencesOf(video).catch(() => [] as [number, number][])]);
  return observe(facts, cut, motion, silences, ctx.request.targetSeconds);
}

const viewerReport: Tool = {
  name: "viewer_report",
  description:
    "What a person watching the last rendered video on a phone would notice, in plain words: writing on screen too briefly to read or gone before the voice names it, writing too small for a phone, cut by the frame, on other writing or under a shape, stretches where the picture stands still while the voice goes on or too much arrives at once, beats that open empty or cut just as something appears, gaps and silences in the voice, its pace, mostly empty frames and small subjects. Each line says when (time and beat), what a viewer sees or hears and the numbers measured, the most noticeable first, then what reads fine. Measured from the rendered mp4 and the scenes' own data, never guessed. It reads the last render; after changes, render again and ask again.",
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx) {
    if (!(await settled(ctx.folder, RENDER_WAIT_MS))) return stillRendering(ctx.folder, "viewer_report");
    const cut = ctx.draft.cut;
    if (!cut || !existsSync(join(ctx.folder, cut.file))) return fail("Nothing is rendered yet: the report reads the real video, which render makes.");
    if (!cut.facts || !existsSync(join(ctx.folder, cut.facts))) return fail("This render was made without the scenes' data the report reads; render again and ask again.");
    ctx.step("Your agent is reading what a viewer would notice");
    const report = await viewerReportOf(ctx, cut);
    ctx.draft.seenCut = cut.number;
    ctx.draft.report = { cut: cut.number, things: report.observations.length, scenes: scenesKey(ctx.draft) };
    ctx.save();
    const current = cut.key === cutKey(ctx);
    const about = `The viewer report for cut ${cut.number} (${clock(cut.durationMs / 1000)} with the end card${current ? ", the video as it stands" : "; the video has changed since, so render again for a report of the changes"}). Each line is measured, with when and the numbers; it is what a viewer meets, for you to weigh against what the video is for. watch with phone: true shows the video at the size a phone does.`;
    return { text: reportText(report, about) };
  },
};

/** Each beat that builds, its opening on top and its end below, from the builds: the video before anything is rendered. */
async function builtSheets(ctx: ToolContext, lead: string): Promise<ToolAnswer> {
  const script = ctx.draft.script!;
  const ready = script.scenes.filter((s) => ctx.draft.scenes[s.id]?.built && ctx.draft.scenes[s.id]?.source);
  if (!ready.length) return fail(`${lead} No beat's picture builds yet (write_beat).`);
  ctx.step("Looking over the whole video");
  const sheets = await reviewSheets(ctx, ready.map((s) => s.id));
  ctx.draft.watched = (ctx.draft.watched ?? 0) + 1;
  ctx.save();
  const total = script.scenes.reduce((sum, x) => sum + ctx.draft.timings[x.id]!.timing.seconds, 0);
  const missing = script.scenes.filter((s) => !ready.includes(s)).map((s) => s.id);
  const measured = ready.flatMap((s) => (ctx.draft.scenes[s.id]!.open ?? []).map((w) => `${s.id}: ${w}`));
  const text = [
    `${lead} From the builds instead: ${sheets.length === 1 ? "one sheet" : `${sheets.length} sheets`} below, one column per beat (${ready.map((s) => s.id).join(", ")}), its opening on top and its end below. ${Math.round(total)} s spoken${ctx.request.targetSeconds ? `, about ${Math.round(ctx.request.targetSeconds)} s asked for` : ""}.`,
    ...(missing.length ? [`Not shown, as they do not build yet: ${missing.join(", ")}.`] : []),
    ...(measured.length ? ["Measured in the builds:", ...measured.slice(0, 16).map((w) => `- ${w}`)] : ["Nothing is measured wrong in the builds."]),
  ];
  return { text: text.join("\n"), images: sheets.map((f) => ({ mimeType: "image/jpeg", dataBase64: jpegBase64(f) })) };
}

const sound: Tool = {
  name: "sound",
  description: `Choose the sound under the voice, from this kit, once the scenes are written (call it again to change it; each call replaces the last). music: the bed for the video and any change of bed, each on a scene and one of its word numbers (at 0 is the scene's first frame), with a level from ${MUSIC_LEVELS[0]} (silence) to ${MUSIC_LEVELS[1]} dB over a quiet bed; music plays until the next cue and is lowered under the voice by itself. effects: a few short sounds on the word where something lands on screen, ${EFFECT_LEVELS[0]} to ${EFFECT_LEVELS[1]} dB, at least ${EFFECT_GAP} s apart. Reason from what each scene shows and how it should feel: most moments are better silent, a bed that suits the subject carries the whole video, an effect marks a reveal or a result landing, never every entrance, and nothing swells over a key line. Both lists may be empty for voice only.\n${kitText()}`,
  inputSchema: {
    type: "object",
    properties: {
      music: { type: "array", items: { type: "object", properties: { scene: { type: "string" }, at: { type: "integer", description: "word number in that scene" }, name: { type: "string", enum: Object.keys(KIT.music) }, level: { type: "number" }, why: { type: "string" } }, required: ["scene", "at", "name", "level", "why"] } },
      effects: { type: "array", items: { type: "object", properties: { scene: { type: "string" }, at: { type: "integer", description: "word number in that scene" }, name: { type: "string", enum: Object.keys(KIT.sfx) }, level: { type: "number" }, why: { type: "string" } }, required: ["scene", "at", "name", "level", "why"] } },
    },
    required: ["music", "effects"],
  },
  async run(input, ctx) {
    const script = ctx.draft.script;
    if (!script) return fail("Write a beat first; sounds are placed on the beats' words.");
    const problems: string[] = [];
    const read = (list: unknown, kind: "music" | "effects"): SoundPlan["music"] => {
      if (!Array.isArray(list)) {
        problems.push(`${kind}: a list (empty for none).`);
        return [];
      }
      return list.flatMap((raw, i) => {
        const c = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
        const where = `${kind}[${i}]`;
        const scene = script.scenes.find((s) => s.id === c.scene);
        const name = String(c.name ?? "");
        const at = Number(c.at ?? 0);
        const level = Number(c.level);
        const words = scene ? ctx.draft.timings[scene.id]?.timing.words.length ?? 0 : 0;
        if (!scene) problems.push(`${where}: no scene ${String(c.scene)} (${script.scenes.map((s) => s.id).join(", ")}).`);
        else if (!Number.isInteger(at) || at < 0 || at >= Math.max(1, words)) problems.push(`${where}: ${scene.id} has words @0 to @${Math.max(0, words - 1)}.`);
        if (!(kind === "music" ? KIT.music[name] : KIT.sfx[name])) problems.push(`${where}: no ${kind === "music" ? "music" : "effect"} named "${name}" (${Object.keys(kind === "music" ? KIT.music : KIT.sfx).join(", ")}).`);
        if (!Number.isFinite(level)) problems.push(`${where}: level is a number in dB.`);
        return [{ scene: String(c.scene), at, name, level, why: String(c.why ?? "").slice(0, 200) }];
      });
    };
    const plan: SoundPlan = { music: read(input.music, "music"), effects: read(input.effects, "effects") };
    if (problems.length) return fail(`The sound was not taken:\n- ${problems.join("\n- ")}`);
    ctx.draft.sound = plan;
    ctx.save();
    const said = (c: SoundPlan["music"][number]) => `${c.name} at ${c.scene} @${c.at}, ${c.level} dB`;
    return {
      text: [
        `Sound taken: ${plan.music.length ? `music ${plan.music.map(said).join("; ")}` : "no music"}; ${plan.effects.length ? `effects ${plan.effects.map(said).join("; ")}` : "no effects"}.`,
        "Levels are kept in range, and an effect closer than " + EFFECT_GAP + " s to the one before is left out. It is mixed under the voice when the video renders.",
      ].join("\n"),
    };
  },
};

const finish: Tool = {
  name: "finish",
  description:
    "End the work, when the video is ready. Every beat must have a source that builds, since the engine draws only those. When your last render is the video as it stands, the person gets that file; otherwise Open Sourcebook voices and renders it once more after you stop. Once a video, when Open Sourcebook's record shows a step was skipped (never rendered; the render the person would get never watched nor its viewer report read, saying which earlier render was; a viewer report, manual or shown with render, that listed things with no scene changed since), it answers with those facts instead of ending. After it answers that the video is taken, stop.",
  inputSchema: { type: "object", properties: { note: { type: "string", description: "Anything the person should know, in one or two sentences." } } },
  async run(input, ctx) {
    // What Open Sourcebook would hold against the video at the end is said here, while the agent can still fix it.
    const why = [...unfinished(ctx.draft), ...(ctx.draft.script && !ctx.draft.script.idea.trim() ? ["the video has no idea yet: say in a sentence what the viewer understands by the end, with about_video (idea)."] : [])];
    if (why.length) return fail(`Not yet:\n- ${why.join("\n- ")}`);
    await settled(ctx.folder, 75_000);
    // Once a video, and only when Open Sourcebook's own record shows a step skipped: the facts, phone frames and findings if a cut exists, and the video not yet handed over.
    const facts = ctx.draft.finishAnswered ? [] : skippedSteps(ctx);
    if (facts.length) {
      ctx.draft.finishAnswered = true;
      ctx.save();
      const key = scenesKey(ctx.draft);
      const cut =
        currentCut(ctx) ??
        (ctx.draft.cut &&
        ((ctx.draft.report?.cut === ctx.draft.cut.number && ctx.draft.report.scenes === key) ||
          (ctx.draft.renderReport?.cut === ctx.draft.cut.number && ctx.draft.renderReport.scenes === key))
          ? ctx.draft.cut
          : undefined);
      if (cut && existsSync(join(ctx.folder, cut.file))) {
        const insp = await cutInspection(ctx, cut, `finish-${cut.number}`);
        if (insp.images.length > 0 || insp.report !== undefined) {
          ctx.draft.seenCut = cut.number;
          ctx.save();
          return {
            text: [
              finishAnswer(facts),
              `Cut ${cut.number}:`,
              ...insp.findingsLines,
              ...(insp.images.length ? [`${insp.frameLines.length} frames of cut ${cut.number} below at phone size (${PHONE_TILE} pixels wide), left to right and down:`, ...insp.frameLines] : []),
            ]
              .filter(Boolean)
              .join("\n"),
            ...(insp.images.length ? { images: insp.images } : {}),
          };
        }
      }
      return { text: finishAnswer(facts) };
    }
    ctx.draft.sceneCount = ctx.draft.script?.scenes.length ?? 0;
    ctx.step("Finishing");
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : "";
    ctx.draft.finished = note || ctx.draft.short ? { note: [note, ctx.draft.short && !note.includes(ctx.draft.short) ? `Shorter than asked: ${ctx.draft.short}` : ""].filter(Boolean).join(" ").slice(0, 600) } : {};
    ctx.save();
    const cut = currentCut(ctx);
    // What the agent has seen of what the person gets, as a fact: the finish is taken either way.
    const running = renders.get(ctx.folder);
    const unseen = cut
      ? ctx.draft.seenCut === cut.number
        ? ""
        : ` You did not watch cut ${cut.number} or read its viewer report: the person gets a video you have not seen.`
      : running && !running.result && !running.error
        ? ` A render was still running (${Math.round(running.progress * 100)}% of its frames) and nothing of it was seen: the person gets a video you have not seen.`
        : ` No render of the video as it stands was made, so you have not seen it as the person will: the person gets a video you have not seen.`;
    const then = unseen ? " watch and viewer_report still answer until you stop; a change you make after this takes the finish back until you call it again. Otherwise stop now." : " Stop now.";
    // With the voice out there is no render to see: the video waits for it, and the person is told.
    if (ctx.draft.voiceDown && !cut) return { text: "The video is taken. The voice cannot speak for now, so it is not voiced or rendered yet: it waits for the voice, and the person is told why and that they may finish it without sound instead. Stop now." };
    return { text: cut ? `The video is taken: cut ${cut.number}, as you last rendered it.${unseen}${then}` : `The video is taken. It is voiced and rendered as it stands after you stop.${unseen}${then}` };
  },
};

/** What the scenes are, words and pictures: it changes when any beat's narration or source does. */
export function scenesKey(draft: Draft): string {
  const scenes = (draft.script?.scenes ?? []).map((s) => [s.id, withPauses(s), draft.scenes[s.id]?.source ?? ""]);
  return createHash("sha256").update(JSON.stringify(scenes)).digest("hex").slice(0, 16);
}

/**
 * The steps Open Sourcebook's own record shows were skipped, as facts, when the agent calls finish: the video never rendered; a
 * render never watched and its viewer report never read; the last viewer report listing things with no scene changed
 * since it was read. With a render still running, that it is, and that watch and the report wait for it. Empty when
 * nothing was skipped.
 */
export function skippedSteps(ctx: ToolContext): string[] {
  const d = ctx.draft;
  // No render can be made while the voice is out, so not having seen one is no skipped step.
  if (d.voiceDown) return [];
  const r = renders.get(ctx.folder);
  const running = !!r && !r.result && !r.error;
  // What was seen, cut by cut, from the same record the job's record of the making reads.
  const byCut = seenByCut(seenOf(d));
  const seen = byCut.size > 0;
  const facts: string[] = [];
  const earlier = () => [...byCut.keys()].map((n) => `cut ${n}`).join(" and ");
  if (running && !seen) facts.push(`A render is still running (${Math.round(r!.progress * 100)}% of its frames), and nothing of any render has been seen yet. watch and viewer_report wait for it.`);
  else if (!d.cut) facts.push("The video was never rendered: it has not existed yet as the viewer will meet it, with the real voice and its pace, the cuts and the captions.");
  else if (!seen) facts.push(`The video was rendered (cut ${d.cut.number}), but no render was ever watched and its viewer report was never read.`);
  else if (!running) {
    // Something was seen: say whether it was the render the person would get, or an earlier one.
    const handed = currentCut(ctx);
    if (handed && !byCut.has(handed.number)) facts.push(`Cut ${handed.number}, the video as it stands and the file the person would get, was never watched and its viewer report never read; what was seen was ${earlier()}, an earlier render.`);
    else if (!handed) facts.push(`The video has changed since cut ${d.cut.number}, the last render (seen: ${earlier()}): what the person would get is rendered after you stop, and nobody has seen it.`);
  }
  const key = scenesKey(d);
  if (d.report && d.report.things > 0 && d.report.scenes === key) facts.push(`The viewer report for cut ${d.report.cut} listed ${d.report.things === 1 ? "one thing" : `${d.report.things} things`} a viewer would notice, and no scene has changed since it was read.`);
  else if (d.renderReport && d.renderReport.things > 0 && d.renderReport.scenes === key) facts.push(`The viewer report shown with cut ${d.renderReport.cut} listed ${d.renderReport.things === 1 ? "one thing" : `${d.renderReport.things} things`} a viewer would notice, and no scene has changed since it rendered.`);
  return facts;
}

/**
 * Each render seen, in order, from the record of the calls; for a draft kept before that record had it, the last cut
 * watched and the last report read.
 */
export function seenOf(d: Draft): Seen[] {
  if (d.made?.seen) return d.made.seen;
  return [...(d.watchedCut !== undefined ? [{ cut: d.watchedCut, how: "watch" as const, afterAnswer: false }] : []), ...(d.report ? [{ cut: d.report.cut, how: "report" as const, afterAnswer: false }] : [])];
}

/** finish's one answer when a step was skipped: what is true, and that calling finish again hands the video over as it is. */
const finishAnswer = (facts: string[]) =>
  [FACTS_HEAD, ...facts.map((f) => `- ${f}`), "Open Sourcebook says this once. Calling finish again hands the video over as it is."].join("\n");

/**
 * The whole video at a glance: every given scene's opening and end as small stills, one column a scene, at most six
 * scenes a sheet, tiled into JPEGs in the job's folder.
 */
async function reviewSheets(ctx: ToolContext, ids: string[]): Promise<string[]> {
  const folder = join(ctx.folder, "watch", String((ctx.draft.watched ?? 0) + 1));
  const sheets: string[] = [];
  for (let from = 0; from < ids.length; from += 6) {
    const group = ids.slice(from, from + 6);
    const opens: string[] = [];
    const ends: string[] = [];
    for (const id of group) {
      const c = sceneContext(ctx, id)!;
      const built = await buildScene(c, ctx.draft.scenes[id]!.source!, join(ctx.folder, "build"));
      if (!built.ok || !built.scene) throw new Error(`${id} no longer builds`);
      const f = built.scene.frames;
      const [a, b] = await renderStills(await forStills(built.scene, c.assets?.root), built.theme, [Math.min(f - 1, Math.round(built.scene.fps * 0.4)), Math.max(0, f - 2)], join(folder, id), 0.25);
      opens.push(a!);
      ends.push(b!);
    }
    const out = join(folder, `sheet-${from / 6 + 1}.jpg`);
    const inputs = [...opens, ...ends].flatMap((f) => ["-i", f]);
    const n = group.length;
    const tiles = [...opens, ...ends].map((_, i) => `[${i}:v]scale=270:480,pad=278:488:4:4:color=gray[t${i}]`).join(";");
    const layout = [...opens, ...ends].map((_, i) => `${(i % n) * 278}_${Math.floor(i / n) * 488}`).join("|");
    await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", `${tiles};${[...opens, ...ends].map((_, i) => `[t${i}]`).join("")}xstack=inputs=${n * 2}:layout=${layout}[out]`, "-map", "[out]", "-frames:v", "1", "-q:v", "4", out]);
    sheets.push(out);
  }
  return sheets;
}

/** Why the writing cannot end yet: a scene with no source, or one the engine cannot build. Empty when it can. */
export function unfinished(draft: Draft): string[] {
  if (!draft.script?.scenes.length) return ["there is no beat yet (write_beat)."];
  return draft.script.scenes.flatMap((s) => {
    const d = draft.scenes[s.id];
    if (!d?.source) return [`${s.id} has no picture (write_beat with source).`];
    if (!d.built) return [`${s.id}'s picture does not build (write_beat).`];
    return [];
  });
}

export const TOOLS: Tool[] = [readPassages, readSkillTool, aboutVideo, writeBeat, look, render, watch, viewerReport, sound, finish, ...SHELF_TOOLS];

/** The video tools, then the toolbox's tools this computer can run. */
export const listing = (toolbox?: PictureToolbox) => [...TOOLS, ...boxTools(toolbox)].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

export async function callTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolAnswer> {
  const tool = TOOLS.find((t) => t.name === name) ?? boxTools(ctx.toolbox).find((t) => t.name === name) ?? (BOX_TOOLS.some((t) => t.name === name) ? { run: async () => fail(`${name} can't run on this computer now.`) } : undefined);
  if (!tool) return fail(`There is no tool "${name}".`);
  ctx.draft.toolCalls += 1;
  const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const ids = (d: Draft) => new Set((d.script?.scenes ?? []).map((s) => s.id));
  const before = ids(ctx.draft);
  let answer: ToolAnswer;
  try {
    answer = await tool.run(args, ctx);
  } catch (e) {
    const down = voiceDownOf(e);
    // The voice going away is a fact to know once, not a failure to try again.
    if (down) answer = fail(voiceWentDown(ctx, down));
    else answer = fail(`That failed in the service: ${(e as Error).message.slice(0, 400)}. Try once more; if it fails again, change what you sent.`);
  }
  // The record of how the video is made, from the call as Open Sourcebook answered it: the beat a write_beat changed, added or removed.
  const named = typeof args.beat === "string" && args.beat.trim() ? args.beat.trim() : undefined;
  const beat = named ?? [...ids(ctx.draft)].find((id) => !before.has(id));
  noteCall((ctx.draft.made ??= emptyMaking()), name, args, answer, beat);
  ctx.save();
  return answer;
}

/** How the video was made, from the record of the calls and the draft as it stands. */
export function makingOf(draft: Draft, handedOver?: number | "after"): Making {
  const log = { ...withDefaults(draft.made), seen: seenOf(draft) };
  const sources = Object.values(draft.scenes).map((s) => s.source ?? "");
  return {
    ...log,
    beats: draft.script?.scenes.length ?? 0,
    piecesUsed: piecesIn(sources, shelf().map((p) => p.name)),
    watchedRender: draft.watchedCut !== undefined,
    readReport: log.reportsRead > 0 || draft.report !== undefined,
    finishAnswered: !!draft.finishAnswered,
    ...(draft.review ? { review: reviewSummary(draft.review) } : {}),
    ...(handedOver !== undefined ? { handedOver } : {}),
  };
}
