/**
 * Codex (`codex`), run headless (`codex exec --json`) for one turn of Open Sourcebook's chat or a piece of work: the unmodified
 * program, signed in by the person the normal way (with their ChatGPT plan, or an API key of theirs through `codex
 * login`). `codex exec` uses that saved login as it is; Open Sourcebook only launches it and never reads, holds or passes it on.
 *
 * Boxed in: an empty directory (`-C`), its own tools off (the shell, files, images, web search, sub-agents, apps,
 * plugins and hooks, each a feature turned off for this run), no prompts (`approval_policy="never"`), only Open Sourcebook's MCP
 * server, no user config, rules or saved session (`--ephemeral`), and Open Sourcebook's instructions as its developer instructions.
 *
 * With an API key the person gave the connector (`apiKey`), two more things work. A turn runs on that key
 * (`CODEX_API_KEY`) when Codex is not signed in. And a turn that asks for a workspace can get its own tools there,
 * inside the box (`../box.ts`), with its own sandbox off (`-s danger-full-access`, as macOS's sandbox can't be nested;
 * the box is the wall). In the box it never uses the person's login (`~/.codex/auth.json` stays shut): it keeps its
 * state in a folder of its own (`CODEX_HOME`) and holds no credential at all: its model calls go to this connector,
 * signed with the turn's own secret, and the connector forwards them to OpenAI with the key.
 *
 * It has no files-only workspace: Codex reads files only through its shell (it has no file-reading tool of its own),
 * so on a plan alone work that asks for a folder runs with Open Sourcebook's tools only.
 */
import { programOf } from "./locate.ts";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { plainEnv, programReads, tempEnv, toolReads } from "../box.ts";
import { PRODUCT } from "../names.ts";
import { heardLimit } from "./limit.ts";
import { marks } from "./marks.ts";
import { agentEnv, allLines, firstLine, Remembered, run, saidOf, stop } from "./process.ts";
import type { AgentAdapter, AgentInfo, AgentModel, ModelTier, Problem, RunningTurn, TurnEnd, TurnSpec } from "./types.ts";

export interface CodexOptions {
  bin?: string;
  /** An OpenAI API key the person gave the connector: for turns when Codex is not signed in, and for the box. */
  apiKey?: string;
  /** Where OpenAI's API is; only changed by tests. */
  apiOrigin?: string;
}

export const NO_CODEX_KEY = "Its own tools in a workspace need an OpenAI API key in Open Sourcebook's connector settings (OPENSOURCEBOOK_OPENAI_API_KEY); without one it works with Open Sourcebook's tools only.";
export const CODEX_ON_KEY = "Answers with the OpenAI API key in Open Sourcebook's connector settings, billed to that key, as Codex is not signed in.";
export const CODEX_FULL = "Works in each piece of work's own folder with its own shell, files and web, walled in on this Mac, on the OpenAI API key in Open Sourcebook's connector settings.";

const OPENAI = "https://api.openai.com";

/** The model calls Codex makes, the only ones forwarded for it. */
export const openaiAllows = (method: string, path: string) => (method === "POST" && path === "/v1/responses") || (method === "GET" && path === "/v1/models");

/** Codex's state folder for boxed turns: its own, never the person's ~/.codex. */
export const codexBoxHome = (tmp: string = tmpdir()) => join(tmp, "opensourcebook-codex-box");

/**
 * Its own tools, each a feature turned off when it runs with Open Sourcebook's tools only. Set with `-c features.<name>=false`,
 * which a Codex that doesn't know a name ignores (`--disable` would refuse to start).
 */
