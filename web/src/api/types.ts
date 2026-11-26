/**
 * Shapes from the Studio API contract, engine/docs/api.md, and the older
 * routes in engine/README.md that the web app calls. Optional fields are
 * absent when they have no value; the engine never sends null.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// Formats (GET /v1/formats, engine/README.md)

export interface SettingFieldBase {
  key: string;
  label: string;
  help?: string;
  /** Set by Open Sourcebook itself; clients do not show it. */
  hidden?: boolean;
  /** Shown, and read, only while setting `key` of the same format holds one of `in` (its default when the item sets none). */
  showWhen?: { key: string; in: string[] };
}

/** A setting a format declares. A client leaves out a `kind` it does not know. */
/** One value a `choice` or `choices` setting may hold: the stored code, its word and one plain line on what picking it does. */
export interface SettingOption {
  value: string;
  label: string;
  description?: string;
  /** A picture of what picking it gives, as an engine path (`/v1/...`), loaded through the proxy. */
  preview?: string;
}

/** A number that does not mean the number itself ("0" is "Fit to the brief"): shown by its label, offered as a pick beside the number. */
export interface SpecialValue {
  value: number;
  /** What the value stands for: `auto`, the brief and the sources decide the number when it is made; `none`, there is no such limit. Absent from older engines. */
  means?: "auto" | "none";
  label: string;
  description?: string;
}

export type SettingField =
  | (SettingFieldBase & { kind: "choice"; options: SettingOption[] })
  | (SettingFieldBase & { kind: "choices"; options: SettingOption[]; minItems?: number; maxItems?: number })
  | (SettingFieldBase & { kind: "number"; min?: number; max?: number; step?: number; unit?: string; specialValues?: SpecialValue[] })
  | (SettingFieldBase & { kind: "toggle" })
  | (SettingFieldBase & { kind: "text"; maxLength?: number })
  | (SettingFieldBase & { kind: "textList"; maxItems?: number; maxLength?: number })
  | (SettingFieldBase & {
      kind: "agent";
      effortKey?: string;
      turnKind?: "chat" | "work";
      /** `review`: who reviews it (its scope is `<format>.review`); absent or `make`: who makes it. */
      role?: "make" | "review";
      /** The value that turns it off (a reviewer's `"off"`); absent when it cannot be off. */
      offValue?: string;
    });

/** One number a format's player reports in a result, in words. */
export interface ReportedMetric {
  /** The key in the result. */
  metric: string;
  /** Its name, in sentence case. */
  label: string;
  about?: string;
  /** `share`: 0 to 1, shown as a percentage. `count`, or absent: shown as it is. */
  unit?: string;
}

export interface FormatDescriptor {
  id: string;
  label: string;
  /** The word for more than one ("quizzes"); `label` + "s" when absent. */
  plural?: string;
  /** The words for one in a sentence ("set of flashcards"), when the label reads as many. */
  singular?: string;
  colorSlot: number;
  icon: string;
  aliases?: string[];
  settings: SettingField[];
  defaults: JsonObject;
  /** What it is, in the engine's words. */
  about?: string;
  /** What it is in a few plain words, for a person meeting the word ("cards to swipe and flip, brought back until they stick"). */
  blurb?: string;
  /** True when an engine can make it now. */
  ready: boolean;
  /** When it cannot be made on this computer now for a reason the person can fix: what, with what to do. */
  problem?: string;
  /** What a person's run through it reports, which branches and the card read. */
  reports?: ReportedMetric[];
  /** How its making times are grouped by length: the setting read, and the edges of each group (`timeBucket`). Absent: one group. */
  timing?: { setting: string; edges: number[] };
  /** It is spoken, so the voice set up on this computer makes part of it. */
  voiced?: true;
}

// Projects

export interface Project {
  id: string;
  title: string;
  icon?: string;
  colorHex?: number;
  /** The screen word is "topic". */
  category?: string;
  settings: JsonObject;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** The folder on this computer the project is linked to: its files are sources read where they are. */
  folder?: string;
  /** When the linked folder was last looked at. */
  folderCheckedAt?: string;
}

/** What one look at a linked folder found, by each file's path from the folder (engine/docs/api.md). */
export interface FolderCheck {
  folder: string;
  added: string[];
  changed: string[];
  missing: string[];
  unchanged: number;
  failed: Array<{ path: string; message: string }>;
  skipped: number;
  more: boolean;
}

/** The folder finished videos are copied into, and whether the person picked it. */
export interface Library {
  folder: string;
  chosen: boolean;
}

export interface ProjectInput {
  title?: string;
  icon?: string | null;
  colorHex?: number | null;
  category?: string | null;
  settings?: JsonObject;
}

