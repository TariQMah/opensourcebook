import { useEffect, useId, useRef, useState } from "react";
import { errorText, isApiError } from "../api/errors";
import type { VoiceOption, VoiceServiceView, VoiceSetup as Setup } from "../api/types";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { Icon } from "../design/Icon";
import { Segmented } from "../design/ui";
import { serviceReady as ready } from "./ready";
import { SAMPLE_FAILED, useSample } from "./useSample";
import "./voice.css";

export interface VoiceSetupProps {
  /** Called once a voice service is in use with its voice: the setup is done. */
  onDone?(): void;
  /** Tighter, for first-time setup: no closing line, and nothing shown until a service is picked. */
  compact?: boolean;
  /** The service to open on, when a link asks for one; the one in use otherwise. */
  start?: string;
}

/**
 * The voice that speaks videos and audio (engine/docs/api.md, "Voice"): the
 * services the engine lists, a key for one that needs it, the voices of the
 * person's own account with a sample of each, and for one that runs on this
 * computer the command that installs it. A key is typed once and sent once;
 * the engine only ever answers whether one is set and its last four
 * characters, and that is all this shows of it.
 */
export function VoiceSetup({ onDone, compact = false, start }: VoiceSetupProps) {
  const client = useApi();
  const setup = useLoad(() => client.voice(), [client]);
  const [tab, setTab] = useState<string | undefined>(start);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const s = setup.data;
  if (!s) {
    const off = isApiError(setup.error, "voice_unavailable");
    return (
      <div className="vs">
        <div className="vs-card">
          <p className="vs-d" role="status">
            {setup.loading
              ? "Checking…"
              : off
                ? "The voice is kept by the scenes service, which isn't running. Start Open Sourcebook again, then check again."
                : errorText(setup.error)}
          </p>
          {!setup.loading && (
            <button className="mini" type="button" onClick={() => void setup.reload()}>
              <Icon name="retry" />
              Check again
            </button>
          )}
        </div>
      </div>
    );
  }

  const shownId = (tab && s.services.some((x) => x.id === tab) ? tab : undefined) ?? s.service ?? (compact ? undefined : s.services[0]?.id);
  const service = s.services.find((x) => x.id === shownId);
  const local = s.services.find((x) => x.where === "local");

  async function act(call: () => Promise<Setup>, done = false) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await call();
      setup.set(next);
      if (done && next.service) onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  /** One service's view after a key change, laid into the setup. */
  function replaceService(view: VoiceServiceView) {
    if (!s) return;
    setup.set({ ...s, services: s.services.map((x) => (x.id === view.id ? view : x)) });
  }

  return (
    <div className={`vs${compact ? " compact" : ""}`}>
      <div className="vs-card">
        {!compact && <span className="vs-lbl">Where the voice comes from</span>}
        <Segmented
          label="Where the voice comes from"
          options={s.services.map((x) => ({ value: x.id, label: x.label }))}
          value={shownId ?? ""}
          onChange={(id) => {
            setTab(id);
            setError(undefined);
          }}
        />
        {!service ? (
          <p className="vs-d">Pick one to see what it needs.</p>
        ) : service.where === "local" ? (
          <LocalSetup service={service} checking={setup.loading} onCheck={() => void setup.reload()} />
        ) : service.needsKey ? (
          <KeyField
            key={service.id}
            service={service}
            onSaved={replaceService}
            onCleared={(next) => setup.set(next)}
            onError={setError}
          />
        ) : (
          <p className="vs-d">{service.about}</p>
        )}
        {s.note && <p className="vs-d">{s.note}</p>}
        {error !== undefined && (
          <p className="vs-err" role="alert">
            {errorText(error)}
          </p>
        )}
      </div>

      {service && ready(service) && (
        <Voices
          key={service.id}
          service={service}
          setup={s}
          busy={busy}
          onPick={(voice) => void act(() => client.setVoice({ service: service.id, voice }), true)}
        />
      )}

      {!compact && (
        <p className="vs-foot">
          The voice list comes from your own account.
          {local ? ` "${local.label}" needs no key; it is set up once from here.` : ""}
        </p>
      )}
    </div>
  );
}

