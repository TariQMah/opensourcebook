// Drawing a video runs at low priority, so the person's own apps come first and the video only uses what is left.
//
// The headless Chrome that draws the frames, Remotion's encoder and ffmpeg are each lowered to below-normal priority:
// on macOS and Linux a nice level of 10, on Windows the below-normal priority class (`os.setPriority` maps one to the
// other). ffmpeg is lowered as soon as it is started (src/ffmpeg.ts). The renderer starts Chrome and its encoder
// itself, and Chrome starts more processes as it opens tabs, so while a render runs every process the service has
// started, and theirs, is lowered as it appears. It imports nothing from the service, so the tests can read it.
import { execFile } from "node:child_process";
import { constants, setPriority } from "node:os";

/** The priority a drawing runs at: 10 on macOS and Linux, below normal on Windows. */
export const LOW = constants.priority.PRIORITY_BELOW_NORMAL;
/** How often a running render looks for new processes to lower, in milliseconds. */
const EVERY_MS = 1_000;

/** Asks for low priority for one process. True when it was set; a process that already ended is no error. */
export function lower(pid: number | undefined, set: (pid: number, priority: number) => void = setPriority): boolean {
  if (!pid) return false;
  try {
    set(pid, LOW);
    return true;
  } catch {
    return false;
  }
}

/** Every process and its parent on this computer, as [pid, parent pid]. */
export function processes(platform: NodeJS.Platform = process.platform): Promise<[number, number][]> {
  const [file, args] =
    platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]]
      : ["ps", ["-A", "-o", "pid=,ppid="]];
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      const pairs: [number, number][] = [];
      for (const line of String(stdout).split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid && ppid !== undefined && Number.isInteger(ppid)) pairs.push([pid, ppid]);
      }
      resolve(pairs);
    });
  });
}

/** The processes under `root`, its children and theirs, from a list of [pid, parent pid]. */
export function under(root: number, pairs: [number, number][]): number[] {
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of pairs) if (pid !== ppid) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const todo = [root];
  while (todo.length) {
    for (const kid of kids.get(todo.pop()!) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      found.push(kid);
      todo.push(kid);
    }
  }
  return found;
}

export interface LowerSeams {
  /** False draws at normal priority, for a person who asked for speed; true when absent. */
  gentle?: boolean;
  /** Lists [pid, parent pid]; this computer's processes when absent. */
  list?: () => Promise<[number, number][]>;
  /** Sets a process's priority; `os.setPriority` when absent. */
  set?: (pid: number, priority: number) => void;
  /** The process whose children are lowered; this one when absent. */
  root?: number;
  everyMs?: number;
}

/**
 * Runs the work while lowering every process started under this one as it appears: the drawing browser and its tabs,
 * the encoder. Does nothing extra when drawing is not gentle (the person asked for speed).
 */
export async function lowWhile<T>(work: () => Promise<T>, o: LowerSeams = {}): Promise<T> {
  if (o.gentle === false) return work();
  const list = o.list ?? (() => processes());
  const root = o.root ?? process.pid;
  const lowered = new Set<number>();
  let looking = false;
  const look = async () => {
    if (looking) return;
    looking = true;
    try {
      for (const pid of under(root, await list())) if (!lowered.has(pid) && lower(pid, o.set)) lowered.add(pid);
    } finally {
      looking = false;
    }
  };
  const timer = setInterval(() => void look(), o.everyMs ?? EVERY_MS);
  timer.unref();
  void look();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
