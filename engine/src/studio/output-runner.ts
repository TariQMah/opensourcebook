/**
 * The runner for `kind = 'output'` jobs: one engine run for one item,
 * whether it is in a plan or made on its own in quick mode.
 *
 *   1. load the job's sources and make sure each is extracted (cached by hash);
 *   2. build the EngineContext: provider wired to a usage sink scoped to the
 *      job, the asset store, the run's abort signal and progress;
 *   3. runEngine, resuming from the blueprint saved on the job;
 *   4. write the `outputs` row with the brief, settings and sources used and
 *      the job's summed cost.
 *
 * Everything the engine needs from the plan (brief, settings, the outputs
 * it may assume, fix inputs) is written into the job's input when the job is
 * queued, so this runner does not know about plans.
 */
import type { AssetStore } from "../assets";
import { projectPacks } from "../chat/planning/guide";
import { PipelineError, isRetryablePipelineError } from "../engines/retry";
import { failureCodeOf } from "../jobs/failure-words";
import { CHOSEN_KEY, JobFailure, type JobRun } from "../jobs/lifecycle";
import type { JobRunner, JobRunResult } from "../jobs/consumer";
import type { TurnPick } from "../chat/agent/connector";
import { PickNeededError } from "../chat/providers";
import type { JsonObject } from "../jobs/types";
import { isRecord } from "../net";
import { BudgetGuard } from "../providers/budget";
import { SettlingUsageSink } from "../providers/usage";
import { SourceInputError, type SourceService } from "../sources/service";
import type { FetchLike, StructuredProvider, UsageSink } from "../types/provider";
import { runEngine, type FormatRegistry } from "./registry";
import { reviewScope, timeBucket, usableTiming } from "./timing";
import type { StudioRepositories } from "./repositories";
import type { Project, Settings } from "./repositories/projects";
import { folderName, joinPath, type LocalFiles } from "../local-files";
import type {
  EngineCheckpoint,
  EngineContext,
  FormatDescriptor,
  JsonValue,
  MakeTiming,
  NodeInput,
  NodeSource,
  PriorOutput,
  SourceLocator,
  SceneRemakeOf,
  ValidationReport,
} from "./types";

/** What an output job's `input_json` holds. */
export interface OutputJobInput {
  sources: Array<{ sourceId: string; range?: SourceLocator }>;
  title?: string;
  /** The item's brief; empty for quick mode. */
  prompt?: string;
  /** Raw settings, parsed by the format's `parseSettings`. */
  settings?: JsonValue;
  assumes?: PriorOutput[];
  inputs?: NodeInput[];
  budgetUSD?: number;
  /** A caption shared with a link; reaches the extractor on first extraction only. */
  contextText?: string;
  /** A remake of one scene of a made output, the rest of it kept (`EngineContext.remakeOf`). */
  remakeOf?: SceneRemakeOf;
}

export interface OutputRunnerOptions {
  repos: StudioRepositories;
  registry: FormatRegistry;
  sources: SourceService;
  /** Builds the provider for one job. Every call it makes must report to `usage`. */
  provider(usage: UsageSink): StructuredProvider | undefined;
  assets: AssetStore;
  fetch: FetchLike;
  /** For addresses a source or a model gave; see `EngineServices.sourceFetch`. */
  sourceFetch?: FetchLike;
  now?: () => string;
  /**
   * Settles a turn's pick that names no agent, for the owner of the job
   * (`EngineServices.settlePick`): the scope's default, else the only
   * provider that can. Undefined when none can; throws `PickNeededError`
   * when several could; the pick as it is when the connector can't be
   * reached (the turn then says so). Absent: picks are sent as they are.
   */
  settlePick?(ownerId: string, scope: string, pick: TurnPick): Promise<TurnPick | undefined>;
  /** This computer's files, for where a finished file is copied (`EngineServices.libraryFolder`); absent when deployed. */
  localFiles?: LocalFiles;
}

/** Share of a job's progress bar spent extracting before the engine starts. */
const EXTRACTION_SHARE = 0.1;
/** How many validation errors a failed job's message lists. */
const REPORTED_ISSUES = 5;

export class OutputJobRunner implements JobRunner {
  constructor(private readonly options: OutputRunnerOptions) {}

