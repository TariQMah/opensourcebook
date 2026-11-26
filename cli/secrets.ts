/**
 * The strings Open Sourcebook's programs share with each other, made once on this computer with a secure random generator and kept
 * in `.opensourcebook/secrets.json` (git-ignored, readable only by the person). Each program gets the ones it needs through its
 * environment (programs.ts). Nothing here prints a secret.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The shared strings, by the name the programs already read. */
export const SECRET_NAMES = [
  "OPENSOURCEBOOK_CLIENT_TOKEN", // engine and the web proxy
  "OPENSOURCEBOOK_CONNECTOR_TOKEN", // engine (CHAT_AGENT_TOKEN) and the connector
  "SCENES_CONNECTOR_TOKEN", // scenes and the connector (OPENSOURCEBOOK_CONNECTOR_SCENES_TOKEN): turns only in the scenes service's own folder
  "SCENES_TOKEN", // engine (SCENES_SERVICE_TOKEN) and the scenes service
  "PHONE_TOKEN", // the web proxy and the launcher's phone control (phone.ts)
  "FILES_TOKEN", // engine (LOCAL_FILES_TOKEN) and the launcher's answers about this computer's files (local-files.ts)
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];
export type Secrets = Record<SecretName, string>;

/** 32 random bytes as base64url: 43 characters, safe in env files and headers. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** What two of the names were called before the product was renamed. A file from then holds its tokens under these. */
const OLD_NAMES: Partial<Record<SecretName, string>> = {
  OPENSOURCEBOOK_CLIENT_TOKEN: "RE_CLIENT_TOKEN",
  OPENSOURCEBOOK_CONNECTOR_TOKEN: "RE_CONNECTOR_TOKEN",
};

const usable = (value: unknown): value is string => typeof value === "string" && value.length >= 16;

/** The value kept for a name: under the name itself, else under what it was called before the rename. */
function kept(stored: Record<string, unknown>, name: SecretName): string | undefined {
  if (usable(stored[name])) return stored[name];
  const old = OLD_NAMES[name];
  return old && usable(stored[old]) ? (stored[old] as string) : undefined;
}

function parseStored(file: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/**
 * Reads the secrets file and changes nothing: for the commands that talk to a running copy. A file from before the
 * rename gives the same tokens under the new names. Undefined when the file is not there or cannot be read; a name
 * the file lacks is left out.
 */
export function readSecrets(file: string): Partial<Secrets> | undefined {
  let stored: Record<string, unknown>;
  try {
    stored = parseStored(file);
  } catch {
    return undefined;
  }
  const secrets: Partial<Secrets> = {};
  for (const name of SECRET_NAMES) {
    const value = kept(stored, name);
    if (value) secrets[name] = value;
  }
  return secrets;
}

/**
 * Reads the secrets file, adds any name it lacks (keeping the ones already there), and writes it back only when
 * something was added or renamed. A token kept under a name from before the rename is carried over to the new name,
 * never made again: the phone app and anything else that holds it keeps working. The old name stays in the file too,
 * with the same value, so a launcher from before the rename reads what it always did. Returns the secrets and which
 * ones were made new.
 */
export function loadSecrets(file: string, make: () => string = newSecret): { secrets: Secrets; created: SecretName[] } {
  let stored: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      stored = parseStored(file);
    } catch {
      throw new Error(`${file} is damaged. Delete that file and start again; Open Sourcebook makes new passwords for its programs.`);
    }
  }
  const created: SecretName[] = [];
  let carried = false;
  const secrets = {} as Secrets;
  for (const name of SECRET_NAMES) {
    const value = kept(stored, name);
    if (value) {
      secrets[name] = value;
      if (stored[name] !== value) carried = true;
    } else {
      secrets[name] = make();
      created.push(name);
    }
  }
  if (created.length || carried) writePrivate(file, `${JSON.stringify({ ...stored, ...secrets }, null, 2)}\n`);
  return { secrets, created };
}

/** Writes a file only the person can read, in a folder only the person can open, replacing it in one step. */
export function writePrivate(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
