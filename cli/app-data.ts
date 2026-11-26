/**
 * The app data folder (docs/JOB-FOLDER.md): one folder where Open Sourcebook keeps everything of a person's that is not
 * the programs, named by OPENSOURCEBOOK_APP_DATA (the desktop app sets it; on a Mac
 * `~/Library/Application Support/Open Sourcebook`). Inside it, `state/` is the launcher's state folder, `data/` the
 * engine's saved projects and files, and `jobs/` the scenes service's folder with one job folder per video. A setting
 * named on its own (OPENSOURCEBOOK_STATE, SCENES_DATA_DIR) still wins. Without it, a clone keeps everything where it
 * always did: `.opensourcebook/`, `engine/.wrangler/state` and `services/scenes/.data`.
 */
import { join } from "node:path";

export const APP_DATA_ENV = "OPENSOURCEBOOK_APP_DATA";

/** The app data folder, when one is named. */
export function appDataOf(env: NodeJS.ProcessEnv): string | undefined {
  return env[APP_DATA_ENV]?.trim() || undefined;
}

/** Points the state folder and the scenes service's folder into the app data folder, unless each is named already. */
export function useAppData(env: NodeJS.ProcessEnv): void {
  const root = appDataOf(env);
  if (!root) return;
  if (!env.OPENSOURCEBOOK_STATE?.trim()) env.OPENSOURCEBOOK_STATE = join(root, "state");
  if (!env.SCENES_DATA_DIR?.trim()) env.SCENES_DATA_DIR = join(root, "jobs");
}

/** Where the engine keeps its local database, queue and files (what `--persist-to` names): `data/` in the app data folder, else beside the engine. */
export function engineState(engineDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = appDataOf(env);
  return root ? join(root, "data") : join(engineDir, ".wrangler", "state");
}
