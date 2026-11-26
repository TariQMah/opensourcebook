import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorText } from "../api/errors";
import type { Provider, VoiceInstallState, VoiceServiceView } from "../api/types";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { VoiceInstallProgress } from "../voice/InstallProgress";
import { VoiceSetup } from "../voice/VoiceSetup";
import { ProviderMark } from "../design/ProviderMark";
import { byName } from "../firstrun/rules";
import { AgentFixRow } from "./AgentFix";
import { fetchFfmpeg } from "./api";
import { SETUP_POLL_MS, useLauncherSetup } from "./useLauncherSetup";
import "./setup.css";


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
 * agent's own, in the browser: this only starts it and watches for the agent to say it is signed in. Each agent is a
 * row of its own with its button (`./AgentFix.tsx`), the same rows the Connect step and Settings › Providers show.
 */
export function GetSetUp({ onReady }: { onReady?: (ready: boolean) => void }) {
  const client = useApi();
  const providers = useLoad(() => client.providers({ fresh: true }), [client]);
  // An agent the person signed in to with its button is the one they want: it is connected at once.
  const launcher = useLauncherSetup(({ signedIn }) => {
    void (async () => {
      for (const id of signedIn) {
        const p = providers.data?.providers.find((x) => x.id === id);
        if (p && !(p.added && p.enabled)) await client.updateProvider(id, { added: true, enabled: true }).catch(() => undefined);
      }
      if (alive.current) await providers.reload();
    })();
  });
  const voice = useLoad(() => client.voice(), [client]);
  const [checking, setChecking] = useState(false);
  const [voiceJob, setVoiceJob] = useState<{ state: "idle" | "working" | "failed"; message?: string; now?: VoiceInstallState }>({ state: "idle" });
  const [keyFor, setKeyFor] = useState<string>();
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const list = providers.data?.providers ?? [];
  const here = list.filter(installed);
  const ready = list.filter((p) => p.state === "ready");
  const signedOut = list.filter((p) => p.state === "signedOut");
  const isReady = ready.length > 0;

  useEffect(() => onReady?.(isReady), [isReady, onReady]);

  async function checkAgain() {
    setChecking(true);
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
          if (alive.current) setVoiceJob({ state: "working", now });
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

  const launcherOff = launcher.off;
  const check = () => void checkAgain();
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
          {providers.data && list.length > 0 && (
            <ul className="ag-list gs-agents" aria-label="Coding agents">
              {byName(list).map((p) => (
                <AgentFixRow key={p.id} p={p} launcher={launcher} onCheck={check} checking={checking} checkHere={false} mark={<ProviderMark mark={p.mark} label={p.label} size={18} />} />
              ))}
            </ul>
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
                  ? `${listed(signedOut.map((p) => p.label))} ${signedOut.length === 1 ? "is" : "are"} installed but not signed in. Sign in with its button above.`
                  : "Install an agent first, then sign in to it above."
          }
        />

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
                <PrimaryButton onClick={() => void launcher.act(() => fetchFfmpeg(client))}>Get ffmpeg</PrimaryButton>
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
                  <VoiceInstallProgress now={voiceJob.now} />
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
      {launcher.error !== undefined && (
        <p className="gs-err gs-pad" role="alert">
          {errorText(launcher.error)}
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
