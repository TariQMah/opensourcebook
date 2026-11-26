import { useRef, useState, type DragEvent } from "react";
import { sourceKind } from "../api/measure";
import type { Project, Source, SourceRemoved } from "../api/types";
import { useApi } from "../app/context";
import { ErrorNotice, LoadState } from "../app/Status";
import { Icon } from "../design/Icon";
import { Checkbox } from "../design/ui";
import { addFiles } from "../sources/addFiles";
import { AddSourcesDialog } from "../sources/AddSources";
import { fromDataTransfer } from "../sources/dropped";
import { readableFiles } from "../sources/fileTypes";
import { RemoveSource, RenameSource, SourceMenu } from "../sources/SourceActions";
import { useRetrySource, useSourceNotes } from "../sources/useSourceNotes";
import { extractionText, readMark } from "../sources/sourceText";
import { FolderLink } from "./FolderLink";
import { usable } from "./ticks";

/** The project's sources: tick what the chat may use, add more, open one beside the chat. */
export function SourcesPanel({
  project,
  sources,
  loading,
  error: loadError,
  reload,
  unselected,
  setUnselected,
  onOpen,
  onRemoved,
  onFolderChanged,
}: {
  project: Project;
  sources: Source[];
  loading: boolean;
  error: unknown;
  reload: () => Promise<void>;
  unselected: Set<string>;
  setUnselected: (s: Set<string>) => void;
  onOpen: (id: string) => void;
  /** A source was removed: plans that read it may have changed. */
  onRemoved?: (result: SourceRemoved) => void;
  /** The project's linked folder was linked, unlinked or looked at: the project and its sources may have changed. */
  onFolderChanged?: () => Promise<void>;
}) {
  const client = useApi();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<unknown>();
  const fileInput = useRef<HTMLInputElement>(null);
  const open = !project.archivedAt;
  // A source that could not be read is never ticked or counted; it says why, with Remove, and Try again when that could help.
  const readable = usable(sources);
  const selected = readable.filter((s) => !unselected.has(s.id)).length;
  const { notes, set: setNote } = useSourceNotes(sources);
  const { retrying, retry } = useRetrySource(setNote, reload);
  const [renaming, setRenaming] = useState<string>();
  const [removing, setRemoving] = useState<Source>();

  function toggle(id: string, on: boolean) {
    const next = new Set(unselected);
    if (on) next.delete(id);
    else next.add(id);
    setUnselected(next);
  }
  async function upload(files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      await addFiles(client, files, project.id);
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    // Dropped folders are walked, so what is in them is added too.
    try {
      void upload((await fromDataTransfer(e.dataTransfer, () => readableFiles(client))).files);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section
      className={`col srcs${over ? " over" : ""}`}
      aria-label="Sources"
      onDragOver={(e) => {
        if (!open) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={open ? (e) => void onDrop(e) : undefined}
    >
      <div className="hd">
        <h2>Sources</h2>
        <span className="sp" />
        {readable.length > 0 && (
          <small className="used-n">
            {selected} of {readable.length} used
          </small>
        )}
      </div>
      {open && sources.length > 0 && (
        <div className="srcadd">
          <button className="addbtn" type="button" aria-haspopup="dialog" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            Add sources
          </button>
          {readable.length > 0 && (
            <p className="used-ph">
              <span>
                {selected} of {readable.length} used by the chat and what you make
              </span>
              {selected < readable.length && (
                <button className="link small" type="button" onClick={() => setUnselected(new Set())}>
                  Use all
                </button>
              )}
            </p>
          )}
        </div>
      )}
      <FolderLink project={project} onChanged={() => (onFolderChanged ? onFolderChanged() : reload())} />
      <div className="sc">
        <input ref={fileInput} type="file" multiple hidden aria-label="Files" onChange={(e) => void upload(Array.from(e.target.files ?? []))} />
        {open && adding && (
          <AddSourcesDialog
            projectId={project.id}
            projectTitle={project.title}
            onAdded={() => void reload()}
            onClose={() => setAdding(false)}
          />
        )}
        {busy && <p className="d adding">Adding…</p>}
        <LoadState loading={loading} error={loadError} what="sources" />
        <ErrorNotice error={error} />
        {open && !loading && sources.length === 0 && (
          <>
            <div className={`drop${over ? " over" : ""}`}>
              <span className="big">
                <Icon name="upload" />
              </span>
              <b>Drop anything here</b>
              PDFs, slides, docs, images, audio
              <br />
              <button className="btn" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
                {busy ? "Adding…" : "Choose files"}
              </button>
            </div>
            <button className="way" type="button" onClick={() => setAdding(true)}>
              <Icon name="link" />
              Paste a link
            </button>
            <button className="way" type="button" onClick={() => setAdding(true)}>
              <Icon name="paste" />
              Paste text
            </button>
            <Private />
          </>
        )}
        <ul className="srcs-list">
          {sources.map((s) => {
            const st = extractionText(s.status);
            const failed = s.status === "failed";
            const on = !failed && !unselected.has(s.id);
            const note = notes.get(s.id);
            const mark = readMark(s);
            return (
              <li key={s.id} className={`s${on ? " on" : ""}${failed ? " failed" : ""}`}>
                <Checkbox checked={on} disabled={failed} onChange={(v) => toggle(s.id, v)} label={failed ? `${s.title} could not be read` : `Use ${s.title} in this chat`} />
                <span className="n">
                  {renaming === s.id ? (
                    <RenameSource
                      source={s}
                      onDone={(renamed) => {
                        setRenaming(undefined);
                        if (renamed) void reload();
                      }}
                    />
                  ) : (
                    <button className="nm" type="button" title={`Open ${s.title}`} onClick={() => onOpen(s.id)}>
                      {s.title}
                    </button>
                  )}
                  {s.status === "ready" ? (
                    <small>{sourceKind(s)}</small>
                  ) : (
                    <small className={`st ${st.tone}`}>
                      <span className="dot" aria-hidden="true" />
                      {retrying === s.id ? "Reading…" : failed ? (note?.error ?? st.text) : `${st.text} · ${sourceKind(s)}`}
                    </small>
                  )}
                  {mark && (
                    <small className="mark" title={note?.limitations?.join(" ")}>
                      {mark}
                    </small>
                  )}
                  {s.missingAt && (
                    <small className="mark" title={s.filePath}>
                      Not in the folder any more
                    </small>
                  )}
                  {open && failed && retrying !== s.id && (
                    <span className="acts">
                      {s.retryable !== false && (
                        <button className="link small" type="button" onClick={() => void retry(s)}>
                          Try again
                        </button>
                      )}
                      <button className="link small" type="button" onClick={() => setRemoving(s)}>
                        Remove
                      </button>
                    </span>
                  )}
                </span>
                {renaming !== s.id && (
                  <SourceMenu
                    source={s}
                    onRename={() => setRenaming(s.id)}
                    onRemove={() => setRemoving(s)}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {removing && (
          <RemoveSource
            source={removing}
            place="this project"
            onCancel={() => setRemoving(undefined)}
            onDone={(result) => {
              setRemoving(undefined);
              void reload();
              onRemoved?.(result);
            }}
          />
        )}
      </div>
      {readable.length > 0 && (
        <p className="srchelp">
          <span className="wide">Ticked sources are what the chat and anything you make may use.{open && " Drop files anywhere on this panel to add them."}</span>
          <span className="narrow">Tap a source to read it. Its menu renames or removes it.</span>
        </p>
      )}
    </section>
  );
}

function Private() {
  return (
    <div className="priv">
      <Icon name="lock" />
      Private. Never shared or used for training.
    </div>
  );
}
