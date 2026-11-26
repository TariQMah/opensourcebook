/**
 * What the starting page may ask of the app: the current line, new lines as they come, "Try again" and "Show log".
 * Given only to the app's own page (a file). The web app on this computer gets one thing only: picking a folder.
 */
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("desktop", {
    status: () => ipcRenderer.invoke("status"),
    onStatus: (listener: (status: unknown) => void) => ipcRenderer.on("status", (_event, status) => listener(status)),
    retry: () => ipcRenderer.invoke("retry"),
    showLog: () => ipcRenderer.invoke("show-log"),
  });
} else if (location.protocol === "http:" && location.hostname === "127.0.0.1") {
  // The web app on this computer: a folder picked in the system's own dialog (a project's folder, the library).
  contextBridge.exposeInMainWorld("opensourcebook", { pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("pick-folder") });
}
