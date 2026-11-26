import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorText } from "../api/errors";
import type { Provider, VoiceServiceView } from "../api/types";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { VoiceSetup } from "../voice/VoiceSetup";
import { fetchFfmpeg, installAgent, launcherSetup, signInAgent, type AgentSetup, type LauncherSetup } from "./api";
import "./setup.css";

/** How often the list asks how an install or a sign-in is going. */
export const SETUP_POLL_MS = 2000;

/** Installed: the agent's program is on this computer, signed in or not. */
const installed = (p: Provider) => p.state === "ready" || p.state === "signedOut" || p.state === "unavailable";

/** "A", "A and B", "A, B and C". */
function listed(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function Row({ ok, title, said, children }: { ok: boolean | undefined; title: string; said: ReactNode; children?: ReactNode }) {
  return (
    <li className={`gs-row ${ok ? "ok" : ok === false ? "todo" : "unknown"}`}>
      <span className="gs-mark" aria-hidden="true">
        <Icon name={ok ? "check" : ok === false ? "alert" : "dot"} />
      </span>
      <span className="gs-who">
        <b>
          {title}
          <span className="sr-only">{ok ? " (done)" : ok === false ? " (to do)" : ""}</span>
        </b>
        <span>{said}</span>
      </span>
      {children && <span className="gs-fix">{children}</span>}
    </li>
  );
}

/**
 * Get set up: one list of what this computer needs to make a video with a voice (a coding agent, signed in, ffmpeg and
 * a voice), each with what is wrong in plain words and the one button that fixes it, and Check again, which asks
 * everything again (the connector looks for each agent anew). The buttons are the launcher's (`./api.ts`); the agents,
 * how each installs and signs in, and the voices all come from their own lists, none named here. A sign-in is the
 * agent's own, in the browser: this only starts it and watches for the agent to say it is signed in.
 */
export function GetSetUp({ onReady }: { onReady?: (ready: boolean) => void }) {
  const client = useApi();
  const providers = useLoad(() => client.providers({ fresh: true }), [client]);
  const launcher = useLoad(() => launcherSetup(client), [client]);
  const voice = useLoad(() => client.voice(), [client]);
  const [error, setError] = useState<unknown>();
  const [checking, setChecking] = useState(false);
  const [voiceJob, setVoiceJob] = useState<{ state: "idle" | "working" | "failed"; message?: string }>({ state: "idle" });
  const [keyFor, setKeyFor] = useState<string>();
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const list = providers.data?.providers ?? [];
  const here = list.filter(installed);
  const ready = list.filter((p) => p.state === "ready");
  const signedOut = list.filter((p) => p.state === "signedOut");
  const agents = launcher.data?.agents ?? [];
  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const isReady = ready.length > 0;

  useEffect(() => onReady?.(isReady), [isReady, onReady]);

  // While the launcher installs or signs in, it is asked again; what finished is then looked for anew.
  const before = useRef<LauncherSetup | undefined>(undefined);
  useEffect(() => {
    const now = launcher.data;
    const was = before.current;
    before.current = now;
    if (!now) return;
    const finished = (pick: (a: AgentSetup) => string) => now.agents.filter((a) => pick(a) === "done" && was?.agents.some((b) => b.id === a.id && pick(b) !== "done"));
    const installedNow = finished((a) => a.install.state);
    const signedInNow = finished((a) => a.signIn.state);
    if (installedNow.length || signedInNow.length) {
      void (async () => {
        // An agent the person signed in to with its button is the one they want: it is connected at once.
        for (const a of signedInNow) {
          const p = list.find((x) => x.id === a.id);
          if (p && !(p.added && p.enabled)) await client.updateProvider(a.id, { added: true, enabled: true }).catch(() => undefined);
        }
        if (alive.current) await providers.reload();
      })();
    }
    const going = now.agents.some((a) => a.install.state === "installing" || a.signIn.state === "signingIn") || now.ffmpeg.fetch.state === "installing";
    if (!going) return;
    const timer = setTimeout(() => void launcher.reload(), SETUP_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launcher.data]);

  async function act(call: () => Promise<unknown>) {
    setError(undefined);
    try {
      await call();
      await launcher.reload();
    } catch (e) {
      setError(e);
    }
  }

  async function checkAgain() {
    setChecking(true);
    setError(undefined);
    await Promise.all([providers.reload(), launcher.reload(), voice.reload()]);
    if (alive.current) setChecking(false);
  }

  const v = voice.data;
  const local = v?.services.find((s) => s.where === "local" && (s.installed !== undefined || s.install));
  const guided = v?.services.filter((s) => s.where === "hosted" && s.needsKey && s.keySteps?.length) ?? [];
  const inUse = v?.services.find((s) => s.id === v.service);

  async function freeVoice(service: VoiceServiceView) {
    setVoiceJob({ state: "working" });
    try {
      if (!service.installed) {
        let now = await client.installVoice(service.id);
        while (now.state === "installing") {
          await new Promise((done) => setTimeout(done, SETUP_POLL_MS));
          if (!alive.current) return;
          now = await client.voiceInstall(service.id);
        }
        if (now.state === "failed") throw new Error(now.message);
        if (now.state !== "done") throw new Error("It stopped before it finished. Press the button again.");
      }
      // The person asked for this voice: it is the one videos and audio speak with from now on.
      voice.set(await client.setVoice({ service: service.id, voice: null }));
      if (alive.current) setVoiceJob({ state: "idle" });
    } catch (e) {
      if (alive.current) setVoiceJob({ state: "failed", message: errorText(e) });
    }
  }

  const launcherOff = launcher.error !== undefined && !launcher.data;
  const installButtons = agents.filter((a) => a.canInstall);

  return (
    <div className="gs">
      <ul className="gs-list" aria-label="What this computer needs">
        <Row
          ok={providers.data ? here.length > 0 : undefined}
          title="A coding agent"
          said={
            !providers.data
              ? providers.error !== undefined
                ? errorText(providers.error)
                : "Looking for agents on this computer…"
              : here.length
                ? `${listed(here.map((p) => p.label))} ${here.length === 1 ? "is" : "are"} installed.`
                : "None is installed yet. It is what makes your videos and answers your chats, on your own plan."
          }
        >
          {providers.data && !here.length && (
            <>
              {installButtons.map((a) =>
                a.install.state === "installing" ? (
                  <span key={a.id} className="gs-note" role="status">
                    Installing {a.label}… this can take a few minutes.
                  </span>
                ) : (
                  <PrimaryButton key={a.id} onClick={() => void act(() => installAgent(client, a.id))} disabled={installButtons.some((b) => b.install.state === "installing")}>
                    Install {a.label}
                  </PrimaryButton>
                ),
              )}
              {installButtons.map((a) =>
                a.install.state === "failed" ? (
                  <span key={`${a.id}-failed`} className="gs-err" role="alert">
                    {a.install.message}
                  </span>
                ) : a.install.state === "done" && !here.some((p) => p.id === a.id) ? (
                  <span key={`${a.id}-done`} className="gs-note">
                    {a.label} is installed. Press Check again if it is not found yet.
                  </span>
                ) : null,
              )}
              {launcherOff && (
                <span className="gs-note">
                  Install one from its own page:{" "}
                  {list
                    .filter((p) => p.install?.url)
                    .map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && ", "}
                        <a href={p.install!.url} target="_blank" rel="noreferrer">
                          {p.label}
                        </a>
                      </span>
                    ))}
                  .
                </span>
              )}
            </>
          )}
        </Row>

        <Row
          ok={providers.data ? isReady : undefined}
          title="Signed in"
          said={
            !providers.data
              ? "…"
              : isReady
                ? `${listed(ready.map((p) => p.label))} ${ready.length === 1 ? "is" : "are"} signed in.`
                : signedOut.length
                  ? `${listed(signedOut.map((p) => p.label))} ${signedOut.length === 1 ? "is" : "are"} installed but not signed in.`
                  : "Install an agent first, then sign in to it here."
          }
        >
          {providers.data &&
            !isReady &&
            signedOut.map((p) => {
              const a = agentOf(p.id);
              if (!a?.canSignIn)
                return p.signIn ? (
                  <span key={p.id} className="gs-note">
                    Sign in to {p.label} once in a terminal: <code>{p.signIn}</code>
                  </span>
                ) : null;
              if (a.signIn.state === "signingIn")
                return (
                  <span key={p.id} className="gs-note" role="status">
                    Finish signing in to {p.label} in your browser.
                    {a.signIn.url && (
                      <>
                        {" "}
                        If it did not open,{" "}
                        <a href={a.signIn.url} target="_blank" rel="noreferrer">
                          open the sign-in page
                        </a>
                        .
                      </>
                    )}
                  </span>
                );
              return (
                <span key={p.id} className="gs-fixone">
                  <PrimaryButton onClick={() => void act(() => signInAgent(client, p.id))}>{a.signIn.state === "failed" ? `Sign in to ${p.label} again` : `Sign in to ${p.label}`}</PrimaryButton>
                  {a.signIn.state === "failed" && (
                    <span className="gs-err" role="alert">
                      {a.signIn.message}
                    </span>
                  )}
                </span>
              );
            })}
        </Row>

        <Row
          ok={launcher.data ? launcher.data.ffmpeg.found : undefined}
          title="ffmpeg"
          said={
            !launcher.data
              ? launcherOff
                ? "Can't be checked from this page."
                : "…"
              : launcher.data.ffmpeg.found
                ? "Here. It puts the pictures and the voice of a video together."
                : "Missing, so videos and audio can't be made."
          }
        >
          {launcher.data && !launcher.data.ffmpeg.found && (
            <>
              {launcher.data.ffmpeg.fetch.state === "installing" ? (
                <span className="gs-note" role="status">
                  Getting ffmpeg…
                </span>
              ) : (
                <PrimaryButton onClick={() => void act(() => fetchFfmpeg(client))}>Get ffmpeg</PrimaryButton>
              )}
              {launcher.data.ffmpeg.fetch.state === "failed" && (
                <span className="gs-err" role="alert">
                  {launcher.data.ffmpeg.fetch.message}
                </span>
              )}
            </>
          )}
        </Row>

        <Row
          ok={v ? !!v.service : undefined}
          title="A voice"
          said={!v ? (voice.error !== undefined ? errorText(voice.error) : "…") : inUse ? `Videos and audio have a voice: ${inUse.label}${v.voice ? `, ${v.voice.label}` : ""}.` : "None yet: videos have captions and no sound, and audio can't be made."}
        >
          {v && !v.service && (
            <>
              {local &&
                (voiceJob.state === "working" ? (
                  <span className="gs-note" role="status">
                    Setting up the free voice… the first time it downloads a few hundred MB, which can take several minutes.
                  </span>
                ) : (
                  <PrimaryButton onClick={() => void freeVoice(local)}>Set up the free voice</PrimaryButton>
                ))}
              {voiceJob.state === "failed" && (
                <span className="gs-err" role="alert">
                  {voiceJob.message}
                </span>
              )}
              {guided.map((s) => (
                <OutlineButton key={s.id} aria-expanded={keyFor === s.id} onClick={() => setKeyFor(keyFor === s.id ? undefined : s.id)}>
                  Use your {s.label} key instead
                </OutlineButton>
              ))}
            </>
          )}
        </Row>
      </ul>
      {keyFor && v && !v.service && (
        <div className="gs-key">
          <VoiceSetup compact start={keyFor} onDone={() => void voice.reload()} />
        </div>
      )}
      {error !== undefined && (
        <p className="gs-err gs-pad" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="gs-foot">
        <OutlineButton onClick={() => void checkAgain()} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </OutlineButton>
      </div>
    </div>
  );
}
