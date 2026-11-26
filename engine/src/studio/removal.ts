/**
 * Removing and deleting what a person owns: a source, a chat, a plan, a
 * project (engine/docs/api.md "Removing and deleting"; docs/DECISIONS.md #52).
 *
 * The rule is the same everywhere: nothing that was made, cited or started
 * breaks. A removed source that something still points at (an item of a
 * started plan, something made from it, a cite in a chat reply) stays as a
 * hidden row with its text, marked `removedAt`, so those keep working and
 * can say it was removed. Once nothing points at it any more, the row goes
 * for good, with its extraction and chunks when no other source has the
 * same content, and its uploaded file when nothing else was made from it.
 * Pictures kept while reading it are content-addressed and may be shared by
 * other sources and outputs, so they stay. Deleting a plan or a project
 * also deletes the files its made things kept (a video's, an audio's), each
 * once nothing left points at it.
 */
import { AssetStore } from "../assets";
import type { GenerationJobStore } from "../jobs/types";
import type { R2BucketLike } from "../types";
import type { UploadStore } from "../uploads";
import type { StudioRepositories } from "./repositories";
import type { Plan } from "./repositories/plans";
import type { Project } from "./repositories/projects";
import type { Session } from "./repositories/sessions";
import type { Source } from "./repositories/sources";

export interface RemovalDeps {
  repos: StudioRepositories;
  uploads: Pick<UploadStore, "deleteUpload">;
  /** Where made things' files are kept (/v1/assets); absent, they are left where they are. */
  bucket?: R2BucketLike;
  /** The jobs that make things; a plan's go with it when they can be listed and deleted. */
  jobs?: Pick<GenerationJobStore, "listByPlan" | "deleteByPlan">;
}

export interface SourceRemoval {
  /** True when the source is gone for good; false when it is kept, hidden, because something points at it. */
  deleted: boolean;
  /** Plans not started yet whose items no longer read it. */
  changedPlanIds: string[];
}

export interface ChatDeletion {
  /** Plans the chat made that were never started: deleted with it. */
  deletedPlanIds: string[];
  /** Plans the chat made that were started: kept, with no chat. */
  keptPlanIds: string[];
}

/** What a project holds, counted as deleting it counts what went. */
export interface ProjectDeletion {
  chats: number;
  plans: number;
  /** Everything made in it, archived too. */
  outputs: number;
  /** Its sources the person has not removed. */
  sources: number;
}

/** What deleting a plan took with it. */
export interface PlanDeletion {
  items: number;
  /** Everything its items made, archived too. */
  outputs: number;
  /** Its jobs, with the steps their makers saved. */
  jobs: number;
  /** Kept files (`/v1/assets/…`) nothing else pointed at any more. */
  files: number;
}

/**
 * What deleting the project would take with it, by the same definition
 * `deleteProject` reports, so the numbers a client shows before deleting
 * match its result.
 */
export async function projectContents(repos: StudioRepositories, projectId: string): Promise<ProjectDeletion> {
  const [plans, chats, sources, outputs] = await Promise.all([
    repos.plans.listByProject(projectId),
    repos.sessions.listByProject(projectId),
    repos.sources.listByProject(projectId),
    repos.outputs.countByProject(projectId),
  ]);
  return { chats: chats.length, plans: plans.length, outputs, sources: sources.length };
}

/**
 * Takes a source out of its project or the Inbox: unticked in every chat,
 * dropped from the items of plans not started yet, then deleted for good or
 * kept hidden. Removing a source that is already removed checks again
 * whether it can go for good.
 */
export async function removeSource(deps: RemovalDeps, source: Source): Promise<SourceRemoval> {
  const { repos } = deps;
  const changedPlanIds = await repos.plans.dropSourceFromUnstarted(source.id);
  if (source.projectId) await untick(repos, source.projectId, source.id);
  if (await purgeIfUnused(deps, source)) return { deleted: true, changedPlanIds };
  await repos.sources.markRemoved(source.id);
  return { deleted: false, changedPlanIds };
}

/**
 * Deletes a chat and its messages. Plans it made that never started go with
 * it (nothing was made from them); started plans stay, with no chat, and
 * keep everything they made. Removed sources only its replies cited go too.
 */
export async function deleteChat(deps: RemovalDeps, chat: Session): Promise<ChatDeletion> {
  const { repos } = deps;
  const plans = await repos.plans.listBySession(chat.id);
  const unstarted = plans.filter((plan) => !plan.kickedOffAt);
  for (const plan of unstarted) await repos.plans.delete(plan.id);
  await repos.sessions.delete(chat.id);
  await sweepRemovedSources(deps, chat.ownerId);
  return { deletedPlanIds: unstarted.map((plan) => plan.id), keptPlanIds: plans.filter((plan) => plan.kickedOffAt).map((plan) => plan.id) };
}

