/**
 * The agent connector on this computer (services/agent-connector): it runs the person's own agent, boxed in, with only
 * the tools a turn brings. This service starts a turn, is that turn's callback, asks whether it still runs, and stops it.
 */

export type AgentProblem = "agentUnreachable" | "agentMissing" | "agentSignedOut" | "agentLimit" | "timedOut" | "stopped" | "error";

/** When the agent said its plan's usage limit resets: an exact time, its own words, each only when it said so. */
export interface LimitReset {
  /** ISO time. */
  resetsAt?: string;
  /** The agent's own words, e.g. "3pm (Europe/Berlin)". */
  resets?: string;
}

/** The reset of a limit as it came, with only the fields that are strings; undefined when it says neither. */
export function readLimit(raw: unknown): LimitReset | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const resetsAt = typeof r.resetsAt === "string" && r.resetsAt.trim() ? r.resetsAt.trim().slice(0, 64) : undefined;
  const resets = typeof r.resets === "string" && r.resets.trim() ? r.resets.trim().slice(0, 200) : undefined;
  return resetsAt || resets ? { ...(resetsAt ? { resetsAt } : {}), ...(resets ? { resets } : {}) } : undefined;
}

export interface AgentStatus {
  reachable: boolean;
  id?: string;
  label?: string;
  /** The model a video's turn asks for; absent when the agent runs on its own default. */
  model?: string;
  /** The effort a video's turn asks for; absent when left to the agent's own default. */
  effort?: string;
  problem?: AgentProblem;
  /** The agent can work in a folder of its own with some of its own tools on. */
  workspace?: boolean;
  /** Which of its own tools it has there: `files` (its file tools only, on its own login) or `full` (also its shell and the web, boxed). */
  access?: "files" | "full";
  /** What a turn names beside its folder (`StartTurn.workspace.read`) is opened to this agent here, read only. */
  reads?: boolean;
  /** True when this agent's adapter declares that work turns can replace its built-in instructions. */
  replacesWorkPrompt?: boolean;
}

export interface StartTurn {
  turnId: string;
  systemPrompt: string;
  prompt: string;
  tools: { name: string; description: string; inputSchema: unknown }[];
  callback: { url: string; token: string };
  instructions?: string;
  /** How long the turn may run; 0 lets it run until it ends or is stopped. */
  timeoutMs: number;
  /** Add the system prompt to the agent's own instructions instead of replacing them. */
  keepAgentPrompt?: boolean;
  /**
   * A folder for the agent to work in with its own tools on, as far as the connector allows (`AgentStatus.access`), and
   * what beside it, in the folder that holds it, the agent may read without changing, where it can (`AgentStatus.reads`).
   */
  workspace?: { path: string; read?: string[] };
  /** An agent, model, and effort for this turn alone, over the ones set for videos. */
  agent?: string;
  model?: string;
  effort?: string;
  /** What the turn is for, recorded in the connector's usage log. */
  target?: { type: string; id: string };
}

