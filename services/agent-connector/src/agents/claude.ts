/**
 * Claude Code (`claude`), run headless for one turn of Open Sourcebook's chat with the
 * person's own login, as the CLI already has it: the unmodified program,
 * signed in by the person the normal way. Open Sourcebook only launches it; it never
 * reads, holds or passes on that login.
 *
 * Boxed in: it runs in an empty directory with every built-in tool off
 * (`--tools ""`), only Open Sourcebook's MCP server (`--strict-mcp-config`), only Open Sourcebook's
 * tools allowed and everything else refused without a prompt
 * (`--permission-mode dontAsk`), no settings files, slash commands or saved
 * session. Open Sourcebook's system prompt replaces the coding one, or is added to it
 * when the caller asks to keep the agent's own (a video's turn does).
 *
 * A turn that asks for a workspace (a folder of its own, e.g. a video's)
 * gets one of two:
 *
 * - Files only, on its own login: its file tools (read, write, edit,
 *   search) and nothing else of its own, no shell and no web, so its login
 *   has no way out. `--restricted` confines those tools to the folder (it
 *   also drops every tool that runs code, and WebFetch), the settings of the
 *   turn block reads and writes outside it besides, and only those tools are
 *   listed (`--tools`). Where there is a box it also runs inside it as a
 *   second wall: nothing of the person's is open but the folder, the
 *   program, and the places Claude Code keeps its own login and state
 *   (`~/.claude*`, the keychains, its cache), which it reaches the way it
 *   always does. Open Sourcebook reads none of it.
 * - Everything, with an API key the person gave the connector (`apiKey`):
 *   its shell, files, web search and fetch in that folder, inside the box
 *   (`../box.ts`). There it never uses the person's login and never holds
 *   any credential: its model calls go to this connector
 *   (`ANTHROPIC_BASE_URL`), signed with the turn's own secret, and the
 *   connector forwards them to Anthropic with the key. It keeps its settings
 *   in a folder of its own (`CLAUDE_CONFIG_DIR`), and the person's keychains
 *   and `~/.claude/.credentials.json` stay shut.
 *
 * The key also answers a turn when the CLI is not signed in.
 */
import { programOf } from "./locate.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { plainEnv, programReads, tempEnv, toolReads, within, type BoxSpec } from "../box.ts";
import { epochToIso, heardLimit } from "./limit.ts";
import { marks } from "./marks.ts";
import { agentEnv, allLines, firstLine, Remembered, run, saidOf, stop } from "./process.ts";
import type { AgentAdapter, AgentInfo, Problem, RunningTurn, TurnEnd, TurnSpec } from "./types.ts";
import type { Box, Reach } from "../box.ts";

export interface ClaudeOptions {
  bin?: string;
  /**
   * An Anthropic API key the person gave the connector (billed to them as API use). Used for a turn when the CLI is
   * not signed in, and for boxed turns, where only the connector holds it and adds it to the calls it forwards.
   */
  apiKey?: string;
  /** Where Anthropic's API is; only changed by tests. */
  apiOrigin?: string;
}

/** Its own tools that a full workspace turns on; everything else stays refused. */
export const WORKSPACE_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite"];

/** Its own tools in a files-only workspace: reading, writing, editing and searching files, and its to-do list. */
export const FILE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "TodoWrite"];

/** The settings of a files-only turn: its file tools refuse any path outside the folder, besides `--restricted`. */
export const FILES_SETTINGS = { permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true } };

/** A path in a permission rule: an absolute one starts with `//`. */
const rulePath = (path: string) => `/${path}`;

/**
 * Its own rules for what a turn may read beside its folder (`TurnSpec.workspace.reach`), as far as they can say it.
 * They open folders only, never a single file, and they follow a link to where it leads, so each file's folder is
 * added too (a job folder's own for its `README.md`, the person's for a source's original): `--add-dir` for those
 * folders, and every edit in what is opened refused (`deny` wins over every allow) except in a folder that holds the
 * workspace. They are the looser wall: such a turn runs only inside the box, which opens exactly those files and
 * folders and no more, and keeps every write in the workspace (`FilesOnly.reads`).
 */
