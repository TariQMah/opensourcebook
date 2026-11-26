/**
 * Google's Antigravity CLI (`agy`), the Google agent Open Sourcebook lists, run headless for one turn of Open Sourcebook's chat or a piece of
 * work: the unmodified program as the person installed it. Written from Google's documentation only
 * (antigravity.google/docs, read Nov 23, 2026); no real `agy` has run against this adapter yet, so every part below is
 * as the documentation says, untried.
 *
 * One turn is `agy --input-format stream-json --output-format stream-json`: the prompt goes on stdin as one `user`
 * event (Open Sourcebook's instructions first, as it takes no system prompt of a caller's), stdin is closed, and it ends after its
 * one `result` event (docs/cli/headless). Its events give each tool call once it is made, so there are no drafts.
 *
 * On the person's own sign-in (a chat turn: no workspace). It signs in with their Google account (its own login, in
 * the system keychain), which Open Sourcebook never reads, holds or passes on. Its own shell, file tools and the web must be off
 * and only Open Sourcebook's tools allowed. The documentation offers two ways and neither can be made sure of from it alone:
 * - `agy acp`, where the client answers each permission request. But the documentation says the person's own allow
 *   rules still apply without asking, so a `command(*)` of theirs would run its shell on their login without the
 *   connector ever being asked; and it does not say how a session is given its folder or MCP servers.
 * - `agy -p` (here with stdin) and the turn's own folder: Open Sourcebook's MCP server in `<folder>/.agents/mcp_config.json`, and a
 *   `PreToolUse` hook in `<folder>/.agents/hooks.json` (docs/hooks) that answers `deny` (a hard block) for every tool
 *   but Open Sourcebook's (`call_mcp_tool` naming Open Sourcebook's server, or `mcp_opensourcebook_<tool>`; docs/mcp) and `auto_approve` for Open Sourcebook's, plus its
 *   terminal sandbox (`--sandbox`: commands without the network). This is the closer one, as a deny there blocks
 *   whatever the person's rules allow, and it is what is built here. But the documentation does not say that a
 *   folder's hooks are read by a headless run in a folder it has never been told to trust, nor how a deny from a hook
 *   and an allow from the person's own hooks or rules are weighed; if the hook were not read, its shell would run
 *   loose on the person's login (`agy -p` starts in `auto` mode, which runs commands it judges safe).
 * So the gate is not assumed to work: the connector checks it itself on each computer (`checkAntigravity`). The first
 * time a turn on a sign-in is asked for, and again whenever `agy --version` changes, it runs one small check turn in a
 * throwaway folder of its own, with the same gate and flags a real turn uses, asking the agent to create `canary.txt`
 * with its own tools and to call Open Sourcebook's harmless `probe` tool (from a tiny MCP server of the check's own). It passes only
 * if the file does not exist afterwards and the gate recorded a refused call; an agent that did not try is asked once
 * more, more firmly, and otherwise, like an error, a timeout or no sign-in, the check fails closed. A pass is kept in
 * the connector's own state (its version and date, `~/.opensourcebook-agent-connector/antigravity-check.json`, or the folder from
 * before the rename, `~/.re-agent-connector`, read where it is), and turns on the
 * sign-in run from then on; until a pass it is listed as checking, or as not able to run with the reason
 * (`ON_LOGIN_BROKE`, `couldNotCheck`). There are no settings of the person's to change instead:
 * `~/.gemini/antigravity-cli/settings.json` is theirs and is never written, nor anything else under `~/.gemini`.
 *
 * In the box (a full workspace, on macOS): its shell, files and web on, inside the box (`../box.ts`), never on the
 * person's login. It runs on a Gemini API key the person gave the connector (`apiKey`), and holds none: its settings
 * say to call the Gemini API directly (`modelProvider: "gemini"`, docs/install), with the turn's own secret as its
 * `GEMINI_API_KEY` and this connector as the endpoint (`GOOGLE_GEMINI_BASE_URL`, the custom endpoint docs/install
 * names), and the connector forwards its model calls to Google with the key. Its home folder for the turn (`HOME`) is
 * a folder of the turn's own, holding its settings and Open Sourcebook's MCP server (`~/.gemini/config/mcp_config.json`); the
 * person's `~/.gemini` and keychains stay shut. That `agy` takes its settings from `HOME` is not documented; if it does
 * not, it finds nothing it may read and the turn fails, without anything of the person's opened. Every tool is
 * approved there (`--dangerously-skip-permissions`), and only there, as the operating system holds the walls.
 *
 * Whether it is signed in it has no documented command to say, and Open Sourcebook does not read its keychain, so that is left
 * unsaid until a turn says otherwise (`authentication required`).
 */
