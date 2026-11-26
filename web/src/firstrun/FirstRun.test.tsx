import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { redesignRoutes, sampleProviders, sampleSetup, sampleVoiceSetup, type FakeRequest, type Handler } from "../test/fakeEngine";
import { renderApp } from "../test/render";
import { byName, firstStep, needsSetup, summaryLine } from "./rules";
import type { Provider, Providers, SetupState } from "../api/types";

const mark = sampleProviders.providers[0]!.mark;
const base = { added: false, enabled: false, headline: "", pick: "", models: [], efforts: [] };
/** Three agents out of A to Z order: one signed in, one not signed in, one not installed. */
const found: Providers = {
  connector: { configured: true, reachable: true },
  providers: [
    { ...base, id: "agy", label: "Antigravity", state: "missing", install: { command: "npm i -g agy", url: "https://agy.example" }, signIn: "agy login" },
    { ...base, id: "cur", label: "Cursor", mark, state: "signedOut", signIn: "cur login" },
    { ...base, id: "cla", label: "Claude Code", state: "ready" },
  ] satisfies Provider[],
};
const setupOf = (over: Partial<SetupState>): SetupState => ({ ...sampleSetup, ...over });
const fresh = setupOf({ done: false, providers: { connected: 0, ready: 0 }, voice: { set: false, skipped: false } });

/** A fake engine where the providers list changes as the page patches it, like the engine's. */
function engineWith(setup: SetupState, providers: Providers = found, extra: Record<string, Handler> = {}) {
  let list = providers;
  let patched = false;
  return {
    ...redesignRoutes,
    "GET /v1/setup": () => ({ ...setup, providers: patched ? { connected: list.providers.filter((p) => p.added && p.enabled).length, ready: 0 } : setup.providers }),
    "GET /v1/providers": () => list,
    "PATCH /v1/providers/:id": (req: FakeRequest) => {
      patched = true;
      list = { ...list, providers: list.providers.map((p) => (p.id === req.params.id ? { ...p, ...(req.body as object) } : p)) };
      return list;
    },
    ...extra,
  };
}

describe("the redirect rules", () => {
  it("needs setup only when it is not done and the person has not already connected an agent and a voice", () => {
    expect(needsSetup(fresh)).toBe(true);
    expect(needsSetup(setupOf({ providers: { connected: 1, ready: 1 }, voice: { set: false, skipped: false } }))).toBe(true);
    expect(needsSetup(setupOf({ providers: { connected: 1, ready: 1 }, voice: { set: true, skipped: false } }))).toBe(false);
    // A skipped voice step is passed, so setup does not come back to it.
    expect(needsSetup(setupOf({ providers: { connected: 1, ready: 1 }, voice: { set: false, skipped: true } }))).toBe(false);
    expect(needsSetup(setupOf({ providers: { connected: 0, ready: 0 }, voice: { set: false, skipped: true } }))).toBe(true);
    expect(needsSetup(setupOf({ done: true, providers: { connected: 0, ready: 0 }, voice: { set: false, skipped: false } }))).toBe(false);
  });

  it("returns a person to the first step still to do", () => {
    expect(firstStep(fresh)).toBe("providers");
    expect(firstStep(setupOf({ providers: { connected: 2, ready: 1 }, voice: { set: false, skipped: false } }))).toBe("voice");
    expect(firstStep(setupOf({ providers: { connected: 2, ready: 1 }, voice: { set: false, skipped: true } }))).toBe("try");
  });

  it("opens a fresh install on step 1 instead of Home", async () => {
    renderApp("/", engineWith(fresh));
    expect(await screen.findByRole("heading", { name: /Connect (the|your) coding agent/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Your projects" })).not.toBeInTheDocument();
  });

  it("opens Home for someone who is already set up", async () => {
    const routes = engineWith(setupOf({ done: true }), found, { "GET /v1/projects": { projects: [] } });
    renderApp("/", routes);
    await waitFor(() => expect(screen.queryByText("Set up")).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: /Connect (the|your) coding agent/ })).not.toBeInTheDocument();
  });

  it("opens Home when the engine cannot say", async () => {
    renderApp("/", { ...redesignRoutes, "GET /v1/setup": [500, { error: "boom", message: "No" }], "GET /v1/projects": { projects: [] } });
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Connect (the|your) coding agent/ })).not.toBeInTheDocument());
  });

  it("resumes at voice for a person who connected an agent and left", async () => {
    const connected: Providers = { ...found, providers: found.providers.map((p) => (p.id === "cla" ? { ...p, added: true, enabled: true } : p)) };
    renderApp("/", engineWith(setupOf({ ...fresh, providers: { connected: 1, ready: 1 } }), connected));
    expect(await screen.findByRole("heading", { name: "Give your videos and audio a voice" })).toBeInTheDocument();
  });

  it("sends a later step back to the first while no agent is connected", async () => {
    renderApp("/welcome/voice", engineWith(fresh));
    expect(await screen.findByRole("heading", { name: /Connect (the|your) coding agent/ })).toBeInTheDocument();
  });
});

