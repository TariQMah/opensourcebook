/**
 * Open Sourcebook engine worker entry point: HTTP routes and the queue handler.
 *
 *   GET  /health
 *   GET  /v1/assets/:id        public, immutable
 *   GET  /v1/formats           format descriptors
 *   GET  /v1/edge-kinds        the kinds of link between plan items
 *   GET  /v1/video-makers      who can make videos here, and whether each can now
 *   GET  /v1/video-makers/:maker/styles/:style/preview   a picture of a maker's style
 *   POST /v1/uploads   GET /v1/uploads/types
 *   GET  /v1/plans/:id/progress   items with status, done ticks and results
 *   POST /v1/plans/:id/items/:itemId/done     tick or un-tick an item, record its result
 *   POST /v1/plans/:id/items/:itemId/progress keep where the person stopped in an item
 *   POST /v1/plans/:id/items/:itemId/answer   answer an "ask me" branch
 *   POST /v1/plans/:id/items/:itemId/retry    make a failed item again, or carry on a stopped one
 *   POST /v1/plans/:id/items/:itemId/stop     stop one item; the rest of the plan goes on
 *   POST /v1/sources           GET|PATCH|DELETE /v1/sources/:id   POST /v1/sources/:id/retry
 *   Studio API (docs/api.md):
 *   POST|GET /v1/projects      GET|PATCH|DELETE /v1/projects/:id   POST /v1/projects/:id/(archive|unarchive)
 *   GET /v1/projects/:id/sources   GET /v1/inbox   POST /v1/sources/:id/file   GET /v1/sources/:id/file (its own uploaded file)
 *   POST /v1/projects/:id/make   POST /v1/projects/:id/make/settle   (one thing at once, no chat)
 *   GET|POST /v1/projects/:id/plans   GET|PATCH|DELETE /v1/plans/:id   PUT /v1/plans/:id/stages/:level
 *   POST /v1/plans/:id/items   PATCH|DELETE /v1/plans/:id/items/:itemId   POST /v1/plans/:id/reorder
 *   POST|DELETE /v1/plans/:id/edges   POST /v1/plans/:id/(approve|start|cancel|resume)   POST /v1/plans/:id/maker
 *   GET /v1/outputs   GET /v1/outputs/:id   GET /v1/(projects|plans)/:id/(outputs|usage)
 *   POST /v1/outputs/:id/scenes/:scene/remake   (one scene of a made thing made again, as a new output)
 *   GET|POST /v1/projects/:id/chats   GET|PATCH|DELETE /v1/chats/:id   POST /v1/chats/:id/messages
 *   GET /v1/chats/:id/usage   GET /v1/skills   POST /v1/chats/:id/stop   GET /v1/agent
 *   POST /v1/chats/:id/messages/:messageId/pieces/:piece/close   (a make sheet's Cancel)
 *   GET|POST /v1/plans/:id/items/:itemId/thread   GET /v1/threads   (the thread on a made thing, in its chat)
 *   GET /v1/providers   PATCH /v1/providers/:id   (the person's agents that can answer the chat)
 *   GET|PUT /v1/setup   (first-time setup: how far the person is, and whether it is done)
 *   GET|PUT /v1/voice   PUT|DELETE /v1/voice/services/:service/key   GET /v1/voice/services/:service/voices[/:voiceId/sample]
 *   POST /v1/agent-turns/:id/(tools|draft|finish)  (the connector of the person's own agent; turn token)
 *   POST /v1/work-turns/:id/(tools|draft|finish)   (the same, for flashcards or a quiz the agent makes; turn token)
 *   GET /v1/make-times   (how long things took to make here, from past runs only)
 *   GET /v1/activity     (what is being made now, the agents' finished turns and what they took)
 *   POST /v1/jobs              GET /v1/jobs/:id   POST /v1/jobs/:id/retry   POST /v1/jobs/:id/cancel
 *   POST /v1/jobs/:id/files/show   (opens the folder a job works in, on this computer)
 *                              (the August API, kept as a wrapper for the iOS app)
 *
 * Every /v1 route but assets needs the client token. The queue handler runs
 * generation jobs from the main queue and ends jobs the dead-letter queue
 * hands back.
 */
