import { ApiClient } from "../api/client";
import type { Activity, FormatDescriptor, Item, ItemJob, MakePiece, MakeTime, Output, OutputSummary, PlanView, Progress, Remaking, Source, Providers, SetupState, UploadType, VoiceOption, VoiceSetup } from "../api/types";

/** Rows shaped by engine/docs/api.md, for tests only. */
export interface FakeRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}
type Answer = unknown | [number, unknown];
export type Handler = Answer | ((req: FakeRequest) => Answer);

/**
 * A mocked fetch that answers like the engine behind the proxy. Routes are
 * "METHOD /v1/path/:param"; anything else is a 404 the way the engine says it.
 */
export function fakeEngine(routes: Record<string, Handler>) {
  const calls: FakeRequest[] = [];
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(" ") as [string, string];
    const names: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, n: string) => (names.push(n), "([^/]+)")) + "$");
    return { method, re, names, handler };
  });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://web.test");
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    for (const route of table) {
      const m = method === route.method ? route.re.exec(path) : null;
      if (!m) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")]));
      const req = { method, path, params, query: url.searchParams, body };
      calls.push(req);
      const answer = typeof route.handler === "function" ? (route.handler as (r: FakeRequest) => Answer)(req) : route.handler;
      const [status, payload] = Array.isArray(answer) && typeof answer[0] === "number" && answer.length === 2 ? (answer as [number, unknown]) : [200, answer];
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }
    calls.push({ method, path, params: {}, query: url.searchParams, body });
    return new Response(JSON.stringify({ error: "not_found", message: `No fake for ${method} ${path}` }), { status: 404 });
  };

  return { client: new ApiClient({ fetch: fetchImpl as typeof fetch }), calls, fetch: fetchImpl };
}

export const now = "2026-11-12T10:00:00.000Z";

export const formats = [
  { id: "video", label: "video", colorSlot: 1, icon: "play", blurb: "an explainer to watch", settings: [], defaults: {}, ready: false },
  { id: "flashcards", label: "flashcards", plural: "sets of flashcards", singular: "set of flashcards", colorSlot: 2, icon: "feed", aliases: ["byte", "bits", "read", "cards"], blurb: "cards to swipe and flip, brought back until they stick", settings: [{ key: "cards", label: "Cards", kind: "number", min: 0, max: 200, step: 1, specialValues: [{ value: 0, means: "auto", label: "Fit to the sources", description: "Counted when it is made." }] }, { key: "kinds", label: "Kinds of card", kind: "choices", options: [{ value: "recall", label: "Front and back", description: "A question on the front, the answer on the back." }, { value: "cloze", label: "Fill the gap", description: "A sentence with its key part hidden." }], minItems: 1, maxItems: 2 }], defaults: { cards: 0, kinds: ["recall", "cloze"] }, ready: true },
  { id: "quiz", label: "quiz", colorSlot: 3, icon: "check", aliases: ["check"], blurb: "questions that check you", settings: [], defaults: {}, ready: true },
];

export const edgeKinds = [
  { id: "assumes", label: "Builds on", about: "May rely on what the earlier item made, without going over it again." },
  { id: "fix_of", label: "Fixes", about: "Works on what was missed in the earlier item: reads what it made and the result recorded on it." },
];

/** The routes every screen's shell calls. */
export const baseRoutes: Record<string, Handler> = {
  "GET /v1/formats": { formats },
  "GET /v1/edge-kinds": { edgeKinds },
  "GET /v1/inbox": { sources: [] },
};

/*
 * Sample rows for the redesign's screens: makers, reviewers, times, voice,
 * setup and the files the engine reads. Test content only; spread
 * `redesignRoutes` into a fake engine to render against them.
 */

/** A shape with everything the make sheet reads: a style with pictures, a maker, a reviewer that can be off, length groups and a voice. */
export const sampleVideoFormat = {
  id: "video",
  label: "video",
  colorSlot: 1,
  icon: "play",
  blurb: "an explainer to watch",
  settings: [
    { key: "minutes", label: "Length", kind: "number", min: 0, max: 30, step: 1, unit: "min", specialValues: [{ value: 0, means: "auto", label: "Fit to the sources" }] },
    {
      key: "style",
      label: "Style",
      kind: "choice",
      options: [
        { value: "auto", label: "Maker's pick", description: "The maker picks the look that suits the brief and the sources when it makes it." },
        { value: "chalk", label: "Chalkboard", description: "White chalk on a dark green board.", preview: "/v1/video-makers/scenes/styles/chalk/preview" },
        { value: "ink", label: "Ink", description: "Fine pen lines on warm paper.", preview: "/v1/video-makers/scenes/styles/ink/preview" },
      ],
    },
    { key: "agent", label: "Agent & model", kind: "agent", effortKey: "effort", turnKind: "work", role: "make" },
    { key: "reviewer", label: "Reviewed by", kind: "agent", effortKey: "reviewEffort", turnKind: "work", role: "review", offValue: "off" },
  ],
  defaults: { minutes: 0, style: "auto" },
  ready: true,
  timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] },
  voiced: true,
} satisfies FormatDescriptor;

