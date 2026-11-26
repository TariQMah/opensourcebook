import { useMemo, useState, type ReactNode } from "react";
import type { Provider, Providers } from "../api/types";
import { useApi } from "../app/context";
import { ErrorNotice } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { ProviderMark } from "../design/ProviderMark";
import { AgentButton, AgentNotes } from "../setup/AgentFix";
import type { AgentSetup } from "../setup/api";
import { useLauncherSetup } from "../setup/useLauncherSetup";
import { byName, isConnected } from "./rules";

/** The words under a name; the short ones (phone) are the part not marked long. */
function Status({ p, a }: { p: Provider; a?: AgentSetup }): ReactNode {
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
    // Its maker's app is here but not the program Open Sourcebook runs.
    if (a?.appFound) {
      return (
        <>
          {a.appFound} app found<span className="fr-long">; Open Sourcebook needs its command-line part</span>
        </>
      );
    }
    return (
      <>
        Not found<span className="fr-long"> on this computer</span>
      </>
    );
  }
  return <>{p.headline}</>;
}

/**
 * Step 1: the agents the engine lists, A to Z, each with Connect or the button that gets it there: Install, Get it
 * from its own page, or Sign in (`../setup/AgentFix.tsx`, the same buttons Get set up shows). Nothing is picked for the
 * person and none comes first.
 */
export function ProvidersStep({ onNext, onConnected }: { onNext: () => void; onConnected: (count: number) => void }) {
  const client = useApi();
  const loaded = useLoad(() => client.providers(), [client]);
  const [busy, setBusy] = useState<string>();
  const [checking, setChecking] = useState(false);
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
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  }
  // An install or a sign-in a button started finishing is looked for at once; one signed in to is connected.
  const launcher = useLauncherSetup(({ signedIn }) => {
    void (async () => {
      for (const id of signedIn) {
        const p = data?.providers.find((x) => x.id === id);
        if (p && !isConnected(p)) await client.updateProvider(id, { added: true, enabled: true }).catch(() => undefined);
      }
      await check();
    })();
  });

  const note =
    data && !data.connector.configured
      ? "No agent connector is set up, so there is nothing to connect yet. Close Open Sourcebook and open it again from its shortcut."
      : data && !data.connector.reachable
        ? "Open Sourcebook can't reach the connector that runs your agents. Close Open Sourcebook and open it again from its shortcut, then press Check again."
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
            const fix = { p, launcher, onCheck: () => void check(), checking };
            return (
              <li key={p.id}>
                <div className="fr-row">
                  <span className="fr-logo">
                    <ProviderMark mark={p.mark} label={p.label} size={20} />
                  </span>
                  <span className="fr-who">
                    <b>{p.label}</b>
                    <span>
                      <Status p={p} {...(launcher.of(p.id) ? { a: launcher.of(p.id)! } : {})} />
                    </span>
                  </span>
                  <span className="fr-on">
                    <AgentButton {...fix} />
                    {on ? (
                      <>
                        <span className="fr-ok">
                          <Icon name="check" />
                          Connected
                        </span>
                        <OutlineButton aria-label={`Disconnect ${p.label}`} disabled={busy === p.id} onClick={() => void change(p, false)}>
                          Disconnect
                        </OutlineButton>
                      </>
                    ) : (
                      (p.state === "ready" || p.state === "signedOut") && (
                        <PrimaryButton aria-label={`Connect ${p.label}`} disabled={busy === p.id} onClick={() => void change(p, true)}>
                          Connect
                        </PrimaryButton>
                      )
                    )}
                  </span>
                </div>
                <div className="fr-fix">
                  <AgentNotes {...fix} />
                </div>
              </li>
            );
          })}
        </ul>
        <ErrorNotice error={error ?? launcher.error} />
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
