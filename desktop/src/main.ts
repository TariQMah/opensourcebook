/**
 * The desktop app: Open Sourcebook in its own window. Opening it puts the programs in place (first start, or a waiting
 * update), starts the four of them with the launcher in the app data folder, and shows the web app; quitting it stops
 * them. While it starts the window shows one plain line of what is happening; when something goes wrong it says what,
 * with "Try again" and "Show log".
 */
import { appendFileSync, mkdirSync, statSync, truncateSync, readFileSync, watchFile } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { failure, openingTo, reopenRequest, runLauncher } from "./launcher.ts";
import { appDataRoot, carried as carriedIn, layout, APP_NAME } from "./paths.ts";
import { prepare } from "./prepare.ts";
import { resolvePath } from "./shell-path.ts";
import { checkAndDownload, readJson, type Installed } from "./update.ts";

const at = layout(appDataRoot());
const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "out", "resources");
const carried = carriedIn(resources);
const own = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { opensourcebook?: { releases?: string } };

app.setName(APP_NAME);
try {
  mkdirSync(at.shell, { recursive: true });
  // The window's own browser data goes in a folder of its own, not loose in the app data folder beside the programs.
  app.setPath("userData", at.shell);
} catch {
  // A folder that cannot be made is said on the error screen, when the start tries to write in it.
}

function log(text: string): void {
  try {
    mkdirSync(dirname(at.log), { recursive: true });
    if ((statSync(at.log, { throwIfNoEntry: false })?.size ?? 0) > 5_000_000) truncateSync(at.log, 0);
    appendFileSync(at.log, text.endsWith("\n") ? text : `${text}\n`);
  } catch {
    // A log that cannot be written never stops the app.
  }
}

type Status = { kind: "progress"; line: string } | { kind: "error"; line: string; detail?: string };
let status: Status = { kind: "progress", line: "Starting Open Sourcebook" };
let window: BrowserWindow | undefined;
let env: NodeJS.ProcessEnv | undefined;
/** Whether programs of ours may be running, so quitting stops them. */
let started = false;
let starting = false;
let stopped = false;
let webOrigin = "";

function show(next: Status): void {
  status = next;
  log(`${new Date().toISOString()}  ${next.kind === "error" ? "error: " : ""}${next.line}${next.kind === "error" && next.detail ? ` (${next.detail})` : ""}`);
  if (window && !window.isDestroyed() && window.webContents.getURL().startsWith("file:")) window.webContents.send("status", next);
}

const statusPage = () => join(app.getAppPath(), "page", "index.html");

async function launcherEnv(): Promise<NodeJS.ProcessEnv> {
  if (env) return env;
  const { path, fromShell } = await resolvePath({ first: [dirname(carried.node), at.bin] });
  if (!fromShell) log("The login shell did not say its PATH; the usual folders are used.");
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ELECTRON_")));
  // The launcher asks this window, not the browser, for the fresh page a tab from an earlier run wants (reopen below).
  env = { ...clean, PATH: path, OPENSOURCEBOOK_APP_DATA: at.root, OPENSOURCEBOOK_NO_OPEN: "1", OPENSOURCEBOOK_REOPEN_FILE: at.reopen };
  return env;
}

/** Runs the launcher; its answer goes in the log unless it holds a secret (the one-time address that lets the window in). */
const launcher = async (args: string[], onLine?: (line: string) => void, logAnswer = true) =>
  runLauncher(args, { node: carried.node, app: at.app, env: await launcherEnv(), ...(onLine ? { onLine } : {}), ...(logAnswer ? { onLog: (text: string) => log(text) } : {}) });

async function stopPrograms(): Promise<void> {
  if (!readJson(join(at.app, "package.json"))) return;
  const answer = await launcher(["stop", "--json"]);
  if (answer.json?.ok === false) log(`Stopping said: ${failure(answer)}`);
}

