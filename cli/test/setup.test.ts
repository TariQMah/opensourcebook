/** Get set up's buttons in the launcher: an agent installed with npm into Open Sourcebook's folder, its sign-in watched, the routes. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Phone } from "../phone.ts";
import { SetupActions, agentsPrefix, firstUrl, ownBins, useOwnBins, type SetupAgent } from "../setup.ts";

const posixOnly = { skip: process.platform === "win32" ? "the fakes are shell scripts" : false };

function folder() {
  const root = mkdtempSync(join(tmpdir(), "opensourcebook-setup-"));
  return { root, home: join(root, "state"), remove: () => rmSync(root, { recursive: true, force: true }) };
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** An agent as the registry gives one, with a sign-in that says signed in once `signedIn` is set. */
function fakeAgent(program: string, o: { npm?: string; signedIn?: () => boolean } = {}): SetupAgent {
  return {
    id: "pal",
    label: "Pal",
    setup: { ...(o.npm ? { npm: o.npm } : {}), signIn: ["login"] },
    program: () => program,
    info: async () => ({ installed: true, signedIn: o.signedIn?.() ?? false }),
  };
}

const ffmpeg = { found: async () => true, fetch: async () => ({ ok: true }) };

async function until<T extends { state: string }>(read: () => Promise<T> | T, not: string, tries = 100): Promise<T> {
  let now = await read();
  for (let i = 0; i < tries && now.state === not; i++) {
    await new Promise((r) => setTimeout(r, 30));
    now = await read();
  }
  return now;
}

test("the programs Open Sourcebook fetched are first on the PATH: in the app data folder, else in the state folder", () => {
  assert.deepEqual(ownBins({ OPENSOURCEBOOK_APP_DATA: "/data" }, "/data/state", "darwin"), ["/data/bin", "/data/agents/bin"]);
  assert.deepEqual(ownBins({}, "/copy/.opensourcebook", "linux"), ["/copy/.opensourcebook/bin", "/copy/.opensourcebook/agents/bin"]);
  const env: NodeJS.ProcessEnv = { OPENSOURCEBOOK_APP_DATA: "/data", PATH: "/data/bin:/usr/bin" };
  useOwnBins(env, "/data/state", "darwin");
  assert.equal(env.PATH, "/data/bin:/data/agents/bin:/usr/bin", "each folder once");
  const win: NodeJS.ProcessEnv = { OPENSOURCEBOOK_APP_DATA: "C:\\Data", Path: "C:\\Windows" };
  useOwnBins(win, "C:\\Data\\state", "win32");
  assert.deepEqual(Object.keys(win).filter((k) => k.toUpperCase() === "PATH"), ["Path"], "the PATH keeps its own spelling");
  assert.ok(win.Path!.endsWith(";C:\\Windows"));
});

test("the login page's address is the first web address the sign-in printed", () => {
  assert.equal(firstUrl("Opening browser to sign in…\nIf it did not open, visit: https://login.example.test/oauth?state=a1&x=2.\n"), "https://login.example.test/oauth?state=a1&x=2");
  assert.equal(firstUrl("Waiting for you to sign in"), undefined);
});

test("an agent is installed from its npm package into Open Sourcebook's own folder; one npm can't install says so", posixOnly, async () => {
  const f = folder();
  try {
    const npm = script(join(f.root, "npm"), `echo "npm $*"\n[ "$FAIL" = 1 ] && exit 1\nexit 0`);
    const env = { OPENSOURCEBOOK_APP_DATA: join(f.root, "data"), PATH: "/usr/bin:/bin" };
    const setup = new SetupActions({ root: f.root, home: f.home, env, npm, ffmpeg, agents: async () => [fakeAgent("/nowhere/pal", { npm: "@maker/pal" })] });
    assert.equal((await setup.install("pal")).state, "installing");
    assert.deepEqual(await until(async () => (await setup.view()).agents[0]!.install, "installing"), { state: "done" });
    assert.match(readFileSync(join(f.home, "logs", "agent-pal.log"), "utf8"), new RegExp(`^npm install --global --prefix ${agentsPrefix(env, f.home)} --no-audit --no-fund @maker/pal$`, "m"));

    const failing = new SetupActions({ root: f.root, home: f.home, env: { ...env, FAIL: "1" }, npm, ffmpeg, agents: async () => [fakeAgent("/nowhere/pal", { npm: "@maker/pal" })] });
    await failing.install("pal");
    const failed = await until(async () => (await failing.view()).agents[0]!.install, "installing");
    assert.equal(failed.state, "failed");

    const none = new SetupActions({ root: f.root, home: f.home, env, npm, agents: async () => [fakeAgent("/nowhere/pal")] });
    assert.deepEqual(await none.install("pal"), { state: "failed", message: "Pal can't be installed from here; install it from its own page." });
  } finally {
    f.remove();
  }
});