  async run(run: JobRun): Promise<JobRunResult> {
    const job = run.job;
    const { repos } = this.options;

    // A redelivery after the output row was written must not write a second one.
    const written = typeof job.state.outputId === "string" ? await repos.outputs.get(job.state.outputId) : undefined;
    if (written) {
      const of = parseOutputJobInput(job.input);
      if (typeof of !== "string" && of.remakeOf) await this.retireRemade(job, of.remakeOf.outputId, written.id);
      return { outputId: written.id };
    }

    const definition = job.type ? this.options.registry.get(job.type) : undefined;
    if (!definition) throw new JobFailure(`No engine is registered for format "${job.type ?? ""}".`, false, "format_missing");
    const input = parseOutputJobInput(job.input);
    if (typeof input === "string") throw new JobFailure(`Invalid output job: ${input}`, false, "bad_job");
    const parsed = definition.parseSettings(input.settings);
    if (!parsed.ok) {
      throw new JobFailure(`Invalid settings: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`, false, "bad_settings");
    }

    const settling = new SettlingUsageSink(
      repos.usage.sink({
        ownerId: job.ownerId,
        jobId: job.id,
        ...(job.projectId ? { projectId: job.projectId } : {}),
        ...(job.planId ? { planId: job.planId } : {}),
        ...(job.nodeId ? { nodeId: job.nodeId } : {}),
      }),
    );
    // A retried job starts from what its earlier attempts already spent.
    const before = input.budgetUSD === undefined ? 0 : (await repos.usage.totals("job", job.id)).usd;
    const budget = new BudgetGuard(settling, input.budgetUSD, before);
    const usage: UsageSink = budget;
    const provider = budget.guard(this.options.provider(usage) ?? missingProvider);

    await run.progress("extracting", 0);
    const sources = await this.loadSources(input, provider);
    run.signal.throwIfAborted();

    const ctx: EngineContext = {
      jobId: job.id,
      ownerId: job.ownerId,
      node: {
        id: job.nodeId ?? job.id,
        type: definition.descriptor.id,
        title: input.title ?? "",
        prompt: input.prompt ?? "",
        settings: parsed.settings,
      },
      sources,
      assumes: input.assumes ?? [],
      inputs: input.inputs ?? [],
      ...(input.budgetUSD !== undefined ? { budgetUSD: input.budgetUSD } : {}),
      ...(input.remakeOf ? { remakeOf: input.remakeOf } : {}),
      services: {
        provider,
        assets: this.options.assets,
        usage,
        fetch: this.options.fetch,
        ...(this.options.sourceFetch ? { sourceFetch: this.options.sourceFetch } : {}),
        now: this.options.now ?? (() => new Date().toISOString()),
        signal: run.signal,
        progress: async (update) => {
          const step = update.step?.trim().slice(0, MAX_STEP_CHARS);
          if (step && run.job.state[STEP_KEY] !== step) await run.saveState(STEP_KEY, step);
          if (update.doneBy !== undefined) {
            const doneBy = { attempt: run.attempt, at: update.doneBy };
            const kept = run.job.state[DONE_BY_KEY];
            if (JSON.stringify(kept) !== JSON.stringify(doneBy)) await run.saveState(DONE_BY_KEY, doneBy);
          }
          await run.progress(update.stage, EXTRACTION_SHARE + (1 - EXTRACTION_SHARE) * update.progress);
        },
        checkpoint: jobCheckpoint(run),
        ...(this.options.settlePick ? { settlePick: settlePickFor(this.options.settlePick, job.ownerId) } : {}),
        ...(typeof run.job.state[CHOSEN_KEY] === "string" ? { chosen: run.job.state[CHOSEN_KEY] as string } : {}),
      },
    };
    if (job.projectId) {
      const project = await repos.projects.get(job.projectId);
      if (project && project.ownerId === job.ownerId) {
        const packs = projectPacks(project.settings);
        ctx.project = { id: project.id, title: project.title, ...(packs.length > 0 ? { packs } : {}) };
        const files = this.options.localFiles;
        if (files) ctx.services.libraryFolder = () => libraryFolderOf(repos, files, project);
      }
    }

    // A blueprint from a way of making Open Sourcebook no longer has is not continued: the
    // item is planned again by the maker it resolves to now. A stand-in that
    // is gone marked its jobs with `state.mode` (DECISIONS #50); a format
    // says which of its own saved blueprints it can no longer read.
    const saved = job.state.blueprint;
    const stale = job.state.mode !== undefined || (saved !== undefined && definition.keepsBlueprint?.(saved) === false);
    if (stale) {
      if (job.state.mode !== undefined) await run.saveState("mode", null);
      await run.saveState(CHECKPOINTS_KEY, null);
    }

    let result;
    try {
      result = await runEngine(definition, ctx, {
        ...(saved !== undefined && !stale ? { blueprint: saved } : {}),
        onBlueprint: async (blueprint) => {
          await run.saveState("blueprint", blueprint as JsonValue);
        },
        onReport: async (report, round) => {
          await run.saveState(VALIDATION_KEY, [...validationLog(run.job.state[VALIDATION_KEY]), validationEntry(report, round, run.attempt)].slice(-MAX_VALIDATION_ENTRIES));
        },
      });
    } catch (error) {
      // Whatever an engine made of the refusal, the job ends as a budget failure.
      if (budget.exceeded) throw new JobFailure(budget.exceeded.message, false, "over_budget");
      // An engine error a retry cannot change (no source text, unusable settings) ends the job at once.
      if (error instanceof PipelineError && !isRetryablePipelineError(error)) throw new JobFailure(error.message, false, failureCodeOf(error));
      throw error;
    }
    if (budget.exceeded) throw new JobFailure(budget.exceeded.message, false, "over_budget");
    if (!result.report.valid) throw new JobFailure(summarizeReport(result.report, result.repairRounds), false, "not_valid");

    await settling.settled();
    const cost = await repos.usage.totals("job", job.id);
    // Calls to a model with no price add nothing to the cost; say so on the job.
    if (cost.unpricedCalls > 0) {
      console.warn(`Job ${job.id}: ${cost.unpricedCalls} provider call(s) used a model with no price; cost is understated.`);
      await run.saveState("unpricedCalls", cost.unpricedCalls);
    }
    // A call the engine stopped waiting for may still be billed; its cost is unknown.
    if (cost.timedOutCalls > 0) await run.saveState("timedOutCalls", cost.timedOutCalls);
    const output = await repos.outputs.create({
      ownerId: job.ownerId,
      ...(ctx.project ? { projectId: ctx.project.id } : {}),
      ...(job.nodeId ? { nodeId: job.nodeId } : {}),
      type: definition.descriptor.id,
      schemaVersion: definition.engine.schemaVersion,
      title: result.output.title,
      summary: result.output.summary,
      payload: result.output.payload,
      citations: result.output.citations,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      settings: parsed.settings as Settings,
      sources: input.sources,
      costUsd: cost.usd,
    });
    await run.saveState("outputId", output.id);
    if (input.remakeOf) await this.retireRemade(job, input.remakeOf.outputId, output.id);
    // What the maker keeps to find its work again (a remake of one scene reads it), once the pieces below are spent.
    if (result.output.keep && Object.keys(result.output.keep).length > 0) await run.saveState(KEPT_KEY, result.output.keep);
    await this.recordTiming(job.ownerId, job.id, definition.descriptor, parsed.settings, result.output.timing);
    // The output row holds the work now; the pieces kept for a retry are spent.
    await run.saveState(CHECKPOINTS_KEY, null);
    return { outputId: output.id };
  }

