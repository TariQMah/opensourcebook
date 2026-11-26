/**
 * The connector's HTTP server, on this computer only (127.0.0.1).
 *
 *   GET  /status[?fresh=1]     → 200 { agent?, model?, effort?, agents: [{ id, label, installed, version?, signedIn?, apiKey?, note?, unavailable?, mark?, models?, makers?, defaultModels?, defaultEfforts?, efforts?, signIn?, install?, workspace, workspaceAccess?, workspaceNote?, workspaceUnavailable?, workspaceReads?, limit? }] }
 *   POST /turns               → 202 { ok, agent, model?, effort?, workspace, access?, read? }   start a turn (the engine, the scenes service)
 *                               429 { problem: "agentLimit", message, limit }   not started: the agent's limit resets later
 *   GET  /turns/:id           → 200 { running }       whether that turn still runs here (the engine, to tell a dropped turn)
 *   POST /turns/:id/stop      → 200 { ok }            stop it (the engine)
 *   POST /agents/:id/probe    → 200 { ok } | { ok: false, problem, limit? }   whether that agent answers now, with the smallest turn
 *   GET  /usage[?limit=&before=] → 200 { turns, next?, off? }   the finished turns in the usage log, newest first, with no cost
 *   POST /mcp/:turnId         → 200 JSON-RPC          Open Sourcebook's tools for that turn's agent
 *   *    /model/:turnId/...    → the provider's answer  a boxed turn's model calls, forwarded with the person's API key
 *
 * `limit` is { since, resetsAt?, resets? }: a usage limit the agent ran into, since when, and when it said it resets
 * (an exact ISO time, its own words), each only when it said so. The routes above the MCP one take the connector's
 * token (`Authorization: Bearer`). The scenes service may hold a narrower one instead (`scenes`): /status, POST /turns
 * with a work folder inside its own folders (or none), and GET and stop of the turns it started; 403 for the rest.
 * The MCP and model routes take the turn's own secrets, which only that
 * turn's agent has. The model route adds the API key the person gave the
 * connector, so that key never enters the box; nothing here reads, holds
 * or forwards the agent's own login.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Box } from "./box.ts";
import type { AgentRegistry } from "./agents/registry.ts";
import { marksOf } from "./agents/marks.ts";
import type { AgentAdapter, AgentInfo } from "./agents/types.ts";
import { safeEqual } from "./net.ts";
import { forwardModelCall } from "./model-proxy.ts";
import { readUsageLog, USAGE_PAGE_MAX } from "./usage-log.ts";
import { turnEffort, turnModel, Turns, workspaceAccess, type Scope, type TurnDefaults } from "./turns.ts";

export interface ConnectorOptions {
  token: string;
  /**
   * A second, narrower token for the scenes service: it may read /status, start turns whose work folder is inside one
   * of `roots` (or that have none), and see and stop only the turns it started. Nothing else.
   */
  scenes?: { token: string; roots: string[] };
  agents: AgentRegistry;
  defaults: TurnDefaults;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
  /** The box for workspace turns (`./box.ts`); none on a computer without one. */
  box?: Box;
  /** True gives no turn a workspace: every agent's own tools stay off. */
  noWorkspaces?: boolean;
  /** Path to the JSONL file where finished turns' usage is appended. */
  usageLog?: string;
  /** The home folder a workspace is checked against; the user's own unless a test names one. */
  home?: string;
}

const MAX_BODY = 2_000_000;
const STATUS_CACHE_MS = 30_000;

