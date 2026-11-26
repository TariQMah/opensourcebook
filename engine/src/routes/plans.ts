/**
 * Plan progress and done ticks (docs/DECISIONS.md #26, #28): progress is
 * which items the person has ticked done, not time.
 *
 *   GET  /v1/plans/:id/progress                  → 200 { plan, stages, items, counts, counts }
 *
 * `items` are the plan's items in stage then position order, each with its
 * status, its output id when it has one, the person's `done`/`doneAt` tick
 * and recorded `result`, and `asking: { question? }` while it is an
 * undecided "ask me" branch. `counts` is { total, done } over the items that
 * can still be done (enabled and not skipped by a branch).
 *
 * `done` ticks (true) or un-ticks (false) an item; the first tick's time is
 * kept when it is sent again, an un-tick keeps the result. `result` replaces
 * the item's whole recorded result (its shape belongs to the format) and may
 * be sent with or without a tick. `doneAt` is the engine's clock at the
 * request, so a tick a phone syncs late carries the sync time. Ticking or
 * recording a result needs the item to have an output (409 item_not_ready
 * otherwise); un-ticking never does. An `outputId` must be an output of that
 * item (400 output_mismatch). Writes are refused on a plan that has not
 * started (409 plan_not_started). The plan runner is advanced after every
 * write, so branches waiting on a result move at once.
 *
 * `progress` (POST .../items/:itemId/progress) is where the person stopped
 * in the item, kept apart from the result: it never moves a branch, and
 * writing it leaves the tick and the result alone (keepProgress below).
 *
 * `answer` is the person's reply to an "ask me" branch. It is accepted only
 * while that branch is still pending in a running plan (409 not_asking); it
 * decides the branch (true runs it, false skips it).
 *
 * `maker` (POST /v1/plans/:id/maker) changes who makes the items not made
 * yet: before Start, or while the plan is stopped or failed (changePlanMaker).
 *
 * A plan another client owns, or an item that is not in the plan, is 404.
 */
import { hasJobFiles } from "./job-files";
import { failureWords, waitingWords } from "../jobs/failure-words";
import { waitOf } from "../jobs/waits";
import { sameLine } from "../jobs/lanes";
import { choiceOf } from "../jobs/lifecycle";
import { authenticate, errorResponse, json, notFound, readJsonObject } from "../http";
import type { GenerationJob } from "../jobs/types";
import { jobKey, nodeStatusFor } from "../studio/plan-runner";
import { DONE_BY_KEY } from "../studio/output-runner";
import type { Plan, PlanNode, PlanStage, PlanStageDate } from "../studio/repositories";
import type { JsonValue } from "../studio/types";
import type { EngineDeps } from "../wiring";
import { PlanMakerChangeError, type PlanMakerChange } from "../studio/plan-runner";
import { planView } from "./plan-edits";
import { remakeOfJob } from "./remake";

export async function getPlanProgress(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  return json(await progressView(deps, owned.plan));
}

const MAX_RESULT_CHARS = 64_000;

export async function tickItem(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { body } = read;
  const target = await writableItem(request, planId, itemId, deps, typeof body.clientToken === "string" ? body.clientToken : undefined);
  if ("response" in target) return target.response;
  const { plan, node } = target;

  if (body.done !== undefined && typeof body.done !== "boolean") return errorResponse("invalid_request", "done must be true or false", 400);
  if (body.outputId !== undefined && typeof body.outputId !== "string") return errorResponse("invalid_request", "outputId must be text", 400);
  if (body.result !== undefined && JSON.stringify(body.result).length > MAX_RESULT_CHARS) {
    return errorResponse("result_too_large", `A result is at most ${MAX_RESULT_CHARS} characters of JSON`, 413);
  }
  const done = body.done ?? true;
  const needsOutput = done || body.result !== undefined || body.outputId !== undefined;
  if (needsOutput) {
    const latest = await deps.repos.outputs.latestForNode(node.id);
    if (!latest) return errorResponse("item_not_ready", "This item has no output yet", 409);
    if (body.outputId !== undefined) {
      const output = await deps.repos.outputs.get(body.outputId);
      if (!output || output.nodeId !== node.id) return errorResponse("output_mismatch", "That output does not belong to this item", 400);
    }
  }
  await deps.repos.results.set(node.id, {
    done,
    ...(body.result === undefined ? {} : { result: body.result as JsonValue }),
    ...(body.outputId === undefined ? {} : { outputId: body.outputId }),
  });
  return respondAfterWrite(deps, plan, node.id);
}

const MAX_PROGRESS_CHARS = 16_000;

