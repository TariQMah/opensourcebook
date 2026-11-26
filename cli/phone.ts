/**
 * Open Sourcebook on a phone: the switch, the door and the QR code.
 *
 * By default Open Sourcebook listens on this computer only. The person turns the phone on (`opensourcebook start --phone`, or "Open on
 * your phone" in Settings); the launcher remembers the choice in `.opensourcebook/phone.json` until it is turned off
 * (`--no-phone`, or Settings). While it is on, the door (door.ts) listens on the home network and the terminal shows a
 * QR code with a one-time pairing code.
 *
 * The web app manages it through a small control server on 127.0.0.1 that answers only with the shared PHONE_TOKEN,
 * which the web app's proxy adds (web/worker/proxy.ts) and the browser never holds:
 *
 *   GET    /phone               { on, address?, code?: { url, expiresAt, svg }, devices }
 *   POST   /phone/on            turns it on (remembered) and makes a code
 *   POST   /phone/off           turns it off (remembered); paired devices stay paired
 *   POST   /phone/code          a new code (the old one stops working)
 *   DELETE /phone/devices/:id   unpairs a device
 *
 * The same control server lets this computer's browser in (opener.ts): the web app's proxy asks it whether a code
 * someone opened is one the launcher made, and `opensourcebook open` asks it for a new code.
 *
 *   POST   /browser/code        { code, expiresAt }: a one-time code for /api/open
 *   POST   /browser/redeem      { code } -> 200 { ok: true } once for a right code, else 403
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Device } from "./devices.ts";
import { DeviceStore } from "./devices.ts";
import { openDoor, type Door } from "./door.ts";
import type { OpenCodes, RunKeys } from "./opener.ts";
import type { VoiceInstalls } from "./voice.ts";
import { PairingCodes } from "./pairing.ts";
import { encodeQr, svgQr, terminalQr } from "./qr.ts";
import { writePrivate } from "./secrets.ts";

export const PHONE_FILE = "phone.json";
export const DEVICES_FILE = "devices.json";

/** Whether the person turned the phone on, as remembered. Off when never chosen. */
export function phoneChoice(home: string): boolean {
  const file = join(home, PHONE_FILE);
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

export function rememberPhone(home: string, on: boolean): void {
  writePrivate(join(home, PHONE_FILE), `${JSON.stringify({ on }, null, 2)}\n`);
}

/**
 * This computer's address on the home network: a private IPv4 address of a network card, preferring Wi-Fi and
 * Ethernet over tunnels and virtual ones. Undefined when it has none (no network).
 */
export function homeAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
  const found: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue;
      found.push({ name, address: i.address });
    }
  }
  const rank = (name: string) => (/^(en|eth|wl)/.test(name) ? 0 : /^(utun|tun|tap|wg|bridge|docker|vmnet|veth|llw|awdl)/.test(name) ? 2 : 1);
  found.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return found[0]?.address;
}

export interface PhoneOptions {
  home: string;
  /** The web app's port on 127.0.0.1. */
  webPort: number;
  /** The door's port on the network. */
  doorPort: number;
  /** The control server's port on 127.0.0.1. */
  controlPort: number;
  token: string;
  say: (line?: string) => void;
  /** Whether the terminal shows colour (the QR code is drawn black on white). */
  ansi: boolean;
  address?: () => string | undefined;
  /** Where the door listens: every address, unless a test says otherwise. */
  listenHost?: string;
  /** This run's keys: the door marks what it passes on with the door key. */
  keys?: RunKeys;
  /** The one-time codes that let this computer's browser in. */
  openCodes?: OpenCodes;
  /** The installs of voices that run on this computer, which the voice screen's button starts (cli/voice.ts). */
  voices?: VoiceInstalls;
}

export interface PhoneStatus {
  on: boolean;
  address?: string;
  code?: { url: string; expiresAt: string; svg: string };
  devices: Device[];
}

export class Phone {
  readonly store: DeviceStore;
  readonly codes = new PairingCodes();
  private door: Door | undefined;
  private control: Server | undefined;
  private current: { url: string; expiresAt: number } | undefined;
  private readonly o: PhoneOptions;
  /** The control server's port, once it listens. */
  controlPort = 0;

  constructor(options: PhoneOptions) {
    this.o = options;
    this.store = new DeviceStore(join(options.home, DEVICES_FILE));
  }

  private address(): string | undefined {
    return (this.o.address ?? homeAddress)();
  }

  private base(): string | undefined {
    const ip = this.address();
    return ip ? `http://${ip}:${this.door?.port ?? this.o.doorPort}` : undefined;
  }

  get on(): boolean {
    return this.door !== undefined;
  }

  /** Starts the control server, and the door when the person turned the phone on. */
  async start(on: boolean): Promise<void> {
    this.control = await this.listenControl();
    if (on) await this.turnOn({ remember: false, show: true });
  }

  async turnOn({ remember = true, show = false }: { remember?: boolean; show?: boolean } = {}): Promise<PhoneStatus> {
    if (remember) rememberPhone(this.o.home, true);
    if (!this.door) {
      this.door = await openDoor({
        upstreamPort: this.o.webPort,
        port: this.o.doorPort,
        ...(this.o.listenHost ? { listenHost: this.o.listenHost } : {}),
        store: this.store,
        codes: this.codes,
        ...(this.o.keys ? { key: this.o.keys.door } : {}),
        onPaired: (device) => this.o.say(`  Paired ${device.name}. See paired devices with "npm run devices", or in Settings.`),
      });
      this.o.say(`  Open on your phone is on: phones on this network that you pair can use Open Sourcebook. Turn it off in Settings, or with "opensourcebook start --no-phone".`);
    }
    this.newCode();
    if (show) this.show();
    return this.status();
  }

