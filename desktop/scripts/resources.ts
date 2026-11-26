/**
 * `npm run resources`: stages what the app carries inside itself in `out/resources`, for a run from this folder
 * (`npm start`) and for `npm run package`, which copies it into the app.
 *
 *   node/       Node with npm, from nodejs.org, checked against its published checksum (kept in .cache/ between builds)
 *   installer/  the one-line install's library (install/package/lib): puts files in place, fetches ffmpeg
 *   payload/    the programs, as the archive of the repo's last commit, and which version that is
 *
 * The payload is made from what is committed (git archive), never from files that are only on this computer.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NODE_VERSION = "24.22.3";
export const DESKTOP = join(import.meta.dirname, "..");
export const REPO = join(DESKTOP, "..");
export const RESOURCES = join(DESKTOP, "out", "resources");
const CACHE = join(DESKTOP, ".cache");

/** The folders of the repo the desktop programs never use, left out of the payload. */
const LEFT_OUT = ["ios", "desktop"];

const nodeArch = (arch: string) => (arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch);

async function download(url: string): Promise<Buffer> {
  const answer = await fetch(url, { redirect: "follow" });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return Buffer.from(await answer.arrayBuffer());
}

/** Node for this computer's system and chip, checked against nodejs.org's SHASUMS256.txt, unpacked into `dest`. */
export async function stageNode(dest: string, platform = process.platform, arch = process.arch): Promise<void> {
  if (platform === "win32") throw new Error("Staging Node for Windows is not done yet (the Windows app is its own step).");
  const name = `node-v${NODE_VERSION}-${platform}-${nodeArch(arch)}`;
  const file = `${name}.tar.gz`;
  const cached = join(CACHE, file);
  mkdirSync(CACHE, { recursive: true });
  const sums = (await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).toString("utf8");
  const want = sums.split("\n").find((line) => line.trim().endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`nodejs.org lists no ${file}.`);
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  if (!existsSync(cached) || sha(readFileSync(cached)) !== want) {
    console.log(`Downloading ${file}`);
    const data = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`);
    if (sha(data) !== want) throw new Error(`${file} does not match its checksum.`);
    writeFileSync(cached, data);
  }
  const unpacked = join(CACHE, name);
  rmSync(unpacked, { recursive: true, force: true });
  execFileSync("tar", ["-xzf", cached, "-C", CACHE]);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, "lib"), { recursive: true });
  // Node itself, npm and npx (the launcher installs each program's packages with npm); not the headers or the manuals.
  // npm and npx are small scripts instead of Node's links, since a link inside a signed app must not point outside it
  // and the packager's copy makes every link an absolute one.
  mkdirSync(join(dest, "bin"), { recursive: true });
  cpSync(join(unpacked, "bin", "node"), join(dest, "bin", "node"));
  cpSync(join(unpacked, "lib", "node_modules", "npm"), join(dest, "lib", "node_modules", "npm"), { recursive: true, verbatimSymlinks: true });
  cpSync(join(unpacked, "LICENSE"), join(dest, "LICENSE"));
  for (const tool of ["npm", "npx"]) {
    const script = join(dest, "bin", tool);
    writeFileSync(script, `#!/bin/sh\nhere="$(cd "$(dirname "$0")" && pwd)"\nexec "$here/node" "$here/../lib/node_modules/npm/bin/${tool}-cli.js" "$@"\n`);
    chmodSync(script, 0o755);
  }
  rmSync(unpacked, { recursive: true, force: true });
  const links = execFileSync("find", [dest, "-type", "l"], { encoding: "utf8" }).trim();
  if (links) throw new Error(`Node's files still hold links, which the signed app cannot carry:\n${links}`);
}

export function stageInstaller(dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(REPO, "install", "package", "lib"), dest, { recursive: true });
  // The library's .mjs files are modules whatever the folder they sit in.
  writeFileSync(join(dest, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
}

/** The programs at the repo's last commit, as the archive the installer's library puts in place. */
export function stagePayload(dest: string): { version: string; commit: string } {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
  const commit = git("rev-parse", "--short=12", "HEAD");
  const version = (JSON.parse(git("show", "HEAD:package.json")) as { version: string }).version;
  git("archive", "--format=tar.gz", "--prefix=opensourcebook/", "-o", join(dest, "opensourcebook.tar.gz"), "HEAD", "--", ".", ...LEFT_OUT.map((dir) => `:(exclude)${dir}`));
  const info = { version, commit };
  writeFileSync(join(dest, "payload.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export async function stageAll(): Promise<void> {
  mkdirSync(RESOURCES, { recursive: true });
  await stageNode(join(RESOURCES, "node"));
  stageInstaller(join(RESOURCES, "installer"));
  const payload = stagePayload(join(RESOURCES, "payload"));
  console.log(`Staged Node ${NODE_VERSION}, the installer's library and Open Sourcebook ${payload.version} (${payload.commit}) in ${RESOURCES}`);
}

if (import.meta.main) await stageAll();
