/** The desktop app's own folder dialog, when the page is open in it (desktop/src/preload.cts); absent in a browser. */
export function folderDialog(): (() => Promise<string | undefined>) | undefined {
  const app = (globalThis as { opensourcebook?: { pickFolder?: () => Promise<string | undefined> } }).opensourcebook;
  return typeof app?.pickFolder === "function" ? app.pickFolder : undefined;
}
