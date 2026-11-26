import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import type { RestoreChoice, RestoreView } from "../../api/types";
import { Ctx } from "../../app/context";
import { forgetThisComputer } from "../../app/thisComputer";
import { BackupsSection } from "./BackupsSection";

function show(client: Partial<ApiClient>) {
  const app = { client: { backupUrl: () => "/api/v1/backup", ...client } as ApiClient, formats: [], edgeKinds: [], refreshInbox: () => undefined };
  return render(
    <MemoryRouter>
      <Ctx.Provider value={app}>
        <BackupsSection />
      </Ctx.Provider>
    </MemoryRouter>,
  );
}

const view: RestoreView = {
  id: "r1",
  madeAt: "2026-11-26T08:00:00.000Z",
  projects: [
    { id: "p1", title: "Tides", archived: false, sources: 2, outputs: 1, chats: 1, linkedFiles: 0, here: { title: "Tides" } },
    { id: "p2", title: "Cells", archived: false, sources: 1, outputs: 0, chats: 0, linkedFiles: 3, linkedFolder: "/Users/me/Notes" },
  ],
};

const onThisComputer = () => vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "browser" }));

afterEach(() => {
  vi.unstubAllGlobals();
  forgetThisComputer();
});

describe("Settings › Backups", () => {
  it("backs up by a download of the whole file, on this computer only", async () => {
    onThisComputer();
    show({});
    const link = await screen.findByRole("link", { name: "Back up now" });
    expect(link).toHaveAttribute("href", "/api/v1/backup");
    expect(link).toHaveAttribute("download");
  });

  it("on a paired phone says it is for this computer, and offers no restore", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "device" }));
    show({});
    expect(await screen.findByText("Only in the browser on the computer Open Sourcebook runs on.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back up now" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose a backup file/)).not.toBeInTheDocument();
  });

  it("restores only once every project here has a choice, and asks again before replacing", async () => {
    onThisComputer();
    const sent: Array<Record<string, RestoreChoice>> = [];
    show({
      startRestore: async () => view,
      finishRestore: async (_id: string, choices: Record<string, RestoreChoice>) => {
        sent.push(choices);
        return { restored: [{ from: "p1", projectId: "p1", title: "Tides", as: "replaced" as const }, { from: "p2", projectId: "p2", title: "Cells", as: "added" as const }], skipped: [] };
      },
    });
    await userEvent.upload(await screen.findByLabelText(/Choose a backup file/), new File(["zip"], "backup.zip", { type: "application/zip" }));
    expect(await screen.findByText("You have this project already.")).toBeInTheDocument();
    expect(screen.getByText(/3 files of a linked folder are read where they were/)).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Restore 2 projects" });
    expect(go).toBeDisabled();
    await userEvent.click(within(screen.getByRole("group", { name: "What to do with Tides" })).getByRole("button", { name: "Replace" }));
    await userEvent.click(go);
    const ask = screen.getByRole("alertdialog", { name: "Replace 1 project?" });
    expect(sent).toEqual([]);
    await userEvent.click(within(ask).getByRole("button", { name: "Replace" }));
    expect(sent).toEqual([{ p1: "replace" }]);
    expect(await screen.findByText("Restored 2 projects.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tides" })).toHaveAttribute("href", "/projects/p1");
  });

  it("leaves out a project not ticked, and Cancel lets the backup go", async () => {
    onThisComputer();
    const cancelled: string[] = [];
    const sent: Array<Record<string, RestoreChoice>> = [];
    show({
      startRestore: async () => view,
      cancelRestore: async (id: string) => void cancelled.push(id),
      finishRestore: async (_id: string, choices: Record<string, RestoreChoice>) => (sent.push(choices), { restored: [], skipped: [] }),
    });
    await userEvent.upload(await screen.findByLabelText(/Choose a backup file/), new File(["zip"], "backup.zip"));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Restore" }));
    await userEvent.click(within(screen.getByRole("group", { name: "What to do with Tides" })).getByRole("button", { name: "Keep both" }));
    await userEvent.click(screen.getByRole("button", { name: "Restore 1 project" }));
    expect(sent).toEqual([{ p1: "keep-both", p2: "skip" }]);
    await userEvent.upload(screen.getByLabelText(/Choose a backup file/), new File(["zip"], "backup.zip"));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelled).toEqual(["r1"]);
    expect(screen.getByLabelText(/Choose a backup file/)).toBeInTheDocument();
  });
});