export function claudeReach(reach: Reach | undefined, base: { permissions: Record<string, unknown> } = { permissions: {} }): { dirs: string[]; settings: { permissions: Record<string, unknown> } } {
  const read = [...(reach?.folders ?? []), ...(reach?.files ?? [])];
  if (!reach || !read.length) return { dirs: [], settings: base };
  const dirs = [...new Set([...reach.folders, ...reach.files.map((f) => dirname(f))])];
  const holdsWork = (dir: string) => reach.write.some((w) => within(w, dir));
  const denied = [...reach.folders.map((d) => `${rulePath(d)}/**`), ...reach.files.map(rulePath), ...dirs.filter((d) => !holdsWork(d) && !reach.folders.includes(d)).map((d) => `${rulePath(d)}/**`)];
  return { dirs, settings: { permissions: { ...base.permissions, deny: [...new Set(denied)].map((p) => `Edit(${p})`) } } };
}

const ANTHROPIC = "https://api.anthropic.com";

/** The model calls Claude Code makes, the only ones forwarded for it. */
export const anthropicAllows = (method: string, path: string) => method === "POST" && /^\/v1\/messages(\/count_tokens)?$/.test(path);

export const NO_CLAUDE_KEY = "Its shell and the web in a workspace need an Anthropic API key in Open Sourcebook's connector settings (OPENSOURCEBOOK_ANTHROPIC_API_KEY); without one it works there with its file tools only.";
export const CLAUDE_ON_KEY = "Answers with the Anthropic API key in Open Sourcebook's connector settings, billed to that key, as Claude Code is not signed in.";
export const CLAUDE_FILES = "Works in each piece of work's own folder with its file tools only (read, write, search), on your own Claude login: no shell or web of its own. An Anthropic API key in Open Sourcebook's connector settings adds those, in the box.";
export const CLAUDE_FULL = "Works in each piece of work's own folder with its own shell, files and web, walled in on this Mac, on the Anthropic API key in Open Sourcebook's connector settings.";