export function createConnector(options: ConnectorOptions): { server: Server; turns: Turns } {
  let base = "";
  const turns = new Turns({
    agents: options.agents,
    defaults: options.defaults,
    baseUrl: () => base,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.box ? { box: options.box } : {}),
    ...(options.noWorkspaces ? { noWorkspaces: true } : {}),
    ...(options.scenes?.roots.length ? { roots: options.scenes.roots } : {}),
    ...(options.home ? { home: options.home } : {}),
    ...(options.usageLog ? { usageLog: options.usageLog } : {}),
  });
  let cached: { at: number; body: unknown } | undefined;

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => send(response, 500, { error: "internal_error" }));
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address === "object") base = `http://127.0.0.1:${address.port}`;
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // A boxed agent's model calls, signed with its turn's secret; the connector adds the person's API key (./model-proxy.ts).
    const model = /^\/model\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (model) {
      // Claude Code checks it can reach its API (unsigned) before it starts; that says nothing, so it is answered here.
      if (request.method === "HEAD") return void response.writeHead(200).end();
      // The secret comes as a bearer token, or as an API key in the header its provider's own API reads it from.
      const upstream = turns.model(decodeURIComponent(model[1]!), header(request, "authorization"), header(request, "x-api-key") ?? header(request, "x-goog-api-key"));
      if (!upstream) return send(response, 401, { error: "unauthorized" });
      return forwardModelCall(request, response, upstream, model[2]!, url.search, options.fetch);
    }
    const mcp = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    if (mcp) {
      if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
      const message = await readJson(request);
      const answer = await turns.mcp(decodeURIComponent(mcp[1]!), header(request, "authorization"), message);
      if (!answer) return send(response, 401, { error: "unauthorized" });
      if (answer.body === undefined) return send(response, 202);
      return send(response, 200, answer.body);
    }

    const bearer = header(request, "authorization");
    const given = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
    // Both compared, each in constant time, whichever it is.
    const full = safeEqual(given, options.token);
    const narrow = !!options.scenes && safeEqual(given, options.scenes.token);
    if (!full && !narrow) return send(response, 401, { error: "unauthorized" });
    const scope: Scope | undefined = full ? undefined : { name: "scenes", roots: options.scenes!.roots };
    // The scenes service's token: only what it uses (/status, starting turns, and its own turns' state and stop).
    if (scope && !(request.method === "GET" && url.pathname === "/status") && !(request.method === "POST" && url.pathname === "/turns") && !/^\/turns\/[^/]+(\/stop)?$/.test(url.pathname)) return send(response, 403, { error: "forbidden" });

    if (request.method === "GET" && url.pathname === "/status") {
      if (!cached || Date.now() - cached.at > STATUS_CACHE_MS || url.searchParams.get("fresh") === "1") {
        const agents = await Promise.all(options.agents.list().map(
            async (agent) => {
              const entry = { id: agent.id, label: agent.label, ...(agent.models?.length ? { models: agent.models } : {}), ...(agent.defaultModels?.chat || agent.defaultModels?.work ? { defaultModels: agent.defaultModels } : {}), ...(agent.defaultEfforts?.chat || agent.defaultEfforts?.work ? { defaultEfforts: agent.defaultEfforts } : {}), ...(agent.efforts?.length ? { efforts: agent.efforts } : {}), ...(agent.replacesWorkPrompt ? { replacesWorkPrompt: true } : {}), ...(agent.signIn ? { signIn: agent.signIn } : {}), ...(agent.install ? { install: agent.install } : {}), ...(await agent.info()), ...workspaceOf(agent, options.box, options.noWorkspaces) } satisfies AgentInfo & { id: string; label: string; workspace: boolean; workspaceUnavailable?: string };
              return { ...entry, ...marksOf(agent, entry.models) };
            },
          ));
        // The connector's own agent, only when the person named one (OPENSOURCEBOOK_AGENT), and the model and effort a chat turn of
        // it runs on when none is named. None by default: no provider is preferred.
        const main = options.defaults.agent ? options.agents.get(options.defaults.agent) : undefined;
        const model = main ? turnModel(main, {}, options.defaults.model) : undefined;
        const effort = main ? turnEffort(main, {}, options.defaults.effort) : undefined;
        cached = { at: Date.now(), body: { ...(main ? { agent: main.id } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), agents, running: turns.size } };
      }
      // A limit is added on every answer, never kept in the cache: it comes and goes with each turn.
      const body = cached.body as { agents: Array<{ id: string }> };
      const agents = body.agents.map((agent) => {
        const limit = turns.limitOf(agent.id);
        return limit ? { ...agent, limit } : agent;
      });
      return send(response, 200, { ...body, agents, running: turns.size });
    }
    if (request.method === "POST" && url.pathname === "/turns") {
      const started = await turns.start(await readJson(request), scope);
      if (started.ok) return send(response, 202, { ok: true, agent: started.agent, ...(started.model ? { model: started.model } : {}), ...(started.effort ? { effort: started.effort } : {}), workspace: started.workspace, ...(started.access ? { access: started.access } : {}), ...(started.read ? { read: true } : {}) });
      return send(response, started.status, { problem: started.problem, message: started.message, ...(started.limit ? { limit: started.limit } : {}) });
    }
    const probe = /^\/agents\/([^/]+)\/probe$/.exec(url.pathname);
    if (request.method === "POST" && probe) {
      request.resume();
      const checked = turns.probe(decodeURIComponent(probe[1]!));
      if (!checked) return send(response, 404, { error: "not_found" });
      return send(response, 200, await checked);
    }
    if (request.method === "GET" && url.pathname === "/usage") return send(response, ...(await usage(url.searchParams)));
    const one = /^\/turns\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && one) return send(response, 200, { running: turns.has(decodeURIComponent(one[1]!), scope) });
    const stop = /^\/turns\/([^/]+)\/stop$/.exec(url.pathname);
    if (request.method === "POST" && stop) return send(response, 200, { ok: turns.stop(decodeURIComponent(stop[1]!), scope) });
    return send(response, 404, { error: "not_found" });
  }

  /** The usage log, newest first (`./usage-log.ts`); `off: true` when the person turned it off (`OPENSOURCEBOOK_USAGE_LOG=off`). */
  async function usage(query: URLSearchParams): Promise<[number, unknown]> {
    const limit = wholeOf(query.get("limit"));
    const before = wholeOf(query.get("before"));
    if (limit === null || (limit !== undefined && (limit < 1 || limit > USAGE_PAGE_MAX)) || before === null || (before !== undefined && before < 1)) {
      return [400, { error: "invalid_request", message: `limit is 1 to ${USAGE_PAGE_MAX}, before a line of the log from 1` }];
    }
    if (!options.usageLog) return [200, { turns: [], off: true }];
    try {
      return [200, await readUsageLog(options.usageLog, { ...(limit ? { limit } : {}), ...(before ? { before } : {}) })];
    } catch (error) {
      options.log?.(`usage log could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return [500, { error: "unreadable", message: "The usage log could not be read." }];
    }
  }

  return { server, turns };
}

/** A whole number from a query, undefined when not given, null when it is not one. */
function wholeOf(value: string | null): number | undefined | null {
  if (value === null || value === "") return undefined;
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * What a turn that asks for a workspace gets with this agent here: `workspace` whether it gets one, `workspaceAccess`
 * which (`files`: its file tools only, on its own login; `full`: its shell, files and web in the box, on an API key),
 * `workspaceNote` that in the adapter's words, and `workspaceUnavailable` why it doesn't get everything.
 */
function workspaceOf(agent: AgentAdapter, box: Box | undefined, off?: boolean): { workspace: boolean; workspaceAccess?: string; workspaceNote?: string; workspaceUnavailable?: string; workspaceReads?: boolean } {
  const offer = workspaceAccess(agent, box, off);
  return { workspace: !!offer.access, ...(offer.access ? { workspaceAccess: offer.access } : {}), ...(offer.note ? { workspaceNote: offer.note } : {}), ...(offer.unavailable ? { workspaceUnavailable: offer.unavailable } : {}), ...(offer.access && offer.reads ? { workspaceReads: true } : {}) };
}
