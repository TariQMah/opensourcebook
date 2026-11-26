/**
 * Builds what the routes and the queue consumer use from the worker's env:
 * stores, repositories, the source service, the registry, the provider
 * factory and the job runners. Tests build the same `EngineDeps` from
 * fakes; nothing below the routes reads `env`.
 */
import puppeteer from "@cloudflare/puppeteer";
import { AssetStore } from "./assets";
import { createSourceExtractor } from "./extract";
import { defaultFetch } from "./extract/context";
import { handleJobBatch, type JobConsumerOptions, type JobRunner } from "./jobs/consumer";
import { sendToLane } from "./jobs/lanes";
import { keepJobsSoon, type AgentCheck, type VoiceCheck } from "./jobs/keeper";
import { D1GenerationJobStore } from "./jobs/d1-store";
import type { GenerationJobStore, JobQueueMessageBody } from "./jobs/types";
import { createDeepSeekProvider } from "./providers/deepseek";
import { createGeminiProvider } from "./providers/gemini";
import { createOpenAlexProvider } from "./providers/openalex";
import { createOpenRouterProvider } from "./providers/openrouter";
import { MODEL_PRICES } from "./providers/prices";
import { priceFor } from "./providers/usage";
import { createProviderRouter } from "./providers/router";
import { researchSource } from "./research";
import { SourceService } from "./sources/service";
import { DEFAULT_TURN_TIMEOUT_MS, isLoopback, type AgentConfig, type TurnPick } from "./chat/agent/connector";
import { picksByScope } from "./chat/planning/commit";
import { providerViews } from "./chat/providers";
import { settleWorkPick } from "./engines/agent-fields";
import { createDefaultTools } from "./chat/agent/default-tools";
import { AgentChat } from "./chat/agent/turn";
import { AgentWork, refreshAgentStatus } from "./chat/agent/work";
import { createAgentFlashcardsMaker } from "./engines/flashcards/agent-maker";
import { createAgentQuizMaker } from "./engines/quiz/agent-maker";
import { createAgentAudioMaker } from "./engines/audio/agent-maker";
import { AudioVoiceClient } from "./engines/audio/voice-client";
import { createAgentGuideMaker } from "./engines/guide/agent-maker";
import { createDefaultSkills } from "./chat/default-skills";
import { ChatService } from "./chat/service";
import { createDefaultRegistry } from "./studio/default-registry";
import { OutputJobRunner } from "./studio/output-runner";
import { PlanRunner } from "./studio/plan-runner";
import type { FormatRegistry } from "./studio/registry";
import { timeBucket } from "./studio/timing";
import type { FormatDescriptor } from "./studio/types";
import { createStudioRepositories, type StudioRepositories } from "./studio/repositories";
import { drawFasterFrom } from "./routes/drawing";
import type {
  BrowserBindingLike,
  BrowserRenderingBindingLike,
  FetchLike,
  ModelPrice,
  R2BucketLike,
  StructuredProvider,
  UsageSink,
  WorkerEnv,
  WorkerExecutionContext,
} from "./types";
import { UploadStore } from "./uploads";
import { localFilesFromEnv, type LocalFiles } from "./local-files";
import { VideoMakersEngine, type VideoMaker, type VideoMakerRegistry } from "./engines/video/makers";
import { refreshScenesStatus, ScenesClient } from "./engines/video/scenes/client";
import { createScenesMaker } from "./engines/video/scenes/maker";

