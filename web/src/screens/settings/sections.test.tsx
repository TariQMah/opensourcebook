import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { redesignRoutes } from "../../test/fakeEngine";
import { renderApp } from "../../test/render";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

test("Voice holds the voice setup form under its own words", async () => {
  renderApp("/settings#voice", redesignRoutes);
  const section = await screen.findByRole("region", { name: "Voice" });
  expect(section).toHaveTextContent("Without one, videos come out with no sound (captions carry the words) and audio can't be made.");
  expect(await within(section).findByRole("group", { name: "Where the voice comes from" })).toBeInTheDocument();
  expect(section).toHaveTextContent(/The voice list comes from your own account\. "On this computer" needs no key/);
});

test("Voice opens on the service a link asks for with ?voice=", async () => {
  renderApp("/settings?voice=local-b#voice", redesignRoutes);
  const section = await screen.findByRole("region", { name: "Voice" });
  expect(await within(section).findByText(/It isn't installed yet/)).toBeInTheDocument();
  expect(within(section).queryByPlaceholderText("Paste your key")).toBeNull();
});

test("Appearance picks the theme from three pictures and keeps it on this device", async () => {
  renderApp("/settings#appearance", redesignRoutes);
  const themes = await screen.findByRole("radiogroup", { name: "Theme" });
  expect(within(themes).getAllByRole("radio").map((r) => r.textContent)).toEqual(["System", "Light", "Dark"]);
  expect(within(themes).getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  await userEvent.click(within(themes).getByRole("radio", { name: "Dark" }));
  expect(within(themes).getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(window.localStorage.getItem("opensourcebook.theme")).toBe("dark");
});

test("Reminders is a switch that asks the browser, and says what to do when the browser blocks it", async () => {
  const N = Object.assign(function Notification() {}, { permission: "default", requestPermission: vi.fn() });
  const requestPermission = vi.fn(async () => (N.permission = "granted"));
  N.requestPermission = requestPermission;
  vi.stubGlobal("Notification", N);
  const first = renderApp("/settings#reminders", redesignRoutes);
  const section = await screen.findByRole("region", { name: "Reminders" });
  expect(section).toHaveTextContent("Only for plans whose stages you gave days.");
  const daily = within(section).getByRole("switch", { name: "Daily reminder" });
  expect(daily).toHaveAttribute("aria-checked", "false");
  await userEvent.click(daily);
  expect(requestPermission).toHaveBeenCalled();
  expect(await within(section).findByRole("switch", { name: "Daily reminder" })).toHaveAttribute("aria-checked", "true");
  first.unmount();

  vi.stubGlobal("Notification", Object.assign(function Notification() {}, { permission: "denied", requestPermission }));
  renderApp("/settings#reminders", redesignRoutes);
  const blocked = await screen.findByRole("region", { name: "Reminders" });
  expect(within(blocked).getByRole("switch", { name: "Daily reminder" })).toBeDisabled();
  expect(within(blocked).getByRole("status")).toHaveTextContent("This browser blocks notifications from Open Sourcebook.");
});

test("Advanced says how the site reaches the engine, whether the connector is connected, and keeps the video makers' check", async () => {
  const makers = {
    makers: [
      { id: "other", label: "Another maker", description: "Makes it another way.", styles: 0, available: true, default: true },
      { id: "scenes", label: "Drawn scenes", description: "Your own agent draws it.", local: true, styles: 7, available: true, agent: { id: "claude", label: "Claude Code", model: "sonnet", effort: "high" } },
    ],
  };
  const { calls } = renderApp("/settings#advanced", { ...redesignRoutes, "GET /v1/video-makers": makers });
  const section = await screen.findByRole("region", { name: "Advanced" });
  expect(within(section).getByRole("region", { name: "How this site reaches the engine" })).toHaveTextContent("/api proxy");
  expect(await within(section).findByText("Connected")).toBeInTheDocument();
  const video = within(section).getByRole("region", { name: "Video makers" });
  expect(await within(video).findByText("Videos: Drawn scenes")).toBeInTheDocument();
  expect(video).toHaveTextContent("Another maker. VIDEO_MAKER_DEFAULT");
  expect(video).toHaveTextContent("Ready. Pick it as a video's maker. Claude Code writes them (sonnet, high effort).");
  const before = calls.filter((c) => c.path === "/v1/video-makers").length;
  await userEvent.click(within(video).getByRole("button", { name: "Check again" }));
  await vi.waitFor(() => expect(calls.filter((c) => c.path === "/v1/video-makers").length).toBe(before + 1));
});

test("Advanced says when the video maker on this computer is not running", async () => {
  renderApp("/settings#advanced", {
    ...redesignRoutes,
    "GET /v1/video-makers": { makers: [{ id: "scenes", label: "Drawn scenes", description: "d", local: true, styles: 0, available: false, problem: "Drawn scenes needs the scene maker running on this computer." }] },
  });
  expect(await screen.findByText(/needs the scene maker running on this computer/)).toBeInTheDocument();
});

test("Videos is a switch to use more of the computer, off by default, kept by the engine", async () => {
  const app = renderApp("/settings#videos", redesignRoutes);
  const section = await screen.findByRole("region", { name: "Videos" });
  const faster = within(section).getByRole("switch", { name: "Use more of my computer to make videos faster" });
  expect(faster).toHaveAttribute("aria-checked", "false");
  expect(section).toHaveTextContent("Videos draw with about half of this computer, after your own apps");
  await userEvent.click(faster);
  expect(await within(section).findByRole("switch", { name: "Use more of my computer to make videos faster" })).toHaveAttribute("aria-checked", "true");
  expect(section).toHaveTextContent("Videos draw with most of this computer");
  expect(app.calls.find((c) => c.method === "PUT" && c.path === "/v1/drawing")?.body).toEqual({ faster: true });
});

test("Videos shows the switch on when the engine says it is", async () => {
  renderApp("/settings#videos", { ...redesignRoutes, "GET /v1/drawing": { faster: true } });
  const section = await screen.findByRole("region", { name: "Videos" });
  await vi.waitFor(() => expect(within(section).getByRole("switch", { name: "Use more of my computer to make videos faster" })).toHaveAttribute("aria-checked", "true"));
});
