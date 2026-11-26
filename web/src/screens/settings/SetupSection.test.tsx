import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { forgetThisComputer } from "../../app/thisComputer";
import { renderWithEngine } from "../../test/renderWithEngine";
import { SetupSection } from "./SetupSection";

const idle = { state: "idle" as const };
const launcher = { agents: [], ffmpeg: { found: true, fetch: idle } };

afterEach(() => {
  vi.unstubAllGlobals();
  forgetThisComputer();
});

test("Settings › Get set up shows the same list as first-time setup, on this computer", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "browser" }));
  renderWithEngine(<SetupSection />, { "GET /launcher/setup": launcher });
  expect(screen.getByRole("heading", { name: "Get set up" })).toBeInTheDocument();
  expect(await screen.findByRole("list", { name: "What this computer needs" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
});

test("on a paired phone it says the list is for this computer, with none of its buttons", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "device" }));
  renderWithEngine(<SetupSection />, { "GET /launcher/setup": launcher });
  expect(await screen.findByText("Only in the browser on the computer Open Sourcebook runs on.")).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "What this computer needs" })).not.toBeInTheDocument();
});