describe("step 1: providers", () => {
  it("lists the agents A to Z with Connect or How to connect, none picked and Next waiting", async () => {
    expect(byName(found.providers).map((p) => p.label)).toEqual(["Antigravity", "Claude Code", "Cursor"]);
    renderApp("/welcome/providers", engineWith(fresh));
    await screen.findByRole("button", { name: "Connect Claude Code" });
    const rows = within(screen.getByRole("list", { name: "Coding agents" })).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual(["Antigravity", "Claude Code", "Cursor"]);
    expect(screen.getByRole("button", { name: "Connect Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How to connect Antigravity" })).toBeInTheDocument();
    expect(screen.getByText("Listed A to Z. Connect at least one to go on.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.queryByText(/default|recommended/i)).not.toBeInTheDocument();
  });

  it("connects one with the engine's own patch, then goes on to voice", async () => {
    const { calls } = renderApp("/welcome/providers", engineWith(fresh));
    await userEvent.click(await screen.findByRole("button", { name: "Connect Claude Code" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/v1/providers/cla", body: { added: true, enabled: true } });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Give your videos and audio a voice" })).toBeInTheDocument();
  });

  it("shows the engine's install and sign-in commands for one that is not found, and Check again asks fresh", async () => {
    const { calls } = renderApp("/welcome/providers", engineWith(fresh));
    await userEvent.click(await screen.findByRole("button", { name: "How to connect Antigravity" }));
    const how = screen.getByRole("group", { name: "How to connect Antigravity" });
    expect(within(how).getByText("npm i -g agy")).toBeInTheDocument();
    expect(within(how).getByText("agy login")).toBeInTheDocument();
    await userEvent.click(within(how).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/providers" && c.query.get("fresh") === "1")).toBe(true));
    // Still not found after the check: it says plainly that a restart is what is left.
    expect(await within(how).findByRole("status")).toHaveTextContent("If you just installed it, close Open Sourcebook and open it again");
  });

  it("links the install page when the agent has no command", async () => {
    const routes = engineWith(fresh, { ...found, providers: [{ ...found.providers[0]!, install: { url: "https://agy.example/install" }, signIn: undefined }] });
    renderApp("/welcome/providers", routes);
    await userEvent.click(await screen.findByRole("button", { name: "How to connect Antigravity" }));
    expect(screen.getByRole("link", { name: "its own page" })).toHaveAttribute("href", "https://agy.example/install");
  });

  it("disconnects a connected one", async () => {
    const connected: Providers = { ...found, providers: found.providers.map((p) => (p.id === "cla" ? { ...p, added: true, enabled: true } : p)) };
    const { calls } = renderApp("/welcome/providers", engineWith(fresh, connected));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Claude Code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeDisabled());
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ body: { added: false, enabled: false } });
  });

  it("says so when the connector cannot be reached", async () => {
    renderApp("/welcome/providers", engineWith(fresh, { ...found, connector: { configured: true, reachable: false } }));
    expect(await screen.findByText(/can't reach the connector/)).toBeInTheDocument();
  });
});

describe("step 2: voice", () => {
  const connectedSetup = setupOf({ providers: { connected: 1, ready: 1 }, voice: { set: false, skipped: false } });
  const noVoice = { ...sampleVoiceSetup, service: undefined, voice: undefined, from: "none" as const };

  it("shows the shared voice form and goes on without a voice, saying what that means", async () => {
    const routes = renderApp("/welcome/voice", engineWith(connectedSetup, found, { "GET /v1/voice": noVoice }));
    expect(await screen.findByText(/Without one, videos have no sound/)).toBeInTheDocument();
    expect(await screen.findByText("Pick one to see what it needs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    const calls = routes.calls;
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("heading", { name: "You're set up" })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/setup")?.body).toEqual({ voice: { skipped: true } });
    expect(await screen.findByText(/no voice yet/)).toBeInTheDocument();
  });

  it("goes back to step 1", async () => {
    renderApp("/welcome/voice", engineWith(connectedSetup, found, { "GET /v1/voice": noVoice }));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: /Connect (the|your) coding agent/ })).toBeInTheDocument();
  });

  it("enables Next once a voice is in use", async () => {
    renderApp("/welcome/voice", engineWith(setupOf({ providers: { connected: 1, ready: 1 }, voice: { set: true, skipped: false } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  });
});

describe("step 3: try it", () => {
  const ready = setupOf({ providers: { connected: 2, ready: 2 }, voice: { set: false, skipped: false } });

  it("sums up what is set from what the engine says", () => {
    expect(summaryLine(2, false)).toBe("2 providers connected · no voice yet");
    expect(summaryLine(1, true)).toBe("1 provider connected · voice set");
  });

  it("marks setup done and opens a new project", async () => {
    const { calls } = renderApp("/welcome/try", engineWith(ready, { ...found, providers: found.providers.map((p) => ({ ...p, added: p.id !== "agy", enabled: p.id !== "agy" })) }, { "GET /v1/projects": { projects: [] } }));
    await userEvent.click(await screen.findByRole("button", { name: /New project/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/setup")?.body).toEqual({ done: true }));
  });

  it("opens the example as the person's own project", async () => {
    const project = { id: "p1", title: "Example", settings: { example: "x" }, createdAt: "2026-11-12T10:00:00.000Z", updatedAt: "2026-11-12T10:00:00.000Z" };
    const { calls } = renderApp(
      "/welcome/try",
      engineWith(ready, { ...found, providers: found.providers.map((p) => ({ ...p, added: true, enabled: true })) }, { "GET /v1/projects": { projects: [] }, "POST /v1/projects/import": [201, project] }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /Open the example/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/setup")?.body).toEqual({ done: true }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.startsWith("/v1/projects"))).toBe(true));
  });
});