const mark = { path: "M2 2h20v20H2z" };

/** Two agents on this computer, named so the A to Z order differs from the order they are listed in. */
export const sampleProviders = {
  connector: { configured: true, reachable: true, checkedAt: now },
  providers: [
    {
      id: "zeta",
      label: "Zeta Agent",
      mark,
      added: true,
      enabled: true,
      state: "ready",
      headline: "Ready",
      signIn: "zeta login",
      install: { command: "npm i -g zeta", url: "https://zeta.example/install" },
      defaultModel: "z-mid",
      defaultEffort: "low",
      workDefaultModel: "z-mid",
      workDefaultEffort: "medium",
      pick: "agent:zeta",
      models: [
        { id: "z-small", pick: "agent:zeta:z-small", label: "Z Small", shown: true, favorite: false, tier: "fast" },
        { id: "z-mid", pick: "agent:zeta:z-mid", label: "Z Mid", shown: true, favorite: false, tier: "balanced" },
        { id: "z-big", pick: "agent:zeta:z-big", label: "Z Big", shown: true, favorite: false, tier: "strong" },
      ],
      efforts: [
        { id: "low", label: "Low", weight: "light" },
        { id: "medium", label: "Medium", weight: "medium" },
        { id: "high", label: "High", weight: "high" },
      ],
    },
    {
      id: "alpha",
      label: "Alpha Code",
      added: true,
      enabled: true,
      state: "ready",
      headline: "Ready",
      install: { url: "https://alpha.example/install" },
      defaultModel: "a-one",
      pick: "agent:alpha",
      models: [{ id: "a-one", pick: "agent:alpha:a-one", label: "A One", shown: true, favorite: false }],
      efforts: [],
    },
  ],
  picks: { video: { agent: "zeta", model: "z-mid", effort: "medium" }, "video.review": { off: true } },
} satisfies Providers;

/** Past runs: one exact key for a 3 minute video on Z Mid at medium effort, and a chat reply. */
export const sampleMakeTimes = [
  { scope: "video", agent: "zeta", model: "z-mid", effort: "medium", bucket: "le4", runs: 5, seconds: 252, lastAt: now },
  { scope: "video", agent: "zeta", model: "z-small", effort: "medium", bucket: "le4", runs: 1, seconds: 170, lastAt: now },
  { scope: "chat", agent: "zeta", model: "z-mid", effort: "low", runs: 12, seconds: 8, lastAt: now },
] satisfies MakeTime[];

export const sampleVoiceSetup = {
  service: "hosted-a",
  voice: { id: "v1", label: "Warm" },
  from: "app",
  services: [
    { id: "hosted-a", label: "Hosted A", where: "hosted", about: "A voice service with a key.", needsKey: true, keyLabel: "Your Hosted A API key", keyHelpUrl: "https://hosted-a.example/keys", keySet: true, keyHint: "a1b2", listsVoices: true, samples: true, health: { ok: true } },
    { id: "local-b", label: "On this computer", where: "local", about: "A voice that runs here.", needsKey: false, installed: false, install: { command: "npm run voice:local", folder: "services/scenes" }, listsVoices: true, samples: true },
  ],
} satisfies VoiceSetup;

export const sampleVoices = [
  { id: "v1", label: "Warm", description: "Calm and clear.", language: "en", sample: true },
  { id: "v2", label: "Bright", sample: false },
] satisfies VoiceOption[];

export const sampleSetup = { done: false, providers: { connected: 2, ready: 2 }, voice: { set: true, skipped: false } } satisfies SetupState;

export const sampleUploadTypes = {
  maxBytes: 25 * 1024 * 1024,
  types: [
    { contentType: "application/pdf", extensions: ["pdf"], group: "PDF" },
    { contentType: "image/*", extensions: ["png", "jpg"], group: "images" },
    { contentType: "audio/*", extensions: ["mp3"], group: "audio" },
  ] satisfies UploadType[],
};

