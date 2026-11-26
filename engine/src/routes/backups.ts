/**
 * Backing up every project to one file, and restoring from one (#66, backup/backup.ts). Only when the engine runs on
 * the person's own computer (`LOCAL_FILES_URL`); a deployed engine answers 501. The web app's proxy lets only the
 * browser on this computer reach these, never a paired phone.
 *
 *   GET    /v1/backup                    → 200 the zip, as `Open Sourcebook backup <day>.zip`
 *   POST   /v1/backup/restores           the zip as the body → 201 { restore: { id, madeAt, projects } }
 *   POST   /v1/backup/restores/:id       { choices: { <project id>: "keep-both" | "replace" | "skip" } } → 200 { restored, skipped }
 *   DELETE /v1/backup/restores/:id       → 200 { id, cancelled: true }
 *
 * A restore is two steps: the file is kept while the person looks at what is in it and chooses, for each project
 * that is here already, whether to keep both or put the backup's in its place. A project not here is added unless it
 * is skipped. Nothing is deleted but a project the person chose to replace.
 */
import { authenticate, errorResponse, json } from "../http";
import { BackupError, backupFileName, openBackup, restoreProject, restoreProjects, writeBackup, type RestoreChoice, type RestoredProject } from "../backup/backup";
import { STALE_TURN_MS } from "../chat/service";
import { deleteProject } from "../studio/removal";
import type { WorkerExecutionContext } from "../types";
import type { EngineDeps } from "../wiring";

/** Where a file being restored is kept meanwhile, in the engine's own bucket. */
const restoreKey = (id: string) => `restores/${id}.zip`;
/** The restores not finished, so one left behind is cleaned up a day later. */
const PENDING = "backup.restores";
const PENDING_MS = 24 * 60 * 60 * 1000;
const CHOICES = new Set<RestoreChoice>(["keep-both", "replace", "skip"]);

function thisComputerOnly(): Response {
  return errorResponse("this_computer_only", "Backing up and restoring are only for Open Sourcebook on your own computer.", 501);
}

function noBucket(): Response {
  return errorResponse("files_unavailable", "This engine has no store for files, so it cannot back up or restore.", 503);
}

function backupError(error: unknown): Response {
  if (error instanceof BackupError) return errorResponse(error.code, error.message, error.status);
  throw error;
}

export async function makeBackup(request: Request, deps: EngineDeps, ctx: WorkerExecutionContext): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!deps.localFiles) return thisComputerOnly();
  const now = new Date();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const writing = writeBackup({ repos: deps.repos, ...(deps.bucket ? { bucket: deps.bucket } : {}) }, auth.ownerId, writer, now).catch(async (error: unknown) => {
    console.error(`Backup: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    // The download ends broken rather than looking whole.
    await writer.abort(error).catch(() => undefined);
  });
  ctx.waitUntil(writing);
  return new Response(readable, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${backupFileName(now)}"`,
      "cache-control": "no-store",
    },
  });
}

async function pending(deps: EngineDeps, ownerId: string): Promise<Array<{ id: string; at: number }>> {
  const kept = await deps.repos.ownerSettings.get(ownerId, PENDING);
  return Array.isArray(kept) ? kept.flatMap((v) => (v && typeof v === "object" && !Array.isArray(v) && typeof v.id === "string" && typeof v.at === "number" ? [{ id: v.id, at: v.at }] : [])) : [];
}

async function forget(deps: EngineDeps, ownerId: string, id: string): Promise<void> {
  await deps.bucket?.delete?.(restoreKey(id));
  const left = (await pending(deps, ownerId)).filter((p) => p.id !== id);
  await deps.repos.ownerSettings.set(ownerId, PENDING, left.length ? left : null);
}