// Sources

export type ExtractionStatus = "pending" | "extracting" | "ready" | "failed";

/** A source as lists return it. Absent `projectId` means it is in the Inbox. */
export interface Source {
  id: string;
  projectId?: string;
  kind: string;
  /** The name to show, always present: the person's own, else the one read from it, else the engine's fallback. */
  title: string;
  url?: string;
  uploadId?: string;
  origin?: string;
  status: ExtractionStatus;
  /** Why it could not be read, in plain words; only while `status` is `failed`. */
  errorMessage?: string;
  /** Only while `status` is `failed`: whether reading it again could end differently (false for a file that read as nothing). */
  retryable?: boolean;
  /** How much of it could be read, once it has been: `full`, `partial`, `metadata` (a title and description only) or `none`. */
  accessLevel?: AccessLevel;
  /** How long it is, once read ("24 pages"); absent when reading counted nothing. */
  detail?: Measure;
  createdAt: string;
  updatedAt: string;
  /** Set only on a removed source something still points at; lists never show one, reading it by id does. */
  removedAt?: string;
  /** A file of the project's linked folder: its whole path on this computer. */
  filePath?: string;
  /** The file was not in the folder at the last look; the source keeps what was read from it. */
  missingAt?: string;
  /** When it was last read again because the file changed. */
  changedAt?: string;
}

export type AccessLevel = "full" | "partial" | "metadata" | "none" | (string & {});

export interface SourceExtraction {
  contentHash: string;
  kind: string;
  status: ExtractionStatus;
  accessLevel?: AccessLevel;
  errorMessage?: string;
  title?: string;
  text?: string;
  limitations?: string[];
  createdAt: string;
  updatedAt: string;
}

/** `POST /v1/sources` and `GET /v1/sources/:id`. The source here is the stored row, without `status`. */
export interface SourceDetail {
  source: Omit<Source, "status"> & { status?: ExtractionStatus };
  extraction: SourceExtraction;
  chunkCount: number;
}

/** `DELETE /v1/sources/:id`: gone for good, or kept hidden because something still points at it. */
export interface SourceRemoved {
  sourceId: string;
  deleted: boolean;
  /** Plans not started yet whose items no longer read it. */
  changedPlanIds: string[];
}

export interface AddSourceInput {
  url?: string;
  text?: string;
  uploadId?: string;
  projectId?: string;
  kind?: string;
  title?: string;
}

export interface Upload {
  id: string;
  contentType: string;
  filename?: string;
  byteLength: number;
  uploadedAt: string;
}

// Plans

/** `cancelled` is stopped after Start and can be resumed; `discarded` was cancelled before Start and is final. */
export type PlanStatus = "draft" | "approved" | "running" | "done" | "failed" | "cancelled" | "discarded";
export type ItemStatus = "pending" | "queued" | "running" | "done" | "failed" | "skipped" | "cancelled";

export interface Plan {
  id: string;
  projectId: string;
  title?: string;
  version: number;
  supersedesPlanId?: string;
  status: PlanStatus;
  budgetUsd?: number;
  /** The chat whose planning made it; absent for a plan made by hand. */
  chatId?: string;
  createdAt: string;
  updatedAt: string;
  kickedOffAt?: string;
  /** Made for one thing asked for on its own: one item, started at once, shown as that thing rather than a plan card. */
  direct?: boolean;
}

export interface Counts {
  total: number;
  done: number;
}

/** A stage with a label, a day or both; stages with neither are not listed. */
export interface Stage {
  level: number;
  label?: string;
  /** The day the person means to go through it by, YYYY-MM-DD, when they gave one. */
  dueOn?: string;
}

/** `GET /v1/due`: a dated stage with something left, across the person's plans. */
export interface DueStage {
  planId: string;
  planTitle?: string;
  projectId: string;
  projectTitle?: string;
  level: number;
  /** 1-based place among the plan's stages. */
  number: number;
  label?: string;
  dueOn: string;
  when: "missed" | "today" | "soon";
  left: number;
  total: number;
  /** False while the plan waits for Start. */
  started: boolean;
}

/** Where a passage sits in a source; every field optional. */
export interface SourceLocator {
  page?: number;
  endPage?: number;
  slide?: number;
  endSlide?: number;
  startMs?: number;
  endMs?: number;
  charStart?: number;
  charEnd?: number;
  cell?: string;
}

export interface ItemSource {
  sourceId: string;
  range?: SourceLocator;
}

/** A branch condition: a tagged object a registered resolver reads (`metric`, `ask`, …). */
export type Condition = { kind: string } & JsonObject;

