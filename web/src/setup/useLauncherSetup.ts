import { useEffect, useRef, useState } from "react";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { launcherSetup, type AgentSetup, type LauncherSetup } from "./api";

/** How often an install or a sign-in the launcher runs is asked about. */
export const SETUP_POLL_MS = 2000;

/** What the launcher's setup buttons can do on this computer, and each button, as one agent row reads them (`./AgentFix.tsx`). */
export interface Launcher {
  data?: LauncherSetup;
  /** The launcher can't be asked (the web app was started without it): the rows say how to do it by hand. */
  off: boolean;
  of(id: string): AgentSetup | undefined;
  reload(): Promise<void>;
  /** Runs one button's call and asks the launcher again; what went wrong is in `error`. */
  act(call: () => Promise<unknown>): Promise<void>;
  error?: unknown;
}

/**
 * The launcher's setup, asked again while an install or a sign-in it runs is going. When an agent's install or
 * sign-in finishes, `onFinished` is called with which, so the screen looks for the agents anew.
 */
export function useLauncherSetup(onFinished?: (done: { installed: string[]; signedIn: string[] }) => void): Launcher {
  const client = useApi();
  const loaded = useLoad(() => launcherSetup(client), [client]);
  const [error, setError] = useState<unknown>();
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  });

  const before = useRef<LauncherSetup | undefined>(undefined);
  useEffect(() => {
    const now = loaded.data;
    const was = before.current;
    before.current = now;
    if (!now) return;
    const doneNow = (pick: (a: AgentSetup) => string) =>
      now.agents.filter((a) => pick(a) === "done" && was?.agents.some((b) => b.id === a.id && pick(b) !== "done")).map((a) => a.id);
    const installed = doneNow((a) => a.install.state);
    const signedIn = doneNow((a) => a.signIn.state);
    if (installed.length || signedIn.length) finished.current?.({ installed, signedIn });
    const going = now.agents.some((a) => a.install.state === "installing" || a.signIn.state === "signingIn") || now.ffmpeg.fetch.state === "installing";
    if (!going) return;
    const timer = setTimeout(() => void loaded.reload(), SETUP_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.data]);

  return {
    ...(loaded.data ? { data: loaded.data } : {}),
    off: loaded.error !== undefined && !loaded.data,
    of: (id) => loaded.data?.agents.find((a) => a.id === id),
    reload: () => loaded.reload(),
    async act(call) {
      setError(undefined);
      try {
        await call();
        await loaded.reload();
      } catch (e) {
        setError(e);
      }
    },
    ...(error !== undefined ? { error } : {}),
  };
}
