import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { homeAddress, Phone, phoneChoice, rememberPhone } from "../phone.ts";
import { parseArgs } from "../main.ts";

function call(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("phone: off by default, turned on and off from the control, which needs its token and this computer's Host", async () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-phone-"));
  const lines: string[] = [];
  const phone = new Phone({ home, webPort: 1, doorPort: 0, controlPort: 0, token: "phone-token-0123456789", say: (l = "") => lines.push(l), ansi: false, address: () => "192.168.1.50", listenHost: "127.0.0.1" });
  try {
    assert.equal(phoneChoice(home), false);
    await phone.start(false);
    const port = phone.controlPort;
    const ok = { host: `127.0.0.1:${port}`, "x-phone-token": "phone-token-0123456789" };
    assert.equal((await call(port, "GET", "/phone", { host: `127.0.0.1:${port}` })).status, 401);
    assert.equal((await call(port, "GET", "/phone", { ...ok, "x-phone-token": "phone-token-0123456788" })).status, 401);
    assert.equal((await call(port, "GET", "/phone", { ...ok, host: `evil.example:${port}` })).status, 421);
    const off = await call(port, "GET", "/phone", ok);
    assert.deepEqual(off.body, { on: false, devices: [] });
    assert.equal((await call(port, "POST", "/phone/code", ok)).status, 409);

    const on = await call(port, "POST", "/phone/on", ok);
    assert.equal(on.body.on, true);
    assert.match(on.body.address, /^http:\/\/192\.168\.1\.50:\d+$/);
    assert.match(on.body.code.url, /^http:\/\/192\.168\.1\.50:\d+\/pair#[A-Za-z0-9_-]{22}$/);
    assert.match(on.body.code.svg, /^<svg/);
    assert.equal(phoneChoice(home), true, "turning it on is remembered");
    assert.ok(lines.some((l) => l.includes("Open on your phone is on") && l.includes("--no-phone")));

    const next = await call(port, "POST", "/phone/code", ok);
    assert.notEqual(next.body.code.url, on.body.code.url);
    const old = on.body.code.url.split("#")[1];
    assert.equal(phone.codes.redeem(old, "10.0.0.2"), "wrong", "a new code closes the old one");

    const { device } = phone.store.add("iPhone, Safari");
    assert.equal((await call(port, "DELETE", `/phone/devices/${device.id}`, ok)).body.devices.length, 0);
    assert.equal((await call(port, "DELETE", `/phone/devices/${device.id}`, ok)).status, 404);

    const offAgain = await call(port, "POST", "/phone/off", ok);
    assert.equal(offAgain.body.on, false);
    assert.equal(offAgain.body.code, undefined);
    assert.equal(phoneChoice(home), false);
  } finally {
    await phone.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("phone: the terminal shows the code, the address and the plain-HTTP line", async () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-phone-"));
  const lines: string[] = [];
  const phone = new Phone({ home, webPort: 1, doorPort: 0, controlPort: 0, token: "t".repeat(20), say: (l = "") => lines.push(l), ansi: true, address: () => "10.0.0.7", listenHost: "127.0.0.1" });
  try {
    await phone.start(true);
    const text = lines.join("\n");
    assert.match(text, /Scan this with your phone's camera/);
    assert.match(text, /\x1b\[30;107m/);
    assert.match(text, /Open Sourcebook on your phone: http:\/\/10\.0\.0\.7:\d+/);
    assert.match(text, /not encrypted/);
    // The pairing code is only in the picture, never printed as text.
    assert.ok(!/pair#/.test(text));
  } finally {
    await phone.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("phone: the remembered choice, and the flags that change it", () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-phone-"));
  rememberPhone(home, true);
  assert.equal(phoneChoice(home), true);
  rmSync(home, { recursive: true, force: true });
  assert.equal(parseArgs(["--phone"], {}).phone, true);
  assert.equal(parseArgs(["--no-phone"], {}).phone, false);
  assert.equal(parseArgs([], {}).phone, undefined);
  assert.deepEqual(parseArgs(["devices", "remove", "ab12"], {}), { command: "devices", open: true, rest: ["remove", "ab12"] });
});

test("phone: the home address is a private address of a real network card", () => {
  const nic = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null });
  assert.equal(homeAddress({ lo0: [nic("127.0.0.1", true)], utun4: [nic("10.8.0.2")], en0: [nic("192.168.1.23")] }), "192.168.1.23");
  assert.equal(homeAddress({ en0: [nic("8.8.8.8")] }), undefined);
  assert.equal(homeAddress({}), undefined);
});

test("browser reopen: a tab from an earlier run gets a fresh page opened in this computer's browser, a path of the app only, and not twice in a row", async () => {
  const home = mkdtempSync(join(tmpdir(), "opensourcebook-phone-"));
  const opened: string[] = [];
  const phone = new Phone({ home, webPort: 1, doorPort: 0, controlPort: 0, token: "phone-token-0123456789", say: () => undefined, ansi: false, listenHost: "127.0.0.1", reopen: (to) => (opened.push(to), true) });
  try {
    await phone.start(false);
    const port = phone.controlPort;
    const send = (body: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/browser/reopen", headers: { host: `127.0.0.1:${port}`, "x-phone-token": "phone-token-0123456789", "content-type": "application/json" } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.on("error", reject);
        req.end(body);
      });
    assert.equal(await send(JSON.stringify({ to: "//evil.example" })), 200);
    assert.deepEqual(opened, ["/"]);
    assert.equal(await send(JSON.stringify({ to: "/projects/p1" })), 429, "not twice in a row");
    assert.equal((await call(port, "POST", "/browser/reopen", { host: `127.0.0.1:${port}` })).status, 401, "only with the token");
  } finally {
    await phone.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
