import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const project = (id: string, title: string, groupId?: string) => ({ id, title, settings: {}, createdAt: now, updatedAt: now, ...(groupId ? { groupId } : {}) });
const group = (id: string, title: string, projects = 0) => ({ id, title, projects, createdAt: now, updatedAt: now });

const routes = {
  "GET /v1/projects": { projects: [project("p1", "Calculus I", "g1"), project("p2", "Tides"), project("p3", "Cells", "g1")] },
  "GET /v1/projects/:id": ({ params }: { params: Record<string, string> }) => ({ project: project(params.id!, "x"), counts: { chats: 0, plans: 0, outputs: 0, sources: 0 } }),
  "GET /v1/projects/:id/plans": { plans: [] },
  "GET /v1/projects/:id/outputs": { outputs: [] },
  "GET /v1/groups": { groups: [group("g1", "Maths", 2), group("g2", "Empty one")] },
};

test("Home shows folders first, then the projects in none; a folder opens to its own projects", async () => {
  renderApp("/", routes);
  const maths = await screen.findByRole("link", { name: /Maths/ });
  expect(maths).toHaveAttribute("href", "/?folder=g1");
  expect(within(maths).getByText("2 projects")).toBeInTheDocument();
  expect(screen.getByText("Tides")).toBeInTheDocument();
  expect(screen.queryByText("Calculus I")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
});

test("a folder's page lists its projects, searches inside it and goes back to Home", async () => {
  renderApp("/?folder=g1&q=calc", routes);
  expect(await screen.findByRole("heading", { level: 1, name: "Maths" })).toBeInTheDocument();
  expect(await screen.findByText("Calculus I")).toBeInTheDocument();
  expect(screen.queryByText("Cells")).not.toBeInTheDocument();
  expect(screen.queryByText("Tides")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
});

test("searching on Home looks inside folders too", async () => {
  renderApp("/?q=cel", routes);
  expect(await screen.findByText("Cells")).toBeInTheDocument();
  expect(screen.queryByText("Tides")).not.toBeInTheDocument();
});

test("New folder makes one by the name typed on its tile", async () => {
  const { calls } = renderApp("/", { ...routes, "POST /v1/groups": [201, { group: group("g3", "Art") }] });
  await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
  await userEvent.type(screen.getByLabelText("Folder name"), "  Art {Enter}");
  expect(calls.find((c) => c.method === "POST" && c.path === "/v1/groups")?.body).toEqual({ title: "Art" });
});

test("a project's menu moves it into a folder, or into a new one named there", async () => {
  const { calls } = renderApp("/", { ...routes, "PATCH /v1/projects/:id": { project: project("p2", "Tides", "g2") }, "POST /v1/groups": [201, { group: group("g3", "Oceans") }] });
  await userEvent.click(await screen.findByRole("button", { name: "More for Tides" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to folder…" }));
  const dialog = screen.getByRole("dialog", { name: "Move “Tides” to" });
  expect(within(dialog).getByRole("button", { name: /Home/ })).toBeDisabled();
  await userEvent.click(within(dialog).getByRole("button", { name: "Empty one" }));
  expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/v1/projects/p2", body: { groupId: "g2" } });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "More for Tides" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to folder…" }));
  await userEvent.click(screen.getByRole("button", { name: "New folder…" }));
  await userEvent.type(screen.getByLabelText("New folder name"), "Oceans{Enter}");
  expect(calls.find((c) => c.method === "POST" && c.path === "/v1/groups")?.body).toEqual({ title: "Oceans" });
  expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ groupId: "g3" });
});

test("deleting a folder says its projects go back on Home and none is deleted", async () => {
  const { calls } = renderApp("/?folder=g1", { ...routes, "DELETE /v1/groups/:id": { groupId: "g1", moved: 2 } });
  await userEvent.click(await screen.findByRole("button", { name: "More for Maths" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Delete folder/ }));
  const ask = screen.getByRole("alertdialog", { name: "Delete the folder “Maths”?" });
  expect(ask).toHaveTextContent("Its 2 projects go back on Home, with everything in them. No project is deleted.");
  await userEvent.click(within(ask).getByRole("button", { name: "Delete folder" }));
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/groups/g1")).toBe(true);
  expect(await screen.findByText("Deleted the folder “Maths”. Its 2 projects are back on Home.")).toBeInTheDocument();
});

test("a folder renames in place", async () => {
  const { calls } = renderApp("/?folder=g1", { ...routes, "PATCH /v1/groups/:id": { group: group("g1", "Algebra") } });
  await userEvent.click(await screen.findByRole("button", { name: "More for Maths" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const box = screen.getByLabelText("Folder name");
  await userEvent.clear(box);
  await userEvent.type(box, "Algebra{Enter}");
  expect(calls.find((c) => c.method === "PATCH" && c.path === "/v1/groups/g1")?.body).toEqual({ title: "Algebra" });
});