export const OWN_TOOL_FEATURES = ["shell_tool", "unified_exec", "view_image", "multi_agent", "multi_agent_v2", "goals", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use", "image_generation", "tool_suggest", "skill_search", "sleep_tool", "memories"];

export function codexAdapter(options: CodexOptions = {}): AgentAdapter {
  const name = options.bin ?? "codex";
  // Looked for again at each check and turn, also where it installs itself when that is not on the PATH (./locate.ts).
  const where = () => programOf(name);
  const unready = () => (options.apiKey ? undefined : NO_CODEX_KEY);
  const login = new Remembered<{ signedIn?: boolean }>(30_000);
  const catalog = new Remembered<AgentModel[]>(5 * 60_000);
  return {
    id: "codex",
    label: "Codex",
    mark: marks.openai,
    maker: "openai",
    boxing: { note: CODEX_FULL, unready, upstream: () => (options.apiKey ? { origin: options.apiOrigin ?? OPENAI, headers: { authorization: `Bearer ${options.apiKey}` }, allows: openaiAllows } : undefined) },
    signIn: `${name} login`,
    // From its own install page.
    install: { command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", url: "https://github.com/openai/codex" },
    defaultEfforts: { work: "high" },
    // What `model_reasoning_effort` takes on the models it lists.
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
      const models = await catalog.get(() => codexModels(bin));
      return { installed: true, version: version.text.replace(/^codex-cli\s*/, ""), ...status, ...(onKey ? { apiKey: true, note: CODEX_ON_KEY } : {}), ...(models.length ? { models } : {}) };
    },
    run(spec: TurnSpec): RunningTurn {
      const bin = where();
      if (spec.workspace && (spec.workspace.access !== "full" || unready() || !spec.workspace.model || !spec.workspace.box)) return { done: Promise.resolve({ ok: false, problem: "error", detail: unready() ?? NO_CODEX_KEY }), kill: () => undefined };
      const seen: CodexFacts = {};
      let killed = false;
      let child: ReturnType<typeof run>["child"] | undefined;
      const done = (async (): Promise<TurnEnd> => {
        let command: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
        if (spec.workspace?.access === "full") command = boxedCodex(bin, codexArgs(spec), spec);
        else {
          // Its own login as it has it; the key only when it has none. Without either it can't answer: said at once.
          const status = await login.get(() => signedIn(bin));
          if (status.signedIn === false && !options.apiKey) return { ok: false, problem: "agentSignedOut", detail: "codex login status: not logged in" };
          const onKey = status.signedIn === false && !!options.apiKey;
          command = { bin, args: codexArgs(spec), env: agentEnv(process.env, onKey ? { CODEX_API_KEY: options.apiKey } : {}) };
        }
        if (killed) return { ok: false, problem: "stopped" };
        const spawned = run(command.bin, command.args, { cwd: spec.cwd, stdin: spec.prompt, env: command.env, onLine: (line) => readCodexLine(line, seen) });
        child = spawned.child;
        const { code, stderr, missing } = await spawned.exited;
        if (missing) return { ok: false, problem: "agentMissing", detail: `${bin} was not found` };
        const facts = {
          ...(spec.model ? { model: spec.model } : {}),
          ...(seen.tokensIn !== undefined ? { tokensIn: seen.tokensIn } : {}),
          ...(seen.inputTokens !== undefined ? { inputTokens: seen.inputTokens } : {}),
          ...(seen.tokensOut !== undefined ? { tokensOut: seen.tokensOut } : {}),
          ...(seen.cacheReadTokens !== undefined ? { cacheReadTokens: seen.cacheReadTokens } : {}),
          ...(seen.cacheWriteTokens !== undefined ? { cacheWriteTokens: seen.cacheWriteTokens } : {}),
        };
        if (killed) return { ok: false, problem: "stopped", ...facts };
        if (code === 0 && seen.completed && !seen.failed) return { ok: true, ...(seen.text ? { text: seen.text } : {}), ...facts };
        const said = `${seen.failed ?? seen.lastError ?? ""}\n${stderr}`;
        const problem = classifyCodex(said);
        const limit = problem === "agentLimit" ? heardLimit(said) : undefined;
        return { ok: false, problem, ...facts, ...(limit ? { limit } : {}), ...saidOf(seen.failed ?? seen.lastError), detail: `exit ${code}; ${said.trim().slice(0, 300)}` };
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

/** A TOML string for `-c key=value`: JSON's escapes are TOML's. */
const toml = (value: string) => JSON.stringify(value);

/** The command line for one turn. The prompt goes on stdin. */
export function codexArgs(spec: TurnSpec): string[] {
  const headers = Object.entries(spec.mcp.headers).map(([k, v]) => `${toml(k)}=${toml(v)}`).join(",");
  const boxed = spec.workspace?.access === "full";
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    // In the box its own tools are on and the box is the wall (Codex's own sandbox can't nest in it). Without a box its
    // own tools are off, and its sandbox stays at its strictest besides.
    "-s",
    boxed ? "danger-full-access" : "read-only",
    ...(boxed ? [] : [...OWN_TOOL_FEATURES.flatMap((name) => ["-c", `features.${name}=false`]), "-c", 'web_search="disabled"']),
    "-c",
    'approval_policy="never"',
    "-C",
    spec.cwd,
    "-c",
    `mcp_servers.${spec.mcp.name}.url=${toml(spec.mcp.url)}`,
    "-c",
    `mcp_servers.${spec.mcp.name}.http_headers={${headers}}`,
    // Open Sourcebook's tools can take minutes (a render, a look at stills).
    "-c",
    `mcp_servers.${spec.mcp.name}.tool_timeout_sec=900`,
    // Open Sourcebook's tools run without asking: nobody is there to approve them.
    "-c",
    `mcp_servers.${spec.mcp.name}.default_tools_approval_mode="approve"`,
    // Open Sourcebook's instructions. Codex's own base instructions stay; there is no flag that replaces them.
    "-c",
    `developer_instructions=${toml(`${spec.systemPrompt}\n\n${PRODUCT}'s tools are the ${spec.mcp.name} tools (mcp__${spec.mcp.name}).`)}`,
    // In the box its model calls go to this connector, which adds the key; Codex itself holds only the turn's secret.
    ...(spec.workspace?.model
      ? ["-c", 'model_provider="opensourcebookbox"', "-c", `model_providers.opensourcebookbox={name="OpenAI through Open Sourcebook",base_url=${toml(`${spec.workspace.model.baseUrl}/v1`)},wire_api="responses",env_key="CODEX_API_KEY",supports_websockets=false}`]
      : []),
    ...(spec.model ? ["-m", spec.model] : []),
    ...(spec.effort ? ["-c", `model_reasoning_effort=${toml(spec.effort)}`] : []),
    "-",
  ];
}

/** The command that runs Codex inside the box, and the only environment it gets. */
export function boxedCodex(bin: string, args: string[], spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), tmp: string = tmpdir()): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  const state = codexBoxHome(tmp);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const command = spec.workspace!.box!.wrap(bin, args, {
    workspace: spec.cwd,
    home,
    read: [...toolReads(env.PATH, home), ...programReads(bin, env.PATH, home)],
    write: [state],
    deny: [join(home, ".codex", "auth.json")],
    connectorPort: spec.workspace!.connectorPort,
    ...(spec.workspace!.tmp ? { tmp: spec.workspace!.tmp } : {}),
  });
  return { ...command, env: { ...plainEnv(env), ...tempEnv(spec.workspace!.tmp), CODEX_HOME: state, CODEX_API_KEY: spec.workspace!.model!.secret } };
}

interface CodexFacts {
  text?: string;
  completed?: boolean;
  failed?: string;
  lastError?: string;
  tokensIn?: number;
  inputTokens?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * One line of `codex exec --json`. Lines that are not JSON (its log) are ignored, and so are items of type `error`,
 * which are its warnings (an unknown setting, a fallback); a turn fails only with `turn.failed`.
 */
export function readCodexLine(line: string, seen: CodexFacts): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const item = event.item as Record<string, unknown> | undefined;
  if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") seen.text = item.text;
  if (event.type === "error" && typeof event.message === "string") seen.lastError = event.message;
  if (event.type === "turn.failed") {
    const error = event.error as Record<string, unknown> | undefined;
    seen.failed = typeof error?.message === "string" ? error.message : "turn failed";
  }
  if (event.type === "turn.completed") {
    seen.completed = true;
    const usage = typeof event.usage === "object" && event.usage !== null ? (event.usage as Record<string, unknown>) : undefined;
    if (usage) {
      const num = (key: string) => (typeof usage[key] === "number" && Number.isFinite(usage[key] as number) ? (usage[key] as number) : undefined);
      const rawIn = num("input_tokens");
      const cacheRead = num("cached_input_tokens");
      const cacheWrite = num("cache_write_input_tokens");
      const out = num("output_tokens");
      // Codex counts cached input inside input_tokens.
      if (rawIn !== undefined) {
        seen.tokensIn = rawIn;
        seen.inputTokens = Math.max(0, rawIn - (cacheRead ?? 0));
      }
      if (cacheRead !== undefined) seen.cacheReadTokens = cacheRead;
      if (cacheWrite !== undefined) seen.cacheWriteTokens = cacheWrite;
      if (out !== undefined) seen.tokensOut = out;
    }
  }
}

export function classifyCodex(said: string): Problem {
  if (/usage limit|rate limit|quota|insufficient_quota|429/i.test(said)) return "agentLimit";
  if (/401|unauthori[sz]ed|invalid api key|incorrect api key|not logged in|log ?in/i.test(said)) return "agentSignedOut";
  return "error";
}

/** The models Codex lists (`codex debug models`, those it shows in its own picker), or none when it can't say. */
export async function codexModels(bin: string): Promise<AgentModel[]> {
  const { lines, code } = await allLines(bin, ["debug", "models"], { timeoutMs: 15_000 });
  return code === 0 ? readCodexModels(lines.join("\n")) : [];
}

export function readCodexModels(json: string): AgentModel[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    const list = Array.isArray(parsed) ? parsed : ((parsed as { models?: unknown }).models ?? []);
    if (!Array.isArray(list)) return [];
    return list
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && typeof (m as Record<string, unknown>).slug === "string" && (m as Record<string, unknown>).visibility === "list")
      .map((m) => {
        const tier = typeof m.description === "string" ? codexTier(m.description) : undefined;
        return { id: m.slug as string, label: typeof m.display_name === "string" ? m.display_name : (m.slug as string), ...(tier ? { tier } : {}) };
      });
  } catch {
    return [];
  }
}

/** What a model's own description in Codex's list says of how quick or capable it is, by its words. */
const TIER_WORDS: ReadonlyArray<[ModelTier, RegExp]> = [
  ["fast", /\b(?:fast|quick|affordable|lightweight|simpler|easier|simple tasks|easy tasks)\b/i],
  ["balanced", /\b(?:balanced|everyday)\b/i],
  ["strong", /\b(?:complex|professional|most capable|frontier|hardest)\b/i],
];

/**
 * A Codex model's tier, read from the description Codex's own list gives it
 * ("Fast and affordable model for easier tasks" is quick, "for coding and
 * everyday work" good, "for complex coding and professional work" best).
 * A description that says none of these, or more than one, gives no tier:
 * it is left out rather than guessed.
 */
export function codexTier(description: string): ModelTier | undefined {
  const said = TIER_WORDS.filter(([, words]) => words.test(description)).map(([tier]) => tier);
  return said.length === 1 ? said[0] : undefined;
}

/** `codex login status` exits 0 when signed in; only the exit code is read. */
async function signedIn(bin: string): Promise<{ signedIn?: boolean }> {
  const result = await allLines(bin, ["login", "status"]);
  return result.missing || result.code === null ? {} : { signedIn: result.code === 0 };
}
