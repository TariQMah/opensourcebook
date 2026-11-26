/**
 * EngineDeps over fakes: SQLite with the real migrations, an in-memory R2
 * bucket, a scripted extractor and a provider that logs one priced usage
 * event per call. Routes, the output runner and the plan runner are the
 * real ones.
 */
import { AssetStore } from "../../src/assets";
import type { AgentConfig } from "../../src/chat/agent/connector";
import { createDefaultTools } from "../../src/chat/agent/default-tools";
import { AgentChat } from "../../src/chat/agent/turn";
import { ChatService } from "../../src/chat/service";
import { SkillRegistry } from "../../src/chat/skills";
import { createDefaultConditions } from "../../src/studio/conditions";
import { handleJobBatch } from "../../src/jobs/consumer";
import { D1GenerationJobStore } from "../../src/jobs/d1-store";
import { SourceService, type Extractor } from "../../src/sources/service";
import { OutputJobRunner } from "../../src/studio/output-runner";
import { FormatRegistry } from "../../src/studio/registry";
import { createStudioRepositories } from "../../src/studio/repositories";
import type {
  FetchLike,
  ExtractionRequest,
  SourceEnvelope,
  StructuredGenerationRequest,
  StructuredProvider,
  UsageSink,
} from "../../src/types";
import { UploadStore } from "../../src/uploads";
import type { LocalFiles } from "../../src/local-files";
import { consumerOptions, type EngineDeps } from "../../src/wiring";
import { FakeR2Bucket } from "./fake-r2";
import { ManualClock } from "./job-harness";
import { createSqliteD1, type SqliteD1 } from "./sqlite-d1";

export const CLIENT_TOKEN = "test-client-token-0123456789";
export const PROVIDER_CALL_USD = 0.0025;

/** Answers every extraction from `byURL`, or with the request's own text. Counts calls. */
export class FakeExtractor implements Extractor {
  readonly calls: ExtractionRequest[] = [];
  hold?: Promise<void>;

  constructor(private readonly byURL: Record<string, Partial<SourceEnvelope>> = {}) {}

  async extract(request: ExtractionRequest): Promise<SourceEnvelope> {
    this.calls.push(request);
    if (this.hold) await this.hold;
    const fixed = request.sourceURL ? this.byURL[request.sourceURL] : undefined;
    const text = request.uploadBytes ? new TextDecoder().decode(request.uploadBytes.bytes) : `Text of ${request.sourceURL ?? "nothing"}`;
    return {
      originalText: request.sourceText,
      ...(request.sourceURL ? { originalURL: request.sourceURL } : {}),
      kind: request.sourceKind,
      title: request.sourceURL ? `Title of ${request.sourceURL}` : "Uploaded file",
      text,
      references: request.sourceURL ? [{ url: request.sourceURL, label: "source" }] : [],
      metadata: {},
      accessLevel: "full",
      depthCap: "medium",
      limitations: [],
      fetchedAt: "2026-11-10T09:00:00.000Z",
      ...fixed,
    };
  }
}

export type ProviderAnswer = (request: StructuredGenerationRequest) => unknown;

/** A provider factory whose providers report one priced event per call to the job's sink. */
export function recordingProvider(answer: ProviderAnswer = () => ({})) {
  const calls: StructuredGenerationRequest[] = [];
  const factory = (usage: UsageSink): StructuredProvider => ({
    name: "fake",
    async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
      calls.push(request);
      await usage.record({ provider: "fake", model: "fake-1", task: request.task, tokensIn: 100, tokensOut: 50, usd: PROVIDER_CALL_USD, latencyMs: 5, ok: true });
      return answer(request) as T;
    },
  });
  return { factory, calls };
}

export interface TestEngine {
  deps: EngineDeps;
  db: SqliteD1;
  clock: ManualClock;
  extractor: FakeExtractor;
  bucket: FakeR2Bucket;
  provider: ReturnType<typeof recordingProvider>;
  /** Background work scheduled by routes (inline job runs). */
  background: Promise<unknown>[];
  ctx: { waitUntil(promise: Promise<unknown>): void };
  /** Runs one queue delivery of `jobId` through the real consumer. */
  deliver(jobId: string): Promise<"ack" | "retry">;
  settle(): Promise<void>;
}