/**
 * Where the person stopped in an item (`{ progress }`, an object whose shape
 * belongs to the format; `null` clears it). It keeps the done tick and the
 * result as they are and decides nothing, so the plan is not advanced. Like
 * a tick it needs the item to have an output.
 */
export async function keepProgress(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { body } = read;
  const target = await writableItem(request, planId, itemId, deps, typeof body.clientToken === "string" ? body.clientToken : undefined);
  if ("response" in target) return target.response;
  const { plan, node } = target;
  const progress = body.progress;
  if (progress !== null && (typeof progress !== "object" || Array.isArray(progress))) {
    return errorResponse("invalid_request", "progress must be an object, or null to clear it", 400);
  }
  if (progress !== null && JSON.stringify(progress).length > MAX_PROGRESS_CHARS) {
    return errorResponse("progress_too_large", `A progress is at most ${MAX_PROGRESS_CHARS} characters of JSON`, 413);
  }
  if (!(await deps.repos.outputs.latestForNode(node.id))) return errorResponse("item_not_ready", "This item has no output yet", 409);
  await deps.repos.results.set(node.id, { progress: progress as JsonValue | null });
  const view = (await progressView(deps, plan)) as { items: Array<{ id: string }> };
  return json({ item: view.items.find((item) => item.id === node.id) });
}

export async function answerItem(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { body } = read;
  const target = await writableItem(request, planId, itemId, deps, typeof body.clientToken === "string" ? body.clientToken : undefined);
  if ("response" in target) return target.response;
  const { plan, node } = target;
  if (typeof body.answer !== "boolean") return errorResponse("invalid_request", "answer must be true or false", 400);
  if (plan.status !== "running" || !deps.plans?.askOf(node)) {
    return errorResponse("not_asking", "This item is not waiting for an answer", 409);
  }
  await deps.repos.results.set(node.id, { result: { answer: body.answer } });
  return respondAfterWrite(deps, plan, node.id);
}

/** Owner, plan started, item in the plan; the runner is needed to move waiting branches. */
async function writableItem(
  request: Request,
  planId: string,
  itemId: string,
  deps: EngineDeps,
  bodyToken: string | undefined,
): Promise<{ plan: Plan; node: PlanNode } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken, bodyToken);
  if ("response" in auth) return auth;
  const plan = await deps.repos.plans.get(planId);
  if (!plan || plan.ownerId !== auth.ownerId) return { response: notFound("Plan not found") };
  const node = await deps.repos.plans.getNode(itemId);
  if (!node || node.planId !== plan.id) return { response: notFound("Item not found") };
  if (!deps.plans) return { response: errorResponse("plans_unavailable", "Plans cannot be advanced on this Worker", 503) };
  // A plan cancelled before Start never ran either.
  if (!plan.kickedOffAt) {
    return { response: errorResponse("plan_not_started", "The plan has not been started", 409) };
  }
  return { plan, node };
}

async function respondAfterWrite(deps: EngineDeps, plan: Plan, itemId: string): Promise<Response> {
  await deps.plans!.advance(plan.id);
  const view = (await progressView(deps, (await deps.repos.plans.get(plan.id))!)) as { items: Array<{ id: string }>; counts: unknown };
  return json({ item: view.items.find((item) => item.id === itemId), counts: view.counts });
}

/** Stages with a label, a day or both, lowest level first. */
function stageViews(labels: readonly PlanStage[], dates: readonly PlanStageDate[]): Array<{ level: number; label?: string; dueOn?: string }> {
  const byLevel = new Map<number, { level: number; label?: string; dueOn?: string }>();
  for (const { level, label } of labels) byLevel.set(level, { level, label });
  for (const { level, dueOn } of dates) byLevel.set(level, { ...(byLevel.get(level) ?? { level }), dueOn });
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

export async function ownedPlan(request: Request, planId: string, deps: EngineDeps): Promise<{ plan: Plan; ownerId: string } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  const plan = await deps.repos.plans.get(planId);
  if (!plan || plan.ownerId !== auth.ownerId) return { response: notFound("Plan not found") };
  return { plan, ownerId: auth.ownerId };
}

/**
 * What an item's job is doing: its own status, stage and progress, and what
 * each validation found. A failed job says why in plain words
 * (`errorMessage`, jobs/failure-words.ts) and keeps its technical text apart
 * (`errorDetail`).
 */
