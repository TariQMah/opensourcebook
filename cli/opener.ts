/**
 * How this computer's own browser is let into Open Sourcebook.
 *
 * The web app's proxy holds the engine's token, so whoever can call the web app's port could act as the person:
 * another user of this computer, or any program on it. So the proxy serves the engine only to a browser that holds
 * this run's browser key, in a cookie its scripts cannot read and other sites cannot send (web/worker/proxy.ts).
 *
 * The browser gets that cookie by opening a one-time address the launcher makes: `/api/open?code=...` on the web
 * app. `npm start` opens it; `opensourcebook open` (and `opensourcebook project open`, `opensourcebook item open`) makes a new one. The proxy asks the
 * launcher (its control server, phone.ts, with the phone token) whether the code is one it made; a code works once
 * and runs out after a few minutes, so an address left in a browser's history or seen in a process list opens
 * nothing later. The keys are made new at each start and never written to disk.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { writePrivate } from "./secrets.ts";

export const OPEN_CODE_LIFE_MS = 10 * 60_000;
/** At most this many codes are open at once; making another drops the oldest. */
const OPEN_AT_ONCE = 16;

/** The keys of one run: the browser's (in its cookie) and the door's (on everything the door passes on). */
export interface RunKeys {
  browser: string;
  door: string;
}

export function newRunKeys(): RunKeys {
  return { browser: randomBytes(32).toString("base64url"), door: randomBytes(32).toString("base64url") };
}

const digest = (code: string) => createHash("sha256").update(code, "utf8").digest();

export class OpenCodes {
  private open: Array<{ digest: Buffer; expiresAt: number }> = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A new one-time code. */
  issue(): { code: string; expiresAt: number } {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + OPEN_CODE_LIFE_MS;
    this.open.push({ digest: digest(code), expiresAt });
    if (this.open.length > OPEN_AT_ONCE) this.open.shift();
    return { code, expiresAt };
  }

  /** True once for a code this launcher made that has not run out; every code is compared in constant time. */
  redeem(code: unknown): boolean {
    const now = this.now();
    this.open = this.open.filter((o) => o.expiresAt > now);
    if (typeof code !== "string" || code.length > 64) return false;
    const given = digest(code);
    let at = -1;
    this.open.forEach((o, i) => {
      if (timingSafeEqual(o.digest, given) && at < 0) at = i;
    });
    if (at < 0) return false;
    this.open.splice(at, 1);
    return true;
  }
}

/** The address that lets this computer's browser in and then shows `to` (a path of the web app). */
export function openAddress(web: string, code: string, to = "/"): string {
  const path = to.startsWith("/") && !to.startsWith("//") ? to : "/";
  return `${web.replace(/\/$/, "")}/api/open?code=${encodeURIComponent(code)}&to=${encodeURIComponent(path)}`;
}

/**
 * Set by an app that shows Open Sourcebook in its own window (the desktop app, desktop/): a fresh page a tab from an
 * earlier run asks for is that window's to show, not the browser's. The launcher then writes `{ to, at }` in this file
 * instead of opening the browser, and the app, watching it, lets its window in again with its own new code. The file
 * holds no code, so nothing that lets a browser in is ever on the disk.
 */
export const OWN_WINDOW_ENV = "OPENSOURCEBOOK_REOPEN_FILE";

/** Asks the app's own window for a fresh page of `to`; false when the file could not be written. */
export function askOwnWindow(file: string, to: string, now: Date = new Date()): boolean {
  try {
    writePrivate(file, `${JSON.stringify({ to, at: now.toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}