export interface EngineDeps {
  clientToken?: string;
  jobs: GenerationJobStore;
  repos: StudioRepositories;
  sources: SourceService;
  uploads: UploadStore;
  registry: FormatRegistry;
  /** The video makers the video format picks from (`GET /v1/video-makers`); empty when video is not made here. */
  videoMakers?: VideoMakerRegistry;
  /** The R2 bucket behind /v1/assets and /v1/uploads; absent disables both. */
  bucket?: R2BucketLike;
  /** Builds a provider whose every call reports to `usage`; undefined when no key is set. */
  provider(usage: UsageSink): StructuredProvider | undefined;
  /** Job kind → runner. */
  runners: Record<string, JobRunner>;
  /** Without a queue, a job runs in the background of the request that scheduled it. */
  queue?: { send(body: JobQueueMessageBody): Promise<unknown> };
  /** The line heavy items are made in, one after another (`jobs/lanes.ts`); absent: they share `queue`. */
  heavyQueue?: { send(body: JobQueueMessageBody): Promise<unknown> };
  /** Walks started plans; it hears about finished jobs through `consumer.onFinished`. */
  plans?: PlanRunner;
  /** Writes chat replies; absent disables the chat routes that need it (503). */
  chat?: ChatService;
  /** Extra consumer settings (tests shorten delays; the plan runner listens for finished jobs). */
  consumer?: Partial<Omit<JobConsumerOptions, "store" | "runners">>;
  /** The cheapest honest check of the person's agent's plan, for jobs waiting on its limit (jobs/keeper.ts). */
  checkAgent?: () => Promise<AgentCheck>;
  /** Whether the voice can speak, checked for free, for jobs waiting on it (jobs/keeper.ts). */
  checkVoice?: () => Promise<VoiceCheck>;
  /** Whether a voice service is chosen, for first-time setup's voice step (`GET /v1/setup`); absent, none counts as chosen. */
  voiceChosen?: () => Promise<boolean>;
  /** The scenes service on this computer, where the voice is set up (`routes/voice.ts`); absent when it is not configured. */
  scenes?: ScenesClient;
  /** This computer's files, through the launcher (local-files.ts): the library and linked folders. Absent when deployed. */
  localFiles?: LocalFiles;
}

/** Undefined when the worker has no database bound: nothing durable can be done. */
export function depsForEnv(env: WorkerEnv): EngineDeps | undefined {
  if (!env.OPENSOURCEBOOK_JOB_DB) return undefined;
  const fetchImpl: FetchLike = (input, init) => fetch(input, init);
  const repos = createStudioRepositories(env.OPENSOURCEBOOK_JOB_DB);
  const assets = new AssetStore(env.OPENSOURCEBOOK_ASSETS);
  const uploads = new UploadStore(env.OPENSOURCEBOOK_ASSETS);
  const extractor = createSourceExtractor({
    ...(env.YTDLP_SIDECAR_URL ? { sidecarURL: env.YTDLP_SIDECAR_URL } : {}),
    ...(env.YTDLP_SIDECAR_TOKEN ? { sidecarToken: env.YTDLP_SIDECAR_TOKEN } : {}),
    ...(env.JINA_API_KEY ? { jinaApiKey: env.JINA_API_KEY } : {}),
    ...(env.BROWSER ? { browser: browserLauncherFor(env.BROWSER) } : {}),
  });
  const openAlex = () =>
    createOpenAlexProvider({
      fetchImpl,
      ...(env.OPENALEX_BASE_URL ? { baseURL: env.OPENALEX_BASE_URL } : {}),
      ...(env.OPENALEX_MAILTO ? { mailto: env.OPENALEX_MAILTO } : {}),
    });
  // Cost estimates are priced for the model that writes flashcards, quiz and video text.
  const price = writingModelPrice(env);
  // Video makers (DECISIONS #54, #69); each is set up only when its own config is. With none, video is not made here.
  const makers = videoMakersFromEnv(env, fetchImpl, madeInFrom(repos, "video", () => registry.descriptor("video")), drawFasterFrom(repos));
  // Flashcards and quizzes: the person's own agent when it is connected, and Open Sourcebook's own writer when a model key is set.
  const work = agentWorkFromEnv(env, fetchImpl);
  const api = createProvider(env, fetchImpl, { record: () => undefined }) !== undefined;
  // Audio: written by the person's agent, voiced by the scenes service on this computer (the same service as videos).
  const scenes = scenesClientFromEnv(env, fetchImpl);
  const voice = scenes ? new AudioVoiceClient(scenes.config, fetchImpl) : undefined;
  const itemMakers = { api, ...(env.ITEM_MAKER_DEFAULT?.trim() ? { defaultMaker: env.ITEM_MAKER_DEFAULT.trim() } : {}) };
  const registry = createDefaultRegistry({
    flashcards: {
      research: (source, services) => researchSource(source, services.provider, openAlex()),
      ...(price ? { price } : {}),
      ...itemMakers,
      ...(work ? { makers: [createAgentFlashcardsMaker({ work })] } : {}),
    },
    quiz: { ...(price ? { price } : {}), ...itemMakers, ...(work ? { makers: [createAgentQuizMaker({ work })] } : {}) },
    ...(makers.length > 0 ? { video: { makers, ...videoMakerDefault(env) } } : {}),
    audio: { ...(voice ? { voice } : {}), ...(work && voice ? { makers: [createAgentAudioMaker({ work, voice })] } : {}) },
    // A guide: written by the person's agent; nothing else to make, the page is drawn from it.
    guide: work ? { makers: [createAgentGuideMaker({ work })] } : {},
  });
  const localFiles = localFilesFromEnv(env, fetchImpl);
  const sources = new SourceService({ repos, extractor, uploads, assets, ...(localFiles ? { localFiles } : {}) });
  const provider = (usage: UsageSink) => createProvider(env, fetchImpl, usage);
  const jobs = new D1GenerationJobStore(env.OPENSOURCEBOOK_JOB_DB);
  const deps: EngineDeps = {
    clientToken: env.OPENSOURCEBOOK_CLIENT_TOKEN,
    jobs,
    repos,
    sources,
    uploads,
    registry,
    videoMakers: registeredVideoMakers(registry),
    ...(env.OPENSOURCEBOOK_ASSETS ? { bucket: env.OPENSOURCEBOOK_ASSETS } : {}),
    provider,
    runners: {
      output: new OutputJobRunner({
        repos,
        registry,
        sources,
        provider,
        assets,
        fetch: fetchImpl,
        sourceFetch: defaultFetch,
        ...(work ? { settlePick: workPickSettler(repos, work) } : {}),
        ...(localFiles ? { localFiles } : {}),
      }),
    },
    ...(env.OPENSOURCEBOOK_BYTE_QUEUE ? { queue: env.OPENSOURCEBOOK_BYTE_QUEUE } : {}),
    ...(env.OPENSOURCEBOOK_BYTE_QUEUE && env.OPENSOURCEBOOK_HEAVY_QUEUE ? { heavyQueue: env.OPENSOURCEBOOK_HEAVY_QUEUE } : {}),
  };
  // Branch conditions are the built-in kinds (conditions.ts); a branch waits
  // until the result it reads is recorded in item_results.
  const plans = new PlanRunner({
    repos,
    jobs,
    registry,
    ...(work ? { checkPick: pickChecker(repos, work) } : {}),
    schedule: async (jobId) => {
      if (deps.queue) {
        await sendJob(deps, jobId);
        return;
      }
      // Local dev without a queue: run after the current advance has
      // finished, so a nested advance never races the one that queued it.
      setTimeout(() => void runInline(deps, jobId).catch((error) => console.warn(`Job ${jobId}: ${String(error)}`)), 0);
    },
  });
  deps.plans = plans;
  deps.consumer = { onFinished: (job) => plans.onJobFinished(job), heartbeatMs: HEARTBEAT_MS };
  if (work) deps.checkAgent = () => work.check();
  if (scenes) deps.checkVoice = () => scenes.voice();
  if (scenes) deps.scenes = scenes;
  if (localFiles) deps.localFiles = localFiles;
  if (scenes) deps.voiceChosen = voiceChosenFrom(scenes);
  const agent = agentFromEnv(env, fetchImpl);
  deps.chat = new ChatService({
    repos,
    registry,
    skills: createDefaultSkills(),
    conditions: plans.conditions,
    plans,
    provider,
    ...(agent ? { agent } : {}),
    workDefault: async () => deps.videoMakers?.default()?.defaultAgent?.(),
  });
  return deps;
}

