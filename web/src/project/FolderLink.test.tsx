import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { FolderCheck, Project } from "../api/types";
import { Ctx } from "../app/context";
import { forgetThisComputer } from "../app/thisComputer";
import { FolderLink } from "./FolderLink";
import { foundWords } from "./folderWords";

const project: Project = { id: "p1", title: "Cells", settings: {}, createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z" };
const check = (over: Partial<FolderCheck> = {}): FolderCheck => ({ folder: "/Users/me/Course", added: [], changed: [], missing: [], unchanged: 0, failed: [], skipped: 0, more: false, ...over });

function at(as: "browser" | "device") {
  vi.stubGlobal("fetch", async () => Response.json({ in: true, as }));
}

function show(ui: React.ReactNode, client: Partial<ApiClient>) {
  const app = { client: client as ApiClient, formats: [], edgeKinds: [], refreshInbox: () => undefined };
  return render(
    <MemoryRouter>
      <Ctx.Provider value={app}>{ui}</Ctx.Provider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetThisComputer();
  delete (globalThis as { opensourcebook?: unknown }).opensourcebook;
});

describe("a project linked to a folder", () => {
  it("is linked by typing the folder's path in a browser, then says what was found", async () => {
    at("browser");
    const linked: string[] = [];
    const changed: Project[] = [];
    show(<FolderLink project={project} onChanged={(p) => void changed.push(p)} />, {
      linkFolder: async (_id: string, path: string) => (linked.push(path), { project: { ...project, folder: path }, check: check({ added: ["a.md", "b.pdf"] }) }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Link a folder on this computer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Folder to link" }), "/Users/me/Course");
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(linked).toEqual(["/Users/me/Course"]);
    expect(changed.at(-1)?.folder).toBe("/Users/me/Course");
  });

  it("uses the desktop app's own folder dialog when it has one", async () => {
    at("browser");
    (globalThis as { opensourcebook?: unknown }).opensourcebook = { pickFolder: async () => "/Users/me/Picked" };
    const linked: string[] = [];
    show(<FolderLink project={project} onChanged={() => undefined} />, {
      linkFolder: async (_id: string, path: string) => (linked.push(path), { project: { ...project, folder: path }, check: check() }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Link a folder on this computer" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    expect(linked).toEqual(["/Users/me/Picked"]);
  });

  it("looks at a linked folder once when the project opens, and again on Check folder", async () => {
    at("browser");
    let checks = 0;
    show(<FolderLink project={{ ...project, folder: "/Users/me/Course" }} onChanged={() => undefined} />, {
      checkFolder: async () => (checks++, { project: { ...project, folder: "/Users/me/Course" }, check: check({ changed: ["a.md"], missing: ["b.md"] }) }),
    });
    expect(await screen.findByRole("status")).toHaveTextContent("1 read again, 1 no longer there.");
    expect(checks).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Check folder" }));
    expect(checks).toBe(2);
  });

  it("a paired phone sees that it is linked, with nothing to change and no look at the folder", async () => {
    at("device");
    let checks = 0;
    show(<FolderLink project={{ ...project, folder: "/Users/me/Course" }} onChanged={() => undefined} />, { checkFolder: async () => (checks++, { project, check: check() }) });
    expect(await screen.findByText("Linked to a folder on your computer.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button")).toBeNull();
    expect(checks).toBe(0);
  });

  it("says what a look found in one line", () => {
    expect(foundWords(check())).toBe("Nothing changed.");
    expect(foundWords(check({ added: ["a"], failed: [{ path: "b", message: "no" }] }))).toBe("1 added, 1 could not be read.");
    expect(foundWords(check({ more: true }))).toMatch(/first 1000/);
  });
});
