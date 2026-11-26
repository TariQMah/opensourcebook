import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { Provider, Providers, VoiceSetup } from "../api/types";
import { sampleVoiceSetup, type FakeRequest } from "../test/fakeEngine";
import { renderWithEngine } from "../test/renderWithEngine";
import type { LauncherSetup } from "./api";
import { GetSetUp } from "./GetSetUp";

const base = { added: false, enabled: false, headline: "", pick: "", models: [], efforts: [] };
const agents = (states: Record<string, Provider["state"]>): Providers => ({
  connector: { configured: true, reachable: true },
  providers: [
    { ...base, id: "alpha", label: "Alpha", state: states.alpha ?? "missing", signIn: "alpha login", install: { url: "https://alpha.example" } },
    { ...base, id: "beta", label: "Beta", state: states.beta ?? "missing", signIn: "beta login" },
  ],
});
const idle = { state: "idle" as const };
const launcherOf = (over: Partial<Record<"alpha" | "beta", Partial<LauncherSetup["agents"][number]>>> = {}, ffmpeg = true): LauncherSetup => ({
  agents: [
    { id: "alpha", label: "Alpha", canInstall: true, canSignIn: true, install: idle, signIn: idle, ...over.alpha },
    { id: "beta", label: "Beta", canInstall: false, canSignIn: false, install: idle, signIn: idle, ...over.beta },
  ],
  ffmpeg: { found: ffmpeg, fetch: idle },
});
const noVoice: VoiceSetup = {
  ...sampleVoiceSetup,
  service: undefined,
  voice: undefined,
  from: "none",
  services: sampleVoiceSetup.services.map((s) => (s.where === "hosted" ? { ...s, keySet: false, keyHint: undefined, health: undefined, keySteps: ["Make an account.", "Paste the key here."] } : s)),
};

function row(name: string) {
  return screen.getByText(name, { selector: ".gs-who b" }).closest("li")!;
}

test("everything there: each row says what it found, and Check again asks the connector anew", async () => {
  const { calls } = renderWithEngine(<GetSetUp />, { "GET /v1/providers": agents({ alpha: "ready" }), "GET /launcher/setup": launcherOf() });
  expect(await screen.findByText("Alpha is installed.")).toBeInTheDocument();
  expect(screen.getByText("Alpha is signed in.")).toBeInTheDocument();
  expect(screen.getByText(/Here\. It puts the pictures/)).toBeInTheDocument();
  expect(await screen.findByText("Videos and audio have a voice: Hosted A, Warm.")).toBeInTheDocument();
  const asked = calls.filter((c) => c.path === "/v1/providers").length;
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await vi.waitFor(() => expect(calls.filter((c) => c.path === "/v1/providers").length).toBe(asked + 1));
  expect(calls.filter((c) => c.path === "/v1/providers").at(-1)!.query.get("fresh")).toBe("1");
});

test("no agent: a button installs the one that can be, says it is installing, and the agent is looked for again when it is done", async () => {
  let installed = false;
  let polls = 0;
  const { calls } = renderWithEngine(<GetSetUp />, {
    "GET /v1/providers": () => agents({ alpha: installed ? "signedOut" : "missing" }),
    "GET /launcher/setup": () => {
      polls++;
      const started = calls.some((c) => c.method === "POST" && c.path === "/launcher/agents/alpha/install");
      if (started && polls > 2) installed = true;
      return launcherOf({ alpha: { install: !started ? idle : installed ? { state: "done" } : { state: "installing", since: "now" } } });
    },
    "POST /launcher/agents/:id/install": [202, { state: "installing", since: "now" }],
  });
  const agentRow = await vi.waitFor(() => row("A coding agent"));
  expect(await within(agentRow).findByText(/None is installed yet/)).toBeInTheDocument();
  // Only an agent whose adapter says how is installed with a button.
  expect(within(agentRow).queryByRole("button", { name: "Install Beta" })).not.toBeInTheDocument();
  await userEvent.click(within(agentRow).getByRole("button", { name: "Install Alpha" }));
  expect(await within(agentRow).findByText(/Installing Alpha/)).toBeInTheDocument();
  expect(await screen.findByText("Alpha is installed.", {}, { timeout: 8000 })).toBeInTheDocument();
  // Installed but not signed in is its own state, with its own button.
  expect(screen.getByText("Alpha is installed but not signed in.")).toBeInTheDocument();
  expect(within(row("Signed in")).getByRole("button", { name: "Sign in to Alpha" })).toBeInTheDocument();
}, 15000);

