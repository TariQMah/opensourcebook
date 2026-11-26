import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { Provider, ProviderPatch, Providers } from "../api/types";
import { Icon } from "../design/Icon";
import { ProviderMark } from "../design/ProviderMark";
import { Switch } from "../design/ui";
import { aToZ } from "../make/makerKey";
import { said, tone } from "../project/providers";
import { AgentButton, AgentNotes } from "../setup/AgentFix";
import { agentStatus } from "../setup/agentStatus";
import { useLauncherSetup, type Launcher } from "../setup/useLauncherSetup";
import { SectionHead } from "./settings/SectionHead";
import { useNarrow } from "./settings/useNarrow";

/**
 * Settings › Providers (engine/docs/api.md, "Providers"; DECISIONS #58):
 * the person's providers, A to Z with none put first, beside the chosen
 * one's details. Each in the list
 * has its mark, version, state and an on/off switch; the details say what
 * to do when it can't answer, how to sign in, and which of its models the
 * chat shows, with a star for favorites. Add provider offers every agent
 * the connector can run that isn't in the list. Never a credential: signing
 * in happens on the person's computer, with the command shown.
 */
export function ProvidersSettings({
  headingId,
  data,
  failed,
  checking,
  selected,
  onSelect,
  onBack,
  onChange,
  onCheck,
}: {
  /** The id the section is labelled by. */
  headingId: string;
  data?: Providers;
  failed: boolean;
  checking: boolean;
  selected?: string;
  onSelect: (id: string) => void;
  /** On a phone, closes the details and goes back to the list. */
  onBack: () => void;
  onChange: (id: string, patch: ProviderPatch) => Promise<void>;
  onCheck: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const narrow = useNarrow();
  // The same buttons as Get set up's; what one finished is looked for at once.
  const launcher = useLauncherSetup(() => onCheck());
  const head = (body: ReactNode) => (
    <>
      <SectionHead
        id={headingId}
        title="Providers"
        action={
          data?.connector.configured && (
            <button type="button" className="pv-check" disabled={checking} onClick={onCheck} title="Check every provider again">
              <Icon name="retry" />
              {checking ? "Checking…" : data.connector.checkedAt ? `Checked ${ago(data.connector.checkedAt)}` : "Check again"}
            </button>
          )
        }
      >
        Your own agents answer the chat and make things, on your computer and with your own sign-in. Open Sourcebook never holds their credentials.
      </SectionHead>
      {body}
    </>
  );
  if (!data) return head(<p className="pv-note card">{failed ? "Couldn't ask the engine about your providers." : "Checking…"}</p>);
  if (!data.connector.configured) {
    return head(
      <p className="pv-note card">
        No agent is connected to this engine. Start Open Sourcebook's connector on your computer (<code>services/agent-connector</code>) and give the engine its address
        and token (<code>CHAT_AGENT_URL</code>, <code>CHAT_AGENT_TOKEN</code>).
      </p>,
    );
  }
  const listed = aToZ(data.providers.filter((p) => p.added));
  const offered = aToZ(data.providers.filter((p) => !p.added));
  // On a phone the list and a provider's details are two views: the details open on their own, with a way back.
  const chosen = listed.find((p) => p.id === selected) ?? (narrow ? undefined : listed[0]);
  const chat = data.picks?.chat?.agent;
  if (narrow && chosen && data.connector.reachable) {
    return (
      <>
        <button type="button" className="sx-back pv-backbar" aria-label="Back to Providers" onClick={onBack}>
          <Icon name="chev-l" />
          Providers
        </button>
        <ProviderDetail key={chosen.id} provider={chosen} launcher={launcher} chatPick={chat === chosen.id} checking={checking} onChange={(patch) => onChange(chosen.id, patch)} onCheck={onCheck} />
      </>
    );
  }
  return head(
    <>
      {!data.connector.reachable ? (
        <div className="pv-note card">
          <span className="dot warn" aria-hidden="true" /> Your agent can't be reached. Start Open Sourcebook's connector on your computer, then check again.
        </div>
      ) : (
        <div className="pv card">
          <div className="pv-list">
            <ul aria-label="Your providers">
              {listed.map((p) => (
                <li key={p.id} className={p.id === chosen?.id ? "on" : ""}>
                  <button type="button" className="pv-item" aria-current={p.id === chosen?.id} onClick={() => onSelect(p.id)}>
                    <ProviderMark mark={p.mark} label={p.label} size={20} />
                    <span className="pv-ab">
                      <b>
                        {p.label}
                        {p.version && <code>v{p.version}</code>}
                      </b>
                      <span title={p.enabled ? said(p) : undefined}>
                        <span className={`dot ${tone(p)}`} aria-hidden="true" />
                        {p.enabled ? said(p) : "Off"}
                      </span>
                    </span>
                  </button>
                  <Switch checked={p.enabled} label={`Use ${p.label}`} onChange={(enabled) => void onChange(p.id, { enabled })} />
                </li>
              ))}
            </ul>
            {listed.length === 0 && <p className="pv-empty">No providers yet. Add the agent you use on your computer.</p>}
            <button type="button" className="obtn pv-add" disabled={offered.length === 0} onClick={() => setAdding(true)} title={offered.length === 0 ? "Every agent the connector can run is in your list" : undefined}>
              <Icon name="plus" />
              Add provider
            </button>
          </div>
          {narrow ? null : chosen ? (
            <ProviderDetail key={chosen.id} provider={chosen} launcher={launcher} chatPick={chat === chosen.id} checking={checking} onChange={(patch) => onChange(chosen.id, patch)} onCheck={onCheck} />
          ) : (
            <div className="pv-detail" />
          )}
        </div>
      )}
      {adding && (
        <AddProvider
          offered={offered}
          launcher={launcher}
          checking={checking}
          onCheck={onCheck}
          onCancel={() => setAdding(false)}
          onAdd={async (p) => {
            await onChange(p.id, { added: true, enabled: true });
            setAdding(false);
            onSelect(p.id);
          }}
        />
      )}
    </>,
  );
}

/** "just now", "3m ago", "2h ago". */
function ago(at: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * What a provider that can't answer needs: what is wrong, then its button (Install, Get it from its own page, or Sign
 * in, the same as Get set up's, `../setup/AgentFix.tsx`), what that button is doing, and a check-again.
 */
function Setup({ provider: p, launcher, checking, onCheck }: { provider: Provider; launcher: Launcher; checking: boolean; onCheck: () => void }) {
  if (p.state === "ready") return null;
  const fix = { p, launcher, onCheck, checking, checkHere: false };
  const a = launcher.of(p.id);
  return (
    <div className="pv-setup" role="group" aria-label={`Set up ${p.label}`}>
      <p>{p.state === "missing" && a?.appFound ? `${agentStatus(p, a)}.` : (p.detail ?? p.headline)}</p>
      <div className="pv-fix">
        <AgentButton {...fix} />
        <button className="mini" type="button" disabled={checking} onClick={onCheck}>
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
      <AgentNotes {...fix} />
    </div>
  );
}

function ProviderDetail({
  provider: p,
  launcher,
  chatPick,
  checking,
  onChange,
  onCheck,
}: {
  provider: Provider;
  launcher: Launcher;
  chatPick: boolean;
  checking: boolean;
  onChange: (patch: ProviderPatch) => Promise<void>;
  onCheck: () => void;
}) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const models = p.models.filter((m) => !q || `${m.label} ${m.id}`.toLowerCase().includes(q));
  const hidden = p.models.filter((m) => !m.shown).map((m) => m.id);
  const favorites = p.models.filter((m) => m.favorite).map((m) => m.id);
  const allOff = hidden.length === p.models.length;
  return (
    <section className="pv-detail" aria-label={p.label}>
      <div className="pv-title">
        <ProviderMark mark={p.mark} label={p.label} size={22} />
        <h3>{p.label}</h3>
        {p.version && <code>v{p.version}</code>}
      </div>

      <div className="pv-two">
        <section className="pv-sec" aria-label="Status">
          <h4>Status</h4>
          <p className="pv-state">
            <span className={`dot ${tone(p)}`} aria-hidden="true" />
            {p.enabled ? p.headline : `Off. The chat doesn't use ${p.label}.`}
            {chatPick && p.enabled && <small>Picked for the chat in What makes what</small>}
            {p.workDefault && p.enabled && <small> · Default for longer work</small>}
          </p>
        </section>

        {(p.state === "ready" || p.state === "signedOut") && (
          <section className="pv-sec" aria-label="Account">
            <h4>Account</h4>
            <p className="pv-d">
              {p.state === "ready"
                ? (p.detail ?? `Signed in on your computer. ${p.label} answers with your own account; Open Sourcebook never holds its credentials.`)
                : `Not signed in on this computer yet. Sign in below, then check again.`}
            </p>
          </section>
        )}
      </div>
      <Setup provider={p} launcher={launcher} checking={checking} onCheck={onCheck} />

      <section className="pv-sec" aria-label="Models">
        <div className="pv-sech">
          <h4>Models</h4>
          {p.models.length > 0 && <small>{p.models.length === 1 ? "1 model" : `${p.models.length} models`}</small>}
        </div>
        <p className="pv-d">The pickers show the models switched on here. Star one to keep it at the top of the pickers.</p>
        {p.models.length === 0 ? (
          <p className="pv-d">{p.label} lists no models of its own; it answers with its default.</p>
        ) : (
          <>
            <div className="pv-tools">
              <label className="pv-filter">
                <Icon name="search" />
                <input type="search" placeholder="Filter models" aria-label="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </label>
              <button className="mini" type="button" onClick={() => void onChange({ hiddenModels: allOff ? [] : p.models.map((m) => m.id) })}>
                {allOff ? "Turn all on" : "Turn all off"}
              </button>
            </div>
            <ul className="pv-models" aria-label={`${p.label} models`}>
              {models.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className={`pv-star${m.favorite ? " on" : ""}`}
                    aria-pressed={m.favorite}
                    aria-label={`${m.favorite ? "Unstar" : "Star"} ${m.label}`}
                    onClick={() => void onChange({ favoriteModels: m.favorite ? favorites.filter((id) => id !== m.id) : [...favorites, m.id] })}
                  >
                    <Icon name="star" />
                  </button>
                  <span className="pv-mname">{m.label}</span>
                  <code>{m.id}</code>
                  {p.defaultModel && (m.id === p.defaultModel || m.label.toLowerCase() === p.defaultModel.toLowerCase()) && <small>default</small>}
                  {p.workDefaultModel && (m.id === p.workDefaultModel || m.label.toLowerCase() === p.workDefaultModel.toLowerCase()) && <small>work default</small>}
                  <Switch
                    checked={m.shown}
                    label={`Show ${m.label} in the pickers`}
                    onChange={(show) => void onChange({ hiddenModels: show ? hidden.filter((id) => id !== m.id) : [...hidden, m.id] })}
                  />
                </li>
              ))}
              {models.length === 0 && <li className="pv-none">No model matches “{filter.trim()}”.</li>}
            </ul>
          </>
        )}
      </section>

      {p.efforts.length > 0 && (
        <section className="pv-sec" aria-label="Effort">
          <h4>Effort</h4>
          <p className="pv-d">
            {p.label} can think {p.efforts.map((e) => e.label.toLowerCase()).join(", ")}
            {p.defaultEffort ? `; without a pick it uses ${p.efforts.find((e) => e.id === p.defaultEffort)?.label.toLowerCase() ?? p.defaultEffort}.` : "."}
            {p.workDefaultEffort ? ` For longer work it defaults to ${p.efforts.find((e) => e.id === p.workDefaultEffort)?.label.toLowerCase() ?? p.workDefaultEffort}.` : ""} You pick it per chat and
            per thing. Which agent, model and effort each one starts with is set in <Link to={{ hash: "#makers" }}>What makes what</Link>.
          </p>
        </section>
      )}

      <div className="pv-foot">
        <button className="obtn" type="button" onClick={() => void onChange({ added: false })}>
          Remove from your providers
        </button>
      </div>
    </section>
  );
}

