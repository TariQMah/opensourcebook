// Stage 7: render the timeline with Remotion. The video's folder is the public dir, so asset paths stay relative.
// It takes the timeline and the folder, can be cancelled, and reports progress, so the scenes service can drive it.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundled, releaseBundles } from "../../engine/render/bundle.ts";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import type { Timeline } from "../../schemas/project.ts";
import { fewerAtOnce, framesAtOnce, lackedRoom, thisMachine, type Machine } from "../lib/frames-at-once.ts";
import { lowWhile } from "../lib/priority.ts";

// H.264 quality: 18 (the default) made a 5:40 video 378 MB. 23 is the usual choice for video on the web.
const CRF = Number(process.env.RENDER_CRF ?? 23);
// A smaller render for drafts and comparisons: 0.75 gives 810 by 1440 (the scale must give whole pixels).
const SCALE = Number(process.env.RENDER_SCALE ?? 1);
const ENTRY = resolve(import.meta.dirname, "../../video/index.ts");
// How long one frame may take before the renderer gives up on it, in milliseconds. A try that failed for lack of room
// gets longer: a computer that is short of room is a slow one.
const FRAME_TIMEOUT_MS = 45_000;

/** How many frames are drawn at once on this computer now (pipeline/lib/frames-at-once.ts); more when `faster`. */
export const atOnce = (machine: Machine = thisMachine(), faster = false) => framesAtOnce(machine, process.env, { faster });

/** What a person reads in the video's step while another video draws and this one waits its turn. */
export const WAIT_WORDS = "Waiting for the video before it to finish drawing";

// What a person reads in the video's step when a render has to be tried again, in plain words.
export const roomWords = (was: number, next: number) =>
  next < was
    ? `This computer is short of room to draw the video, so Open Sourcebook is trying again with fewer frames at a time (${next} instead of ${was}). It will take longer.`
    : "A frame took too long to draw on this computer, so Open Sourcebook is trying once more and giving it more time. It will take longer.";

// What the video's engine scenes hold. Remotion hands the props to the page for every frame, so their size costs on every
// frame: a 1.8 MB scene (6 minutes) rendered at 18 frames/s against 27 for the same frames with small props. Each engine
// scene goes into a JSON file in the video's folder instead, and the player loads it once per browser tab. Call it
// before bundling, since the bundle takes a copy of the folder.
export function playerProps(timeline: Timeline, folder: string, imageCredits: Record<string, string> = {}): { timeline: Timeline; scenes: Record<string, string>; imageCredits: Record<string, string> } {
  const scenes: Record<string, string> = {};
  const clips = timeline.clips.map((c) => {
    if (c.type !== "engine" || !c.scene) return c;
    const file = `engine-${c.shotId.replace(/[^\w-]/g, "_")}.json`;
    writeFileSync(join(folder, file), JSON.stringify(c.scene));
    scenes[c.shotId] = file;
    const { scene: _, ...rest } = c;
    return rest;
  });
  return { timeline: { ...timeline, clips }, scenes, imageCredits };
}

/** What a render measured about itself, for the speed this computer keeps (src/speed.ts). */
export interface Drawn {
  frames: number;
  /** Seconds spent drawing the frames, from the first asked for to the last done. */
  seconds: number;
  /** Seconds before the first frame: the page built, the browser started. */
  setupSeconds: number;
  /** Frames drawn at once in the try that worked. */
  concurrency: number;
}

export type RenderOptions = {
  output?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  log?: (line: string) => void;
  imageCredits?: Record<string, string>;
  /** Called before the drawing starts with how many frames it is and how many are drawn at once. */
  onStart?: (start: { frames: number; concurrency: number }) => void;
  /** Called with what a person should read when the render is tried again with fewer frames at once. */
  onNote?: (words: string) => void;
  /**
   * The person asked to use more of the computer to make videos faster (Settings › Videos): more frames at once, at
   * normal priority. Gently when absent: about half the computer, at low priority.
   */
  faster?: boolean;
  /** Called at once when another video is drawing, so this one waits its turn; then `onStart` when it draws. */
  onWait?: () => void;
  /** Called with what the render measured once it is done. */
  onDrawn?: (drawn: Drawn) => void;
  /** The renderer to draw with; the Remotion one when absent. A seam for tests that make a render fail. */
  renderer?: typeof renderMedia;
  /** The computer to count cores and memory of; this one when absent. A seam for tests, so a ladder does not depend on the machine they run on. */
  machine?: Machine;
};

// One render or measure at a time on this computer, whoever asks: each takes the processor and the memory the frames
// at once were counted for, and two at once ran a computer short of memory. One that comes while another draws waits
// its turn and says so (`onWait`). It draws at low priority, so the person's own apps come first (pipeline/lib/priority.ts),
// unless the person asked for speed.
let line: Promise<unknown> = Promise.resolve();
let drawing = 0;
function alone<T>(work: () => Promise<T>, onWait?: () => void, gentle = true): Promise<T> {
  if (drawing > 0) onWait?.();
  drawing++;
  const next = line
    .catch(() => undefined)
    .then(() => lowWhile(work, { gentle }))
    .finally(() => void drawing--);
  line = next;
  return next;
}

/**
 * Tries the work with the frames at once this computer allows, and while it fails for lack of room (the renderer
 * refused the number, a frame timed out, the browser ran out of memory or lost a tab) with fewer, down to one, then
 * once more at one with more time. Any other failure, or a stop, ends it at once. Returns what the working try gave.
 */
