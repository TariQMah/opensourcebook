/**
 * Projects, their sources and the Inbox (docs/api.md, "Projects" and
 * "Sources in a project and the Inbox").
 *
 *   POST  /v1/projects                  → 201 { project }
 *   GET   /v1/projects                  → 200 { projects, nextCursor? }   ?archived=include|only, paged
 *   GET   /v1/projects/:id              → 200 { project, counts? }        ?counts=1 adds { chats, plans, outputs, sources }
 *   PATCH /v1/projects/:id              → 200 { project }                 { groupId } moves it into a folder on Home (routes/groups.ts)
 *   POST  /v1/projects/:id/archive      → 200 { project }
 *   POST  /v1/projects/:id/unarchive    → 200 { project }
 *   DELETE /v1/projects/:id             → 200 { projectId, deleted: { chats, plans, outputs, sources } }
 *   GET   /v1/projects/:id/sources      → 200 { sources, nextCursor? }    paged, oldest first
 *   GET   /v1/inbox                     → 200 { sources, nextCursor? }    paged, newest first
 *   POST  /v1/sources/:id/file          → 200 { source }                   { projectId: string | null }
 *   GET   /v1/projects/:id/export       → 200 { bundle }                   the project as one file (studio/bundle.ts)
 *   POST  /v1/projects/import           → 201 { project, droppedCites, droppedOutputs }   { bundle, example? }
 *
 * Another owner's project or source is a 404, like one that does not exist.
 */
import { authenticate, errorResponse, json, notFound, pageBody, pageParams, readJsonObject } from "../http";
import type { ArchivedFilter, ListedSource, Project, ProjectPatch } from "../studio/repositories";
import { STALE_TURN_MS } from "../chat/service";
import { deleteProject as deleteProjectAndContents, projectContents } from "../studio/removal";
import { BundleError, exportProject, importProject } from "../studio/bundle";
import type { EngineDeps } from "../wiring";
import { listedSourceView } from "./sources";
import { FieldError, clearableId, clearableInteger, clearableText, object, readFields, required, text } from "./fields";

const MAX_TITLE = 200;
const MAX_LABEL = 100;
const MAX_SETTINGS_CHARS = 16_000;
const MAX_COLOR = 0xffffff;

export async function createProject(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => {
    const patch = projectFields(read.body);
    return { ...patch, title: required(patch.title, "title") };
  });
  if ("response" in fields) return fields.response;
  const { title, icon, colorHex, category, settings } = fields.value;
  const project = await deps.repos.projects.create({
    ownerId: auth.ownerId,
    title,
    ...(icon ? { icon } : {}),
    ...(typeof colorHex === "number" ? { colorHex } : {}),
    ...(category ? { category } : {}),
    ...(settings ? { settings } : {}),
  });
  return json({ project: projectView(project) }, 201);
}

export async function listProjects(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const paging = pageParams(url);
  if ("response" in paging) return paging.response;
  const archived = url.searchParams.get("archived");
  if (archived !== null && archived !== "include" && archived !== "only") {
    return errorResponse("invalid_request", "archived must be include or only", 400);
  }
  const page = await deps.repos.projects.page(auth.ownerId, paging, (archived ?? "exclude") as ArchivedFilter);
  return json(pageBody("projects", page, projectView));
}

export async function getProject(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  // What deleting it would take, counted the way DELETE reports it.
  const counts = new URL(request.url).searchParams.get("counts") === "1" ? await projectContents(deps.repos, id) : undefined;
  return json({ project: projectView(owned.project), ...(counts ? { counts } : {}) });
}

export async function updateProject(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => ({ patch: projectFields(read.body), groupId: clearableId(read.body, "groupId") }));
  if ("response" in fields) return fields.response;
  const { patch, groupId } = fields.value;
  if (groupId) {
    const group = await deps.repos.groups.get(groupId);
    if (!group || group.ownerId !== owned.ownerId) return notFound("Folder not found");
  }
  // Moving it between folders is not a change to the project, so its place in lists stays.
  if (groupId !== undefined) await deps.repos.groups.place(id, groupId);
  const project = Object.keys(patch).length ? await deps.repos.projects.update(id, patch) : await deps.repos.projects.get(id);
  return json({ project: projectView(project!) });
}

export async function archiveProject(request: Request, id: string, archive: boolean, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  const project = archive ? await deps.repos.projects.archive(id) : await deps.repos.projects.unarchive(id);
  return json({ project: projectView(project!) });
}

/**
 * Deletes a project for good with everything in it (`DELETE /v1/projects/:id`;
 * studio/removal.ts). Refused while one of its plans is running or a reply
 * is being written in one of its chats.
 */
