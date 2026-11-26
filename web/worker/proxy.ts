/**
 * The same-origin proxy between the browser and the engine.
 *
 * The browser only ever calls its own origin at /api/v1/...; this adds the engine's client token from a server-side
 * secret and forwards the call to ENGINE_URL/v1/.... The token never reaches browser code.
 *
 * Because this proxy holds the token, it serves the engine only to callers Open Sourcebook let in (who):
 *
 *  - "browser": this computer's own browser, holding this run's browser key (OPENSOURCEBOOK_BROWSER_KEY) in a cookie its scripts
 *    cannot read and other sites cannot send. The launcher lets a browser in by opening `/api/open?code=...`, a
 *    one-time code it made and that this proxy checks with it (cli/opener.ts); `opensourcebook open` makes another.
 *  - "device": a request the launcher's door passed on from a paired phone (cli/door.ts), marked with the door's
 *    per-run key (OPENSOURCEBOOK_DOOR_KEY). A device reaches the engine, never the phone's management.
 *  - "tool": a program that already holds the engine's own token (the launcher's health check). It could call the
 *    engine itself, so it gains nothing here.
 *
 * Anything else (another program on this computer, another user of it, a page elsewhere) gets 401 and the web app
 * says how to open Open Sourcebook. A deployed site with no launcher sets OPENSOURCEBOOK_BROWSER_GATE=off and must then sit behind a login
 * gate (Cloudflare Access) before it is exposed (README, "Deploying").
 *
 * `/api/phone/...` goes the same way to the launcher's phone control (cli/phone.ts) with its own token,
 * PHONE_TOKEN: Settings turns "Open on your phone" on and off, shows the pairing code and lists paired devices.
 * Only "browser" may use it, whatever the path's spelling: the decision is by who is calling. `/api/launcher/...` goes
 * there too, for what only the launcher can do (installing a voice that runs on this computer), by the same rule.
 */

export interface ProxyEnv {
  /** The engine's shared client token (a secret; .dev.vars locally). */
  OPENSOURCEBOOK_CLIENT_TOKEN?: string;
  /** The engine's base URL, e.g. http://localhost:8787. */
  ENGINE_URL?: string;
  /** The launcher's control on this computer, e.g. http://127.0.0.1:5181; set by `npm start`. */
  PHONE_URL?: string;
  /** Its token (a secret, like OPENSOURCEBOOK_CLIENT_TOKEN). */
  PHONE_TOKEN?: string;
  /** This run's browser key (cli/opener.ts), set by `npm start`. */
  OPENSOURCEBOOK_BROWSER_KEY?: string;
  /** This run's door key, on everything the door passes on. */
  OPENSOURCEBOOK_DOOR_KEY?: string;
  /** "off" serves anyone who reaches this origin: only for a site behind a login gate, or a web app run alone. */
  OPENSOURCEBOOK_BROWSER_GATE?: string;
}

export type Caller = "browser" | "device" | "tool";

/**
 * The settings under the names they had before the app was called Open Sourcebook: a setting given as `RE_X` (a
 * person's own `.dev.vars`, a secret on a deployed site) is read as `OPENSOURCEBOOK_X` when that one is not given.
 * Everything below reads only the new names.
 */
export function withOldNames(env: ProxyEnv): ProxyEnv {
  const given = env as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const name of Object.keys(given)) {
    if (!name.startsWith("RE_")) continue;
    const next = `OPENSOURCEBOOK_${name.slice(3)}`;
    if (given[next] !== undefined || given[name] === undefined) continue;
    out ??= { ...given };
    out[next] = given[name];
  }
  return (out ?? given) as ProxyEnv;
}

const PREFIX = "/api/";
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]);
/** Request headers the engine reads. Everything else (cookies, Access JWTs, the door's mark) stays here. */
const FORWARD_REQUEST = ["content-type", "accept", "x-upload-filename", "idempotency-key", "range"];
/** Ranges pass through so a video can be seeked; the engine's own guards on an asset pass through too. */
const FORWARD_RESPONSE = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-security-policy",
  "x-content-type-options",
  "content-disposition",
];
export const DOOR_HEADER = "x-opensourcebook-door";
/** How long the browser keeps its cookie; a new run's key replaces it anyway. */
const BROWSER_COOKIE_LIFE_S = 7 * 24 * 60 * 60;

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * How a person opens the app, in the words every message here ends with: first what to do without a terminal, then
 * the command. `opensourcebook` is the command the one-line install gives; `npm run open` is the same in a copy of the code.
 */