export interface Item {
  id: string;
  parentId?: string;
  level: number;
  ord: number;
  type: string;
  title: string;
  /** The brief. */
  prompt?: string;
  settings: JsonObject;
  /** What it will be, in its format's own few words ("Drawn scenes", "Chalkboard", "about 8 min"); absent from older engines. */
  plannedAs?: string[];
  /** What the person should know about it, though it can be made (a video that will have no sound, and what to do for one), or about what was made: each a quiet line. Absent when there is nothing to say. */
  notices?: string[];
  /** Once made: what it is, in the same few words, true of what was made ("18 cards", "6 questions of 8 planned"). */
  madeAs?: string[];
  /** Once made: the maker's own words on why its size differs from the plan's, when it left some. */
  madeNote?: string;
  condition?: Condition;
  enabled: boolean;
  estCostUsd?: number;
  status: ItemStatus;
  /** Why it could not be made; only on a `failed` item. */
  errorMessage?: string;
  /** The item's job once Start queued it: what it is doing now. */
  job?: ItemJob;
  sources: ItemSource[];
  outputId?: string;
  done: boolean;
  doneAt?: string;
  result?: Json;
  /** Where the person stopped in it, in its player's own shape; the same on the phone and here. */
  progress?: Json;
  asking?: { question?: string };
  /** A scene of what it made being made again, while that is queued, running, waiting or failed. */
  remaking?: Remaking;
}

export interface Edge {
  from: string;
  to: string;
  kind: string;
}

export interface PlanView {
  plan: Plan;
  stages: Stage[];
  items: Item[];
  edges: Edge[];
  counts: Counts;
  estimateUsd: number;
  issues: string[];
  /** The same issues in order, each with the item it is about; no `itemId` for one about the whole plan. Absent from older engines. */
  issueDetails?: IssueDetail[];
}

export interface IssueDetail {
  /** Stable kind of issue (`no_sources`, `over_budget`, …); a client acts on it, never on the words. */
  code: string;
  /** The full sentence, naming the item. */
  message: string;
  /** The same without the item's title, for the item's own row. */
  short: string;
  itemId?: string;
}

/** `GET /v1/edge-kinds`: a kind of link between items, said of the later one. */
export interface EdgeKind {
  id: string;
  label: string;
  about: string;
}

/** `GET /v1/projects/:id?counts=1`: what a project holds, counted as deleting it would. */
export interface ProjectCounts {
  chats: number;
  plans: number;
  outputs: number;
  sources: number;
}

export interface PlanInput {
  title?: string | null;
  budgetUsd?: number | null;
}

export interface ItemInput {
  type: string;
  title: string;
  level: number;
  ord?: number;
  prompt?: string;
  settings?: JsonObject;
  sources?: ItemSource[];
  parentId?: string;
  condition?: Condition;
  enabled?: boolean;
  estCostUsd?: number;
}

export type ItemPatch = Partial<{
  type: string;
  title: string;
  level: number;
  ord: number;
  prompt: string;
  settings: JsonObject;
  sources: ItemSource[];
  parentId: string | null;
  condition: Condition | null;
  enabled: boolean;
  estCostUsd: number | null;
}>;

export interface ProgressItem {
  id: string;
  parentId?: string;
  level: number;
  ord: number;
  type: string;
  title: string;
  enabled: boolean;
  status: ItemStatus;
  /** The item's job, once it has one: what it is doing now. */
  job?: ItemJob;
  outputId?: string;
  done: boolean;
  doneAt?: string;
  result?: Json;
  progress?: Json;
  asking?: { question?: string };
  /** A scene of what it made being made again, while that is queued, running, waiting or failed. */
  remaking?: Remaking;
}

/**
 * One scene of a made thing being made again (engine/docs/api.md, "Remaking
 * one scene"): which output and scene, the person's note, and its job. Gone
 * once it is done or stopped.
 */
export interface Remaking {
  outputId: string;
  scene: string;
  note?: string;
  job: ItemJob;
}

