/**
 * `npm run package`: the Mac app and its disk image, for this Mac's chip.
 *
 *   1. builds the main process (tsc) and stages what the app carries (resources.ts)
 *   2. makes `Open Sourcebook.app` with Electron's packager, its icon from install/site/icon-512.png
 *   3. signs it ad hoc (no paid Apple certificate), which is what an Apple Silicon Mac needs to run it at all
 *   4. makes `out/Open Sourcebook-<version>-<arch>.dmg`: the app, a link to Applications, and the one step the
 *      first open needs, since a Mac asks before opening an app it does not know
 *
 * macOS only for now: Windows (#12) and Linux (#9) are their own steps.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packager } from "@electron/packager";
import { DESKTOP, REPO, RESOURCES, stageAll } from "./resources.ts";

const OUT = join(DESKTOP, "out");
const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "inherit" });

/** The words in the disk image beside the app: how to open it the first time. */
export const FIRST_OPEN = `Open Sourcebook: the first time you open it

1. Drag Open Sourcebook into the Applications folder.
2. Open it. Your Mac says it cannot check it, because Open Sourcebook is not signed with a paid Apple certificate. Click Done (or OK).
3. Open System Settings, then Privacy & Security. Scroll down to the line about Open Sourcebook and click Open Anyway, then confirm.

You do this once. After that it opens like any other app.

The first start sets everything up and takes a few minutes; later starts take seconds. Your projects are kept in
~/Library/Application Support/Open Sourcebook, which updating or replacing the app never touches.
`;

function icon(): string {
  const set = join(OUT, "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  const source = join(REPO, "install", "site", "icon-512.png");
  for (const size of [16, 32, 128, 256, 512]) {
    run("sips", ["-z", String(size), String(size), source, "--out", join(set, `icon_${size}x${size}.png`)]);
    if (size <= 256) run("sips", ["-z", String(size * 2), String(size * 2), source, "--out", join(set, `icon_${size}x${size}@2x.png`)]);
  }
  const file = join(OUT, "icon.icns");
  run("iconutil", ["-c", "icns", set, "-o", file]);
  rmSync(set, { recursive: true, force: true });
  return file;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("npm run package makes the Mac app, so it runs on a Mac.");
  const own = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as { version: string; productName: string };
  run("npx", ["tsc", "-p", join(DESKTOP, "tsconfig.build.json")]);
  await stageAll();
  mkdirSync(OUT, { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const [appDir] = await packager({
    dir: DESKTOP,
    out: join(OUT, "app"),
    overwrite: true,
    platform: "darwin",
    arch,
    name: own.productName,
    appBundleId: "app.opensourcebook.desktop",
    appCategoryType: "public.app-category.education",
    appVersion: own.version,
    icon: icon(),
    asar: true,
    prune: true,
    extraResource: ["node", "installer", "payload"].map((dir) => join(RESOURCES, dir)),
    // Only the built main process, the page and package.json go in the app.
    ignore: [/^\/(src|test|scripts|out|\.cache)(\/|$)/, /^\/tsconfig.*\.json$/, /^\/README\.md$/, /^\/\.gitignore$/],
  });
  if (!appDir) throw new Error("The packager made no app.");
  const app = join(appDir, `${own.productName}.app`);
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);

  const stage = join(OUT, "dmg");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(app, join(stage, `${own.productName}.app`), { recursive: true, verbatimSymlinks: true });
  symlinkSync("/Applications", join(stage, "Applications"));
  writeFileSync(join(stage, "Open this first.txt"), FIRST_OPEN);
  const dmg = join(OUT, `${own.productName}-${own.version}-${arch}.dmg`);
  rmSync(dmg, { force: true });
  run("hdiutil", ["create", "-volname", own.productName, "-srcfolder", stage, "-ov", "-format", "UDZO", "-fs", "HFS+", dmg]);
  rmSync(stage, { recursive: true, force: true });
  console.log(`Made ${app}\nMade ${dmg} (${Math.round(statSync(dmg).size / 1e6)} MB)`);
}

if (import.meta.main) await main();
