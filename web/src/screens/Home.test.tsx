import { ICONS } from "../design/icons";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formats, now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const project = (id: string, title: string, category?: string, settings: Record<string, string> = {}) => ({
  id, title, settings, createdAt: now, updatedAt: now, ...(category ? { category } : {}),
});

const routes = {
  "GET /v1/projects": { projects: [project("p1", "Calculus I", "math"), project("p2", "Untitled")] },
  "GET /v1/projects/:id": ({ params, query }: { params: Record<string, string>; query: URLSearchParams }) => ({
    project: params.id === "p1" ? project("p1", "Calculus I", "math") : project("p2", "Untitled"),
    ...(query.get("counts") === "1"
      ? { counts: params.id === "p1" ? { chats: 1, plans: 1, outputs: 1, sources: 3 } : { chats: 0, plans: 0, outputs: 0, sources: 0 } }
      : {}),
  }),
  "GET /v1/projects/:id/plans": ({ params }: { params: Record<string, string> }) =>
    params.id === "p1"
      ? { plans: [{ id: "pl1", projectId: "p1", version: 1, status: "running", createdAt: now, updatedAt: now, counts: { total: 4, done: 1 } }] }
      : { plans: [] },
  "GET /v1/projects/:id/sources": { sources: [{ id: "s1", kind: "pdf", status: "ready", createdAt: now, updatedAt: now }] },
  "GET /v1/plans/:id": {
    plan: { id: "pl1", projectId: "p1", title: "Unit 1", version: 1, status: "running", createdAt: now, updatedAt: now },
    stages: [], edges: [], counts: { total: 4, done: 1 }, estimateUsd: 0, issues: [],
    items: [{ id: "i1", level: 1, ord: 0, type: "byte", title: "Limits, the long read", settings: {}, enabled: true, status: "done", sources: [], done: false, outputId: "o7" }],
  },
  "GET /v1/projects/:id/usage": { usage: { calls: 2, failedCalls: 0, tokensIn: 10, tokensOut: 10, usd: 0.42, unpricedCalls: 0 } },
  "GET /v1/projects/:id/outputs": ({ params }: { params: Record<string, string> }) => ({ outputs: params.id === "p1" ? [{ id: "o7", type: "byte", title: "Limits, the long read", schemaVersion: 2, createdAt: now, updatedAt: now, glimpse: { text: "A limit is where a function heads" } }] : [] }),
  "GET /v1/inbox": { sources: [{ id: "s1", kind: "web", status: "ready", createdAt: now, updatedAt: now }] },
};

/** A status line whose first word is drawn in its own element, matched by all its words. */
const statusText = (words: string) => (_: string, el: Element | null) => el?.classList.contains("making-st") === true && el.textContent === words;

test("top bar has Open Sourcebook, Projects and Library tabs and search; Inbox leaves the menu while /inbox still works; bottom links stay plain", async () => {
  renderApp("/", routes);
  const banner = screen.getByRole("banner");
  expect(within(banner).getByRole("link", { name: "Open Sourcebook home" })).toHaveAttribute("href", "/");
  const nav = within(banner).getByRole("navigation", { name: "Main" });
  expect(within(nav).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
    ["Projects", "/"],
    ["Library", "/library"],
  ]);
  expect(within(nav).queryByText(/Inbox/)).not.toBeInTheDocument();
  expect(within(banner).getByRole("searchbox", { name: "Search projects" })).toBeInTheDocument();

  const footer = screen.getByRole("contentinfo");
  expect(within(footer).getByRole("button", { name: "Open on your phone" })).toBeInTheDocument();
  expect(within(footer).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  expect(await screen.findByText("Calculus I")).toBeInTheDocument();
  expect(screen.queryByText(/Drop a file here to start/)).not.toBeInTheDocument();
});

