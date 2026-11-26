import { useEffect, useRef, useState } from "react";
import type { FolderCheck, Project } from "../api/types";
import { useApi } from "../app/context";
import { ErrorNotice } from "../app/Status";
import { useThisComputer } from "../app/thisComputer";
import { FolderField } from "../app/FolderField";
import { foundWords } from "./folderWords";

/**
 * A project linked to a folder on this computer: its files are its sources, read where they are. Shown only in the
 * browser on this computer. Linked, the folder is looked at again when the project opens and on "Check folder";
 * the line under it says what the last look found.
 */
export function FolderLink({ project, onChanged }: { project: Project; onChanged: (project: Project) => void | Promise<void> }) {
  const client = useApi();
  const here = useThisComputer();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<FolderCheck>();
  const [error, setError] = useState<unknown>();
  const looked = useRef<string>(undefined);

  /** Does one thing with the folder; true when it was done. */
  async function run(act: () => Promise<{ project: Project; check?: FolderCheck } | Project>): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      const done = await act();
      const next = "check" in done || "project" in done ? (done as { project: Project }).project : (done as Project);
      setFound("check" in done ? done.check : undefined);
      await onChanged(next);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Each time the project opens, its folder is looked at once.
  useEffect(() => {
    if (!here || !project.folder || project.archivedAt || looked.current === project.id) return;
    looked.current = project.id;
    void run(() => client.checkFolder(project.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, project.id, project.folder]);

  if (!here) return project.folder ? <p className="folderlink quiet">Linked to a folder on your computer.</p> : null;
  if (project.archivedAt && !project.folder) return null;

  if (!project.folder) {
    return (
      <div className="folderlink">
        {picking ? (
          <FolderField
            label="Folder to link"
            action="Link"
            busy={busy}
            onPick={(path) => void run(() => client.linkFolder(project.id, path)).then((ok) => ok && setPicking(false))}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <button className="link small" type="button" onClick={() => setPicking(true)}>
            Link a folder on this computer
          </button>
        )}
        <ErrorNotice error={error} />
      </div>
    );
  }

  return (
    <div className="folderlink" aria-label="Linked folder">
      <p className="fl-path" title={project.folder}>
        Linked to <code>{project.folder}</code>
      </p>
      <span className="fl-acts">
        {!project.archivedAt && (
          <button className="mini" type="button" disabled={busy} onClick={() => void run(() => client.checkFolder(project.id))}>
            {busy ? "Checking…" : "Check folder"}
          </button>
        )}
        <button className="link small" type="button" disabled={busy} onClick={() => void run(() => client.unlinkFolder(project.id))}>
          Unlink
        </button>
      </span>
      {found && <p className="fl-found" role="status">{foundWords(found)}</p>}
      <ErrorNotice error={error} />
    </div>
  );
}
