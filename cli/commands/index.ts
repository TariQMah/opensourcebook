/**
 * The whole `opensourcebook` command: the groups in order, and the one place a command line is read, run and answered. A new
 * group is one file in this folder and one entry in GROUPS.
 */
import { join } from "node:path";
import { stateFolder } from "../state.ts";
import { agents, makers, styles } from "./makers.ts";
import { chats } from "./chats.ts";
import { devices } from "./devices.ts";
import { items } from "./items.ts";
import { make } from "./make.ts";
import { packs } from "./packs.ts";
import { picks } from "./picks.ts";
import { plans } from "./plans.ts";
import { projects } from "./projects.ts";
import { quiz } from "./quiz.ts";
import { cards } from "./cards.ts";
import { run } from "./run.ts";
import { skills } from "./skills.ts";
import { sources } from "./sources.ts";
import { update } from "./update.ts";
import { voice } from "./voice.ts";
import { rememberProject } from "./connect.ts";
import { Problem, describeAll, flagString, helpAll, helpCommand, helpGroup, parse, type Command, type Ctx, type Group } from "./table.ts";

export const GROUPS: Group[] = [run, projects, sources, chats, make, plans, items, quiz, cards, makers, picks, styles, agents, packs, skills, devices, voice, update];

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  root: string;
  home: string;
  /** See Ctx.settle. */
  settle?: (say: (line: string) => void) => string;
  pollMs: number;
}

const ROOT = join(import.meta.dirname, "..", "..");

export function defaultIo(): Io {
  return {
    stdout: (t) => process.stdout.write(`${t}\n`),
    stderr: (t) => process.stderr.write(`${t}\n`),
    env: process.env,
    cwd: process.cwd(),
    root: ROOT,
    // Where the state is now, moving nothing: only a start gives an old folder its new name (settle).
    home: stateFolder(ROOT, process.env),
    settle: (say) => stateFolder(ROOT, process.env, { settle: true, say }),
    pollMs: 1000,
  };
}

/** The launcher's own flags: `npm start -- --no-open` and the like still start Open Sourcebook. */
const LAUNCHER_FLAGS = new Set(["--no-open", "--ports-from", "--phone", "--no-phone", "--dev"]);

export function findGroup(word: string): Group | undefined {
  return GROUPS.find((g) => g.thing && (g.thing === word || g.aliases?.includes(word)));
}

/** The commands with no thing before them (`opensourcebook start`, `opensourcebook make`): every group whose thing is empty. */
const topLevel = (word: string): Command | undefined => GROUPS.filter((g) => !g.thing).flatMap((g) => g.commands).find((c) => c.action === word);

/** The command a line names and the words left for it, or what help to show. */
export function resolve(argv: string[]): { command: Command; words: string[] } | { help: string; json: Record<string, unknown> } {
  const [first, second, ...rest] = argv;
  const helpWord = (w: string | undefined) => w === "help" || w === "--help" || w === "-h";
  if (first === undefined || LAUNCHER_FLAGS.has(first)) return { command: topLevel("start")!, words: argv };
  if (helpWord(first)) {
    const words = [second, ...rest].filter((w): w is string => !!w && !w.startsWith("--"));
    if (!words.length) return { help: helpAll(GROUPS), json: describeAll(GROUPS) };
    const again = resolve([...words, "help"]);
    return "help" in again ? again : { help: helpCommand(again.command), json: describeAll([{ thing: "", about: "", commands: [again.command] }]) };
  }
  const top = topLevel(first);
  if (top) return helpWord(second) ? { help: helpCommand(top), json: describeAll([{ thing: "", about: "", commands: [top] }]) } : { command: top, words: argv.slice(1) };
  const group = findGroup(first);
  if (!group) throw new Problem("unknown_command", `opensourcebook does not know "${first}". Run "opensourcebook help" to see every command.`);
  const byDefault = group.default ? group.commands.find((c) => c.action === group.default) : undefined;
  if (second === undefined && byDefault) return { command: byDefault, words: [] };
  if (second === undefined || helpWord(second)) return { help: helpGroup(group), json: describeAll([group]) };
  const command = group.commands.find((c) => c.action === second);
  if (!command) throw new Problem("unknown_command", `"opensourcebook ${group.thing}" has no "${second}"; it has ${group.commands.map((c) => c.action).join(", ")}. Run "opensourcebook ${group.thing} help" for more.`);
  if (helpWord(rest[0]) && rest.length === 1) return { help: helpCommand(command), json: describeAll([{ thing: "", about: "", commands: [command] }]) };
  return { command, words: rest };
}

/** Runs one command line. Every answer ends here: JSON on stdout with --json, else plain words; never a stack trace. */
export async function runCommand(argv: string[], io: Io = defaultIo()): Promise<number> {
  const json = argv.includes("--json");
  const fail = (code: string, message: string, exit = 1) => {
    if (json) io.stdout(JSON.stringify({ ok: false, error: { code, message } }));
    else io.stderr(message);
    return exit;
  };
  try {
    // --json is for every command and may sit anywhere; the rest of the line names the command.
    const found = resolve(argv.filter((w) => w !== "--json"));
    if ("help" in found) {
      io.stdout(json ? JSON.stringify({ ok: true, ...found.json }) : found.help);
      return 0;
    }
    const parsed = parse(found.command, found.words);
    if (parsed.flags.help) {
      io.stdout(helpCommand(found.command));
      return 0;
    }
    const ctx: Ctx = { ...parsed, json, progress: (line) => io.stderr(`  ${line}`), env: io.env, cwd: io.cwd, root: io.root, home: io.home, ...(io.settle ? { settle: io.settle } : {}), pollMs: io.pollMs };
    const answer = await found.command.run(ctx);
    // A project named with --project becomes the one used last once a command has worked with it, so the next command needs no flag.
    const named = flagString(ctx, "project");
    if (named && (answer.exit ?? 0) === 0) rememberProject(ctx, named);
    if (json) io.stdout(JSON.stringify({ ok: true, ...answer.data }));
    else if (answer.text) io.stdout(answer.text);
    return answer.exit ?? 0;
  } catch (error) {
    if (error instanceof Problem) return fail(error.code, error.message, error.exit);
    if (io.env.OPENSOURCEBOOK_DEBUG) io.stderr(String((error as Error)?.stack ?? error));
    const said = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return fail("internal", `Something went wrong in the opensourcebook command: ${said}. Run it again with OPENSOURCEBOOK_DEBUG=1 to see the whole error.`);
  }
}
