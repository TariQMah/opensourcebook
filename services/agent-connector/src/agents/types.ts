/**
 * An agent the connector can run: the person's own coding agent, the
 * unmodified program as it is installed and signed in on this computer. An
 * adapter knows how to start one turn of its CLI boxed in (an empty
 * directory, its own tools off, no prompts, only Open Sourcebook's tools through MCP)
 * and how to read what it says back. Open Sourcebook only launches it: it never reads,
 * copies, stores, passes on or prints the CLI's login. The one credential
 * an adapter may hold is an API key the person gave the connector for it.
 */
import type { Box, Reach } from "../box.ts";
import type { Mark } from "./marks.ts";

/** Why a turn did not end with a reply, in the engine's words. */
export type Problem = "agentMissing" | "agentSignedOut" | "agentLimit" | "timedOut" | "stopped" | "error";

export interface AgentInfo {
  installed: boolean;
  version?: string;
  /** Undefined when the CLI cannot say without reading its credentials. */
  signedIn?: boolean;
  /** Set when the adapter cannot run turns yet, in plain words. */
  unavailable?: string;
  /** It answers with the API key the person gave the connector, as it is not signed in itself. */
  apiKey?: boolean;
  /** How it answers, in one plain sentence, when that is worth telling the person (e.g. "with your API key"). */
  note?: string;
  /** The models it offers when it can only say so by asking the CLI; replaces the adapter's own list. */
  models?: readonly AgentModel[];
}

export interface TurnSpec {
  turnId: string;
  systemPrompt: string;
  /** Add the system prompt to the agent's own instructions instead of replacing them. */
  keepAgentPrompt?: boolean;
  prompt: string;
  model?: string;
  effort?: string;
  /** The empty directory the agent runs in. */
  cwd: string;
  /** Open Sourcebook's tools, as an MCP server over HTTP on this connector. */
  mcp: { name: string; url: string; headers: Record<string, string> };
  /**
   * Called while the agent is still writing the input of a call to one of
   * Open Sourcebook's tools, with the tool's name (as Open Sourcebook lists it) and the input's JSON
   * so far, unfinished. Adapters whose CLI cannot stream tool input never
   * call it.
   */
  onDraft?: (tool: string, partialInput: string) => void;
  /**
   * When set, the turn works in this folder (`cwd` is it) with some of the agent's own tools on, as `access` says:
   * - `files`: its file tools only (read, write, edit, search), limited to this folder by the agent's own permission
   *   rules, no shell and no web of its own, on its own login. `box`, when there is one, is a second wall around it
   *   that still lets the program reach its own login the way it normally does. Only adapters with `filesOnly`.
   * - `full`: its shell, files and web, inside the box (`../box.ts`), on an API key. Only adapters with `boxing`.
   */
  workspace?: {
    access: WorkspaceAccess;
    box?: Box;
    connectorPort: number;
    /**
     * What the agent may reach in files: the folder itself to write, and what the caller named beside it (a video's
     * `README.md`, `sources/`, `extracted/`, and the exact files its links lead to) to read only (`reachOf` in
     * `../box.ts`). Only with a box, which already opens exactly those reads; an adapter whose own rules wall the folder
     * opens them there too, as far as its rules can (`FilesOnly.reads`).
     */
    reach?: Reach;
    /** With a box: the agent's own temporary folder for this turn (its TMPDIR), as the shared ones are shut in the box. */
    tmp?: string;
    /**
     * Where the boxed agent sends its model calls: this connector, which adds the API key the person gave it on the
     * way out (`Boxing.upstream`), so the key itself never enters the box. `secret` is what the agent signs its calls
     * with; it works only on this computer and only while the turn runs. Never a subscription login: a boxed turn
     * runs only on an API key.
     */
    model?: { baseUrl: string; secret: string };
  };
}

/** What an agent may do in a workspace of its own: its file tools only, or its shell, files and web. */
export type WorkspaceAccess = "files" | "full";

export interface TurnEnd {
  ok: boolean;
  problem?: Problem;
  /** What the agent said last, as text. */
  text?: string;
  model?: string;
  tokensIn?: number;
  /** Uncached input tokens, kept separate from cache tokens, when the CLI reports it. */
  inputTokens?: number;
  /** Input tokens of the turn's first model call, when the CLI reports it. */
  firstTokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cost in USD when the agent itself reports one; never estimated or computed. */
  costUsd?: number;
  /** A short reason for the connector's log; never shown to the person. */
  detail?: string;
  /**
   * With a failed turn: the agent's own words on why, as it reported them in its own output (its error event, never
   * its log or stderr), for the person; e.g. that the model asked for is not offered on their account.
   */
  said?: string;
  /** With `agentLimit`: when the agent said its limit resets, if it said so (`./limit.ts`). */
  limit?: LimitReset;
}

/** When an agent said its usage limit resets: each field only when it really said it, never estimated. */
export interface LimitReset {
  /** An exact time it gave, as ISO 8601. */
  resetsAt?: string;
  /** Its own short words for when, e.g. "3pm (Europe/Berlin)" or "in 2 hours". */
  resets?: string;
}

