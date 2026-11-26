// @vitest-environment node
import { NOT_OPENED, proxy, withOldNames, type ProxyEnv } from "./proxy";

// A web app run alone (no launcher): the browser check is off. The check itself is tested below.
const env = { OPENSOURCEBOOK_CLIENT_TOKEN: "secret-token", ENGINE_URL: "http://engine.test", OPENSOURCEBOOK_BROWSER_GATE: "off" };

function engine(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "set-cookie": "x=1" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("forwards /api/v1 to the engine with the token from the environment", async () => {
  const { calls, fetchImpl } = engine();
  const res = await proxy(new Request("https://web.test/api/v1/projects?limit=5"), env, fetchImpl);
  expect(res.status).toBe(200);
  expect(calls[0]?.url).toBe("http://engine.test/v1/projects?limit=5");
  expect(new Headers(calls[0]?.init.headers).get("x-client-token")).toBe("secret-token");
});

test("a token the browser sends is replaced, and cookies are not forwarded", async () => {
  const { calls, fetchImpl } = engine();
  await proxy(
    new Request("https://web.test/api/v1/inbox", { headers: { "x-client-token": "forged", cookie: "CF_Authorization=abc" } }),
    env,
    fetchImpl,
  );
  const headers = new Headers(calls[0]?.init.headers);
  expect(headers.get("x-client-token")).toBe("secret-token");
  expect(headers.get("cookie")).toBeNull();
});

test("passes the body, content type and upload filename on a POST", async () => {
  const { calls, fetchImpl } = engine(201);
  const res = await proxy(
    new Request("https://web.test/api/v1/uploads", {
      method: "POST",
      body: "bytes",
      headers: { "content-type": "application/pdf", "x-upload-filename": "a.pdf", origin: "https://web.test" },
    }),
    env,
    fetchImpl,
  );
  expect(res.status).toBe(201);
  const headers = new Headers(calls[0]?.init.headers);
  expect(headers.get("content-type")).toBe("application/pdf");
  expect(headers.get("x-upload-filename")).toBe("a.pdf");
  expect(new TextDecoder().decode(calls[0]?.init.body as ArrayBuffer)).toBe("bytes");
});

test("keeps the engine's status and error body, drops its other headers", async () => {
  const { fetchImpl } = engine(404, { error: "not_found", message: "Plan not found" });
  const res = await proxy(new Request("https://web.test/api/v1/plans/x"), env, fetchImpl);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found", message: "Plan not found" });
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("refuses a write from another site", async () => {
  const { calls, fetchImpl } = engine();
  const res = await proxy(
    new Request("https://web.test/api/v1/projects", { method: "POST", body: "{}", headers: { origin: "https://evil.test" } }),
    env,
    fetchImpl,
  );
  expect(res.status).toBe(403);
  expect(calls).toHaveLength(0);
});

test("answers 404 outside /api/v1 and 500 when not configured", async () => {
  const { fetchImpl } = engine();
  expect((await proxy(new Request("https://web.test/api/health"), env, fetchImpl)).status).toBe(404);
  const res = await proxy(new Request("https://web.test/api/v1/projects"), { ENGINE_URL: "http://engine.test", OPENSOURCEBOOK_BROWSER_GATE: "off" }, fetchImpl);
  expect(res.status).toBe(500);
  expect(((await res.json()) as { error: string }).error).toBe("proxy_not_configured");
});

test("an engine that does not answer is a 502", async () => {
  const failing = (async () => {
    throw new TypeError("connection refused");
  }) as unknown as typeof fetch;
  const res = await proxy(new Request("https://web.test/api/v1/projects"), env, failing);
  expect(res.status).toBe(502);
});

test("passes a byte range both ways, so a video can be seeked", async () => {
  const calls: Array<RequestInit> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response("abcd", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 2-5/100", "accept-ranges": "bytes" } });
  }) as unknown as typeof fetch;
  const res = await proxy(new Request("https://web.test/api/v1/assets/a1", { headers: { range: "bytes=2-5" } }), env, fetchImpl);
  expect(new Headers(calls[0]?.headers).get("range")).toBe("bytes=2-5");
  expect(res.status).toBe(206);
  expect(res.headers.get("content-range")).toBe("bytes 2-5/100");
  expect(res.headers.get("accept-ranges")).toBe("bytes");
});

describe("/api/phone, to the launcher's phone control", () => {
  const withPhone = { ...env, PHONE_URL: "http://127.0.0.1:5181", PHONE_TOKEN: "phone-secret" };

  test("forwards with the phone token, never the browser's own", async () => {
    const { calls, fetchImpl } = engine(200, { on: false, devices: [] });
    const res = await proxy(new Request("https://web.test/api/phone", { headers: { "x-phone-token": "forged", cookie: "a=b" } }), withPhone, fetchImpl);
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe("http://127.0.0.1:5181/phone");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-phone-token")).toBe("phone-secret");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-client-token")).toBeNull();
  });

  test("passes a removal through, and refuses one from another site", async () => {
    const { calls, fetchImpl } = engine();
    const ok = await proxy(new Request("https://web.test/api/phone/devices/ab12", { method: "DELETE", headers: { origin: "https://web.test" } }), withPhone, fetchImpl);
    expect(ok.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:5181/phone/devices/ab12", init: { method: "DELETE" } });
    const evil = await proxy(new Request("https://web.test/api/phone/on", { method: "POST", headers: { origin: "https://evil.test" } }), withPhone, fetchImpl);
    expect(evil.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  test("says plainly when Open Sourcebook was not started by the launcher", async () => {
    const { fetchImpl } = engine();
    const res = await proxy(new Request("https://web.test/api/phone"), env, fetchImpl);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("phone_unavailable");
  });
});

describe("/api/launcher, to what only the launcher can do", () => {
  const withPhone = { ...env, PHONE_URL: "http://127.0.0.1:5181", PHONE_TOKEN: "phone-secret" };

  test("starts a voice install with the phone token, and refuses one from another site", async () => {
    const { calls, fetchImpl } = engine(202, { voice: "kokoro", state: "installing" });
    const res = await proxy(new Request("https://web.test/api/launcher/voices/kokoro/install", { method: "POST", headers: { origin: "https://web.test" } }), withPhone, fetchImpl);
    expect(res.status).toBe(202);
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:5181/launcher/voices/kokoro/install", init: { method: "POST" } });
    expect(new Headers(calls[0]?.init.headers).get("x-phone-token")).toBe("phone-secret");
    const evil = await proxy(new Request("https://web.test/api/launcher/voices/kokoro/install", { method: "POST", headers: { origin: "https://evil.test" } }), withPhone, fetchImpl);
    expect(evil.status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

describe("who may use the engine through this proxy", () => {
  // As `npm start` runs it: a browser key and a door key for this run, and the launcher's control.
  const run = {
    OPENSOURCEBOOK_CLIENT_TOKEN: "secret-token",
    ENGINE_URL: "http://engine.test",
    PHONE_URL: "http://127.0.0.1:5181",
    PHONE_TOKEN: "phone-secret",
    OPENSOURCEBOOK_BROWSER_KEY: "browser-key-of-this-run",
    OPENSOURCEBOOK_DOOR_KEY: "door-key-of-this-run",
  };
  const at = "http://127.0.0.1:5173";
  const browser = { cookie: "opensourcebook_browser_5173=browser-key-of-this-run" };

  test("a caller with no key gets nothing: no projects, no pairing code, no way to turn the door on", async () => {
    const { calls, fetchImpl } = engine();
    for (const [path, method] of [["/api/v1/projects", "GET"], ["/api/v1/projects", "POST"], ["/api/phone", "GET"], ["/api/phone/on", "POST"], ["/api/phone/code", "POST"]] as const) {
      const res = await proxy(new Request(`${at}${path}`, { method }), run, fetchImpl);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("not_opened");
    }
    // A wrong key, a key for another copy's port, the engine token in the wrong place: nothing either.
    for (const headers of [{ cookie: "opensourcebook_browser_5173=guess" }, { cookie: "opensourcebook_browser_5174=browser-key-of-this-run" }, { "x-client-token": "secret-token" }, { authorization: "Bearer guess" }] as Array<Record<string, string>>) {
      expect((await proxy(new Request(`${at}/api/v1/projects`, { headers }), run, fetchImpl)).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("this run's browser, by its cookie, has the engine and the phone's management", async () => {
    const { calls, fetchImpl } = engine(200, { on: true });
    expect((await proxy(new Request(`${at}/api/v1/projects`, { headers: browser }), run, fetchImpl)).status).toBe(200);
    expect((await proxy(new Request(`${at}/api/phone`, { headers: browser }), run, fetchImpl)).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["http://engine.test/v1/projects", "http://127.0.0.1:5181/phone"]);
    const session = await proxy(new Request(`${at}/api/session`, { headers: browser }), run, fetchImpl);
    expect(await session.json()).toEqual({ in: true, as: "browser" });
  });

  test("what the door passes on reaches the engine, and never the phone's management, however the path is spelled", async () => {
    const { calls, fetchImpl } = engine();
    const door = { "x-opensourcebook-door": "door-key-of-this-run" };
    expect((await proxy(new Request(`${at}/api/v1/projects`, { headers: door }), run, fetchImpl)).status).toBe(200);
    for (const path of ["/api/phone", "/api/./phone", "/api/v1/../phone", "/api/v1/%2e%2e/phone", "/api/phone/code", "/API/phone", "/api/phone;x", "/api/v1/%2E%2E/phone/off"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        // Even with this computer's browser cookie alongside: the door's mark decides.
        const res = await proxy(new Request(`${at}${path}`, { method, headers: { ...door, ...browser } }), run, fetchImpl);
        expect([403, 404]).toContain(res.status);
      }
    }
    expect((await proxy(new Request(`${at}/api/v1/projects`, { headers: { "x-opensourcebook-door": "forged", ...browser } }), run, fetchImpl)).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("a job's files open only for this computer's browser: the door is refused, however the path is spelled", async () => {
    const { calls, fetchImpl } = engine(200, { shown: true });
    const door = { "x-opensourcebook-door": "door-key-of-this-run" };
    for (const path of ["/api/v1/jobs/j1/files/show", "/api/v1/jobs/j1/FILES/show", "/api/v1/jobs/j1/files%2Fshow", "/api/v1/jobs/j1/files/show/"]) {
      const res = await proxy(new Request(`${at}${path}`, { method: "POST", headers: { ...door, ...browser } }), run, fetchImpl);
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
    const res = await proxy(new Request(`${at}/api/v1/jobs/j1/files/show`, { method: "POST", headers: { ...browser, origin: at } }), run, fetchImpl);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["http://engine.test/v1/jobs/j1/files/show"]);
  });

  test("a folder on this computer is named only by this computer's browser: the door may not link one or pick the library", async () => {
    const { calls, fetchImpl } = engine(200, { project: {} });
    const door = { "x-opensourcebook-door": "door-key-of-this-run" };
    const refused: Array<[string, string]> = [["PUT", "/api/v1/projects/p1/folder"], ["DELETE", "/api/v1/projects/p1/folder/"], ["PUT", "/api/v1/projects/p1/FOLDER"], ["PUT", "/api/v1/projects/p1%2Ffolder"], ["PUT", "/api/v1/library"]];
    for (const [method, path] of refused) {
      const res = await proxy(new Request(`${at}${path}`, { method, headers: { ...door, ...browser } }), run, fetchImpl);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(calls).toHaveLength(0);
    const read = await proxy(new Request(`${at}/api/v1/library`, { headers: { ...door, ...browser } }), run, fetchImpl);
    expect(read.status).not.toBe(403);
    const res = await proxy(new Request(`${at}/api/v1/projects/p1/folder`, { method: "PUT", headers: { ...browser, origin: at, "content-type": "application/json" }, body: "{}" }), run, fetchImpl);
    expect(res.status).toBe(200);
    expect(calls.at(-1)!.url).toBe("http://engine.test/v1/projects/p1/folder");
  });

  test("backing up and restoring are only for this computer: the door is refused, however the path is spelled", async () => {
    const { calls, fetchImpl } = engine(200, {});
    const door = { "x-opensourcebook-door": "door-key-of-this-run" };
    const refused: Array<[string, string]> = [["GET", "/api/v1/backup"], ["GET", "/api/v1/BACKUP/"], ["POST", "/api/v1/backup/restores"], ["POST", "/api/v1/backup%2Frestores/r1"], ["DELETE", "/api/v1//backup/restores/r1"]];
    for (const [method, path] of refused) {
      const res = await proxy(new Request(`${at}${path}`, { method, headers: { ...door, ...browser } }), run, fetchImpl);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(calls).toHaveLength(0);
    expect((await proxy(new Request(`${at}/api/v1/backups-elsewhere`, { headers: { ...door, ...browser } }), run, fetchImpl)).status).not.toBe(403);
    const res = await proxy(new Request(`${at}/api/v1/backup`, { headers: browser }), run, fetchImpl);
    expect(res.status).toBe(200);
    expect(calls.at(-1)!.url).toBe("http://engine.test/v1/backup");
  });

  test("the launcher's own check holds the engine token and reaches the engine, not the phone", async () => {
    const { fetchImpl } = engine();
    const tool = { authorization: "Bearer secret-token" };
    expect((await proxy(new Request(`${at}/api/v1/projects`, { headers: tool }), run, fetchImpl)).status).toBe(200);
    expect((await proxy(new Request(`${at}/api/phone`, { headers: tool }), run, fetchImpl)).status).toBe(403);
  });

  test("/api/open lets a browser in once with a code the launcher made, sets a cookie scripts cannot read, and shows only this app", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      asked.push(`${url} ${String(init.body)} ${new Headers(init.headers).get("x-phone-token")}`);
      return new Response(null, { status: JSON.parse(String(init.body)).code === "right" ? 200 : 403 });
    }) as unknown as typeof fetch;
    const ok = await proxy(new Request(`${at}/api/open?code=right&to=%2Fprojects%2Fp1`), run, fetchImpl);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/projects/p1");
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^opensourcebook_browser_5173=browser-key-of-this-run;/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(asked[0]).toBe('http://127.0.0.1:5181/browser/redeem {"code":"right"} phone-secret');
    const used = await proxy(new Request(`${at}/api/open?code=wrong`), run, fetchImpl);
    expect(used.status).toBe(403);
    expect(used.headers.get("set-cookie")).toBeNull();
    const page = await used.text();
    expect(page).toMatch(/Start Open Sourcebook again and it opens the right page for you\./);
    expect(page.indexOf("Start Open Sourcebook again")).toBeLessThan(page.indexOf("opensourcebook open"));
    expect(page).toMatch(/<code>opensourcebook open<\/code>, or <code>npm run open<\/code> in its folder/);
    expect(page).not.toMatch(/\bRe\b|re open/);
    for (const to of ["//evil.example", "https://evil.example", "/\\evil.example", "/api/phone"]) {
      expect((await proxy(new Request(`${at}/api/open?code=right&to=${encodeURIComponent(to)}`), run, fetchImpl)).headers.get("location")).toBe("/");
    }
    // A phone through the door has its own pairing.
    expect((await proxy(new Request(`${at}/api/open?code=right`, { headers: { "x-opensourcebook-door": "door-key-of-this-run" } }), run, fetchImpl)).status).toBe(403);
  });

  test("a browser that was not let in is told how to open the app: what to do first, then the command", async () => {
    const { fetchImpl } = engine();
    const res = await proxy(new Request(`${at}/api/session`), run, fetchImpl);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_opened");
    expect(body.message).toBe(NOT_OPENED);
    expect(body.message).toBe('This page opens from Open Sourcebook itself. Start Open Sourcebook again and it opens the right page for you. If you use a terminal, the command is "opensourcebook open", or "npm run open" in its folder.');
  });

  test("the door's old header name is not a way in, nor is the old cookie name", async () => {
    const { fetchImpl } = engine();
    expect((await proxy(new Request(`${at}/api/v1/projects`, { headers: { "x-re-door": "door-key-of-this-run" } }), run, fetchImpl)).status).toBe(401);
    expect((await proxy(new Request(`${at}/api/v1/projects`, { headers: { cookie: "re_browser_5173=browser-key-of-this-run" } }), run, fetchImpl)).status).toBe(401);
  });

  test("with no browser key and no word that the check is off, nothing is served", async () => {
    const { calls, fetchImpl } = engine();
    const res = await proxy(new Request(`${at}/api/v1/projects`), { OPENSOURCEBOOK_CLIENT_TOKEN: "secret-token", ENGINE_URL: "http://engine.test" }, fetchImpl);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("with nothing set up it says how to start the app, by the command the install gives", async () => {
    const { fetchImpl } = engine();
    const res = await proxy(new Request(`${at}/api/session`), {}, fetchImpl);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_set_up");
    expect(body.message).toMatch(/^Open Sourcebook is not running yet\. Start Open Sourcebook and it opens the right page for you\./);
    expect(body.message).toContain('"opensourcebook", or "npm start" in its folder');
    expect(body.message).toContain("OPENSOURCEBOOK_BROWSER_GATE=off");
  });

  test("the engine's own guards on an asset reach the browser", async () => {
    const fetchImpl = (async () =>
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml", "content-security-policy": "sandbox", "x-content-type-options": "nosniff", "content-disposition": "attachment" } })) as unknown as typeof fetch;
    const res = await proxy(new Request(`${at}/api/v1/assets/a1`, { headers: browser }), run, fetchImpl);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });
});

describe("settings under the names they had before the app was called Open Sourcebook", () => {
  test("an old name is read as the new one, and the new one wins when both are given", () => {
    expect(withOldNames({ RE_CLIENT_TOKEN: "old", ENGINE_URL: "http://engine.test" } as ProxyEnv)).toMatchObject({ OPENSOURCEBOOK_CLIENT_TOKEN: "old", ENGINE_URL: "http://engine.test" });
    expect(withOldNames({ RE_BROWSER_GATE: "off", OPENSOURCEBOOK_BROWSER_GATE: "on" } as ProxyEnv).OPENSOURCEBOOK_BROWSER_GATE).toBe("on");
    const same = { OPENSOURCEBOOK_CLIENT_TOKEN: "new" };
    expect(withOldNames(same)).toBe(same);
  });

  test("a person's own .dev.vars from before still serves the app", async () => {
    const { calls, fetchImpl } = engine();
    const old = { RE_CLIENT_TOKEN: "secret-token", ENGINE_URL: "http://engine.test", RE_BROWSER_GATE: "off" } as ProxyEnv;
    expect((await proxy(new Request("https://web.test/api/v1/projects"), old, fetchImpl)).status).toBe(200);
    expect(new Headers(calls[0]?.init.headers).get("x-client-token")).toBe("secret-token");
  });

  test("a run started by a launcher from before, with the old key names, lets its browser in and nobody else", async () => {
    const { fetchImpl } = engine();
    const old = { RE_CLIENT_TOKEN: "secret-token", ENGINE_URL: "http://engine.test", RE_BROWSER_KEY: "browser-key-of-this-run", RE_DOOR_KEY: "door-key-of-this-run" } as ProxyEnv;
    expect((await proxy(new Request("http://127.0.0.1:5173/api/v1/projects", { headers: { cookie: "opensourcebook_browser_5173=browser-key-of-this-run" } }), old, fetchImpl)).status).toBe(200);
    expect((await proxy(new Request("http://127.0.0.1:5173/api/v1/projects"), old, fetchImpl)).status).toBe(401);
  });
});