/**
 * The key of a service that needs one. A password field, cleared once sent;
 * a key already kept shows only that it is set and its last four characters.
 */
function KeyField({
  service: s,
  onSaved,
  onCleared,
  onError,
}: {
  service: VoiceServiceView;
  onSaved: (view: VoiceServiceView) => void;
  onCleared: (setup: Setup) => void;
  onError: (e: unknown) => void;
}) {
  const client = useApi();
  const field = useId();
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  // The engine's own words ("Your ElevenLabs key"), once.
  const name = s.keyLabel ?? `Your ${s.label} key`;

  async function save() {
    const typed = key.trim();
    if (!typed) return;
    setBusy(true);
    onError(undefined);
    try {
      const view = await client.setVoiceKey(s.id, typed);
      setKey("");
      setReplacing(false);
      onSaved(view);
    } catch (e) {
      // A refused key is not kept; the field is emptied so it is not left on screen either.
      setKey("");
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    onError(undefined);
    try {
      onCleared(await client.clearVoiceKey(s.id));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  if (s.keySet && !replacing) {
    return (
      <div className="vs-key">
        <span className="vs-lbl">{name}</span>
        <div className="vs-keyset">
          <span>
            Set{s.keyHint ? <>, ending in <code>{s.keyHint}</code></> : ""}
          </span>
          <button className="mini" type="button" disabled={busy} onClick={() => setReplacing(true)}>
            Replace key
          </button>
          <button className="mini" type="button" disabled={busy} onClick={() => void clear()}>
            Remove key
          </button>
        </div>
        <KeyNote service={s} />
      </div>
    );
  }
  return (
    <form
      className="vs-key"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="vs-lbl" htmlFor={field}>
        {name}
      </label>
      <div className="vs-keyrow">
        <input
          id={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your key"
          value={key}
          maxLength={400}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="btn soft" type="submit" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Save and check"}
        </button>
        {replacing && (
          <button className="btn ghost" type="button" disabled={busy} onClick={() => (setKey(""), setReplacing(false))}>
            Cancel
          </button>
        )}
      </div>
      <KeyNote service={s} />
    </form>
  );
}

function KeyNote({ service: s }: { service: VoiceServiceView }) {
  return (
    <p className="vs-d">
      Kept on this computer only, in the scenes service's settings.
      {s.keyHelpUrl && (
        <>
          {" "}
          <a href={s.keyHelpUrl} target="_blank" rel="noreferrer">
            Where to get a key
          </a>
        </>
      )}
    </p>
  );
}

/** How often the screen asks how an install is going. */
const INSTALL_POLL_MS = 3000;

/**
 * A voice that runs on this computer: installed or not. If not, a button that has the launcher install it with the
 * Node Open Sourcebook came with (cli/voice.ts), and the command that does the same in a terminal, run once.
 */
function LocalSetup({ service: s, checking, onCheck }: { service: VoiceServiceView; checking: boolean; onCheck: () => void }) {
  const client = useApi();
  const [install, setInstall] = useState<{ state: "idle" | "installing" | "failed"; message?: string }>({ state: "idle" });
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  if (s.installed) return <p className="vs-d">{s.about}</p>;

  async function follow(): Promise<void> {
    for (;;) {
      if (!alive.current) return;
      const now = await client.voiceInstall(s.id);
      if (now.state === "installing") {
        await new Promise((done) => setTimeout(done, INSTALL_POLL_MS));
        continue;
      }
      if (now.state === "done") {
        setInstall({ state: "idle" });
        onCheck();
      } else setInstall({ state: "failed", message: now.state === "failed" ? now.message : "It stopped before it finished. Press Install again." });
      return;
    }
  }
  async function start() {
    setInstall({ state: "installing" });
    try {
      const started = await client.installVoice(s.id);
      if (started.state === "failed") setInstall({ state: "failed", message: started.message });
      else await follow();
    } catch (e) {
      if (alive.current) setInstall({ state: "failed", message: errorText(e) });
    }
  }

  const installing = install.state === "installing";
  return (
    <div className="vs-local">
      <p className="vs-d">
        {s.about} It isn't installed yet.
      </p>
      <div className="vs-install">
        <button className="mini go" type="button" disabled={installing || checking} onClick={() => void start()}>
          {installing ? "Installing…" : "Install it"}
        </button>
        {installing && (
          <span className="vs-d" role="status">
            This downloads a few hundred MB once and can take several minutes. You can keep using Open Sourcebook meanwhile.
          </span>
        )}
      </div>
      {install.state === "failed" && (
        <p className="vs-err" role="alert">
          {install.message}
        </p>
      )}
      {s.install && (
        <>
          <p className="vs-d">Or run this once in a terminal{s.install.folder ? <>, in <code>{s.install.folder}</code></> : ""}, then check again:</p>
          <div className="vs-cmd">
            <code>{s.install.command}</code>
            <button className="mini" type="button" onClick={() => void navigator.clipboard?.writeText(s.install!.command)}>
              <Icon name="copy" />
              Copy
            </button>
          </div>
        </>
      )}
      <button className="mini" type="button" disabled={checking || installing} onClick={onCheck}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/** The voices a ready service offers, each with a sample to play and Pick. */
function Voices({ service: s, setup, busy, onPick }: { service: VoiceServiceView; setup: Setup; busy: boolean; onPick: (voiceId: string | null) => void }) {
  const client = useApi();
  const voices = useLoad(async (): Promise<VoiceOption[]> => (s.listsVoices ? client.voiceOptions(s.id) : []), [client, s.id, s.keySet, s.installed]);
  const inUse = setup.service === s.id;
  const health = s.health;
  const { playing, failed, play } = useSample(s.id);

  return (
    <section className="vs-card vs-voices" aria-label="Pick a voice">
      <div className="vs-vh">
        <b>Pick a voice</b>
        {health &&
          (health.ok ? (
            <span className="vs-ok">
              <span className="dot" aria-hidden="true" />
              {s.where === "hosted" ? "Key works" : "Works"}
            </span>
          ) : (
            <span className="vs-warn">
              <span className="dot" aria-hidden="true" />
              {health.message}
            </span>
          ))}
      </div>
      {!s.listsVoices ? (
        <div className="vs-row">
          <span className="vs-who">
            <b>{s.label}</b>
            <span>{s.about}</span>
          </span>
          {inUse ? (
            <span className="mini on">In use</span>
          ) : (
            <button className="mini" type="button" disabled={busy} onClick={() => onPick(null)}>
              Use {s.label}
            </button>
          )}
        </div>
      ) : voices.data === undefined ? (
        <p className="vs-d vs-pad" role="status">
          {voices.error !== undefined ? errorText(voices.error) : "Asking for your voices…"}
        </p>
      ) : voices.data.length === 0 ? (
        <p className="vs-d vs-pad">{s.label} lists no voices for this account.</p>
      ) : (
        <ul className="vs-list" aria-label={`${s.label} voices`}>
          {voices.data.map((v) => {
            const picked = inUse && setup.voice?.id === v.id;
            const about = [v.description, v.language].filter(Boolean).join(" · ");
            return (
              <li key={v.id} className={picked ? "on" : ""}>
                {s.samples && v.sample ? (
                  <button type="button" className="ib vs-play" aria-label={`${playing === v.id ? "Stop" : "Play"} ${v.label}`} aria-pressed={playing === v.id} onClick={() => play(v.id)}>
                    <Icon name={playing === v.id ? "pause" : "play"} />
                  </button>
                ) : (
                  <span className="vs-play" aria-hidden="true" />
                )}
                <span className="vs-who">
                  <b>{v.label}</b>
                  {about && <span>{about}</span>}
                  {failed === v.id && (
                    <span className="vs-fail" role="status">
                      {SAMPLE_FAILED}
                    </span>
                  )}
                </span>
                {picked ? (
                  <span className="mini on">Picked</span>
                ) : (
                  <button className="mini" type="button" disabled={busy} aria-label={`Pick ${v.label}`} onClick={() => onPick(v.id)}>
                    Pick
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