export function jobView(job: GenerationJob, thing: string, ahead: GenerationJob[] = []): Record<string, unknown> {
  const validation = job.state.validation;
  const failed = job.status === "failed" || job.status === "dead";
  const running = job.status === "running";
  const step = job.status === "queued" ? queuedStep(job, ahead) : job.state.step;
  const waiting = waitingWords(job, thing);
  const wait = waiting ? waitOf(job) : undefined;
  const choice = choiceOf(job);
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempt: job.attempt,
    // What it is doing now in plain words, while it runs, when its engine says (studio/output-runner.ts); while it is
    // queued, what it waits for.
    ...((running || job.status === "queued") && typeof step === "string" && step ? { step } : {}),
    // Waiting (a restart, the agent's plan limit): the step says so, `waiting` says why, what is kept and when it is tried again.
    ...(waiting && wait
      ? {
          step: waiting.step,
          waiting: {
            reason: waiting.reason,
            words: waiting.words,
            since: wait.since,
            nextTryAt: wait.nextAt,
            tries: wait.tries,
            ...(wait.resetsAt ? { resetsAt: wait.resetsAt } : {}),
            ...(wait.resets ? { resets: wait.resets } : {}),
          },
        }
      : {}),
    ...(running && job.startedAt ? { startedAt: job.startedAt } : {}),
    // When its maker expects it done, from what this computer has done before, or that it cannot be known now.
    ...(running ? doneByView(job) : {}),
    // A way on the person may take instead of waiting (finishing a video without sound): a button on the item.
    ...(choice ? { choice: { id: choice.id, label: choice.label } } : {}),
    ...(failed ? { errorMessage: failureWords(job, thing) } : {}),
    ...(failed && job.errorMessage ? { errorDetail: job.errorMessage } : {}),
    ...(Array.isArray(validation) && validation.length > 0 ? { validation } : {}),
  };
}

/**
 * What a queued item waits for, when something else of the person's is being made on this computer now: those things
 * by their titles, and that one was carried on after Open Sourcebook restarted (it then started again before anything asked
 * later). Undefined when nothing else is being made: it is about to start.
 */
export function queuedStep(job: GenerationJob, running: GenerationJob[], waitsFor: (other: GenerationJob) => boolean = (other) => other.ownerId === job.ownerId && other.kind === job.kind): string | undefined {
  const ahead = running.filter((other) => other.id !== job.id && other.status === "running" && waitsFor(other));
  if (ahead.length === 0) return undefined;
  const named = ahead.map((other) => (typeof other.input.title === "string" && other.input.title.trim() ? `“${other.input.title.trim()}”` : undefined));
  const titles = named.filter((title): title is string => title !== undefined);
  const what =
    ahead.length === 1
      ? (titles[0] ?? "another item")
      : titles.length === ahead.length && ahead.length <= 3
        ? `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`
        : `${ahead.length} other items`;
  const carried = ahead.some((other) => other.attempt > 1) ? (ahead.length === 1 ? " Open Sourcebook carried it on after a restart." : " Open Sourcebook carried one on after a restart.") : "";
  return `Waiting to start: ${what} ${ahead.length === 1 ? "is" : "are"} being made first.${carried}`;
}

/** The maker's word on when a running job is done, said in this attempt: `doneBy`, or `leftUnknown` when it cannot know. */
export function doneByView(job: GenerationJob): { doneBy: string } | { leftUnknown: true } | Record<string, never> {
  const said = job.state[DONE_BY_KEY];
  if (!said || typeof said !== "object" || Array.isArray(said) || said.attempt !== job.attempt) return {};
  if (typeof said.at === "string" && Number.isFinite(Date.parse(said.at))) return { doneBy: said.at };
  return said.at === null ? { leftUnknown: true } : {};
}

/** What a failed item says when its job left no reason. */
const FAILED_ITEM = "This item could not be made.";

