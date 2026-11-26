/** The box's walls as written for macOS's sandbox, and the checks on what goes in them, without running sandbox-exec. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boxConfigDir, boxed, CLAUDE_FILES, claudeAdapter, claudeArgs, claudeFilesBoxSpec, claudeReach, claudeTempEnv, FILE_TOOLS, NO_CLAUDE_KEY, WORKSPACE_TOOLS } from "../src/agents/claude.ts";
import { fakeCli } from "./fake-cli.ts";
import { ancestors, boxForPlatform, checkWorkspace, installOf, judgeWorkspace, linkable, reachOf, readsOf, realPath, seatbeltProfile, tempEnv, toolReads, withReach, SANDBOX_EXEC, type Box, type BoxSpec, type ToolFs } from "../src/box.ts";

/** The box is macOS's sandbox, and a profile names POSIX paths: these read one, which Windows writes with its own. */
const seatbelt = { skip: process.platform === "win32" && "the box is macOS's sandbox; its profile names POSIX paths" };

const spec = { workspace: "/Users/ann/opensourcebook/.data/v1/work", home: "/Users/ann", read: ["/Users/ann/.npm-global/bin"], write: ["/private/tmp/opensourcebook-claude-box"], deny: ["/Users/ann/.claude/.credentials.json"], connectorPort: 8650 };

