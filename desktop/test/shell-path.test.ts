import assert from "node:assert/strict";
import { test } from "node:test";
import { loginShell, mergePath, parseShellPath, printPathArgs, resolvePath, usualFolders } from "../src/shell-path.ts";

test("the PATH is read between the marks, whatever the shell's start files print", () => {
  const args = printPathArgs();
  const mark = /'(__[A-Z_]+__)'/.exec(args[1]!)![1]!;
  assert.equal(parseShellPath(`Welcome!\n${mark}/a:/b${mark}\nbye`), "/a:/b");
  assert.equal(parseShellPath("no marks here"), undefined);
  assert.equal(parseShellPath(`${mark}/a:/b`), undefined);
  assert.equal(parseShellPath(`${mark}${mark}`), undefined);
});

test("PATH lists are joined in order, each folder once", () => {
  assert.equal(mergePath(["/n:/b", undefined, "/a::/b", "/c"], ":"), "/n:/b:/a:/c");
  assert.equal(mergePath(["C:\\a;C:\\b", "C:\\a"], ";"), "C:\\a;C:\\b");
});

test("the usual folders include ~/.local/bin and Homebrew's on a Mac", () => {
  const mac = usualFolders("darwin", "/Users/ana");
  assert.ok(mac.includes("/Users/ana/.local/bin"));
  assert.ok(mac.includes("/opt/homebrew/bin"));
  assert.ok(mac.includes("/usr/local/bin"));
  assert.ok(!usualFolders("linux", "/home/ana").includes("/opt/homebrew/bin"));
  assert.deepEqual(usualFolders("win32", "C:\\"), []);
});

test("the login shell is $SHELL, else zsh on a Mac", () => {
  assert.equal(loginShell({ SHELL: "/bin/bash" }, "darwin"), "/bin/bash");
  assert.equal(loginShell({}, "darwin"), "/bin/zsh");
});

test("a Finder-launched app's bare PATH gets the app's own folders, the shell's PATH and the usual folders", async () => {
  let asked: { shell: string; args: string[] } | undefined;
  const { path, fromShell } = await resolvePath({
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh" },
    platform: "darwin",
    home: "/Users/ana",
    first: ["/App/node/bin", "/Data/bin"],
    run: async (shell, args) => {
      asked = { shell, args };
      return `noise\n${/'(__[A-Z_]+__)'/.exec(args[1]!)![1]}/Users/ana/.nvm/versions/node/v24/bin:/usr/bin${/'(__[A-Z_]+__)'/.exec(args[1]!)![1]}`;
    },
  });
  assert.equal(asked?.shell, "/bin/zsh");
  assert.ok(fromShell);
  const dirs = path.split(":");
  assert.deepEqual(dirs.slice(0, 4), ["/App/node/bin", "/Data/bin", "/Users/ana/.nvm/versions/node/v24/bin", "/usr/bin"]);
  assert.ok(dirs.includes("/Users/ana/.local/bin"));
  assert.ok(dirs.includes("/opt/homebrew/bin"));
  assert.equal(new Set(dirs).size, dirs.length);
});

test("a shell that says nothing still leaves the usual folders", async () => {
  const { path, fromShell } = await resolvePath({ env: { PATH: "/usr/bin" }, platform: "darwin", home: "/Users/ana", run: async () => "" });
  assert.equal(fromShell, false);
  assert.ok(path.split(":").includes("/Users/ana/.local/bin"));
});

test("Windows is not asked through a shell", async () => {
  const { path, fromShell } = await resolvePath({ env: { Path: "C:\\x" }, platform: "win32", run: async () => assert.fail("no shell on Windows") });
  assert.equal(fromShell, false);
  assert.equal(path, "C:\\x");
});