import { programOf } from "./locate.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { plainEnv, programReads, tempEnv, toolReads, type Box, type BoxSpec } from "../box.ts";
import { connectorHome, MCP_SERVER } from "../names.ts";
import { heardLimit } from "./limit.ts";
import { marks } from "./marks.ts";
import { agentEnv, allLines, firstLine, Remembered, run, saidOf, stop } from "./process.ts";
import type { AgentAdapter, AgentInfo, AgentModel, ModelTier, Problem, RunningTurn, TurnEnd, TurnSpec } from "./types.ts";

export interface AntigravityOptions {
  bin?: string;
  /** A Gemini API key the person gave the connector, only for the box, where the connector adds it to the calls it forwards. */
  apiKey?: string;
  /** Where the Gemini API is; only changed by tests. */
  apiOrigin?: string;
  /** Where the connector keeps what its check of the gate found; only changed by tests. Never under `~/.gemini`. */
  stateDir?: string;
  /** How long one check turn may take; only changed by tests. */
  checkTimeoutMs?: number;
}

export const ON_LOGIN_BROKE = "Antigravity ran a command Open Sourcebook told it not to, so Open Sourcebook will not run it on your sign-in. Restart Open Sourcebook's connector to check again.";
export const ON_LOGIN_CHECKING = "Checking that Antigravity keeps to Open Sourcebook's tools on this computer…";
export const couldNotCheck = (why: string) => `Open Sourcebook could not check Antigravity yet: ${why}. Open Sourcebook checks again in a few minutes, or when Open Sourcebook's connector restarts.`;
/** A check that could not finish is tried again after this long; one that found the gate broken is not, until a restart or a new version. */
const RECHECK_MS = 10 * 60_000;
/** The file the check turn asks the agent to make, and Open Sourcebook's harmless tool it asks it to call. */
export const CANARY = "canary.txt";
export const PROBE_TOOL = "probe";
export const defaultStateDir = (home: string = homedir()) => connectorHome(home);
const STATE_FILE = "antigravity-check.json";
export const NO_GEMINI_KEY = "Its shell and the web in a workspace need a Gemini API key in Open Sourcebook's connector settings (OPENSOURCEBOOK_GEMINI_API_KEY).";
export const ANTIGRAVITY_FULL = "Works in each piece of work's own folder with its own shell, files and web, walled in on this Mac, on the Gemini API key in Open Sourcebook's connector settings.";

const GEMINI_API = "https://generativelanguage.googleapis.com";

/** The Gemini API's model calls (listing, reading, counting and generating), the only ones forwarded for it. */
export const geminiAllows = (method: string, path: string) =>
  (method === "POST" && /^\/v1(beta|alpha)?\/models\/[^/]+:(generateContent|streamGenerateContent|countTokens)$/.test(path)) || (method === "GET" && /^\/v1(beta|alpha)?\/models(\/[^/:]+)?$/.test(path));

/** The `PreToolUse` hook of a turn on the person's sign-in: its name in `hooks.json`. */
export const GATE_HOOK = "opensourcebook-only-opensourcebook-tools";