test("the profile shuts the home folder, other drives and system writes, then opens only the work, the agent's own files and its tools", seatbelt, () => {
  const p = seatbeltProfile(spec);
  const at = (needle: string) => {
    const i = p.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  const shut = at('(deny file-read* file-write* (subpath "/Users/ann") (subpath "/Volumes") (subpath "/Users/Shared"))');
  const noWrites = at('(deny file-write* (subpath "/"))');
  // Later rules win, so every opening comes after the walls.
  assert.ok(at('(allow file-read* (subpath "/Users/ann/.npm-global/bin"))') > shut);
  const opened = at('(allow file-read* file-write* (subpath "/Users/ann/opensourcebook/.data/v1/work") (subpath "/private/tmp/opensourcebook-claude-box"))');
  assert.ok(opened > noWrites);
  // The keychains and the login file are shut last, so nothing opened before reaches them.
  assert.ok(at('(deny file-read* file-write* (subpath "/Users/ann/Library/Keychains") (subpath "/Users/ann/.claude/.credentials.json"))') > opened);
  assert.ok(at('(allow file-write* (subpath "/dev"))') > noWrites);
  // The shared temporary folders are shut for reading and writing; nothing opens them again.
  assert.ok(at('(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/tmp"))') < opened);
  assert.doesNotMatch(p, /allow file-[^\n]*\(subpath "\/private\/(tmp|var\/folders|var\/tmp)"\)/);
  // No Unix socket but the system's name lookup.
  const sockets = at("(deny network-outbound (remote unix-socket))");
  assert.ok(at('(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))') > sockets);
  assert.equal(p.match(/unix-socket \(path/g)?.length, 1);
  assert.ok(at('(allow network-outbound (remote ip "localhost:8650"))') > at('(deny network-outbound (remote ip "localhost:*"))'));
  assert.doesNotMatch(p, /Desktop|Documents|\.ssh/);
  // The folders above what is opened can be seen to exist (a program resolving its real path needs that), and no more:
  // as literals, for metadata only, never their contents.
  assert.ok(p.includes('(allow file-read-metadata (literal "/Users") (literal "/Users/ann") (literal "/private/tmp") (literal "/private/var/folders") (literal "/private/var/tmp") (literal "/Users/ann/.npm-global") (literal "/Users/ann/opensourcebook") (literal "/Users/ann/opensourcebook/.data") (literal "/Users/ann/opensourcebook/.data/v1"))'));
  assert.doesNotMatch(p, /allow file-read\* [^\n]*"\/Users\/ann\/\.npm-global"\)/);
  assert.deepEqual(ancestors(["/Users/ann/a/b/c", "/private/tmp/x", "/Users/ann"], "/Users/ann"), ["/Users/ann/a", "/Users/ann/a/b"]);
});

test("the agent's own temporary folder is opened, by its real path, with the folders above it seen to exist", seatbelt, () => {
  const p = seatbeltProfile({ ...spec, tmp: "/private/var/folders/ab/cd/T/opensourcebook-box-tmp-1" });
  assert.ok(p.includes('(allow file-read* file-write* (subpath "/Users/ann/opensourcebook/.data/v1/work") (subpath "/private/tmp/opensourcebook-claude-box") (subpath "/private/var/folders/ab/cd/T/opensourcebook-box-tmp-1"))'));
  assert.ok(p.includes('(literal "/private/var/folders/ab") (literal "/private/var/folders/ab/cd") (literal "/private/var/folders/ab/cd/T")'));
  assert.deepEqual(tempEnv("/private/var/folders/ab/cd/T/x"), { TMPDIR: "/private/var/folders/ab/cd/T/x/", TMP: "/private/var/folders/ab/cd/T/x", TEMP: "/private/var/folders/ab/cd/T/x" });
  // Claude Code keeps its own scratch files in /tmp unless told otherwise.
  assert.equal(claudeTempEnv("/private/var/folders/ab/cd/T/x").CLAUDE_CODE_TMPDIR, "/private/var/folders/ab/cd/T/x");
  assert.deepEqual(claudeTempEnv(undefined), {});
});

test("there is a box only on macOS with sandbox-exec, and it wraps the agent's command", () => {
  assert.equal(boxForPlatform("linux", () => true), undefined);
  assert.equal(boxForPlatform("darwin", () => false), undefined);
  const box = boxForPlatform("darwin", (p) => p === SANDBOX_EXEC)!;
  const wrapped = box.wrap("claude", ["-p"], spec);
  assert.equal(wrapped.bin, SANDBOX_EXEC);
  assert.equal(wrapped.args[0], "-p");
  assert.equal(wrapped.args[1], seatbeltProfile(spec));
  assert.deepEqual(wrapped.args.slice(2), ["claude", "-p"]);
});

test("a workspace must be a real folder of its own, never the home folder, above it, or an agent's settings", () => {
  // The real path, since a Mac's temp folder sits behind a link.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-home-")));
  try {
    mkdirSync(join(home, "opensourcebook", "work"), { recursive: true });
    mkdirSync(join(home, ".claude", "x"), { recursive: true });
    symlinkSync(join(home, "opensourcebook", "work"), join(home, "link"));
    assert.deepEqual(checkWorkspace(join(home, "link"), home), { path: join(home, "opensourcebook", "work") }, "by its real path");
    assert.match((checkWorkspace(home, home) as { problem: string }).problem, /folder of its own/);
    assert.match((checkWorkspace(join(home, "opensourcebook"), home) as { problem: string }).problem, /folder of its own/);
    assert.match((checkWorkspace(join(home, ".claude", "x"), home) as { problem: string }).problem, /own settings/);
    assert.match((checkWorkspace("relative/path", home) as { problem: string }).problem, /absolute/);
    assert.match((checkWorkspace(join(home, "nope", "x"), home) as { problem: string }).problem, /does not exist/);
    const system = process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : "/usr/bin";
    assert.match((checkWorkspace(system, home) as { problem: string }).problem, /folder of its own/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an installed copy's video work folder, under ~/.opensourcebook, is a workspace because the connector was set up with it; settings folders stay refused whatever it was set up with", () => {
  // The layout the one-line install makes: the app in ~/.opensourcebook/app, the scenes service's data beside its code.
  const home = "/Users/ann";
  const root = "/Users/ann/.opensourcebook/app/services/scenes/.data";
  const temps = ["/private/var/folders/ab/cd/T", "/private/tmp"];
  const work = `${root}/job1/work`;
  const problem = (path: string, roots: string[] = [root]) => (judgeWorkspace(path, home, temps, roots) as { problem?: string }).problem;
  assert.deepEqual(judgeWorkspace(work, home, temps, [root]), { path: work }, "inside the scenes service's own folder");
  assert.match(problem(work, [])!, /\.opensourcebook at the top of the home folder/, "not without the connector being set up with it, and the real reason is said");
  assert.match(problem(root)!, /top of the home folder/, "never the root itself");
  assert.match(problem("/Users/ann/.opensourcebook/app/engine/x")!, /top of the home folder/, "the rest of the app's folder stays refused");
  assert.match(problem("/Users/ann/.opensourcebook/state/x")!, /top of the home folder/);
  assert.match(problem("/Users/ann/.npm/x")!, /top of the home folder/, "other dot folders stay refused");
  // Settings, logins and keys: refused even when a root was set up there.
  for (const dir of [".ssh", ".gnupg", ".aws", ".claude", ".codex", ".config", ".gemini", ".cursor", ".docker", ".kube"]) {
    const set = `/Users/ann/${dir}/opensourcebook`;
    assert.match(problem(`${set}/job1/work`, [set])!, /own settings/, dir);
  }
  assert.match(problem(`${root}/job1/.claude/x`)!, /own settings/, "a settings folder inside the root");
  assert.match(problem("/Users/ann/.opensourcebook/job/work", [home])!, /top of the home folder/, "the home folder is never a root");
  assert.match(problem("/Users/ann/.opensourcebook/job/work", ["/"])!, /top of the home folder/, "nor a folder above it");
  // A developer's copy in a plain folder needs no root.
  assert.deepEqual(judgeWorkspace("/Users/ann/code/opensourcebook/services/scenes/.data/job1/work", home, temps), { path: "/Users/ann/code/opensourcebook/services/scenes/.data/job1/work" });
});

test("the desktop app's jobs folder, in ~/Library/Application Support, is a workspace when the connector was set up with it; the rest of ~/Library stays refused", () => {
  const home = "/Users/ann";
  const temps = ["/private/var/folders/ab/cd/T", "/private/tmp"];
  const root = "/Users/ann/Library/Application Support/Open Sourcebook/jobs";
  const work = `${root}/job1/work`;
  const problem = (path: string, roots: string[] = [root]) => (judgeWorkspace(path, home, temps, roots) as { problem?: string }).problem;
  assert.deepEqual(judgeWorkspace(work, home, temps, [root]), { path: work });
  assert.match(problem(work, [])!, /own settings/, "not without the connector being set up with it");
  assert.match(problem(root)!, /own settings/, "never the root itself");
  assert.match(problem("/Users/ann/Library/Application Support/Open Sourcebook/state/x")!, /own settings/, "the rest of the app's data folder stays refused");
  assert.match(problem("/Users/ann/Library/Application Support/Other/x/y")!, /own settings/, "another app's folder stays refused");
  assert.match(problem("/Users/ann/Library/Keychains/x/y")!, /own settings/);
  assert.match(problem(`${root}/job1/.claude/x`)!, /own settings/, "a settings folder inside the root");
  // A root of ~/Library itself, or one folder in it, opens nothing there.
  assert.match(problem("/Users/ann/Library/Caches/x/y", ["/Users/ann/Library"])!, /own settings/);
  assert.match(problem("/Users/ann/Library/Application Support/x/y", ["/Users/ann/Library/Application Support"])!, /own settings/);
});

test("on disk, the installed layout's work folder is a workspace when its root is named, through links too", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-home-")));
  try {
    const root = join(home, ".opensourcebook", "app", "services", "scenes", ".data");
    mkdirSync(join(root, "job1", "work"), { recursive: true });
    mkdirSync(join(home, ".ssh", "x"), { recursive: true });
    symlinkSync(root, join(home, "data-link"));
    assert.deepEqual(checkWorkspace(join(root, "job1", "work"), home, tmpdir(), [join(home, "data-link")]), { path: join(root, "job1", "work") });
    assert.match((checkWorkspace(join(root, "job1", "work"), home) as { problem: string }).problem, /\.opensourcebook/);
    assert.match((checkWorkspace(join(home, ".ssh", "x"), home, tmpdir(), [join(home, ".ssh")]) as { problem: string }).problem, /own settings/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path is named by its real path, through links, also when its last parts do not exist yet", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-real-")));
  try {
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    assert.equal(realPath(join(base, "link", "not-yet", "x")), join(base, "real", "not-yet", "x"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("on a Mac, a path behind the system's /var link is named by its /private real path, which is what the sandbox sees", { skip: process.platform !== "darwin" && "macOS only: /var is a link to /private/var there, and the box is macOS's sandbox" }, () => {
  assert.equal(realPath("/var/folders/ab/cd/T/opensourcebook-box-tmp-1"), "/private/var/folders/ab/cd/T/opensourcebook-box-tmp-1");
  assert.ok(seatbeltProfile({ ...spec, tmp: "/var/folders/ab/cd/T/x" }).includes('(subpath "/private/var/folders/ab/cd/T/x")'));
  assert.match((checkWorkspace("/private/var/folders", "/Users/nobody-here") as { problem: string }).problem, /folder of its own/);
});

test("a workspace is never in a dot folder at the top of the home folder, nor in ~/Library, whatever its name; a dot folder inside a project is fine", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-home-")));
  try {
    const dirs = [".kube/x", ".docker/run", ".npm/cache", ".local/share/x", ".anything-new/x", "Library/Application Support/X", "opensourcebook/.claude/x", "opensourcebook/services/scenes/.data/v1/work", "Desktop/opensourcebook/work"];
    for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true });
    for (const dir of dirs.slice(0, 7)) assert.match((checkWorkspace(join(home, dir), home) as { problem: string }).problem, /own settings/, dir);
    // Open Sourcebook's own work folders: the video maker's, inside the repo's services/scenes/.data, and any project folder.
    assert.deepEqual(checkWorkspace(join(home, "opensourcebook/services/scenes/.data/v1/work"), home), { path: join(home, "opensourcebook/services/scenes/.data/v1/work") });
    assert.deepEqual(checkWorkspace(join(home, "Desktop/opensourcebook/work"), home), { path: join(home, "Desktop/opensourcebook/work") });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  // In temporary folders: inside this user's own, never a folder beside it (on a Mac, the system's per-user cache
  // folder sits next to it). Built for whatever system runs the test, with a temporary folder of the test's own.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-temps-")));
  const nobody = join(base, "no-home");
  try {
    const temp = join(base, "T");
    mkdirSync(join(temp, "work"), { recursive: true });
    mkdirSync(join(base, "C", "work"), { recursive: true });
    assert.deepEqual(checkWorkspace(join(temp, "work"), nobody, temp), { path: join(temp, "work") });
    assert.match((checkWorkspace(join(base, "C", "work"), nobody, temp) as { problem: string }).problem, /folder of its own/);
    assert.match((checkWorkspace(temp, nobody, temp) as { problem: string }).problem, /folder of its own/, "the temporary folder itself is not a folder of its own");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the tools on PATH are opened read only as narrowly as they run: their PATH folder, each linked program's package, never a whole home folder", seatbelt, () => {
  const home = "/Users/ann";
  const files = new Set([`${home}/.npm-global/lib/node_modules/@x/cli/package.json`, `${home}/.homebrew/Cellar`]);
  const links: Record<string, string> = {
    [`${home}/.npm-global/bin/cli`]: `${home}/.npm-global/lib/node_modules/@x/cli/bin/run.js`,
    [`${home}/.local/bin/claude`]: `${home}/.local/share/claude/versions/2.1.0`,
    [`${home}/.local/bin/tool`]: `${home}/.local/share/uv/tools/tool/bin/tool`,
    [`${home}/.local/bin/sneaky`]: `${home}/.ssh/id_ed25519`,
    [`${home}/.local/bin/doc`]: `${home}/Documents/x.sh`,
  };
  const fs: ToolFs = {
    exists: (p) => files.has(p),
    list: (dir) => Object.keys(links).filter((l) => l.startsWith(`${dir}/`)).map((l) => l.slice(dir.length + 1)),
    link: (p) => links[p],
  };
  const reads = toolReads(`/usr/bin:${home}/.npm-global/bin:${home}/.local/bin:${home}/bin:${home}:${home}/Desktop/tools/bin:${home}/.homebrew/bin:/opt/homebrew/bin`, home, fs);
  assert.deepEqual(reads.sort(), [
    `${home}/.homebrew`,
    `${home}/.local/bin`,
    `${home}/.local/share/claude/versions`,
    `${home}/.local/share/uv/tools/tool`,
    `${home}/.npm-global/bin`,
    `${home}/.npm-global/lib/node_modules/@x/cli`,
    `${home}/bin`,
  ]);
  assert.ok(!reads.includes(`${home}/.npm-global`) && !reads.includes(`${home}/.local`), "never a whole install folder");
  // A program straight under a first-level folder opens only itself.
  assert.equal(installOf(`${home}/.bun/bun`, home, () => false), `${home}/.bun/bun`);
  assert.equal(installOf(`${home}/.ssh/x`, home, () => false), undefined);
});

test("in a workspace Claude Code gets its own tools, inside the box; without one it has none", seatbelt, () => {
  const base = { turnId: "t1", systemPrompt: "s", prompt: "p", cwd: "/Users/ann/opensourcebook/.data/v1/work", mcp: { name: "opensourcebook", url: "http://127.0.0.1:8650/mcp/t1", headers: {} } };
  const box = boxForPlatform("darwin", () => true)!;
  const turn = { ...base, workspace: { access: "full" as const, box, connectorPort: 8650, model: { baseUrl: "http://127.0.0.1:8650/model/t1", secret: "turn-secret" } } };
  const args = claudeArgs(turn);
  assert.ok(!args.includes("--tools"), "its own tools are on");
  assert.equal(args[args.indexOf("--allowedTools") + 1], ["mcp__opensourcebook", ...WORKSPACE_TOOLS].join(","));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  // By its real path, as the box names every path (a Mac's temp folder sits behind a link).
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-tmp-")));
  try {
    const env = { PATH: "/usr/bin", HOME: "/Users/ann", OPENSOURCEBOOK_CONNECTOR_TOKEN: "connector-secret", ANTHROPIC_API_KEY: "k", META_API_KEY: "m" };
    const command = boxed("claude", args, turn, env, "/Users/ann", tmp);
    assert.equal(command.bin, SANDBOX_EXEC);
    const profile = command.args[1]!;
    assert.match(profile, /\(subpath "\/Users\/ann\/opensourcebook\/\.data\/v1\/work"\)/);
    assert.match(profile, /localhost:8650/);
    assert.ok(profile.includes(`(subpath "${boxConfigDir(tmp)}")`), "a settings folder of its own");
    assert.ok(profile.includes('(subpath "/Users/ann/.claude/.credentials.json") (subpath "/Users/ann/.claude.json"))'), "the person's login stays shut");
    assert.doesNotMatch(profile, /allow[^\n]*\/Users\/ann\/\.claude/, "nothing of the person's ~/.claude is opened");
    // Only plain settings pass, its own settings folder, and the turn's secret for its model calls through the
    // connector, as a gateway's token: never a login, an OAuth token, the connector's token or other keys.
    assert.deepEqual(command.env, { PATH: "/usr/bin", HOME: "/Users/ann", CLAUDE_CONFIG_DIR: boxConfigDir(tmp), ANTHROPIC_BASE_URL: "http://127.0.0.1:8650/model/t1", ANTHROPIC_AUTH_TOKEN: "turn-secret", DISABLE_AUTOUPDATER: "1", ENABLE_TOOL_SEARCH: "false" });
    assert.ok(!Object.keys(command.env).some((key) => /OAUTH/.test(key)), "no subscription token of any kind");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(claudeArgs(base)[claudeArgs(base).indexOf("--tools") + 1], "");
});

test("Claude Code is boxed only on an API key the person gave the connector, which only the connector uses, and only for model calls", async () => {
  assert.equal(claudeAdapter().boxing?.unready(), NO_CLAUDE_KEY);
  assert.equal(claudeAdapter().boxing?.upstream?.(), undefined);
  // Asked for a workspace without a key, it never runs in the box.
  const box = boxForPlatform("darwin", () => true)!;
  const refused = await claudeAdapter({ bin: "/nonexistent/claude" }).run({ turnId: "t", systemPrompt: "s", prompt: "p", cwd: "/tmp", mcp: { name: "opensourcebook", url: "u", headers: {} }, workspace: { access: "full" as const, box, connectorPort: 1 } }).done;
  assert.deepEqual(refused, { ok: false, problem: "error", detail: NO_CLAUDE_KEY });
  const adapter = claudeAdapter({ apiKey: "sk-ant-fake" });
  assert.equal(adapter.boxing?.unready(), undefined);
  const upstream = adapter.boxing!.upstream!()!;
  assert.equal(upstream.origin, "https://api.anthropic.com");
  assert.deepEqual(upstream.headers, { "x-api-key": "sk-ant-fake" });
  assert.ok(upstream.allows("POST", "/v1/messages") && upstream.allows("POST", "/v1/messages/count_tokens"));
  assert.ok(!upstream.allows("GET", "/v1/messages") && !upstream.allows("POST", "/v1/files") && !upstream.allows("POST", "/api/oauth/profile"));
});

test("a files-only workspace: its file tools only, confined to the folder by its own rules, no shell or web, on its own login", () => {
  const box = boxForPlatform("darwin", () => true)!;
  const args = claudeArgs({ turnId: "t", systemPrompt: "s", prompt: "p", cwd: "/Users/ann/opensourcebook/.data/v1/work", mcp: { name: "opensourcebook", url: "u", headers: {} }, workspace: { access: "files", box, connectorPort: 8650 } });
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes("--restricted"), "confines the file tools to the folder and drops every tool that runs code");
  assert.equal(after("--tools"), FILE_TOOLS.join(","));
  assert.deepEqual(JSON.parse(after("--settings")!), { permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true } });
  assert.equal(after("--allowedTools"), ["mcp__opensourcebook", ...FILE_TOOLS].join(","));
  assert.equal(after("--permission-mode"), "dontAsk");
  for (const tool of ["Bash", "WebFetch", "WebSearch", "Agent"]) assert.ok(!args.join(" ").includes(tool), tool);
  assert.ok(!args.some((a) => /OAUTH|ANTHROPIC/.test(a)));
  assert.equal(claudeAdapter().filesOnly?.note, CLAUDE_FILES);
});

test("its second wall: the box opens the folder, the program and its own login and state, and nothing else of the person's", seatbelt, () => {
  const spec = claudeFilesBoxSpec("/opt/homebrew/bin/claude", { turnId: "t", systemPrompt: "s", prompt: "p", cwd: "/Users/ann/opensourcebook/.data/v1/work", mcp: { name: "opensourcebook", url: "u", headers: {} }, workspace: { access: "files", connectorPort: 8650 } }, { PATH: "/usr/bin" }, "/Users/ann");
  assert.deepEqual(spec.own, ["/Users/ann/.claude", "/Users/ann/Library/Keychains", "/Users/ann/Library/Caches/claude-cli-nodejs"]);
  assert.deepEqual(spec.write, []);
  const p = seatbeltProfile(spec);
  const own = p.indexOf('(allow file-read* file-write* (regex "^/Users/ann/\\\\.claude") (regex "^/Users/ann/Library/Keychains") (regex "^/Users/ann/Library/Caches/claude-cli-nodejs"))');
  assert.ok(own > p.indexOf('(deny file-read* file-write* (subpath "/Users/ann/Library/Keychains"))'), "opened after the keychain wall, so it wins");
  assert.ok(p.includes('(subpath "/Users/ann/opensourcebook/.data/v1/work")'));
  assert.doesNotMatch(p, /Desktop|Documents|\.ssh|\.codex/);
  // A full workspace never opens them.
  assert.doesNotMatch(seatbeltProfile({ workspace: "/w", home: "/Users/ann", read: [], write: [], connectorPort: 1 }), /regex/);
});

test("a files-only turn runs on its own login: no connector address, no secret, no settings folder of its own, none of Open Sourcebook's settings", seatbelt, async () => {
  const result = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", usage: {} })}\n`;
  const cli = fakeCli([{ args: "-p", out: result }]);
  const wrapped: string[][] = [];
  const box = { kind: "seatbelt" as const, wrap: (bin: string, args: string[]) => (wrapped.push(args), { bin, args }) };
  // The test's own environment may hold some of these; the turn adds none of them.
  const saved = Object.fromEntries(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN = "connector-token";
  try {
    const end = await claudeAdapter({ bin: cli.bin }).run({ turnId: "t", systemPrompt: "s", prompt: "p", cwd: tmpdir(), mcp: { name: "opensourcebook", url: "u", headers: {} }, workspace: { access: "files", box, connectorPort: 8650 } }).done;
    assert.equal(end.ok, true);
    assert.equal(wrapped.length, 1, "inside the box");
    const env = cli.env();
    assert.ok(!env.some((line) => /^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|CLAUDE_CONFIG_DIR|OPENSOURCEBOOK_)/.test(line)));
    assert.ok(env.some((line) => line.startsWith("HOME=")), "its own home, where it keeps its login");

    // With workspace.tmp (real boxed turns), the prompt file lives in that turn tmp folder.
    const turnTmp = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-turn-tmp-")));
    try {
      const boxedTurn = await claudeAdapter({ bin: cli.bin }).run({ turnId: "t2", systemPrompt: "boxed-sys", prompt: "p", cwd: tmpdir(), mcp: { name: "opensourcebook", url: "u", headers: {} }, workspace: { access: "files", box, connectorPort: 8650, tmp: turnTmp } }).done;
      assert.equal(boxedTurn.ok, true);
      const promptPath = join(turnTmp, "opensourcebook-system-prompt.txt");
      assert.equal(readFileSync(promptPath, "utf8"), "boxed-sys");
      assert.ok(cli.calls().at(-1)!.includes(`--system-prompt-file ${promptPath}`));
    } finally {
      rmSync(turnTmp, { recursive: true, force: true });
    }
  } finally {
    delete process.env.OPENSOURCEBOOK_CONNECTOR_TOKEN;
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    cli.remove();
  }
});

test("what a workspace may read beside it: what was named in the folder around it, and the exact file each link there leads to", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opensourcebook-reach-")));
  const jobs = join(home, "app", "jobs");
  const job = join(jobs, "v1");
  const work = join(job, "work");
  const docs = join(home, "Documents", "course");
  for (const dir of [work, join(job, "sources"), join(job, "extracted", "s1"), docs, join(home, ".ssh"), join(home, "Library", "Keychains")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(job, "README.md"), "note");
  writeFileSync(join(docs, "chapter.pdf"), "pdf");
  writeFileSync(join(home, ".ssh", "id_fake"), "not a key");
  writeFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "not a keychain");
  symlinkSync(join(docs, "chapter.pdf"), join(job, "sources", "s1-chapter.pdf"));
  symlinkSync(docs, join(job, "sources", "s2-folder"));
  symlinkSync(join(home, ".ssh", "id_fake"), join(job, "sources", "s3-key"));
  symlinkSync(join(home, "Library", "Keychains", "login.keychain-db"), join(job, "sources", "s4-keychain"));
  symlinkSync(join(home, "gone.pdf"), join(job, "sources", "s5-gone.pdf"));
  try {
    const named = [join(job, "README.md"), join(job, "sources"), join(job, "extracted"), join(job, "pictures")];
    const found = reachOf(work, named, home, tmpdir(), [jobs]);
    assert.ok("reach" in found);
    assert.deepEqual(found.reach.write, [work]);
    assert.deepEqual(found.reach.folders, [join(job, "sources"), join(job, "extracted")]);
    assert.deepEqual(found.reach.files, [join(job, "README.md"), join(docs, "chapter.pdf")], "the original only: no folder a link leads to, no key, no keychain, nothing missing");
    assert.deepEqual(found.missing, [join(job, "pictures")]);
    assert.deepEqual(readsOf(found.reach), [...found.reach.folders, ...found.reach.files]);
    assert.ok("problem" in reachOf(work, [docs], home, tmpdir(), [jobs]), "nothing outside the folder around the workspace");
    assert.ok("problem" in reachOf(work, [job], home, tmpdir(), [jobs]), "not the folder around it as a whole");
    assert.ok("problem" in reachOf(work, ["sources"], home, tmpdir(), [jobs]), "absolute paths only");
    assert.ok("problem" in reachOf(join(home, "a"), [join(home, "README.md")], home, tmpdir()), "never beside a workspace whose folder is the home folder");
    const inside = reachOf(work, [join(work, "skills")], home, tmpdir(), [jobs]);
    assert.ok("reach" in inside && !inside.reach.folders.length && !inside.missing.length, "the workspace itself is already open");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a linked file is opened unless it is where programs keep settings, logins or keys", () => {
  assert.equal(linkable("/Users/ann/Documents/a.pdf", "/Users/ann"), true);
  assert.equal(linkable("/Users/ann/Library/Mobile Documents/com~apple~CloudDocs/a.pdf", "/Users/ann"), true, "iCloud Drive");
  assert.equal(linkable("/Volumes/USB/a.pdf", "/Users/ann"), true);
  assert.equal(linkable("/Users/ann/.ssh/id_ed25519", "/Users/ann"), false);
  assert.equal(linkable("/Users/ann/.claude.json", "/Users/ann"), false, "a dot file at the top of the home folder");
  assert.equal(linkable("/Users/ann/Library/Keychains/login.keychain-db", "/Users/ann"), false);
  assert.equal(linkable("/Users/ann/code/app/.codex/auth.json", "/Users/ann"), false);
});

test("the box opens a reach's reads for every agent, on top of what its adapter opens", () => {
  const seen: BoxSpec[] = [];
  const box: Box = { kind: "seatbelt", wrap: (bin, args, s) => (seen.push(s), { bin, args }) };
  const reach = { write: ["/w/job/work"], folders: ["/w/job/extracted"], files: ["/w/job/README.md", "/Users/ann/Documents/a.pdf"] };
  withReach(box, reach).wrap("agent", [], { ...spec, read: ["/opt/agent"] });
  assert.deepEqual(seen[0]!.read, ["/opt/agent", "/w/job/extracted", "/w/job/README.md", "/Users/ann/Documents/a.pdf"]);
  assert.equal(withReach(box, undefined), box);
  assert.match(seatbeltProfile({ ...spec, read: readsOf(reach) }), /\(allow file-read\* [^\n]*\(subpath "\/Users\/ann\/Documents\/a\.pdf"\)/);
});

test("Claude Code beside its folder: the folders of what it may read added, every edit there refused, its folder still its own", () => {
  const box = boxForPlatform("darwin", () => true)!;
  const reach = { write: ["/j/v1/work"], folders: ["/j/v1/sources", "/j/v1/extracted"], files: ["/j/v1/README.md", "/Users/ann/Documents/a.pdf"] };
  for (const access of ["files", "full"] as const) {
    const args = claudeArgs({ turnId: "t", systemPrompt: "s", prompt: "p", cwd: "/j/v1/work", mcp: { name: "opensourcebook", url: "u", headers: {} }, workspace: { access, box, connectorPort: 8650, reach, ...(access === "full" ? { model: { baseUrl: "b", secret: "s" } } : {}) } });
    const dirs = args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));
    assert.deepEqual(dirs, ["/j/v1/sources", "/j/v1/extracted", "/j/v1", "/Users/ann/Documents"], access);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    assert.deepEqual(settings.permissions.deny, ["Edit(//j/v1/sources/**)", "Edit(//j/v1/extracted/**)", "Edit(//j/v1/README.md)", "Edit(//Users/ann/Documents/a.pdf)", "Edit(//Users/ann/Documents/**)"], `${access}: the job folder itself holds the work folder, so only the box keeps writes out of it`);
    if (access === "files") assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true);
  }
  assert.deepEqual(claudeReach(undefined), { dirs: [], settings: { permissions: {} } });
  assert.equal(claudeAdapter().filesOnly?.reads, true, "with its file tools only it runs in the box, which holds the reads exactly");
});
