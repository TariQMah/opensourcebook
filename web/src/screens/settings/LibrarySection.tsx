import { useId, useState } from "react";
import { useApi } from "../../app/context";
import { FolderField } from "../../app/FolderField";
import { ErrorNotice } from "../../app/Status";
import { useLoad } from "../../app/useLoad";
import { useThisComputer } from "../../app/thisComputer";
import { SectionHead } from "./SectionHead";

/**
 * Settings › Library: the folder finished videos are copied into, one folder per project (a project linked to a
 * folder gets its videos there instead). Only the browser on this computer changes it.
 */
export function LibrarySection() {
  const heading = useId();
  const client = useApi();
  const here = useThisComputer();
  const library = useLoad(() => client.library(), [client]);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function pick(folder: string | null) {
    setBusy(true);
    setError(undefined);
    try {
      library.set(await client.setLibrary(folder));
      setChanging(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Library">
        Where finished videos are saved on this computer, in a folder for each project. Open Sourcebook never moves, renames or deletes anything in it.
      </SectionHead>
      <div className="card sx-rows">
        <section className="sx-arow" aria-label="Library folder">
          <b>Library folder</b>
          {library.loading && !library.data ? (
            <p>Checking…</p>
          ) : library.data ? (
            <p>
              <code>{library.data.folder}</code>
              {!library.data.chosen && " (the usual one)"}
            </p>
          ) : (
            <p>Only when Open Sourcebook runs on your own computer.</p>
          )}
          {here && library.data && !changing && (
            <span className="fl-acts">
              <button className="mini" type="button" onClick={() => setChanging(true)}>
                Change
              </button>
              {library.data.chosen && (
                <button className="link small" type="button" disabled={busy} onClick={() => void pick(null)}>
                  Use the usual one
                </button>
              )}
            </span>
          )}
          {here && changing && <FolderField label="Library folder" action="Use this folder" busy={busy} onPick={(folder) => void pick(folder)} onCancel={() => setChanging(false)} />}
          <ErrorNotice error={error} />
        </section>
      </div>
    </section>
  );
}