export interface ConnectorConfig {
  url: string;
  token: string;
  agent?: string;
  /** The model for videos (SCENES_AGENT_MODEL); none runs the agent on its own default for a piece of work. */
  model?: string;
  effort?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export class Connector {
  readonly config: ConnectorConfig;
  private readonly fetch: typeof fetch;
  private readonly cached = new Map<string, { at: number; status: AgentStatus }>();
  private defaultAgent?: string;

  constructor(config: ConnectorConfig, fetchImpl: typeof fetch = fetch) {
    if (!isLoopback(config.url)) throw new Error("The agent connector must be on this computer (127.0.0.1).");
    this.config = { ...config, url: config.url.replace(/\/$/, "") };
    this.fetch = fetchImpl;
  }

  private headers() {
    return { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" };
  }

  /** Whether the named agent (or configured/connector default) can run a turn now, cached for 10 s unless `fresh`. */
  async status(fresh = false, agentId?: string): Promise<AgentStatus> {
    const cacheKey = agentId ?? "";
    const hit = this.cached.get(cacheKey);
    if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.status;
    let status: AgentStatus;
    try {
      const response = await this.fetch(`${this.config.url}/status`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as {
        agent?: string;
        agents?: {
          id: string;
          label: string;
          installed: boolean;
          signedIn?: boolean;
          apiKey?: boolean;
          unavailable?: string;
          workspace?: boolean;
          workspaceAccess?: string;
          workspaceReads?: boolean;
          defaultModels?: { work?: string };
          defaultEfforts?: { work?: string };
          replacesWorkPrompt?: boolean;
        }[];
      };
      if (body.agent) this.defaultAgent = body.agent;
      const id = agentId ?? this.config.agent ?? body.agent;
      const agent = body.agents?.find((a) => a.id === id);
      // Configured model/effort (`SCENES_AGENT_MODEL`/`SCENES_AGENT_EFFORT`) belong only to the configured or default agent.
      const configuredAgent = !agentId || (this.config.agent ? agentId === this.config.agent : agentId === body.agent);
      const model = (configuredAgent ? this.config.model : undefined) ?? (typeof agent?.defaultModels?.work === "string" ? agent.defaultModels.work : undefined);
      const effort = (configuredAgent ? this.config.effort : undefined) ?? (typeof agent?.defaultEfforts?.work === "string" ? agent.defaultEfforts.work : undefined);
      status = {
        reachable: true,
        ...(id ? { id } : {}),
        ...(agent ? { label: agent.label } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        // A connector from before files-only folders offered only the full one.
        ...(agent?.workspace ? { workspace: true, access: agent.workspaceAccess === "files" ? ("files" as const) : ("full" as const) } : {}),
        ...(agent?.workspace && agent.workspaceReads === true ? { reads: true } : {}),
        ...(agent?.replacesWorkPrompt === true ? { replacesWorkPrompt: true } : {}),
        ...(!agent || !agent.installed || agent.unavailable ? { problem: "agentMissing" as const } : agent.signedIn === false && !agent.apiKey ? { problem: "agentSignedOut" as const } : {}),
      };
    } catch {
      status = { reachable: false, problem: "agentUnreachable" };
    }
    this.cached.set(cacheKey, { at: Date.now(), status });
    return status;
  }

  /** Starts a turn. Refused with `agentLimit` (a 429) while the agent's limit has not reset, with when it said it would. */
  async start(turn: StartTurn): Promise<{ ok: true; agent: string; model?: string; effort?: string; workspace: boolean } | { ok: false; problem: AgentProblem; message: string; limit?: LimitReset }> {
    // A piece of work: with no model or effort set, the connector runs the agent on its adapter's defaults for work.
    const { agent: turnAgent, model: turnModel, effort: turnEffort, ...rest } = turn;
    const agent = turnAgent ?? this.config.agent;
    const configuredAgent = !turnAgent || (this.config.agent ? turnAgent === this.config.agent : turnAgent === this.defaultAgent);
    const model = turnModel ?? (configuredAgent ? this.config.model : undefined);
    const effort = turnEffort ?? (configuredAgent ? this.config.effort : undefined);
    const body = { ...rest, kind: "work", ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    try {
      const response = await this.fetch(`${this.config.url}/turns`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const answer = (await response.json().catch(() => ({}))) as { agent?: string; model?: string; effort?: string; problem?: string; message?: string; workspace?: boolean; limit?: unknown };
      if (response.ok) return { ok: true, agent: answer.agent ?? agent ?? "agent", ...(answer.model ? { model: answer.model } : {}), ...(answer.effort ? { effort: answer.effort } : {}), workspace: answer.workspace === true };
      const problem = (["agentMissing", "agentSignedOut", "agentLimit"] as const).find((p) => p === answer.problem) ?? (response.status === 429 ? "agentLimit" : "error");
      const limit = problem === "agentLimit" ? readLimit(answer.limit) : undefined;
      return { ok: false, problem, message: answer.message ?? `The connector answered ${response.status}.`, ...(limit ? { limit } : {}) };
    } catch {
      return { ok: false, problem: "agentUnreachable", message: "The agent connector is not running on this computer." };
    }
  }

  /**
   * Whether a turn still runs on the connector: `reachable` false when the connector did not answer, `running` absent
   * when it answered without saying (a connector from before it could tell).
   */
  async running(turnId: string): Promise<{ reachable: boolean; running?: boolean }> {
    try {
      const response = await this.fetch(`${this.config.url}/turns/${encodeURIComponent(turnId)}`, { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return { reachable: true };
      const body = (await response.json().catch(() => ({}))) as { running?: unknown };
      return typeof body.running === "boolean" ? { reachable: true, running: body.running } : { reachable: true };
    } catch {
      return { reachable: false };
    }
  }

  async stop(turnId: string): Promise<void> {
    await this.fetch(`${this.config.url}/turns/${encodeURIComponent(turnId)}/stop`, { method: "POST", headers: this.headers(), body: "{}", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
}