  async turnOff(): Promise<PhoneStatus> {
    rememberPhone(this.o.home, false);
    this.codes.close();
    this.current = undefined;
    const door = this.door;
    this.door = undefined;
    if (door) {
      door.server.closeAllConnections();
      await door.close();
      this.o.say("  Open on your phone is off: Open Sourcebook listens on this computer only.");
    }
    return this.status();
  }

  newCode(): PhoneStatus {
    const base = this.base();
    if (!this.door || !base) return this.status();
    const { code, expiresAt } = this.codes.issue();
    this.current = { url: `${base}/pair#${code}`, expiresAt };
    return this.status();
  }

  /** Draws the open code in the terminal, with the address and what to do. */
  show(): void {
    const say = this.o.say;
    const base = this.base();
    if (!base) {
      say("  This computer is on no home network now, so a phone can't reach it. Join a Wi-Fi network and start Open Sourcebook again.");
      return;
    }
    if (!this.current || !this.codes.openUntil()) this.newCode();
    say();
    say("  Scan this with your phone's camera (same Wi-Fi as this computer):");
    for (const line of terminalQr(encodeQr(this.current!.url), this.o.ansi)) say(`  ${line}`);
    say(`  Open Sourcebook on your phone: ${base}`);
    say(`  The code works once, for ten minutes. For another device, choose Open on your phone in Settings.`);
    say(`  Plain HTTP on your home network: not encrypted, so use it on a network you trust.`);
  }

  status(): PhoneStatus {
    const until = this.codes.openUntil();
    const address = this.on ? this.base() : undefined;
    return {
      on: this.on,
      ...(address ? { address } : {}),
      ...(this.current && until ? { code: { url: this.current.url, expiresAt: new Date(until).toISOString(), svg: svgQr(encodeQr(this.current.url)) } } : {}),
      devices: this.store.list(),
    };
  }

  async stop(): Promise<void> {
    const door = this.door;
    this.door = undefined;
    door?.server.closeAllConnections();
    await Promise.all([door?.close(), new Promise<void>((resolve) => (this.control ? this.control.close(() => resolve()) : resolve()))]);
  }

  private listenControl(): Promise<Server> {
    const server = createServer((req, res) => void this.answer(req, res));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: this.o.controlPort }, () => {
        const a = server.address();
        if (a && typeof a === "object") this.controlPort = a.port;
        resolve(server);
      });
    });
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.controlPort}` && host !== `localhost:${this.controlPort}`) return reply(421, { error: "wrong_host", message: "This address is not this computer." });
    if (!sameToken(req.headers["x-phone-token"], this.o.token)) return reply(401, { error: "unauthorized", message: "The phone token is missing or wrong." });
    const path = (req.url ?? "/").split("?")[0]!;
    try {
      if (req.method === "GET" && path === "/phone") return reply(200, this.status());
      if (req.method === "POST" && path === "/phone/on") return reply(200, await this.turnOn());
      if (req.method === "POST" && path === "/phone/off") return reply(200, await this.turnOff());
      if (req.method === "POST" && path === "/phone/code") {
        if (!this.on) return reply(409, { error: "phone_off", message: "Turn Open on your phone on first." });
        return reply(200, this.newCode());
      }
      const opener = this.o.openCodes;
      if (req.method === "POST" && path === "/browser/code" && opener) {
        const { code, expiresAt } = opener.issue();
        return reply(200, { code, expiresAt: new Date(expiresAt).toISOString() });
      }
      if (req.method === "POST" && path === "/browser/redeem" && opener) {
        const text = await readSmall(req, 1024);
        let code: unknown;
        try {
          code = (JSON.parse(text ?? "") as { code?: unknown }).code;
        } catch {
          return reply(400, { error: "bad_request", message: "Send the code as JSON." });
        }
        return opener.redeem(code) ? reply(200, { ok: true }) : reply(403, { error: "wrong_code", message: "That address was used or has run out." });
      }
      // A voice that runs on this computer, installed from the voice screen: its state, and a start.
      const voice = /^\/launcher\/voices\/([a-z0-9-]{1,40})(\/install)?$/.exec(path);
      const voices = this.o.voices;
      if (voice && voices) {
        const id = voice[1]!;
        if (!voices.has(id)) return reply(404, { error: "not_found", message: `"${id}" is not a voice that runs on this computer.` });
        if (req.method === "GET" && !voice[2]) return reply(200, { voice: id, ...voices.state(id) });
        if (req.method === "POST" && voice[2]) return reply(202, { voice: id, ...voices.start(id) });
      }
      const device = /^\/phone\/devices\/([0-9a-f]{1,32})$/.exec(path);
      if (req.method === "DELETE" && device) {
        if (!this.store.remove(device[1]!)) return reply(404, { error: "not_found", message: "No such device." });
        return reply(200, this.status());
      }
      return reply(404, { error: "not_found", message: "No such route." });
    } catch (error) {
      return reply(500, { error: "phone_failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function readSmall(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > limit) {
        resolve(undefined);
        req.destroy();
      }
    });
    req.on("end", () => resolve(text));
    req.on("error", () => resolve(undefined));
  });
}

function sameToken(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