export function claudeAdapter(options: ClaudeOptions = {}): AgentAdapter {
  const name = options.bin ?? "claude";
  // Looked for again at each check and turn, also where it installs itself when that is not on the PATH (./locate.ts).
  const where = () => programOf(name, [".claude/local"]);
  // A turn on the key only when the CLI is not signed in; asked again at most every half minute.
  const login = new Remembered<{ signedIn?: boolean }>(30_000);
  return {
    id: "claude",
    label: "Claude Code",
    mark: marks.claude,
    maker: "anthropic",
    replacesWorkPrompt: true,
    // With its file tools only it runs inside the box where there is one, which opens what is beside its folder exactly.
    filesOnly: { note: CLAUDE_FILES, reads: true },
    boxing: {
      note: CLAUDE_FULL,
      unready: () => (options.apiKey ? undefined : NO_CLAUDE_KEY),
      upstream: () => (options.apiKey ? { origin: options.apiOrigin ?? ANTHROPIC, headers: { "x-api-key": options.apiKey }, allows: anthropicAllows } : undefined),
    },
    signIn: `${name} auth login`,
    // From its own install page.
    install: { command: "curl -fsSL https://claude.ai/install.sh | bash", url: "https://code.claude.com/docs/en/setup" },
    // The CLI's own aliases: each always means that family's newest model.
    models: [
      { id: "haiku", label: "Haiku", tier: "fast" },
      { id: "sonnet", label: "Sonnet", tier: "balanced" },
      { id: "opus", label: "Opus", tier: "strong" },
    ],
    // A fast one for a chat's many small steps; the middle one with high effort for long work such as a video.
    defaultModels: { chat: "haiku", work: "sonnet" },
    defaultEfforts: { work: "high" },
    // What `--effort` takes.
    efforts: [
      { id: "low", label: "Low", weight: "light" },
      { id: "medium", label: "Medium", weight: "medium" },
      { id: "high", label: "High", weight: "high" },
      { id: "xhigh", label: "Extra high", weight: "max" },
      { id: "max", label: "Max", weight: "max" },
    ],
    async info(): Promise<AgentInfo> {
      const bin = where();
      const version = await firstLine(bin, ["--version"]);
      if (version.missing || !version.text) return { installed: false };
      const status = await signedIn(bin);
      const onKey = status.signedIn === false && !!options.apiKey;
      return { installed: true, version: version.text.replace(/\s*\(Claude Code\)\s*$/, ""), ...status, ...(onKey ? { apiKey: true, note: CLAUDE_ON_KEY } : {}) };
    },
    run(spec: TurnSpec): RunningTurn {
      const bin = where();
      if (spec.workspace?.access === "full" && (!spec.workspace.model || !spec.workspace.box)) return { done: Promise.resolve({ ok: false, problem: "error", detail: NO_CLAUDE_KEY }), kill: () => undefined };
      // Passed via file so long prompts stay clear of OS argv limits; inside a boxed turn's own tmp when boxed.
      const promptDir = spec.workspace?.tmp ? undefined : mkdtempSync(join(tmpdir(), "opensourcebook-claude-prompt-"));
      const promptFile = spec.workspace?.tmp ? join(spec.workspace.tmp, "opensourcebook-system-prompt.txt") : join(promptDir!, "prompt.txt");
      writeFileSync(promptFile, spec.systemPrompt, { mode: 0o600 });
      const args = claudeArgs(spec, promptFile);
      const seen: StreamFacts = {};
      const drafts = spec.onDraft ? new ToolInputs(spec.mcp.name, spec.onDraft) : undefined;
      let killed = false;
      let child: ReturnType<typeof run>["child"] | undefined;
      const done = (async (): Promise<TurnEnd> => {
        try {
          let command: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
          if (spec.workspace?.access === "full") command = boxed(bin, args, spec);
          else {
            // Its own login as it has it; the key only when it has none.
            const onKey = !!options.apiKey && (await login.get(() => signedIn(bin))).signedIn === false;
            const env = agentEnv(process.env, { ...(onKey ? { ANTHROPIC_API_KEY: options.apiKey } : {}), ENABLE_TOOL_SEARCH: "false" });
            // A files-only workspace runs in the box too where there is one, reaching its own login as it always does.
            const box = spec.workspace?.box;
            command = box ? { ...box.wrap(bin, args, claudeFilesBoxSpec(bin, spec)), env: { ...env, ...claudeTempEnv(spec.workspace?.tmp) } } : { bin, args, env };
          }
          if (killed) return { ok: false, problem: "stopped" };
          const spawned = run(command.bin, command.args, { cwd: spec.cwd, stdin: spec.prompt, onLine: (line) => readLine(line, seen, drafts), env: command.env });
          child = spawned.child;
          const { code, stderr, missing } = await spawned.exited;
          if (missing) return { ok: false, problem: "agentMissing", detail: `${bin} was not found` };
          const facts = {
            ...(seen.model ? { model: seen.model } : {}),
            ...(seen.tokensIn !== undefined ? { tokensIn: seen.tokensIn } : {}),
            ...(seen.inputTokens !== undefined ? { inputTokens: seen.inputTokens } : {}),
            ...(seen.firstTokensIn !== undefined ? { firstTokensIn: seen.firstTokensIn } : {}),
            ...(seen.tokensOut !== undefined ? { tokensOut: seen.tokensOut } : {}),
            ...(seen.cacheReadTokens !== undefined ? { cacheReadTokens: seen.cacheReadTokens } : {}),
            ...(seen.cacheWriteTokens !== undefined ? { cacheWriteTokens: seen.cacheWriteTokens } : {}),
            ...(seen.costUsd !== undefined ? { costUsd: seen.costUsd } : {}),
          };
          if (killed) return { ok: false, problem: "stopped", ...facts };
          if (code === 0 && seen.resultOk) return { ok: true, ...(seen.text ? { text: seen.text } : {}), ...facts };
          const problem = await classify(bin, seen, stderr);
          const limit = problem === "agentLimit" ? heardLimit(`${seen.errorText ?? ""}\n${stderr}`, seen.limitResetsAt) : undefined;
          return { ok: false, problem, ...facts, ...(limit ? { limit } : {}), ...saidOf(seen.errorText), detail: `exit ${code}; ${(seen.errorText ?? stderr).slice(0, 300)}` };
        } finally {
          if (promptDir) rmSync(promptDir, { recursive: true, force: true });
        }
      })();
      return {
        done,
        kill() {
          killed = true;
          if (child) stop(child);
        },
      };
    },
  };
}