export async function deleteProject(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  const plans = await deps.repos.plans.listByProject(id);
  if (plans.some((plan) => plan.status === "running")) {
    return errorResponse("project_busy", "A plan in this project is running; stop it first", 409);
  }
  const chats = await deps.repos.sessions.listByProject(id);
  if (chats.some((chat) => chat.busySince && Date.now() - Date.parse(chat.busySince) < STALE_TURN_MS)) {
    return errorResponse("project_busy", "A reply is being written in this project; wait for it", 409);
  }
  const deleted = await deleteProjectAndContents(deps, owned.project);
  return json({ projectId: id, deleted });
}

export async function listProjectSources(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  const paging = pageParams(new URL(request.url));
  if ("response" in paging) return paging.response;
  return json(pageBody("sources", await deps.repos.sources.pageByProject(id, paging), sourceView));
}

export async function listInbox(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const paging = pageParams(new URL(request.url));
  if ("response" in paging) return paging.response;
  return json(pageBody("sources", await deps.repos.sources.pageInbox(auth.ownerId, paging), sourceView));
}

export async function fileSource(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const source = await deps.repos.sources.get(id);
  if (!source || source.ownerId !== auth.ownerId || source.removedAt) return notFound("Source not found");
  const fields = readFields(() => {
    if (!("projectId" in read.body)) throw new FieldError("projectId is required; null files it back to the Inbox");
    return clearableId(read.body, "projectId")!;
  });
  if ("response" in fields) return fields.response;
  const projectId = fields.value;
  if (projectId !== null) {
    const project = await deps.repos.projects.get(projectId);
    if (!project || project.ownerId !== auth.ownerId) return errorResponse("project_not_found", "Project not found", 404);
    if (project.archivedAt) return errorResponse("project_archived", "An archived project takes no new sources", 409);
  }
  const moved = source.projectId === (projectId ?? undefined) ? source : (await deps.repos.sources.moveToProject(id, projectId))!;
  return json({ source: await listedSourceView(deps, moved) });
}

/** The caller's project, or the response to send. */
export async function ownedProject(request: Request, id: string, deps: EngineDeps): Promise<{ project: Project; ownerId: string } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  const project = await deps.repos.projects.get(id);
  if (!project || project.ownerId !== auth.ownerId) return { response: notFound("Project not found") };
  return { project, ownerId: auth.ownerId };
}

function projectFields(body: Record<string, unknown>): ProjectPatch {
  const patch: ProjectPatch = {};
  const title = text(body, "title", MAX_TITLE);
  if (title !== undefined) patch.title = title;
  const icon = clearableText(body, "icon", MAX_LABEL);
  if (icon !== undefined) patch.icon = icon;
  const colorHex = clearableInteger(body, "colorHex", 0, MAX_COLOR);
  if (colorHex !== undefined) patch.colorHex = colorHex;
  const category = clearableText(body, "category", MAX_LABEL);
  if (category !== undefined) patch.category = category;
  const settings = object(body, "settings", MAX_SETTINGS_CHARS);
  if (settings !== undefined) patch.settings = settings;
  return patch;
}

/** A project as clients see it: no owner hash. */
export function projectView(project: Project): Omit<Project, "ownerId"> {
  const { ownerId: _owner, ...view } = project;
  return view;
}

function sourceView(source: ListedSource): Omit<ListedSource, "ownerId" | "contentHash"> {
  const { ownerId: _owner, contentHash: _hash, ...view } = source;
  return view;
}

/**
 * `GET /v1/projects/:id/export` → 200 { bundle }: the project as one file
 * (studio/bundle.ts): its sources' text, its chats and its plans with what
 * they made.
 */
export async function exportProjectBundle(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  return json({ bundle: await exportProject(deps.repos, id) });
}

/**
 * `POST /v1/projects/import` { bundle, example? } → 201 { project, droppedCites, droppedOutputs }:
 * a new project from a bundle, every cite checked again against the text
 * it brings. `example` names the example folder it came from, kept in the
 * project's settings so a client can find the copy it already opened.
 */
export async function importProjectBundle(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const example = read.body.example;
  if (example !== undefined && (typeof example !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(example))) {
    return errorResponse("invalid_request", "example must be a folder name: lower-case letters, digits and dashes", 400);
  }
  try {
    const imported = await importProject(deps.repos, {
      ownerId: auth.ownerId,
      bundle: read.body.bundle,
      ...(example ? { settings: { example } } : {}),
      addText: async ({ projectId, text, title }) => {
        const added = await deps.sources.add({ ownerId: auth.ownerId, projectId, text, ...(title ? { title } : {}) });
        return { id: added.source.id, contentHash: added.source.contentHash };
      },
    });
    const project = (await deps.repos.projects.get(imported.projectId))!;
    return json({ project: projectView(project), droppedCites: imported.droppedCites, droppedOutputs: imported.droppedOutputs }, 201);
  } catch (error) {
    if (error instanceof BundleError) return errorResponse("invalid_bundle", error.message, 400);
    throw error;
  }
}
