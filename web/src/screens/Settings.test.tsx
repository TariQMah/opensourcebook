import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { redesignRoutes } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const sectionNav = () => screen.findByRole("navigation", { name: "Settings sections" });

test("one page with its sections on the left, What makes what first, and no spend anywhere", async () => {
  renderApp("/settings", redesignRoutes);
  const nav = await sectionNav();
  expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["What makes what", "Providers", "Voice", "Library", "Backups", "Phone", "Reminders", "Appearance", "Advanced"]);
  expect(within(nav).getByRole("link", { name: "What makes what" })).toHaveAttribute("aria-current", "page");
  expect(await screen.findByRole("region", { name: "What makes what" })).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\$\d/);
});

test("each section opens by its hash, and a click on the left opens it", async () => {
  renderApp("/settings#voice", redesignRoutes);
  expect(await screen.findByRole("region", { name: "Voice" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "What makes what" })).not.toBeInTheDocument();
  await userEvent.click(within(await sectionNav()).getByRole("link", { name: "Appearance" }));
  expect(await screen.findByRole("region", { name: "Appearance" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Voice" })).not.toBeInTheDocument();
});

test("the older links still land: #providers, ?provider= and #phone", async () => {
  const first = renderApp("/settings#providers", redesignRoutes);
  expect(await screen.findByRole("region", { name: "Providers" })).toBeInTheDocument();
  first.unmount();
  const second = renderApp("/settings?provider=alpha", redesignRoutes);
  const section = await screen.findByRole("region", { name: "Providers" });
  expect(await within(section).findByRole("region", { name: "Alpha Code" })).toBeInTheDocument();
  second.unmount();
  renderApp("/settings#phone", { ...redesignRoutes, "GET /phone": { on: false, devices: [] } });
  expect(await screen.findByRole("region", { name: "Phone" })).toBeInTheDocument();
});

describe("on a phone", () => {
  afterEach(() => vi.unstubAllGlobals());
  function phoneWidth() {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  }

  test("Settings is a list: What makes what with each row's line, then every other section with its state in a word", async () => {
    phoneWidth();
    renderApp("/settings", { ...redesignRoutes, "GET /phone": { on: false, devices: [] } });
    const makers = await screen.findByRole("region", { name: "What makes what" });
    expect(within(makers).getByRole("button", { name: "Use one for all" })).toBeInTheDocument();
    const rows = within(makers).getAllByRole("button").filter((b) => b.textContent !== "Use one for all");
    expect(rows[0]).toHaveTextContent("The chat");
    expect(rows[1]).toHaveTextContent("videoZ Mid · medium");
    const more = screen.getByRole("region", { name: "More" });
    expect(within(more).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Providers2 ready",
      "VoiceHosted A",
      "Library",
      "Backups",
      expect.stringMatching(/^Phone/),
      expect.stringMatching(/^Reminders/),
      expect.stringMatching(/^Appearance/),
      "Advanced",
    ]);
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
  });

  test("a section opens on its own page with a way back to the list", async () => {
    phoneWidth();
    renderApp("/settings#appearance", redesignRoutes);
    expect(await screen.findByRole("region", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings");
  });

  test("tapping a row opens its choices, and each choice its own picker", async () => {
    phoneWidth();
    renderApp("/settings", redesignRoutes);
    const makers = await screen.findByRole("region", { name: "What makes what" });
    await userEvent.click(within(makers).getByRole("button", { name: /^video/ }));
    const sheet = screen.getByRole("dialog", { name: "video" });
    expect(sheet).toHaveTextContent("Made by Z Mid");
    expect(sheet).toHaveTextContent("Reviewed by: none");
    expect(sheet).toHaveTextContent("Voice: Hosted A");
    await userEvent.click(within(sheet).getByRole("button", { name: /Reviewed by: none/ }));
    expect(screen.getByRole("dialog", { name: "Reviewed by, for videos" })).toBeInTheDocument();
  });
});

// Providers

const claude = {
  id: "claude", label: "Claude Code", local: true, added: true, enabled: true, state: "ready", headline: "Ready", version: "2.1.3", default: true, defaultModel: "haiku", defaultEffort: "medium", workDefault: true, workDefaultModel: "sonnet", workDefaultEffort: "high", pick: "agent:claude",
  models: [
    { id: "haiku", pick: "agent:claude:haiku", label: "Haiku", shown: true, favorite: false },
    { id: "sonnet", pick: "agent:claude:sonnet", label: "Sonnet", shown: true, favorite: false },
    { id: "opus", pick: "agent:claude:opus", label: "Opus", shown: true, favorite: false },
  ],
  efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "max", label: "Max" }],
};
const codex = { id: "codex", label: "Codex", local: true, added: true, enabled: true, state: "unavailable", headline: "Can't run yet", detail: "Open Sourcebook can't run Codex yet: it can't be started with its own shell turned off.", pick: "agent:codex", models: [], efforts: [] };
const pi = { id: "pi", label: "Pi", local: true, added: false, enabled: true, state: "missing", headline: "Not installed", detail: "Install Pi on your computer, then check again.", install: { command: "npm i -g pi-agent", url: "https://pi.example/install" }, signIn: "pi login", pick: "agent:pi", models: [], efforts: [] };
const listed = (...providers: object[]) => ({ connector: { configured: true, reachable: true, checkedAt: new Date().toISOString() }, providers });
const atProviders = "/settings#providers";

test("lists your providers A to Z beside the chosen one's state and models, with nothing marked as preferred", async () => {
  renderApp(atProviders, { "GET /v1/providers": listed(codex, claude, pi) });
  const section = await screen.findByRole("region", { name: "Providers" });
  expect(section).toHaveTextContent("Your own agents answer the chat and make things, on your computer and with your own sign-in. Open Sourcebook never holds their credentials.");
  const list = await within(section).findByRole("list", { name: "Your providers" });
  // Only the providers in the list, A to Z whatever order the engine sends; one not added waits under Add provider.
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("Claude Code"), expect.stringContaining("Codex")]);
  expect(list).not.toHaveTextContent(/default/i);
  expect(list).toHaveTextContent("Can't run yet. Open Sourcebook can't run Codex yet");
  expect(within(list).getByRole("switch", { name: "Use Claude Code" })).toHaveAttribute("aria-checked", "true");
  expect(section).toHaveTextContent("Checked just now");
  const models = within(section).getByRole("list", { name: "Claude Code models" });
  expect(within(models).getByRole("switch", { name: "Show Opus in the pickers" })).toHaveAttribute("aria-checked", "true");
  expect(models).toHaveTextContent("haikudefault");
  expect(models).toHaveTextContent("sonnetwork default");
  const effort = within(section).getByRole("region", { name: "Effort" });
  expect(effort).toHaveTextContent("For longer work it defaults to high.");
  expect(within(effort).getByRole("link", { name: "What makes what" })).toHaveAttribute("href", "/settings#makers");
});

