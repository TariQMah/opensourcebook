import { useState, type FormEvent, type ReactNode } from "react";
import type { Provider } from "../api/types";
import { useApi } from "../app/context";
import { OUTLINE_BUTTON, OutlineButton, PRIMARY_BUTTON, PrimaryButton } from "../design/Buttons";
import { installAgent, sendSignInCode, signInAgent, type AgentSetup } from "./api";
import { agentStatus } from "./agentStatus";
import type { Launcher } from "./useLauncherSetup";
import "./setup.css";

/**
 * What one agent needs on this computer and the button that does it, the same wherever agents are listed (Get set up,
 * first-time setup's Connect step, Settings › Providers): Install it (with npm or its own installer, which the
 * launcher runs), Get it from its own download page when neither can, and Sign in, which starts the agent's own
 * sign-in in the browser. How each agent installs and signs in comes from its adapter through the launcher; nothing
 * here names one. `AgentButton` is the one button, `AgentNotes` what goes under it (how it is going, what went wrong,
 * a code to enter or a box to paste one into).
 */
export interface AgentFixProps {
  p: Provider;
  launcher: Launcher;
  /** Looks for the agents again (Check again). */
  onCheck: () => void;
  checking?: boolean;
  /** Whether an agent got from its own page has its own Check again under it; false where the screen has one already. */
  checkHere?: boolean;
}

/** Whether a button does it here, or the agent is got from its own page. */
function installable(a?: AgentSetup): a is AgentSetup {
  return !!a && a.canInstall && a.how !== "page";
}

/** Its download page: the launcher's, else the one the engine lists. */
const pageOf = (p: Provider, a?: AgentSetup) => a?.page ?? p.install?.url;

export function AgentButton({ p, launcher, onCheck, checking }: AgentFixProps) {
  const client = useApi();
  const a = launcher.of(p.id);
  if (p.state === "missing") {
    if (installable(a)) {
      if (a.install.state === "installing")
        return (
          <PrimaryButton disabled aria-label={`Installing ${p.label}`}>
            Installing…
          </PrimaryButton>
        );
      if (a.install.state === "done")
        return (
          <OutlineButton onClick={onCheck} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </OutlineButton>
        );
      return (
        <PrimaryButton aria-label={`Install ${p.label}`} onClick={() => void launcher.act(() => installAgent(client, p.id))}>
          {a.install.state === "failed" ? "Install again" : "Install"}
        </PrimaryButton>
      );
    }
    const page = pageOf(p, a);
    if (page)
      return (
        <a className={PRIMARY_BUTTON} href={page} target="_blank" rel="noreferrer" aria-label={`Get ${p.label}`}>
          Get {p.label}
        </a>
      );
    return null;
  }
  if (p.state === "signedOut" && a?.canSignIn) {
    if (a.signIn.state === "signingIn")
      return (
        <OutlineButton aria-label={`Start signing in to ${p.label} again`} onClick={() => void launcher.act(() => signInAgent(client, p.id))}>
          Start again
        </OutlineButton>
      );
    return (
      <PrimaryButton aria-label={`Sign in to ${p.label}`} onClick={() => void launcher.act(() => signInAgent(client, p.id))}>
        {a.signIn.state === "failed" ? "Sign in again" : "Sign in"}
      </PrimaryButton>
    );
  }
  return null;
}

