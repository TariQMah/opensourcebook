/**
 * Cursor's CLI agent (`cursor-agent`, also installed as `agent`), run headless (`--print --output-format
 * stream-json`, the prompt on stdin) for one turn of Open Sourcebook's chat or a piece of work: the unmodified program, signed in
 * by the person the normal way (`cursor-agent login`, their Cursor account, or a `CURSOR_API_KEY` of their own in the
 * environment it was started with). Open Sourcebook only launches it and never reads, holds or passes on what it signs in with.
 *
 * Boxed in: an empty directory, trusted for this run only (`--trust`), and every setting of the turn in files of the
 * turn's own folder, never in the person's `~/.cursor`:
 * - its tools cut down to Open Sourcebook's for the run (`--allowed-tools`, by the names of its own tool calls: calling an MCP
 *   tool and listing them), so its shell, file tools, web, sub-agents and the rest are not offered at all;
 * - its settings for the run in a folder of the turn's own (`CURSOR_CONFIG_DIR`; its login is kept elsewhere, so it is
 *   still signed in): approvals by its allowlist only, Open Sourcebook's server's tools allowed (`Mcp(opensourcebook:*)`) and, as a second
 *   wall, its shell, the web and every file read and write refused (`Shell(*)`, `WebFetch(*)`, `Read(/**)`, …);
 * - Open Sourcebook's MCP server from a plugin of the turn's own (`--plugin-dir`, its `.mcp.json`), approved for the run
 *   (`--approve-mcps`); a model it is asked for is written to that folder's settings, not the person's.
 *
 * It takes no system prompt of a caller's, so Open Sourcebook's instructions open the prompt it gets on stdin, beside its own.
 *
 * A turn that asks for a workspace gets its file tools only there (read, edit, list, search, its to-do list), with
 * reads kept to the workspace (`sandbox.readBoundary`) and its settings allowing reads and writes in it; its shell,
 * the web and sub-agents stay off. It has no box here, so its own rules are the only wall. A folder holding a link
 * that leads out of it, or a `.cursor` folder (settings, rules, hooks or MCP servers it would read as the folder's
 * own), is refused at the start.
 *
 * Whether it is signed in it says itself (`cursor-agent status --format json`, reading only `isAuthenticated`). Its
 * JSON events give each tool call once it is made, not while it is written, so there are no drafts.
 */
import { programOf } from "./locate.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linksOut } from "./folder.ts";
import { heardLimit } from "./limit.ts";
import { agentEnv, allLines, firstLine, Remembered, run, saidOf, stop } from "./process.ts";
import { marks } from "./marks.ts";
import type { AgentAdapter, AgentInfo, AgentModel, Problem, RunningTurn, TurnEnd, TurnSpec } from "./types.ts";

export interface CursorOptions {
  bin?: string;
}

export const CURSOR_NOTE = "Answers with the Cursor account (or Cursor API key) Cursor's CLI agent is signed in with on this computer.";
export const CURSOR_FILES = "Works in each piece of work's own folder with its file tools only (read, write, search), on what Cursor's agent signs in with: no shell or web of its own.";

/** Its tools in every turn, by the names of its own tool calls: calling one of Open Sourcebook's tools, and listing them. */
export const CURSOR_MCP_TOOLS = ["mcp_tool_call", "get_mcp_tools_tool_call"];

/** Its file tools in a files-only folder, by the same names. */
export const CURSOR_FILE_TOOLS = ["read_tool_call", "edit_tool_call", "ls_tool_call", "glob_tool_call", "grep_tool_call", "update_todos_tool_call", "read_todos_tool_call"];