export async function progressView(deps: EngineDeps, plan: Plan): Promise<Record<string, unknown>> {
  const { repos } = deps;
  const [nodes, labels, dates, results] = await Promise.all([
    repos.plans.listNodes(plan.id),
    repos.plans.listStages(plan.id),
    repos.plans.listStageDates(plan.id),
    repos.results.listByPlan(plan.id),
  ]);
  const resultOf = new Map(results.map((result) => [result.nodeId, result]));
  const running = plan.status === "running";
  // What else is being made now, read once: a queued item says what it waits for.
  let busy: GenerationJob[] | undefined;
  // Only what is made in the same line holds it up (jobs/lanes.ts): a quick item never waits for a heavy one.
  const beingMade = async (job: GenerationJob) => (busy ??= (await deps.jobs.listByStatus?.(["running"], 20)) ?? []).filter((other) => sameLine(job, other, deps.registry, Boolean(deps.heavyQueue)));
  const items = [];
  for (const node of [...nodes].sort((a, b) => a.level - b.level || a.ord - b.ord)) {
    const recorded = resultOf.get(node.id);
    const outputId = recorded?.outputId ?? (await repos.outputs.latestForNode(node.id))?.id;
    const asking = running ? deps.plans?.askOf(node) : undefined;
    // The item's row moves only when its job settles; the job says what is happening now.
    const job = node.status === "pending" || node.status === "skipped" ? undefined : await deps.jobs.findByKey(plan.ownerId, jobKey(node));
    const status = job && (node.status === "queued" || node.status === "running") ? nodeStatusFor(job) : node.status;
    const thing = deps.registry.descriptor(node.type)?.singular ?? deps.registry.descriptor(node.type)?.label ?? "item";
    // A scene of what it made being made again (routes/remake.ts): the newest such job, until it is done or stopped.
    const remake = node.status === "done" ? ((await deps.jobs.listByNode?.(node.id, 10)) ?? []).find((other) => remakeOfJob(other)) : undefined;
    const remakeOf = remake && remake.status !== "done" && remake.status !== "cancelled" ? remakeOfJob(remake) : undefined;
    items.push({
      id: node.id,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      level: node.level,
      ord: node.ord,
      type: deps.registry.servedType(node.type),
      title: node.title,
      enabled: node.enabled,
      status,
      // A failed item says why on its own row, so a plan read needs nothing else.
      ...(status === "failed" ? { errorMessage: job ? failureWords(job, thing) : FAILED_ITEM } : {}),
      // `files`: the job works in a folder on this computer the person can open (routes/job-files.ts).
      ...(job ? { job: { ...jobView(job, thing, job.status === "queued" ? await beingMade(job) : []), ...(hasJobFiles(job, deps) ? { files: true } : {}) } } : {}),
      ...(outputId ? { outputId } : {}),
      done: recorded?.doneAt !== undefined,
      ...(recorded?.doneAt ? { doneAt: recorded.doneAt } : {}),
      ...(recorded?.result !== undefined ? { result: recorded.result } : {}),
      ...(recorded?.progress !== undefined ? { progress: recorded.progress } : {}),
      ...(asking ? { asking } : {}),
      ...(remake && remakeOf ? { remaking: { ...remakeOf, job: jobView(remake, thing, remake.status === "queued" ? await beingMade(remake) : []) } } : {}),
    });
  }
  const countable = items.filter((item) => item.enabled && item.status !== "skipped");
  return {
    plan: {
      id: plan.id,
      projectId: plan.projectId,
      ...(plan.title ? { title: plan.title } : {}),
      status: plan.status,
      ...(plan.kickedOffAt ? { kickedOffAt: plan.kickedOffAt } : {}),
    },
    stages: stageViews(labels, dates),
    items,
    counts: { total: countable.length, done: countable.filter((item) => item.done).length },
  };
}

/**
 * "Change for all" before Start, or "Change maker for what's left" on a
 * stopped plan (`POST /v1/plans/:id/maker`): the maker's agent and effort,
 * and the reviewer's where a format has one, of the items not made yet.
 * Nothing starts. Answers the plan with which items changed and which did
 * not, and why.
 */
export async function changePlanMaker(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  if (!deps.plans) return errorResponse("plans_unavailable", "Plans cannot change on this Worker", 503);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const change = readMakerChange(read.body);
  if (typeof change === "string") return errorResponse("invalid_request", change, 400);
  try {
    const result = await deps.plans.changeMaker(owned.plan.id, change);
    return json({ ...(await planView(deps, (await deps.repos.plans.get(owned.plan.id))!)), ...result });
  } catch (error) {
    if (!(error instanceof PlanMakerChangeError)) throw error;
    const status = error.code === "invalid_request" ? 400 : error.code === "invalid_settings" ? 422 : 409;
    return errorResponse(error.code, error.message, status);
  }
}

const PICK_TEXT = /^[^\s\u0000-\u001f]{1,160}$/;

function readMakerChange(body: Record<string, unknown>): PlanMakerChange | string {
  if (!("agent" in body)) return "Send agent: a pick id, or null for the defaults";
  const change: PlanMakerChange = { agent: null };
  for (const key of ["agent", "effort", "reviewer", "reviewEffort"] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value !== null && (typeof value !== "string" || !PICK_TEXT.test(value.trim()))) return `${key} must be an id or null`;
    change[key] = value === null ? null : (value as string).trim();
  }
  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 500 || !body.items.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) {
      return "items must be a list of item ids";
    }
    change.items = [...new Set(body.items as string[])];
  }
  return change;
}
