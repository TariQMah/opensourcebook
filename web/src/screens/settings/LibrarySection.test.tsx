import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import type { Library } from "../../api/types";
import { Ctx } from "../../app/context";
import { forgetThisComputer } from "../../app/thisComputer";
import { LibrarySection } from "./LibrarySection";

function show(client: Partial<ApiClient>) {
  const app = { client: client as ApiClient, formats: [], edgeKinds: [], refreshInbox: () => undefined };
  return render(
    <MemoryRouter>
      <Ctx.Provider value={app}>
        <LibrarySection />
      </Ctx.Provider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetThisComputer();
});

describe("Settings › Library", () => {
  it("shows the library folder and changes it on this computer", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "browser" }));
    let library: Library = { folder: "/Users/me/Documents/Open Sourcebook", chosen: false };
    show({
      library: async () => library,
      setLibrary: async (folder: string | null) => (library = folder ? { folder, chosen: true } : { folder: "/Users/me/Documents/Open Sourcebook", chosen: false }),
    });
    expect(await screen.findByText("/Users/me/Documents/Open Sourcebook")).toBeInTheDocument();
    expect(screen.getByText(/the usual one/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Library folder" }), "/Users/me/Videos");
    await userEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(await screen.findByText("/Users/me/Videos")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use the usual one" }));
    expect(await screen.findByText("/Users/me/Documents/Open Sourcebook")).toBeInTheDocument();
  });
});