/** `POST /v1/outputs/:id/scenes/:scene/remake`: the person's note, and another agent, model or effort when they picked one. */
export interface RemakeInput {
  note?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

/** What a remake answers: its job, and which output and scene it makes again. */
export interface RemakeStarted {
  job: { id: string; status: string; stage: string; progress: number };
  remakeOf: { outputId: string; scene: string };
}

export interface ItemJob {
  id: string;
  status: string;
  /** The engine's stage name, e.g. "writing", "repairing". */
  stage: string;
  /** 0...1. */
  progress: number;
  /** What it is doing now in plain words, while it runs, when its maker says ("Writing scene 2 of 5"). */
  step?: string;
  /** When this attempt started, while it runs. */
  startedAt?: string;
  /** When its maker expects it done, from what this computer has done before, while it runs. */
  doneBy?: string;
  /** Its maker cannot know when it will be done now (nothing like it made here yet, or past what was expected). */
  leftUnknown?: boolean;
  attempt: number;
  errorMessage?: string;
  validation?: Json[];
  /** Set while it waits: something Open Sourcebook runs restarted, the agent's plan reached its limit, or the voice cannot speak. What was made is kept. */
  waiting?: ItemWaiting;
  /**
   * A way on the person may take instead of waiting (a video finished without sound while its voice cannot speak),
   * while it waits or after it was given up on: a button labelled `label`, sent back as `retryItem(..., id)`.
   */
  choice?: { id: string; label: string };
  /** It works in a folder on this computer the person can open ("Show job files"). */
  files?: boolean;
}

export interface ItemWaiting {
  reason: "restart" | "agent_limit" | "voice" | (string & {});
  /** What to tell the person, with what is kept. */
  words: string;
  since: string;
  nextTryAt: string;
  tries: number;
  /** When the agent said its limit resets, only if it said a time. */
  resetsAt?: string;
  /** The agent's own words for when ("3pm (Europe/Berlin)"), already in `words`. */
  resets?: string;
}

export interface Progress {
  plan: Pick<Plan, "id" | "projectId" | "title" | "status" | "kickedOffAt">;
  stages: Stage[];
  items: ProgressItem[];
  counts: Counts;
}

export interface DoneInput {
  done?: boolean;
  result?: Json;
  outputId?: string;
}

/** `DELETE /v1/projects/:id`: how many of each went with it. */
export interface ProjectDeleted {
  projectId: string;
  deleted: ProjectCounts;
}

/** `DELETE /v1/plans/:id`: the plan, or a thing made at once, went for good with what it made. */
export interface PlanDeleted {
  planId: string;
  /** Counted as they went: its items, what they made, their jobs, and the kept files nothing else showed. */
  deleted: { items: number; outputs: number; jobs: number; files: number };
}

/** `DELETE /v1/chats/:id`: plans it made that never started went; started ones stay, without a chat. */
export interface ChatDeleted {
  chatId: string;
  deletedPlanIds: string[];
  keptPlanIds: string[];
}

// Outputs

export interface OutputSummary {
  id: string;
  type: string;
  title: string;
  summary?: string;
  projectId?: string;
  planId?: string;
  itemId?: string;
  category?: string;
  /** What a list shows besides the title, as the format writes it; absent when it shows nothing. */
  glimpse?: Glimpse;
  /** How big it is, counted by its format from what was made; absent when its payload does not say. */
  size?: Measure;
  /** Whether the person ticked it done; absent on something not made from a plan item. */
  done?: boolean;
  schemaVersion: number;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

/** A count and the word after it, already singular or plural to suit the count ("12 cards", "0.5 page"). */
export interface Measure {
  count: number;
  unit: string;
}

/** A line of what a made thing says first, and a picture or its video for a frame. */
export interface Glimpse {
  text?: string;
  media?: { kind: "image" | "video" | (string & {}); url: string };
}

export interface Citation {
  sourceId: string;
  chunkId?: string;
  locator?: SourceLocator;
  quote?: string;
  anchor?: string;
}

export interface Output extends OutputSummary {
  archivedAt?: string;
  payload: JsonObject;
  citations: Citation[];
  prompt?: string;
  settings?: JsonObject;
  sources?: ItemSource[];
  /** One of its scenes can be made again on its own (by `id` in `payload.scenes`). */
  remakesScene?: boolean;
  /** It is a remake of one scene of that output. */
  remakeOf?: { outputId: string; scene: string };
  /** Passages it cites that changed in their file since (a linked folder's file read again). */
  changedChunks?: string[];
}

// Chats (engine/docs/api.md, "Chats")

/** A citation at the exact spot (engine/docs/flashcards.md, "Cite"). */
export interface Cite {
  sourceId: string;
  spot: string;
  chunkId?: string;
  locator?: SourceLocator;
  assetId?: string;
  quote?: string;
}

export interface Chat {
  id: string;
  projectId: string;
  title?: string;
  sources?: string[];
  /** Who answers this chat, as picked (a provider pick); unset is the default provider. */
  answerer?: string;
  /** How hard it thinks, one of the provider's efforts; unset is the provider's own default. */
  effort?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  busySince?: string;
}

export interface Mention {
  kind: string;
  id: string;
  label?: string;
}

/**
 * One piece of a reply, drawn in order. Kinds are open: the engine may send
 * one this app does not know yet (project/pieces.ts draws it honestly).
 */
export interface Piece {
  kind: string;
  [field: string]: unknown;
}

/** Where a block, a list item or a table row stands with its cites (engine/docs/api.md, "Reply blocks"). */
export interface Cited {
  /** Indexes into the message's `cites`. */
  cites?: number[];
  /** It cited the sources but no cite held up to the check, so it is not shown as cited. */
  unchecked?: boolean;
}

/** A paragraph, with inline marks. */
export interface TextPiece extends Piece, Cited {
  kind: "text";
  text: string;
  cites: number[];
  /** The words saying why the person's agent ended a turn early; drawn as the failure line, not as reply text. */
  failure?: boolean;
}

export interface HeadingPiece extends Piece {
  kind: "heading";
  text: string;
}

export interface ListPiece extends Piece, Cited {
  kind: "list";
  ordered: boolean;
  items: Array<{ text: string } & Cited>;
  /** The list in plain words. */
  text: string;
}

export interface TablePiece extends Piece, Cited {
  kind: "table";
  header: string[];
  rows: Array<{ cells: string[] } & Cited>;
  text: string;
}

export interface NotePiece extends Piece, Cited {
  kind: "note";
  text: string;
}

/** A formula on its own line; `text` is LaTeX. */
export interface MathPiece extends Piece, Cited {
  kind: "math";
  text: string;
}

export interface CodePiece extends Piece {
  kind: "code";
  text: string;
  lang?: string;
}

/** How one point of a teach-back stands against the sources. */
export type Verdict = "right" | "missing" | "wrong";

/** Feedback on the person's own explanation of an idea: each point right, left out or wrong, with its cites. */
export interface TeachBackPiece extends Piece, Cited {
  kind: "teachback";
  items: Array<{ verdict: Verdict; text: string } & Cited>;
  /** The feedback in plain words, grouped. */
  text: string;
}

/** One idea on a mind map: its name, a sentence on it, and its cites. */
export interface MindMapNode extends Cited {
  id: string;
  text: string;
  detail?: string;
}

/** How two ideas of a mind map connect, read from `from` to `to`. */
export interface MindMapLink {
  from: string;
  to: string;
  text: string;
}

/** The main ideas of the sources and how they connect; the first node is the centre. */
export interface MindMapPiece extends Piece, Cited {
  kind: "mindmap";
  nodes: MindMapNode[];
  links: MindMapLink[];
  /** The map in plain words. */
  text: string;
}

export interface PlanPiece extends Piece {
  kind: "plan";
  planId: string;
  action: "created" | "edited";
  changes?: string[];
  /** A thing made at once (or a remake of one), drawn as that thing rather than a plan card. */
  made?: "made" | "remade";
}

export interface QuestionOption {
  id: string;
  label: string;
  /** The skill picking this option hands the turn to. */
  skill?: string;
}

export interface QuestionPiece extends Piece {
  kind: "question";
  id: string;
  text: string;
  options: QuestionOption[];
  multiple: boolean;
}

/** Options picked in questions of one earlier reply. */
export interface Answer {
  messageId: string;
  picks: Array<{ questionId: string; optionIds: string[] }>;
}

export interface Message {
  id: string;
  chatId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  mentions?: Mention[];
  sources?: string[];
  answer?: Answer;
  pieces?: Piece[];
  cites?: Cite[];
  covered?: boolean;
  skill?: string;
  /** Set only on a reply Open Sourcebook could not write; its one text piece says what happened. */
  failed?: FailedReply;
  usage?: UsageTotals;
  /** Set while the person's own agent is still writing this reply; it fills in when the turn ends. */
  state?: "running";
  /** The agent that wrote (or is writing) the reply, when one did. */
  agent?: string;
  /** What the agent did, in order: while it runs and after. */
  steps?: Step[];
  /** Once the turn ended: the steps in fewer lines, said in the past ("Read 9 passages of Lecture 7"). */
  stepLines?: StepLine[];
  /** Written in the thread on a made thing, or a reply to such a message: which thing and where in it. */
  about?: ThreadAbout;
  createdAt: string;
}

/**
 * What a thread message is about (engine/docs/api.md, "Threads"): the plan
 * item, its made output, the format and title, where the person was in it
 * in the player's own shape (`at`), and that spot in the format's own words.
 */
export interface ThreadAbout {
  item: string;
  plan: string;
  output?: string;
  format: string;
  title: string;
  at?: Json;
  label?: string;
}

/** The thread on one made thing: the item, its chat once it has one, and the messages about it. */
export interface ThreadView {
  item: { id: string; planId: string; projectId: string; title: string; type: string; outputId?: string };
  chat?: Chat;
  messages: Message[];
  /** The spot asked about (`?at=`) in words, when the format has words for it. */
  here?: { label: string };
}

/** How many messages a thing's thread holds, and in which chat. */
export interface ThreadCount {
  itemId: string;
  chatId: string;
  count: number;
  lastAt: string;
}

/** Steps in a row that did the same kind of thing, as one line. */
export interface StepLine {
  text: string;
  steps: number;
  state: "done" | "failed";
}

/**
 * Why a reply could not be written (engine/docs/api.md, "Message"):
 * `outOfCredit` and `keyRefused` are the model account, `budget` the turn's
 * limit, `error` anything else, where sending again may work. Open: a reason
 * this app does not know reads like `error`.
 */
export interface FailedReply {
  reason: "outOfCredit" | "keyRefused" | "budget" | "error" | (string & {});
  budgetUsd?: number;
  /** The person's agent had shown part of its reply: those blocks stay, cut short. */
  cutShort?: boolean;
}

/** One step an agent took in a turn, in plain words: "Searching Lecture 7". */
export interface Step {
  tool: string;
  label: string;
  state: "running" | "done" | "failed";
  startedAt: string;
  endedAt?: string;
}

/** Which agent answers the chat (`GET /v1/agent`). No credentials, ever. */
export interface AgentStatus {
  configured: boolean;
  reachable?: boolean;
  id?: string;
  label?: string;
  installed?: boolean;
  signedIn?: boolean;
  version?: string;
  model?: string;
}

/** `GET /v1/video-makers`: one way of making a video, and whether it can make one now. */
export interface VideoMaker {
  id: string;
  label: string;
  description: string;
  /** Works only on the person's computer. */
  local?: boolean;
  /** The one the open pick ("Whichever is ready") gets. */
  default?: boolean;
  /** How many styles it offers. */
  styles: number;
  available: boolean;
  /** Why not, with what to do, when it can't. */
  problem?: string;
  agent?: { id?: string; label?: string; model?: string; effort?: string };
  /** What to know before making a video with it, though it can: a line with what to do (no voice key, so no sound). */
  notice?: string;
}

export interface MessageInput {
  text: string;
  mentions?: Mention[];
  sources?: string[];
  skill?: string;
  answer?: Answer;
  budgetUsd?: number;
  /** Who answers, picked in the chat (a provider pick); kept on the chat. */
  answerer?: string;
  /** How hard it thinks, picked in the chat; kept on the chat. */
  effort?: string;
  /** The item open in the Studio as the person writes, so "make it shorter" is about it. */
  opened?: string;
  /** Today on the person's calendar, YYYY-MM-DD, so "by Friday" becomes a stage's day. */
  today?: string;
}

/** `GET /v1/providers`: one of the person's agents that can answer the chat, with their settings over it. */
/** A logo: one filled path in a 24×24 box, in `color` or the text's colour. */
export interface Mark {
  path: string;
  color?: string;
}

export type ModelTier = "fast" | "balanced" | "strong";
export type EffortWeight = "light" | "medium" | "high" | "max";

export interface AgentPick {
  agent?: string;
  model?: string;
  effort?: string;
  /** Turned off; only a review scope (`<format>.review`) can be. */
  off?: boolean;
}

export interface AgentPickPatch {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
  off?: boolean | null;
}

export interface Provider {
  id: string;
  label: string;
  /** Its logo, from its agent's adapter; none gets a plain one. */
  mark?: Mark;
  local?: boolean;
  /** In the person's list in Settings; one not in it is offered under Add provider. */
  added: boolean;
  /** Turned on in Settings; one turned off is never used. */
  enabled: boolean;
  /** Whether it can answer now; an unknown state is shown by its headline. */
  state: "ready" | "signedOut" | "missing" | "unavailable" | (string & {});
  headline: string;
  detail?: string;
  /** The command that signs in to it, run on the person's computer. */
  signIn?: string;
  /** How to install it: its own install page, and its one-line install command when it has one. */
  install?: { command?: string; url: string };
  version?: string;
  /** Answers a chat that picked none. */
  default?: boolean;
  defaultModel?: string;
  defaultEffort?: string;
  /** Default agent for longer work (when set). */
  workDefault?: boolean;
  workDefaultModel?: string;
  workDefaultEffort?: string;
  /** The chat's pick for it with its own default model. */
  pick: string;
  models: ProviderModel[];
  /** The makers of its models, by id: their names and logos. */
  makers?: Record<string, { label: string; mark: Mark }>;
  /** How hard it can be asked to think, lightest first; empty when it takes none. */
  efforts: Array<{ id: string; label: string; weight?: EffortWeight }>;
}

export interface ProviderModel {
  id: string;
  pick: string;
  label: string;
  /** Shown in the chat's picker. */
  shown: boolean;
  /** Starred: listed under the picker's favorites. */
  favorite: boolean;
  /** Who made it, one of its provider's `makers`. */
  maker?: string;
  tier?: ModelTier;
}

export interface ProviderPatch {
  added?: boolean;
  enabled?: boolean;
  hiddenModels?: string[];
  favoriteModels?: string[];
}

export interface Providers {
  /** Whether the engine has a connector set up, whether it answered, and when it was asked. */
  connector: { configured: boolean; reachable: boolean; checkedAt?: string };
  providers: Provider[];
  /** Remembered agent/model/effort picks by scope (such as a format id). */
  picks?: Record<string, AgentPick>;
}

export interface Skill {
  id: string;
  label: string;
  command?: string;
  about: string;
}

/** A command the chat takes (`GET /v1/skills`, `commands`): a skill's own word, or one per format that can be made. */
export interface ChatCommand {
  command: string;
  /** The one name on screen, the same in the `/` list, the Tools list and the Studio. */
  title: string;
  /** Where it is listed: things that are made, plans, or answers in the chat that make nothing. */
  group: "make" | "plan" | "chat";
  /** Kept for older clients; use `title`. */
  label: string;
  /** Kept for older clients; use `title`. */
  action?: string;
  /** It makes nothing, so only the chat offers it, never the Studio. */
  chatOnly?: boolean;
  /** One line on what it does. */
  about: string;
  skill: string;
  /** The format it makes at once, when it is a format's command. */
  format?: string;
}

/**
 * A thing asked for in the chat, settled and checked but saved nowhere: the
 * make sheet opens filled in from it, and nothing is made until the person
 * presses the sheet's button.
 */
export interface MakePiece extends Piece {
  kind: "make";
  format: string;
  title: string;
  /** The brief in the person's words: what the sheet's "What it covers" shows. */
  about: string;
  /** Source ids. */
  sources: string[];
  /** Settled as `/make/settle` settles them. */
  settings: JsonObject;
  plannedAs: string;
  notices: string[];
  /** What would stop it now; the sheet shows them and its button stays off while there are any. */
  issues: string[];
  /** A follow-up about something made: a remake of that item. */
  remakes?: { planId: string; itemId: string };
  state: "open" | "made" | "closed";
  /** Once made from this piece. */
  planId?: string;
}

/** What the Studio's make form asks for (`POST /v1/projects/:id/make`). */
export interface MakeInput {
  format: string;
  about?: string;
  sources?: string[];
  settings?: JsonObject;
  chatId?: string;
  /** A remake of this made item: the new plan supersedes its plan. */
  remakes?: { planId: string; itemId: string };
  /** The chat's `make` piece it was opened from, marked made so it never opens again. */
  proposal?: { messageId: string; piece: number };
}

// Makers, reviewers and times (GET /v1/providers picks, GET /v1/make-times)

/** How long making took here for one key (scope, agent, model, effort, bucket): the middle of the newest runs. */
export interface MakeTime {
  /** "chat", a format id, or "<format>.review". */
  scope: string;
  agent: string;
  model?: string;
  effort?: string;
  /** The length group ("auto", "le4", "gt20"); absent for a scope made in one group. */
  bucket?: string;
  /** How many runs it is from, at most 12. */
  runs: number;
  /** The middle of those runs, in seconds. */
  seconds: number;
  lastAt: string;
}

/** `POST /v1/plans/:id/maker`: who makes (and reviews) the items not made yet. A `null` goes back to the defaults. */
export interface PlanMakerChange {
  /** A pick id; null is "auto". */
  agent: string | null;
  effort?: string | null;
  /** A pick id, "off", or null for "auto". */
  reviewer?: string | null;
  reviewEffort?: string | null;
  /** Only these items; absent is every item not made yet. */
  items?: string[];
}

export type PlanMakerResult = PlanView & {
  changed: string[];
  /** Items left as they were, each with why in its format's words. */
  unchanged: Array<{ itemId: string; why: string }>;
};

// Voice (GET /v1/voice and its routes). The browser never sees a key, only that one is set.

export interface VoiceServiceView {
  id: string;
  label: string;
  where: "hosted" | "local";
  about: string;
  needsKey: boolean;
  keyLabel?: string;
  keyHelpUrl?: string;
  keySet?: boolean;
  /** The key's last four characters. */
  keyHint?: string;
  /** A local one: whether it is installed. */
  installed?: boolean;
  /** A local one: what to run, and where, to install it. */
  install?: { command: string; folder?: string };
  listsVoices: boolean;
  /** Whether it offers a sample of its voices to hear; with none, no voice of it has a play button. */
  samples: boolean;
  health?: { ok: true } | { ok: false; trouble: "credits" | "refused" | "unreachable"; message: string };
}

export interface VoiceSetup {
  /** The chosen service; absent is none (videos without sound). */
  service?: string;
  voice?: { id: string; label: string };
  /** Where the choice comes from. */
  from: "app" | "env" | "none";
  /** The plain line to show. */
  note?: string;
  /** Hosted A to Z, then local. */
  services: VoiceServiceView[];
}

export interface VoiceOption {
  id: string;
  label: string;
  description?: string;
  language?: string;
  sample: boolean;
}

// First-time setup (GET /v1/setup)

export interface SetupState {
  /** Set by the last step, or by Skip on it. */
  done: boolean;
  /** Added and on, and of those, ready. */
  providers: { connected: number; ready: number };
  /** A voice service is chosen; the person skipped the voice step (kept, so setup does not ask again). */
  voice: { set: boolean; skipped: boolean };
}

// Sources (GET /v1/uploads/types)

/** A kind of file the engine reads, with its plain group word ("PDF", "slides", "images"). */
export interface UploadType {
  contentType: string;
  extensions: string[];
  group: string;
}

// Usage

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** Dollars. Calls to a model with no known price add nothing here and count in `unpricedCalls`. */
  usd: number;
  unpricedCalls: number;
  /** Calls the engine stopped waiting for; the provider may still bill them, so `usd` may be undercounted. Absent from older engines. */
  timedOutCalls?: number;
}

export interface PlanUsage {
  usage: UsageTotals;
  items: Array<{ id: string; usage: UsageTotals }>;
}

// Paging

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  rows: T[];
  nextCursor?: string;
}

