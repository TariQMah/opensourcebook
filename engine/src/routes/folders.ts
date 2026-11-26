/**
 * A project linked to a folder on this computer (#71, sources/folder.ts), and the library finished videos are copied
 * into (docs/JOB-FOLDER.md, "The library"). Both need the engine to run on the person's own computer with the
 * launcher (`LOCAL_FILES_URL`); a deployed engine answers 501. The web app's proxy lets only the browser on this
 * computer link a folder or pick the library, never a paired phone.
 *
 *   PUT    /v1/projects/:id/folder         { path }  → 200 { project, check }   links it and looks at it at once
 *   DELETE /v1/projects/:id/folder                   → 200 { project }          unlinks it; its sources stay
 *   POST   /v1/projects/:id/folder/check             → 200 { project, check }   looks at the folder again
 *   GET    /v1/library                               → 200 { library: { folder, chosen } }
 *   PUT    /v1/library                    { folder: string | null } → 200 { library }
 */
import { errorResponse, json, readJsonObject, authenticate } from "../http";
import { LocalFilesError, type LocalFiles } from "../local-files";
import { checkFolder, type FolderCheck } from "../sources/folder";
import type { Project } from "../studio/repositories/projects";
import type { EngineDeps } from "../wiring";
import { ownedProject, projectView } from "./projects";

const MAX_PATH = 1024;

function noFiles(): Response {
  return errorResponse("this_computer_only", "A folder can be linked only when Open Sourcebook runs on your own computer.", 501);
}

function filesError(error: unknown): Response {
  if (error instanceof LocalFilesError) return errorResponse(error.code, error.message, error.status);
  throw error;
}

export async function linkFolder(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  if (!deps.localFiles) return noFiles();
  if (owned.project.archivedAt) return errorResponse("project_archived", "An archived project takes no new sources", 409);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const path = typeof read.body.path === "string" ? read.body.path.trim() : "";
  if (!path || path.length > MAX_PATH) return errorResponse("invalid_folder", "Send { path }: the folder's whole path on this computer.", 400);
  try {
    // Listed first, so only a folder that is there is linked, under the name the computer gives it.
    const listing = await deps.localFiles.list(path);
    const project = (await deps.repos.projects.linkFolder(id, listing.folder))!;
    const found = await check(deps, deps.localFiles, project, owned.ownerId);
    return json({ project: projectView((await deps.repos.projects.get(id))!), check: found });
  } catch (error) {
    return filesError(error);
  }
}

export async function unlinkFolder(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  const project = (await deps.repos.projects.linkFolder(id, null))!;
  return json({ project: projectView(project) });
}

export async function checkProjectFolder(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, id, deps);
  if ("response" in owned) return owned.response;
  if (!owned.project.folder) return errorResponse("no_folder", "This project is not linked to a folder.", 409);
  if (!deps.localFiles) return noFiles();
  try {
    const found = await check(deps, deps.localFiles, owned.project, owned.ownerId);
    return json({ project: projectView((await deps.repos.projects.get(id))!), check: found });
  } catch (error) {
    return filesError(error);
  }
}

function check(deps: EngineDeps, files: LocalFiles, project: Project, ownerId: string): Promise<FolderCheck> {
  const provider = deps.provider(deps.repos.usage.sink({ ownerId }));
  return checkFolder({ repos: deps.repos, sources: deps.sources, files, ...(provider ? { provider } : {}) }, { ...project, folder: project.folder! });
}

export async function getLibrary(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!deps.localFiles) return noFiles();
  try {
    return json({ library: await deps.localFiles.library() });
  } catch (error) {
    return filesError(error);
  }
}

export async function setLibrary(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  if (!deps.localFiles) return noFiles();
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const folder = read.body.folder;
  if (folder !== null && (typeof folder !== "string" || !folder.trim() || folder.length > MAX_PATH)) {
    return errorResponse("invalid_folder", "Send { folder }: the folder's whole path on this computer, or null for the usual one.", 400);
  }
  try {
    return json({ library: await deps.localFiles.setLibrary(folder === null ? null : folder.trim()) });
  } catch (error) {
    return filesError(error);
  }
}
