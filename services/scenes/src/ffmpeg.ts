/**
 * ffmpeg as a child process the service does not wait on: the service keeps answering while a long sound is mastered
 * or a narration is decoded. Stopping the job (its signal) ends ffmpeg too. It runs at low priority, so the person's
 * own apps come first (pipeline/lib/priority.ts).
 */
import { spawn } from "node:child_process";
import { lower } from "../pipeline/lib/priority.ts";

export interface Ran {
  stdout: Buffer;
  stderr: string;
}

/** Runs ffmpeg with these arguments, feeding it `input` on stdin when given. Rejects with the end of its log on failure. */
export function ffmpeg(args: string[], o: { input?: Uint8Array; signal?: AbortSignal } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error("stopped"));
    const child = spawn("ffmpeg", args, { stdio: [o.input ? "pipe" : "ignore", "pipe", "pipe"] });
    lower(child.pid);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const stop = () => child.kill("SIGKILL");
    o.signal?.addEventListener("abort", stop, { once: true });
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      o.signal?.removeEventListener("abort", stop);
      reject(e);
    });
    child.on("close", (code) => {
      o.signal?.removeEventListener("abort", stop);
      const stderr = Buffer.concat(err).toString("utf8");
      if (o.signal?.aborted) return reject(new Error("stopped"));
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${stderr.slice(-800)}`));
      resolve({ stdout: Buffer.concat(out), stderr });
    });
    if (o.input && child.stdin) {
      // ffmpeg may stop reading early (a bad input); its own exit code says what went wrong, not the broken pipe.
      child.stdin.on("error", () => {});
      child.stdin.end(o.input);
    }
  });
}