const HOW_TO_OPEN = 'Open Open Sourcebook with its shortcut (on Windows, find it in the Start menu); if it is already running, that opens a fresh page for you. If you use a terminal, the command is "opensourcebook open", or "npm run open" in its folder.';
const HOW_TO_START = 'Start Open Sourcebook and it opens the right page for you. If you use a terminal, the command is "opensourcebook", or "npm start" in its folder.';

/** What a browser Open Sourcebook has not let in is told (the app draws its own page for it, src/app/OpenGate.tsx). */
export const NOT_OPENED = `This page opens from Open Sourcebook itself. ${HOW_TO_OPEN}`;

/** The cookie's name, per port: two copies of Open Sourcebook on one computer keep their own. */
export function browserCookie(url: URL): string {
  return `opensourcebook_browser_${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

/** Compares two strings in time that depends only on their lengths. */
function same(a: string | null | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** Who is calling, or undefined when Open Sourcebook did not let them in. */
export function callerOf(request: Request, url: URL, env: ProxyEnv): Caller | undefined {
  const door = request.headers.get(DOOR_HEADER);
  // Something the door passed on is a device's, whatever else it carries; a wrong mark is nobody's.
  if (door !== null) return same(door, env.OPENSOURCEBOOK_DOOR_KEY) ? "device" : undefined;
  if (same(cookie(request, browserCookie(url)), env.OPENSOURCEBOOK_BROWSER_KEY)) return "browser";
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (same(bearer, env.OPENSOURCEBOOK_CLIENT_TOKEN)) return "tool";
  if (!env.OPENSOURCEBOOK_BROWSER_KEY && env.OPENSOURCEBOOK_BROWSER_GATE === "off") return "browser";
  return undefined;
}

/** True when a browser sent this from another site (a cross-site form or fetch). */
function crossSite(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin !== url.origin;
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

export async function proxy(
  request: Request,
  given: ProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const env = withOldNames(given);
  const url = new URL(request.url);
  if (!env.OPENSOURCEBOOK_BROWSER_KEY && env.OPENSOURCEBOOK_BROWSER_GATE !== "off") {
    return error(503, "not_set_up", `Open Sourcebook is not running yet. ${HOW_TO_START} (A web app run alone, or deployed behind a login gate, sets OPENSOURCEBOOK_BROWSER_GATE=off.)`);
  }
  if (url.pathname === "/api/open") return open(request, url, env, fetchImpl);
  if (url.pathname === "/api/reopen") return reopen(request, url, env, fetchImpl);
  const who = callerOf(request, url, env);
  if (!who) {
    // A tab let in by an earlier run (its cookie is from before this start): Open Sourcebook is running, this tab only needs letting in again.
    if (earlierTab(request, url)) return Response.json({ error: "not_opened", message: NOT_OPENED, earlier: true, canReopen: Boolean(env.PHONE_URL && env.PHONE_TOKEN) }, { status: 401, headers: { "cache-control": "no-store" } });
    return error(401, "not_opened", NOT_OPENED);
  }
  if (url.pathname === "/api/session") return Response.json({ in: true, as: who }, { headers: { "cache-control": "no-store" } });
  if (url.pathname === "/api/phone" || url.pathname.startsWith("/api/phone/") || url.pathname.toLowerCase().startsWith("/api/phone")) {
    if (who !== "browser") return error(403, "this_computer_only", "Paired devices are managed in this computer's browser.");
    return phone(request, url, env, fetchImpl);
  }
  // What only the launcher on this computer can do, such as installing a voice that runs here: the same way, this computer's browser only.
  if (url.pathname.toLowerCase().startsWith("/api/launcher/")) {
    if (who !== "browser") return error(403, "this_computer_only", "This is done in the browser on the computer Open Sourcebook runs on.");
    return phone(request, url, env, fetchImpl, "This");
  }
  if (!url.pathname.startsWith(PREFIX + "v1/")) return error(404, "not_found", "No such route.");
  // Opening a folder in the file manager is for the person at this computer, never a paired phone.
  if (who !== "browser" && opensFiles(url.pathname)) return error(403, "this_computer_only", "A job's files open only in the browser on the computer Open Sourcebook runs on.");
  // Naming a folder on this computer (a project's linked folder, the library) is for the person at it, never a phone.
  if (who !== "browser" && namesFolder(request.method, url.pathname)) return error(403, "this_computer_only", "A folder is picked only in the browser on the computer Open Sourcebook runs on.");
  // A backup holds every project, and restoring one writes them: for this computer, never a paired phone.
  if (who === "device" && backsUp(url.pathname)) return error(403, "this_computer_only", "Backing up and restoring are only in the browser on the computer Open Sourcebook runs on.");
  if (!METHODS.has(request.method)) return error(405, "method_not_allowed", "Method not allowed.");
  if (request.method !== "GET" && request.method !== "HEAD" && crossSite(request, url)) {
    return error(403, "cross_site", "Requests must come from this site.");
  }
  if (!env.OPENSOURCEBOOK_CLIENT_TOKEN || !env.ENGINE_URL) {
    return error(500, "proxy_not_configured", "OPENSOURCEBOOK_CLIENT_TOKEN and ENGINE_URL must be set for the web proxy.");
  }

  const target = new URL(url.pathname.slice(PREFIX.length - 1) + url.search, env.ENGINE_URL);
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-client-token", env.OPENSOURCEBOOK_CLIENT_TOKEN);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetchImpl(target.toString(), {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch {
    return error(502, "engine_unreachable", "The engine did not answer.");
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** Whether a path asks the engine to open a folder on this computer (`POST /v1/jobs/:id/files/show`), however it is spelled. */
function opensFiles(path: string): boolean {
  let plain = path;
  try {
    plain = decodeURIComponent(path);
  } catch {
    // A path that does not decode is judged as it is.
  }
  return /\/files\/show/i.test(plain);
}

/** Whether a request names a folder on this computer: linking a project to one or unlinking it, or picking the library. */
function namesFolder(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  let plain = path;
  try {
    plain = decodeURIComponent(path);
  } catch {
    // A path that does not decode is judged as it is.
  }
  plain = plain.replace(/\/+$/, "").toLowerCase();
  return /\/v1\/projects\/[^/]+\/folder$/.test(plain) || /\/v1\/library$/.test(plain);
}

/** Whether a path backs up every project or restores a backup (`/v1/backup`, `/v1/backup/restores/...`), however it is spelled. */
function backsUp(path: string): boolean {
  let plain = path;
  try {
    plain = decodeURIComponent(path);
  } catch {
    // A path that does not decode is judged as it is.
  }
  return /\/v1\/+backup(\/|$)/i.test(plain.replace(/\/+$/, ""));
}

/** Where `/api/open` goes once the browser is in: a path of this app, never another site. */
function landing(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.startsWith("/api/")) return "/";
  return raw;
}

/**
 * `/api/open?code=...&to=/path`: lets this computer's browser in when the launcher made the code, then shows `to`.
 * The code works once (the launcher crosses it off), so the address left in the history opens nothing later.
 */
async function open(request: Request, url: URL, env: ProxyEnv, fetchImpl: typeof fetch): Promise<Response> {
  if (request.method !== "GET") return error(405, "method_not_allowed", "Open the address in the browser.");
  // The door never passes this on: a phone has its own pairing.
  if (request.headers.get(DOOR_HEADER) !== null) return error(403, "this_computer_only", "This address is for the browser on the computer Open Sourcebook runs on.");
  if (!env.OPENSOURCEBOOK_BROWSER_KEY || !env.PHONE_URL || !env.PHONE_TOKEN) return error(503, "not_set_up", `Open Sourcebook is not running yet. ${HOW_TO_START}`);
  const code = url.searchParams.get("code") ?? "";
  let ok: boolean;
  try {
    const answer = await fetchImpl(new URL("/browser/redeem", env.PHONE_URL).toString(), {
      method: "POST",
      headers: { "x-phone-token": env.PHONE_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ code }),
      redirect: "manual",
    });
    ok = answer.status === 200;
  } catch {
    return error(502, "launcher_unreachable", "The launcher did not answer.");
  }
  if (!ok) return openPage();
  return new Response(null, {
    status: 303,
    headers: {
      location: landing(url.searchParams.get("to")),
      "set-cookie": `${browserCookie(url)}=${env.OPENSOURCEBOOK_BROWSER_KEY}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${BROWSER_COOKIE_LIFE_S}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** True when this browser holds a browser cookie of this address that this run did not make: a tab from an earlier run. Never for what the door passes on. */
function earlierTab(request: Request, url: URL): boolean {
  if (request.headers.get(DOOR_HEADER) !== null) return false;
  return Boolean(cookie(request, browserCookie(url)));
}

/**
 * `POST /api/reopen`: a tab from an earlier run asks the launcher to open a fresh opening address in this computer's
 * browser. The tab itself gets nothing: the address goes to the browser by the launcher, as at a start, so the most a
 * caller can do is make a new page of Open Sourcebook appear on this computer. Only for a tab with an earlier run's
 * cookie, from this site, never through the door.
 */
async function reopen(request: Request, url: URL, env: ProxyEnv, fetchImpl: typeof fetch): Promise<Response> {
  if (request.method !== "POST") return error(405, "method_not_allowed", "Method not allowed.");
  if (request.headers.get(DOOR_HEADER) !== null) return error(403, "this_computer_only", "This is done in the browser on the computer Open Sourcebook runs on.");
  if (crossSite(request, url)) return error(403, "cross_site", "Requests must come from this site.");
  if (!earlierTab(request, url)) return error(403, "not_opened", NOT_OPENED);
  if (!env.PHONE_URL || !env.PHONE_TOKEN) return error(503, "not_set_up", `Open Sourcebook was not started by its launcher, so it cannot open a fresh page. ${HOW_TO_OPEN}`);
  let to = "/";
  try {
    const body = (await request.json()) as { to?: unknown };
    if (typeof body.to === "string") to = landing(body.to);
  } catch {
    // No body: the home page.
  }
  try {
    const answer = await fetchImpl(new URL("/browser/reopen", env.PHONE_URL).toString(), {
      method: "POST",
      headers: { "x-phone-token": env.PHONE_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ to }),
      redirect: "manual",
    });
    const said = (await answer.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json(said, { status: answer.status, headers: { "cache-control": "no-store" } });
  } catch {
    return error(502, "launcher_unreachable", "The launcher did not answer.");
  }
}

/** The plain page for an opening address that was used or ran out. */
function openPage(): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Open Sourcebook</title></head>
<body style="font: 17px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 20px">
<h1 style="font-size: 24px">This address has already been used</h1>
<p>Open Open Sourcebook with its shortcut (on Windows, find it in the Start menu). If it is already running, that opens a fresh page for you.</p>
<p>If you use a terminal, the command is <code>opensourcebook open</code>, or <code>npm run open</code> in its folder.</p>
<p>Each address that opens Open Sourcebook works once, for ten minutes, so an old one in the browser's history opens nothing.</p>
</body></html>`;
  return new Response(page, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

const PHONE_METHODS = new Set(["GET", "POST", "DELETE"]);

/** Settings > Phone, through to the launcher's phone control with its token. */
async function phone(request: Request, url: URL, env: ProxyEnv, fetchImpl: typeof fetch, what = "Opening Open Sourcebook on a phone"): Promise<Response> {
  if (!PHONE_METHODS.has(request.method)) return error(405, "method_not_allowed", "Method not allowed.");
  if (request.method !== "GET" && crossSite(request, url)) return error(403, "cross_site", "Requests must come from this site.");
  if (!env.PHONE_URL || !env.PHONE_TOKEN) {
    return error(503, "phone_unavailable", `${what} needs it started the usual way, with all its parts, not the web app alone.`);
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(new URL(url.pathname.slice(PREFIX.length - 1), env.PHONE_URL).toString(), {
      method: request.method,
      headers: { "x-phone-token": env.PHONE_TOKEN },
      redirect: "manual",
    });
  } catch {
    return error(502, "phone_unreachable", "The launcher did not answer.");
  }
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}