export interface TestEngineOptions {
  registry?: FormatRegistry;
  extractor?: FakeExtractor;
  answer?: ProviderAnswer;
  /** Use a queue (records sends) instead of running jobs inline. */
  queue?: boolean;
  /** The chat's skills; none when absent. */
  skills?: SkillRegistry;
  /** Turns go to the person's own agent through a connector reached with `fetch`. */
  agent?: { fetch: FetchLike; config?: Partial<AgentConfig> };
  /** This computer's files (the library and linked folders), as the launcher would give them. */
  localFiles?: LocalFiles;
}

export function createTestEngine(options: TestEngineOptions = {}): TestEngine & { sent: string[] } {
  const clock = new ManualClock();
  const db = createSqliteD1();
  const repos = createStudioRepositories(db, { now: clock.iso });
  const bucket = new FakeR2Bucket();
  const uploads = new UploadStore(bucket);
  const assets = new AssetStore(bucket);
  const extractor = options.extractor ?? new FakeExtractor();
  const provider = recordingProvider(options.answer);
  const registry = options.registry ?? new FormatRegistry();
  const sources = new SourceService({ repos, extractor, uploads, assets, now: clock.now, ...(options.localFiles ? { localFiles: options.localFiles } : {}) });
  const sent: string[] = [];
  const deps: EngineDeps = {
    clientToken: CLIENT_TOKEN,
    jobs: new D1GenerationJobStore(db, { now: clock.iso }),
    repos,
    sources,
    uploads,
    registry,
    bucket,
    provider: provider.factory,
    runners: {
      output: new OutputJobRunner({
        repos,
        registry,
        sources,
        provider: provider.factory,
        assets,
        fetch: async () => new Response(null, { status: 200 }),
        now: clock.iso,
      }),
    },
    ...(options.queue ? { queue: { send: async (body) => void sent.push(body.jobId) } } : {}),
    consumer: { now: clock.now, heartbeatMs: 0, log: () => undefined },
    ...(options.localFiles ? { localFiles: options.localFiles } : {}),
  };
  deps.chat = new ChatService({
    repos,
    registry,
    skills: options.skills ?? new SkillRegistry(),
    conditions: createDefaultConditions(),
    provider: provider.factory,
    now: clock.now,
    ...(options.agent
      ? {
          agent: new AgentChat(
            { url: "http://127.0.0.1:8650", token: "connector-token", agent: "claude", timeoutMs: 60_000, ...options.agent.config },
            createDefaultTools(),
            options.agent.fetch,
            clock.now,
          ),
        }
      : {}),
  });
  const background: Promise<unknown>[] = [];
  return {
    deps,
    db,
    clock,
    extractor,
    bucket,
    provider,
    background,
    sent,
    ctx: { waitUntil: (promise) => void background.push(promise) },
    async deliver(jobId) {
      let result: "ack" | "retry" = "ack";
      await handleJobBatch(
        { queue: "re-byte-jobs", messages: [{ body: { jobId }, attempts: 1, ack: () => undefined, retry: () => void (result = "retry") }] },
        consumerOptions(deps),
      );
      return result;
    },
    async settle() {
      while (background.length > 0) await Promise.all(background.splice(0));
    },
  };
}

export function authed(path: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-client-token", CLIENT_TOKEN);
  let body = init.body as BodyInit | undefined;
  if (init.body !== undefined && typeof init.body !== "string" && !(init.body instanceof ArrayBuffer) && !ArrayBuffer.isView(init.body)) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  return new Request(`https://engine.test${path}`, { ...init, headers, body });
}

/** A response's JSON body, untyped for assertions. */
export async function bodyOf(response: Response): Promise<any> {
  return response.json();
}
