/** Typed repositories over the Studio tables (migrations/0004_studio.sql, 0005). */
import type { D1DatabaseLike } from "../../types/bindings";
import { AgentTurnRepository } from "./agent-turns";
import { ProjectGroupRepository } from "./groups";
import { MakeTimeRepository } from "./make-times";
import { OutputRepository } from "./outputs";
import { PlanRepository } from "./plans";
import { ProjectRepository } from "./projects";
import { ProviderSettingsRepository } from "./provider-settings";
import { ItemResultRepository } from "./results";
import { repositoryContext, type RepositoryOptions } from "./shared";
import { SessionRepository } from "./sessions";
import { SourceRepository } from "./sources";
import { UsageRepository } from "./usage";
import { OwnerSettingsRepository } from "./owner-settings";

export interface StudioRepositories {
  projects: ProjectRepository;
  groups: ProjectGroupRepository;
  sources: SourceRepository;
  sessions: SessionRepository;
  plans: PlanRepository;
  outputs: OutputRepository;
  usage: UsageRepository;
  results: ItemResultRepository;
  agentTurns: AgentTurnRepository;
  providerSettings: ProviderSettingsRepository;
  makeTimes: MakeTimeRepository;
  ownerSettings: OwnerSettingsRepository;
}

export function createStudioRepositories(db: D1DatabaseLike, options: RepositoryOptions = {}): StudioRepositories {
  const ctx = repositoryContext(db, options);
  return {
    projects: new ProjectRepository(ctx),
    groups: new ProjectGroupRepository(ctx),
    sources: new SourceRepository(ctx),
    sessions: new SessionRepository(ctx),
    plans: new PlanRepository(ctx),
    outputs: new OutputRepository(ctx),
    usage: new UsageRepository(ctx),
    results: new ItemResultRepository(ctx),
    agentTurns: new AgentTurnRepository(ctx),
    providerSettings: new ProviderSettingsRepository(ctx),
    makeTimes: new MakeTimeRepository(ctx),
    ownerSettings: new OwnerSettingsRepository(ctx),
  };
}

export * from "./agent-turns";
export * from "./groups";
export * from "./make-times";
export * from "./outputs";
export * from "./plans";
export * from "./projects";
export * from "./provider-settings";
export * from "./results";
export * from "./sessions";
export * from "./sources";
export * from "./usage";
export * from "./owner-settings";
export { InvalidRecordError, type RepositoryOptions } from "./shared";
