// The starting page: one line of what is happening, or what went wrong with "Try again" and "Show log".
const $ = (id) => document.getElementById(id);
const FIRST = /first start|Installing|Downloading|Getting Open Sourcebook ready|Putting Open Sourcebook in place/i;

function render(status) {
  if (!status) return;
  const failed = status.kind === "error";
  $("title").textContent = failed ? status.line : "Starting Open Sourcebook";
  $("line").textContent = failed ? "" : status.line;
  $("line").classList.toggle("dots", !failed);
  $("line").hidden = failed;
  $("failed").hidden = !failed;
  $("detail").textContent = failed ? status.detail || "" : "";
  if (!failed && FIRST.test(status.line)) $("first").hidden = false;
  if (failed) $("first").hidden = true;
}

if (window.desktop) {
  window.desktop.onStatus(render);
  window.desktop.status().then(render);
  $("retry").addEventListener("click", () => {
    render({ kind: "progress", line: "Trying again" });
    window.desktop.retry();
  });
  $("log").addEventListener("click", () => window.desktop.showLog());
}
