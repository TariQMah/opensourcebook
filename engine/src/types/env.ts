/**
 * Worker environment: vars from wrangler.toml plus secrets and bindings, under their names now. The worker's
 * handlers read old names (`RE_X`) into these first (`old-names.ts`); `wrangler.toml` still binds the database, the
 * bucket and the queues as `RE_JOB_DB`, `RE_ASSETS`, `RE_BYTE_QUEUE` and `RE_HEAVY_QUEUE`.
 */
import type { BrowserRenderingBindingLike, D1DatabaseLike, R2BucketLike } from "./bindings";

/** What the runtime hands the worker: the settings under their names now, or under the ones from before the rename. */
export type WorkerBindings = WorkerEnv & { [oldName: `RE_${string}`]: unknown };

export interface WorkerEnv {
  OPENSOURCEBOOK_CLIENT_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_BASE_URL?: string;
  GENERATION_PROVIDER?: "gemini" | "deepseek" | "router";
  OPENSOURCEBOOK_BYTE_QUEUE?: Queue;
  /** The queue heavy items are made from, one after another (`jobs/lanes.ts`); unbound, they go on OPENSOURCEBOOK_BYTE_QUEUE. */
  OPENSOURCEBOOK_HEAVY_QUEUE?: Queue;
  /** D1 binding: generation jobs and the Studio tables. */
  OPENSOURCEBOOK_JOB_DB?: D1DatabaseLike;
  /** Name of the heavy items' queue (`jobs/lanes.ts`); a batch from it is made one job at a time. */
  OPENSOURCEBOOK_JOB_HEAVY_QUEUE?: string;
  /** Name of the dead-letter queue; batches from it end jobs as `dead`. */
  OPENSOURCEBOOK_JOB_DEAD_LETTER_QUEUE?: string;
  /** R2 binding for harvested source media; asset harvesting degrades gracefully when absent. */
  OPENSOURCEBOOK_ASSETS?: R2BucketLike;
  /** Public base URL used to resolve worker-relative /v1/assets/ paths for clients. */
  ASSET_PUBLIC_BASE_URL?: string;
  YTDLP_SIDECAR_URL?: string;
  YTDLP_SIDECAR_TOKEN?: string;
  /**
   * The video maker "auto" picks (engines/video/makers.ts; DECISIONS
   * #54), by id. Unset, or a maker not set up here: the first one registered.
   */
  VIDEO_MAKER_DEFAULT?: string;
  /**
   * The scenes service on this computer (services/scenes; DECISIONS #54):
   * set with its token, the person's own agent can make videos as drawn
   * scenes. Local `.dev.vars` only: a URL that is not this machine is refused.
   */
  SCENES_SERVICE_URL?: string;
  SCENES_SERVICE_TOKEN?: string;
  /**
   * The launcher on this computer, which answers for what the local runtime cannot read itself: the library folder
   * and the files of a folder a project is linked to (cli/local-files.ts). Set by the launcher with its token; a URL
   * that is not this machine is refused. Unset (a deployed engine), no project can be linked to a folder.
   */
  LOCAL_FILES_URL?: string;
  LOCAL_FILES_TOKEN?: string;
  /**
   * The connector on this computer that runs the person's own agent
   * (services/agent-connector; DECISIONS #53). Set, every chat turn goes to
   * that agent. Local `.dev.vars` only: a URL that is not this machine is refused.
   */
  CHAT_AGENT_URL?: string;
  CHAT_AGENT_TOKEN?: string;
  /** Which agent the connector runs (`claude`, `codex`); the connector's default when unset. */
  CHAT_AGENT?: string;
  CHAT_AGENT_MODEL?: string;
  CHAT_AGENT_EFFORT?: string;
  /** Where the connector calls the engine back; the request's origin when unset. */
  CHAT_AGENT_CALLBACK_URL?: string;
  /** Most milliseconds one turn may run. Default 180000. */
  CHAT_AGENT_TIMEOUT_MS?: string;
  /**
   * With the connector set, the person's agent also makes flashcards and quizzes
   * (DECISIONS #53, #64). These pick the model and effort it makes them with
   * (CHAT_AGENT_MODEL / _EFFORT, then the connector's, when unset).
   */
  ITEM_AGENT_MODEL?: string;
  ITEM_AGENT_EFFORT?: string;
  /**
   * The maker "auto" prefers for flashcards or a quiz: `agent` (the
   * person's own, the default when it is connected) or `api` (the model API
   * key). The other is used when the preferred one cannot make things now.
   */
  ITEM_MAKER_DEFAULT?: string;
  /** Jina Reader API key enabling the reader-service escalation tier for bot-walled pages. */
  JINA_API_KEY?: string;
  /**
   * Browser Rendering binding (wrangler [browser]); powers the headless render tier for bot-blocked/JS-heavy pages.
   * Only a deployed engine has it (a deployer's wrangler.local.toml); the launcher never gives it to an engine on a
   * person's computer, where the local runtime would download a whole Chrome to answer it.
   */
  BROWSER?: BrowserRenderingBindingLike;
  /** Optional OpenAlex API base URL override for tests or a controlled proxy. */
  OPENALEX_BASE_URL?: string;
  /** Contact email sent as OpenAlex's mailto param (polite pool, higher rate limits). */
  OPENALEX_MAILTO?: string;
}