async function begin(): Promise<void> {
  if (starting || !window) return;
  starting = true;
  try {
    if (!window.webContents.getURL().startsWith("file:")) await window.loadFile(statusPage());
    show({ kind: "progress", line: "Starting Open Sourcebook" });
    const ready = await prepare({ at, carried, env: await launcherEnv(), say: (line) => show({ kind: "progress", line }), stopRunning: stopPrograms });
    if (ready.warning) log(`Note: ${ready.warning}`);
    if (ready.changed) log(`Updated to ${ready.changed.version}${ready.changed.notes ? `: ${ready.changed.notes}` : ""}`);
    show({ kind: "progress", line: "Starting the programs" });
    started = true;
    const answer = await launcher(["start", "--background", "--json", "--timeout", "60"], (line) => show({ kind: "progress", line }));
    if (answer.json?.ok !== true) throw new Error(failure(answer));
    const open = await launcher(["open", "--print", "--json"], undefined, false);
    const entry = open.json?.open;
    if (open.json?.ok !== true || typeof entry !== "string") throw new Error(failure(open));
    webOrigin = new URL(entry).origin;
    show({ kind: "progress", line: "Opening Open Sourcebook" });
    await window.loadURL(entry);
    if (ready.changed) notify(`Open Sourcebook was updated to ${ready.changed.version}.`, ready.changed.notes);
    setTimeout(() => void lookForUpdate(), 20_000);
  } catch (error) {
    show({ kind: "error", line: "Open Sourcebook could not start.", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    starting = false;
  }
}

/**
 * The window let in again: the launcher asked for a fresh page (the window, or a tab, was let in by an earlier run). It
 * gets its own new one-time address for that page and is brought to the front; with no window, a new one starts.
 */
async function reopen(): Promise<void> {
  let asked: { to: string; at: string } | undefined;
  try {
    asked = reopenRequest(readFileSync(at.reopen, "utf8"));
  } catch {
    return;
  }
  if (!asked) return;
  if (!window) return createWindow();
  if (starting) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const open = await launcher(["open", "--print", "--json"], undefined, false);
  const entry = open.json?.open;
  if (open.json?.ok !== true || typeof entry !== "string") {
    log(`A fresh page was asked for, and could not be opened: ${failure(open)}`);
    return;
  }
  log(`${new Date().toISOString()}  Letting the window in again for ${asked.to}.`);
  await window.loadURL(openingTo(entry, asked.to)).catch((error: unknown) => log(`The fresh page did not load: ${error instanceof Error ? error.message : String(error)}`));
}

function notify(title: string, body?: string): void {
  if (Notification.isSupported()) new Notification({ title, ...(body ? { body } : {}) }).show();
}

async function lookForUpdate(): Promise<void> {
  const repo = own.opensourcebook?.releases;
  if (!repo) return;
  const waiting = await checkAndDownload({ repo, updates: at.updates, installed: readJson<Installed>(at.installed) });
  if (!waiting) return;
  log(`Downloaded ${waiting.version}; it is put in place the next time Open Sourcebook opens.`);
  notify(`Open Sourcebook ${waiting.version} is ready`, `It is used the next time you open Open Sourcebook.${waiting.notes ? ` ${waiting.notes}` : ""}`);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: APP_NAME,
    show: false,
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.once("ready-to-show", () => window?.show());
  // Links to other sites open in the person's own browser; the web app's own pages stay in this window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (webOrigin && url.startsWith(webOrigin)) return { action: "allow" };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:") || (webOrigin && url.startsWith(webOrigin))) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  window.on("closed", () => (window = undefined));
  void begin();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!window) return createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  ipcMain.handle("status", () => status);
  ipcMain.handle("retry", () => void begin());
  ipcMain.handle("show-log", () => shell.openPath(at.log));
  // A folder picked in the system's dialog, for the web app's own page only; undefined when the person cancels.
  ipcMain.handle("pick-folder", async (event) => {
    if (!window || !webOrigin || !event.senderFrame?.url.startsWith(webOrigin)) return undefined;
    const picked = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    return picked.canceled ? undefined : picked.filePaths[0];
  });
  app.whenReady().then(() => {
    createWindow();
    // The launcher writes here when a page asks for a fresh one; only a change counts, never a request left from before.
    watchFile(at.reopen, { interval: 1000 }, (now, before) => {
      if (now.mtimeMs > before.mtimeMs) void reopen();
    });
  });
  app.on("activate", () => {
    if (!window) createWindow();
  });
  // The programs belong to the window: closing it quits, and quitting stops them first.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!started || stopped) return;
    event.preventDefault();
    stopped = true;
    log(`${new Date().toISOString()}  Quitting: stopping the programs.`);
    void stopPrograms().finally(() => app.quit());
  });
}
