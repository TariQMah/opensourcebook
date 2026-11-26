/**
 * GitHub Copilot's CLI (`copilot`), run headless (`--output-format json`, the prompt piped on stdin) for one turn of
 * Open Sourcebook's chat or a piece of work: the unmodified program, signed in by the person the normal way (`copilot login`, or a
 * GitHub token of their own in the environment it was started with, as it reads one). Open Sourcebook only launches it and never
 * reads, holds or passes on what it signs in with.
 *
 * Boxed in: an empty directory, not trusted (so a folder's MCP servers, hooks and plugin settings are not read), and
 * on its command line:
 * - its own tools left off the model's list (`--excluded-tools`: its shell, file tools, web, sub-agents, skills, …),
 *   and, as a second wall that a tool it adds later still meets, refused by kind (`--deny-tool shell`, `url`,
 *   `memory`, `read`, `write`), which wins over every allow;
 * - Open Sourcebook's MCP server added for the run from a file of the turn's own (`--additional-mcp-config @…`) and its tools
 *   allowed (`--allow-tool opensourcebook`); its built-in GitHub servers off (`--disable-builtin-mcps`), and no plugins found on
 *   their own (`COPILOT_PLUGIN_DIR_ONLY`);
 * - no custom instructions (`--no-custom-instructions`: none of the person's `AGENTS.md`, `CLAUDE.md` or
 *   `copilot-instructions.md`), no question form (`--no-ask-user`), no temporary folder (`--disallow-temp-dir`), no
 *   update, and the session not synced to the person's GitHub account (`--sync-session=off`).
 *
 * It takes no system prompt of a caller's in place of its own, so Open Sourcebook's goes in beside it as a custom agent of the
 * turn's own (`--agent`), from a folder holding only that agent (`--add-dir`).
 *
 * A turn that asks for a workspace gets its file tools only there (view, create, edit, search): they stay on the list
 * and reads and writes are allowed, and its path check keeps them to the working directory (and the agent's folder);
 * its shell, the web and sub-agents stay off. It has no box here, so its own rules are the only wall. A folder
 * holding a link that leads out of it is refused at the start.
 *
 * It has no command that says whether it is signed in, and its credentials are the keychain's or its own files, which
 * Open Sourcebook does not read, so it is shown as ready until a turn says otherwise. Hooks the person set up in their own
 * `~/.copilot` still run, as in every session of theirs: no flag turns them off for one run. Its JSON events give each
 * tool call once it is made, not while it is written, so there are no drafts.
 */
import { programOf } from "./locate.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { linksOut } from "./folder.ts";
import { heardLimit } from "./limit.ts";
import { agentEnv, firstLine, run, saidOf, stop } from "./process.ts";
import { marks } from "./marks.ts";
import type { AgentAdapter, AgentInfo, Problem, RunningTurn, TurnEnd, TurnSpec } from "./types.ts";

export interface CopilotOptions {
  bin?: string;
}

export const COPILOT_NOTE = "Answers with the GitHub account Copilot's CLI is signed in with on this computer, on that account's Copilot plan.";
export const COPILOT_FILES = "Works in each piece of work's own folder with its file tools only (read, write, search), on what Copilot's CLI signs in with: no shell or web of its own.";

/** Its own file tools in a files-only folder, by the names `--available-tools` and `--excluded-tools` take. */
export const COPILOT_FILE_TOOLS = ["view", "create", "edit", "apply_patch", "glob", "grep", "rg"];

/** Its own tools as Copilot's CLI 1.0 names them, left off the model's list. A tool added later meets the deny rules. */
export const COPILOT_OWN_TOOLS = [
  ...COPILOT_FILE_TOOLS,
  "bash",
  "powershell",
  "list_bash",
  "read_bash",
  "stop_bash",
  "write_bash",
  "list_powershell",
  "read_powershell",
  "stop_powershell",
  "write_powershell",
  "web_fetch",
  "web_search",
  "task",
  "list_agents",
  "read_agent",
  "write_agent",
  "skill",
  "ask_user",
  "store_memory",
  "sql",
  "lsp",
];

/** Its environment variables that would widen a run (allow everything, trust the folder, add instructions or skills). */
const WIDENING_ENV = ["COPILOT_ALLOW_ALL", "COPILOT_ASSISTED_APPROVAL", "COPILOT_PLAN_THEN_AUTOPILOT", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "COPILOT_SKILLS_DIRS"];

