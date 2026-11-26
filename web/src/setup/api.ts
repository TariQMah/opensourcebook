/**
 * What Get set up asks the launcher on this computer (cli/setup.ts), through the proxy's `/api/launcher/...`, which
 * only this computer's browser may use: what its buttons can do, and each button.
 */
import type { ApiClient } from "../api/client";

/** How an install the launcher runs is going. */
export type JobState = { state: "idle" } | { state: "installing"; since: string } | { state: "done" } | { state: "failed"; message: string };

/** How an agent's own sign-in is going: with the address of its login page once the agent printed it. */
export type SignInState = { state: "idle" } | { state: "signingIn"; since: string; url?: string } | { state: "done" } | { state: "failed"; message: string };

export interface AgentSetup {
  id: string;
  label: string;
  /** A button can install it. */
  canInstall: boolean;
  /** A button can start its sign-in. */
  canSignIn: boolean;
  install: JobState;
  signIn: SignInState;
}

export interface LauncherSetup {
  agents: AgentSetup[];
  ffmpeg: { found: boolean; fetch: JobState };
}

const enc = encodeURIComponent;

export const launcherSetup = (client: ApiClient) => client.request<LauncherSetup>("GET", "/launcher/setup");
export const installAgent = (client: ApiClient, id: string) => client.request<JobState>("POST", `/launcher/agents/${enc(id)}/install`);
export const signInAgent = (client: ApiClient, id: string) => client.request<SignInState>("POST", `/launcher/agents/${enc(id)}/sign-in`);
export const fetchFfmpeg = (client: ApiClient) => client.request<JobState>("POST", "/launcher/tools/ffmpeg");