  /**
   * A scene made again: the new video takes the old one's place. The old
   * output is archived, as outputs are, so lists, the Library and the item
   * show only the new one, while its row and files stay for whatever still
   * points at them; a done tick that named the old one names the new one.
   * Only the old output of this same item and owner is retired, and doing
   * it again changes nothing.
   */
  private async retireRemade(job: { ownerId: string; nodeId?: string }, oldId: string, newId: string): Promise<void> {
    const { repos } = this.options;
    if (!job.nodeId || oldId === newId) return;
    const old = await repos.outputs.get(oldId);
    if (!old || old.ownerId !== job.ownerId || old.nodeId !== job.nodeId) return;
    if (!old.archivedAt) await repos.outputs.archive(old.id);
    const result = await repos.results.get(job.nodeId);
    if (result?.outputId === old.id) await repos.results.set(job.nodeId, { outputId: newId });
  }

  /**
   * Keeps how long a finished job took, under the pick the maker says it was
   * made on (and its review under the review's). A time is only what the
   * maker measured: with none, nothing is kept. Never fails the job.
   */
  private async recordTiming(ownerId: string, jobId: string, descriptor: FormatDescriptor, settings: unknown, timing: MakeTiming | undefined): Promise<void> {
    if (!usableTiming(timing)) return;
    const bucket = timeBucket(descriptor, settings);
    // A shape that keeps times by length has no time to keep without a length.
    if (descriptor.timing && bucket === undefined) return;
    try {
      const at = (this.options.now ?? (() => new Date().toISOString()))();
      await this.options.repos.makeTimes.record({
        ownerId,
        scope: descriptor.id,
        agent: timing.agent,
        ...(timing.model ? { model: timing.model } : {}),
        ...(timing.effort ? { effort: timing.effort } : {}),
        ...(bucket ? { bucket } : {}),
        seconds: timing.seconds,
        jobId,
        madeAt: at,
      });
      if (timing.review && usableTiming(timing.review)) {
        await this.options.repos.makeTimes.record({
          ownerId,
          scope: reviewScope(descriptor.id),
          agent: timing.review.agent,
          ...(timing.review.model ? { model: timing.review.model } : {}),
          ...(timing.review.effort ? { effort: timing.review.effort } : {}),
          ...(bucket ? { bucket } : {}),
          seconds: timing.review.seconds,
          jobId: `${jobId}.review`,
          madeAt: at,
        });
      }
    } catch (error) {
      console.warn(`Job ${jobId}: its making time was not kept: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadSources(input: OutputJobInput, provider: StructuredProvider): Promise<NodeSource[]> {
    const loaded: NodeSource[] = [];
    for (const use of input.sources) {
      const source = await this.options.repos.sources.get(use.sourceId);
      if (!source) throw new JobFailure(`Source ${use.sourceId} does not exist.`, false, "source_missing");
      try {
        const extracted = await this.options.sources.ensureExtracted(source, {
          provider,
          ...(input.contextText ? { contextText: input.contextText } : {}),
        });
        loaded.push({
          sourceId: source.id,
          title: extracted.source.title,
          envelope: extracted.envelope,
          chunks: extracted.chunks,
          ...(use.range ? { range: use.range } : {}),
          ...(source.filePath ? { path: source.filePath } : {}),
        });
      } catch (error) {
        // A missing upload will not appear on retry; anything else (a busy or
        // failed extraction) might.
        if (error instanceof SourceInputError) throw new JobFailure(error.message, false, "source_missing");
        throw error;
      }
    }
    return loaded;
  }
}

/**
 * Where a project's finished files are copied: its linked folder, else `<library>/<its folder name>`, the name kept
 * from the first time so renaming the project never renames the folder. Undefined when this computer cannot say.
 */
export async function libraryFolderOf(repos: StudioRepositories, files: LocalFiles, project: Project): Promise<string | undefined> {
  if (project.folder) return project.folder;
  try {
    const library = await files.library();
    const name = (await repos.projects.keepLibraryName(project.id, folderName(project.title))) ?? folderName(project.title);
    return joinPath(library.folder, name);
  } catch (error) {
    console.warn(`Project ${project.id}: where its finished files go could not be found: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Where a finished job keeps what its maker kept to find its work again (`EngineOutput.keep`). */
export const KEPT_KEY = "kept";

/** Where a job keeps what it is doing now in plain words (`state.step`), when its engine says. */
export const STEP_KEY = "step";
/** When the engine expects this attempt to be done (`EngineProgress.doneBy`), with the attempt it was said in. */
export const DONE_BY_KEY = "doneBy";
const MAX_STEP_CHARS = 160;

/** Where a job keeps what each validation found (`state.validation`). */
export const VALIDATION_KEY = "validation";
const MAX_VALIDATION_ENTRIES = 12;
const MAX_LISTED_ISSUES = 20;

/**
 * One validation of one output, as kept on the job: round 0 is the first
 * output, round n the output after n repair rounds. `codes` counts every
 * error by code, so repair rates (`bit_over_budget`, `quote_not_in_passage`)
 * can be measured across jobs; `issues` lists the first few with their paths.
 */
export function validationEntry(report: ValidationReport, round: number, attempt: number): JsonValue {
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const codes: Record<string, number> = {};
  for (const issue of errors) codes[issue.code] = (codes[issue.code] ?? 0) + 1;
  return {
    attempt,
    round,
    valid: report.valid,
    errors: errors.length,
    warnings: report.issues.length - errors.length,
    codes,
    issues: errors.slice(0, MAX_LISTED_ISSUES).map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })),
  };
}

function validationLog(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** Where a job keeps its finished pieces of work (`state.checkpoints`). */
export const CHECKPOINTS_KEY = "checkpoints";

/**
 * An engine checkpoint on the job's state: what earlier attempts saved is
 * read once, at the start of this attempt, and each piece this attempt
 * finishes is written at once, so a retry never pays for it again.
 */
export function jobCheckpoint(run: JobRun): EngineCheckpoint {
  const stored = run.job.state[CHECKPOINTS_KEY];
  const entries = new Map<string, JsonValue>(isRecord(stored) ? Object.entries(stored as Record<string, JsonValue>) : []);
  return {
    get: (key) => entries.get(key),
    put: async (key, value) => {
      entries.set(key, value);
      await run.saveStateEntry(CHECKPOINTS_KEY, key, value);
    },
  };
}

/** The job's failure message for an output still invalid after its last repair round. */
export function summarizeReport(report: ValidationReport, repairRounds: number): string {
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const listed = errors.slice(0, REPORTED_ISSUES).map((issue) => `${issue.path}: ${issue.message} (${issue.code})`);
  const more = errors.length > REPORTED_ISSUES ? `; and ${errors.length - REPORTED_ISSUES} more` : "";
  const rounds = `${repairRounds} repair round${repairRounds === 1 ? "" : "s"}`;
  return `Output failed validation after ${rounds}: ${listed.join("; ")}${more}`;
}

/** Validates an output job's input; returns a reason string when it is unusable. */
export function parseOutputJobInput(raw: JsonObject): OutputJobInput | string {
  const sources = raw.sources;
  // Empty is allowed: a fix item's input can be another item's result. The
  // engine decides whether it can work without files.
  if (!Array.isArray(sources)) return "sources must be an array";
  const uses: OutputJobInput["sources"] = [];
  for (const entry of sources) {
    if (!isRecord(entry) || typeof entry.sourceId !== "string" || !entry.sourceId) return "each source needs a sourceId";
    if (entry.range !== undefined && !isRecord(entry.range)) return "a source range must be an object";
    uses.push({ sourceId: entry.sourceId, ...(entry.range ? { range: entry.range as SourceLocator } : {}) });
  }
  const optionalString = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  return {
    sources: uses,
    ...(optionalString("title") !== undefined ? { title: optionalString("title") } : {}),
    ...(optionalString("prompt") !== undefined ? { prompt: optionalString("prompt") } : {}),
    ...(optionalString("contextText") !== undefined ? { contextText: optionalString("contextText") } : {}),
    ...(raw.settings !== undefined ? { settings: raw.settings } : {}),
    ...(Array.isArray(raw.assumes) ? { assumes: raw.assumes as unknown as PriorOutput[] } : {}),
    ...(Array.isArray(raw.inputs) ? { inputs: raw.inputs as unknown as NodeInput[] } : {}),
    ...(typeof raw.budgetUSD === "number" ? { budgetUSD: raw.budgetUSD } : {}),
    ...(readRemakeOf(raw.remakeOf) ? { remakeOf: readRemakeOf(raw.remakeOf)! } : {}),
  };
}

/** A job's `remakeOf`, when it is one: the output and its scene, with the note and what made it when given. */
function readRemakeOf(raw: unknown): SceneRemakeOf | undefined {
  if (!isRecord(raw) || typeof raw.outputId !== "string" || !raw.outputId || typeof raw.scene !== "string" || !raw.scene) return undefined;
  return {
    outputId: raw.outputId,
    scene: raw.scene,
    ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note } : {}),
    ...(typeof raw.madeBy === "string" && raw.madeBy ? { madeBy: raw.madeBy } : {}),
    ...(isRecord(raw.kept) ? { kept: raw.kept as Record<string, JsonValue> } : {}),
  };
}

/** Stands in when no provider key is configured; a format that needs no model still runs. */
const missingProvider: StructuredProvider = {
  name: "none",
  async generateJSON() {
    throw new JobFailure("No generation provider is configured on this engine.", false, "no_provider");
  },
};

/** A job's `settlePick`: a turn that names no agent gets one, or the job fails saying what to do. */
function settlePickFor(settle: NonNullable<OutputRunnerOptions["settlePick"]>, ownerId: string): (scope: string, pick: TurnPick) => Promise<TurnPick> {
  return async (scope, pick) => {
    let settled: TurnPick | undefined;
    try {
      settled = await settle(ownerId, scope, pick);
    } catch (error) {
      if (error instanceof PickNeededError) throw new JobFailure(error.message, false, "pick_needed");
      throw error;
    }
    if (!settled) throw new JobFailure("None of your providers can make it. Add or turn one on in Settings, under Providers.", false, "no_agent");
    return settled;
  };
}