export function AgentNotes({ p, launcher, onCheck, checking, checkHere = true }: AgentFixProps) {
  const a = launcher.of(p.id);
  if (p.state === "missing") {
    if (installable(a)) {
      if (a.install.state === "installing")
        return (
          <p className="ag-note" role="status">
            {a.how === "script" ? `Running ${p.label}'s own installer…` : `Installing ${p.label}…`} This can take a few minutes; you can keep using Open Sourcebook meanwhile.
          </p>
        );
      if (a.install.state === "failed")
        return (
          <p className="ag-err" role="alert">
            {a.install.message}
          </p>
        );
      if (a.install.state === "done")
        return <p className="ag-note">{p.label} is installed. Press Check again if it is not found yet.</p>;
      return null;
    }
    const page = pageOf(p, a);
    // Started without the launcher (no button can run here): its page's one-line install, for whoever runs it.
    const command = launcher.off && p.install?.command && (
      <p className="ag-note">
        Or run its install command: <code>{p.install.command}</code>
      </p>
    );
    if (!checkHere) return command || null;
    return (
      <div className="ag-notes">
        <p className="ag-note">{page ? `Get opens ${p.label}'s own download page. Install it there, then come back and press Check again.` : `Install ${p.label} on this computer, then press Check again.`}</p>
        {command}
        <OutlineButton onClick={onCheck} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </OutlineButton>
      </div>
    );
  }
  if (p.state !== "signedOut") return null;
  if (!a?.canSignIn)
    // No button can start its sign-in (it has no sign-in command of its own, or the launcher is not there to run one).
    return p.signIn ? (
      <p className="ag-note">
        Sign in to {p.label} once by running <code>{p.signIn}</code> on this computer, then press Check again.
      </p>
    ) : (
      <p className="ag-note">Sign in to {p.label} on this computer, then press Check again.</p>
    );
  if (a.signIn.state === "failed")
    return (
      <p className="ag-err" role="alert">
        {a.signIn.message}
      </p>
    );
  if (a.signIn.state !== "signingIn") return null;
  const s = a.signIn;
  return (
    <div className="ag-notes" role="group" aria-label={`Signing in to ${p.label}`}>
      <p className="ag-note" role="status">
        Finish signing in to {p.label} in your browser.
        {s.url && (
          <>
            {" "}
            If it did not open,{" "}
            <a href={s.url} target="_blank" rel="noreferrer">
              open the sign-in page
            </a>
            .
          </>
        )}
      </p>
      {s.deviceCode && (
        <p className="ag-note">
          Enter this code on that page: <b className="ag-code">{s.deviceCode}</b>
        </p>
      )}
      {s.asksCode && <PasteCode p={p} launcher={launcher} />}
    </div>
  );
}

/** The box for the code the sign-in page shows when it can't hand it to the agent itself, written to the agent's sign-in. */
function PasteCode({ p, launcher }: { p: Provider; launcher: Launcher }) {
  const client = useApi();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    const typed = code.trim();
    if (!typed) return;
    await launcher.act(() => sendSignInCode(client, p.id, typed));
    setCode("");
    setSent(true);
  }
  return (
    <form className="ag-paste" onSubmit={(e) => void send(e)}>
      <label>
        <span>If the page shows a code instead, paste the code here</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`The code from ${p.label}'s sign-in page`} />
      </label>
      <button className={OUTLINE_BUTTON} type="submit" disabled={!code.trim()}>
        Send
      </button>
      {sent && (
        <span className="ag-note" role="status">
          Sent. It finishes in a moment.
        </span>
      )}
    </form>
  );
}

/** One agent as a row: its mark and name, where it stands, its button, and what goes under it. */
export function AgentFixRow({ p, launcher, onCheck, checking, checkHere, mark, extra }: AgentFixProps & { mark?: ReactNode; extra?: ReactNode }) {
  const a = launcher.of(p.id);
  return (
    <li className="ag-row">
      <div className="ag-line">
        {mark && <span className="ag-logo">{mark}</span>}
        <span className="ag-who">
          <b>{p.label}</b>
          <span>{agentStatus(p, a)}</span>
        </span>
        <span className="ag-act">
          <AgentButton p={p} launcher={launcher} onCheck={onCheck} {...(checking !== undefined ? { checking } : {})} />
          {extra}
        </span>
      </div>
      <AgentNotes p={p} launcher={launcher} onCheck={onCheck} {...(checking !== undefined ? { checking } : {})} {...(checkHere !== undefined ? { checkHere } : {})} />
    </li>
  );
}
