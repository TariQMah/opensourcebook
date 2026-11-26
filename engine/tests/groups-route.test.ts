/** Folders on Home (/v1/groups, PATCH /v1/projects/:id { groupId }), over the real routes and SQL. */
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

function setup() {
  const engine = createTestEngine();
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  return { engine, call };
}

describe("folders on Home", () => {
  it("makes, renames and lists folders by name, with how many projects each holds", async () => {
    const t = setup();
    const made = await t.call("/v1/groups", "POST", { title: "  Year   two " });
    expect(made.status).toBe(201);
    expect(made.body.group).toMatchObject({ title: "Year two", projects: 0 });
    expect(made.body.group.ownerId).toBeUndefined();
    await t.call("/v1/groups", "POST", { title: "art" });
    const project = (await t.call("/v1/projects", "POST", { title: "Cells" })).body.project;
    const moved = await t.call(`/v1/projects/${project.id}`, "PATCH", { groupId: made.body.group.id });
    expect(moved.body.project.groupId).toBe(made.body.group.id);
    expect(moved.body.project.updatedAt).toBe(project.updatedAt);
    const renamed = await t.call(`/v1/groups/${made.body.group.id}`, "PATCH", { title: "Biology" });
    expect(renamed.body.group.title).toBe("Biology");
    const list = await t.call("/v1/groups");
    expect(list.body.groups.map((g: any) => [g.title, g.projects])).toEqual([
      ["art", 0],
      ["Biology", 1],
    ]);
  });

  it("puts a project back on Home with null", async () => {
    const t = setup();
    const group = (await t.call("/v1/groups", "POST", { title: "A" })).body.group;
    const project = (await t.call("/v1/projects", "POST", { title: "P" })).body.project;
    await t.call(`/v1/projects/${project.id}`, "PATCH", { groupId: group.id });
    const back = await t.call(`/v1/projects/${project.id}`, "PATCH", { groupId: null });
    expect(back.body.project.groupId).toBeUndefined();
  });

  it("deleting a folder moves its projects back on Home and deletes none", async () => {
    const t = setup();
    const group = (await t.call("/v1/groups", "POST", { title: "Old" })).body.group;
    const ids: string[] = [];
    for (const title of ["One", "Two"]) {
      const project = (await t.call("/v1/projects", "POST", { title })).body.project;
      await t.call(`/v1/projects/${project.id}`, "PATCH", { groupId: group.id });
      ids.push(project.id);
    }
    const gone = await t.call(`/v1/groups/${group.id}`, "DELETE");
    expect(gone.body).toEqual({ groupId: group.id, moved: 2 });
    for (const id of ids) {
      const { body } = await t.call(`/v1/projects/${id}`);
      expect(body.project.groupId).toBeUndefined();
    }
    expect((await t.call("/v1/groups")).body.groups).toEqual([]);
  });

  it("refuses a blank or long name, an unknown folder, and another owner's folder", async () => {
    const t = setup();
    for (const body of [{}, { title: "  " }, { title: "x".repeat(101) }, { title: 4 }]) expect((await t.call("/v1/groups", "POST", body)).status).toBe(400);
    const project = (await t.call("/v1/projects", "POST", { title: "P" })).body.project;
    expect((await t.call(`/v1/projects/${project.id}`, "PATCH", { groupId: "nope" })).status).toBe(404);
    const theirs = await t.engine.deps.repos.groups.create({ ownerId: "client:someone-else", title: "Theirs" });
    expect((await t.call(`/v1/projects/${project.id}`, "PATCH", { groupId: theirs.id })).status).toBe(404);
    expect((await t.call(`/v1/groups/${theirs.id}`, "PATCH", { title: "Mine" })).status).toBe(404);
    expect((await t.call(`/v1/groups/${theirs.id}`, "DELETE")).status).toBe(404);
  });
});