/**
 * A boxed turn's own temporary folder for Claude Code: TMPDIR for what it runs, and CLAUDE_CODE_TMPDIR for its own
 * scratch files, which it would otherwise keep in /tmp (shut in the box).
 */
export function claudeTempEnv(tmp: string | undefined): NodeJS.ProcessEnv {
  return tmp ? { ...tempEnv(tmp), CLAUDE_CODE_TMPDIR: tmp } : {};
}

/** Claude Code's settings folder for boxed turns: its own, never the person's ~/.claude. */
export const boxConfigDir = (tmp: string = tmpdir()) => join(tmp, "opensourcebook-claude-box");

/** The box Claude Code runs in for a turn with a workspace. */
export function claudeBoxSpec(bin: string, spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), tmp: string = tmpdir()): BoxSpec {
  return {
    workspace: spec.cwd,
    home,
    read: [...toolReads(env.PATH, home), ...programReads(bin, env.PATH, home)],
    // Its logs, which it writes beside the person's own sessions' logs; read and write, nothing else of theirs.
    write: [boxConfigDir(tmp), join(home, "Library", "Caches", "claude-cli-nodejs")],
    // Shut by the home folder's wall already; named again so nothing opened above (e.g. a program kept in ~/.claude/local) reaches them.
    deny: [join(home, ".claude", ".credentials.json"), join(home, ".claude.json")],
    connectorPort: spec.workspace!.connectorPort,
    ...(spec.workspace!.tmp ? { tmp: spec.workspace!.tmp } : {}),
  };
}

/**
 * The only environment boxed Claude Code gets: a few plain settings, its own settings folder, and where its model calls
 * go with the turn's secret, as a gateway's bearer token (`ANTHROPIC_AUTH_TOKEN`); the connector puts the key on.
 */
export function claudeBoxEnv(spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): NodeJS.ProcessEnv {
  return { ...plainEnv(env), ...claudeTempEnv(spec.workspace!.tmp), CLAUDE_CONFIG_DIR: boxConfigDir(tmp), ANTHROPIC_BASE_URL: spec.workspace!.model!.baseUrl, ANTHROPIC_AUTH_TOKEN: spec.workspace!.model!.secret, DISABLE_AUTOUPDATER: "1", ENABLE_TOOL_SEARCH: "false" };
}

/**
 * The box around a files-only turn: the folder, the program, and where Claude Code keeps its own login and state
 * (`~/.claude`, `~/.claude.json` and the like, the keychains, its cache), which it reaches the way it always does.
 * Everything else of the person's stays shut, and nothing outside the folder, its state and temporary folders can be
 * written. A second wall: the first is its own (`--restricted`), since it has no shell to go around it.
 */
export function claudeFilesBoxSpec(bin: string, spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): BoxSpec {
  return {
    workspace: spec.cwd,
    home,
    read: [...toolReads(env.PATH, home), ...programReads(bin, env.PATH, home)],
    write: [],
    own: [join(home, ".claude"), join(home, "Library", "Keychains"), join(home, "Library", "Caches", "claude-cli-nodejs")],
    connectorPort: spec.workspace!.connectorPort,
    ...(spec.workspace!.tmp ? { tmp: spec.workspace!.tmp } : {}),
  };
}

