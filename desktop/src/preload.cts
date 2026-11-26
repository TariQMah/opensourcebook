/**
 * What the starting page may ask of the app: the current line, new lines as they come, "Try again" and "Show log".
 * Given only to the app's own page (a file), never to the web app once it shows.
 */
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("desktop", {
    status: () => ipcRenderer.invoke("status"),
    onStatus: (listener: (status: unknown) => void) => ipcRenderer.on("status", (_event, status) => listener(status)),
    retry: () => ipcRenderer.invoke("retry"),
    showLog: () => ipcRenderer.invoke("show-log"),
  });
}