// Open Sourcebook on a phone (the launcher's phone control, cli/phone.ts)

/** A device paired to open Open Sourcebook from the home network. */
export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string;
}

/** An install of a voice that runs on this computer, as the launcher runs it (cli/voice.ts). */
export type VoiceInstallState = { voice: string } & ({ state: "idle" } | { state: "installing"; since: string } | { state: "done" } | { state: "failed"; message: string });

export interface PhoneStatus {
  /** Whether phones on the home network may open Open Sourcebook (once paired). */
  on: boolean;
  /** Where a phone opens Open Sourcebook, while it is on. */
  address?: string;
  /** The open one-time pairing code: its address (for the QR code), when it runs out, and the QR code as SVG. */
  code?: { url: string; expiresAt: string; svg: string };
  devices: PairedDevice[];
}

/** Where an activity row opens: a project's chat, its plan, or the thing made. */
export interface ActivityOpen {
  projectId: string;
  chatId?: string;
  planId?: string;
  outputId?: string;
}

/** Something being made now (`GET /v1/activity`, `making`). */
export interface ActivityMaking {
  jobId: string;
  shape: string;
  title?: string;
  project?: { id: string; title: string };
  open?: ActivityOpen;
  status: "running" | "waiting" | "queued";
  step?: string;
  waiting?: { reason: string; words: string };
  progress: number;
  /** When it started, or was asked for while queued. */
  since: string;
  seconds: number;
  doneBy?: string;
  /** The agent, model and effort picked for it; absent when left to Open Sourcebook. */
  maker?: { agent?: string; model?: string; effort?: string };
}

