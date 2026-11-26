/**
 * Keeping the programs up to date without updating the app itself (which a system lets happen only for a signed app).
 *
 * The programs are files in the app data's `app/` folder. The app carries one version of them (its payload), put in
 * place on the first start. In the background, once the window shows Open Sourcebook, the newest release is asked for;
 * when it is newer than what is in place it is downloaded into `updates/` and put in place on the next start, before
 * the programs start. Putting files in place is the installer's own code (install/package/lib/archive.mjs): it changes
 * only the files the last version brought, so a person's projects and settings are never touched.
 *
 * A version is the root package.json's version (`0.2.0`), with the commit it was made from when known.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface Version {
  version: string;
  commit?: string;
  /** One line on what changed, from the release. */
  notes?: string;
}

export interface Installed extends Version {
  /** Where the files in `app/` came from: the app's own payload, or a release downloaded later. */
  source: "carried" | "release";
}

/** "v0.2.1" or "0.2.1-beta" as [0, 2, 1]; anything that is not a version as undefined. */
export function parseVersion(text: string | undefined): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec((text ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Below zero when a is older than b, zero when the same, above zero when newer. A version that is not one is the oldest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export type Plan = { kind: "keep" } | { kind: "carried"; version: Version } | { kind: "pending"; version: Version };

/**
 * What goes in `app/` at this start: the downloaded version when one waits and is newer than what is there, else the
 * carried one when nothing is there yet or it is newer (the app itself was replaced by a newer download). The same
 * version made from another commit replaces one that also came from the app (an app built again from newer files).
 */
export function planStart(installed: Installed | undefined, carried: Version, pending: Version | undefined): Plan {
  const pendingWins = pending && compareVersions(pending.version, carried.version) >= 0;
  if (!installed) return pendingWins ? { kind: "pending", version: pending! } : { kind: "carried", version: carried };
  if (pending && compareVersions(pending.version, installed.version) > 0 && pendingWins) return { kind: "pending", version: pending };
  const byCarried = compareVersions(carried.version, installed.version);
  if (byCarried > 0) return { kind: "carried", version: carried };
  if (byCarried === 0 && installed.source === "carried" && carried.commit && installed.commit !== carried.commit) return { kind: "carried", version: carried };
  return { kind: "keep" };
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** The downloaded version waiting in `updates/`, when its archive is whole. */
export function pendingUpdate(updates: string): (Version & { archive: string }) | undefined {
  const info = readJson<Version>(join(updates, "next.json"));
  const archive = join(updates, "next.tar.gz");
  return info && parseVersion(info.version) && existsSync(archive) ? { ...info, archive } : undefined;
}

export function dropPending(updates: string): void {
  rmSync(join(updates, "next.json"), { force: true });
  rmSync(join(updates, "next.tar.gz"), { force: true });
}

export interface Release extends Version {
  /** The archive of the programs: the release's own `opensourcebook-app.tar.gz`, else the source archive of its tag. */
  archive: string;
}

/** The first line of a release's notes that says something, without Markdown's marks. */
export function firstLine(body: string | undefined): string | undefined {
  for (const raw of (body ?? "").split("\n")) {
    const line = raw.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim();
    if (line) return line.length > 200 ? `${line.slice(0, 197)}...` : line;
  }
  return undefined;
}

export const ASSET_NAME = "opensourcebook-app.tar.gz";

/** A release from GitHub's answer for the latest one, or undefined when it is not a usable one. */
export function releaseFrom(answer: unknown): Release | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const a = answer as { tag_name?: unknown; body?: unknown; tarball_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown }> };
  if (a.draft || a.prerelease || typeof a.tag_name !== "string" || !parseVersion(a.tag_name)) return undefined;
  const asset = (a.assets ?? []).find((x) => x.name === ASSET_NAME && typeof x.browser_download_url === "string");
  const archive = (asset?.browser_download_url ?? a.tarball_url) as string | undefined;
  if (typeof archive !== "string" || !/^https:\/\//.test(archive)) return undefined;
  const notes = firstLine(typeof a.body === "string" ? a.body : undefined);
  return { version: a.tag_name.replace(/^v/, ""), archive, ...(notes ? { notes } : {}) };
}

type Fetch = typeof fetch;

/** The newest release of a GitHub repository ("owner/name"), or undefined when offline, slow or there is none. */
export async function latestRelease(repo: string, fetchImpl: Fetch = fetch, timeoutMs = 15_000): Promise<Release | undefined> {
  try {
    const answer = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "opensourcebook-desktop" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!answer.ok) return undefined;
    return releaseFrom(await answer.json());
  } catch {
    return undefined;
  }
}

/**
 * Asks for the newest release and downloads it into `updates/` when it is newer than both what is in place and what
 * already waits. Resolves with the version now waiting, or undefined when there is nothing new.
 */
export async function checkAndDownload(options: { repo: string; updates: string; installed: Version | undefined; fetchImpl?: Fetch }): Promise<Version | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const release = await latestRelease(options.repo, fetchImpl);
  if (!release) return undefined;
  if (options.installed && compareVersions(release.version, options.installed.version) <= 0) return undefined;
  const waiting = pendingUpdate(options.updates);
  if (waiting && compareVersions(release.version, waiting.version) <= 0) return undefined;
  mkdirSync(options.updates, { recursive: true });
  const part = join(options.updates, "next.tar.gz.part");
  try {
    const answer = await fetchImpl(release.archive, { redirect: "follow", headers: { "user-agent": "opensourcebook-desktop" } });
    if (!answer.ok || !answer.body) return undefined;
    await pipeline(Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream), createWriteStream(part));
    // The archive is whole before the note that it waits is written: a cut-off download is never put in place.
    dropPending(options.updates);
    renameSync(part, join(options.updates, "next.tar.gz"));
    const { archive: _archive, ...version } = release;
    writeJson(join(options.updates, "next.json"), version);
    return version;
  } catch {
    rmSync(part, { force: true });
    return undefined;
  }
}
