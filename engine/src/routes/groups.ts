/**
 * Folders on Home (#66): a person's own grouping of projects, kept in the engine so every browser and the phone see the
 * same ones. In code a group, never to be confused with the folder on disk a project may be linked to (folders.ts).
 * A project is moved into one with `PATCH /v1/projects/:id { groupId }` (`null` puts it back on Home).
 *
 *   GET    /v1/groups          → 200 { groups: [{ id, title, projects, createdAt, updatedAt }] }   by name
 *   POST   /v1/groups          { title } → 201 { group }
 *   PATCH  /v1/groups/:id      { title } → 200 { group }
 *   DELETE /v1/groups/:id      → 200 { groupId, moved }   its projects go back on Home; none is deleted
 *
 * Another owner's group is a 404, like one that does not exist.
 */
import { authenticate, errorResponse, json, notFound, readJsonObject } from "../http";
import type { ProjectGroup } from "../studio/repositories/groups";
import type { EngineDeps } from "../wiring";

const MAX_TITLE = 100;

export function groupView(group: ProjectGroup & { projects?: number }): Omit<ProjectGroup, "ownerId"> & { projects?: number } {
  const { ownerId: _owner, ...view } = group;
  return view;
}

/** The title a request sends, trimmed; undefined when it is missing, blank or too long. */
function titleOf(body: Record<string, unknown>): string | undefined {
  const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
  return title && title.length <= MAX_TITLE ? title : undefined;
}

export async function listGroups(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  return json({ groups: (await deps.repos.groups.listByOwner(auth.ownerId)).map(groupView) });
}

export async function createGroup(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const title = titleOf(read.body);
  if (!title) return errorResponse("invalid_request", `Send { title }: the folder's name, ${MAX_TITLE} characters at most.`, 400);
  const group = await deps.repos.groups.create({ ownerId: auth.ownerId, title });
  return json({ group: groupView({ ...group, projects: 0 }) }, 201);
}

/** The caller's group, or the response to send. */
export async function ownedGroup(request: Request, id: string, deps: EngineDeps): Promise<{ group: ProjectGroup; ownerId: string } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  const group = await deps.repos.groups.get(id);
  if (!group || group.ownerId !== auth.ownerId) return { response: notFound("Folder not found") };
  return { group, ownerId: auth.ownerId };
}

export async function renameGroup(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedGroup(request, id, deps);
  if ("response" in owned) return owned.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const title = titleOf(read.body);
  if (!title) return errorResponse("invalid_request", `Send { title }: the folder's name, ${MAX_TITLE} characters at most.`, 400);
  return json({ group: groupView((await deps.repos.groups.rename(id, title))!) });
}

export async function deleteGroup(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedGroup(request, id, deps);
  if ("response" in owned) return owned.response;
  const moved = await deps.repos.groups.delete(id);
  return json({ groupId: id, moved });
}