/**
 * Deletes a project for good with everything in it: its chats and their
 * messages, its plans with their items, results and done ticks, everything
 * made in it, and its sources. A source of the project that a plan or
 * output elsewhere still points at (it was used there before it was filed
 * here) is kept hidden instead. Usage rows and job rows stay as the record
 * of what was spent. The caller refuses a project with a running plan or a
 * reply being written.
 */
export async function deleteProject(deps: RemovalDeps, project: Project): Promise<ProjectDeletion> {
  const { repos } = deps;
  const counts = await projectContents(repos, project.id);
  const plans = await repos.plans.listByProject(project.id);
  const chats = await repos.sessions.listByProject(project.id);
  const sources = await repos.sources.listAllByProject(project.id);
  const files = await repos.outputs.filesByProject(project.id);
  await repos.outputs.deleteByProject(project.id);
  for (const plan of plans) await repos.plans.delete(plan.id);
  for (const chat of chats) await repos.sessions.delete(chat.id);
  for (const source of sources) {
    if (!(await purgeIfUnused(deps, source))) await repos.sources.markRemoved(source.id);
  }
  await repos.projects.delete(project.id);
  await sweepRemovedSources(deps, project.ownerId);
  // The files its made things kept (a video's, an audio's, their pictures) go once nothing else points at them.
  const store = new AssetStore(deps.bucket);
  for (const id of files) if (!(await repos.outputs.fileInUse(id))) await store.deleteAsset(id);
  return counts;
}

/**
 * Whether a plan is still being made: it is running, or a job of it (a
 * remake of one scene of a made video, say) is queued or running. Such a
 * plan is not deleted; it is stopped first.
 */
export async function planBusy(deps: RemovalDeps, plan: Plan): Promise<boolean> {
  if (plan.status === "running") return true;
  const jobs = (await deps.jobs?.listByPlan?.(plan.id)) ?? [];
  return jobs.some((job) => job.status === "queued" || job.status === "running");
}

/**
 * Deletes a plan for good with everything in it: its items with their
 * sources, edges, results, done ticks and kept progress, its stages and
 * days, everything its items made (they leave the Library), its jobs with
 * the steps their makers saved, and the files those made things kept, each
 * once nothing left points at it. A removed source only it pointed at goes
 * too. A plan made from it keeps going, with nothing it was made from.
 * Usage rows and making times stay as the record of spend. Chat messages
 * that showed it stay; they show nothing for it. The caller refuses a plan
 * that is still being made (`planBusy`).
 */
export async function deletePlan(deps: RemovalDeps, plan: Plan): Promise<PlanDeletion> {
  const { repos } = deps;
  const items = (await repos.plans.listNodes(plan.id)).length;
  const files = await repos.outputs.filesByPlan(plan.id);
  const outputs = await repos.outputs.deleteByPlan(plan.id);
  const jobs = (await deps.jobs?.deleteByPlan?.(plan.id)) ?? 0;
  await repos.plans.delete(plan.id);
  await sweepRemovedSources(deps, plan.ownerId);
  const store = new AssetStore(deps.bucket);
  let gone = 0;
  for (const id of files) {
    if (!(await repos.outputs.fileInUse(id)) && (await store.deleteAsset(id))) gone += 1;
  }
  return { items, outputs, jobs, files: gone };
}

/** Deletes for good every removed source of the owner that nothing points at any more. */
export async function sweepRemovedSources(deps: RemovalDeps, ownerId: string): Promise<number> {
  let deleted = 0;
  for (const source of await deps.repos.sources.listRemoved(ownerId)) {
    if (await purgeIfUnused(deps, source)) deleted += 1;
  }
  return deleted;
}

async function purgeIfUnused(deps: RemovalDeps, source: Source): Promise<boolean> {
  const { repos } = deps;
  if (await repos.sources.isReferenced(source)) return false;
  // A file of a linked folder the person removed stays as a hidden row, so checking the folder does not add it back.
  if (source.filePath && source.projectId && (await repos.projects.get(source.projectId))?.folder) return false;
  await repos.sources.purge(source);
  if (source.uploadId && !(await repos.sources.uploadInUse(source.uploadId))) await deps.uploads.deleteUpload(source.uploadId);
  return true;
}

/** Unticks a source in every chat of the project that had it ticked. */
async function untick(repos: StudioRepositories, projectId: string, sourceId: string): Promise<void> {
  for (const chat of await repos.sessions.listByProject(projectId)) {
    const ticked = chat.settings.sources;
    if (!Array.isArray(ticked) || !ticked.includes(sourceId)) continue;
    await repos.sessions.replaceSettingsQuietly(chat.id, { ...chat.settings, sources: ticked.filter((id) => id !== sourceId) });
  }
}