export function copilotAdapter(options: CopilotOptions = {}): AgentAdapter {
  const name = options.bin ?? "copilot";
  // Looked for again at each check and turn, also where it installs itself when that is not on the PATH (./locate.ts).
  const where = () => programOf(name);
  return {
    id: "copilot",
    label: "GitHub Copilot",
    mark: marks.githubcopilot,
    // Its own sign-in: a GitHub account in the browser.
    signIn: `${name} login`,
    // From its own install page.
    install: { command: "npm install -g @github/copilot", url: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli" },
    filesOnly: { note: COPILOT_FILES },
    // From its own docs' list of models (November 2026); `auto` lets it pick from what the plan offers.
    models: [
      { id: "auto", label: "Auto" },
      { id: "claude-haiku-5.5", label: "Claude Haiku 5.5", tier: "fast" },
      { id: "claude-sonnet-5.5", label: "Claude Sonnet 5.5", tier: "balanced" },
      { id: "claude-opus-5.5", label: "Claude Opus 5.5", tier: "strong" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", tier: "balanced" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", tier: "fast" },
    ],
    // A fast one for a chat's many small steps; the middle one with high effort for long work such as a video.
    defaultModels: { chat: "claude-haiku-5.5", work: "claude-sonnet-5.5" },
    defaultEfforts: { work: "high" },
    // What `--effort` takes (`max` only on Anthropic's models, so left out).
    efforts: [
      { id: "low", label: "Low", weight: "light" },
      { id: "medium", label: "Medium", weight: "medium" },
      { id: "high", label: "High", weight: "high" },
      { id: "xhigh", label: "Extra high", weight: "max" },
    ],
    async info(): Promise<AgentInfo> {
      const bin = where();
      const version = await firstLine(bin, ["--version"]);
      if (version.missing || !version.text) return { installed: false };
      const number = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(version.text)?.[0] ?? version.text;
      return { installed: true, version: number, note: COPILOT_NOTE };
    },
    run(spec: TurnSpec): RunningTurn {
      const bin = where();
      if (spec.workspace?.access === "files") {
        const out = linksOut(spec.cwd);
        if (out.length) return { done: Promise.resolve({ ok: false, problem: "error", detail: `the folder holds links that lead out of it: ${out.slice(0, 3).join(", ")}` }), kill: () => undefined };
      }
      const own = mkdtempSync(join(tmpdir(), "opensourcebook-copilot-"));
      const files = writeCopilotFiles(spec, own);
      const seen: CopilotFacts = {};
      const spawned = run(bin, copilotArgs(spec, files), { cwd: spec.cwd, stdin: spec.prompt, env: copilotEnv(), onLine: (line) => readCopilotLine(line, seen) });
      let killed = false;
      const done = spawned.exited.then(({ code, stderr, missing }): TurnEnd => {
        const usage = readUsage(files.usage);
        rmSync(own, { recursive: true, force: true });
        if (missing) return { ok: false, problem: "agentMissing", detail: `${bin} was not found` };
        const model = seen.model ?? usage.model;
        const facts = {
          ...(model ? { model } : {}),
          ...(usage.tokensIn !== undefined ? { tokensIn: usage.tokensIn } : {}),
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.tokensOut !== undefined ? { tokensOut: usage.tokensOut } : {}),
          ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        };
        if (killed) return { ok: false, problem: "stopped", ...facts };
        if (code === 0 && (seen.exitCode === undefined || seen.exitCode === 0)) return { ok: true, ...(seen.text?.trim() ? { text: seen.text.trim() } : {}), ...facts };
        const words = `${seen.error ?? ""}\n${stderr}`;
        const problem = classifyCopilot(seen.errorType, words);
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

interface CopilotFiles {
  /** Open Sourcebook's MCP server for the run. */
  mcp: string;
  /** The folder holding only the turn's agent, added with `--add-dir`. */
  agentRoot: string;
  /** The agent's id: its file's name, unique to the turn so no agent of the person's can stand in for it. */
  agent: string;
  /** Where it writes its usage when the run ends. */
  usage: string;
}

/** The command line for one turn. The prompt is piped on stdin. */
export function copilotArgs(spec: TurnSpec, files: CopilotFiles): string[] {
  const filesOnly = spec.workspace?.access === "files";
  const excluded = COPILOT_OWN_TOOLS.filter((tool) => !(filesOnly && COPILOT_FILE_TOOLS.includes(tool)));
  const denied = ["shell", "url", "memory", ...(filesOnly ? [] : ["read", "write"])];
  return [
    "--output-format",
    "json",
    "--no-auto-update",
    "--no-custom-instructions",
    "--no-ask-user",
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--sync-session=off",
    "--additional-mcp-config",
    `@${files.mcp}`,
    "--add-dir",
    files.agentRoot,
    "--agent",
    files.agent,
    "--excluded-tools",
    excluded.join(","),
    "--allow-tool",
    spec.mcp.name,
    ...(filesOnly ? ["--allow-tool", "read,write"] : []),
    ...denied.flatMap((kind) => ["--deny-tool", kind]),
    "--usage-output-file",
    files.usage,
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
  ];
}

/** Open Sourcebook's MCP server for the run, in the shape its MCP config takes. */
export function copilotMcpConfig(spec: TurnSpec): Record<string, unknown> {
  // Open Sourcebook's tools can take minutes (a render).
  return { mcpServers: { [spec.mcp.name]: { type: "http", url: spec.mcp.url, headers: spec.mcp.headers, tools: ["*"], timeout: 900_000 } } };
}

/** The turn's custom agent: Open Sourcebook's system prompt, beside Copilot's own. */
export function copilotAgent(spec: Pick<TurnSpec, "systemPrompt">): string {
  return `---\nname: Open Sourcebook\ndescription: Open Sourcebook's agent for one turn.\ninfer: false\n---\n${spec.systemPrompt}\n`;
}

function writeCopilotFiles(spec: TurnSpec, own: string): CopilotFiles {
  const agent = `opensourcebook-turn-${randomBytes(6).toString("hex")}`;
  const files: CopilotFiles = { mcp: join(own, "mcp.json"), agentRoot: join(own, "agent"), agent, usage: join(own, "usage.json") };
  writeFileSync(files.mcp, JSON.stringify(copilotMcpConfig(spec), null, 2), { mode: 0o600 });
  mkdirSync(join(files.agentRoot, ".github", "agents"), { recursive: true, mode: 0o700 });
  writeFileSync(join(files.agentRoot, ".github", "agents", `${agent}.agent.md`), copilotAgent(spec), { mode: 0o600 });
  return files;
}

/** The environment of a turn: the connector's own less Open Sourcebook's settings and anything that would widen the run. */
export function copilotEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const base = agentEnv(env, { COPILOT_AUTO_UPDATE: "false", COPILOT_PLUGIN_DIR_ONLY: "true", NO_COLOR: "1" });
  for (const key of WIDENING_ENV) delete base[key];
  return base;
}

/** The tokens and model of a run, from the usage file it writes when it ends (`--usage-output-file`). */
export function readUsage(path: string): { model?: string; tokensIn?: number; inputTokens?: number; tokensOut?: number; cacheReadTokens?: number; cacheWriteTokens?: number } {
  let usage: { modelMetrics?: Record<string, { usage?: Record<string, unknown> }> };
  try {
    usage = JSON.parse(readFileSync(path, "utf8")) as typeof usage;
  } catch {
    return {};
  }
  const models = Object.entries(usage.modelMetrics ?? {});
  if (!models.length) return {};
  let tokensIn: number | undefined;
  let inputTokens: number | undefined;
  let tokensOut: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const add = (cur: number | undefined, value: number | undefined) => (value !== undefined ? (cur ?? 0) + value : cur);
  for (const [, metric] of models) {
    const counts = metric.usage ?? {};
    const inp = num(counts.inputTokens);
    const read = num(counts.cacheReadTokens);
    const write = num(counts.cacheWriteTokens);
    inputTokens = add(inputTokens, inp);
    cacheReadTokens = add(cacheReadTokens, read);
    cacheWriteTokens = add(cacheWriteTokens, write);
    if (inp !== undefined || read !== undefined || write !== undefined) {
      tokensIn = (tokensIn ?? 0) + (inp ?? 0) + (read ?? 0) + (write ?? 0);
    }
    tokensOut = add(tokensOut, num(counts.outputTokens));
  }
  return {
    ...(models.length === 1 ? { model: models[0]![0] } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

interface CopilotFacts {
  model?: string;
  /** The words it has said since its last tool call: its last words when the turn ends. */
  text?: string;
  /** The exit code its final result record gives. */
  exitCode?: number;
  error?: string;
  errorType?: string;
}

/** One line of `copilot --output-format json`: one session event per line, and a result record at the end. */
export function readCopilotLine(line: string, seen: CopilotFacts): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  // A sub-agent's events carry its id; only the main agent's words are the turn's.
  if (typeof event.agentId === "string") return;
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (event.type === "session.start" && typeof data.selectedModel === "string") seen.model ??= data.selectedModel;
  if (event.type === "session.model_change" && typeof data.newModel === "string") seen.model = data.newModel;
  if (event.type === "assistant.message") {
    if (typeof data.model === "string") seen.model = data.model;
    const asks = Array.isArray(data.toolRequests) && data.toolRequests.length > 0;
    if (typeof data.content === "string" && data.content.trim()) seen.text = data.content;
    if (asks) seen.text = undefined;
  }
  if (event.type === "tool.execution_start") seen.text = undefined;
  if (event.type === "session.error") {
    if (typeof data.message === "string" && data.message.trim()) seen.error = data.message;
    if (typeof data.errorType === "string") seen.errorType = data.errorType;
  }
  if (event.type === "result" && typeof event.exitCode === "number") seen.exitCode = event.exitCode;
}

/** Why a turn failed, from its error's category and its words. */
export function classifyCopilot(errorType: string | undefined, said: string): Problem {
  if (errorType === "quota" || errorType === "rate_limit") return "agentLimit";
  if (errorType === "authentication") return "agentSignedOut";
  if (/quota|rate limit|usage limit|premium requests|ai credits|\b429\b/i.test(said)) return "agentLimit";
  if (/no authentication information found|not (signed|logged) in|unauthenticated|copilot login|\/login|\b401\b/i.test(said)) return "agentSignedOut";
  return "error";
}

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").filter(Boolean).at(-1);
}