export async function startRestore(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!deps.localFiles) return thisComputerOnly();
  if (!deps.bucket) return noBucket();
  // A restore left half done more than a day ago goes, with its file.
  for (const old of (await pending(deps, auth.ownerId)).filter((p) => Date.now() - p.at > PENDING_MS)) await forget(deps, auth.ownerId, old.id);
  const id = crypto.randomUUID();
  const length = Number(request.headers.get("content-length"));
  const body = request.body && Number.isFinite(length) && length > 0 ? request.body : await request.arrayBuffer();
  if (!(body instanceof ReadableStream) && body.byteLength === 0) return errorResponse("invalid_backup", "Send the backup file as the request's body.", 400);
  await deps.bucket.put(restoreKey(id), body, { httpMetadata: { contentType: "application/zip" } });
  await deps.repos.ownerSettings.set(auth.ownerId, PENDING, [...(await pending(deps, auth.ownerId)), { id, at: Date.now() }]);
  try {
    const backup = await openBackup(deps.bucket, restoreKey(id));
    return json({ restore: { id, madeAt: backup.manifest.madeAt, projects: await restoreProjects(deps, auth.ownerId, backup.manifest) } }, 201);
  } catch (error) {
    await forget(deps, auth.ownerId, id);
    return backupError(error);
  }
}

export async function cancelRestore(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!deps.localFiles) return thisComputerOnly();
  if (!(await pending(deps, auth.ownerId)).some((p) => p.id === id)) return errorResponse("restore_not_found", "No such restore.", 404);
  await forget(deps, auth.ownerId, id);
  return json({ id, cancelled: true });
}

export async function finishRestore(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!deps.localFiles) return thisComputerOnly();
  if (!deps.bucket) return noBucket();
  if (!(await pending(deps, auth.ownerId)).some((p) => p.id === id)) return errorResponse("restore_not_found", "That backup is no longer here; choose the file again.", 404);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const sent = body && typeof body === "object" && !Array.isArray(body) ? (body as { choices?: unknown }).choices : undefined;
  const choices = sent && typeof sent === "object" && !Array.isArray(sent) ? (sent as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(choices)) {
    if (!CHOICES.has(value as RestoreChoice)) return errorResponse("invalid_request", `The choice for ${key} must be keep-both, replace or skip.`, 400);
  }
  try {
    const backup = await openBackup(deps.bucket, restoreKey(id));
    const projects = await restoreProjects(deps, auth.ownerId, backup.manifest);
    // Every project here already needs the person's choice, asked before anything is written.
    const unasked = projects.filter((p) => p.here && !choices[p.id]);
    if (unasked.length) {
      return json({ error: "choice_needed", message: "Choose, for each project you have already, whether to keep both or replace it.", projects: unasked.map((p) => ({ id: p.id, title: p.title })) }, 409);
    }
    for (const p of projects) {
      if (!p.here || choices[p.id] !== "replace") continue;
      const busy = await busyWith(deps, p.id);
      if (busy) return errorResponse("project_busy", `"${p.here.title}" ${busy}; it is not replaced while that goes on.`, 409);
    }
    const restored: RestoredProject[] = [];
    const skipped: Array<{ from: string; title: string }> = [];
    for (const p of projects) {
      const asked = choices[p.id] as RestoreChoice | undefined;
      if (asked === "skip") {
        skipped.push({ from: p.id, title: p.title });
        continue;
      }
      const choice = p.here ? (asked as "keep-both" | "replace") : "add";
      restored.push(
        await restoreProject(
          {
            repos: deps.repos,
            bucket: deps.bucket,
            replace: async (projectId) => {
              const project = await deps.repos.projects.get(projectId);
              if (project && project.ownerId === auth.ownerId) await deleteProject(deps, project);
            },
          },
          auth.ownerId,
          backup,
          p.id,
          choice,
        ),
      );
    }
    await forget(deps, auth.ownerId, id);
    return json({ restored, skipped });
  } catch (error) {
    return backupError(error);
  }
}

/** What keeps a project from being replaced now, in words, or undefined. */
async function busyWith(deps: EngineDeps, projectId: string): Promise<string | undefined> {
  if ((await deps.repos.plans.listByProject(projectId)).some((plan) => plan.status === "running")) return "has a plan being made";
  const chats = await deps.repos.sessions.listByProject(projectId);
  if (chats.some((chat) => chat.busySince && Date.now() - Date.parse(chat.busySince) < STALE_TURN_MS)) return "has a reply being written";
  return undefined;
}