/**
 * Settles a maker's turn that names no agent, for one owner: the shape's
 * default from Settings, else the agent the person named for the engine or
 * the connector, else the only provider that can (`resolvePick`, which
 * throws `PickNeededError` with several). A connector that can't be reached
 * leaves the pick as it is: the turn then says the connector is not running.
 */
export function workPickSettler(repos: StudioRepositories, work: AgentWork): (ownerId: string, scope: string, pick: TurnPick) => Promise<TurnPick | undefined> {
  return async (ownerId, scope, pick) => {
    if (pick.agent) return pick;
    const status = await work.status();
    if (!status.reachable) return pick;
    const views = providerViews(status, await repos.providerSettings.list(ownerId));
    return settleWorkPick(scope, pick, await picksByScope(repos, ownerId), views, work.config.agent ?? status.agent?.id);
  };
}

/** Start's check of a scope whose items leave who makes them open: several could and none is picked asks the person. */
export function pickChecker(repos: StudioRepositories, work: AgentWork): (ownerId: string, scope: string) => Promise<void> {
  const settle = workPickSettler(repos, work);
  return async (ownerId, scope) => {
    await settle(ownerId, scope, {});
  };
}

/** The maker "auto" picks, when VIDEO_MAKER_DEFAULT names one (DECISIONS #54). */
function videoMakerDefault(env: WorkerEnv): { defaultMaker?: string } {
  const wanted = env.VIDEO_MAKER_DEFAULT?.trim();
  return wanted ? { defaultMaker: wanted } : {};
}

