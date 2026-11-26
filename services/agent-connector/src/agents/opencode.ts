/**
 * OpenCode (`opencode`), run headless (`opencode run --format json`) for one turn of Open Sourcebook's chat or a piece of work: the
 * unmodified program with the providers the person connected in it, or its own free models without an account. Open Sourcebook
 * only launches it and never reads, holds or passes on what it signs in with.
 *
 * Boxed in: a private server of its own for the run (`--standalone`, not the shared background one, which has its own
 * settings), an empty directory, an agent of Open Sourcebook's own (`opensourcebook`) whose rules refuse every tool except Open Sourcebook's
 * (`permissions`: deny all, then allow `opensourcebook_*`; the last rule that matches wins), only Open Sourcebook's MCP server added, no
 * project config, no sharing, no session title call, no update check, nothing read from Claude Code's folders, and
 * the session kept out of its lists (`--archived`). All of it goes in through `OPENCODE_CONFIG_CONTENT`; nothing is
 * written to the person's OpenCode settings. Open Sourcebook's system prompt is that agent's own, or is added to OpenCode's as an
 * instructions file when the caller keeps the agent's own.
 *
 * A turn that asks for a workspace gets its file tools only there (read, write, edit, search), on what OpenCode
 * signs in with: its rules allow those tools and refuse every path outside the folder (`external_directory`), and
 * every other tool of its own (its shell, the web, sub-agents) stays refused. OpenCode does not resolve links before
 * that check, so a turn whose folder holds a link leading out of it is refused at the start; with no shell it can't
 * make one itself. It has no box: its private server talks to itself over this computer's own address, which the
 * box shuts, so its own rules are the only wall. Its JSON output gives each tool call once it is made, not while it
 * is written, so there are no drafts.
 */
import { programOf } from "./locate.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linksOut } from "./folder.ts";
import { MCP_SERVER } from "../names.ts";
import { heardLimit } from "./limit.ts";
import { marks } from "./marks.ts";
import { agentEnv, allLines, firstLine, Remembered, run, saidOf, stop } from "./process.ts";
import type { AgentAdapter, AgentInfo, AgentModel, Problem, RunningTurn, TurnEnd, TurnSpec } from "./types.ts";

/** Kept here too for the tests that read it from OpenCode's adapter. */
export { linksOut };

export interface OpenCodeOptions {
  bin?: string;
}

/** Its own file tools in a files-only folder, as its rules name them. */
export const FILE_ACTIONS = ["read", "edit", "glob", "grep"];
export const OPENCODE_FILES = "Works in each piece of work's own folder with its file tools only (read, write, search), on what OpenCode signs in with: no shell or web of its own.";
export const OPENCODE_NOTE ="Answers with the models OpenCode offers on this computer: its free ones without an account, and more once you connect a provider in OpenCode.";

/** Open Sourcebook's own agent in OpenCode for a turn. */
const AGENT = MCP_SERVER;