/** One finished agent turn (`GET /v1/activity`, `turns`). Never a cost. */
export interface ActivityTurn {
  turnId: string;
  at: string;
  /** A format id, `chat`, or the turn's own type; absent when it named nothing. */
  shape?: string;
  /** The fresh read of something made, not its making. */
  review?: true;
  title?: string;
  project?: { id: string; title: string };
  open?: ActivityOpen;
  agent: string;
  agentLabel?: string;
  model?: string;
  effort?: string;
  seconds: number;
  /** Tokens read fresh. */
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens read from the cache. */
  cacheReadTokens?: number;
  /** Tokens written to the cache. */
  cacheWriteTokens?: number;
  toolCalls: number;
  outcome: "done" | "failed" | "stopped";
}

export interface ActivityTotals {
  turns: number;
  seconds: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Activity {
  connector: "ready" | "notSetUp" | "unreachable";
  log?: "off";
  making: ActivityMaking[];
  turns: ActivityTurn[];
  nextCursor?: string;
  totals?: { today: ActivityTotals; week: ActivityTotals };
  shapes: Array<{ id: string; label: string }>;
  projects: Array<{ id: string; title: string }>;
}

export interface ActivityQuery {
  limit?: number;
  cursor?: string;
  shape?: string;
  project?: string;
  /** The start of the person's today, as an ISO time. */
  dayStart?: string;
}
