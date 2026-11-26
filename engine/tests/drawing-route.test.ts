/**
 * How a video is drawn (docs/api.md, "Drawing a video"): gently unless the owner turns "Use more of my computer to
 * make videos faster" on, kept per owner until changed back.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { DRAW_FASTER_KEY, drawFasterFrom } from "../src/routes/drawing";
import { authed, bodyOf, CLIENT_TOKEN, createTestEngine } from "./support/engine-harness";

function setup() {
  const engine = createTestEngine();
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  return { engine, call };
}

describe("drawing a video", () => {
  it("is gentle by default, and faster once turned on, until turned off again", async () => {
    const t = setup();
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    expect(await t.call("/v1/drawing")).toEqual({ status: 200, body: { faster: false } });
    expect(await drawFasterFrom(t.engine.deps.repos)(owner)).toBe(false);
    expect(await t.call("/v1/drawing", "PUT", { faster: true })).toEqual({ status: 200, body: { faster: true } });
    expect(await t.call("/v1/drawing")).toEqual({ status: 200, body: { faster: true } });
    expect(await t.engine.deps.repos.ownerSettings.get(owner, DRAW_FASTER_KEY)).toBe(true);
    expect(await drawFasterFrom(t.engine.deps.repos)(owner)).toBe(true);
    expect(await t.call("/v1/drawing", "PUT", { faster: false })).toEqual({ status: 200, body: { faster: false } });
    expect(await t.engine.deps.repos.ownerSettings.get(owner, DRAW_FASTER_KEY)).toBeUndefined();
    expect(await drawFasterFrom(t.engine.deps.repos)(undefined)).toBe(false);
  });

  it("refuses anything but faster: true or false", async () => {
    const t = setup();
    for (const body of [{}, { faster: "yes" }, { faster: 1 }, { faster: null }]) expect((await t.call("/v1/drawing", "PUT", body)).status).toBe(400);
  });
});
