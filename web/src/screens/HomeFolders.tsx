import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { Project, ProjectGroup } from "../api/types";
import { useApi } from "../app/context";
import { Confirm } from "../app/Confirm";
import { ErrorNotice } from "../app/Status";
import { Icon } from "../design/Icon";
import { RowMenu } from "../design/RowMenu";

/** "1 project", "3 projects". */
function projectsWord(n: number): string {
  return `${n} project${n === 1 ? "" : "s"}`;
}

/** A folder on Home, as a card in the grid: its name and how many projects it holds; it opens the folder. */
export function FolderCard({ group, count }: { group: ProjectGroup; count: number }) {
  return (
    <div className="pcw">
      <Link className="card pc fc" to={`/?folder=${encodeURIComponent(group.id)}`}>
        <span className="fface" aria-hidden="true">
          <Icon name="folder" />
        </span>
        <div className="pbody">
          <h3 title={group.title}>{group.title}</h3>
          <span className="pfoot">{projectsWord(count)}</span>
        </div>
      </Link>
    </div>
  );
}

/** A name for a folder, typed in place: a new one or a new name. */
function NameForm({ label, start = "", action, busy, error, onSave, onCancel, className }: { label: string; start?: string; action: string; busy?: boolean; error?: unknown; onSave: (title: string) => void; onCancel: () => void; className?: string }) {
  const [title, setTitle] = useState(start);
  function save(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) onSave(title.trim());
    else onCancel();
  }
  return (
    <form className={className} onSubmit={save}>
      <input className="ipt" autoFocus aria-label={label} maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} />
      <span className="acts">
        <button className="mini go" type="submit" disabled={busy}>
          {action}
        </button>
        <button className="mini" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
      <ErrorNotice error={error} />
    </form>
  );
}

/** The quiet tile beside New project that makes a folder, its name typed on the tile. */
export function NewFolderTile({ onMade }: { onMade: (group: ProjectGroup) => void }) {
  const client = useApi();
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function make(title: string) {
    setBusy(true);
    setError(undefined);
    try {
      onMade(await client.createGroup(title));
      setNaming(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  if (naming) return <NameForm className="card pc renaming" label="Folder name" action="Make folder" busy={busy} error={error} onSave={(t) => void make(t)} onCancel={() => setNaming(false)} />;
  return (
    <button type="button" className="pc-new" onClick={() => setNaming(true)}>
      <Icon name="folder" />
      <span>New folder</span>
    </button>
  );
}

/**
 * The top of a folder's page: back to Home, its name, and its menu to rename it or delete it. Deleting a folder puts
 * its projects back on Home; no project is ever deleted with it.
 */
export function FolderHead({ group, count, onChange, onDeleted }: { group: ProjectGroup; count: number; onChange: () => void; onDeleted: (said: string) => void }) {
  const client = useApi();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function rename(title: string) {
    if (title === group.title) return setRenaming(false);
    setBusy(true);
    setError(undefined);
    try {
      await client.renameGroup(group.id, title);
      setRenaming(false);
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      const { moved } = await client.deleteGroup(group.id);
      setDeleting(false);
      onDeleted(`Deleted the folder “${group.title}”. ${moved ? `Its ${projectsWord(moved)} ${moved === 1 ? "is" : "are"} back on Home.` : ""}`.trim());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="folder-head">
      <Link className="link small folder-back" to="/">
        <Icon name="back" />
        Home
      </Link>
      {renaming ? (
        <NameForm className="folder-rename" label="Folder name" start={group.title} action="Save" busy={busy} error={error} onSave={(t) => void rename(t)} onCancel={() => setRenaming(false)} />
      ) : (
        <div className="folder-title">
          <Icon name="folder" />
          <h1>{group.title}</h1>
          <RowMenu
            name={group.title}
            items={[
              { label: "Rename", run: () => setRenaming(true) },
              { label: "Delete folder…", note: "keeps its projects", danger: true, run: () => setDeleting(true) },
            ]}
          />
        </div>
      )}
      {deleting && (
        <Confirm title={`Delete the folder “${group.title}”?`} action="Delete folder" busy={busy} error={error} onConfirm={() => void remove()} onCancel={() => setDeleting(false)}>
          <p>{count ? `Its ${projectsWord(count)} go${count === 1 ? "es" : ""} back on Home, with everything in ${count === 1 ? "it" : "them"}.` : "It is empty."} No project is deleted.</p>
        </Confirm>
      )}
    </div>
  );
}

/**
 * Moves a project into a folder, back on Home, or into a new folder named here. One press moves it; the dialog
 * closes when it is done.
 */
export function MoveToFolder({ project, groups, onMoved, onCancel }: { project: Project; groups: ProjectGroup[]; onMoved: () => void; onCancel: () => void }) {
  const client = useApi();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<unknown>();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && !busy && !naming && onCancel();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, naming, onCancel]);
  async function move(groupId: string | null) {
    setBusy(true);
    setError(undefined);
    try {
      await client.moveProject(project.id, groupId);
      onMoved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function makeAndMove(title: string) {
    setBusy(true);
    setError(undefined);
    try {
      const group = await client.createGroup(title);
      await client.moveProject(project.id, group.id);
      onMoved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  const choices: Array<{ id: string | null; title: string; icon: "home" | "folder" }> = [{ id: null, title: "Home", icon: "home" }, ...groups.map((g) => ({ id: g.id, title: g.title, icon: "folder" as const }))];
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm move-folder" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>Move “{project.title}” to</h2>
        <ul className="move-list">
          {choices.map((c, i) => {
            const here = (project.groupId ?? null) === c.id;
            return (
              <li key={c.id ?? "home"}>
                <button ref={i === 0 ? first : undefined} type="button" className="move-to" disabled={busy || here} aria-current={here ? "true" : undefined} onClick={() => void move(c.id)}>
                  <Icon name={c.icon} />
                  <span>{c.title}</span>
                  {here && <span className="move-here">where it is</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {naming ? (
          <NameForm className="move-new" label="New folder name" action="Make and move" busy={busy} onSave={(t) => void makeAndMove(t)} onCancel={() => setNaming(false)} />
        ) : (
          <button className="link small" type="button" disabled={busy} onClick={() => setNaming(true)}>
            New folder…
          </button>
        )}
        <ErrorNotice error={error} />
        <div className="acts">
          <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
