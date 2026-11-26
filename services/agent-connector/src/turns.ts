/**
 * The turns this connector is running. The engine hands one over (POST
 * /turns); the connector makes an empty directory, starts the agent there
 * with Open Sourcebook's tools as its only tools, forwards each tool call to the engine
 * with the turn's token, and tells the engine when the agent ends, is
 * stopped or runs out of time. Nothing of a turn outlives it: its
 * directory is removed and its secrets are dropped.
 *
 * It also remembers, for each agent, a usage limit the agent ran into (and
 * when it said the limit resets) until a later turn of that agent ends well
 * or that time has passed, and it can check whether a limit has lifted with
 * the smallest turn there is (`probe`).
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRegistry } from "./agents/registry.ts";
import type { AgentAdapter, LimitReset, Problem, RunningTurn, TurnEnd, Upstream, WorkspaceAccess } from "./agents/types.ts";
import { boxTemp, checkWorkspace, reachOf, readsOf, realPath, within, withReach, type Box, type Reach } from "./box.ts";
import { handleMcp, type ToolAnswer, type ToolImage, type ToolListing } from "./mcp.ts";
import { MCP_SERVER } from "./names.ts";
import { isLoopback, safeEqual } from "./net.ts";
import { appendUsageLog, type UsageOutcome } from "./usage-log.ts";

export interface TurnTarget {
  type?: string;
  id?: string;
}

export interface TurnDefaults {
  /**
   * The agent a turn that names none runs on: only the person's own `OPENSOURCEBOOK_AGENT`. None by default, so no provider is
   * preferred: a turn that names no agent is then refused, and the engine names one (the person's pick).
   */
  agent?: string;
  /** The person's own model for the connector's agent in chat (`OPENSOURCEBOOK_AGENT_MODEL`); none leaves it to the adapter. */
  model?: string;
  effort?: string;
}

export interface TurnsOptions {
  agents: AgentRegistry;
  defaults: TurnDefaults;
  /** This connector's own address, for the agent's MCP config. */
  baseUrl: () => string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Most milliseconds a turn may run when the engine does not say. */
  timeoutMs?: number;
  /** The box this computer has (`./box.ts`); without one, no turn gets a full workspace. */
  box?: Box;
  /** True keeps every agent's own tools off everywhere: no turn gets a workspace. */
  noWorkspaces?: boolean;
  /** The home folder, for checking a workspace. */
  home?: string;
  /**
   * The work folders this connector was set up with in its own environment (the scenes service's), where a workspace
   * may be even under a dot folder at the top of the home folder, as an installed copy's are (`checkWorkspace`).
   */
  roots?: string[];
  /** Path to the JSONL file where finished turns' usage is appended. */
  usageLog?: string;
}

interface Turn {
  id: string;
  /** The agent it runs. */
  agent: string;
  /** Resolved effort passed to the agent, if any. */
  effort?: string;
  /** What the caller said this turn is for (format/type and id). */
  target?: TurnTarget;
  /** What the agent's MCP requests carry. */
  secret: string;
  /** Where its tool calls and its end go; none for the connector's own check (`probe`), which ends with `onEnd`. */
  callback?: { url: string; token: string };
  onEnd?: (problem: Problem | undefined) => void;
  tools: ToolListing[];
  instructions?: string;
  running?: RunningTurn;
  timer?: NodeJS.Timeout;
  cwd?: string;
  /** The caller's own folder: kept when the turn ends, unlike the empty one made for a turn without it. */
  workspace?: boolean;
  /** A boxed turn's own temporary folder (`boxTemp`), removed when the turn ends. */
  tmp?: string;
  /** Who started it, when not the connector's full token: such a caller sees and stops only its own turns. */
  scope?: string;
  /** For a boxed turn: what its model calls are signed with, and where the connector forwards them with the person's API key. */
  model?: { secret: string; upstream: Upstream };
  startedAt: number;
  ending?: Problem;
  toolCalls: number;
  /** Tools whose input the engine wants while the agent still writes it. */
  drafts: Set<string>;
  /** The newest unfinished input not sent yet, and whether a send is under way. */
  draft?: { tool: string; input: string; calls: number };
  draftTimer?: NodeJS.Timeout;
  drafting?: boolean;
}