/** Listed outputs as the engine sends them: a size in its own words, and a done tick where a plan item made it. */
export const sampleOutputs = [
  { id: "o1", type: "flashcards", title: "Limits, 12 cards", projectId: "p1", planId: "d1", itemId: "d1-i", size: { count: 12, unit: "cards" }, done: true, schemaVersion: 1, createdAt: now, updatedAt: now },
  { id: "o2", type: "guide", title: "One page to keep", projectId: "p1", size: { count: 0.5, unit: "page" }, schemaVersion: 1, createdAt: now, updatedAt: now },
  { id: "o3", type: "video", title: "Not rendered yet", schemaVersion: 1, createdAt: now, updatedAt: now },
] satisfies OutputSummary[];

/** Listed sources as the engine sends them: how long it is once read, nothing when reading counted nothing. */
export const sampleSources = [
  { id: "s1", projectId: "p1", kind: "pdf", title: "Week 3 notes", status: "ready", detail: { count: 24, unit: "pages" }, createdAt: now, updatedAt: now },
  { id: "s2", projectId: "p1", kind: "link", title: "example.com/notes", status: "ready", createdAt: now, updatedAt: now },
] satisfies Source[];

/** A `make` piece, as a chat reply carries one. */
export const sampleMakePiece = {
  kind: "make",
  format: "video",
  title: "The spindle checkpoint",
  about: "What it waits for, and what goes wrong when it fails.",
  sources: ["s1"],
  settings: { minutes: 3, style: "chalk" },
  plannedAs: "about 3 min",
  notices: [],
  issues: [],
  state: "open",
} satisfies MakePiece;

/** What the agents are doing, as GET /v1/activity answers it: one video being made, a chat reply, a quiz and a stopped video. */
export const sampleActivity = {
  connector: "ready",
  making: [
    {
      jobId: "j1",
      shape: "video",
      title: "The spindle checkpoint",
      project: { id: "p1", title: "Cell biology" },
      open: { projectId: "p1", planId: "d1" },
      status: "running",
      step: "Drawing scene 3 of 7",
      progress: 0.4,
      since: now,
      seconds: 250,
      maker: { agent: "zeta", model: "z-mid", effort: "medium" },
    },
  ],
  turns: [
    { turnId: "t3", at: now, shape: "chat", title: "Mitosis questions", project: { id: "p1", title: "Cell biology" }, open: { projectId: "p1", chatId: "c1" }, agent: "zeta", agentLabel: "Zeta Agent", model: "z-small", seconds: 8.2, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 24000, toolCalls: 3, outcome: "done" },
    { turnId: "t2", at: now, shape: "quiz", title: "Check the phases", project: { id: "p1", title: "Cell biology" }, open: { projectId: "p1", planId: "d1", outputId: "o9" }, agent: "zeta", agentLabel: "Zeta Agent", model: "z-mid", effort: "low", seconds: 95, inputTokens: 5000, outputTokens: 2100, toolCalls: 12, outcome: "done" },
    { turnId: "t1", at: "2026-11-11T09:00:00.000Z", shape: "video", review: true, agent: "alpha", seconds: 240, toolCalls: 1, outcome: "stopped" },
  ],
  totals: {
    today: { turns: 2, seconds: 103.2, inputTokens: 6200, outputTokens: 2440, cacheReadTokens: 24000, cacheWriteTokens: 0 },
    week: { turns: 3, seconds: 343.2, inputTokens: 6200, outputTokens: 2440, cacheReadTokens: 24000, cacheWriteTokens: 0 },
  },
  shapes: [{ id: "chat", label: "chat" }, { id: "quiz", label: "quiz" }, { id: "video", label: "video" }],
  projects: [{ id: "p1", title: "Cell biology" }],
} satisfies Activity;