test("a sign-in is the agent's own, watched until the agent says it is signed in, with the login page's address it printed", posixOnly, async () => {
  const f = folder();
  try {
    const pal = script(join(f.root, "pal"), `echo "Visit https://login.example.test/start?s=1 to sign in"\nsleep 30`);
    let signedIn = false;
    const setup = new SetupActions({ root: f.root, home: f.home, env: { PATH: "/usr/bin:/bin" }, pollMs: 20, ffmpeg, agents: async () => [fakeAgent(pal, { signedIn: () => signedIn })] });
    assert.equal((await setup.signIn("pal")).state, "signingIn");
    const waiting = await until(async () => {
      const s = (await setup.view()).agents[0]!.signIn;
      return s.state === "signingIn" && !s.url ? { state: "nourl" } : s;
    }, "nourl");
    assert.deepEqual(waiting, { state: "signingIn", since: (waiting as { since: string }).since, url: "https://login.example.test/start?s=1" });
    signedIn = true;
    assert.deepEqual(await until(async () => (await setup.view()).agents[0]!.signIn, "signingIn"), { state: "done" });
  } finally {
    f.remove();
  }
});

test("a sign-in that closes without signing in, or is not finished in time, says so plainly", posixOnly, async () => {
  const f = folder();
  try {
    const quits = script(join(f.root, "quits"), "exit 1");
    const closes = new SetupActions({ root: f.root, home: f.home, env: { PATH: "/usr/bin:/bin" }, pollMs: 20, ffmpeg, agents: async () => [fakeAgent(quits)] });
    await closes.signIn("pal");
    assert.deepEqual(await until(async () => (await closes.view()).agents[0]!.signIn, "signingIn"), { state: "failed", message: "Pal's sign-in closed before it finished. Press Sign in to try again." });

    const waits = script(join(f.root, "waits"), "sleep 30");
    const slow = new SetupActions({ root: f.root, home: f.home, env: { PATH: "/usr/bin:/bin" }, pollMs: 20, signInMs: 100, ffmpeg, agents: async () => [fakeAgent(waits)] });
    await slow.signIn("pal");
    const timedOut = await until(async () => (await slow.view()).agents[0]!.signIn, "signingIn");
    assert.equal(timedOut.state, "failed");
  } finally {
    f.remove();
  }
});

function call(port: number, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, "x-phone-token": "phone-token-0123456789" } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the launcher's control answers Get set up: what its buttons can do, and an agent it does not know is refused", async () => {
  const f = folder();
  mkdirSync(f.home, { recursive: true });
  const setup = new SetupActions({
    root: f.root,
    home: f.home,
    env: {},
    agents: async () => [fakeAgent("/nowhere/pal", { npm: "@maker/pal" }), { id: "plain", label: "Plain", info: async () => ({ installed: false }) }],
    ffmpeg: { found: async () => true, fetch: async () => ({ ok: true }) },
  });
  const phone = new Phone({ home: f.home, webPort: 1, doorPort: 0, controlPort: 0, token: "phone-token-0123456789", say: () => undefined, ansi: false, listenHost: "127.0.0.1", setup });
  try {
    await phone.start(false);
    const port = phone.controlPort;
    assert.deepEqual((await call(port, "GET", "/launcher/setup")).body, {
      agents: [
        { id: "pal", label: "Pal", canInstall: true, canSignIn: true, install: { state: "idle" }, signIn: { state: "idle" } },
        { id: "plain", label: "Plain", canInstall: false, canSignIn: false, install: { state: "idle" }, signIn: { state: "idle" } },
      ],
      ffmpeg: { found: true, fetch: { state: "idle" } },
    });
    assert.equal((await call(port, "POST", "/launcher/agents/nobody/install")).status, 404);
    assert.equal((await call(port, "POST", "/launcher/tools/ffmpeg")).status, 202);
  } finally {
    await phone.stop();
    f.remove();
  }
});
