import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { engineState, useAppData } from "../app-data.ts";
import { PROGRAMS, type Wiring } from "../programs.ts";
import { SECRET_NAMES, type Secrets } from "../secrets.ts";
import { stateFolder } from "../state.ts";

const secrets = Object.fromEntries(SECRET_NAMES.map((n) => [n, `${n.toLowerCase()}-0123456789`])) as Secrets;
const ports = { engine: 9003, web: 9004, connector: 9000, scenes: 9002, "engine-inspector": 9005 };
const dir = mkdtempSync(join(tmpdir(), "opensourcebook-app-data-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const root = join(dir, "app");
const data = join(dir, "Application Support", "Open Sourcebook");
mkdirSync(join(root, "engine"), { recursive: true });
mkdirSync(join(root, ".opensourcebook"), { recursive: true });
mkdirSync(join(data, "state"), { recursive: true });

test("with an app data folder, the state, the engine's data and the video jobs are in it, and the connector may work in the jobs folder", () => {
  const env: NodeJS.ProcessEnv = { OPENSOURCEBOOK_APP_DATA: data };
  useAppData(env);
  assert.equal(env.OPENSOURCEBOOK_STATE, join(data, "state"));
  assert.equal(env.SCENES_JOBS_DIR, join(data, "jobs"));
  assert.equal(env.SCENES_DATA_DIR, join(data, "scenes"));
  assert.equal(stateFolder(root, env), join(data, "state"));
  assert.equal(engineState(join(root, "engine"), env), join(data, "data"));
  const w: Wiring = { root, home: join(data, "state"), ports, secrets, env };
  const program = (id: string) => PROGRAMS.find((p) => p.id === id)!;
  assert.equal(program("connector").start(w).env.OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS, join(data, "jobs"));
  assert.equal(program("scenes").start(w).env.SCENES_ENGINE_URL, "http://127.0.0.1:9003");
  const dev = program("engine").start(w).args;
  assert.equal(dev[dev.indexOf("--persist-to") + 1], join(data, "data"));
});

test("without one, everything stays where a clone always kept it, and a setting named on its own still wins", () => {
  const env: NodeJS.ProcessEnv = {};
  useAppData(env);
  assert.deepEqual(env, {});
  assert.equal(engineState(join(root, "engine"), env), join(root, "engine", ".wrangler", "state"));
  const w: Wiring = { root, home: join(root, ".opensourcebook"), ports, secrets, env };
  assert.ok(!PROGRAMS.find((p) => p.id === "engine")!.start(w).args.includes("--persist-to"));
  assert.equal(PROGRAMS.find((p) => p.id === "connector")!.start(w).env.OPENSOURCEBOOK_CONNECTOR_SCENES_ROOTS, join(root, "services", "scenes", ".data"));

  const named: NodeJS.ProcessEnv = { OPENSOURCEBOOK_APP_DATA: data, SCENES_DATA_DIR: "/elsewhere/jobs" };
  useAppData(named);
  assert.equal(named.SCENES_DATA_DIR, "/elsewhere/jobs");
  assert.equal(named.SCENES_JOBS_DIR, undefined);
  assert.equal(named.OPENSOURCEBOOK_STATE, join(data, "state"));
});
