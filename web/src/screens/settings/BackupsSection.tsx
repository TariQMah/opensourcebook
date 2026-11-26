import { useId, useRef, useState } from "react";
import { errorText } from "../../api/errors";
import type { RestoreChoice, RestoreDone, RestoreProject, RestoreView, WeeklyBackup } from "../../api/types";
import { useApi } from "../../app/context";
import { Confirm } from "../../app/Confirm";
import { ErrorNotice } from "../../app/Status";
import { useThisComputer } from "../../app/thisComputer";
import { useLoad } from "../../app/useLoad";
import { Switch } from "../../design/ui";
import { SectionHead } from "./SectionHead";
import "./backups.css";

const CHOICES: ReadonlyArray<{ value: RestoreChoice; label: string }> = [
  { value: "keep-both", label: "Keep both" },
  { value: "replace", label: "Replace" },
  { value: "skip", label: "Skip" },
];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What a project of a backup holds, in a few words. */
function holds(p: RestoreProject): string {
  const parts = [plural(p.sources, "source"), plural(p.chats, "chat"), `${p.outputs} made`];
  return `${parts.join(", ")}${p.archived ? ", archived" : ""}`;
}

/** How many backups the weekly one may keep, as offered here. */
const KEEP_CHOICES = [1, 2, 3, 4, 6, 8, 12];

/**
 * The weekly backup: the launcher saves one into the library's Backups folder every week, keeping the newest few. Off
 * until the person turns it on, since each holds every video made and goes into their own folder.
 */