/** The routes the redesign's screens call, answering with the samples above. Writes answer what was written. */
export const redesignRoutes: Record<string, Handler> = {
  "GET /v1/formats": { formats: [sampleVideoFormat, ...formats.filter((f) => f.id !== sampleVideoFormat.id)] },
  "GET /v1/providers": sampleProviders,
  "PUT /v1/providers/picks/:scope": (req: FakeRequest) => ({ ok: true, scope: req.params.scope, pick: req.body }),
  "PUT /v1/providers/picks": (req: FakeRequest) => ({ picks: { ...sampleProviders.picks, ...(req.body as { picks: object }).picks } }),
  "GET /v1/activity": sampleActivity,
  "GET /v1/make-times": (req: FakeRequest) => ({ times: sampleMakeTimes.filter((t) => !req.query.get("scope") || t.scope === req.query.get("scope")) }),
  "GET /v1/voice": sampleVoiceSetup,
  "PUT /v1/voice": (req: FakeRequest) => {
    // The engine answers the whole setup after the change: a chosen voice by its id and label, never the request echoed.
    const sent = req.body as { service: string | null; voice?: string | null };
    if (sent.service === null) return { from: "none", services: sampleVoiceSetup.services } satisfies VoiceSetup;
    const picked = sampleVoices.find((v) => v.id === sent.voice);
    const voice = sent.voice === undefined ? sampleVoiceSetup.voice : picked && { id: picked.id, label: picked.label };
    return { ...sampleVoiceSetup, service: sent.service, voice } satisfies VoiceSetup;
  },
  "PUT /v1/voice/services/:service/key": (req: FakeRequest) => ({ service: { ...sampleVoiceSetup.services.find((s) => s.id === req.params.service), keySet: true } }),
  "DELETE /v1/voice/services/:service/key": sampleVoiceSetup,
  "GET /v1/voice/services/:service/voices": { voices: sampleVoices },
  "GET /v1/setup": sampleSetup,
  "PUT /v1/setup": (req: FakeRequest) => {
    const sent = req.body as { done?: boolean; voice?: { skipped: boolean } };
    return { ...sampleSetup, ...(sent.done !== undefined ? { done: sent.done } : {}), ...(sent.voice ? { voice: { ...sampleSetup.voice, skipped: sent.voice.skipped } } : {}) };
  },
  "GET /v1/drawing": { faster: false },
  "PUT /v1/drawing": (req: FakeRequest) => ({ faster: (req.body as { faster: boolean }).faster }),
  "GET /v1/uploads/types": sampleUploadTypes,
  "POST /v1/chats/:id/messages/:messageId/pieces/:piece/close": (req: FakeRequest) => ({ message: { id: req.params.messageId, chatId: req.params.id, pieces: [{ ...sampleMakePiece, state: "closed" }] } }),
};

/** A made video one of whose scenes can be made again: three scenes, the third from 0:09 to the end. */
export const sampleSceneVideo = {
  id: "v1",
  type: "video",
  title: "Why a cell checks itself",
  projectId: "p1",
  planId: "d1",
  itemId: "d1-i",
  schemaVersion: 1,
  createdAt: now,
  updatedAt: now,
  citations: [],
  sources: [{ sourceId: "s1" }],
  remakesScene: true,
  payload: {
    idea: "A cell waits until every chromosome is held from both sides.",
    scenes: [
      { id: "s1", kind: "hook", durationMs: 4000, visual: { kind: "drawn", description: "A cell about to divide." }, narration: "Why does a cell wait?", onScreenText: [], cites: [] },
      { id: "s2", kind: "explain", durationMs: 5000, visual: { kind: "drawn", description: "Fibres reach for each chromosome." }, narration: "Fibres reach in from both poles.", onScreenText: [], cites: [] },
      { id: "s3", kind: "explain", durationMs: 6000, visual: { kind: "drawn", description: "The spindle pulls." }, narration: "The spindle pulls only when every chromosome is held from both sides.", onScreenText: ["Held from both sides"], cites: [] },
    ],
    render: { by: "scenes", storyboard: false, url: "/v1/assets/a1", width: 720, height: 1280, durationMs: 15000, scenes: [{ id: "s1", startMs: 0, endMs: 4000 }, { id: "s2", startMs: 4000, endMs: 9000 }, { id: "s3", startMs: 9000, endMs: 15000 }] },
  },
} satisfies Output;

/**
 * The engine's side of remaking one scene of `sampleSceneVideo`, made at
 * once in project p1 (plan d1, item d1-i): the remake and Stop write into
 * `state`, which the plan, its progress and the outputs read back. `run`,
 * `fail` and `finish` move the remake on as its job would; `refuse` answers
 * the next remake with an error instead.
 */