/** The maker registry inside the video format, when video is made here. */
function registeredVideoMakers(registry: FormatRegistry): VideoMakerRegistry | undefined {
  const engine = registry.get("video")?.engine;
  const makers = engine instanceof VideoMakersEngine ? engine.makers : undefined;
  if (makers?.defaultMissing && !makerDefaultAnnounced) {
    makerDefaultAnnounced = true;
    console.warn(`VIDEO_MAKER_DEFAULT=${makers.defaultMissing} is not a video maker set up here; "auto" picks ${makers.default()?.id ?? "none"}.`);
  }
  return makers;
}

let makerDefaultAnnounced = false;
let scenesAnnounced = false;

/**
 * Video makers set up from env. The scenes maker (the person's own agent
 * writing scenes, DECISIONS #54) needs
 * SCENES_SERVICE_URL and SCENES_SERVICE_TOKEN; local only, so a service that
 * is not on this machine is refused. Said once per isolate.
 */
export function videoMakersFromEnv(env: WorkerEnv, fetchImpl: FetchLike, madeIn?: MadeIn, drawFaster?: (ownerId?: string) => Promise<boolean>): VideoMaker[] {
  const client = scenesClientFromEnv(env, fetchImpl);
  return client ? [createScenesMaker({ client, ...(madeIn ? { madeIn } : {}), ...(drawFaster ? { drawFaster } : {}) })] : [];
}

/** Whether a voice service is chosen in the scenes service's voice setup (from the app or its environment). */
export function voiceChosenFrom(scenes: Pick<ScenesClient, "voiceSetup">): () => Promise<boolean> {
  return async () => Boolean((await scenes.voiceSetup()).service);
}

type MadeIn = NonNullable<Parameters<typeof createScenesMaker>[0]["madeIn"]>;

/**
 * How long this computer took to make a thing of `scope` on exactly this pick and length: the middle of the owner's
 * past runs under the very same agent, model, effort and length bucket (`make_times`), or undefined when there is no
 * such run. Never another pick's time, and never a guess.
 */
export function madeInFrom(repos: StudioRepositories, scope: string, descriptor: () => Pick<FormatDescriptor, "timing"> | undefined): MadeIn {
  return async (pick, settings, ownerId) => {
    const shape = descriptor();
    if (!ownerId || !shape) return undefined;
    const bucket = timeBucket(shape, settings);
    if (shape.timing && bucket === undefined) return undefined;
    const times = await repos.makeTimes.summary(ownerId, scope);
    const same = (a: string | undefined, b: string | undefined) => (a ?? "") === (b ?? "");
    return times.find((time) => time.agent === pick.agent && same(time.model, pick.model) && same(time.effort, pick.effort) && same(time.bucket, bucket))?.seconds;
  };
}

function scenesClientFromEnv(env: WorkerEnv, fetchImpl: FetchLike): ScenesClient | undefined {
  const url = env.SCENES_SERVICE_URL?.trim();
  const token = env.SCENES_SERVICE_TOKEN?.trim();
  if (!url) return undefined;
  const say = (line: string) => {
    if (scenesAnnounced) return;
    scenesAnnounced = true;
    console.warn(line);
  };
  if (!token) {
    say("SCENES_SERVICE_URL is ignored: SCENES_SERVICE_TOKEN is not set.");
    return undefined;
  }
  if (!isLoopback(url)) {
    say(`SCENES_SERVICE_URL is ignored: ${url} is not on this machine, and the scenes maker is local only for now.`);
    return undefined;
  }
  say(`SCENES_SERVICE_URL=${url}: videos can be made by your own agent through the scenes service on this computer. Local only.`);
  return new ScenesClient({ url, token }, fetchImpl);
}

/**
 * Reads, at most every few seconds, what the local services the makers use
 * say about themselves (the scenes service's styles and whether its agent
 * answers), so the descriptors and the checks before Start built for this
 * request have it. Nothing is called when no such service is configured.
 */
export function refreshMakerStatus(env: WorkerEnv): Promise<void> {
  // One look at a time: a page opening fires many requests at once, and each would otherwise ask again.
  refreshing ??= (async () => {
    const fetchImpl: FetchLike = (input, init) => fetch(input, init);
    const client = scenesClientFromEnv(env, fetchImpl);
    if (client) await refreshScenesStatus(client).catch(() => undefined);
    const work = agentWorkFromEnv(env, fetchImpl);
    if (work) await refreshAgentStatus(work).catch(() => undefined);
    heardOnce = true;
  })().finally(() => (refreshing = undefined));
  return refreshing;
}