/** The command that runs Claude Code inside the box, for a turn with a full workspace, and the environment it gets. */
export function boxed(bin: string, args: string[], spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), tmp: string = tmpdir()): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  mkdirSync(boxConfigDir(tmp), { recursive: true, mode: 0o700 });
  return { ...(spec.workspace!.box as Box).wrap(bin, args, claudeBoxSpec(bin, spec, env, home, tmp)), env: claudeBoxEnv(spec, env, tmp) };
}

/** The command line for one turn. The prompt goes on stdin; when `promptFile` is given, the system prompt passes by path. */
export function claudeArgs(spec: TurnSpec, promptFile?: string): string[] {
  const mcp = { mcpServers: { [spec.mcp.name]: { type: "http", url: spec.mcp.url, headers: spec.mcp.headers } } };
  const access = spec.workspace?.access;
  const reach = spec.workspace?.reach;
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Its own tools: all of them in a full workspace (inside the box), its file tools confined to the folder in a
    // files-only one, none otherwise.
    ...(access === "full" ? (reach ? ["--settings", JSON.stringify(claudeReach(reach).settings)] : []) : access === "files" ? ["--restricted", "--tools", FILE_TOOLS.join(","), "--settings", JSON.stringify(claudeReach(reach, FILES_SETTINGS).settings)] : ["--tools", ""]),
    // The folders of what it may read beside its own (`claudeReach`, which keeps them read only).
    ...(access && reach ? claudeReach(reach).dirs.flatMap((dir) => ["--add-dir", dir]) : []),
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcp),
    "--allowedTools",
    [`mcp__${spec.mcp.name}`, ...(access === "full" ? WORKSPACE_TOOLS : access === "files" ? FILE_TOOLS : [])].join(","),
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--disable-slash-commands",
    // Open Sourcebook's prompt replaces the coding one, or is added to it when the caller keeps the agent's own.
    promptFile
      ? spec.keepAgentPrompt ? "--append-system-prompt-file" : "--system-prompt-file"
      : spec.keepAgentPrompt ? "--append-system-prompt" : "--system-prompt",
    promptFile ?? spec.systemPrompt,
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
    // Tool input as it is written, so Open Sourcebook can show a reply while the agent still writes it.
    ...(spec.onDraft ? ["--include-partial-messages"] : []),
  ];
}

/**
 * The input of each call to Open Sourcebook's tools while the agent writes it, from the
 * stream's `input_json_delta` events: each delta is added to its content
 * block's input and the whole input so far goes to `onDraft`.
 */
export class ToolInputs {
  private readonly open = new Map<number, { tool: string; input: string }>();
  private readonly server: string;
  private readonly onDraft: (tool: string, partialInput: string) => void;

  constructor(server: string, onDraft: (tool: string, partialInput: string) => void) {
    this.server = server;
    this.onDraft = onDraft;
  }

  read(event: Record<string, unknown>): void {
    const index = typeof event.index === "number" ? event.index : -1;
    if (event.type === "message_start") this.open.clear();
    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      const prefix = `mcp__${this.server}__`;
      if (block?.type === "tool_use" && typeof block.name === "string" && block.name.startsWith(prefix)) this.open.set(index, { tool: block.name.slice(prefix.length), input: "" });
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      const call = this.open.get(index);
      if (!call || delta?.type !== "input_json_delta" || typeof delta.partial_json !== "string") return;
      call.input += delta.partial_json;
      this.onDraft(call.tool, call.input);
    }
    if (event.type === "content_block_stop") this.open.delete(index);
  }
}

interface StreamFacts {
  model?: string;
  resultOk?: boolean;
  text?: string;
  errorText?: string;
  tokensIn?: number;
  inputTokens?: number;
  firstTokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  rateLimited?: boolean;
  /** When a refused rate limit resets, as the stream gave it. */
  limitResetsAt?: string;
}