function WeeklyRow() {
  const client = useApi();
  const weekly = useLoad(() => client.weeklyBackup(), [client]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function change(work: () => Promise<WeeklyBackup>) {
    setBusy(true);
    setError(undefined);
    try {
      weekly.set(await work());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const w = weekly.data;
  const keepChoices = w && !KEEP_CHOICES.includes(w.keep) ? [...KEEP_CHOICES, w.keep].sort((a, b) => a - b) : KEEP_CHOICES;
  return (
    <section className="sx-arow" aria-label="Every week">
      <span className="bk-weekly">
        <b>Back up every week</b>
        {w && <Switch checked={w.on} label="Back up every week" disabled={busy} onChange={(on) => void change(() => client.setWeeklyBackup(on))} />}
      </span>
      {!w ? (
        <p>{weekly.error !== undefined ? errorText(weekly.error) : "…"}</p>
      ) : (
        <>
          <p>
            Saves a backup in <code>{w.folder}</code> once a week while Open Sourcebook runs, and catches up when it starts. Each one holds every video you made, so it can be large.
          </p>
          <label className="bk-keep">
            Keep the newest
            <select value={w.keep} disabled={busy} onChange={(e) => void change(() => client.keepBackups(Number(e.target.value)))}>
              {keepChoices.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {w.keep === 1 ? "backup" : "backups"}; older ones are deleted.
          </label>
          <p>{w.saving ? "Backing up now…" : w.last ? `Last backup: ${new Date(w.last).toLocaleString()}.` : "Last backup: none yet."}</p>
          {w.failed && <p role="alert">The last try, {new Date(w.failed.at).toLocaleString()}, did not work: {w.failed.message}</p>}
        </>
      )}
      <ErrorNotice error={error} />
    </section>
  );
}

/**
 * Settings › Backups: every project in one file, the files of what was made in it too, and back. Only the browser on
 * this computer backs up or restores. Restoring adds the projects that are not here; for one that is, the person
 * chooses to keep both or to replace the one here, and nothing is written until every such project has a choice.
 */
export function BackupsSection() {
  const heading = useId();
  const client = useApi();
  const here = useThisComputer();
  const input = useRef<HTMLInputElement>(null);
  const [restore, setRestore] = useState<RestoreView>();
  const [choices, setChoices] = useState<Record<string, RestoreChoice>>({});
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<RestoreDone>();
  const [error, setError] = useState<unknown>();

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      return await work();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function choose(id: string, choice: RestoreChoice | undefined) {
    const next = { ...choices };
    if (choice) next[id] = choice;
    else delete next[id];
    setChoices(next);
  }

  async function chosen(file: File | undefined) {
    if (!file) return;
    setDone(undefined);
    const view = await run(() => client.startRestore(file));
    if (input.current) input.current.value = "";
    if (!view) return;
    setRestore(view);
    setChoices({});
  }

  async function cancel() {
    const id = restore?.id;
    setRestore(undefined);
    setAsking(false);
    if (id) await client.cancelRestore(id).catch(() => undefined);
  }

  async function finish() {
    if (!restore) return;
    setAsking(false);
    const answer = await run(() => client.finishRestore(restore.id, choices));
    if (!answer) return;
    setDone(answer);
    setRestore(undefined);
  }

  const already = restore?.projects.filter((p) => p.here) ?? [];
  const unchosen = already.filter((p) => !choices[p.id]);
  const replacing = already.filter((p) => choices[p.id] === "replace");
  const restoring = restore ? restore.projects.filter((p) => choices[p.id] !== "skip").length : 0;
  const linked = restore?.projects.filter((p) => p.linkedFiles > 0) ?? [];

  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Backups">
        Every project in one file: its sources, chats, plans and everything made, videos included. Restore it here or on another computer.
      </SectionHead>
      <div className="card sx-rows">
        <section className="sx-arow" aria-label="Back up">
          <b>Back up every project</b>
          {here ? (
            <>
              <p>Saves one .zip file where your browser saves downloads, or where you choose. Files of a linked folder stay where they are; the backup keeps where they are.</p>
              <a className="btn" href={client.backupUrl()} download>
                Back up now
              </a>
            </>
          ) : (
            <p>Only in the browser on the computer Open Sourcebook runs on.</p>
          )}
        </section>
        {here && <WeeklyRow />}
        {here && (
          <section className="sx-arow" aria-label="Restore">
            <b>Restore from a backup</b>
            <p>Adds the projects you do not have. For a project you have already, you choose whether to keep both or replace it.</p>
            {!restore && (
              <label className={`btn ghost bk-pick${busy ? " is-busy" : ""}`}>
                {busy ? "Reading the backup…" : "Choose a backup file…"}
                <input ref={input} className="sr-only" type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => void chosen(e.target.files?.[0])} />
              </label>
            )}
            {restore && (
              <div className="bk-restore">
                <p>
                  Made {new Date(restore.madeAt).toLocaleString()}, with {plural(restore.projects.length, "project")}.
                </p>
                <ul className="bk-list">
                  {restore.projects.map((p) => (
                    <li key={p.id}>
                      <div className="bk-name">
                        <b>{p.title}</b>
                        <span>{holds(p)}</span>
                        {p.here && <span className="bk-here">You have this project already{p.here.title !== p.title ? `, as “${p.here.title}”` : ""}.</span>}
                      </div>
                      {p.here ? (
                        <div className="seg" role="group" aria-label={`What to do with ${p.title}`}>
                          {CHOICES.map((c) => (
                            <button key={c.value} type="button" aria-pressed={choices[p.id] === c.value} onClick={() => choose(p.id, c.value)}>
                              {c.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <label className="bk-take">
                          <input type="checkbox" checked={choices[p.id] !== "skip"} onChange={(e) => choose(p.id, e.target.checked ? undefined : "skip")} />
                          Restore
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
                {linked.length > 0 && <p>{plural(linked.reduce((n, p) => n + p.linkedFiles, 0), "file")} of a linked folder are read where they were; any not on this computer show as missing.</p>}
                {unchosen.length > 0 && <p className="bk-ask">Choose for {plural(unchosen.length, "project")} you have already.</p>}
                <span className="fl-acts">
                  <button className="btn solid" type="button" disabled={busy || unchosen.length > 0 || restoring === 0} onClick={() => (replacing.length ? setAsking(true) : void finish())}>
                    {busy ? "Restoring…" : `Restore ${plural(restoring, "project")}`}
                  </button>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => void cancel()}>
                    Cancel
                  </button>
                </span>
              </div>
            )}
            {done && (
              <div className="bk-done" role="status">
                <p>
                  Restored {plural(done.restored.length, "project")}
                  {done.skipped.length ? `, skipped ${done.skipped.length}` : ""}.
                </p>
                <ul>
                  {done.restored.map((r) => (
                    <li key={r.projectId}>
                      <a href={`/projects/${encodeURIComponent(r.projectId)}`}>{r.title}</a>
                      {r.as === "copy" ? " (a copy beside yours)" : r.as === "replaced" ? " (replaced yours)" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ErrorNotice error={error} />
          </section>
        )}
      </div>
      {asking && (
        <Confirm title={`Replace ${plural(replacing.length, "project")}?`} action="Replace" busy={busy} onConfirm={() => void finish()} onCancel={() => setAsking(false)}>
          <p>The one you have is deleted, with everything in it, and the backup’s is put in its place:</p>
          <ul>
            {replacing.map((p) => (
              <li key={p.id}>{p.here?.title ?? p.title}</li>
            ))}
          </ul>
        </Confirm>
      )}
    </section>
  );
}