let refreshing: Promise<void> | undefined;
let heardOnce = false;

/**
 * Before a request is answered: the makers' status is looked at again in the background once something was heard,
 * so no request waits on it (a scenes service busy drawing a video can take seconds to answer, and every screen
 * waited with it); only the first request after a start waits, so what it answers is not made up.
 */
export async function refreshMakerStatusSoon(env: WorkerEnv, ctx: WorkerExecutionContext): Promise<void> {
  const look = refreshMakerStatus(env);
  if (heardOnce) ctx.waitUntil(look);
  else await look;
}

let agentAnnounced = false;

/**
 * The person's own agent for the chat (DECISIONS #53), when CHAT_AGENT_URL
 * and CHAT_AGENT_TOKEN are both set. Local only: a connector that is not on
 * this machine is refused. Either way it is said once per isolate.
 */
export function agentFromEnv(env: WorkerEnv, fetchImpl: FetchLike): AgentChat | undefined {
  const url = env.CHAT_AGENT_URL?.trim();
  const token = env.CHAT_AGENT_TOKEN?.trim();
  if (!url) return undefined;
  const say = (line: string) => {
    if (agentAnnounced) return;
    agentAnnounced = true;
    console.warn(line);
  };
  if (!token) {
    say("CHAT_AGENT_URL is ignored: CHAT_AGENT_TOKEN is not set.");
    return undefined;
  }
  if (!isLoopback(url)) {
    say(`CHAT_AGENT_URL is ignored: ${url} is not on this machine, and the agent connector is local only for now.`);
    return undefined;
  }
  const timeout = Number(env.CHAT_AGENT_TIMEOUT_MS);
  const config: AgentConfig = {
    url,
    token,
    ...(env.CHAT_AGENT?.trim() ? { agent: env.CHAT_AGENT.trim() } : {}),
    ...(env.CHAT_AGENT_MODEL?.trim() ? { model: env.CHAT_AGENT_MODEL.trim() } : {}),
    ...(env.CHAT_AGENT_EFFORT?.trim() ? { effort: env.CHAT_AGENT_EFFORT.trim() } : {}),
    ...(env.CHAT_AGENT_CALLBACK_URL?.trim() ? { callbackUrl: env.CHAT_AGENT_CALLBACK_URL.trim() } : {}),
    timeoutMs: env.CHAT_AGENT_TIMEOUT_MS?.trim() && Number.isFinite(timeout) && timeout >= 10_000 ? Math.min(timeout, 1_800_000) : DEFAULT_TURN_TIMEOUT_MS,
  };
  say(`CHAT_AGENT_URL=${url}: chat turns go to your own agent${config.agent ? ` (${config.agent})` : ""} through the connector on this computer. Local only.`);
  return new AgentChat(config, createDefaultTools(), fetchImpl);
}

/**
 * The person's own agent for quick makers (flashcards, quizzes, audio, guides),
 * through the same connector as the chat's (CHAT_AGENT_URL and CHAT_AGENT_TOKEN;
 * local only). These stay on the fast chat default unless ITEM_AGENT_MODEL or
 * ITEM_AGENT_EFFORT overrides them, separate from long video turns.
 */