export function cursorAdapter(options: CursorOptions = {}): AgentAdapter {
  const name = options.bin ?? "cursor-agent";
  // Looked for again at each check and turn, also where it installs itself when that is not on the PATH (./locate.ts).
  const where = () => programOf(name);
  const catalog = new Remembered<AgentModel[]>(5 * 60_000);
  return {
    id: "cursor",
    label: "Cursor",
    mark: marks.cursor,
    signIn: `${name} login`,
    // From its own install page.
    install: { command: "curl https://cursor.com/install -fsS | bash", url: "https://cursor.com/docs/cli/installation" },
    filesOnly: { note: CURSOR_FILES },
    async info(): Promise<AgentInfo> {
      const bin = where();
      const version = await firstLine(bin, ["--version"]);
      if (version.missing || !version.text) return { installed: false };
      const [signedIn, models] = await Promise.all([cursorSignedIn(bin), catalog.get(() => cursorModels(bin))]);
      return {
        installed: true,
        version: version.text.replace(/^(cursor-agent|agent)\s+v?/i, ""),
        ...(signedIn !== undefined ? { signedIn } : {}),
        note: CURSOR_NOTE,
        ...(models.length ? { models } : {}),
      };
    },
    run(spec: TurnSpec): RunningTurn {
      const bin = where();
      if (spec.workspace?.access === "files") {
        const refused = cursorFolderProblem(spec.cwd);
        if (refused) return { done: Promise.resolve({ ok: false, problem: "error", detail: refused }), kill: () => undefined };
      }
      const own = mkdtempSync(join(tmpdir(), "opensourcebook-cursor-"));
      const files = writeCursorFiles(spec, own);
      const seen: CursorFacts = {};
      const spawned = run(bin, cursorArgs(spec, files.plugin), { cwd: spec.cwd, stdin: cursorPrompt(spec), env: cursorEnv(files.config), onLine: (line) => readCursorLine(line, seen) });
      let killed = false;
      const done = spawned.exited.then(({ code, stderr, missing }): TurnEnd => {
        rmSync(own, { recursive: true, force: true });
        if (missing) return { ok: false, problem: "agentMissing", detail: `${bin} was not found` };
        const facts = {
          ...(seen.model ? { model: seen.model } : {}),
          ...(seen.tokensIn !== undefined ? { tokensIn: seen.tokensIn } : {}),
          ...(seen.inputTokens !== undefined ? { inputTokens: seen.inputTokens } : {}),
          ...(seen.tokensOut !== undefined ? { tokensOut: seen.tokensOut } : {}),
          ...(seen.cacheReadTokens !== undefined ? { cacheReadTokens: seen.cacheReadTokens } : {}),
          ...(seen.cacheWriteTokens !== undefined ? { cacheWriteTokens: seen.cacheWriteTokens } : {}),
        };
        if (killed) return { ok: false, problem: "stopped", ...facts };
        if (code === 0 && seen.status === "success") {
          const text = (seen.text ?? seen.result)?.trim();
          return { ok: true, ...(text ? { text } : {}), ...facts };
        }
        // On failure it writes its own words to stderr, and no result event.
        const words = `${seen.error ?? ""}\n${stderr}`;
        const problem = classifyCursor(words);
        const limit = problem === "agentLimit" ? heardLimit(words) : undefined;
        return { ok: false, problem, ...facts, ...(limit ? { limit } : {}), ...saidOf(seen.error ?? lastLine(stderr)), detail: `exit ${code}; ${words.trim().slice(0, 300)}` };
      });
      return {
        done,
        kill() {
          killed = true;
          stop(spawned.child);
        },
      };
    },
  };
}

/** Why a files-only folder can't be used, or undefined when it can. */
export function cursorFolderProblem(dir: string): string | undefined {
  if (existsSync(join(dir, ".cursor"))) return "the folder holds a .cursor folder, which Cursor's agent would read as settings of its own";
  const out = linksOut(dir);
  return out.length ? `the folder holds links that lead out of it: ${out.slice(0, 3).join(", ")}` : undefined;
}

/** The command line for one turn. The prompt goes on stdin; the settings in the folder the environment names. */
export function cursorArgs(spec: TurnSpec, pluginDir: string): string[] {
  const files = spec.workspace?.access === "files";
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--trust",
    "--approve-mcps",
    "--plugin-dir",
    pluginDir,
    "--allowed-tools",
    [...CURSOR_MCP_TOOLS, ...(files ? CURSOR_FILE_TOOLS : [])].join(","),
    ...(spec.model ? ["--model", spec.model] : []),
  ];
}

/** Its settings for one turn (`cli-config.json` in `CURSOR_CONFIG_DIR`): only Open Sourcebook's tools allowed, the rest refused. */
export function cursorConfig(spec: TurnSpec): Record<string, unknown> {
  const files = spec.workspace?.access === "files";
  return {
    version: 1,
    editor: { vimMode: false },
    // Only what the list allows runs; a headless turn can't be asked.
    approvalMode: "allowlist",
    permissions: {
      allow: [`Mcp(${spec.mcp.name}:*)`, ...(files ? ["Read(**)", "Write(**)"] : [])],
      // Relative paths are the workspace's; `/**` is every absolute path.
      deny: ["Shell(*)", "WebFetch(*)", ...(files ? [] : ["Read(**)", "Read(/**)", "Write(**)", "Write(/**)"])],
    },
    ...(files ? { sandbox: { readBoundary: "workspace" } } : {}),
    attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
  };
}

/** The plugin of the turn: its name, and Open Sourcebook's MCP server. */
export function cursorPlugin(spec: TurnSpec): { manifest: Record<string, unknown>; mcp: Record<string, unknown> } {
  return {
    manifest: { name: "opensourcebook-turn", description: "Open Sourcebook's tools for one turn." },
    mcp: { mcpServers: { [spec.mcp.name]: { url: spec.mcp.url, headers: spec.mcp.headers } } },
  };
}

interface CursorFiles {
  config: string;
  plugin: string;
}