/**
 * Adds a provider in two steps: pick one of the agents the connector can
 * run, then see what it needs (install it, sign in with the command shown)
 * and add it. One that can't answer yet can still be added; the list says
 * what it needs.
 */
function AddProvider({
  offered,
  launcher,
  checking,
  onCheck,
  onCancel,
  onAdd,
}: {
  offered: Provider[];
  launcher: Launcher;
  checking: boolean;
  onCheck: () => void;
  onCancel: () => void;
  onAdd: (p: Provider) => Promise<void>;
}) {
  const titleId = useId();
  const [step, setStep] = useState<1 | 2>(1);
  const [pickedId, setPickedId] = useState(offered[0]?.id);
  const [busy, setBusy] = useState(false);
  const picked = offered.find((p) => p.id === pickedId);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onCancel]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="pv-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="pv-dh">
          <h2 id={titleId}>Add provider</h2>
          <button type="button" className="pv-x" aria-label="Close" onClick={onCancel}>
            <Icon name="x" />
          </button>
        </div>
        <p className="pv-d">Connect an agent on your computer to answer and make things with your own account.</p>
        <ol className="pv-steps">
          <li className={step === 1 ? "on" : "done"}>
            <span>{step === 1 ? "1" : <Icon name="check" />}</span>Provider
          </li>
          <li className={step === 2 ? "on" : ""}>
            <span>2</span>Connect
          </li>
        </ol>
        {step === 1 ? (
          <div className="pv-grid" role="radiogroup" aria-label="Provider">
            {offered.map((p, i) => (
              <button
                key={p.id}
                ref={i === 0 ? first : undefined}
                type="button"
                role="radio"
                aria-checked={p.id === pickedId}
                className={p.id === pickedId ? "on" : ""}
                onClick={() => setPickedId(p.id)}
              >
                <ProviderMark mark={p.mark} label={p.label} size={18} />
                <span>{p.label}</span>
                <small>{p.state === "ready" ? "Ready" : p.headline}</small>
                {p.id === pickedId && <Icon name="check" />}
              </button>
            ))}
          </div>
        ) : (
          picked && (
            <div className="pv-connect">
              <div className="pv-title">
                <ProviderMark mark={picked.mark} label={picked.label} size={22} />
                <h3>{picked.label}</h3>
                {picked.version && <code>v{picked.version}</code>}
                <span className={`pv-chip ${picked.state === "ready" ? "on" : "warn"}`}>
                  <span className="dot" aria-hidden="true" />
                  {picked.state === "ready" ? "Ready" : picked.headline}
                </span>
              </div>
              {picked.state === "ready" && <p className="pv-d">{picked.detail ?? "Installed and signed in on your computer. Ready to answer."}</p>}
              <Setup provider={picked} launcher={launcher} checking={checking} onCheck={onCheck} />
            </div>
          )
        )}
        <div className="acts">
          {step === 2 && picked && picked.state !== "ready" && <p className="pv-later">You can add it now and sign in later.</p>}
          {step === 1 ? (
            <>
              <button className="btn ghost" type="button" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn" type="button" disabled={!picked} onClick={() => setStep(2)}>
                Next
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={() => setStep(1)}>
                Back
              </button>
              <button
                className="btn"
                type="button"
                disabled={!picked || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onAdd(picked!);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Add {picked?.label ?? "provider"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
