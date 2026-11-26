/** What setup's buttons may do for each agent: install it from the npm package its adapter names, and start its own sign-in. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultAgents } from "../src/agents/registry.ts";

test("an agent setup can install or sign in names its npm package and its sign-in, and says where its program is", () => {
  const agents = createDefaultAgents().list();
  const withSetup = agents.filter((a) => a.setup);
  assert.ok(withSetup.length >= 2, "at least two agents can be set up with a button");
  for (const a of withSetup) {
    if (a.setup!.npm) assert.match(a.setup!.npm, /^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/, `${a.id}: an npm package name`);
    if (a.setup!.signIn) assert.ok(a.setup!.signIn.length > 0 && a.setup!.signIn.every((w) => !/\s/.test(w)), `${a.id}: its sign-in's arguments`);
    assert.equal(typeof a.program?.(), "string", `${a.id}: where its program is`);
  }
});