export function openCodeAdapter(options: OpenCodeOptions = {}): AgentAdapter {
  const name = options.bin ?? "opencode";
  // Looked for again at each check and turn, also where it installs itself when that is not on the PATH (./locate.ts).
  const where = () => programOf(name, [".opencode/bin"]);
  const catalog = new Remembered<AgentModel[]>(5 * 60_000);
  return {
    id: "opencode",
    label: "OpenCode",
    mark: marks.opencode,
    signIn: `${name} auth login`,
    // From its own install page.
    install: { command: "curl -fsSL https://opencode.ai/v2/install | bash", url: "https://opencode.ai/docs" },
    filesOnly: { note: OPENCODE_FILES },
    async info(): Promise<AgentInfo> {
      const bin = where();
      const version = await firstLine(bin, ["--version"]);
      if (version.missing || !version.text) return { installed: false };
      const models = await catalog.get(() => openCodeModels(bin));
      // Whether it is signed in to a provider is in its credential list, which Open Sourcebook does not read; its free models
      // answer without one, so it is not called signed out.
      return { installed: true, version: version.text.replace(/^opencode\s+v?/i, ""), note: OPENCODE_NOTE, ...(models.length ? { models } : {}) };
    },
    run(spec: TurnSpec): RunningTurn {
      const bin = where();
      const out = spec.workspace?.access === "files" ? linksOut(spec.cwd) : [];
      if (out.length) return { done: Promise.resolve({ ok: false, problem: "error", detail: `the folder holds links that lead out of it: ${out.slice(0, 3).join(", ")}` }), kill: () => undefined };
      // Open Sourcebook's prompt added to OpenCode's own goes in as an instructions file, in a folder of the turn's own.
      const extra = spec.keepAgentPrompt ? mkdtempSync(join(tmpdir(), "opensourcebook-opencode-")) : undefined;
      if (extra) writeFileSync(join(extra, "opensourcebook.md"), spec.systemPrompt, { mode: 0o600 });
      const seen: OpenCodeFacts = {};
      const spawned = run(bin, openCodeArgs(spec), { cwd: spec.cwd, stdin: spec.prompt, env: openCodeEnv(spec, process.env, extra && join(extra, "opensourcebook.md")), onLine: (line) => readOpenCodeLine(line, seen) });
      let killed = false;
      const done = spawned.exited.then(({ code, stderr, missing }): TurnEnd => {
        if (extra) rmSync(extra, { recursive: true, force: true });
        if (missing) return { ok: false, problem: "agentMissing", detail: `${bin} was not found` };
        const facts = {
          ...(spec.model ? { model: modelName(spec.model) } : {}),
          ...(seen.tokensIn !== undefined ? { tokensIn: seen.tokensIn } : {}),
          ...(seen.inputTokens !== undefined ? { inputTokens: seen.inputTokens } : {}),
          ...(seen.tokensOut !== undefined ? { tokensOut: seen.tokensOut } : {}),
          ...(seen.cacheReadTokens !== undefined ? { cacheReadTokens: seen.cacheReadTokens } : {}),
          ...(seen.cacheWriteTokens !== undefined ? { cacheWriteTokens: seen.cacheWriteTokens } : {}),
          ...(seen.costUsd !== undefined ? { costUsd: seen.costUsd } : {}),
        };
        if (killed) return { ok: false, problem: "stopped", ...facts };
        // It exits 0 even when the model refused the turn, so the turn is judged by its events.
        if (code === 0 && seen.steps && !seen.error) return { ok: true, ...(seen.text ? { text: seen.text } : {}), ...facts };
        const said = `${seen.error ?? ""}\n${stderr}`;
        const problem = seen.errorProblem ?? classifyOpenCode(said);
        const limit = problem === "agentLimit" ? heardLimit(said) : undefined;
        return { ok: false, problem, ...facts, ...(limit ? { limit } : {}), ...saidOf(seen.errorMessage), detail: `exit ${code}; ${said.trim().slice(0, 300)}` };
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

/** The command line for one turn. The prompt goes on stdin; the settings go in through the environment (`openCodeEnv`). */
export function openCodeArgs(spec: TurnSpec): string[] {
  return ["run", "--standalone", "--format", "json", "--agent", AGENT, "--archived", ...(spec.model ? ["-m", modelName(spec.model)] : [])];
}

/** OpenCode's settings for one turn, as `OPENCODE_CONFIG_CONTENT` takes them. */
export function openCodeConfig(spec: TurnSpec, instructionsFile?: string): Record<string, unknown> {
  const server = spec.mcp.name;
  return {
    share: "disabled",
    snapshots: false,
    websearch: false,
    ...(instructionsFile ? { instructions: [instructionsFile] } : {}),
    mcp: {
      servers: {
        // Its tools straight on the model's list (`codemode: false`); Open Sourcebook's tools can take minutes (a render).
        [server]: { type: "remote", url: spec.mcp.url, headers: spec.mcp.headers, oauth: false, codemode: false, timeout: { execution: 900_000 } },
      },
    },
    agents: {
      // No extra model call to name the session.
      title: { disabled: true },
      [AGENT]: {
        mode: "primary",
        ...(spec.keepAgentPrompt ? {} : { system: spec.systemPrompt }),
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: `${server}_*`, resource: "*", effect: "allow" },
          // A files-only folder: its file tools, and no path outside the folder (the last rule that matches wins).
          ...(spec.workspace?.access === "files"
            ? [
                ...FILE_ACTIONS.map((action) => ({ action, resource: "*", effect: "allow" })),
                { action: "external_directory", resource: "*", effect: "deny" },
                { action: "external_directory", resource: spec.cwd, effect: "allow" },
                { action: "external_directory", resource: `${spec.cwd}/*`, effect: "allow" },
              ]
            : []),
        ],
      },
    },
  };
}

/** The environment of a turn: the connector's own less Open Sourcebook's settings, and OpenCode's settings for the turn. */
export function openCodeEnv(spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, instructionsFile?: string): NodeJS.ProcessEnv {
  return agentEnv(env, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(spec, instructionsFile)),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  });
}

interface OpenCodeFacts {
  steps?: number;
  text?: string;
  error?: string;
  errorProblem?: Problem;
  /** The error's own message, for the person (`TurnEnd.said`). */
  errorMessage?: string;
  tokensIn?: number;
  inputTokens?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** One line of `opencode run --format json`. Lines that are not JSON are ignored. */
export function readOpenCodeLine(line: string, seen: OpenCodeFacts): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const part = (event.part ?? {}) as Record<string, unknown>;
  if (event.type === "text" && typeof part.text === "string" && part.text.trim()) seen.text = part.text;
  if (event.type === "step_finish") {
    seen.steps = (seen.steps ?? 0) + 1;
    const tokens = typeof part.tokens === "object" && part.tokens !== null ? (part.tokens as Record<string, unknown>) : undefined;
    if (tokens) {
      const cache = typeof tokens.cache === "object" && tokens.cache !== null ? (tokens.cache as Record<string, unknown>) : undefined;
      const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
      const input = num(tokens.input);
      const read = num(cache?.read);
      const write = num(cache?.write);
      const output = num(tokens.output);
      const reasoning = num(tokens.reasoning);
      if (input !== undefined) seen.inputTokens = (seen.inputTokens ?? 0) + input;
      if (read !== undefined) seen.cacheReadTokens = (seen.cacheReadTokens ?? 0) + read;
      if (write !== undefined) seen.cacheWriteTokens = (seen.cacheWriteTokens ?? 0) + write;
      if (input !== undefined || read !== undefined || write !== undefined) {
        seen.tokensIn = (seen.tokensIn ?? 0) + (input ?? 0) + (read ?? 0) + (write ?? 0);
      }
      if (output !== undefined || reasoning !== undefined) {
        seen.tokensOut = (seen.tokensOut ?? 0) + (output ?? 0) + (reasoning ?? 0);
      }
    }
    if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
      seen.costUsd = Math.round(((seen.costUsd ?? 0) + part.cost) * 1e9) / 1e9;
    }
  }
  if (event.type === "error") {
    const error = (event.error ?? {}) as Record<string, unknown>;
    const kind = typeof error.type === "string" ? error.type : "";
    seen.error = `${kind}: ${typeof error.message === "string" ? error.message : "error"}`;
    if (typeof error.message === "string" && error.message.trim()) seen.errorMessage = error.message;
    const status = typeof error.status === "number" ? error.status : undefined;
    if (status === 429 || /limit/i.test(kind)) seen.errorProblem = "agentLimit";
    else if (status === 401 || status === 403 || /auth/i.test(kind)) seen.errorProblem = "agentSignedOut";
  }
}

