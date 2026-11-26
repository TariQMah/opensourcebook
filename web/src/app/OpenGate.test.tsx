import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenGate } from "./OpenGate";

const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("a browser Open Sourcebook let in sees the app", async () => {
  render(<OpenGate fetchImpl={answering(200, { in: true, as: "browser" })}><p>the app</p></OpenGate>);
  expect(await screen.findByText("the app")).toBeInTheDocument();
});

test("a browser Open Sourcebook did not let in sees one plain page that says how to open it, first without a terminal and then the command, and not the app", async () => {
  render(<OpenGate fetchImpl={answering(401, { error: "not_opened", message: "words for other callers" })}><p>the app</p></OpenGate>);
  expect(await screen.findByRole("heading", { name: "Open this page from Open Sourcebook" })).toBeInTheDocument();
  const said = [...document.querySelectorAll("main p")].map((p) => p.textContent);
  expect(said[0]).toMatch(/shortcut|Start menu|Applications/);
  expect(said[0]).toMatch(/If it is already running, that opens a fresh page for you\.$/);
  expect(said[1]).toBe("If you use a terminal, the command is opensourcebook open, or npm run open in its folder.");
  expect(said.join(" ")).not.toMatch(/\bRe\b|npm start/);
  expect(screen.queryByText("words for other callers")).toBeNull();
  expect(screen.queryByText("the app")).toBeNull();
});

test("a web app that was not started by the launcher shows what the proxy says", async () => {
  render(<OpenGate fetchImpl={answering(503, { error: "not_set_up", message: "Open Sourcebook is not running yet." })}><p>the app</p></OpenGate>);
  expect(await screen.findByText("Open Sourcebook is not running yet.")).toBeInTheDocument();
  expect(screen.queryByText(/opens a fresh page/)).toBeNull();
  expect(screen.queryByText("the app")).toBeNull();
});

test("no answer at all shows the app, whose screens say the server is not reachable", async () => {
  const failing = (async () => {
    throw new TypeError("offline");
  }) as unknown as typeof fetch;
  render(<OpenGate fetchImpl={failing}><p>the app</p></OpenGate>);
  expect(await screen.findByText("the app")).toBeInTheDocument();
});

test("a tab let in by an earlier run says Open Sourcebook is running, and its button asks the launcher for a fresh page", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url === "/api/session") return new Response(JSON.stringify({ error: "not_opened", message: "x", earlier: true, canReopen: true }), { status: 401 });
    return new Response(JSON.stringify({ opened: true }), { status: 200 });
  }) as unknown as typeof fetch;
  render(<OpenGate fetchImpl={fetchImpl}><p>the app</p></OpenGate>);
  expect(await screen.findByRole("heading", { name: "Open Sourcebook is running. Let this tab in again" })).toBeInTheDocument();
  expect(document.querySelector("main")!.textContent).not.toMatch(/stopped|Start Open Sourcebook again/);
  await userEvent.click(screen.getByRole("button", { name: "Open a fresh page" }));
  expect(await screen.findByRole("status")).toHaveTextContent("A fresh page of Open Sourcebook is opening in this browser.");
  expect(calls[1]).toMatchObject({ url: "/api/reopen", init: { method: "POST" } });
  expect(screen.getByText(/opensourcebook open/)).toBeInTheDocument();
});

test("an earlier tab with no launcher to ask shows the shortcut and the command, and no button", async () => {
  render(<OpenGate fetchImpl={answering(401, { error: "not_opened", message: "x", earlier: true, canReopen: false })}><p>the app</p></OpenGate>);
  expect(await screen.findByRole("heading", { name: "Open Sourcebook is running. Let this tab in again" })).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText(/It is already running, so this only opens a fresh page\./)).toBeInTheDocument();
});
