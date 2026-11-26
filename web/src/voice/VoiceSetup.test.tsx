import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { sampleVoiceSetup, type FakeRequest } from "../test/fakeEngine";
import { renderWithEngine } from "../test/renderWithEngine";
import { VoiceSetup } from "./VoiceSetup";

const noKey = { ...sampleVoiceSetup, service: undefined, voice: undefined, from: "none" as const, services: sampleVoiceSetup.services.map((s) => (s.where === "hosted" ? { ...s, keySet: false, keyHint: undefined, health: undefined } : s)) };

test("shows the chosen service, that its key is set by its last four characters only, and its voices with the picked one", async () => {
  renderWithEngine(<VoiceSetup />);
  const choice = await screen.findByRole("group", { name: "Where the voice comes from" });
  expect(within(choice).getByRole("button", { name: "Hosted A" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("a1b2")).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("Paste your key")).not.toBeInTheDocument();
  const voices = await screen.findByRole("list", { name: "Hosted A voices" });
  expect(within(voices).getAllByRole("listitem")[0]).toHaveTextContent("WarmCalm and clear. · enPicked");
  expect(within(voices).getByRole("button", { name: "Pick Bright" })).toBeInTheDocument();
  // Only a voice with a sample has a play button.
  expect(within(voices).getByRole("button", { name: "Play Warm" })).toBeInTheDocument();
  expect(within(voices).queryByRole("button", { name: "Play Bright" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Pick a voice" })).toHaveTextContent("Key works");
});

test("a service that offers no samples shows no play button on any voice, even one that says it has a sample", async () => {
  const quiet = { ...sampleVoiceSetup, services: sampleVoiceSetup.services.map((s) => (s.id === "hosted-a" ? { ...s, samples: false } : s)) };
  renderWithEngine(<VoiceSetup />, { "GET /v1/voice": quiet });
  const voices = await screen.findByRole("list", { name: "Hosted A voices" });
  expect(within(voices).getByRole("button", { name: "Pick Bright" })).toBeInTheDocument();
  expect(within(voices).queryByRole("button", { name: /^Play / })).not.toBeInTheDocument();
});

test("sends a typed key once from a password field, empties it, and never shows it again", async () => {
  const typed = "sk-secret-key-9z8y";
  const { calls } = renderWithEngine(<VoiceSetup />, {
    "GET /v1/voice": noKey,
    "PUT /v1/voice/services/:service/key": (req: FakeRequest) => ({ service: { ...noKey.services.find((s) => s.id === req.params.service), keySet: true, keyHint: "9z8y", health: { ok: true } } }),
  });
  const field = await screen.findByLabelText("Your Hosted A API key");
  expect(field).toHaveAttribute("type", "password");
  await userEvent.type(field, typed);
  await userEvent.click(screen.getByRole("button", { name: "Save and check" }));
  const sent = calls.filter((c) => c.method === "PUT" && c.path === "/v1/voice/services/hosted-a/key");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toEqual({ key: typed });
  expect(await screen.findByText("9z8y")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(typed);
  expect(document.querySelector("input")?.value ?? "").not.toContain(typed);
  // With a key, the account's voices are listed; picking one sets the service and the voice.
  await userEvent.click(await screen.findByRole("button", { name: "Pick Bright" }));
  expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/voice")?.body).toEqual({ service: "hosted-a", voice: "v2" });
});

test("a refused key is not kept and the engine's words are shown", async () => {
  renderWithEngine(<VoiceSetup />, {
    "GET /v1/voice": noKey,
    "PUT /v1/voice/services/:service/key": [422, { error: "key_refused", message: "Hosted A did not take that key." }],
  });
  await userEvent.type(await screen.findByLabelText("Your Hosted A API key"), "bad-key");
  await userEvent.click(screen.getByRole("button", { name: "Save and check" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Hosted A did not take that key.");
  expect(screen.getByLabelText("Your Hosted A API key")).toHaveValue("");
});

test("removes a kept key", async () => {
  const { calls } = renderWithEngine(<VoiceSetup />, { "DELETE /v1/voice/services/:service/key": noKey });
  await userEvent.click(await screen.findByRole("button", { name: "Remove key" }));
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/voice/services/hosted-a/key")).toBe(true);
  expect(await screen.findByLabelText("Your Hosted A API key")).toBeInTheDocument();
});

test("a voice on this computer that isn't installed shows its install command, and Check again asks once more", async () => {
  const { calls } = renderWithEngine(<VoiceSetup />);
  await userEvent.click(await screen.findByRole("button", { name: "On this computer" }));
  expect(screen.getByText("npm run voice:local")).toBeInTheDocument();
  expect(screen.getByText("services/scenes")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Pick a voice" })).not.toBeInTheDocument();
  const before = calls.filter((c) => c.path === "/v1/voice").length;
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await vi.waitFor(() => expect(calls.filter((c) => c.path === "/v1/voice").length).toBe(before + 1));
});

test("Install it has the launcher install a voice on this computer, then checks again by itself", async () => {
  const { calls } = renderWithEngine(<VoiceSetup />, {
    "POST /launcher/voices/:id/install": [202, { voice: "local-b", state: "installing", since: "2026-11-26T00:00:00.000Z" }],
    "GET /launcher/voices/:id": { voice: "local-b", state: "done" },
  });
  await userEvent.click(await screen.findByRole("button", { name: "On this computer" }));
  const before = calls.filter((c) => c.path === "/v1/voice").length;
  await userEvent.click(screen.getByRole("button", { name: "Install it" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/launcher/voices/local-b/install")).toBe(true);
  await vi.waitFor(() => expect(calls.filter((c) => c.path === "/v1/voice").length).toBe(before + 1));
});

test("an install that could not finish says why, and the terminal line is still there", async () => {
  renderWithEngine(<VoiceSetup />, {
    "POST /launcher/voices/:id/install": [202, { voice: "local-b", state: "installing", since: "2026-11-26T00:00:00.000Z" }],
    "GET /launcher/voices/:id": { voice: "local-b", state: "failed", message: "It did not finish. What it said is in voice-local-b.log." },
  });
  await userEvent.click(await screen.findByRole("button", { name: "On this computer" }));
  await userEvent.click(screen.getByRole("button", { name: "Install it" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("It did not finish.");
  expect(screen.getByText("npm run voice:local")).toBeInTheDocument();
});

test("compact, with nothing chosen, asks to pick a service first and calls onDone once a voice is picked", async () => {
  const onDone = vi.fn();
  const hostedOnly = { ...noKey, services: [{ ...sampleVoiceSetup.services[0]!, keySet: true }] };
  renderWithEngine(<VoiceSetup compact onDone={onDone} />, { "GET /v1/voice": hostedOnly });
  expect(await screen.findByText("Pick one to see what it needs.")).toBeInTheDocument();
  expect(screen.queryByText(/The voice list comes from your own account/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Hosted A" }));
  await userEvent.click(await screen.findByRole("button", { name: "Pick Warm" }));
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});

test("says plainly when the scenes service is not running", async () => {
  renderWithEngine(<VoiceSetup />, { "GET /v1/voice": [503, { error: "voice_unavailable", message: "x" }] });
  expect(await screen.findByText(/scenes service, which isn't running/)).toBeInTheDocument();
});

test("the key is labelled once, with the engine's own words", async () => {
  renderWithEngine(<VoiceSetup />, { "GET /v1/voice": noKey });
  expect(await screen.findByLabelText("Your Hosted A API key")).toBeInTheDocument();
  expect(screen.queryByText(/Your Hosted A Your/)).not.toBeInTheDocument();
});

test("a voice whose sample cannot be played says so under it, and the next press tries again", async () => {
  const played: string[] = [];
  class FailingAudio {
    onerror: (() => void) | null = null;
    onended: (() => void) | null = null;
    constructor(public src: string) {
      played.push(src);
    }
    pause() {}
    play() {
      queueMicrotask(() => this.onerror?.());
      return Promise.resolve();
    }
  }
  vi.stubGlobal("Audio", FailingAudio);
  try {
    renderWithEngine(<VoiceSetup />);
    const voices = await screen.findByRole("list", { name: "Hosted A voices" });
    await userEvent.click(within(voices).getByRole("button", { name: "Play Warm" }));
    expect(await within(voices).findByText("This voice's sample can't be played right now.")).toBeInTheDocument();
    expect(played[0]).toMatch(/\/v1\/voice\/services\/hosted-a\/voices\/v1\/sample$/);
    expect(within(voices).getByRole("button", { name: "Play Warm" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(within(voices).getByRole("button", { name: "Play Warm" }));
    expect(played).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
