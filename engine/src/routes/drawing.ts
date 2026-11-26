/**
 * How a video is drawn on this computer (docs/api.md, "Drawing a video"): gently by default, with about half the
 * computer at low priority so the person's own apps come first, or faster, with most of the computer at normal
 * priority, for a person who starts a video and walks away. Settings › Videos is its switch.
 *
 *   GET /v1/drawing   → 200 DrawingSettings
 *   PUT /v1/drawing   { faster: boolean } → 200 DrawingSettings
 *
 * Kept per owner (`owner_settings`, `video.draw-faster`); each video the scenes maker starts carries it.
 */
import { authenticate, errorResponse, json, readJsonObject } from "../http";
import type { StudioRepositories } from "../studio/repositories";
import type { EngineDeps } from "../wiring";

/** Where "Use more of my computer to make videos faster" is kept in `owner_settings`. */
export const DRAW_FASTER_KEY = "video.draw-faster";

export interface DrawingSettings {
  /** Most of the computer at normal priority; off (the default) draws with about half of it, at low priority. */
  faster: boolean;
}

/** Whether this owner asked for videos to be drawn faster; off when not said or not known. */
export function drawFasterFrom(repos: Pick<StudioRepositories, "ownerSettings">): (ownerId?: string) => Promise<boolean> {
  return async (ownerId) => (ownerId ? (await repos.ownerSettings.get(ownerId, DRAW_FASTER_KEY)) === true : false);
}

export async function getDrawing(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  return json({ faster: await drawFasterFrom(deps.repos)(auth.ownerId) } satisfies DrawingSettings);
}

export async function putDrawing(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { faster } = read.body;
  if (typeof faster !== "boolean") return errorResponse("invalid_request", "Send faster: true or false", 400);
  await deps.repos.ownerSettings.set(auth.ownerId, DRAW_FASTER_KEY, faster ? true : null);
  return json({ faster } satisfies DrawingSettings);
}