/** How often, at most, a turn's unfinished tool input is sent to the engine. */
export const DRAFT_MS = 250;

/**
 * A caller with a narrower token than the connector's own (the scenes service's): it may start turns only with a work
 * folder inside one of `roots` (by their real paths) or with none, and see and stop only the turns it started.
 */
export interface Scope {
  name: string;
  roots: string[];
}

export type StartResult = { ok: true; agent: string; model?: string; effort?: string; workspace: boolean; access?: WorkspaceAccess; read?: boolean } | { ok: false; status: number; problem: Problem | "badRequest"; message: string; limit?: AgentLimit };

/** A usage limit an agent ran into: since when, and when it said it resets, if it said so. */
export interface AgentLimit extends LimitReset {
  since: string;
}

/** What a check of an agent found: it answers, or why not (with its limit when that is why). */
export type ProbeResult = { ok: true } | { ok: false; problem: Problem; limit?: AgentLimit };

/** The longest the check of an agent may run. */
export const PROBE_TIMEOUT_MS = 90_000;
const PROBE_SYSTEM = "You are checking that you can answer. Reply in one word.";
const PROBE_PROMPT = "Reply with the single word ok.";

/**
 * What a turn that asks for a workspace gets with this agent here: everything of its own inside the box when there is
 * a box and the agent is ready for it (an API key), else its file tools only on its own login when its adapter can,
 * else nothing of its own. `note` says it in the adapter's words; `unavailable` says why it doesn't get everything.
 */
export function workspaceAccess(agent: AgentAdapter, box: Box | undefined, off = false): { access?: WorkspaceAccess; note?: string; unavailable?: string; reads?: boolean } {
  if (off) return {};
  const unready = box && agent.boxing ? agent.boxing.unready() : undefined;
  // What is named beside the folder is opened read only only where the box holds it (`FilesOnly.reads`).
  if (box && agent.boxing && !unready) return { access: "full", note: agent.boxing.note, reads: true };
  const why = unready ? { unavailable: unready } : {};
  return agent.filesOnly ? { access: "files", note: agent.filesOnly.note, ...why, ...(box && agent.filesOnly.reads ? { reads: true } : {}) } : why;
}

/** When the caller does not say how long a turn may run. */
export const DEFAULT_TIMEOUT_MS = 180_000;
/**
 * The longest a caller may ask for. A chat turn asks for at most 10 minutes
 * (the engine caps it). A piece of work that should run until it ends, such
 * as making a video, asks for no limit with 0; it can still be stopped.
 */
