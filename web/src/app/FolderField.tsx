import { useState } from "react";
import { folderDialog } from "./folderDialog";


/**
 * Picking a folder on this computer: the system's own dialog in the desktop app, else the folder's whole path typed
 * in (a browser cannot name a folder on the disk).
 */
export function FolderField({
  label,
  action,
  busy,
  onPick,
  onCancel,
}: {
  label: string;
  action: string;
  busy?: boolean;
  onPick: (path: string) => void;
  onCancel?: () => void;
}) {
  const dialog = folderDialog();
  const [path, setPath] = useState("");
  if (dialog) {
    return (
      <span className="folderfield">
        <button
          className="mini"
          type="button"
          disabled={busy}
          onClick={() =>
            void dialog().then((picked) => {
              if (picked) onPick(picked);
              else onCancel?.();
            })
          }
        >
          {busy ? "Working…" : "Choose a folder…"}
        </button>
        {onCancel && (
          <button className="link small" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </span>
    );
  }
  return (
    <form
      className="folderfield"
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim()) onPick(path.trim());
      }}
    >
      <input type="text" aria-label={label} placeholder="/Users/you/Documents/Course" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} />
      <button className="mini" type="submit" disabled={busy || !path.trim()}>
        {busy ? "Working…" : action}
      </button>
      {onCancel && (
        <button className="link small" type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
      <small>The folder's whole path on this computer.</small>
    </form>
  );
}