import { handleDeadLetterBatch, handleJobBatch } from "./jobs/consumer";
import { batchConcurrency } from "./jobs/lanes";
import type { JobQueueBatch } from "./jobs/types";
import { errorResponse, json, notFound } from "./http";
import { cancelLegacyJob, createJob, getJob, retryLegacyJob } from "./routes/jobs";
import { showJobFiles } from "./routes/job-files";
import { listEdgeKinds, listFormats } from "./routes/formats";
import {
  addEdge,
  addItem,
  approvePlan,
  cancelPlan,
  deletePlan,
  createPlan,
  resumePlan,
  deleteItem,
  getPlan,
  listProjectPlans,
  removeEdge,
  reorderItems,
  retryItem,
  stopItem,
  catchUpPlan,
  setStage,
  startPlan,
  updateItem,
  updatePlan,
} from "./routes/plan-edits";
import { editOutput, getOutput, listOutputs, listPlanOutputs, listProjectOutputs, planUsage, projectUsage } from "./routes/outputs";
import { remakeScene } from "./routes/remake";
import { makeInProject } from "./routes/make";
import { answerItem, changePlanMaker, getPlanProgress, keepProgress, tickItem } from "./routes/plans";
import { createUpload, getAsset, uploadTypes } from "./routes/media";
import {
  archiveProject,
  createProject,
  deleteProject,
  exportProjectBundle,
  fileSource,
  getProject,
  importProjectBundle,
  listInbox,
  listProjectSources,
  listProjects,
  updateProject,
} from "./routes/projects";
import { createSource, deleteSource, getSource, getSourceFile, renameSource, retrySource } from "./routes/sources";
import { agentDraft, agentFinish, agentStatus, agentTool, stopChat } from "./routes/agent";
import { workFinish, workTool } from "./routes/work-turns";
import { rememberEngineOrigin } from "./chat/agent/work";
import { chatUsage, closeProposal, createChat, deleteChat, getChat, listChats, listSkills, sendMessage, updateChat } from "./routes/chats";
import { getThread, listThreads, sendThreadMessage } from "./routes/threads";
import { listDue } from "./routes/due";
import { PlanLockedError } from "./studio/repositories/plans";
import { PickNeededError, pickNeededResponse } from "./chat/providers";
import type { WorkerBindings, WorkerEnv, WorkerExecutionContext } from "./types";
import { withNewNames } from "./old-names";
import { listProviders, putProviderPick, putProviderPicks, updateProvider } from "./routes/providers";
import { listMakeTimes } from "./routes/make-times";
import { getActivity } from "./routes/activity";
import { getSetup, putSetup } from "./routes/setup";
import { listVideoMakers, styleSample } from "./routes/video-makers";
import { deleteVoiceKey, getVoice, listVoiceOptions, putVoice, putVoiceKey, voiceSample } from "./routes/voice";
import { consumerOptions, depsForEnv, keepJobsInBackground, refreshMakerStatus, refreshMakerStatusSoon, type EngineDeps } from "./wiring";

const noopContext: WorkerExecutionContext = { waitUntil: () => undefined };