export function classifyOpenCode(said: string): Problem {
  if (/usage limit|rate limit|free-limit|quota|429/i.test(said)) return "agentLimit";
  if (/401|unauthori[sz]ed|invalid api key|not authenticated|no provider|connect a provider/i.test(said)) return "agentSignedOut";
  return "error";
}

/** The models OpenCode offers on this computer (`opencode models`, one `provider/model` a line), or none when it can't say. */
export async function openCodeModels(bin: string): Promise<AgentModel[]> {
  const { lines, code } = await allLines(bin, ["models", "--standalone"], { timeoutMs: 30_000, env: agentEnv(process.env, { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" }), cwd: tmpdir() });
  return code === 0 ? readOpenCodeModels(lines) : [];
}

/**
 * OpenCode names a model `provider/model`; a pick names it with letters, digits, `.`, `_` and `-` only, so the slash
 * goes as `__` (`opencode/big-pickle` is `opencode__big-pickle`). A name that can't be said that way is left out.
 */
export const modelId = (name: string) => name.replace("/", "__");
export const modelName = (id: string) => (id.includes("/") ? id : id.replace("__", "/"));

export function readOpenCodeModels(lines: string[]): AgentModel[] {
  return lines
    .filter((line) => /^[^\s/#]+\/[^\s#]+$/.test(line))
    .map((name) => ({ id: modelId(name), label: name.slice(name.indexOf("/") + 1) }))
    .filter((model) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(model.id));
}
