/**
 * After the writing: the voice speaks every scene (unless it already did while the agent wrote), every scene is built
 * again on those word times, and the video is laid out, its voice mixed with the music and effects the agent chose,
 * and rendered to an mp4.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { mix, placements } from "./sound.ts";
import { render, WAIT_WORDS } from "../pipeline/stages/render.ts";
import { buildScene } from "./scene.ts";
import { sceneContext, styleOf, type ToolContext } from "./tools.ts";
import { speakBeats, spokenAs } from "./beats.ts";
import { howLong, LEAST_FRAMES, speedBook } from "./speed.ts";
import { joinVoice, layOut, type Laid, type Placed } from "./timeline.ts";
import type { Spoken } from "./voice.ts";
import { assetsIn, type Asset } from "./toolbox/assets.ts";

/**
 * Speaks every scene whose timing is only estimated, out of date, or has no audio from a real voice (or its file is
 * gone). A scene whose voice is kept, with its file, is never spoken again, so a voicing cut off and made again buys
 * nothing twice.
 */
export async function voiceAll(ctx: ToolContext): Promise<Spoken[]> {
  const script = ctx.draft.script!;
  const style = styleOf(ctx);
  const sound = ctx.voice.sound(style);
  const need = script.scenes.filter((s) => {
    const t = ctx.draft.timings[s.id];
    return !t || t.narration !== spokenAs(s) || t.estimated || (ctx.voice.real && !(t.audio && existsSync(t.audio))) || t.sound !== sound;
  });
  if (need.length) {
    Object.assign(ctx.draft.timings, await speakBeats(script, need.map((s) => s.id), ctx.voice, { folder: ctx.folder, style, force: true, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
    ctx.save();
  }
  return script.scenes.map((s) => {
    const t = ctx.draft.timings[s.id]!;
    return { id: s.id, seconds: t.timing.seconds, words: t.timing.words, ...(t.timing.holds?.length ? { holds: t.timing.holds } : {}), ...(t.audio ? { audio: t.audio } : {}) };
  });
}

/** Builds every scene on its real word times. The scenes that no longer build come back with their problems. */
export async function finalBuild(ctx: ToolContext, spoken: Spoken[]): Promise<{ placed: Placed[]; broken: Record<string, string[]> }> {
  const placed: Placed[] = [];
  const broken: Record<string, string[]> = {};
  for (const [i, s] of ctx.draft.script!.scenes.entries()) {
    const c = sceneContext(ctx, s.id)!;
    const built = await buildScene(c, ctx.draft.scenes[s.id]!.source!, join(ctx.folder, "build"));
    if (!built.ok || !built.scene) {
      broken[s.id] = built.problems;
      ctx.draft.scenes[s.id]!.built = false;
      ctx.draft.scenes[s.id]!.looked = false;
      continue;
    }
    placed.push({ id: s.id, scene: built.scene, theme: built.theme, spoken: spoken[i]!, ...(s.emphasis?.length ? { emphasis: s.emphasis } : {}) });
  }
  if (Object.keys(broken).length) {
    delete ctx.draft.finished;
    ctx.save();
  }
  return { placed, broken };
}

/** The kept pictures the finished scenes show, in the order they first appear. */
export function shownAssets(ctx: ToolContext): Asset[] {
  const kept = ctx.draft.pictures?.assets ?? {};
  const names = ctx.draft.script!.scenes.flatMap((s) => assetsIn(ctx.draft.scenes[s.id]?.source ?? ""));
  return [...new Set(names)].flatMap((n) => (kept[n] ? [kept[n]!] : []));
}

export interface Rendered {
  laid: Laid;
  path: string;
  bytes: number;
  durationMs: number;
  renderMs: number;
  /** What was mixed under the voice, and the master's measured loudness. */
  sound?: { music: string[]; effects: string[]; lufs: number; truePeak: number };
}

export async function renderVideo(ctx: ToolContext, placed: Placed[], spoken: Spoken[], onProgress: (p: number) => void): Promise<Rendered> {
  // The sources by name, each once on the end card (the quotes are counted for the record, never shown there).
  const sources = ctx.draft.script!.scenes.flatMap((s) => s.cites.map((c) => ({ title: ctx.request.passages.find((p) => p.id === c.passageId)?.sourceTitle ?? "", quotes: 1 }))).filter((s) => s.title);
  const shown = shownAssets(ctx);
  const laid = layOut(placed, styleOf(ctx), ctx.request.frame, sources, shown.flatMap((a) => (a.credit ? [a.credit] : [])), ctx.draft.script!.title || ctx.request.title, !ctx.voice.real);
  const voice = await joinVoice(laid, spoken, ctx.folder, ctx.signal);
  let sound: Rendered["sound"];
  if (voice) {
    // The sound goes under a real voice; a silent voice (no audio) stays silent.
    const seconds = laid.timeline.frames / laid.timeline.fps;
    const scenes = placed.map((p, i) => ({ id: p.id, offset: laid.offsets[i]!, words: p.spoken.words }));
    const { hits, music } = placements(ctx.draft.sound ?? { music: [], effects: [] }, scenes, seconds);
    const mixed = await mix({ voice: join(ctx.folder, voice), hits, music, seconds, folder: ctx.folder, kitDir: join(dirname(ctx.folder), ".kit"), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    sound = { music: music.filter((c) => c.level > -80).map((c) => c.name), effects: hits.map((h) => h.name), lufs: mixed.lufs, truePeak: mixed.truePeak };
    laid.timeline.audio = "mix.wav";
  } else laid.timeline.audio = "";
  const imageCredits = Object.fromEntries(shown.flatMap((a) => (a.credit ? [[a.file, a.credit]] : [])));
  // What this computer has drawn before says how long this will take (src/speed.ts); a style it has not drawn says nothing.
  const style = styleOf(ctx);
  const book = speedBook();
  let waited = false;
  const out = await render(laid.timeline, ctx.folder, {
    output: join(ctx.folder, "video.mp4"),
    imageCredits,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    // The person asked to use more of the computer (Settings › Videos): more frames at once, at normal priority.
    ...(ctx.request.faster ? { faster: true } : {}),
    onProgress,
    // Another video is drawing: this one waits its turn, and says so until it draws.
    onWait: () => {
      waited = true;
      ctx.step(WAIT_WORDS);
    },
    onStart: ({ frames, concurrency }) => {
      const seconds = book?.seconds(style, frames, concurrency);
      if (seconds !== undefined) ctx.step(`Drawing the video, ${howLong(seconds)} on this computer`);
      else if (waited) ctx.step("Drawing the video");
    },
    onNote: (words) => ctx.step(words),
    onDrawn: (drawn) => {
      if (drawn.frames >= LEAST_FRAMES) book?.record(style, { fps: drawn.frames / drawn.seconds, frames: drawn.frames, concurrency: drawn.concurrency, by: "render", setupSeconds: drawn.setupSeconds });
    },
  });
  return { laid, path: out.path, bytes: statSync(out.path).size, durationMs: Math.round((laid.timeline.frames / laid.timeline.fps) * 1000), renderMs: out.ms, ...(sound ? { sound } : {}) };
}