function writeCursorFiles(spec: TurnSpec, own: string): CursorFiles {
  const files = { config: join(own, "config"), plugin: join(own, "plugin") };
  mkdirSync(files.config, { mode: 0o700 });
  mkdirSync(join(files.plugin, ".cursor-plugin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(files.config, "cli-config.json"), JSON.stringify(cursorConfig(spec), null, 2), { mode: 0o600 });
  const plugin = cursorPlugin(spec);
  writeFileSync(join(files.plugin, ".cursor-plugin", "plugin.json"), JSON.stringify(plugin.manifest, null, 2), { mode: 0o600 });
  writeFileSync(join(files.plugin, ".mcp.json"), JSON.stringify(plugin.mcp, null, 2), { mode: 0o600 });
  return files;
}

/** What it gets on stdin: Open Sourcebook's instructions first, as it takes no system prompt of a caller's, then the turn's prompt. */
export function cursorPrompt(spec: Pick<TurnSpec, "systemPrompt" | "prompt">): string {
  return `<instructions>\n${spec.systemPrompt}\n</instructions>\n\n${spec.prompt}`;
}

/** The environment of a turn: the connector's own less Open Sourcebook's settings, and where Cursor's agent finds the turn's. */
export function cursorEnv(configDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Never a browser opened for a sign-in from a headless run.
  return agentEnv(env, { CURSOR_CONFIG_DIR: configDir, NO_OPEN_BROWSER: "1" });
}

/** Whether it is signed in, from `status --format json`, reading only `isAuthenticated`; undefined when it can't say. */
export async function cursorSignedIn(bin: string): Promise<boolean | undefined> {
  const status = await allLines(bin, ["status", "--format", "json"]);
  if (status.missing) return undefined;
  try {
    const said = JSON.parse(status.lines.join("\n")) as { isAuthenticated?: unknown };
    return typeof said.isAuthenticated === "boolean" ? said.isAuthenticated : undefined;
  } catch {
    return undefined;
  }
}

/** The models it offers this account, from `models`: one per line, `id - Name`, maybe marked `(current, default)`. */
export async function cursorModels(bin: string): Promise<AgentModel[]> {
  const listed = await allLines(bin, ["models"], { timeoutMs: 20_000 });
  return listed.code === 0 ? parseCursorModels(listed.lines) : [];
}

export function parseCursorModels(lines: string[]): AgentModel[] {
  const models: AgentModel[] = [];
  for (const raw of lines) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!line || /^(available models|tip:|no models)/i.test(line)) continue;
    const match = /^(\S+)(?:\s+-\s+(.+?))?(?:\s+\((?:current|default)(?:,\s*(?:current|default))*\))?$/.exec(line);
    if (match) models.push({ id: match[1]!, label: match[2]?.trim() || match[1]! });
  }
  return models;
}

interface CursorFacts {
  model?: string;
  /** The words it has said since its last tool call: its last words when the turn ends. */
  text?: string;
  /** Everything it said, from the result event. */
  result?: string;
  status?: "success" | "error";
  error?: string;
  tokensIn?: number;
  inputTokens?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** One line of `cursor-agent --print --output-format stream-json`. Lines that are not JSON are ignored. */
export function readCursorLine(line: string, seen: CursorFacts): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") seen.model = event.model;
  if (event.type === "assistant") {
    const content = ((event.message ?? {}) as { content?: unknown }).content;
    const words = Array.isArray(content) ? content.flatMap((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : [])).join("") : "";
    if (words) seen.text = words;
  }
  if (event.type === "tool_call" && event.subtype === "started") seen.text = undefined;
  if (event.type === "result") {
    seen.status = event.subtype === "success" && event.is_error !== true ? "success" : "error";
    if (typeof event.result === "string") seen.result = event.result;
    if (seen.status === "error" && typeof event.result === "string" && event.result.trim()) seen.error = event.result;
    const usage = typeof event.usage === "object" && event.usage !== null ? (event.usage as Record<string, unknown>) : undefined;
    if (usage) {
      const num = (key: string) => (typeof usage[key] === "number" && Number.isFinite(usage[key] as number) ? (usage[key] as number) : undefined);
      const input = num("inputTokens");
      const cacheRead = num("cacheReadTokens");
      const cacheWrite = num("cacheWriteTokens");
      const output = num("outputTokens");
      if (input !== undefined) seen.inputTokens = input;
      if (cacheRead !== undefined) seen.cacheReadTokens = cacheRead;
      if (cacheWrite !== undefined) seen.cacheWriteTokens = cacheWrite;
      if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
        seen.tokensIn = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
      }
      if (output !== undefined) seen.tokensOut = output;
    }
  }
}

/** Why a turn failed, from its own words. */
export function classifyCursor(said: string): Problem {
  if (/usage limit|rate limit|quota|too many requests|out of (fast )?requests|\b429\b/i.test(said)) return "agentLimit";
  if (/not (signed|logged) in|not authenticated|unauthenticated|authentication required|please (run )?.{0,20}login|invalid api key|\b401\b/i.test(said)) return "agentSignedOut";
  return "error";
}

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").filter(Boolean).at(-1);
}