export function sampleRemakeEngine() {
  const state: { remaking?: Remaking; made: string; refuse?: [number, unknown] } = { made: sampleSceneVideo.id };
  const plan = { id: "d1", projectId: "p1", title: sampleSceneVideo.title, version: 1, status: "done", direct: true, createdAt: now, updatedAt: now, kickedOffAt: now } satisfies PlanView["plan"];
  const item = (): Item => ({ id: "d1-i", level: 0, ord: 0, type: "video", title: sampleSceneVideo.title, settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: state.made, ...(state.remaking ? { remaking: state.remaking } : {}) });
  const counts = { total: 1, done: 0 };
  const job = (more: Partial<ItemJob>): void => {
    if (state.remaking) state.remaking = { ...state.remaking, job: { ...state.remaking.job, ...more } };
  };
  const routes: Record<string, Handler> = {
    "GET /v1/projects/:id/plans": { plans: [{ ...plan, counts }] },
    "GET /v1/plans/:id": () => ({ plan, stages: [], items: [item()], edges: [], counts, estimateUsd: 0, issues: [] }) satisfies PlanView,
    "GET /v1/plans/:id/progress": () => ({ plan, stages: [], items: [item()], counts }) satisfies Progress,
    "GET /v1/plans/:id/outputs": () => ({ outputs: [{ ...sampleSceneVideo, id: state.made }] }),
    "GET /v1/projects/:id/outputs": () => ({ outputs: [{ ...sampleSceneVideo, id: state.made }] }),
    "GET /v1/outputs/:id": (req: FakeRequest) =>
      req.params.id === sampleSceneVideo.id ? { output: sampleSceneVideo } : { output: { ...sampleSceneVideo, id: req.params.id!, remakeOf: { outputId: sampleSceneVideo.id, scene: "s3" } } },
    "POST /v1/outputs/:id/scenes/:scene/remake": (req: FakeRequest) => {
      const refused = state.refuse;
      if (refused) return (state.refuse = undefined), refused;
      const note = (req.body as { note?: string } | undefined)?.note;
      state.remaking = { outputId: req.params.id!, scene: req.params.scene!, ...(note ? { note } : {}), job: { id: "rj1", status: "queued", stage: "queued", progress: 0, attempt: 1 } };
      return [202, { job: { id: "rj1", status: "queued", stage: "queued", progress: 0 }, remakeOf: { outputId: req.params.id, scene: req.params.scene } }];
    },
    "POST /v1/jobs/:id/cancel": (req: FakeRequest) => ((state.remaking = undefined), { job: { id: req.params.id, status: "cancelled" } }),
    "POST /v1/plans/:id/items/:itemId/progress": { item: { id: "d1-i" } },
  };
  return {
    state,
    routes,
    run: () => job({ status: "running", stage: "drawing", progress: 0.4, startedAt: now }),
    fail: (words: string) => job({ status: "failed", stage: "failed", errorMessage: words }),
    finish: (newId = "v2") => ((state.remaking = undefined), (state.made = newId)),
    refuse: (status: number, error: string, message: string) => (state.refuse = [status, { error, message }]),
  };
}

/**
 * `POST /v1/plans/:id/items/:itemId/stop` against a running plan's view, as
 * the engine answers it: only a `queued` or `running` item of a `running`
 * plan stops (else `409 item_not_running`); it is `cancelled`, its job gone,
 * and the plan stays `running` while anything else is left to make, else it
 * is `cancelled`. `POST .../retry` on a stopped item queues it again with
 * the plan `running`.
 */
export function itemStopRoutes(view: PlanView): Record<string, Handler> {
  const set = (id: string, change: (i: Item) => Item): PlanView => ({ ...view, items: view.items.map((i) => (i.id === id ? change(i) : i)) });
  return {
    "POST /v1/plans/:id/items/:itemId/stop": (req: FakeRequest) => {
      const item = view.items.find((i) => i.id === req.params.itemId);
      if (!item) return [404, { error: "not_found", message: "No such item in this plan." }];
      if (view.plan.status !== "running" || (item.status !== "running" && item.status !== "queued")) return [409, { error: "item_not_running", message: "This item is not being made." }];
      view = set(item.id, (i) => {
        const rest = { ...i, status: "cancelled" as const };
        delete rest.job;
        return rest;
      });
      const left = view.items.some((i) => i.enabled && (i.status === "pending" || i.status === "queued" || i.status === "running"));
      if (!left) view = { ...view, plan: { ...view.plan, status: "cancelled" } };
      return view;
    },
    "POST /v1/plans/:id/items/:itemId/retry": (req: FakeRequest) => {
      const item = view.items.find((i) => i.id === req.params.itemId);
      if (!item) return [404, { error: "not_found", message: "No such item in this plan." }];
      if (item.status !== "cancelled" && item.status !== "failed") return [409, { error: "item_not_failed", message: "Only a failed or stopped item can be made again." }];
      view = { ...set(item.id, (i) => ({ ...i, status: "queued" })), plan: { ...view.plan, status: "running" } };
      return view;
    },
  };
}