test("installed but not signed in: Sign in starts the agent's own sign-in, shows its page's address, and connects the agent once it is signed in", async () => {
  let signedIn = false;
  const { calls } = renderWithEngine(<GetSetUp />, {
    "GET /v1/providers": () => agents({ alpha: signedIn ? "ready" : "signedOut", beta: "signedOut" }),
    "GET /launcher/setup": () => {
      const started = calls.some((c) => c.method === "POST" && c.path === "/launcher/agents/alpha/sign-in");
      const polls = calls.filter((c) => c.path === "/launcher/setup").length;
      if (started && polls > 3) signedIn = true;
      return launcherOf({ alpha: { signIn: !started ? idle : signedIn ? { state: "done" } : { state: "signingIn", since: "now", url: "https://login.alpha.example/start" } } });
    },
    "POST /launcher/agents/:id/sign-in": [202, { state: "signingIn", since: "now" }],
    "PATCH /v1/providers/:id": (req: FakeRequest) => ({ ...agents({ alpha: "ready" }), patched: req.body }),
  });
  const signIn = await vi.waitFor(() => row("Signed in"));
  expect(await within(signIn).findByText("Alpha and Beta are installed but not signed in.")).toBeInTheDocument();
  // One the launcher can't sign in to says the command, plainly.
  expect(within(signIn).getByText("beta login")).toBeInTheDocument();
  await userEvent.click(within(signIn).getByRole("button", { name: "Sign in to Alpha" }));
  expect(await within(signIn).findByRole("link", { name: "open the sign-in page" })).toHaveAttribute("href", "https://login.alpha.example/start");
  expect(await screen.findByText("Alpha is signed in.", {}, { timeout: 8000 })).toBeInTheDocument();
  expect(calls.find((c) => c.method === "PATCH" && c.path === "/v1/providers/alpha")?.body).toEqual({ added: true, enabled: true });
}, 15000);

test("a sign-in that did not finish says so, with the button to try again", async () => {
  renderWithEngine(<GetSetUp />, {
    "GET /v1/providers": agents({ alpha: "signedOut" }),
    "GET /launcher/setup": launcherOf({ alpha: { signIn: { state: "failed", message: "Alpha's sign-in closed before it finished. Press Sign in to try again." } } }),
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Alpha's sign-in closed before it finished.");
  expect(screen.getByRole("button", { name: "Sign in to Alpha again" })).toBeInTheDocument();
});

test("no ffmpeg: Get ffmpeg asks the launcher for it", async () => {
  const { calls } = renderWithEngine(<GetSetUp />, {
    "GET /v1/providers": agents({ alpha: "ready" }),
    "GET /launcher/setup": launcherOf({}, false),
    "POST /launcher/tools/ffmpeg": [202, { state: "installing", since: "now" }],
  });
  expect(await screen.findByText("Missing, so videos and audio can't be made.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Get ffmpeg" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/launcher/tools/ffmpeg")).toBe(true);
});

test("no voice: the free voice is installed by the launcher and made the voice in use; a key's steps are a button away", async () => {
  let voice: VoiceSetup = noVoice;
  const { calls } = renderWithEngine(<GetSetUp />, {
    "GET /v1/providers": agents({ alpha: "ready" }),
    "GET /launcher/setup": launcherOf(),
    "GET /v1/voice": () => voice,
    "POST /launcher/voices/:id/install": [202, { voice: "local-b", state: "done" }],
    "PUT /v1/voice": (req: FakeRequest) => {
      voice = { ...noVoice, service: (req.body as { service: string }).service, from: "app" };
      return voice;
    },
  });
  const voiceRow = await vi.waitFor(() => row("A voice"));
  expect(await within(voiceRow).findByText(/None yet: videos have captions and no sound/)).toBeInTheDocument();
  await userEvent.click(within(voiceRow).getByRole("button", { name: "Use your Hosted A key instead" }));
  expect(within(screen.getByRole("list", { name: "How to get a Hosted A key" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Make an account.", "Paste the key here."]);
  await userEvent.click(within(voiceRow).getByRole("button", { name: "Set up the free voice" }));
  expect(await screen.findByText("Videos and audio have a voice: On this computer.")).toBeInTheDocument();
  expect(calls.some((c) => c.method === "POST" && c.path === "/launcher/voices/local-b/install")).toBe(true);
  expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/voice")?.body).toEqual({ service: "local-b", voice: null });
});

test("without the launcher, an agent's own install page is offered instead of a button", async () => {
  renderWithEngine(<GetSetUp />, { "GET /v1/providers": agents({}), "GET /launcher/setup": [502, { error: "launcher_unreachable", message: "The launcher did not answer." }] });
  expect(await screen.findByRole("link", { name: "Alpha" })).toHaveAttribute("href", "https://alpha.example");
  expect(screen.getByText("Can't be checked from this page.")).toBeInTheDocument();
});