test("every project card has the same fixed footer (sources and things made) and no unlabelled play icons; special tags sit on the picture", async () => {
  const runningVideo = {
    plan: { id: "pl2", projectId: "p2", title: "Lesson", version: 1, status: "running", createdAt: now, updatedAt: now },
    stages: [], edges: [], counts: { total: 1, done: 0 }, estimateUsd: 0, issues: [],
    items: [{ id: "i2", level: 1, ord: 0, type: "video", title: "Intro video", settings: {}, enabled: true, status: "running", sources: [], done: false }],
  };
  const { calls } = renderApp("/", {
    ...routes,
    "GET /v1/formats": { formats: [...formats, { id: "guide", label: "guide", colorSlot: 4, icon: "book", settings: [], defaults: {}, ready: true }] },
    "GET /v1/projects": {
      projects: [
        project("p1", "Calculus I", "math"),
        project("p2", "Physics", undefined, { example: "moon-phases" }),
      ],
    },
    "GET /v1/projects/:id": ({ params, query }: { params: Record<string, string>; query: URLSearchParams }) => ({
      project: params.id === "p1" ? project("p1", "Calculus I", "math") : project("p2", "Physics", undefined, { example: "moon-phases" }),
      ...(query.get("counts") === "1"
        ? { counts: params.id === "p1" ? { chats: 1, plans: 1, outputs: 1, sources: 3 } : { chats: 0, plans: 1, outputs: 0, sources: 0 } }
        : {}),
    }),
    "GET /v1/projects/:id/plans": ({ params }: { params: Record<string, string> }) =>
      params.id === "p1"
        ? { plans: [{ id: "pl1", projectId: "p1", version: 1, status: "running", createdAt: now, updatedAt: now, counts: { total: 4, done: 1 } }] }
        : { plans: [{ id: "pl2", projectId: "p2", version: 1, status: "running", createdAt: now, updatedAt: now, counts: { total: 1, done: 0 } }] },
    "GET /v1/plans/:id": ({ params }: { params: Record<string, string> }) => (params.id === "pl1" ? routes["GET /v1/plans/:id"] : runningVideo),
  });

  const calc = (await screen.findByText("Calculus I")).closest("a")!;
  expect(calc).toHaveAttribute("href", "/projects/p1");
  expect(calc.querySelector(".face .said")?.textContent).toBe("A limit is where a function heads");
  // The shape's tile sits at the picture's corner, named for a screen reader; the footer has no play icon.
  expect(calc.querySelector(".pface .ftile")).toHaveAttribute("title", "flashcards");
  expect(calc.querySelector(".pfoot .ftile")).toBeNull();
  const calcFoot = calc.querySelector(".pfoot")!;
  expect(calcFoot).toHaveTextContent("3 sources1 item made");
  // The sources count wears the page icon and the made count the stacked layers, as drawn.
  const paths = (svg: Element | undefined) => [...(svg?.querySelectorAll("path") ?? [])].map((e) => e.getAttribute("d"));
  const [pageIcon, layersIcon] = [...calcFoot.querySelectorAll(".pstat svg")];
  expect(paths(pageIcon)).toEqual([...ICONS.page!.matchAll(/d="([^"]+)"/g)].map((m) => m[1]));
  expect(paths(layersIcon)).toEqual([...ICONS.layers!.matchAll(/d="([^"]+)"/g)].map((m) => m[1]));
  expect(calc.textContent).not.toMatch(/\$|math|Nothing made yet/);

  const phys = (await screen.findByText("Physics")).closest("a")!;
  const physFace = phys.querySelector(".pface")!;
  const physFoot = phys.querySelector(".pfoot")!;
  expect(within(physFace as HTMLElement).getByText("Example")).toBeInTheDocument();
  // The making line is beside the link, not inside it, so Stop is a real button; no minutes when the maker gave none.
  const card = phys.closest(".pcw") as HTMLElement;
  expect(within(card).getByText(statusText("Making video"))).toBeInTheDocument();
  expect(within(card).getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(physFoot).toHaveTextContent("0 sources0 items made");
  expect(physFoot).not.toHaveTextContent(/Example|Making/);
  expect(calls.some((c) => c.path === "/v1/outputs")).toBe(false);
});

test("top-bar search filters projects by title and clears cleanly", async () => {
  renderApp("/", routes);
  await screen.findByText("Calculus I");
  const search = screen.getByRole("searchbox", { name: "Search projects" });
  await userEvent.type(search, "calc");
  expect(screen.getByText("Calculus I")).toBeInTheDocument();
  expect(screen.queryByText("Untitled")).not.toBeInTheDocument();

  await userEvent.clear(search);
  await userEvent.type(search, "biology");
  expect(await screen.findByText("Nothing matches “biology”")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "clear the search" }));
  expect(screen.getByText("Untitled")).toBeInTheDocument();
  expect(search).toHaveValue("");
});

test("Home is only the projects grid: nothing above it, even when a plan has something to continue or no agent is connected", async () => {
  renderApp("/", { ...routes, "GET /v1/providers": { connector: { configured: false, reachable: false }, providers: [] } });
  await screen.findByText("Calculus I");
  expect(screen.queryByText(/Continue/)).not.toBeInTheDocument();
  expect(screen.queryByText(/No AI is connected yet/)).not.toBeInTheDocument();
  const main = screen.getByRole("main");
  expect(main.firstElementChild).toHaveClass("sr-only");
  expect(main.children[1]).toHaveClass("grid");
});

test("a card's Stop stops the plan making it, and the line says minutes only when the maker gave a finish time", async () => {
  const soon = new Date(Date.now() + 3 * 60_000 + 20_000).toISOString();
  const running = (withJob: boolean) => ({
    plan: { id: "pl2", projectId: "p2", title: "Lesson", version: 1, status: "running", createdAt: now, updatedAt: now },
    stages: [], edges: [], counts: { total: 1, done: 0 }, estimateUsd: 0, issues: [],
    items: [{ id: "i2", level: 1, ord: 0, type: "video", title: "Intro video", settings: {}, enabled: true, status: "running", sources: [], done: false, ...(withJob ? { job: { id: "j", status: "running", stage: "w", progress: 0.4, attempt: 1, doneBy: soon } } : {}) }],
  });
  let timed = true;
  const { calls } = renderApp("/", {
    ...routes,
    "GET /v1/formats": { formats },
    "GET /v1/projects": { projects: [project("p2", "Physics")] },
    "GET /v1/projects/:id": { project: project("p2", "Physics"), counts: { chats: 0, plans: 1, outputs: 0, sources: 0 } },
    "GET /v1/projects/:id/plans": { plans: [{ id: "pl2", projectId: "p2", version: 1, status: "running", createdAt: now, updatedAt: now, counts: { total: 1, done: 0 } }] },
    "GET /v1/plans/:id": () => running(timed),
    "POST /v1/plans/:id/cancel": () => running(false),
  });
  expect(await screen.findByText(statusText("Making video · 4 min"))).toBeInTheDocument();
  timed = false;
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/plans/pl2/cancel")).toBe(true);
  expect(await screen.findByText(statusText("Making video"))).toBeInTheDocument();
});

test("plus card is first in the grid, opens an accessible dialog that traps focus and closes on Escape", async () => {
  renderApp("/", routes);
  const grid = (await screen.findByText("Calculus I")).closest(".grid")!;
  const plus = within(grid as HTMLElement).getByRole("button", { name: "New project" });
  expect(grid.firstElementChild).toBe(plus);

  plus.focus();
  await userEvent.click(plus);
  const dialog = screen.getByRole("dialog", { name: "New project" });
  const nameInput = within(dialog).getByLabelText("Name");
  expect(nameInput).toHaveFocus();

  // Tab backwards from the first focusable element inside the dialog wraps to Create / last button, not outside.
  const closeBtn = within(dialog).getByRole("button", { name: "Close" });
  closeBtn.focus();
  await userEvent.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(closeBtn);

  // Tab forward from the last button wraps back to the first control inside the dialog.
  const createBtn = within(dialog).getByRole("button", { name: "Create" });
  createBtn.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(closeBtn);

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(plus).toHaveFocus();
});

const empty = { ...routes, "GET /v1/projects": { projects: [] } };

test("with no projects yet, shows the plus card and the example card with Example on its picture", async () => {
  renderApp("/", empty);
  const plus = await screen.findByRole("button", { name: "New project" });
  const grid = plus.closest(".grid")!;
  expect(grid.firstElementChild).toBe(plus);
  const exampleHeading = await screen.findByRole("heading", { level: 3, name: "Why the Moon has phases" });
  const exampleCard = exampleHeading.closest(".pc")!;
  expect(within(exampleCard.querySelector(".pface") as HTMLElement).getByText("Example")).toBeInTheDocument();
  expect(exampleCard.querySelector(".pfoot")).toHaveTextContent("1 source0 items made");
  expect(screen.queryByText(/Drop a file here to start/)).not.toBeInTheDocument();
  expect(screen.queryByText(/turns your notes, slides and PDFs into answers/)).not.toBeInTheDocument();
  expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();
});

test("opening the example makes a project from it once, and opens the same one after that", async () => {
  const { calls } = renderApp("/", {
    ...empty,
    "POST /v1/projects/import": [201, { project: { ...project("p5", "Why the Moon has phases", undefined, { example: "moon-phases" }) } }],
  });
  await userEvent.click(await screen.findByRole("button", { name: "Why the Moon has phases" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/projects/import")).toBe(true));
  const body = calls.find((c) => c.path === "/v1/projects/import")!.body as { example: string; bundle: { opensourcebook?: string; re?: string } };
  expect(body.example).toBe("moon-phases");
  // The example file is marked with the app's name; one written before it had that name is marked `re`.
  expect(body.bundle.opensourcebook ?? body.bundle.re).toBe("project");
});

test("a load that fails says why and loads again on Try again", async () => {
  let tries = 0;
  renderApp("/", { ...routes, "GET /v1/projects": () => (++tries === 1 ? [500, { error: "internal", message: "The engine could not answer." }] : { projects: [project("p1", "Calculus I")] }) });
  expect(await screen.findByText("The engine could not answer.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Calculus I")).toBeInTheDocument();
});

test("archived projects wait under one quiet line, and Restore brings one back", async () => {
  let archived = [project("p3", "Old course")];
  const { calls } = renderApp("/", {
    ...routes,
    "GET /v1/projects": ({ query }: { query: URLSearchParams }) => ({ projects: query.get("archived") === "only" ? archived : [project("p1", "Calculus I")] }),
    "POST /v1/projects/:id/unarchive": () => {
      archived = [];
      return { project: project("p3", "Old course") };
    },
  });
  const line = await screen.findByRole("button", { name: "Archived (1)" });
  expect(screen.queryByText("Old course")).not.toBeInTheDocument();
  await userEvent.click(line);
  expect(screen.getByRole("link", { name: "Old course" })).toHaveAttribute("href", "/projects/p3");
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/projects/p3/unarchive")).toBe(true);
  await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Archived projects" })).not.toBeInTheDocument());
});

test("a project card's menu renames it in place, and Escape leaves it as it was", async () => {
  const { calls } = renderApp("/", { ...routes, "PATCH /v1/projects/:id": { project: project("p1", "Calculus II") } });
  await userEvent.click(await screen.findByRole("button", { name: "More for Calculus I" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  await userEvent.type(screen.getByLabelText("Project title"), " nope{Escape}");
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "More for Calculus I" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const box = screen.getByLabelText("Project title");
  await userEvent.clear(box);
  await userEvent.type(box, "Calculus II{Enter}");
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "Calculus II" });
});

test("an archived project is deleted for good only after saying what goes with it; busy is said calmly", async () => {
  let archived = [project("p3", "Old course")];
  let tries = 0;
  const { calls } = renderApp("/", {
    ...routes,
    "GET /v1/projects": ({ query }: { query: URLSearchParams }) => ({ projects: query.get("archived") === "only" ? archived : [project("p1", "Calculus I")] }),
    "GET /v1/projects/:id": ({ query }: { query: URLSearchParams }) => ({ project: project("p3", "Old course"), ...(query.get("counts") === "1" ? { counts: { chats: 1, plans: 0, outputs: 0, sources: 1 } } : {}) }),
    "DELETE /v1/projects/:id": () => {
      if (++tries === 1) return [409, { error: "project_busy", message: "A plan in this project is running; stop it first" }];
      archived = [];
      return { projectId: "p3", deleted: { chats: 1, plans: 1, outputs: 0, sources: 1 } };
    },
  });
  await userEvent.click(await screen.findByRole("button", { name: "Archived (1)" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete Old course" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete Old course?" });
  expect(await within(ask).findByText(/Its 1 source and 1 chat go for good\./)).toBeInTheDocument();
  // One read counts it all, as deleting would.
  expect(calls.filter((c) => c.path === "/v1/projects/p3" && c.query.get("counts") === "1")).toHaveLength(1);
  expect(calls.some((c) => c.path.startsWith("/v1/projects/p3/"))).toBe(false);
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "Delete Old course" }));
  const again = screen.getByRole("alertdialog");
  await within(again).findByText(/go for good/);
  await userEvent.click(within(again).getByRole("button", { name: "Delete" }));
  expect(await within(again).findByText(/still running/)).toBeInTheDocument();
  await userEvent.click(within(again).getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("Deleted “Old course” with 1 source, 1 chat, and 1 plan.")).toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("a project card's menu deletes it after a plain confirmation naming what goes with it; busy is said plainly", async () => {
  let tries = 0;
  const { calls } = renderApp("/", {
    ...routes,
    "GET /v1/projects/:id": ({ query }: { query: URLSearchParams }) => ({ project: project("p1", "Calculus I"), ...(query.get("counts") === "1" ? { counts: { chats: 2, plans: 0, outputs: 5, sources: 3 } } : {}) }),
    "DELETE /v1/projects/:id": () => {
      if (++tries === 1) return [409, { error: "project_busy", message: "A plan in this project is running; stop it first" }];
      return { projectId: "p1", deleted: { chats: 2, plans: 0, outputs: 5, sources: 3 } };
    },
  });
  await userEvent.click(await screen.findByRole("button", { name: "More for Calculus I" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete Calculus I?" });
  expect(await within(ask).findByText(/Its 3 sources, 5 made things, and 2 chats go for good\./)).toBeInTheDocument();
  expect(within(ask).getByText(/Archive keeps them instead/)).toBeInTheDocument();
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "More for Calculus I" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const again = screen.getByRole("alertdialog");
  await within(again).findByText(/go for good/);
  await userEvent.click(within(again).getByRole("button", { name: "Delete" }));
  expect(await within(again).findByText(/still running/)).toBeInTheDocument();
  await userEvent.click(within(again).getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("Deleted “Calculus I” with 3 sources, 5 made things, and 2 chats.")).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
});

test("a project card's menu opens with room: placed against the window, never given both a top and a bottom", async () => {
  renderApp("/", routes);
  await userEvent.click(await screen.findByRole("button", { name: "More for Calculus I" }));
  const menu = screen.getByRole("menu", { name: "More for Calculus I" });
  // jsdom draws no CSS, so the guard is on what the code sets: a box with both edges set collapses to an empty bar.
  const { top, bottom } = menu.style;
  expect(Boolean(top && top !== "auto") && Boolean(bottom && bottom !== "auto")).toBe(false);
  expect(menu.style.position).toBe("fixed");
  expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Rename", "Move to folder…", "Archive" + "keeps everything", "Delete…"]);
});

test("deleting a live project can be turned into archiving from the question", async () => {
  const { calls } = renderApp("/", {
    ...routes,
    "POST /v1/projects/:id/archive": { project: { ...project("p1", "Calculus I"), archivedAt: now } },
  });
  await userEvent.click(await screen.findByRole("button", { name: "More for Calculus I" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const ask = screen.getByRole("alertdialog", { name: "Delete Calculus I?" });
  expect(within(ask).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Archive instead", "Delete"]);
  await within(ask).findByText(/go for good/);
  await userEvent.click(within(ask).getByRole("button", { name: "Archive instead" }));
  await vi.waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/projects/p1/archive")).toBe(true));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
});
