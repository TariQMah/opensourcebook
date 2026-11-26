/**
 * Outputs and usage (docs/api.md, "Outputs" and "Usage").
 *
 *   GET /v1/outputs                 → 200 { outputs, nextCursor? }   the Library; ?project=none, ?type=, ?q=, paged
 *   GET /v1/projects/:id/outputs    → 200 { outputs, nextCursor? }   ?type=, paged
 *   GET /v1/plans/:id/outputs       → 200 { outputs }                 item run order, newest first per item
 *   GET /v1/outputs/:id             → 200 { output }                  with payload, citations, prompt, settings, sources,
 *                                                                     remakesScene when one of its scenes can be made again,
 *                                                                     remakeOf when it is such a remake, and
 *                                                                     changedChunks (each such cite `changed`) when a
 *                                                                     passage it cites changed in its file since
 *   PUT /v1/outputs/:id/payload     → 200 { output }                  changed by hand, for a format that takes it (a guide)
 *   GET /v1/projects/:id/usage      → 200 { usage }
 *   GET /v1/plans/:id/usage         → 200 { usage, items: [{ id, usage }] }
 *
 * Lists leave out archived outputs and payloads. `itemId` is the code's
 * `node_id`; `planId` comes from the item. Every output is served through the
 * registry: under its format's current id, and a payload stored at an older
 * schema version upgraded at read time (`FormatRegistry.served`).
 */
import { authenticate, errorResponse, json, notFound, pageBody, pageParams, readJsonObject } from "../http";
import type { PlacedOutput } from "../studio/repositories";
import { isFormatId, type Citation } from "../studio/types";
import type { EngineDeps } from "../wiring";
import { ownedPlan } from "./plans";
import { ownedProject } from "./projects";
import { remakeOfJob } from "./remake";

export async function listOutputs(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  if (project !== null && project !== "none") return errorResponse("invalid_request", "project may only be none", 400);
  return pagedOutputs(url, deps, { ownerId: auth.ownerId, ...(project === "none" ? { projectId: null } : {}) });
}

export async function listProjectOutputs(request: Request, projectId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, projectId, deps);
  if ("response" in owned) return owned.response;
  return pagedOutputs(new URL(request.url), deps, { ownerId: owned.ownerId, projectId });
}

export async function listPlanOutputs(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  return json({ outputs: (await deps.repos.outputs.listByPlan(planId)).map((output) => listedOutput(deps, deps.registry.served(output))) });
}

export async function getOutput(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const output = await deps.repos.outputs.getPlaced(id);
  if (!output || output.ownerId !== auth.ownerId) return notFound("Output not found");
  const served = deps.registry.served(output);
  // A remake of one scene says what it remade; a thing one of whose scenes can be made again says so.
  const made = await deps.jobs.findByOutput?.(output.id);
  const remade = made ? remakeOfJob(made) : undefined;
  const remakesScene = (deps.registry.get(served.type)?.remakeScene?.scenes(served.payload).length ?? 0) > 0;
  const full = fullOutput(deps, served);
  const changed = await changedCites(deps, served.citations);
  return json({
    output: {
      ...full,
      ...(changed.size > 0 ? { citations: served.citations.map((cite) => (cite.chunkId && changed.has(cite.chunkId) ? { ...cite, changed: true } : cite)), changedChunks: [...changed] } : {}),
      ...(remakesScene ? { remakesScene: true } : {}),
      ...(remade ? { remakeOf: { outputId: remade.outputId, scene: remade.scene } } : {}),
    },
  });
}

/**
 * The passages this output cites that are no longer in their source's text: the source is a file of a linked folder
 * that changed and was read again (#71). Its cites still open the passage as it was; they say it has changed.
 */
async function changedCites(deps: EngineDeps, citations: Citation[]): Promise<Set<string>> {
  const cites = citations.filter((cite): cite is Citation & { chunkId: string } => typeof cite.chunkId === "string" && cite.chunkId.length > 0);
  return cites.length > 0 ? deps.repos.sources.changedChunks(cites) : new Set();
}

/**
 * A made output as the person changed it by hand. The body is the whole
 * thing as they now have it, in its format's own shape; the format lays it
 * over what is kept (`FormatDefinition.edit`) and answers what is wrong when
 * it cannot. A format that is not changed by hand refuses it.
 */
export async function editOutput(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const stored = await deps.repos.outputs.getPlaced(id);
  if (!stored || stored.ownerId !== auth.ownerId) return notFound("Output not found");
  const output = deps.registry.served(stored);
  const format = deps.registry.get(output.type);
  if (!format?.edit) return errorResponse("not_editable", `A ${format?.descriptor.singular ?? output.type} is not changed by hand.`, 409);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const change = format.edit(output.payload, read.body, new Date().toISOString());
  if (!change.ok) return errorResponse("invalid_edit", change.problems.join(" "), 400);
  await deps.repos.outputs.setEdited(id, change);
  const kept = await deps.repos.outputs.getPlaced(id);
  return json({ output: fullOutput(deps, deps.registry.served(kept!)) });
}

export async function projectUsage(request: Request, projectId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, projectId, deps);
  if ("response" in owned) return owned.response;
  return json({ usage: await deps.repos.usage.totals("project", projectId) });
}

export async function planUsage(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const nodes = await deps.repos.plans.listNodes(planId);
  const items = [];
  for (const node of nodes) items.push({ id: node.id, usage: await deps.repos.usage.totals("node", node.id) });
  return json({ usage: await deps.repos.usage.totals("plan", planId), items });
}

async function pagedOutputs(url: URL, deps: EngineDeps, filter: { ownerId: string; projectId?: string | null }): Promise<Response> {
  const paging = pageParams(url);
  if ("response" in paging) return paging.response;
  const type = url.searchParams.get("type");
  if (type !== null && !isFormatId(type)) return errorResponse("invalid_request", "type must be a format id", 400);
  const search = url.searchParams.get("q")?.trim().slice(0, 200);
  // Asking for a format finds rows stored under its old ids too.
  const page = await deps.repos.outputs.page({ ...filter, ...(type ? { types: deps.registry.storedTypes(type) } : {}), ...(search ? { search } : {}) }, paging);
  return json(pageBody("outputs", page, (output) => listedOutput(deps, deps.registry.served(output))));
}

function listedOutput(deps: EngineDeps, output: PlacedOutput): Record<string, unknown> {
  const glimpse = deps.registry.glimpse(output);
  const size = deps.registry.size(output);
  return {
    id: output.id,
    type: output.type,
    title: output.title,
    summary: output.summary,
    ...(output.projectId ? { projectId: output.projectId } : {}),
    ...(output.planId ? { planId: output.planId } : {}),
    ...(output.nodeId ? { itemId: output.nodeId } : {}),
    ...(output.category ? { category: output.category } : {}),
    ...(glimpse ? { glimpse } : {}),
    ...(size ? { size } : {}),
    ...(output.done !== undefined ? { done: output.done } : {}),
    schemaVersion: output.schemaVersion,
    ...(output.costUsd !== undefined ? { costUsd: output.costUsd } : {}),
    createdAt: output.createdAt,
    updatedAt: output.updatedAt,
  };
}

function fullOutput(deps: EngineDeps, output: PlacedOutput): Record<string, unknown> {
  return {
    ...listedOutput(deps, output),
    ...(output.archivedAt ? { archivedAt: output.archivedAt } : {}),
    payload: output.payload,
    citations: output.citations,
    ...(output.prompt !== undefined ? { prompt: output.prompt } : {}),
    ...(output.settings !== undefined ? { settings: output.settings } : {}),
    sources: output.sources,
  };
}
