import { ApiError } from "./errors";
import type {
  Activity,
  ActivityQuery,
  Json,
  PhoneStatus,
  VoiceInstallState,
  AgentPick,
  AgentPickPatch,
  AgentStatus,
  ProviderPatch,
  RemakeInput,
  RemakeStarted,
  Providers,
  VideoMaker,
  AddSourceInput,
  Chat,
  ChatDeleted,
  Message,
  MessageInput,
  DueStage,
  ThreadCount,
  ThreadView,
  Skill,
  ChatCommand,
  JsonObject,
  MakeInput,
  DoneInput,
  Edge,
  FormatDescriptor,
  Item,
  ItemInput,
  ItemPatch,
  Output,
  OutputSummary,
  Page,
  PageQuery,
  Plan,
  PlanInput,
  PlanUsage,
  PlanView,
  Counts,
  Progress,
  ProgressItem,
  Project,
  FolderCheck,
  Library,
  ProjectCounts,
  PlanDeleted,
  ProjectDeleted,
  EdgeKind,
  ProjectInput,
  Source,
  SourceDetail,
  SourceRemoved,
  Upload,
  UsageTotals,
  MakeTime,
  PlanMakerChange,
  PlanMakerResult,
  VoiceSetup,
  VoiceServiceView,
  VoiceOption,
  SetupState,
  UploadType,
} from "./types";

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  query?: Query;
  /** A JSON body. */
  json?: unknown;
  /** A raw body (uploads). */
  body?: BodyInit;
  headers?: Record<string, string>;
}