test("turns a provider off, hides and stars a model, keeping what the engine answers", async () => {
  const off = { ...claude, models: [claude.models[0], claude.models[1], { ...claude.models[2], shown: false }] };
  const { calls } = renderApp(atProviders, {
    "GET /v1/providers": listed(claude, codex),
    "PATCH /v1/providers/:id": (req: { params: Record<string, string>; body: unknown }) => listed(off, req.params.id === "codex" ? { ...codex, enabled: false } : codex),
  });
  const section = await screen.findByRole("region", { name: "Providers" });
  await userEvent.click(await within(section).findByRole("switch", { name: "Show Opus in the pickers" }));
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ hiddenModels: ["opus"] });
  expect(await within(section).findByRole("switch", { name: "Show Opus in the pickers" })).toHaveAttribute("aria-checked", "false");
  await userEvent.click(within(section).getByRole("button", { name: "Star Haiku" }));
  expect(calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({ path: "/v1/providers/claude", body: { favoriteModels: ["haiku"] } });
  await userEvent.click(within(section).getByRole("button", { name: "Turn all off" }));
  expect(calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({ path: "/v1/providers/claude", body: { hiddenModels: ["haiku", "sonnet", "opus"] } });
  await userEvent.type(within(section).getByRole("searchbox", { name: "Filter models" }), "zzz");
  expect(within(section).getByText(/No model matches/)).toBeInTheDocument();
  await userEvent.click(within(section).getByRole("switch", { name: "Use Codex" }));
  expect(calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({ path: "/v1/providers/codex", body: { enabled: false } });
  expect(await within(section).findByRole("switch", { name: "Use Codex" })).toHaveAttribute("aria-checked", "false");
});

test("shows a signed-out provider's sign-in command as a step, and checks again fresh", async () => {
  const { calls } = renderApp("/settings?provider=claude", {
    "GET /v1/providers": listed({ ...claude, state: "signedOut", headline: "Not signed in", detail: "Run this on your computer, then check again.", signIn: "claude auth login" }),
  });
  const section = await screen.findByRole("region", { name: "Providers" });
  const how = await within(section).findByRole("list", { name: "How to connect Claude Code" });
  expect(how).toHaveTextContent("Sign in once in a terminal:claude auth login");
  await userEvent.click(within(section).getByRole("button", { name: "Check again" }));
  expect(calls.some((c) => c.method === "GET" && c.path === "/v1/providers" && c.query.get("fresh") === "1")).toBe(true);
});

test("a ready provider says how it answers when its adapter says, else that it is signed in", async () => {
  const note = "Answers with the OpenAI API key in Open Sourcebook's connector settings, billed to that key, as Codex is not signed in.";
  renderApp("/settings?provider=codex", { "GET /v1/providers": listed(claude, { ...codex, state: "ready", headline: "Ready", detail: note }) });
  const section = await screen.findByRole("region", { name: "Providers" });
  expect(await within(section).findByRole("region", { name: "Account" })).toHaveTextContent(note);
  expect(section).not.toHaveTextContent("Signed in on your computer");
});

test("adds a provider in two steps, with how to connect one that isn't installed, and removes one", async () => {
  const { calls } = renderApp(atProviders, {
    "GET /v1/providers": listed(claude, codex, pi),
    "PATCH /v1/providers/:id": (req: { params: Record<string, string>; body: unknown }) =>
      req.params.id === "pi" ? listed(claude, codex, { ...pi, added: true }) : listed({ ...claude, added: false }, codex, pi),
  });
  const section = await screen.findByRole("region", { name: "Providers" });
  await userEvent.click(await within(section).findByRole("button", { name: "Add provider" }));
  const dialog = screen.getByRole("dialog", { name: "Add provider" });
  expect(dialog).toHaveTextContent("Connect an agent on your computer to answer and make things with your own account.");
  expect(within(dialog).getAllByRole("radio").map((r) => r.textContent)).toEqual([expect.stringContaining("Pi")]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  expect(dialog).toHaveTextContent("Install Pi on your computer, then check again.");
  const how = within(dialog).getByRole("list", { name: "How to connect Pi" });
  expect(how).toHaveTextContent("npm i -g pi-agent");
  expect(how).toHaveTextContent("pi login");
  expect(within(how).getByRole("link", { name: "Its install page" })).toHaveAttribute("href", "https://pi.example/install");
  expect(dialog).toHaveTextContent("You can add it now and sign in later.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add Pi" }));
  expect(calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({ path: "/v1/providers/pi", body: { added: true, enabled: true } });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(await within(section).findByRole("region", { name: "Pi" })).toBeInTheDocument();
  await userEvent.click(within(section).getByRole("button", { name: "Remove from your providers" }));
  expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ added: false });
});

test("Add provider is off when every agent is already in the list", async () => {
  renderApp(atProviders, { "GET /v1/providers": listed(claude) });
  const section = await screen.findByRole("region", { name: "Providers" });
  expect(await within(section).findByRole("button", { name: "Add provider" })).toBeDisabled();
});

test("says plainly when the agent's connector is not running, and when none is set up", async () => {
  const first = renderApp(atProviders, { "GET /v1/providers": { connector: { configured: true, reachable: false }, providers: [] } });
  expect(await within(await screen.findByRole("region", { name: "Providers" })).findByText(/Start Open Sourcebook's connector on your computer/)).toBeInTheDocument();
  first.unmount();
  renderApp(atProviders, { "GET /v1/providers": { connector: { configured: false, reachable: false }, providers: [] } });
  expect(await within(await screen.findByRole("region", { name: "Providers" })).findByText(/No agent is connected to this engine/)).toBeInTheDocument();
});

test("says when the engine could not be asked about providers", async () => {
  renderApp(atProviders, { "GET /v1/providers": [500, { error: "x", message: "x" }] });
  expect(await screen.findByText("Couldn't ask the engine about your providers.")).toBeInTheDocument();
});