function usageTokensIn(usage: Record<string, unknown> | undefined): number | undefined {
  if (!usage) return undefined;
  const count = (key: string) => (typeof usage[key] === "number" && Number.isFinite(usage[key] as number) ? (usage[key] as number) : 0);
  const total = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
  return total > 0 ? total : undefined;
}

/** One line of `--output-format stream-json`. Lines that are not JSON are ignored. */
export function readLine(line: string, seen: StreamFacts, drafts?: ToolInputs): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event.type === "stream_event" && drafts && typeof event.event === "object" && event.event !== null) drafts.read(event.event as Record<string, unknown>);
  if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") seen.model = event.model;
  if (event.type === "assistant") {
    const msg = event.message as Record<string, unknown> | undefined;
    if (!seen.model && typeof msg?.model === "string") seen.model = msg.model;
    if (seen.firstTokensIn === undefined) {
      const first = usageTokensIn(msg?.usage as Record<string, unknown> | undefined);
      if (first !== undefined) seen.firstTokensIn = first;
    }
  }
  if (event.type === "rate_limit_event") {
    const info = event.rate_limit_info as Record<string, unknown> | undefined;
    if (info?.status === "rejected") {
      seen.rateLimited = true;
      const resetsAt = epochToIso(info.resetsAt);
      if (resetsAt) seen.limitResetsAt = resetsAt;
    }
  }
  if (event.type === "result") {
    const usage = typeof event.usage === "object" && event.usage !== null ? (event.usage as Record<string, unknown>) : undefined;
    if (usage) {
      const num = (key: string) => (typeof usage[key] === "number" && Number.isFinite(usage[key] as number) ? (usage[key] as number) : undefined);
      const input = num("input_tokens");
      const cacheWrite = num("cache_creation_input_tokens");
      const cacheRead = num("cache_read_input_tokens");
      const output = num("output_tokens");
      if (input !== undefined) seen.inputTokens = input;
      if (cacheWrite !== undefined) seen.cacheWriteTokens = cacheWrite;
      if (cacheRead !== undefined) seen.cacheReadTokens = cacheRead;
      if (input !== undefined || cacheWrite !== undefined || cacheRead !== undefined) {
        seen.tokensIn = (input ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0);
      }
      if (seen.firstTokensIn === undefined && Array.isArray(usage.iterations) && usage.iterations.length > 0) {
        const first = usageTokensIn(usage.iterations[0] as Record<string, unknown> | undefined);
        if (first !== undefined) seen.firstTokensIn = first;
      }
      if (output !== undefined) seen.tokensOut = output;
    }
    if (typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)) seen.costUsd = event.total_cost_usd;
    const text = typeof event.result === "string" ? event.result : undefined;
    if (event.is_error === true || event.subtype !== "success") {
      seen.resultOk = false;
      seen.errorText = text ?? String(event.subtype ?? "error");
    } else {
      seen.resultOk = true;
      if (text) seen.text = text;
    }
  }
}

/** Why a turn failed, from what the CLI said, and its own login check when that is unclear. */
async function classify(bin: string, seen: StreamFacts, stderr: string): Promise<Problem> {
  const said = `${seen.errorText ?? ""}\n${stderr}`;
  if (seen.rateLimited || /usage limit|limit reached|rate limit|out of (extra )?usage|quota/i.test(said)) return "agentLimit";
  if (/log ?in|logged out|not logged|authenticat|invalid api key|oauth|unauthori[sz]ed/i.test(said)) return "agentSignedOut";
  const login = await signedIn(bin);
  return login.signedIn === false ? "agentSignedOut" : "error";
}

/** Whether the CLI says it is signed in (`claude auth status`); only that one field is read. */
async function signedIn(bin: string): Promise<{ signedIn?: boolean }> {
  const { lines } = await allLines(bin, ["auth", "status", "--json"]);
  try {
    const status = JSON.parse(lines.join("\n")) as { loggedIn?: unknown };
    return typeof status.loggedIn === "boolean" ? { signedIn: status.loggedIn } : {};
  } catch {
    return {};
  }
}
