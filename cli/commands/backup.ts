/**
 * `opensourcebook backup`: one backup of every project now, saved where the weekly one goes
 * (`<library>/Backups/Open Sourcebook backup <day>.zip`, cli/backups.ts), keeping the newest few as it does. The
 * weekly one counts from it. Settings › Backups turns the weekly one on and off.
 */
import { join } from "node:path";
import { BACKUPS_FOLDER, readBackupSettings, recordSaved, saveBackup } from "../backups.ts";
import { libraryOf } from "../local-files.ts";
import { runningEngine } from "./connect.ts";
import { Problem, type Group } from "./table.ts";

export const backup: Group = {
  thing: "",
  about: "Backing up every project:",
  commands: [
    {
      thing: "",
      action: "backup",
      summary: "back up every project now, into the library's Backups folder",
      shape: "{ file: string, removed: string[] }",
      more: `Saves "Open Sourcebook backup <day>.zip" in the ${BACKUPS_FOLDER} folder of your library and keeps the newest few (Settings > Backups says how many, and turns on a backup every week). Restore one in Settings > Backups.`,
      async run(ctx) {
        const engine = runningEngine(ctx);
        const settings = readBackupSettings(ctx.home);
        const library = libraryOf(ctx.home).folder;
        ctx.progress(`Backing up every project into ${join(library, BACKUPS_FOLDER)}. With many videos this can take a while.`);
        const now = new Date();
        let saved: { file: string; removed: string[] };
        try {
          saved = await saveBackup({ engine: engine.base, token: engine.token, library, keep: settings.keep, now });
        } catch (error) {
          throw new Problem("backup_failed", `The backup was not made: ${error instanceof Error ? error.message : String(error)}`);
        }
        recordSaved(ctx.home, saved.file, now);
        const older = saved.removed.length ? `\n${saved.removed.length} older backup${saved.removed.length === 1 ? " was" : "s were"} deleted; the newest ${settings.keep} are kept.` : "";
        return { data: { file: saved.file, removed: saved.removed }, text: `${saved.file}${older}` };
      },
    },
  ],
};