export function antigravityAdapter(options: AntigravityOptions = {}): AgentAdapter {
  const name = options.bin ?? "agy";
  // Looked for again at each check and turn, also where it installs itself when that is not on the PATH (./locate.ts).
  const where = () => programOf(name);
  const unready = () => (options.apiKey ? undefined : NO_GEMINI_KEY);
  const catalog = new Remembered<AgentModel[]>(5 * 60_000);
  const stateDir = options.stateDir ?? defaultStateDir();
  const versionOf = (text: string) => text.replace(/^(agy|antigravity)\s+v?/i, "");
  let check: { version: string; running?: Promise<CheckVerdict>; verdict?: CheckVerdict; at?: number } | undefined;
  /** What the check found for this version: a pass kept from before, the one running now, or a new one. */
  const verdictFor = (version: string): Promise<CheckVerdict> => {
    if (passedFor(stateDir) === version) return Promise.resolve({ ok: true });
    if (check?.version === version) {
      if (check.running) return check.running;
      if (check.verdict && (check.verdict.ok || !check.verdict.retry || Date.now() - (check.at ?? 0) < RECHECK_MS)) return Promise.resolve(check.verdict);
    }
    const current: { version: string; running?: Promise<CheckVerdict>; verdict?: CheckVerdict; at?: number } = { version };
    check = current;
    current.running = checkAntigravity(where(), options.checkTimeoutMs).then((verdict) => {
      if (verdict.ok) savePass(stateDir, version);
      current.verdict = verdict;
      current.at = Date.now();
      current.running = undefined;
      return verdict;
    });
    return current.running;
  };
  const startTurn = (spec: TurnSpec, boxedTurn: boolean): RunningTurn => {
    const bin = where();
    // A turn on the person's sign-in: its hook's script in a folder of the turn's own, outside the folder it works in.
    const gate = boxedTurn ? undefined : mkdtempSync(join(tmpdir(), "opensourcebook-agy-gate-"));
    let command: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
    if (boxedTurn) command = boxedAntigravity(bin, spec);
    else {
      writeLoginTurnFiles(spec, gate!);
      command = { bin, args: antigravityArgs(spec), env: agentEnv(process.env) };
    }
    const seen: AntigravityFacts = {};
    const spawned = run(command.bin, command.args, { cwd: spec.cwd, stdin: antigravityInput(spec), env: command.env, onLine: (line) => readAntigravityLine(line, seen) });
    let killed = false;
    const done = spawned.exited.then(({ code, stderr, missing }): TurnEnd => {
      if (gate) {
        rmSync(gate, { recursive: true, force: true });
        rmSync(join(spec.cwd, ".agents"), { recursive: true, force: true });
      }
      if (missing) return { ok: false, problem: "agentMissing", detail: `${bin} was not found` };
      const model = seen.model ?? spec.model;
      const facts = {
        ...(model ? { model } : {}),
        ...(seen.tokensIn !== undefined ? { tokensIn: seen.tokensIn } : {}),
        ...(seen.inputTokens !== undefined ? { inputTokens: seen.inputTokens } : {}),
        ...(seen.tokensOut !== undefined ? { tokensOut: seen.tokensOut } : {}),
        ...(seen.cacheReadTokens !== undefined ? { cacheReadTokens: seen.cacheReadTokens } : {}),
      };
      if (killed) return { ok: false, problem: "stopped", ...facts };
      if (code === 0 && seen.status === "SUCCESS") return { ok: true, ...(seen.text?.trim() ? { text: seen.text.trim() } : {}), ...facts };
      const words = `${seen.error ?? ""}\n${stderr}`;
      const problem = classifyAntigravity(words);
      const limit = problem === "agentLimit" ? heardLimit(words) : undefined;
      return { ok: false, problem, ...facts, ...(limit ? { limit } : {}), ...saidOf(seen.error), detail: `exit ${code}; ${seen.status ?? "no result"}; ${words.trim().slice(0, 300)}` };
    });
    return {
      done,
      kill() {
        killed = true;
        stop(spawned.child);
      },
    };
  };
  return {
    id: "antigravity",
    label: "Antigravity",
    mark: marks.antigravity,
    // Its first interactive run signs in with a Google account (docs/install).
    signIn: name,
    // From its own install page (docs/getting-started, the CLI tab): macOS and Linux.
    install: { command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", url: "https://antigravity.google/docs/getting-started?tab=cli" },
    boxing: { note: ANTIGRAVITY_FULL, unready, upstream: () => (options.apiKey ? { origin: options.apiOrigin ?? GEMINI_API, headers: { "x-goog-api-key": options.apiKey }, allows: geminiAllows } : undefined) },
    // The slugs its documentation names (docs/cli/headless, docs/models); `agy models` gives the account's own.
    models: [
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash", maker: "google", tier: "fast" },
      { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon", maker: "google", tier: "strong" },
    ],
    // Flash for a chat's many small steps (on every plan, Free too); for long work its own default, Gemini 4 Neon.
    defaultModels: { chat: "gemini-3.8-flash-medium" },
    // What `--effort` takes; which of them a model offers depends on the model (most: low to high), and a level it
    // lacks is refused, so none is passed unless picked (a slug already names its level).
    efforts: [
      { id: "low", label: "Low", weight: "light" },
      { id: "medium", label: "Medium", weight: "medium" },
      { id: "high", label: "High", weight: "high" },
      { id: "xhigh", label: "Extra high", weight: "max" },
      { id: "max", label: "Max", weight: "max" },
    ],
    async info(): Promise<AgentInfo> {
      const bin = where();
      const version = await firstLine(bin, ["--version"]);
      if (version.missing || !version.text) return { installed: false };
      const models = await catalog.get(() => antigravityModels(bin));
      const v = versionOf(version.text);
      // Never ready before a pass: a check is started (or the running one joined), and until it ends it says so.
      void verdictFor(v);
      const settled: CheckVerdict | undefined = passedFor(stateDir) === v ? { ok: true } : check?.version === v && !check.running ? check.verdict : undefined;
      const unavailable = !settled ? ON_LOGIN_CHECKING : settled.ok ? undefined : settled.reason;
      return { installed: true, version: v, ...(unavailable ? { unavailable } : {}), ...(models.length ? { models } : {}) };
    },
    run(spec: TurnSpec): RunningTurn {
      const bin = where();
      const refuse = (detail: string): RunningTurn => ({ done: Promise.resolve({ ok: false, problem: "error", detail }), kill: () => undefined });
      const boxedTurn = spec.workspace?.access === "full";
      if (spec.workspace && !boxedTurn) return refuse("it has no files-only workspace");
      if (boxedTurn && (unready() || !spec.workspace!.model || !spec.workspace!.box || !spec.workspace!.tmp)) return refuse(unready() ?? NO_GEMINI_KEY);
      if (boxedTurn) return startTurn(spec, true);
      if (existsSync(join(spec.cwd, ".agents"))) return refuse("the turn's folder already holds a .agents folder");
      // On the person's sign-in only once the check has passed for the `agy` installed now.
      let inner: RunningTurn | undefined;
      let killed = false;
      const done = (async (): Promise<TurnEnd> => {
        const version = await firstLine(bin, ["--version"]);
        if (version.missing || !version.text) return { ok: false, problem: "agentMissing", detail: `${bin} was not found` };
        const verdict = await verdictFor(versionOf(version.text));
        if (killed) return { ok: false, problem: "stopped" };
        if (!verdict.ok) return { ok: false, problem: "error", detail: verdict.reason };
        inner = startTurn(spec, false);
        return inner.done;
      })();
      return {
        done,
        kill() {
          killed = true;
          inner?.kill();
        },
      };
    },
  };
}

/** What the check of the gate found: passed, or not with a reason a person can read (and whether to try again later). */
export type CheckVerdict = { ok: true } | { ok: false; reason: string; retry: boolean };

/** The version a pass was kept for, if one was. */
export function passedFor(stateDir: string): string | undefined {
  try {
    const kept = JSON.parse(readFileSync(join(stateDir, STATE_FILE), "utf8")) as { version?: unknown };
    return typeof kept.version === "string" ? kept.version : undefined;
  } catch {
    return undefined;
  }
}

function savePass(stateDir: string, version: string): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, STATE_FILE), JSON.stringify({ version, passedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch {
    // Not kept: it is checked again next time, which is the safe side.
  }
}

/** The check turn's prompt: make the canary with its own tools, and call Open Sourcebook's harmless tool. */
export function probePrompt(firm: boolean): string {
  const ask = `Do these two things now, in this order. 1. Create a file named ${CANARY} in the current folder containing the word hello, using your own shell or file-writing tool. 2. Call the ${PROBE_TOOL} tool of the "${MCP_SERVER}" MCP server. Then say what happened to each.`;
  return firm ? `${ask} This is a test of your tools: you must actually attempt both tool calls, even if you expect them to be refused; do not skip them or only describe them.` : ask;
}

/** A tiny MCP server over stdio with one harmless tool (`probe`), only for the check turn. */
export function probeServerScript(): string {
  return `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(MCP_SERVER)}, version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: ${JSON.stringify(PROBE_TOOL)}, description: "A harmless check: does nothing and answers ok.", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
  else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
});
`;
}

type ProbeOutcome = "pass" | "broke" | "idle" | { unchecked: string };

/** One check turn in a throwaway folder of its own: the same gate and flags a real turn on the sign-in uses. */
export async function probeAntigravity(bin: string, firm: boolean, timeoutMs = 120_000): Promise<ProbeOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "opensourcebook-agy-check-"));
  const work = join(dir, "work");
  const gate = join(dir, "gate");
  mkdirSync(work, { mode: 0o700 });
  mkdirSync(gate, { mode: 0o700 });
  const log = join(gate, "decisions.log");
  try {
    const script = join(gate, "gate.mjs");
    const server = join(gate, "probe-server.mjs");
    writeFileSync(script, gateScript(MCP_SERVER, log), { mode: 0o600 });
    writeFileSync(server, probeServerScript(), { mode: 0o600 });
    const agents = join(work, ".agents");
    mkdirSync(agents, { mode: 0o700 });
    writeFileSync(join(agents, "mcp_config.json"), JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [server] } } }, null, 2), { mode: 0o600 });
    writeFileSync(join(agents, "hooks.json"), JSON.stringify(gateHooks(script), null, 2), { mode: 0o600 });
    const seen: AntigravityFacts = {};
    const spawned = run(bin, antigravityArgs({}), { cwd: work, stdin: antigravityInput({ systemPrompt: "You are being checked by Open Sourcebook: follow the user's steps exactly.", prompt: probePrompt(firm) }), env: agentEnv(process.env), onLine: (line) => readAntigravityLine(line, seen) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop(spawned.child);
    }, timeoutMs);
    const { code, stderr, missing } = await spawned.exited;
    clearTimeout(timer);
    if (existsSync(join(work, CANARY))) return "broke";
    if (missing) return { unchecked: `${bin} was not found` };
    if (timedOut) return { unchecked: "the check took too long" };
    const words = `${seen.error ?? ""}\n${stderr}`;
    if (classifyAntigravity(words) === "agentSignedOut") return { unchecked: "you are not signed in to Antigravity (run agy once to sign in)" };
    if (code !== 0 || seen.status !== "SUCCESS") return { unchecked: `its check turn ended with an error (${words.trim().slice(0, 120) || `exit ${code}`})` };
    const denied = existsSync(log) && readFileSync(log, "utf8").split("\n").includes("deny");
    return denied ? "pass" : "idle";
  } catch (error) {
    return { unchecked: `the check could not start (${(error as Error).message})` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Checks on this computer that the gate holds: one check turn, once more more firmly if it did not try, else closed. */
export async function checkAntigravity(bin: string, timeoutMs?: number): Promise<CheckVerdict> {
  for (const firm of [false, true]) {
    const outcome = await probeAntigravity(bin, firm, timeoutMs);
    if (outcome === "pass") return { ok: true };
    if (outcome === "broke") return { ok: false, reason: ON_LOGIN_BROKE, retry: false };
    if (outcome !== "idle") return { ok: false, reason: couldNotCheck(outcome.unchecked), retry: true };
  }
  return { ok: false, reason: couldNotCheck("Antigravity did not try the test command, so Open Sourcebook could not tell whether its block holds"), retry: true };
}

/**
 * The command line for one turn: the prompt on stdin, its events as JSON lines, no slash commands or skills expanded.
 * Every tool approved only in the box, where the walls are the operating system's; on the person's sign-in its
 * terminal sandbox besides the turn's hook.
 */
export function antigravityArgs(spec: Partial<TurnSpec>): string[] {
  const boxed = spec.workspace?.access === "full";
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    ...(boxed ? ["--dangerously-skip-permissions"] : ["--sandbox"]),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
  ];
}

/** What it gets on stdin: one `user` event, Open Sourcebook's instructions first, as it takes no system prompt of a caller's. */
export function antigravityInput(spec: Pick<TurnSpec, "systemPrompt" | "prompt">): string {
  return `${JSON.stringify({ event: "user", message: { content: `<instructions>\n${spec.systemPrompt}\n</instructions>\n\n${spec.prompt}` } })}\n`;
}

/** Open Sourcebook's MCP server for the turn, in its `mcp_config.json` shape. Open Sourcebook's tools can take minutes (a render). */
export function antigravityMcp(spec: TurnSpec): Record<string, unknown> {
  return { mcpServers: { [spec.mcp.name]: { serverUrl: spec.mcp.url, headers: spec.mcp.headers, timeoutSeconds: 900 } } };
}

/** The turn's `hooks.json`: every tool call goes past the gate first. */
export function gateHooks(gateScript: string, node: string = process.execPath): Record<string, unknown> {
  return { [GATE_HOOK]: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${JSON.stringify(node)} ${JSON.stringify(gateScript)}`, timeout: 10 }] }] } };
}

/**
 * The gate's answer for one tool call (`toolCall` of a `PreToolUse` hook's input): Open Sourcebook's tools approved, everything
 * else refused. Open Sourcebook's tools are called through `call_mcp_tool` naming Open Sourcebook's server, or, when shown to the model one by
 * one, as `mcp_<server>_<tool>` (docs/mcp).
 */
export function gateDecision(call: unknown, server: string): { decision: "auto_approve" | "deny"; reason?: string } {
  const c = (typeof call === "object" && call !== null ? call : {}) as { name?: unknown; args?: unknown };
  const args = (typeof c.args === "object" && c.args !== null ? c.args : {}) as Record<string, unknown>;
  const ours = (c.name === "call_mcp_tool" && args.ServerName === server) || (typeof c.name === "string" && c.name.startsWith(`mcp_${server}_`));
  return ours ? { decision: "auto_approve" } : { decision: "deny", reason: "Only Open Sourcebook's tools are on in this turn." };
}

/**
 * The gate as the script the hook runs: it reads the hook's input on stdin and prints `gateDecision`'s answer, and,
 * for the check turn, writes each answer to `log` too.
 */
export function gateScript(server: string, log?: string): string {
  const record = log ? `\n  try {\n    appendFileSync(${JSON.stringify(log)}, answer.decision + "\\n");\n  } catch {}` : "";
  return `${log ? 'import { appendFileSync } from "node:fs";\n' : ""}const gateDecision = ${gateDecision.toString()};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let call;
  try {
    call = JSON.parse(input).toolCall;
  } catch {}
  const answer = gateDecision(call, ${JSON.stringify(server)});${record}
  process.stdout.write(JSON.stringify(answer));
});
`;
}

/**
 * A turn on the person's sign-in: Open Sourcebook's MCP server and the gate's hook in the turn's own folder (`.agents/`), the
 * gate's script in `gate`. Nothing is written to the person's `~/.gemini`.
 */
export function writeLoginTurnFiles(spec: TurnSpec, gate: string): void {
  const script = join(gate, "gate.mjs");
  writeFileSync(script, gateScript(spec.mcp.name), { mode: 0o600 });
  const agents = join(spec.cwd, ".agents");
  mkdirSync(agents, { mode: 0o700 });
  writeFileSync(join(agents, "mcp_config.json"), JSON.stringify(antigravityMcp(spec), null, 2), { mode: 0o600 });
  writeFileSync(join(agents, "hooks.json"), JSON.stringify(gateHooks(script), null, 2), { mode: 0o600 });
}

/** Its home folder in the box: one of the turn's own, inside the turn's own temporary folder. */
export const boxHome = (tmp: string) => join(tmp, "agy-home");

/**
 * Its settings in the box: the Gemini API called directly (on the turn's secret as its key, which the connector swaps
 * for the person's), and its own terminal sandbox off, as macOS's sandbox can't be nested; the box is the wall.
 */
export const BOX_SETTINGS = { modelProvider: "gemini", enableTerminalSandbox: false, showTips: false, showFeedbackSurvey: false, notifications: false };

/** Writes its home folder for a boxed turn: its settings and Open Sourcebook's MCP server, nothing else. */
export function writeBoxHome(spec: TurnSpec, home: string): void {
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify(BOX_SETTINGS, null, 2), { mode: 0o600 });
  writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify(antigravityMcp(spec), null, 2), { mode: 0o600 });
}

/** The box `agy` runs in for a turn with a full workspace: the folder, its program and the tools on its PATH, read only. */
export function antigravityBoxSpec(bin: string, spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): BoxSpec {
  return {
    workspace: spec.cwd,
    home,
    read: [...toolReads(env.PATH, home), ...programReads(bin, env.PATH, home)],
    // Its home for the turn is inside the turn's own temporary folder, opened already.
    write: [],
    // Shut by the home folder's wall already; named again so nothing opened above reaches the person's own settings.
    deny: [join(home, ".gemini")],
    connectorPort: spec.workspace!.connectorPort,
    tmp: spec.workspace!.tmp!,
  };
}

/**
 * The only environment boxed `agy` gets: a few plain settings, its own home and temporary folder, and where its model
 * calls go with the turn's secret as its key. Never the person's key, nor the connector's token.
 */
export function antigravityBoxEnv(spec: TurnSpec, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const tmp = spec.workspace!.tmp!;
  return { ...plainEnv(env), ...tempEnv(tmp), HOME: boxHome(tmp), GEMINI_API_KEY: spec.workspace!.model!.secret, GOOGLE_GEMINI_BASE_URL: spec.workspace!.model!.baseUrl };
}

/** The command that runs `agy` inside the box, for a turn with a full workspace, and the environment it gets. */
export function boxedAntigravity(bin: string, spec: TurnSpec, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  writeBoxHome(spec, boxHome(spec.workspace!.tmp!));
  return { ...(spec.workspace!.box as Box).wrap(bin, antigravityArgs(spec), antigravityBoxSpec(bin, spec, env, home)), env: antigravityBoxEnv(spec, env) };
}

/** A model's tier from its name: Flash the quickest, Hydrogen and Sonnet good, the rest of Gemini 4 and Opus the best. */
export function antigravityTier(label: string): ModelTier | undefined {
  const name = label.toLowerCase();
  if (/flash/.test(name)) return "fast";
  if (/hydrogen|sonnet/.test(name)) return "balanced";
  if (/neon|carbon|argon|opus|orchestrator|pro\b/.test(name)) return "strong";
  return undefined;
}

/** The models `agy models` lists for this account, a slug and its name on each line (docs/cli/headless). */
export function readAntigravityModels(lines: string[]): AgentModel[] {
  return lines.flatMap((line) => {
    const m = /^([a-z0-9][a-z0-9._-]*)\s{2,}(\S.*)$/i.exec(line.trim());
    if (!m) return [];
    const tier = antigravityTier(m[2]!);
    return [{ id: m[1]!, label: m[2]!.trim(), ...(tier ? { tier } : {}) }];
  });
}

async function antigravityModels(bin: string): Promise<AgentModel[]> {
  const { lines, code } = await allLines(bin, ["models"]);
  return code === 0 ? readAntigravityModels(lines) : [];
}

interface AntigravityFacts {
  model?: string;
  /** The words it has said since its last tool step, or its `result`'s response: its last words when the turn ends. */
  text?: string;
  status?: string;
  error?: string;
  tokensIn?: number;
  inputTokens?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
}

const record = (value: unknown) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined);

/** One line of `--output-format stream-json`: `init`, `step_update` or `result` events. Lines that are not JSON are ignored. */
export function readAntigravityLine(line: string, seen: AntigravityFacts): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event.event === "init") {
    const init = record(event.init);
    if (typeof init?.model === "string") seen.model = init.model;
  }
  if (event.event === "step_update") {
    const step = record(event.step_update);
    if (step?.step_type === "tool") seen.text = undefined;
    if (step?.step_type === "agent_response" && typeof step.text_delta === "string") seen.text = `${seen.text ?? ""}${step.text_delta}`;
  }
  if (event.event === "result") {
    const result = record(event.result);
    if (!result) return;
    if (typeof result.status === "string") seen.status = result.status;
    if (typeof result.response === "string" && result.response.trim()) seen.text = result.response;
    if (typeof result.error === "string" && result.error.trim()) seen.error = result.error;
    const usage = record(result.usage);
    if (usage) {
      const num = (key: string) => (typeof usage[key] === "number" && Number.isFinite(usage[key] as number) ? (usage[key] as number) : undefined);
      const input = num("input_tokens");
      const cached = num("cache_read_tokens");
      const out = num("output_tokens");
      if (input !== undefined) {
        seen.tokensIn = input;
        seen.inputTokens = Math.max(0, input - (cached ?? 0));
      }
      if (cached !== undefined) seen.cacheReadTokens = cached;
      if (out !== undefined) seen.tokensOut = out;
    }
  }
}

/** Why a turn failed, from its words: not signed in (`authentication required`), out of quota, or another error. */
export function classifyAntigravity(said: string): Problem {
  if (/authentication required|not (signed|logged) in|unauthenticated|api key not valid|invalid api key|\b401\b/i.test(said)) return "agentSignedOut";
  if (/quota|RESOURCE_EXHAUSTED|rate limit|usage limit|\b429\b/i.test(said)) return "agentLimit";
  return "error";
}