async function withRoom<T>(first: number, o: Pick<RenderOptions, "signal" | "log" | "onNote">, run: (concurrency: number, timeout: number) => Promise<T>): Promise<{ value: T; concurrency: number }> {
  // On a two-core computer this is [2, 1, 1]: two at once, then one, then one again with a longer frame timeout. The
  // last try repeats the last number because a computer already at one has nothing fewer to try, only more time.
  const ladder = fewerAtOnce(first);
  ladder.push(ladder[ladder.length - 1]!); // the last, with more time
  for (let i = 0; ; i++) {
    const concurrency = ladder[i]!;
    try {
      return { value: await run(concurrency, FRAME_TIMEOUT_MS * 2 ** i), concurrency };
    } catch (error) {
      if (o.signal?.aborted || i === ladder.length - 1 || !lackedRoom(error)) throw error;
      const next = ladder[i + 1]!;
      o.log?.(`render: ${(error as Error).message.split("\n")[0]}; trying again at ${next} frame${next === 1 ? "" : "s"} at once`);
      o.onNote?.(roomWords(concurrency, next));
    }
  }
}

/** Renders the timeline to `<folder>/video.mp4` (or `output`) and returns the file and how long it took. */
export function render(timeline: Timeline, folder: string, o: RenderOptions = {}): Promise<{ path: string; ms: number }> {
  return alone(() => renderNow(timeline, folder, o), o.onWait, !o.faster);
}

async function renderNow(timeline: Timeline, folder: string, o: RenderOptions): Promise<{ path: string; ms: number }> {
  const t0 = Date.now();
  const output = o.output ?? join(folder, "video.mp4");
  // Scene files first: the bundle copies the public dir as it is when bundling.
  const inputProps = playerProps(timeline, folder, o.imageCredits);
  const serveUrl = await bundled(ENTRY, { publicDir: resolve(folder) });
  const { cancelSignal, cancel } = makeCancelSignal();
  const abort = () => cancel();
  o.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (o.signal?.aborted) throw new Error("render stopped");
    // A Chrome to use instead of the one Remotion downloads, e.g. a shared chrome-headless-shell for worktrees.
    const browserExecutable = process.env.OPENSOURCEBOOK_CHROME || null;
    const composition = await selectComposition({ serveUrl, id: "OpenSourcebook", inputProps, browserExecutable });
    const first = atOnce(o.machine, o.faster);
    o.log?.(`render: ${first.frames} frame${first.frames === 1 ? "" : "s"} at once (${first.why})`);
    o.onStart?.({ frames: composition.durationInFrames, concurrency: first.frames });
    const draw = o.renderer ?? renderMedia;
    let t1 = Date.now();
    const { concurrency } = await withRoom(first.frames, o, (concurrency, timeout) => {
      t1 = Date.now();
      return draw({
        serveUrl,
        composition,
        inputProps,
        browserExecutable,
        codec: "h264",
        crf: CRF,
        imageFormat: "jpeg",
        concurrency,
        timeoutInMilliseconds: timeout,
        scale: SCALE,
        outputLocation: output,
        cancelSignal,
        onProgress: ({ progress }) => o.onProgress?.(progress),
      });
    });
    const seconds = (Date.now() - t1) / 1000;
    o.log?.(`render: ${composition.durationInFrames} frames in ${seconds.toFixed(0)} s, ${(composition.durationInFrames / seconds).toFixed(1)} frames/s at concurrency ${concurrency}, props ${(JSON.stringify(inputProps).length / 1024).toFixed(0)} KB`);
    o.onDrawn?.({ frames: composition.durationInFrames, seconds, setupSeconds: (t1 - t0) / 1000, concurrency });
  } finally {
    o.signal?.removeEventListener("abort", abort);
    await releaseBundles(ENTRY, resolve(folder));
  }
  return { path: output, ms: Date.now() - t0 };
}

/**
 * How long drawing each stretch of the timeline takes, in seconds, one render per stretch (`from` to `to`, frames
 * counted from 0), all from one page and one browser build. For the short measure of this computer's speed
 * (src/speed.ts). Returns the frames at once it ended up using.
 */
export function timeSpans(timeline: Timeline, folder: string, spans: { from: number; to: number }[], o: Pick<RenderOptions, "signal" | "log" | "renderer"> = {}): Promise<{ seconds: number[]; concurrency: number }> {
  return alone(async () => {
    const inputProps = playerProps(timeline, folder);
    const serveUrl = await bundled(ENTRY, { publicDir: resolve(folder) });
    try {
      const browserExecutable = process.env.OPENSOURCEBOOK_CHROME || null;
      const composition = await selectComposition({ serveUrl, id: "OpenSourcebook", inputProps, browserExecutable });
      const draw = o.renderer ?? renderMedia;
      const { value, concurrency } = await withRoom(atOnce().frames, o, async (concurrency, timeout) => {
        const seconds: number[] = [];
        for (const [i, span] of spans.entries()) {
          const t = Date.now();
          await draw({ serveUrl, composition, inputProps, browserExecutable, codec: "h264", crf: CRF, imageFormat: "jpeg", concurrency, timeoutInMilliseconds: timeout, scale: SCALE, frameRange: [span.from, span.to], outputLocation: join(folder, `.span-${i}.mp4`) });
          seconds.push((Date.now() - t) / 1000);
        }
        return seconds;
      });
      return { seconds: value, concurrency };
    } finally {
      await releaseBundles(ENTRY, resolve(folder));
    }
  });
}
