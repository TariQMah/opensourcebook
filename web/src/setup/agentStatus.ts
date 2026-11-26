import type { Provider } from "../api/types";
import type { AgentSetup } from "./api";

/** In plain words, where the agent stands on this computer: found and signed in, not signed in, its app but not its program, or not found. */
export function agentStatus(p: Provider, a?: AgentSetup): string {
  if (p.state === "ready") return "Found on this computer, signed in";
  if (p.state === "signedOut") return "Found on this computer · not signed in yet";
  if (p.state === "missing") return a?.appFound ? `${a.appFound} app found; Open Sourcebook needs its command-line part` : "Not found on this computer";
  return p.headline;
}
