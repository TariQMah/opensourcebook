import type { FolderCheck } from "../api/types";

/** What a look at the folder found, in one line. */
export function foundWords(found: FolderCheck): string {
  const parts = [
    found.added.length ? `${found.added.length} added` : "",
    found.changed.length ? `${found.changed.length} read again` : "",
    found.missing.length ? `${found.missing.length} no longer there` : "",
    found.failed.length ? `${found.failed.length} could not be read` : "",
  ].filter(Boolean);
  const said = parts.length ? `${parts.join(", ")}.` : "Nothing changed.";
  return found.more ? `${said} The folder holds more files than one look takes; only the first 1000 were looked at.` : said;
}