export interface ClientOptions {
  /** Where the same-origin proxy answers. The browser never calls the engine directly. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * A typed client for the Studio API (engine/docs/api.md). Every call goes to
 * the web app's own origin under /api; the proxy there adds the client token.
 * Errors come back as ApiError, paged lists as { rows, nextCursor }.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    // Bound so a test's mock and the browser's fetch are called the same way.
    const f = options.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => f(input, init);
  }

  // The one place a call is made, its errors read and its body parsed.
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    let body = options.body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, body });
    } catch (error) {
      throw new ApiError(0, "network", error instanceof Error ? error.message : "The request did not reach the server.");
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      const err = (parsed ?? {}) as { error?: unknown; message?: unknown; issues?: unknown };
      throw new ApiError(
        response.status,
        typeof err.error === "string" ? err.error : `http_${response.status}`,
        typeof err.message === "string" ? err.message : response.statusText || `Request failed (${response.status})`,
        Array.isArray(err.issues) ? err.issues : [],
      );
    }
    if (parsed === undefined && text) throw new ApiError(response.status, "invalid_response", "The server answered with something that is not JSON.");
    return parsed as T;
  }

  url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private async page<T>(path: string, key: string, query: Query = {}): Promise<Page<T>> {
    const body = await this.request<Record<string, unknown>>("GET", path, { query });
    const rows = (body[key] ?? []) as T[];
    return typeof body.nextCursor === "string" ? { rows, nextCursor: body.nextCursor } : { rows };
  }

  /** Follows `nextCursor` until the list ends (or `max` rows). */
  async all<T>(load: (q: PageQuery) => Promise<Page<T>>, max = 2000): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await load({ limit: 200, ...(cursor ? { cursor } : {}) });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor && rows.length < max);
    return rows;
  }

  // Formats
  async formats(): Promise<FormatDescriptor[]> {
    return (await this.request<{ formats: FormatDescriptor[] }>("GET", "/v1/formats")).formats;
  }
  /** The kinds of link between plan items the engine reads, with what each means. */
  async edgeKinds(): Promise<EdgeKind[]> {
    return (await this.request<{ edgeKinds: EdgeKind[] }>("GET", "/v1/edge-kinds")).edgeKinds;
  }

  // Projects
  listProjects(q: PageQuery & { archived?: "include" | "only" } = {}): Promise<Page<Project>> {
    return this.page("/v1/projects", "projects", { ...q });
  }
  async createProject(input: ProjectInput & { title: string }): Promise<Project> {
    return (await this.request<{ project: Project }>("POST", "/v1/projects", { json: input })).project;
  }
  async getProject(id: string): Promise<Project> {
    return (await this.request<{ project: Project }>("GET", `/v1/projects/${enc(id)}`)).project;
  }
  /** What a project holds, counted exactly as deleting it would count what went. */
  async projectCounts(id: string): Promise<ProjectCounts> {
    return (await this.request<{ counts: ProjectCounts }>("GET", `/v1/projects/${enc(id)}`, { query: { counts: 1 } })).counts;
  }
  async updateProject(id: string, patch: ProjectInput): Promise<Project> {
    return (await this.request<{ project: Project }>("PATCH", `/v1/projects/${enc(id)}`, { json: patch })).project;
  }
  async archiveProject(id: string): Promise<Project> {
    return (await this.request<{ project: Project }>("POST", `/v1/projects/${enc(id)}/archive`)).project;
  }
  async unarchiveProject(id: string): Promise<Project> {
    return (await this.request<{ project: Project }>("POST", `/v1/projects/${enc(id)}/unarchive`)).project;
  }
  /** A new project from a project bundle (engine/docs/api.md, "A project as one file"); `example` names the examples/ folder it came from. */
  async importProject(bundle: unknown, example?: string): Promise<Project> {
    return (await this.request<{ project: Project }>("POST", "/v1/projects/import", { json: { bundle, ...(example ? { example } : {}) } })).project;
  }
  /** Links a project to a folder on this computer and looks at it at once; only the browser on this computer may. */
  linkFolder(id: string, path: string): Promise<{ project: Project; check: FolderCheck }> {
    return this.request("PUT", `/v1/projects/${enc(id)}/folder`, { json: { path } });
  }
  /** Unlinks a project's folder; its sources stay. */
  async unlinkFolder(id: string): Promise<Project> {
    return (await this.request<{ project: Project }>("DELETE", `/v1/projects/${enc(id)}/folder`)).project;
  }
  /** Looks at a linked folder again: new files added, changed ones read again, removed ones marked missing. */
  checkFolder(id: string): Promise<{ project: Project; check: FolderCheck }> {
    return this.request("POST", `/v1/projects/${enc(id)}/folder/check`);
  }
  /** The folder finished videos are copied into. */
  async library(): Promise<Library> {
    return (await this.request<{ library: Library }>("GET", "/v1/library")).library;
  }
  /** Picks the library folder; `null` goes back to the usual one. */
  async setLibrary(folder: string | null): Promise<Library> {
    return (await this.request<{ library: Library }>("PUT", "/v1/library", { json: { folder } })).library;
  }
  /** Deletes a project for good, with everything in it; `409 project_busy` while a plan in it runs. */
  deleteProject(id: string): Promise<ProjectDeleted> {
    return this.request("DELETE", `/v1/projects/${enc(id)}`);
  }

  // Sources and the Inbox
  projectSources(projectId: string, q: PageQuery = {}): Promise<Page<Source>> {
    return this.page(`/v1/projects/${enc(projectId)}/sources`, "sources", { ...q });
  }
  inbox(q: PageQuery = {}): Promise<Page<Source>> {
    return this.page("/v1/inbox", "sources", { ...q });
  }
  async fileSource(sourceId: string, projectId: string | null): Promise<Source> {
    return (await this.request<{ source: Source }>("POST", `/v1/sources/${enc(sourceId)}/file`, { json: { projectId } })).source;
  }
  addSource(input: AddSourceInput): Promise<SourceDetail> {
    return this.request("POST", "/v1/sources", { json: input });
  }
  getSource(id: string): Promise<SourceDetail> {
    return this.request("GET", `/v1/sources/${enc(id)}`);
  }
  /** Renames a source; null goes back to the name it was read with. */
  async renameSource(id: string, title: string | null): Promise<Source> {
    return (await this.request<{ source: Source }>("PATCH", `/v1/sources/${enc(id)}`, { json: { title } })).source;
  }
  /** Takes a source out of its project or the Inbox (engine/docs/api.md, "Removing and deleting"). */
  removeSource(id: string): Promise<SourceRemoved> {
    return this.request("DELETE", `/v1/sources/${enc(id)}`);
  }
  /** Reads a source that could not be read once more, in the request. */
  retrySource(id: string): Promise<SourceDetail> {
    return this.request("POST", `/v1/sources/${enc(id)}/retry`);
  }
  async upload(file: Blob, filename?: string): Promise<Upload> {
    const headers: Record<string, string> = { "content-type": file.type || "application/octet-stream" };
    if (filename) headers["x-upload-filename"] = filename;
    return (await this.request<{ upload: Upload }>("POST", "/v1/uploads", { body: file, headers })).upload;
  }
  /** The kinds of file the engine reads, and the largest it takes; a folder is filtered by these. */
  uploadTypes(): Promise<{ maxBytes: number; types: UploadType[] }> {
    return this.request("GET", "/v1/uploads/types");
  }

  // Plans
  async listPlans(projectId: string): Promise<Array<Plan & { counts: Counts }>> {
    return (await this.request<{ plans: Array<Plan & { counts: Counts }> }>("GET", `/v1/projects/${enc(projectId)}/plans`)).plans;
  }
  createPlan(projectId: string, input: PlanInput = {}): Promise<PlanView> {
    return this.request("POST", `/v1/projects/${enc(projectId)}/plans`, { json: input });
  }
  getPlan(id: string): Promise<PlanView> {
    return this.request("GET", `/v1/plans/${enc(id)}`);
  }
  updatePlan(id: string, patch: PlanInput): Promise<PlanView> {
    return this.request("PATCH", `/v1/plans/${enc(id)}`, { json: patch });
  }
  setStageLabel(planId: string, level: number, label: string | null): Promise<PlanView> {
    return this.request("PUT", `/v1/plans/${enc(planId)}/stages/${level}`, { json: { label } });
  }
  /** Gives a stage a day (YYYY-MM-DD), or clears it with null. */
  setStageDay(planId: string, level: number, dueOn: string | null): Promise<PlanView> {
    return this.request("PUT", `/v1/plans/${enc(planId)}/stages/${level}`, { json: { dueOn } });
  }
  /** Moves the plan's missed days on from `today`, keeping the gaps between them. */
  catchUp(planId: string, today: string): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/catch-up`, { json: { today } });
  }
  /** Dated stages with something left that were missed, fall today, or fall within `ahead` days. */
  async due(today: string, ahead = 7): Promise<DueStage[]> {
    return (await this.request<{ stages: DueStage[] }>("GET", `/v1/due?today=${today}&ahead=${ahead}`)).stages;
  }
  addItem(planId: string, input: ItemInput): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/items`, { json: input });
  }
  updateItem(planId: string, itemId: string, patch: ItemPatch): Promise<PlanView> {
    return this.request("PATCH", `/v1/plans/${enc(planId)}/items/${enc(itemId)}`, { json: patch });
  }
  deleteItem(planId: string, itemId: string): Promise<PlanView> {
    return this.request("DELETE", `/v1/plans/${enc(planId)}/items/${enc(itemId)}`);
  }
  reorder(planId: string, items: Array<Pick<Item, "id" | "level" | "ord">>): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/reorder`, { json: { items } });
  }
  addEdge(planId: string, edge: Edge): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/edges`, { json: edge });
  }
  deleteEdge(planId: string, edge: Edge): Promise<PlanView> {
    return this.request("DELETE", `/v1/plans/${enc(planId)}/edges`, { query: { ...edge } });
  }
  approve(planId: string): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/approve`);
  }
  start(planId: string): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/start`);
  }
  cancel(planId: string): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/cancel`);
  }
  /** Deletes a plan, or a thing made at once, for good with everything it made; `409 plan_running` while it is being made. */
  deletePlan(planId: string): Promise<PlanDeleted> {
    return this.request("DELETE", `/v1/plans/${enc(planId)}`);
  }
  /** Makes a failed item of a running or failed plan again. */
  /** Makes a failed item again; with `choice`, takes the way on its job offers (`ItemJob.choice`), waiting or failed. */
  retryItem(planId: string, itemId: string, choice?: string): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/items/${enc(itemId)}/retry`, choice ? { json: { choice } } : undefined);
  }
  /** Stops one item being made, or waiting, in a running plan; the plan goes on with its other items, and `retryItem` makes the stopped one go on. */
  stopItem(planId: string, itemId: string): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/items/${enc(itemId)}/stop`);
  }
  /** Starts a stopped plan again from what is not made yet. */
  resume(planId: string): Promise<PlanView> {
    return this.request("POST", `/v1/plans/${enc(planId)}/resume`);
  }
  /** Changes who makes (and reviews) the items not made yet, before Start or while stopped; `409 plan_running` while it runs. */
  changePlanMaker(planId: string, change: PlanMakerChange): Promise<PlanMakerResult> {
    return this.request("POST", `/v1/plans/${enc(planId)}/maker`, { json: change });
  }
  progress(planId: string): Promise<Progress> {
    return this.request("GET", `/v1/plans/${enc(planId)}/progress`);
  }
  markDone(planId: string, itemId: string, input: DoneInput = {}): Promise<{ item: ProgressItem; counts: Counts }> {
    return this.request("POST", `/v1/plans/${enc(planId)}/items/${enc(itemId)}/done`, { json: input });
  }
  /** Keeps where the person stopped in an item; leaves its done tick and result alone. `null` clears it. */
  keepProgress(planId: string, itemId: string, progress: Json | null): Promise<{ item: ProgressItem }> {
    return this.request("POST", `/v1/plans/${enc(planId)}/items/${enc(itemId)}/progress`, { json: { progress } });
  }
  answer(planId: string, itemId: string, answer: boolean): Promise<{ item: ProgressItem; counts: Counts }> {
    return this.request("POST", `/v1/plans/${enc(planId)}/items/${enc(itemId)}/answer`, { json: { answer } });
  }

  // Chats
  async listChats(projectId: string): Promise<Chat[]> {
    return (await this.request<{ chats: Chat[] }>("GET", `/v1/projects/${enc(projectId)}/chats`)).chats;
  }
  async createChat(projectId: string, input: { title?: string; sources?: string[] } = {}): Promise<Chat> {
    return (await this.request<{ chat: Chat }>("POST", `/v1/projects/${enc(projectId)}/chats`, { json: input })).chat;
  }
  /** A chat and its messages; with `after`, only the messages after that seq. */
  getChat(id: string, after?: number): Promise<{ chat: Chat; messages: Message[] }> {
    return this.request("GET", `/v1/chats/${enc(id)}`, after === undefined ? {} : { query: { after } });
  }
  /** The thread on a made thing; `at` asks for that spot in words (`here`), `after` only newer messages. */
  getThread(planId: string, itemId: string, options: { after?: number; at?: Json } = {}): Promise<ThreadView> {
    const query: Query = {};
    if (options.after !== undefined) query.after = options.after;
    if (options.at !== undefined) query.at = JSON.stringify(options.at);
    return this.request("GET", `/v1/plans/${enc(planId)}/items/${enc(itemId)}/thread`, { query });
  }
  /** Writes in a thing's thread: a message of its chat (a new chat when it has none), answered in both. */
  sendThread(planId: string, itemId: string, input: { text: string; at?: Json }): Promise<{ chat: Chat; created: boolean; messages: Message[] }> {
    return this.request("POST", `/v1/plans/${enc(planId)}/items/${enc(itemId)}/thread`, { json: input });
  }
  /** Which made things have a thread, and how many messages each holds (one project's, when given). */
  async threads(projectId?: string): Promise<ThreadCount[]> {
    return (await this.request<{ threads: ThreadCount[] }>("GET", "/v1/threads", projectId ? { query: { project: projectId } } : {})).threads;
  }
  /** Stops the reply the person's agent is writing in this chat. */
  stopChat(id: string): Promise<{ chat: Chat; messages: Message[] }> {
    return this.request("POST", `/v1/chats/${enc(id)}/stop`, { json: {} });
  }
  /** Which agent answers the chat, and whether it can be reached. */
  async agent(): Promise<AgentStatus> {
    return (await this.request<{ agent: AgentStatus }>("GET", "/v1/agent")).agent;
  }
  /** The person's agents that can answer the chat, with what each needs and which of them and their models are on. */
  /** `fresh` has the connector check each agent again. */
  providers(options: { fresh?: boolean } = {}): Promise<Providers> {
    return this.request("GET", options.fresh ? "/v1/providers?fresh=1" : "/v1/providers");
  }
  /** Turns a provider on or off, or changes which of its models the chat shows. */
  updateProvider(id: string, patch: ProviderPatch): Promise<Providers> {
    return this.request("PATCH", `/v1/providers/${enc(id)}`, { json: patch });
  }
  /** Remembers the person's picked agent, model, and effort for a scope, or clears them with nulls. */
  putProviderPick(scope: string, patch: AgentPickPatch): Promise<{ pick: (AgentPick & { scope: string }) | null }> {
    return this.request("PUT", `/v1/providers/picks/${enc(scope)}`, { json: patch });
  }
  /** Sets several scopes' picks in one write ("Use one for all"); answers every pick after it. */
  putProviderPicks(picks: Record<string, AgentPickPatch>): Promise<{ picks: Record<string, AgentPick> }> {
    return this.request("PUT", "/v1/providers/picks", { json: { picks } });
  }
  /** How long making took on this computer, per agent, model, effort and length group; one scope's when given. */
  /** What the agents are doing and what each run took, on this computer (`GET /v1/activity`). */
  activity(q: ActivityQuery = {}): Promise<Activity> {
    return this.request<Activity>("GET", "/v1/activity", { query: { ...q } });
  }
  async makeTimes(scope?: string): Promise<MakeTime[]> {
    return (await this.request<{ times: MakeTime[] }>("GET", "/v1/make-times", scope ? { query: { scope } } : {})).times;
  }

  // Voice: the service, its key (never sent back, only whether one is set) and the voice
  voice(): Promise<VoiceSetup> {
    return this.request("GET", "/v1/voice");
  }
  /** Picks the voice service and its voice; `null` service is none (videos without sound). */
  setVoice(input: { service: string | null; voice?: string | null }): Promise<VoiceSetup> {
    return this.request("PUT", "/v1/voice", { json: input });
  }
  /** Keeps a service's key on this computer; a key the service refuses is not kept (`422 key_refused`). */
  async setVoiceKey(service: string, key: string): Promise<VoiceServiceView> {
    return (await this.request<{ service: VoiceServiceView }>("PUT", `/v1/voice/services/${enc(service)}/key`, { json: { key } })).service;
  }
  clearVoiceKey(service: string): Promise<VoiceSetup> {
    return this.request("DELETE", `/v1/voice/services/${enc(service)}/key`);
  }
  /** The voices of the person's own account on a service. */
  async voiceOptions(service: string): Promise<VoiceOption[]> {
    return (await this.request<{ voices: VoiceOption[] }>("GET", `/v1/voice/services/${enc(service)}/voices`)).voices;
  }
  /** Where a voice's sample plays from, through the proxy. */
  voiceSampleUrl(service: string, voiceId: string): string {
    return `${this.baseUrl}/v1/voice/services/${enc(service)}/voices/${enc(voiceId)}/sample`;
  }

  // First-time setup
  setup(): Promise<SetupState> {
    return this.request("GET", "/v1/setup");
  }
  setSetup(done: boolean): Promise<SetupState> {
    return this.request("PUT", "/v1/setup", { json: { done } });
  }
  /** "Skip for now" on the voice step: the engine keeps it, and a skipped step is not asked again. */
  skipVoice(): Promise<SetupState> {
    return this.request("PUT", "/v1/setup", { json: { voice: { skipped: true } } });
  }
  /** Who can make videos on this engine, and whether each can now. */
  async videoMakers(): Promise<VideoMaker[]> {
    return (await this.request<{ makers: VideoMaker[] }>("GET", "/v1/video-makers")).makers;
  }
  async updateChat(id: string, patch: { title?: string | null; sources?: string[] | null; answerer?: string | null; effort?: string | null }): Promise<Chat> {
    return (await this.request<{ chat: Chat }>("PATCH", `/v1/chats/${enc(id)}`, { json: patch })).chat;
  }
  /** Deletes a chat's messages and the plans it made that never started; `409 chat_busy` while a reply is written. */
  deleteChat(id: string): Promise<ChatDeleted> {
    return this.request("DELETE", `/v1/chats/${enc(id)}`);
  }
  /** Sends a message and waits for the reply, with the view of every plan its pieces carry. */
  send(chatId: string, input: MessageInput): Promise<{ chat: Chat; messages: Message[]; plans: PlanView[] }> {
    return this.request("POST", `/v1/chats/${enc(chatId)}/messages`, { json: input });
  }
  async skills(): Promise<Skill[]> {
    return (await this.request<{ skills: Skill[] }>("GET", "/v1/skills")).skills;
  }
  /**
   * Every command the chat takes now; an engine from before commands were worked out gives its skills' own.
   * An engine from before commands had one name and a group answers `label` and `action` only: its name is
   * the button's words, else the label, and its group follows what it makes.
   */
  async commands(): Promise<ChatCommand[]> {
    type Older = Omit<ChatCommand, "title" | "group"> & Partial<Pick<ChatCommand, "title" | "group">>;
    const r = await this.request<{ skills: Skill[]; commands?: Older[] }>("GET", "/v1/skills");
    const list: Older[] = r.commands ?? r.skills.filter((s) => s.command).map((s) => ({ command: s.command!, label: s.label, about: s.about, skill: s.id }));
    return list.map((c) => ({ ...c, title: c.title ?? c.action ?? c.label, group: c.group ?? (c.format ? "make" : c.chatOnly ? "chat" : "plan") }));
  }
  /** Makes one thing at once, with no chat: a plan of one item that starts itself. */
  make(projectId: string, input: MakeInput): Promise<PlanView> {
    return this.request("POST", `/v1/projects/${enc(projectId)}/make`, { json: input });
  }
  /** Closes a `make` piece the person cancelled, so the chat never opens its sheet again. */
  closeProposal(chatId: string, messageId: string, piece: number): Promise<{ message: Message }> {
    return this.request("POST", `/v1/chats/${enc(chatId)}/messages/${enc(messageId)}/pieces/${piece}/close`);
  }
  /** What making it would set: the settings filled the way a plan fills them, in the format's own words, and what stops it. */
  settleMake(projectId: string, input: MakeInput): Promise<{ settings: JsonObject; plannedAs: string; issues: string[]; notices?: string[] }> {
    return this.request("POST", `/v1/projects/${enc(projectId)}/make/settle`, { json: input });
  }

  // Outputs
  /** The Library. `project: "none"` lists only things made outside a project. */
  listOutputs(q: PageQuery & { project?: "none"; type?: string; q?: string } = {}): Promise<Page<OutputSummary>> {
    return this.page("/v1/outputs", "outputs", { ...q });
  }
  projectOutputs(projectId: string, q: PageQuery & { type?: string; q?: string } = {}): Promise<Page<OutputSummary>> {
    return this.page(`/v1/projects/${enc(projectId)}/outputs`, "outputs", { ...q });
  }
  async planOutputs(planId: string): Promise<OutputSummary[]> {
    return (await this.request<{ outputs: OutputSummary[] }>("GET", `/v1/plans/${enc(planId)}/outputs`)).outputs;
  }
  async getOutput(id: string): Promise<Output> {
    return (await this.request<{ output: Output }>("GET", `/v1/outputs/${enc(id)}`)).output;
  }
  /** Makes one scene of a made thing again, with the person's note; the old one stays until the new one is written. */
  remakeScene(outputId: string, scene: string, input: RemakeInput = {}): Promise<RemakeStarted> {
    return this.request("POST", `/v1/outputs/${enc(outputId)}/scenes/${enc(scene)}/remake`, { json: input });
  }
  /** Opens the folder a job works in, in this computer's file manager (a video's job folder); refused on a paired phone. */
  showJobFiles(id: string): Promise<{ shown: true }> {
    return this.request("POST", `/v1/jobs/${enc(id)}/files/show`);
  }
  /** Stops a job that is not an item's own (a scene being made again). */
  cancelJob(id: string): Promise<{ job: { id: string; status: string } }> {
    return this.request("POST", `/v1/jobs/${enc(id)}/cancel`);
  }
  /** Keeps a made thing as the person changed it by hand, the whole of it in its format's shape (a guide); the engine answers what is wrong when it cannot. */
  async editOutput(id: string, payload: JsonObject): Promise<Output> {
    return (await this.request<{ output: Output }>("PUT", `/v1/outputs/${enc(id)}/payload`, { json: payload })).output;
  }

  // Usage
  async projectUsage(projectId: string): Promise<UsageTotals> {
    return (await this.request<{ usage: UsageTotals }>("GET", `/v1/projects/${enc(projectId)}/usage`)).usage;
  }
  planUsage(planId: string): Promise<PlanUsage> {
    return this.request("GET", `/v1/plans/${enc(planId)}/usage`);
  }

  // Open Sourcebook on a phone: the launcher's phone control, through the proxy (cli/phone.ts). Only this computer reaches it.
  phone(): Promise<PhoneStatus> {
    return this.request("GET", "/phone");
  }
  phoneOn(): Promise<PhoneStatus> {
    return this.request("POST", "/phone/on");
  }
  phoneOff(): Promise<PhoneStatus> {
    return this.request("POST", "/phone/off");
  }
  phoneCode(): Promise<PhoneStatus> {
    return this.request("POST", "/phone/code");
  }
  unpairDevice(id: string): Promise<PhoneStatus> {
    return this.request("DELETE", `/phone/devices/${enc(id)}`);
  }

  // A voice that runs on this computer, installed by the launcher (cli/voice.ts), through the proxy. Only this computer reaches it.
  installVoice(id: string): Promise<VoiceInstallState> {
    return this.request("POST", `/launcher/voices/${enc(id)}/install`);
  }
  voiceInstall(id: string): Promise<VoiceInstallState> {
    return this.request("GET", `/launcher/voices/${enc(id)}`);
  }

  /** A harvested asset's URL, through the proxy. */
  /** A source's own uploaded file (`GET /v1/sources/:id/file`), opened in place or saved by its own name. */
  sourceFileUrl(id: string): string {
    return `${this.baseUrl}/v1/sources/${enc(id)}/file`;
  }

  assetUrl(id: string): string {
    return `${this.baseUrl}/v1/assets/${enc(id)}`;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