export async function handleRequest(
  request: Request,
  deps: EngineDeps | undefined,
  ctx: WorkerExecutionContext = noopContext,
): Promise<Response> {
  try {
    return await route(request, deps, ctx);
  } catch (error) {
    // An edit that lost a race with Start: the repository refused the write.
    if (error instanceof PlanLockedError) return errorResponse("plan_locked", "A started plan's items cannot change", 409);
    // Nothing picked and several providers could do it: the person is asked (chat/providers.ts, resolvePick).
    if (error instanceof PickNeededError) return pickNeededResponse(error);
    console.error(`${request.method} ${new URL(request.url).pathname}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return errorResponse("internal_error", "Something went wrong on the engine", 500);
  }
}

async function route(request: Request, deps: EngineDeps | undefined, ctx: WorkerExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return json(null, 204);
  if (method === "GET" && path === "/health") return json({ ok: true });
  if (!path.startsWith("/v1/")) return notFound();
  // A piece of work the person's agent does lives in the job that waits on it, not in the database.
  const workTurn = /^\/v1\/work-turns\/([^/]+)\/(tools|draft|finish)$/.exec(path);
  if (method === "POST" && workTurn) {
    const id = decodeURIComponent(workTurn[1]);
    if (workTurn[2] === "draft") return json({ ok: true });
    return workTurn[2] === "tools" ? workTool(request, id) : workFinish(request, id);
  }
  // Where the connector calls back for a job's piece of work, which runs outside any request.
  rememberEngineOrigin(request.url);
  if (!deps) return errorResponse("database_unavailable", "The database is not bound on this Worker (the RE_JOB_DB binding in wrangler.toml)", 503);

  const asset = /^\/v1\/assets\/([A-Za-z0-9._~-]+)$/.exec(path);
  if (method === "GET" && asset) return getAsset(decodeURIComponent(asset[1]), deps, request.headers.get("range"));
  if (method === "GET" && path === "/v1/formats") return listFormats(request, deps);
  if (method === "GET" && path === "/v1/edge-kinds") return listEdgeKinds(request, deps);
  if (method === "GET" && path === "/v1/video-makers") return listVideoMakers(request, deps);
  const sample = /^\/v1\/video-makers\/([^/]+)\/styles\/([^/]+)\/preview$/.exec(path);
  if (method === "GET" && sample) return styleSample(request, decodeURIComponent(sample[1]), decodeURIComponent(sample[2]), deps);
  if (method === "POST" && path === "/v1/uploads") return createUpload(request, deps);
  if (method === "GET" && path === "/v1/uploads/types") return uploadTypes(request, deps);
  if (method === "POST" && path === "/v1/sources") return createSource(request, deps);
  const source = /^\/v1\/sources\/([^/]+)$/.exec(path);
  if (method === "GET" && source) return getSource(request, decodeURIComponent(source[1]), deps);
  if (method === "PATCH" && source) return renameSource(request, decodeURIComponent(source[1]), deps);
  if (method === "DELETE" && source) return deleteSource(request, decodeURIComponent(source[1]), deps);
  const sourceRetry = /^\/v1\/sources\/([^/]+)\/retry$/.exec(path);
  if (method === "POST" && sourceRetry) return retrySource(request, decodeURIComponent(sourceRetry[1]), deps);

  const fileTo = /^\/v1\/sources\/([^/]+)\/file$/.exec(path);
  if (method === "POST" && fileTo) return fileSource(request, decodeURIComponent(fileTo[1]), deps);
  if (method === "GET" && fileTo) return getSourceFile(request, decodeURIComponent(fileTo[1]), deps);
  if (method === "GET" && path === "/v1/inbox") return listInbox(request, deps);

  if (path === "/v1/projects") {
    if (method === "POST") return createProject(request, deps);
    if (method === "GET") return listProjects(request, deps);
  }
  if (method === "POST" && path === "/v1/projects/import") return importProjectBundle(request, deps);
  const making = /^\/v1\/projects\/([^/]+)\/make(\/settle)?$/.exec(path);
  if (making && method === "POST") return makeInProject(request, decodeURIComponent(making[1]!), deps, Boolean(making[2]));
  const project = /^\/v1\/projects\/([^/]+)(?:\/(archive|unarchive|sources|plans|outputs|usage|chats|export))?$/.exec(path);
  if (project) {
    const id = decodeURIComponent(project[1]);
    if (!project[2] && method === "GET") return getProject(request, id, deps);
    if (!project[2] && method === "PATCH") return updateProject(request, id, deps);
    if (!project[2] && method === "DELETE") return deleteProject(request, id, deps);
    if (project[2] === "sources" && method === "GET") return listProjectSources(request, id, deps);
    if (project[2] === "plans" && method === "GET") return listProjectPlans(request, id, deps);
    if (project[2] === "plans" && method === "POST") return createPlan(request, id, deps);
    if (project[2] === "outputs" && method === "GET") return listProjectOutputs(request, id, deps);
    if (project[2] === "export" && method === "GET") return exportProjectBundle(request, id, deps);
    if (project[2] === "usage" && method === "GET") return projectUsage(request, id, deps);
    if (project[2] === "chats" && method === "GET") return listChats(request, id, deps);
    if (project[2] === "chats" && method === "POST") return createChat(request, id, deps);
    if ((project[2] === "archive" || project[2] === "unarchive") && method === "POST") return archiveProject(request, id, project[2] === "archive", deps);
  }

  const planMaker = /^\/v1\/plans\/([^/]+)\/maker$/.exec(path);
  if (method === "POST" && planMaker) return changePlanMaker(request, decodeURIComponent(planMaker[1]!), deps);
  const plan = /^\/v1\/plans\/([^/]+)(?:\/(progress|items|reorder|edges|approve|start|cancel|resume|outputs|usage))?$/.exec(path);
  if (plan) {
    const id = decodeURIComponent(plan[1]);
    const action = plan[2];
    if (method === "GET" && !action) return getPlan(request, id, deps);
    if (method === "PATCH" && !action) return updatePlan(request, id, deps);
    if (method === "DELETE" && !action) return deletePlan(request, id, deps);
    if (method === "GET" && action === "progress") return getPlanProgress(request, id, deps);
    if (method === "GET" && action === "outputs") return listPlanOutputs(request, id, deps);
    if (method === "GET" && action === "usage") return planUsage(request, id, deps);
    if (method === "POST" && action === "items") return addItem(request, id, deps);
    if (method === "POST" && action === "reorder") return reorderItems(request, id, deps);
    if (method === "POST" && action === "edges") return addEdge(request, id, deps);
    if (method === "DELETE" && action === "edges") return removeEdge(request, id, deps);
    if (method === "POST" && action === "approve") return approvePlan(request, id, deps);
    if (method === "POST" && action === "start") return startPlan(request, id, deps);
    if (method === "POST" && action === "cancel") return cancelPlan(request, id, deps);
    if (method === "POST" && action === "resume") return resumePlan(request, id, deps);
  }
  const stage = /^\/v1\/plans\/([^/]+)\/stages\/([^/]+)$/.exec(path);
  if (method === "PUT" && stage) return setStage(request, decodeURIComponent(stage[1]), decodeURIComponent(stage[2]), deps);
  const catchUp = /^\/v1\/plans\/([^/]+)\/catch-up$/.exec(path);
  if (method === "POST" && catchUp) return catchUpPlan(request, decodeURIComponent(catchUp[1]!), deps);
  if (method === "GET" && path === "/v1/due") return listDue(request, deps);
  const item = /^\/v1\/plans\/([^/]+)\/items\/([^/]+)$/.exec(path);
  if (item) {
    const [planId, itemId] = [decodeURIComponent(item[1]), decodeURIComponent(item[2])];
    if (method === "PATCH") return updateItem(request, planId, itemId, deps);
    if (method === "DELETE") return deleteItem(request, planId, itemId, deps);
  }

  const planItem = /^\/v1\/plans\/([^/]+)\/items\/([^/]+)\/(done|answer|retry|stop|progress)$/.exec(path);
  if (method === "POST" && planItem) {
    const [planId, itemId] = [decodeURIComponent(planItem[1]), decodeURIComponent(planItem[2])];
    if (planItem[3] === "retry") return retryItem(request, planId, itemId, deps);
    if (planItem[3] === "stop") return stopItem(request, planId, itemId, deps);
    if (planItem[3] === "progress") return keepProgress(request, planId, itemId, deps);
    return planItem[3] === "done" ? tickItem(request, planId, itemId, deps) : answerItem(request, planId, itemId, deps);
  }

  const thread = /^\/v1\/plans\/([^/]+)\/items\/([^/]+)\/thread$/.exec(path);
  if (thread) {
    const [planId, itemId] = [decodeURIComponent(thread[1]!), decodeURIComponent(thread[2]!)];
    if (method === "GET") return getThread(request, planId, itemId, deps);
    if (method === "POST") return sendThreadMessage(request, planId, itemId, deps);
  }
  if (method === "GET" && path === "/v1/threads") return listThreads(request, deps);

  if (method === "GET" && path === "/v1/skills") return listSkills(request, deps);
  if (method === "GET" && path === "/v1/agent") return agentStatus(request, deps);
  if (method === "GET" && path === "/v1/providers") return listProviders(request, deps);
  if (method === "PUT" && path === "/v1/providers/picks") return putProviderPicks(request, deps);
  const providerPick = /^\/v1\/providers\/picks\/([^/]+)$/.exec(path);
  if (method === "PUT" && providerPick) return putProviderPick(request, decodeURIComponent(providerPick[1]!), deps);
  const provider = /^\/v1\/providers\/([^/]+)$/.exec(path);
  if (method === "PATCH" && provider) return updateProvider(request, decodeURIComponent(provider[1]), deps);
  if (method === "GET" && path === "/v1/setup") return getSetup(request, deps);
  if (method === "PUT" && path === "/v1/setup") return putSetup(request, deps);
  if (path === "/v1/voice" && method === "GET") return getVoice(request, deps);
  if (path === "/v1/voice" && method === "PUT") return putVoice(request, deps);
  const voiceKey = /^\/v1\/voice\/services\/([^/]+)\/key$/.exec(path);
  if (voiceKey && method === "PUT") return putVoiceKey(request, decodeURIComponent(voiceKey[1]!), deps);
  if (voiceKey && method === "DELETE") return deleteVoiceKey(request, decodeURIComponent(voiceKey[1]!), deps);
  const voiceList = /^\/v1\/voice\/services\/([^/]+)\/voices$/.exec(path);
  if (voiceList && method === "GET") return listVoiceOptions(request, decodeURIComponent(voiceList[1]!), deps);
  const voiceHeard = /^\/v1\/voice\/services\/([^/]+)\/voices\/([^/]+)\/sample$/.exec(path);
  if (voiceHeard && method === "GET") return voiceSample(request, decodeURIComponent(voiceHeard[1]!), decodeURIComponent(voiceHeard[2]!), deps);
  const chat = /^\/v1\/chats\/([^/]+)(?:\/(messages|usage|stop))?$/.exec(path);
  if (chat) {
    const id = decodeURIComponent(chat[1]);
    if (method === "GET" && !chat[2]) return getChat(request, id, deps);
    if (method === "PATCH" && !chat[2]) return updateChat(request, id, deps);
    if (method === "DELETE" && !chat[2]) return deleteChat(request, id, deps);
    if (method === "POST" && chat[2] === "messages") return sendMessage(request, id, deps);
    if (method === "POST" && chat[2] === "stop") return stopChat(request, id, deps);
    if (method === "GET" && chat[2] === "usage") return chatUsage(request, id, deps);
  }
  const proposalClose = /^\/v1\/chats\/([^/]+)\/messages\/([^/]+)\/pieces\/(\d+)\/close$/.exec(path);
  if (method === "POST" && proposalClose) return closeProposal(request, decodeURIComponent(proposalClose[1]!), decodeURIComponent(proposalClose[2]!), Number(proposalClose[3]), deps);
  const agentTurn = /^\/v1\/agent-turns\/([^/]+)\/(tools|draft|finish)$/.exec(path);
  if (method === "POST" && agentTurn) {
    const id = decodeURIComponent(agentTurn[1]);
    if (agentTurn[2] === "draft") return agentDraft(request, id, deps);
    return agentTurn[2] === "tools" ? agentTool(request, id, deps) : agentFinish(request, id, deps);
  }

  if (method === "GET" && path === "/v1/outputs") return listOutputs(request, deps);
  const output = /^\/v1\/outputs\/([^/]+)$/.exec(path);
  if (method === "GET" && output) return getOutput(request, decodeURIComponent(output[1]), deps);
  const edited = /^\/v1\/outputs\/([^/]+)\/payload$/.exec(path);
  if (method === "PUT" && edited) return editOutput(request, decodeURIComponent(edited[1]), deps);
  const remade = /^\/v1\/outputs\/([^/]+)\/scenes\/([^/]+)\/remake$/.exec(path);
  if (method === "POST" && remade) return remakeScene(request, decodeURIComponent(remade[1]!), decodeURIComponent(remade[2]!), deps, ctx);

  if (method === "POST" && path === "/v1/jobs") return createJob(request, deps, ctx);
  const files = /^\/v1\/jobs\/([^/]+)\/files\/show$/.exec(path);
  if (method === "POST" && files) return showJobFiles(request, decodeURIComponent(files[1]!), deps);
  const job = /^\/v1\/jobs\/([^/]+)(?:\/(retry|cancel))?$/.exec(path);
  if (job) {
    const id = decodeURIComponent(job[1]);
    if (method === "GET" && !job[2]) return getJob(request, id, deps);
    if (method === "POST" && job[2] === "retry") return retryLegacyJob(request, id, deps, ctx);
    if (method === "POST" && job[2] === "cancel") return cancelLegacyJob(request, id, deps);
  }

  if (method === "GET" && path === "/v1/make-times") return listMakeTimes(request, deps);
  if (method === "GET" && path === "/v1/activity") return getActivity(request, deps);

  return notFound();
}

export default {
  async fetch(request: Request, bindings: WorkerBindings = {}, ctx: WorkerExecutionContext = noopContext): Promise<Response> {
    const env: WorkerEnv = withNewNames(bindings);
    await refreshMakerStatusSoon(env, ctx);
    const deps = depsForEnv(env);
    if (deps) keepJobsInBackground(deps, ctx);
    return handleRequest(request, deps, ctx);
  },

  async queue(batch: JobQueueBatch, bindings: WorkerBindings, ctx: WorkerExecutionContext = noopContext): Promise<void> {
    const env: WorkerEnv = withNewNames(bindings);
    await refreshMakerStatus(env);
    // Throwing retries the whole batch; without a database nothing can be decided.
    const deps = depsForEnv(env);
    if (!deps) throw new Error("The database is not bound (the RE_JOB_DB binding in wrangler.toml); job messages cannot be processed.");
    keepJobsInBackground(deps, ctx);
    if (env.OPENSOURCEBOOK_JOB_DEAD_LETTER_QUEUE && batch.queue === env.OPENSOURCEBOOK_JOB_DEAD_LETTER_QUEUE) {
      await handleDeadLetterBatch(batch, { store: deps.jobs, ...(deps.consumer?.onFinished ? { onFinished: deps.consumer.onFinished } : {}) });
      return;
    }
    // Heavy items are made one at a time (jobs/lanes.ts); every other line runs a few side by side.
    const concurrency = batchConcurrency(batch.queue, env.OPENSOURCEBOOK_JOB_HEAVY_QUEUE);
    await handleJobBatch(batch, { ...consumerOptions(deps), ...(concurrency ? { concurrency } : {}) });
  },
};
