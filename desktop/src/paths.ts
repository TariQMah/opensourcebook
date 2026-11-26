/**
 * Where the desktop app keeps everything: one folder in the person's app data, never inside the app itself, so the
 * app can be replaced, moved or opened read-only from the download without losing a thing.
 *
 *   macOS    ~/Library/Application Support/Open Sourcebook
 *   Windows  %APPDATA%\Open Sourcebook
 *   Linux    $XDG_DATA_HOME/Open Sourcebook, else ~/.local/share/Open Sourcebook
 *
 * Inside it the programs sit in `app/`, put there and kept up to date the same way the one-line install does it
 * (install/package/lib/archive.mjs), and ffmpeg in `tools/` with links in `bin/` (install/package/lib/tools.mjs). The
 * launcher is told this folder in OPENSOURCEBOOK_APP_DATA and keeps the person's state, projects and jobs there too.
 */
import { homedir } from "node:os";
import { join, win32 } from "node:path";

export const APP_NAME = "Open Sourcebook";

/** The app data folder, or the one named in OPENSOURCEBOOK_APP_DATA. */
export function appDataRoot(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const set = env.OPENSOURCEBOOK_APP_DATA?.trim();
  if (set) return set;
  if (platform === "darwin") return join(home, "Library", "Application Support", APP_NAME);
  if (platform === "win32") return win32.join(env.APPDATA?.trim() || win32.join(home, "AppData", "Roaming"), APP_NAME);
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), APP_NAME);
}

export interface Layout {
  root: string;
  /** The programs (the repo's files): the launcher runs from here. */
  app: string;
  /** Which version is in `app/`, and where it came from (update.ts). */
  installed: string;
  /** A downloaded new version waiting for the next start. */
  updates: string;
  /** ffmpeg and ffprobe once fetched, and the folder put first on the PATH. */
  bin: string;
  /** The window's own browser data (its cookies, its cache). */
  shell: string;
  /** What the desktop app did and what the launcher said, for "Show log". */
  log: string;
}

export function layout(root: string): Layout {
  return {
    root,
    app: join(root, "app"),
    installed: join(root, "installed.json"),
    updates: join(root, "updates"),
    bin: join(root, "bin"),
    shell: join(root, "window"),
    log: join(root, "desktop.log"),
  };
}

/**
 * What the app carries inside itself (Contents/Resources in the .app): Node with npm, the installer's library, and the
 * programs as one archive. `npm run resources` stages the same folders in `out/resources` for a run from a clone.
 */
export interface Carried {
  node: string;
  installer: string;
  payload: string;
  payloadInfo: string;
}

export function carried(resources: string, platform: NodeJS.Platform = process.platform): Carried {
  return {
    node: platform === "win32" ? join(resources, "node", "node.exe") : join(resources, "node", "bin", "node"),
    installer: join(resources, "installer"),
    payload: join(resources, "payload", "opensourcebook.tar.gz"),
    payloadInfo: join(resources, "payload", "payload.json"),
  };
}
