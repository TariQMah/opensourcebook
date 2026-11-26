/**
 * Starts the scenes service on this computer (README). Settings come from the environment, and from `.env` beside this
 * service when there is one (git-ignored; the shell's own settings win).
 */
import { KEEP, type Keep } from "./folder.ts";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AudioJobs } from "./audio.ts";
import { useChrome } from "./chrome.ts";
import { carryOldNames } from "./old-names.ts";
import { Connector } from "./connector.ts";
import { Jobs } from "./jobs.ts";
import { createScenesServer } from "./server.ts";
import { measureStyles, SpeedBook, useSpeedBook } from "./speed.ts";
import { framesAtOnce, thisMachine } from "../pipeline/lib/frames-at-once.ts";
import { allStyles, listStyles } from "./styles.ts";
import { voiceFilePath } from "./voice-file.ts";
import { VoiceSetup } from "./voice-setup.ts";
import { toolboxFromEnv } from "./toolbox/index.ts";
import { boxTools } from "./toolbox/tools.ts";
import { knowledgeFromEnv } from "./knowledge.ts";

const envFile = join(import.meta.dirname, "..", ".env");
if (existsSync(envFile)) {
  const shell = { ...process.env };
  process.loadEnvFile(envFile);
  Object.assign(process.env, shell);
}
carryOldNames();
const env = process.env;
const token = env.SCENES_TOKEN?.trim() ?? "";
if (token.length < 16) {
  console.error("Set SCENES_TOKEN to a random string of at least 16 characters (the engine's SCENES_SERVICE_TOKEN).");
  process.exit(1);
}
const connectorToken = env.SCENES_CONNECTOR_TOKEN?.trim() ?? "";
if (connectorToken.length < 16) {
  console.error("Set SCENES_CONNECTOR_TOKEN to the agent connector's token (its OPENSOURCEBOOK_CONNECTOR_TOKEN).");
  process.exit(1);
}
const port = Number(env.SCENES_PORT ?? 8670);
const dataDir = env.SCENES_DATA_DIR?.trim() || join(import.meta.dirname, "..", ".data");
// The job folders, one per video and nothing else (docs/JOB-FOLDER.md); in the data folder itself unless set apart.
const jobsDir = env.SCENES_JOBS_DIR?.trim() || dataDir;
// No clock by default: the agent works until it finishes or the person stops it. SCENES_TURN_MINUTES sets one.
const minutes = Number(env.SCENES_TURN_MINUTES ?? 0);
// A hung agent is told from a slow one by its calls: none to Open Sourcebook's tools for this long stops its turn, the work kept
// (src/jobs.ts, IDLE_MINUTES by default; 0 never stops it).
const idle = env.SCENES_IDLE_MINUTES?.trim() ? Number(env.SCENES_IDLE_MINUTES) : undefined;
const chrome = useChrome();
// The voice chosen in the app, and its key, are in a private file laid over the environment (src/voice-file.ts).
// It is set up in the app (src/voice-setup.ts) and built again after each change, so a new choice speaks the next video.
const setup = new VoiceSetup({ env, file: voiceFilePath(env, dataDir), cacheDir: join(dataDir, ".voice") });
const voice = () => setup.current();
const toolbox = toolboxFromEnv(env);
const connector = new Connector({
  url: env.SCENES_CONNECTOR_URL?.trim() || "http://127.0.0.1:8650",
  token: connectorToken,
  // None set: each agent runs on its own default for a piece of work (the connector's adapter decides), never a name
  // of another agent's.
  ...(env.SCENES_AGENT_MODEL?.trim() ? { model: env.SCENES_AGENT_MODEL.trim() } : {}),
  ...(env.SCENES_AGENT?.trim() ? { agent: env.SCENES_AGENT.trim() } : {}),
  ...(env.SCENES_AGENT_EFFORT?.trim() ? { effort: env.SCENES_AGENT_EFFORT.trim() } : {}),
});
allStyles();
let base = "";
// A fresh viewer watches each finished video once and its maker gets one round on the notes (src/review.ts); on by
// default, SCENES_REVIEW=off (or 0) turns it off, and a request's own `review` wins. Its model and effort are the video's
// unless SCENES_REVIEW_MODEL / SCENES_REVIEW_EFFORT name others.
const reviewRaw = env.SCENES_REVIEW?.trim();
const review = {
  on: !reviewRaw || !/^(off|0|false|no)$/i.test(reviewRaw),
  ...(env.SCENES_REVIEW_MODEL?.trim() ? { model: env.SCENES_REVIEW_MODEL.trim() } : {}),
  ...(env.SCENES_REVIEW_EFFORT?.trim() ? { effort: env.SCENES_REVIEW_EFFORT.trim() } : {}),
};
const keepRaw = env.SCENES_KEEP_AGENT_PROMPT?.trim();
const keepAgentPrompt = keepRaw ? (/^(1|true|yes)$/i.test(keepRaw) ? true : /^(0|false|no)$/i.test(keepRaw) ? false : undefined) : undefined;
const jobs = new Jobs({
  dataDir,
  jobsDir,
  connector,
  voice,
  styles: listStyles,
  callbackBase: () => base,
  ...(Number.isFinite(minutes) && minutes >= 2 ? { turnMinutes: minutes } : {}),
  ...(idle !== undefined && Number.isFinite(idle) && (idle === 0 || idle >= 5) ? { idleMinutes: idle } : {}),
  toolbox,
  // The agent's own tools in a boxed folder of each video, where the connector has the box; off with SCENES_AGENT_WORKSPACE=off.
  workspace: env.SCENES_AGENT_WORKSPACE?.trim() !== "off",
  // The skills' pages that bear on every video, given whole at the start; SCENES_AGENT_KNOWLEDGE=index gives the index alone.
  knowledge: knowledgeFromEnv(env),
  ...(keepAgentPrompt !== undefined ? { keepAgentPrompt } : {}),
  review,
  // A job folder's pictures come from the engine (docs/JOB-FOLDER.md); a finished video is copied to the library when one is set.
  ...(env.SCENES_ENGINE_URL?.trim() ? { engineUrl: env.SCENES_ENGINE_URL.trim() } : {}),
  ...(env.SCENES_LIBRARY_DIR?.trim() ? { libraryDir: env.SCENES_LIBRARY_DIR.trim() } : {}),
  keep: keepFromEnv(env),
});
// Audio: spoken walk-throughs in the same voice, kept under the data folder's audio/.
const audio = new AudioJobs({ dataDir, voice, log: (line) => console.log(line) });
// How fast this computer draws each style: kept in the data folder, added to by every render, and measured once for
// the styles with no speed yet, in the background (src/speed.ts).
const speed = new SpeedBook(join(dataDir, "speed.json"));
useSpeedBook(speed);
const server = createScenesServer({ token, jobs, audio, connector, voice, setup, styles: allStyles, dataDir, speed, log: (line) => console.log(line) });
server.listen(port, "127.0.0.1", () => {
  base = `http://127.0.0.1:${port}`;
  void measureStyles(speed, listStyles().map((s) => s.id), { folder: join(dataDir, ".speed"), concurrency: framesAtOnce(thisMachine()).frames, log: (line) => console.log(line) }).then(() => rmSync(join(dataDir, ".speed"), { recursive: true, force: true }));
  console.log(`Open Sourcebook scenes service on ${base}: agent through ${connector.config.url} (${connector.config.model ?? "its own default model for a video"}), voice ${setup.current().id}, ${listStyles().length} styles offered of ${allStyles().length}, data in ${dataDir}${jobsDir !== dataDir ? `, jobs in ${jobsDir}` : ""}${chrome ? `, Chrome ${chrome}` : ""}, toolbox: ${boxTools(toolbox).map((t) => t.name).join(", ")}, fresh viewer ${review.on ? `on${review.model || review.effort ? ` (${[review.model, review.effort].filter(Boolean).join(", ")})` : ""}` : "off"}. This computer only.`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));

/** How many jobs, and how many days of them, are kept after they end: SCENES_KEEP_JOBS and SCENES_KEEP_DAYS, else `KEEP`. */
function keepFromEnv(e: Record<string, string | undefined>): Keep {
  const n = (raw: string | undefined, fallback: number) => (raw?.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : fallback);
  return { jobs: n(e.SCENES_KEEP_JOBS, KEEP.jobs), days: n(e.SCENES_KEEP_DAYS, KEEP.days) };
}