export interface RunningTurn {
  done: Promise<TurnEnd>;
  /** Stops the agent; `done` then settles. */
  kill(): void;
}

/** A model the agent can be asked to use: what its CLI takes, and its name on screen. */
/** Rough capability and cost tier of a model, for time and plan-usage estimates. */
export type ModelTier = "fast" | "balanced" | "strong";

/** Rough thinking budget weight of an effort setting, for time and plan-usage estimates. */
export type EffortWeight = "light" | "medium" | "high" | "max";

export interface AgentModel {
  id: string;
  label: string;
  /** Who made it, one of `MAKERS` (`./marks.ts`); left out, it is told from its id and name. */
  maker?: string;
  /** Rough capability tier of this model. */
  readonly tier?: ModelTier;
}

/** How hard the agent thinks on a turn: what its CLI takes, and its name on screen. */
export interface AgentEffort {
  id: string;
  label: string;
  /** Rough thinking weight of this effort level. */
  readonly weight?: EffortWeight;
}

/** Where an agent is installed from: its own install page, and its one-line install command when it has one. */
export interface AgentInstall {
  readonly command?: string;
  readonly url: string;
}

export interface AgentAdapter {
  readonly id: string;
  /** The name on screen. */
  readonly label: string;
  /** Its logo (`./marks.ts`); none gets a plain one. */
  readonly mark?: Mark;
  /** Who made the models it offers, when that is always one maker (`MAKERS` in `./marks.ts`). */
  readonly maker?: string;
  /** The models a chat can pick for it; none means only its own default. */
  readonly models?: readonly AgentModel[];
  /**
   * The model it runs on when the caller names none, by the kind of turn: `chat` for a chat turn's many small steps,
   * `work` for a long piece of work (a video). Each is one of its own models; one left out means no model is passed and
   * the agent runs on its own default. Nothing outside the adapter names a model of an agent.
   */
  readonly defaultModels?: { readonly chat?: string; readonly work?: string };
  /**
   * The effort it runs at when the caller names none, by the kind of turn (`chat` or `work`), so a chat's effort
   * never carries into a piece of work. Undefined passes no effort.
   */
  readonly defaultEfforts?: { readonly chat?: string; readonly work?: string };
  /** The efforts a chat can pick for it, lightest first; none means it takes no effort. */
  readonly efforts?: readonly AgentEffort[];
  /** True when this adapter can replace its built-in instructions on a work turn without breaking its own tool protocol. */
  readonly replacesWorkPrompt?: boolean;
  /** What to run on this computer to sign in to it, shown in its "How to connect" and when it is signed out. */
  readonly signIn?: string;
  /**
   * How to install it, from its own documentation: its install page, and the one-line command that page gives for
   * this kind of computer when it gives one. Shown in its "How to connect"; never run by the connector.
   */
  readonly install?: AgentInstall;
  info(): Promise<AgentInfo>;
  run(spec: TurnSpec): RunningTurn;
  /** Set when the agent can run inside the box with its shell, files and web (`full`). */
  readonly boxing?: Boxing;
  /** Set when the agent can work in a folder with its file tools only, on its own login (`files`). */
  readonly filesOnly?: FilesOnly;
}

/**
 * A workspace with the agent's file tools only, on the person's own login as the agent has it. With no shell and no
 * web of its own there is no way for the login to leave, so nothing about the login changes: Open Sourcebook never touches it. The
 * folder is the agent's own permission rules' wall, and the box's too where there is one.
 */
export interface FilesOnly {
  /** What the agent gets there, in one plain sentence, for the person. */
  readonly note: string;
  /**
   * True when, with its file tools only, it runs inside the box where there is one, so what the caller named beside its
   * folder (`TurnSpec.workspace.reach`) can be opened read only there: the box holds reads to exactly those paths and
   * writes to the folder, and its own rules open them as far as they can. Left out, or with no box, it gets its folder
   * alone: rules of an agent's own that open a path open it to writes too, or a whole folder for one file.
   */
  readonly reads?: boolean;
}

/**
 * An agent in the box has its own shell and the web, so whatever it can read it could send out. So it never runs on
 * the person's subscription login there (the provider's terms also forbid passing that login on or routing calls
 * through it): only on an API key the person gave the connector for it, which the connector adds to the boxed agent's
 * model calls on their way out. Without a key, work that asks for a workspace runs with Open Sourcebook's tools only.
 */
export interface Boxing {
  /** Why the agent can't run in the box right now, in plain words (e.g. no API key for it); undefined when it can. */
  unready(): string | undefined;
  /** What the agent gets in the box, in one plain sentence, for the person. */
  readonly note: string;
  /**
   * Where the agent's model calls go and the API key they carry, added by the connector so the box never holds it.
   * Only requests whose method and path `allows` are forwarded.
   */
  upstream?(): Upstream | undefined;
}

export interface Upstream {
  origin: string;
  /** The headers that carry the API key, put on each forwarded call (e.g. `x-api-key`). */
  headers: Record<string, string>;
  allows(method: string, path: string): boolean;
}