export function agentWorkFromEnv(env: WorkerEnv, fetchImpl: FetchLike): AgentWork | undefined {
  const chat = agentFromEnv(env, fetchImpl);
  if (!chat) return undefined;
  const config = chat.connector.config;
  const model = env.ITEM_AGENT_MODEL?.trim() || config.model;
  const effort = env.ITEM_AGENT_EFFORT?.trim() || config.effort;
  const { model: _model, effort: _effort, ...rest } = config;
  return new AgentWork({ ...rest, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, fetchImpl);
}

/**
 * Hands a job to the queue. Without one (local dev) it runs in the
 * background of the current request; a retryable failure then waits for a
 * manual retry, since nothing redelivers it.
 */
export function scheduleJob(deps: EngineDeps, jobId: string, ctx: WorkerExecutionContext): void {
  if (deps.queue) {
    ctx.waitUntil(sendJob(deps, jobId));
    return;
  }
  ctx.waitUntil(runInline(deps, jobId));
}

/** Puts a job on its line's queue (`jobs/lanes.ts`): heavy work in a line of its own, so nothing quick waits behind it. */
export function sendJob(deps: EngineDeps, jobId: string): Promise<void> {
  const shared = deps.queue;
  if (!shared) return Promise.resolve();
  return sendToLane(jobId, { shared, ...(deps.heavyQueue ? { heavy: deps.heavyQueue } : {}) }, (id) => deps.jobs.get(id), deps.registry);
}

/** One delivery of a job without a queue: nothing redelivers it. */
function runInline(deps: EngineDeps, jobId: string): Promise<void> {
  const message = { body: { jobId }, attempts: 1, ack: () => undefined, retry: () => undefined };
  return handleJobBatch({ queue: "inline", messages: [message] }, consumerOptions(deps));
}

/** How often a running job's row is touched while its maker works: well inside the keeper's QUIET_MS. */
const HEARTBEAT_MS = 15_000;

/**
 * Runs the keeper (jobs/keeper.ts) in the background of this request or
 * delivery, at most every few seconds: jobs a restart left running are
 * carried on, waits that are due are tried, waits that are too long end.
 */
export function keepJobsInBackground(deps: EngineDeps, ctx: WorkerExecutionContext): void {
  ctx.waitUntil(
    keepJobsSoon({
      store: deps.jobs,
      schedule: async (jobId) => {
        if (deps.queue) await sendJob(deps, jobId);
        else ctx.waitUntil(runInline(deps, jobId));
      },
      ...(deps.checkAgent ? { checkAgent: deps.checkAgent } : {}),
      ...(deps.checkVoice ? { checkVoice: deps.checkVoice } : {}),
      ...(deps.consumer?.onFinished ? { onFinished: deps.consumer.onFinished } : {}),
    }),
  );
}

export function consumerOptions(deps: EngineDeps): JobConsumerOptions {
  return { ...deps.consumer, store: deps.jobs, runners: deps.runners };
}

/** The August provider selection, with every adapter reporting to `usage`. */
function createProvider(env: WorkerEnv, fetchImpl: FetchLike, usageSink: UsageSink): StructuredProvider | undefined {
  const gemini = env.GEMINI_API_KEY
    ? createGeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, baseURL: env.GEMINI_BASE_URL, fetchImpl, usageSink, prices: MODEL_PRICES })
    : undefined;
  const deepseek = env.DEEPSEEK_API_KEY
    ? createDeepSeekProvider({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL, baseURL: env.DEEPSEEK_BASE_URL, fetchImpl, usageSink, prices: MODEL_PRICES })
    : undefined;
  const openrouter = env.OPENROUTER_API_KEY
    ? createOpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
        baseURL: env.OPENROUTER_BASE_URL,
        fetchImpl,
        usageSink,
        prices: MODEL_PRICES,
      })
    : undefined;
  if (!gemini && !deepseek && !openrouter) return undefined;
  if (env.GENERATION_PROVIDER === "gemini") return gemini ?? deepseek ?? openrouter;
  if (env.GENERATION_PROVIDER === "deepseek") return deepseek ?? gemini ?? openrouter;
  return createProviderRouter({ gemini, deepseek, openrouter });
}

/**
 * The model that writes flashcard and quiz text, as `createProvider` picks it:
 * the configured provider when GENERATION_PROVIDER names one, otherwise the
 * router's text order (DeepSeek, then OpenRouter, then Gemini). Undefined
 * when that provider has no key or no model set; an estimate is then flagged
 * unpriced.
 */
export function writingModel(env: WorkerEnv): string | undefined {
  const gemini = { key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL };
  const deepseek = { key: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL };
  const openrouter = { key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL };
  const order =
    env.GENERATION_PROVIDER === "gemini"
      ? [gemini, deepseek, openrouter]
      : env.GENERATION_PROVIDER === "deepseek"
        ? [deepseek, gemini, openrouter]
        : [deepseek, openrouter, gemini];
  return order.find((provider) => provider.key)?.model;
}

/** The price in force today for `writingModel`, from the price table. */
export function writingModelPrice(env: WorkerEnv, at: Date = new Date()): ModelPrice | undefined {
  const model = writingModel(env);
  return model ? priceFor(MODEL_PRICES, model, at) : undefined;
}

/** The raw Browser Rendering binding, adapted to the extractor's launcher. */
function browserLauncherFor(binding: BrowserRenderingBindingLike): BrowserBindingLike {
  return { launch: () => puppeteer.launch(binding) };
}
