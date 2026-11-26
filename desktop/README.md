# The desktop app

Open Sourcebook in its own window, opened like any other app. It starts the four programs when it opens and stops them when it quits, and it keeps them up to date by itself. It shows the same web app the browser shows, so nothing is built twice.

macOS first. Windows (#12) and Linux (#9) are later steps; the folders below already name their places.

## What happens when it opens

1. **Programs in place.** The programs are files in the app data folder, not in the app. The first start puts in place the copy the app carries. A newer version downloaded earlier is put in place here, before anything starts. Both use the one-line install's own code (`install/package/lib/archive.mjs`), which changes only the files the last version brought, so projects and settings are never touched.
2. **ffmpeg.** When the computer has no ffmpeg or ffprobe, they are fetched once into the app data folder by the install's own code (`install/package/lib/tools.mjs`).
3. **The PATH.** An app opened from the Finder gets a bare PATH, so the person's agent would not be found. The app asks the person's login shell for its PATH once, adds `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, and puts its own Node and tools first.
4. **The programs.** It runs the launcher in the app data folder (`opensourcebook start --background --json`) with its own Node, and shows each line the launcher says on a plain starting page. The first start installs each program's packages and builds them once, which takes a few minutes. Later starts take seconds.
5. **The window.** It asks the launcher for the one-time address that lets this window in (`opensourcebook open --print`) and shows the web app. Links to other sites open in the person's own browser.

When something goes wrong the page says what, with **Try again** and **Show log**. Closing the window quits the app, and quitting stops every program (`opensourcebook stop`).

## Updates

About 20 seconds after the window shows Open Sourcebook, the app asks GitHub for the newest release of the repository named in `package.json` (`opensourcebook.releases`). When that release is newer than what is in place, it is downloaded into `updates/` and a notification says it is used at the next start. The archive is the release's own `opensourcebook-app.tar.gz` when it has one, else the source archive of its tag. A cut-off download is never put in place.

This updates the programs, not the app around them. The app itself has no self-update, since macOS allows that only for an app signed with a paid Apple certificate. A new app is a new download, and it brings its own newer copy of the programs.

## Where things are

| Folder | What is in it |
| --- | --- |
| `~/Library/Application Support/Open Sourcebook/` (Windows `%APPDATA%\Open Sourcebook`, Linux `~/.local/share/Open Sourcebook`) | Everything. `OPENSOURCEBOOK_APP_DATA` names another folder, and the launcher is told this folder in the same setting |
| `app/` | The programs (the repo's files), and the launcher runs from here. `app.manifest` lists the files the last version brought |
| `installed.json` | Which version is in `app/`, and whether it came with the app or from a release |
| `updates/` | A downloaded version waiting for the next start |
| `bin/`, `tools/` | ffmpeg and ffprobe, when the app fetched them |
| `window/` | The window's own browser data (its cookie, its cache) |
| `desktop.log` | What the app did and what the launcher said. **Show log** opens it |

Nothing is ever written inside the app itself, so it also runs from the disk image or from a read-only place.

## What the app carries

| Inside `Open Sourcebook.app/Contents/Resources/` | Why |
| --- | --- |
| `node/` | Node 24 with npm, from nodejs.org, checked against its checksum when the app is built. The launcher needs Node 24 and npm, and a person may have neither |
| `installer/` | The one-line install's library (`install/package/lib`) |
| `payload/` | The programs, as the archive of the commit the app was built from, and which version that is |

Node is carried and ffmpeg is fetched. Node has to be there before anything else can run, npm included, and carrying it means the first start never depends on nodejs.org. ffmpeg is about as big as Node again, many computers already have it, and the install already fetches it the same way. The Electron runtime has its own Node, but without npm, so it does not replace this one.

## Run it and build it

```bash
npm install                # Electron and the packager (about 400 MB with Electron's download)
npm test                   # the PATH, the app data folders, the update check, putting versions in place
npm run typecheck
npm run resources          # stages node/, installer/ and payload/ in out/resources, for npm start
npm start                  # builds the main process and opens the app from this folder
npm run package            # out/app/.../Open Sourcebook.app and out/Open Sourcebook-<version>-<arch>.dmg
```

`npm run package` builds for this Mac's chip. It makes the app with Electron's packager, signs it ad hoc (`codesign --sign -`) so an Apple Silicon Mac runs it, and makes a disk image holding the app, a link to Applications and `Open this first.txt`. The payload comes from the last commit (`git archive HEAD`), so files that are not committed are not in it.

## Opening it the first time

The app is not signed with a paid Apple Developer ID, so the first open is one extra step, written in the disk image:

1. Drag Open Sourcebook into Applications and open it. The Mac says it cannot check it: click Done.
2. System Settings, then Privacy & Security: click **Open Anyway** beside Open Sourcebook, then confirm.

After that it opens like any other app.

## Files

| File | What it does |
| --- | --- |
| `src/main.ts` | The app: the window, the start, quitting, the update check |
| `src/prepare.ts` | Putting the right version in place and ffmpeg, with the install's library |
| `src/update.ts` | Versions, which one goes in place at a start, the release check and download |
| `src/shell-path.ts` | The PATH from the login shell |
| `src/paths.ts` | The app data folder and what the app carries |
| `src/launcher.ts` | Running `opensourcebook` and reading its answers |
| `src/preload.cts`, `page/` | The starting and error page |
| `scripts/resources.ts`, `scripts/package.ts` | Staging what the app carries; the app and the disk image |
