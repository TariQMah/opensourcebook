import { useEffect, useState, type ReactNode } from "react";

type Seen =
  | { state: "asking" }
  | { state: "in" }
  | { state: "out"; reason: "not_opened" | "not_set_up"; message: string; earlier: boolean; canReopen: boolean };

type Reopen = { state: "idle" } | { state: "asking" } | { state: "opened" } | { state: "failed"; message: string };

/** How to open Open Sourcebook without a terminal, on this computer's system: its shortcut. */
function shortcutWords(): string {
  const platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  if (/Win/i.test(platform)) return "Find Open Sourcebook in the Start menu and open it.";
  if (/Mac/i.test(platform)) return "Open Open Sourcebook from your Applications folder (or the Dock).";
  return "Open Open Sourcebook with its shortcut in your apps.";
}

/**
 * The app, once the proxy has let this browser in (web/worker/proxy.ts). A browser Open Sourcebook did not let in sees
 * one plain page instead of screens that cannot load. A tab let in by an earlier run (Open Sourcebook was stopped and
 * started again while it stayed open) is told that Open Sourcebook is running and this tab only needs letting in
 * again, with a button that asks the launcher to open a fresh page; then, for anyone, the shortcut first and the
 * command second. When it was not started by the launcher at all, the page shows what the proxy says instead.
 * Anything else (no answer at all) shows the app, whose screens say the server is not reachable.
 */
export function OpenGate({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }) {
  const [seen, setSeen] = useState<Seen>({ state: "asking" });
  const [reopen, setReopen] = useState<Reopen>({ state: "idle" });
  const f = fetchImpl ?? globalThis.fetch;
  useEffect(() => {
    let live = true;
    f("/api/session", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (r.ok) return { state: "in" } as const;
        const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string; earlier?: boolean; canReopen?: boolean };
        if (body.error === "not_opened" || body.error === "not_set_up") return { state: "out", reason: body.error, message: body.message ?? "", earlier: body.earlier === true, canReopen: body.canReopen === true } as const;
        return { state: "in" } as const;
      })
      .catch(() => ({ state: "in" }) as const)
      .then((next) => live && setSeen(next));
    return () => {
      live = false;
    };
  }, [f]);

  async function askLauncher() {
    setReopen({ state: "asking" });
    try {
      const to = `${window.location.pathname}${window.location.search}`;
      const r = await f("/api/reopen", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ to }) });
      if (r.ok) return setReopen({ state: "opened" });
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      setReopen({ state: "failed", message: body.message ?? "Open Sourcebook did not open a new page." });
    } catch {
      setReopen({ state: "failed", message: "Open Sourcebook did not answer." });
    }
  }

  if (seen.state === "asking") return null;
  if (seen.state === "in") return <>{children}</>;
  const ways = (
    <>
      <p>
        {shortcutWords()} {seen.earlier ? "It is already running, so this only opens a fresh page." : "If it is already running, that opens a fresh page for you."}
      </p>
      <p>
        If you use a terminal, the command is <code>opensourcebook open</code>, or <code>npm run open</code> in its folder.
      </p>
    </>
  );
  return (
    <main className="open-gate" style={{ maxWidth: "34rem", margin: "15vh auto", padding: "0 20px" }}>
      {seen.reason === "not_opened" && seen.earlier ? (
        <>
          <h1>Open Sourcebook is running. Let this tab in again</h1>
          <p>Open Sourcebook was started again since this tab was opened, and each start lets in only the pages it opens itself.</p>
          {seen.canReopen && (
            <p>
              <button type="button" className="mini go" disabled={reopen.state === "asking" || reopen.state === "opened"} onClick={() => void askLauncher()}>
                {reopen.state === "asking" ? "Opening…" : "Open a fresh page"}
              </button>
            </p>
          )}
          {reopen.state === "opened" && <p role="status">A fresh page of Open Sourcebook is opening in this browser. You can close this tab.</p>}
          {reopen.state === "failed" && <p role="alert">{reopen.message}</p>}
          {ways}
        </>
      ) : (
        <>
          <h1>Open this page from Open Sourcebook</h1>
          {seen.reason === "not_opened" ? ways : <p>{seen.message}</p>}
        </>
      )}
      <p>
        An address typed by hand, or kept from an earlier day, shows this page. Open Sourcebook works only in the browser it opened
        itself, so no other program and no other person on this computer can reach your projects.
      </p>
    </main>
  );
}