export const MAX_TIMEOUT_MS = 45 * 60_000;
/** Pictures a tool may answer with in one call, and the types an agent can see. */
const MAX_IMAGES = 8;
const MAX_IMAGE_BASE64 = 4_000_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * The model a turn runs on: the one the caller named; else, for a chat turn, the person's own setting for this agent
 * (`OPENSOURCEBOOK_AGENT_MODEL`, only for the connector's own agent), then the adapter's model for chat; for a piece of work, the
 * adapter's model for work. Undefined passes no model, so the agent runs on its own default: never another agent's.
 */
export function turnModel(agent: AgentAdapter, read: { model?: string; kind?: TurnKind }, person?: string): string | undefined {
  if (read.model) return read.model;
  if (read.kind === "work") return agent.defaultModels?.work;
  return person ?? agent.defaultModels?.chat;
}

/**
 * The effort a turn runs at: what the caller named; else, for a piece of work, the adapter's default for work (so the
 * person's chat effort never carries into a video); for a chat turn, the person's setting then the adapter's for chat.
 */
export function turnEffort(agent: AgentAdapter, read: { effort?: string; kind?: TurnKind }, person?: string): string | undefined {
  if (read.effort) return read.effort;
  if (read.kind === "work") return agent.defaultEfforts?.work;
  return person ?? agent.defaultEfforts?.chat;
}

/** What a turn is for: a chat's many small steps, or a long piece of work such as a video. */
export type TurnKind = "chat" | "work";

/** How long a turn runs: what the caller asked for, else the connector's default, never past the ceiling. */
export function turnTimeoutMs(requested: number | undefined, fallback: number = DEFAULT_TIMEOUT_MS): number | undefined {
  if (requested === 0) return undefined;
  return Math.min(requested ?? fallback, MAX_TIMEOUT_MS);
}

/** The pictures in a tool answer that an agent can be shown; anything else is dropped. */
export function readImages(value: unknown): ToolImage[] {
  if (!Array.isArray(value)) return [];
  const images: ToolImage[] = [];
  for (const item of value) {
    if (images.length >= MAX_IMAGES) break;
    if (typeof item !== "object" || item === null) continue;
    const { mimeType, dataBase64 } = item as Record<string, unknown>;
    if (typeof mimeType !== "string" || !IMAGE_TYPES.has(mimeType)) continue;
    if (typeof dataBase64 !== "string" || !dataBase64 || dataBase64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(dataBase64)) continue;
    images.push({ mimeType, dataBase64 });
  }
  return images;
}

export class Turns {
  private readonly turns = new Map<string, Turn>();
  /** The usage limit each agent last ran into, by agent id, until it answers again or the time it gave passes. */
  private readonly limits = new Map<string, AgentLimit>();
  /** The check under way for each agent, so a second request waits for the same answer. */
  private readonly probes = new Map<string, Promise<ProbeResult>>();
  private readonly options: TurnsOptions;
  private readonly fetch: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(options: TurnsOptions) {
    this.options = options;
    this.fetch = options.fetch ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
  }

  get size(): number {
    return this.turns.size;
  }

  async start(body: unknown, scope?: Scope): Promise<StartResult> {
    const read = readStart(body);
    if ("problem" in read) return { ok: false, status: 400, problem: "badRequest", message: read.problem };
    if (scope && read.workspace !== undefined) {
      const checked = checkWorkspace(read.workspace, this.options.home, undefined, scope.roots);
      if ("problem" in checked) return { ok: false, status: 403, problem: "badRequest", message: checked.problem };
      const inRoots = scope.roots.map(realPath).some((root) => within(checked.path, root) && checked.path !== root);
      if (!inRoots) return { ok: false, status: 403, problem: "badRequest", message: `workspace.path must be inside the ${scope.name} service's own folders.` };
    }
    if (this.turns.has(read.turnId)) return { ok: false, status: 409, problem: "badRequest", message: "That turn is already running." };
    const agentId = read.agent ?? this.options.defaults.agent;
    if (!agentId) return { ok: false, status: 400, problem: "agentMissing", message: "No agent was named for this turn, and this connector has none of its own: pick who answers." };
    const agent = this.options.agents.get(agentId);
    if (!agent) return { ok: false, status: 400, problem: "agentMissing", message: `This connector has no agent "${agentId}".` };
    // A turn that would only be refused is not started; without a known reset time it is tried, as a refusal costs nothing.
    const limit = this.limitOf(agent.id);
    if (limit?.resetsAt) return { ok: false, status: 429, problem: "agentLimit", message: limitMessage(agent.label, limit), limit };

    // A workspace is given as the agent and this computer allow (`workspaceAccess`); otherwise its own tools stay off.
    let workspace: string | undefined;
    let reach: Reach | undefined;
    const offer = read.workspace !== undefined ? workspaceAccess(agent, this.options.box, this.options.noWorkspaces) : {};
    if (offer.access) {
      const checked = checkWorkspace(read.workspace, this.options.home, undefined, [...(this.options.roots ?? []), ...(scope?.roots ?? [])]);
      if ("problem" in checked) return { ok: false, status: 400, problem: "badRequest", message: checked.problem };
      workspace = checked.path;
      // What the caller named beside the folder, opened read only when this agent here can be held to reading it.
      if (read.read?.length && offer.reads) {
        const reached = reachOf(workspace, read.read, this.options.home, undefined, [...(this.options.roots ?? []), ...(scope?.roots ?? [])]);
        if ("problem" in reached) return { ok: false, status: 400, problem: "badRequest", message: reached.problem };
        const around = dirname(workspace);
        if (scope && !scope.roots.map(realPath).some((root) => within(around, root) && around !== root)) return { ok: false, status: 403, problem: "badRequest", message: `workspace.read must be inside the ${scope.name} service's own folders.` };
        reach = reached.reach;
        if (reached.missing.length) this.log(`turn ${short(read.turnId)}: ${reached.missing.length} of what it may read beside its folder is not there`);
      }
    }
    if (read.workspace !== undefined && offer.unavailable) this.log(`turn ${short(read.turnId)}: ${offer.access ? "files only" : "no workspace"}: ${offer.unavailable}`);

    const turn: Turn = {
      id: read.turnId,
      agent: agent.id,
      ...(read.target ? { target: read.target } : {}),
      secret: randomBytes(32).toString("hex"),
      callback: read.callback,
      tools: read.tools,
      ...(read.instructions ? { instructions: read.instructions } : {}),
      ...(scope ? { scope: scope.name } : {}),
      startedAt: Date.now(),
      toolCalls: 0,
      drafts: new Set(read.drafts ?? []),
    };
    this.turns.set(turn.id, turn);
    turn.cwd = workspace ?? (await mkdtemp(join(tmpdir(), "opensourcebook-agent-")));
    if (workspace) turn.workspace = true;
    // A boxed agent's own temporary folder: the shared ones are shut in the box.
    if (workspace && this.options.box) turn.tmp = await boxTemp();
    const upstream = workspace && offer.access === "full" ? agent.boxing?.upstream?.() : undefined;
    if (upstream) turn.model = { secret: randomBytes(32).toString("hex"), upstream };
    const own = agent.id === this.options.defaults.agent;
    const model = turnModel(agent, read, own ? this.options.defaults.model : undefined);
    // The connector's own effort is for its own agent in chat; a piece of work uses its own default, never chat's.
    const effort = turnEffort(agent, read, own ? this.options.defaults.effort : undefined);
    if (effort) turn.effort = effort;
    turn.running = agent.run({
      turnId: turn.id,
      systemPrompt: read.systemPrompt,
      ...(read.keepAgentPrompt ? { keepAgentPrompt: true } : {}),
      prompt: read.prompt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      cwd: turn.cwd,
      mcp: { name: MCP_SERVER, url: `${this.options.baseUrl()}/mcp/${encodeURIComponent(turn.id)}`, headers: { Authorization: `Bearer ${turn.secret}` } },
      ...(turn.drafts.size ? { onDraft: (tool: string, input: string) => this.drafted(turn, tool, input) } : {}),
      ...(workspace
        ? {
            workspace: {
              access: offer.access!,
              ...(this.options.box ? { box: withReach(this.options.box, reach) } : {}),
              ...(reach ? { reach } : {}),
              connectorPort: Number(new URL(this.options.baseUrl()).port),
              ...(turn.tmp ? { tmp: turn.tmp } : {}),
              ...(turn.model ? { model: { baseUrl: `${this.options.baseUrl()}/model/${encodeURIComponent(turn.id)}`, secret: turn.model.secret } } : {}),
            },
          }
        : {}),
    });
    const timeoutMs = turnTimeoutMs(read.timeoutMs, this.options.timeoutMs);
    if (timeoutMs !== undefined) turn.timer = setTimeout(() => this.end(turn, "timedOut"), timeoutMs);
    this.log(`turn ${short(turn.id)}: started ${agent.id}${model ? ` (${model}${effort ? `, ${effort}` : ""})` : effort ? ` (${effort})` : ""}${!workspace ? "" : offer.access === "full" ? ", own tools on in its boxed workspace" : `, its file tools only in its workspace${this.options.box ? ", boxed" : ""}`}${reach ? `, ${readsOf(reach).length} more read only beside it` : ""}`);
    void turn.running.done.then((result) => this.finished(turn, result));
    return { ok: true, agent: agent.id, ...(model ? { model } : {}), ...(effort ? { effort } : {}), workspace: !!workspace, ...(workspace ? { access: offer.access! } : {}), ...(reach ? { read: true } : {}) };
  }

  /** The usage limit `agentId` last ran into, while it holds: until a turn of it ends well, or the reset time it gave passes. */
  limitOf(agentId: string): AgentLimit | undefined {
    const limit = this.limits.get(agentId);
    if (limit?.resetsAt && Date.parse(limit.resetsAt) <= Date.now()) {
      this.limits.delete(agentId);
      return undefined;
    }
    return limit;
  }

  /**
   * Checks whether `agentId` can answer, with the smallest turn there is: an empty folder, a one-line prompt, none of
   * Open Sourcebook's tools, its own default model, at most 90 seconds. Not run while a limit with a reset time still ahead is
   * remembered. One check per agent at a time; a second request gets the same answer. Undefined for an agent this
   * connector does not have.
   */
  probe(agentId: string): Promise<ProbeResult> | undefined {
    const agent = this.options.agents.get(agentId);
    if (!agent) return undefined;
    const running = this.probes.get(agent.id);
    if (running) return running;
    const limit = this.limitOf(agent.id);
    if (limit?.resetsAt) {
      this.log(`probe ${agent.id}: not run, its limit resets at ${limit.resetsAt}`);
      return Promise.resolve({ ok: false, problem: "agentLimit", limit });
    }
    const check = this.runProbe(agent).finally(() => this.probes.delete(agent.id));
    this.probes.set(agent.id, check);
    return check;
  }

  private async runProbe(agent: AgentAdapter): Promise<ProbeResult> {
    let ended: (problem: Problem | undefined) => void = () => undefined;
    const end = new Promise<Problem | undefined>((resolve) => (ended = resolve));
    const turn: Turn = { id: `probe-${agent.id}-${randomBytes(6).toString("hex")}`, agent: agent.id, secret: randomBytes(32).toString("hex"), tools: [], instructions: "No tools here: answer in words.", onEnd: ended, startedAt: Date.now(), toolCalls: 0, drafts: new Set() };
    this.turns.set(turn.id, turn);
    turn.cwd = await mkdtemp(join(tmpdir(), "opensourcebook-agent-"));
    turn.running = agent.run({
      turnId: turn.id,
      systemPrompt: PROBE_SYSTEM,
      prompt: PROBE_PROMPT,
      cwd: turn.cwd,
      mcp: { name: MCP_SERVER, url: `${this.options.baseUrl()}/mcp/${encodeURIComponent(turn.id)}`, headers: { Authorization: `Bearer ${turn.secret}` } },
    });
    turn.timer = setTimeout(() => this.end(turn, "timedOut"), PROBE_TIMEOUT_MS);
    void turn.running.done.then((result) => this.finished(turn, result));
    const problem = await end;
    if (!problem) return { ok: true };
    const limit = problem === "agentLimit" ? this.limitOf(agent.id) : undefined;
    return { ok: false, problem, ...(limit ? { limit } : {}) };
  }

  /** True while the turn runs here (not yet reported as ended); for a narrower caller, only a turn it started. */
  has(turnId: string, scope?: Scope): boolean {
    const turn = this.turns.get(turnId);
    return !!turn && (!scope || turn.scope === scope.name);
  }

  /** Stops a turn the engine asked to stop. False when it is not running here (or, for a narrower caller, not its own). */
  stop(turnId: string, scope?: Scope): boolean {
    const turn = this.turns.get(turnId);
    if (!turn || (scope && turn.scope !== scope.name)) return false;
    this.end(turn, "stopped");
    return true;
  }

  /**
   * Where a boxed turn's model call goes, when it carries that turn's secret (as a bearer token or an API key header)
   * and the turn is still running; undefined otherwise.
   */
  model(turnId: string, authorization: string | undefined, apiKey: string | undefined): Upstream | undefined {
    const turn = this.turns.get(turnId);
    if (!turn?.model || turn.ending) return undefined;
    const given = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : (apiKey ?? "");
    return safeEqual(given, turn.model.secret) ? turn.model.upstream : undefined;
  }

  /** One MCP request from the agent of `turnId`; undefined when the turn or its secret is wrong. */
  async mcp(turnId: string, authorization: string | undefined, message: unknown): Promise<{ body: unknown } | undefined> {
    const turn = this.turns.get(turnId);
    const secret = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!turn || !safeEqual(secret, turn.secret)) return undefined;
    const body = await handleMcp(message, {
      tools: turn.tools,
      ...(turn.instructions ? { instructions: turn.instructions } : {}),
      call: (name, args) => this.callTool(turn, name, args),
    });
    return { body };
  }

  /**
   * Unfinished input of a tool the engine asked to see while written: the
   * newest goes to the engine at most every DRAFT_MS, never two at once.
   * Best effort: a draft that does not arrive is replaced by the next, and
   * by the call itself.
   */
  private drafted(turn: Turn, tool: string, input: string): void {
    if (turn.ending || !turn.drafts.has(tool)) return;
    // `calls` says which call this will be (the tool calls made before it), so a draft that
    // arrives after its call is known as old.
    turn.draft = { tool, input, calls: turn.toolCalls };
    turn.draftTimer ??= setTimeout(() => void this.sendDraft(turn), DRAFT_MS);
  }

  private async sendDraft(turn: Turn): Promise<void> {
    turn.draftTimer = undefined;
    const draft = turn.draft;
    if (!draft || turn.ending || !turn.callback) return;
    if (turn.drafting) {
      turn.draftTimer = setTimeout(() => void this.sendDraft(turn), DRAFT_MS);
      return;
    }
    turn.draft = undefined;
    turn.drafting = true;
    try {
      await this.fetch(`${turn.callback.url}/draft`, {
        method: "POST",
        headers: { authorization: `Bearer ${turn.callback.token}`, "content-type": "application/json" },
        body: JSON.stringify(draft),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The next draft, or the call itself, says it again.
    } finally {
      turn.drafting = false;
    }
  }

  private async callTool(turn: Turn, name: string, args: unknown): Promise<ToolAnswer> {
    if (turn.ending) return { text: "This turn is over; stop now.", isError: true };
    if (!turn.callback) return { text: "There are no tools here; answer in words.", isError: true };
    turn.toolCalls += 1;
    // The call itself supersedes what was drafted of it.
    if (turn.draft?.tool === name) {
      turn.draft = undefined;
      clearTimeout(turn.draftTimer);
      turn.draftTimer = undefined;
    }
    try {
      const response = await this.fetch(`${turn.callback.url}/tools`, {
        method: "POST",
        headers: { authorization: `Bearer ${turn.callback.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await response.json().catch(() => ({}))) as { text?: unknown; isError?: unknown; images?: unknown };
      if (typeof body.text === "string") {
        const images = readImages(body.images);
        return { text: body.text, isError: body.isError === true, ...(images.length ? { images } : {}) };
      }
      return { text: `Open Sourcebook did not answer that (status ${response.status}). Try once more, or reply to the person.`, isError: true };
    } catch {
      return { text: "Open Sourcebook could not be reached just now. Try once more, or reply to the person.", isError: true };
    }
  }

  /** Ends a turn from here (stop, time out): the agent is killed and its end is reported as `problem`. */
  private end(turn: Turn, problem: Problem): void {
    if (turn.ending) return;
    turn.ending = problem;
    turn.running?.kill();
  }

  private async finished(turn: Turn, result: TurnEnd): Promise<void> {
    clearTimeout(turn.timer);
    clearTimeout(turn.draftTimer);
    turn.draft = undefined;
    // A stop or time-out from here wins over how the killed process looks.
    const problem = turn.ending ?? (result.ok ? undefined : (result.problem ?? "error"));
    const durationMs = Date.now() - turn.startedAt;
    const limit = problem === "agentLimit" && (result.limit?.resetsAt || result.limit?.resets) ? result.limit : undefined;
    this.remember(turn.agent, problem, limit);
    const outcome: UsageOutcome = !problem ? "done" : problem === "stopped" ? "stopped" : "failed";
    const inputTokens =
      result.inputTokens ?? (result.cacheReadTokens === undefined && result.cacheWriteTokens === undefined ? (result.tokensIn ?? null) : null);
    if (turn.callback && this.options.usageLog) {
      try {
        appendUsageLog(this.options.usageLog, {
          time: new Date().toISOString(),
          type: turn.target?.type ?? null,
          targetId: turn.target?.id ?? null,
          turnId: turn.id,
          agent: turn.agent,
          model: result.model ?? null,
          effort: turn.effort ?? null,
          inputTokens,
          outputTokens: result.tokensOut ?? null,
          cacheReadTokens: result.cacheReadTokens ?? null,
          cacheWriteTokens: result.cacheWriteTokens ?? null,
          costUsd: result.costUsd ?? null,
          durationMs,
          toolCalls: turn.toolCalls,
          outcome,
        });
      } catch (error) {
        this.log(`turn ${short(turn.id)}: could not write usage log: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const report = {
      outcome: problem ? "failed" : "done",
      ...(problem ? { problem } : {}),
      ...(limit ? { limit } : {}),
      ...(result.text ? { text: result.text } : {}),
      // The agent's own words on why it failed, when it ended with an error of its own (not a stop or time-out from here).
      ...(problem && !turn.ending && result.said ? { said: result.said } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(turn.effort ? { effort: turn.effort } : {}),
      ...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.firstTokensIn !== undefined ? { firstTokensIn: result.firstTokensIn } : {}),
      ...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
      ...(result.cacheReadTokens !== undefined ? { cacheReadTokens: result.cacheReadTokens } : {}),
      ...(result.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.cacheWriteTokens } : {}),
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      // How many of the caller's tools the agent called: none means it ended before any work.
      toolCalls: turn.toolCalls,
      durationMs,
    };
    this.log(`${turn.callback ? `turn ${short(turn.id)}` : `probe ${turn.agent}`}: ${problem ?? (turn.callback ? "done" : "ok")}${limit ? `, resets ${limit.resets ?? limit.resetsAt}` : ""} in ${(durationMs / 1000).toFixed(1)}s, ${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}${result.firstTokensIn !== undefined ? `, first call ${result.firstTokensIn} in` : ""}${result.detail && problem ? ` (${result.detail})` : ""}`);
    this.turns.delete(turn.id);
    if (turn.cwd && !turn.workspace) await rm(turn.cwd, { recursive: true, force: true }).catch(() => undefined);
    if (turn.tmp) await rm(turn.tmp, { recursive: true, force: true }).catch(() => undefined);
    if (!turn.callback) return turn.onEnd?.(problem);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetch(`${turn.callback.url}/finish`, {
          method: "POST",
          headers: { authorization: `Bearer ${turn.callback.token}`, "content-type": "application/json" },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok || response.status === 404) return;
      } catch {
        // tried again once below
      }
    }
    this.log(`turn ${short(turn.id)}: could not tell the engine it ended`);
  }

  /**
   * Keeps what a turn's end says about its agent's usage limit: a limit is remembered (since when, and when it resets
   * as last heard), and an end without a problem forgets it. Any other end says nothing about it.
   */
  private remember(agentId: string, problem: Problem | undefined, heard: LimitReset | undefined): void {
    if (!problem) {
      this.limits.delete(agentId);
      return;
    }
    if (problem !== "agentLimit") return;
    const before = this.limitOf(agentId);
    const reset = heard ?? { ...(before?.resetsAt ? { resetsAt: before.resetsAt } : {}), ...(before?.resets ? { resets: before.resets } : {}) };
    this.limits.set(agentId, { since: before?.since ?? new Date().toISOString(), ...reset });
  }
}

/** Why a turn was not started, in one plain sentence. */
function limitMessage(label: string, limit: AgentLimit): string {
  return `${label} has used up its plan's usage for now; it said it resets ${limit.resets ?? `at ${limit.resetsAt}`}.`;
}

interface StartBody {
  turnId: string;
  systemPrompt: string;
  prompt: string;
  tools: ToolListing[];
  callback: { url: string; token: string };
  agent?: string;
  model?: string;
  effort?: string;
  /** A chat turn (the default) or a piece of work: with no model named, it picks the adapter's model for that kind. */
  kind?: TurnKind;
  /** 0 for no limit. */
  timeoutMs?: number;
  /** The system prompt is added to the agent's own instructions rather than replacing them. */
  keepAgentPrompt?: boolean;
  instructions?: string;
  drafts?: string[];
  /** The caller's folder for a turn with the agent's own tools on, boxed; checked in start. */
  workspace?: string;
  /** Paths beside the workspace, in the folder that holds it, the agent may read but not change (`reachOf`). */
  read?: unknown[];
  /** What the turn is for, recorded in the usage log. */
  target?: TurnTarget;
}

function readStart(body: unknown): StartBody | { problem: string } {
  if (typeof body !== "object" || body === null) return { problem: "The body must be a JSON object." };
  const value = body as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" && (value[key] as string).trim() ? (value[key] as string) : undefined);
  const turnId = text("turnId");
  if (!turnId || !/^[A-Za-z0-9-]{1,100}$/.test(turnId)) return { problem: "turnId is required." };
  const systemPrompt = text("systemPrompt");
  const prompt = text("prompt");
  if (!systemPrompt || !prompt) return { problem: "systemPrompt and prompt are required." };
  const tools = Array.isArray(value.tools) ? value.tools : undefined;
  if (!tools || !tools.every((tool) => typeof tool === "object" && tool !== null && typeof (tool as ToolListing).name === "string" && typeof (tool as ToolListing).description === "string")) {
    return { problem: "tools must be a list of { name, description, inputSchema }." };
  }
  const callback = value.callback as Record<string, unknown> | undefined;
  if (!callback || typeof callback.url !== "string" || typeof callback.token !== "string" || !callback.token) return { problem: "callback { url, token } is required." };
  // Local only: the connector calls back only to an engine on this machine.
  if (!isLoopback(callback.url)) return { problem: "The callback must be on this computer." };
  const timeoutMs = typeof value.timeoutMs === "number" && (value.timeoutMs === 0 || value.timeoutMs >= 1_000) ? value.timeoutMs : undefined;
  let target: TurnTarget | undefined;
  if (typeof value.target === "object" && value.target !== null && !Array.isArray(value.target)) {
    const raw = value.target as Record<string, unknown>;
    const type = typeof raw.type === "string" && raw.type.trim() ? raw.type.trim().slice(0, 64) : undefined;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 200) : undefined;
    if (type || id) target = { ...(type ? { type } : {}), ...(id ? { id } : {}) };
  }
  return {
    turnId,
    systemPrompt,
    prompt,
    tools: tools as ToolListing[],
    callback: { url: callback.url.replace(/\/$/, ""), token: callback.token },
    ...(text("agent") ? { agent: text("agent")! } : {}),
    ...(text("model") ? { model: text("model")! } : {}),
    ...(text("effort") ? { effort: text("effort")! } : {}),
    ...(value.kind === "work" || value.kind === "chat" ? { kind: value.kind } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(value.keepAgentPrompt === true ? { keepAgentPrompt: true } : {}),
    ...(text("instructions") ? { instructions: text("instructions")!.slice(0, 2_000) } : {}),
    ...(typeof value.workspace === "object" && value.workspace !== null ? { workspace: String((value.workspace as Record<string, unknown>).path ?? "") } : {}),
    ...(typeof value.workspace === "object" && value.workspace !== null && Array.isArray((value.workspace as Record<string, unknown>).read) ? { read: ((value.workspace as Record<string, unknown>).read as unknown[]).slice(0, 50) } : {}),
    ...(target ? { target } : {}),
    // Only names of tools this turn has.
    ...(Array.isArray(value.drafts) ? { drafts: value.drafts.filter((name): name is string => typeof name === "string" && (tools as ToolListing[]).some((tool) => tool.name === name)) } : {}),
  };
}

function short(id: string): string {
  return id.slice(0, 8);
}
