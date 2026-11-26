// How many frames the renderer draws at once on this computer, and what to try when a render cannot get the room.
//
// Every frame at once is a tab of headless Chrome with a frame's worth of memory, drawing on a core. The renderer
// refuses more tabs than the computer has cores, and a person's computer is running the rest of Open Sourcebook at the same time
// (the engine, the web app, their own agent and their own apps), so by default the service takes about half of the
// cores and a quarter of the memory, and the computer stays usable while a video draws; a video takes a little longer. `RENDER_CONCURRENCY` sets it by hand (never above the cores, which the renderer would
// refuse). It imports nothing from the service, so the launcher and the tests can read it.
import { cpus, totalmem } from "node:os";

export interface Machine {
  cores: number;
  /** Total memory, in bytes. */
  memory: number;
}

/** What one tab and its share of the encoder take, in megabytes: a 1080 by 1920 frame, its fonts and the scene. */
export const MEMORY_PER_FRAME_MB = 700;
/** The share of the cores and of the memory a render may take; the rest is for everything else that is running. */
export const CORE_SHARE = 0.5;
export const MEMORY_SHARE = 0.25;
/**
 * The shares for a person who asked to use more of the computer to make videos faster (Settings › Videos): most of
 * it, at normal priority, for a video they start and walk away from.
 */
export const FASTER_CORE_SHARE = 0.6;
export const FASTER_MEMORY_SHARE = 0.5;
/** Past this, more tabs stop helping (measured on a ten-core Mac) and only cost memory. */
export const MOST_AT_ONCE = 6;

/** This computer. `RENDER_CORES` makes the service count fewer cores than there are, for trying a smaller computer. */
export function thisMachine(env: Record<string, string | undefined> = process.env): Machine {
  const real = Math.max(1, cpus().length);
  const asked = Number(env.RENDER_CORES);
  return { cores: Number.isInteger(asked) && asked >= 1 ? Math.min(asked, real) : real, memory: totalmem() };
}

export interface AtOnce {
  /** Frames drawn at once. */
  frames: number;
  /** What decided it, in a line for the log. */
  why: string;
}

/**
 * The number from the machine alone: a share of the cores or of the memory, whichever is fewer, at least one. `faster`
 * takes the larger shares a person asked for.
 */
export function framesAtOnce(machine: Machine, env: Record<string, string | undefined> = process.env, o: { faster?: boolean } = {}): AtOnce {
  const cores = Math.max(1, Math.floor(machine.cores));
  const hand = env.RENDER_CONCURRENCY?.trim();
  if (hand) {
    const set = Number(hand);
    if (Number.isInteger(set) && set >= 1) return set > cores ? { frames: cores, why: `RENDER_CONCURRENCY=${set} is more than this computer's ${cores} cores, which the renderer refuses` } : { frames: set, why: `RENDER_CONCURRENCY=${set}` };
  }
  const byCores = Math.max(1, Math.floor(cores * (o.faster ? FASTER_CORE_SHARE : CORE_SHARE)));
  const byMemory = Math.max(1, Math.floor((machine.memory * (o.faster ? FASTER_MEMORY_SHARE : MEMORY_SHARE)) / (MEMORY_PER_FRAME_MB * 1024 * 1024)));
  const frames = Math.min(byCores, byMemory, MOST_AT_ONCE);
  return { frames, why: `${cores} cores and ${(machine.memory / 1024 ** 3).toFixed(0)} GB of memory allow ${byCores} by cores and ${byMemory} by memory${o.faster ? ", with more of the computer as the person asked" : ""}` };
}

/** The numbers to try, from the first down to one, halving each time: 6 gives 6, 3, 1. */
export function fewerAtOnce(first: number): number[] {
  const steps = [Math.max(1, Math.floor(first))];
  while (steps[steps.length - 1]! > 1) steps.push(Math.max(1, Math.floor(steps[steps.length - 1]! / 2)));
  return steps;
}

/**
 * Whether a render failed for lack of room, so trying again with fewer frames at once may work: the renderer refused
 * the number, a frame did not finish in time, the browser ran out of memory or its tab crashed or closed.
 */
export function lackedRoom(error: unknown): boolean {
  const words = error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error);
  return /concurrency|higher than the amount of CPU|timed out|timeout|delayRender|Target closed|Session closed|Page crashed|crash|out of memory|ENOMEM|SIGKILL|SIGSEGV|Protocol error|browser (was )?closed|Navigating frame was detached|socket hang up|WebSocket/i.test(words);
}
