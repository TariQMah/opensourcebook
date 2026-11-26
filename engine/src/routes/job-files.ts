/**
 * Opening the folder a job works in, on this computer (docs/JOB-FOLDER.md).
 *
 *   POST /v1/jobs/:id/files/show   → 200 { shown: true }, 409 { error: "no_files", message }
 *
 * Only a format that declares its jobs have such a folder (`FormatDefinition.jobFiles`; today video, when its maker
 * makes it on this computer) opens one. The web app offers it only to the browser on this computer, and its proxy
 * refuses a paired phone. Nothing here names a format.
 */
import { authenticate, errorResponse, json, notFound } from "../http";
import { isRecord } from "../net";
import { CHECKPOINTS_KEY, KEPT_KEY } from "../studio/output-runner";
import type { JsonValue } from "../studio/types";
import type { GenerationJob } from "../jobs/types";
import type { EngineDeps } from "../wiring";

export async function showJobFiles(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const job = await deps.jobs.get(id);
  if (!job || job.ownerId !== auth.ownerId) return notFound("Job not found");
  const files = job.type ? deps.registry.get(job.type)?.jobFiles : undefined;
  const settings = job.input.settings;
  if (!files || !files.can(settings)) return errorResponse("no_files", "This has no files on this computer to show.", 409);
  const refused = await files.show({ jobId: job.id, settings, kept: keptOf(job), signal: request.signal });
  if (refused) return errorResponse("no_files", refused, 409);
  return json({ shown: true });
}

/** Whether a job's format says it works in a folder on this computer that can be opened. */
export function hasJobFiles(job: GenerationJob, deps: Pick<EngineDeps, "registry">): boolean {
  return (job.type ? deps.registry.get(job.type)?.jobFiles?.can(job.input.settings) : undefined) ?? false;
}

/** What a job's maker kept to find its work again: what it kept once done, else its pieces saved so far. */
function keptOf(job: GenerationJob): Record<string, JsonValue> {
  const kept = job.state[KEPT_KEY] ?? job.state[CHECKPOINTS_KEY];
  return isRecord(kept) ? (kept as Record<string, JsonValue>) : {};
}
