import { useMemo, useState, type ReactNode } from "react";
import type { Provider, Providers } from "../api/types";
import { useApi } from "../app/context";
import { ErrorNotice } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { ProviderMark } from "../design/ProviderMark";
import { byName, isConnected } from "./rules";

/** The words under a name; the short ones (phone) are the part not marked long. */
function Status({ p }: { p: Provider }): ReactNode {
  if (p.state === "ready") {
    return (
      <>
        <span className="fr-long">Found on this computer, </span>
        <span className="fr-cap">signed in</span>
      </>
    );
  }
  if (p.state === "signedOut") {
    return (
      <>
        <span className="fr-long">Found on this computer · </span>
        <span className="fr-cap">not signed in yet</span>
      </>
    );
  }
  if (p.state === "missing") {
    return (
      <>
        Not found<span className="fr-long"> on this computer</span>
      </>
    );
  }
  return <>{p.headline}</>;
}

/** What to run to connect one the person has not installed, from the engine, with nothing assumed. */
function HowTo({ p, onCheck, checking, checked }: { p: Provider; onCheck: () => void; checking: boolean; checked: boolean }) {
  const steps: ReactNode[] = [];
  if (p.state !== "signedOut") {
    steps.push(
      p.install?.command ? (
        <>
          Install it: <code>{p.install.command}</code>
        </>
      ) : p.install?.url ? (
        <>
          Install it from{" "}
          <a href={p.install.url} target="_blank" rel="noreferrer">
            its own page
          </a>
        </>
      ) : (
        <>Install it on this computer.</>
      ),
    );
  }
  if (p.signIn) {
    steps.push(
      <>
        Sign in once in a terminal: <code>{p.signIn}</code>
      </>,
    );
  }
  steps.push(<>Come back here and press Check again.</>);
  return (
    <div className="fr-how" role="group" aria-label={`How to connect ${p.label}`}>
      <b>
        {p.state === "signedOut" ? `Sign in to ${p.label}` : `How to connect ${p.label}`}
      </b>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {checked && !checking && p.state === "missing" && (
        // Checked again and still not found: an install in a place it is not looked for is seen only after a restart.
        <p className="fr-restart" role="status">
          Still not found. If you just installed it, close Open Sourcebook and open it again from its shortcut, then come back here.
        </p>
      )}
      <OutlineButton onClick={onCheck} disabled={checking}>
        {checking ? "Checking…" : "Check again"}
      </OutlineButton>
    </div>
  );
}

/**
 * Step 1: the agents the engine lists, A to Z, each with Connect or how to
 * connect it. Nothing is picked for the person and none comes first.
 */
export function ProvidersStep({ onNext, onConnected }: { onNext: () => void; onConnected: (count: number) => void }) {
  const client = useApi();
  const loaded = useLoad(() => client.providers(), [client]);
  const [open, setOpen] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<unknown>();
  const data = loaded.data;
  const list = useMemo(() => byName(data?.providers ?? []), [data]);
  const connected = list.filter(isConnected).length;

  function replace(next: Providers) {
    loaded.set(next);
    onConnected(next.providers.filter(isConnected).length);
  }
  async function change(p: Provider, on: boolean) {
    setBusy(p.id);
    setError(undefined);
    try {
      replace(await client.updateProvider(p.id, { added: on, enabled: on }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  }
  async function check() {
    setChecking(true);
    setError(undefined);
    try {
      replace(await client.providers({ fresh: true }));
      setChecked(true);
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  }
  const toggle = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  const note =
    data && !data.connector.configured
      ? "No agent connector is set up, so there is nothing to connect yet. Start Open Sourcebook again from your terminal."
      : data && !data.connector.reachable
        ? "Open Sourcebook can't reach the connector that runs your agents. Start it again from your terminal, then press Check again."
        : undefined;

  return (
    <>
      <section className="fr-card" aria-labelledby="fr-h">
        <div className="fr-head">
          <h1 id="fr-h">
            <span className="fr-long">Connect the coding agent you use</span>
            <span className="fr-short">Connect your coding agent</span>
          </h1>
          <p>
            <span className="fr-long">
              It answers your chats and makes things, on this computer with your own sign-in. Connect one or more; you can change this later in
              Settings.
            </span>
            <span className="fr-short">One or more. You can change this later.</span>
          </p>
        </div>
        {loaded.loading && !data && <p className="fr-line" role="status">Looking for agents on this computer…</p>}
        {loaded.error !== undefined && !data && (
          <div className="fr-line">
            <ErrorNotice error={loaded.error} />
            <OutlineButton onClick={() => void loaded.reload()}>Try again</OutlineButton>
          </div>
        )}
        {note && (
          <div className="fr-line">
            <p role="status">{note}</p>
            <OutlineButton onClick={() => void check()} disabled={checking}>
              {checking ? "Checking…" : "Check again"}
            </OutlineButton>
          </div>
        )}
        {data && list.length === 0 && !note && <p className="fr-line">No agents are listed yet.</p>}
        <ul className="fr-list" aria-label="Coding agents">
          {list.map((p) => {
            const on = isConnected(p);
            const expanded = open.includes(p.id);
            const howTo = on ? p.state === "signedOut" && !!p.signIn : expanded;
            return (
              <li key={p.id}>
                <div className="fr-row">
                  <span className="fr-logo">
                    <ProviderMark mark={p.mark} label={p.label} size={20} />
                  </span>
                  <span className="fr-who">
                    <b>{p.label}</b>
                    <span>
                      <Status p={p} />
                    </span>
                  </span>
                  {on ? (
                    <span className="fr-on">
                      <span className="fr-ok">
                        <Icon name="check" />
                        Connected
                      </span>
                      <OutlineButton aria-label={`Disconnect ${p.label}`} disabled={busy === p.id} onClick={() => void change(p, false)}>
                        Disconnect
                      </OutlineButton>
                    </span>
                  ) : p.state === "ready" || p.state === "signedOut" ? (
                    <PrimaryButton aria-label={`Connect ${p.label}`} disabled={busy === p.id} onClick={() => void change(p, true)}>
                      Connect
                    </PrimaryButton>
                  ) : (
                    <OutlineButton aria-label={`How to connect ${p.label}`} aria-expanded={expanded} onClick={() => toggle(p.id)}>
                      How to connect
                    </OutlineButton>
                  )}
                </div>
                {howTo && <HowTo p={p} onCheck={() => void check()} checking={checking} checked={checked} />}
              </li>
            );
          })}
        </ul>
        <ErrorNotice error={error} />
      </section>
      <div className="fr-foot">
        <span className="fr-hint">Listed A to Z. Connect at least one to go on.</span>
        <PrimaryButton className="fr-next" disabled={connected === 0} onClick={onNext}>
          Next
        </PrimaryButton>
      </div>
    </>
  );
}
