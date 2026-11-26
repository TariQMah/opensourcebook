# A job folder

Each video is made in a folder of its own, its job folder. It holds a note for the video agent, the video's sources, what was already read from them, the agent's own work folder and the service's own files. This page is the layout: the scenes service writes it (`services/scenes/src/folder.ts`), and later video work reads it by these names.

## Where job folders live

Open Sourcebook keeps its data in one folder of its own, the app data folder, never inside the person's library. The library is never moved or renamed by the app.

| Computer | App data folder |
| --- | --- |
| Mac | `~/Library/Application Support/Open Sourcebook/` |
| Linux | `~/.local/share/Open Sourcebook/` |
| Windows | `%APPDATA%\Open Sourcebook\` |

| Inside it | What it is | Set by |
| --- | --- | --- |
| `app/` | The programs | the desktop app |
| `state/` | The launcher's state: secrets, ports, logs, the voice chosen | `OPENSOURCEBOOK_STATE` |
| `data/` | The engine's saved projects, sources and files | the engine's `--persist-to` |
| `jobs/` | One job folder per video, and the scenes service's other files (`audio/`, its caches) | `SCENES_DATA_DIR` |

The launcher sets all three from one setting, `OPENSOURCEBOOK_APP_DATA`, the app data folder. Without it (a clone started with `npm start`) everything stays where it was: `.opensourcebook/` at the repo root, `engine/.wrangler/state` and `services/scenes/.data`.

## What a job folder holds

`<jobs>/<job id>/`, where the job id is the engine's id for the video:

| Path | What it is |
| --- | --- |
| `README.md` | A short note for the video agent: the video's title and brief, what the viewer already knows, its length, and where its files are. Made from the request when the job starts. Knowledge only, no rules. |
| `sources/sources.json` | Every source of the video, in the order sent (below). |
| `sources/<source>-<file name>` | A link (a symbolic link) to the original file, for a source that is a file on disk. Never a copy. None when the source is a page, a pasted text or a file kept only in the engine. |
| `extracted/<source>/text.md` | The source's text as the engine read it, for a video or audio source its transcript: one `## <passage id>` heading per passage, with where it is in the source after it (`## p3 · page 2`). A cite names the passage by that id. |
| `extracted/<source>/pictures.json` | The pictures the engine kept from the source (figures, slides, video frames, images), when it kept any (below). |
| `extracted/<source>/pictures/<n>.<ext>` | Each picture, numbered from 1 in the engine's order. |
| `work/` | The agent's own folder, as before: its `skills/` and whatever it writes. |
| `job.json`, `draft.json`, `video.mp4`, the builds, stills and voice | The service's own files, as before. |

The agent's own tools are boxed to `work/` (`services/agent-connector/src/box.ts`), so today it gets the sources inline and through its tools as before; opening `README.md`, `sources/` and `extracted/` to it, read only, is the next step of the video work.

`<source>` is the source's id with anything but letters, digits, `-`, `_` and `.` turned into `_`. Nothing new is read from a source for its job folder: it holds only what the engine already has.

`sources/sources.json` is a list, one entry per source:

```json
[
  {
    "id": "src_1",
    "title": "Cell biology, chapter 4",
    "kind": "pdf",
    "path": "/Users/me/Documents/chapter-4.pdf",
    "url": "https://example.org/chapter-4",
    "link": "sources/src_1-chapter-4.pdf",
    "extracted": "extracted/src_1"
  }
]
```

`path` is there only for a file on disk, `url` only for a source read from an address, and `link` only when the link was made. `kind` is the engine's (`pdf`, `web`, `youtube`, `text` and the rest), or `source` from an engine that does not send it.

`extracted/<source>/pictures.json` is a list, one entry per picture saved:

```json
[{ "file": "pictures/1.png", "kind": "figure", "caption": "Figure 2", "page": 3 }]
```

with `timestampMs`, `width` and `height` when the engine knows them. The pictures are fetched from the engine (`SCENES_ENGINE_URL`, which the launcher sets) when the job starts: at most 60 a source and 20 MB each. Without that setting there are none.

## What the engine sends

`POST /videos` carries `sources` beside `passages`: `{ id, title, kind, url?, path?, pictures?: [{ url, kind, caption?, page?, timestampMs?, width?, height?, contentType? }] }`, where a picture's `url` is the engine's own `/v1/assets/<id>`. A request without `sources` (an older engine) gets a job folder from its passages alone: every source with its title and text and no pictures.

## Kept, then cleaned up

A job folder stays after its video is done, failed or stopped, so trying again or making one scene again is fast. The scenes service cleans up when it starts and after each job ends: a job is kept while it is among the last 10 changed (`SCENES_KEEP_JOBS`) or was changed in the last 7 days (`SCENES_KEEP_DAYS`), and a job being made is never removed. Only folders with a `job.json` are jobs; nothing else in `jobs/` is touched. The engine keeps its own copy of every finished video, so a cleaned-up job only means a scene of it can no longer be made again on its own.

## The library

When a library folder is set (`SCENES_LIBRARY_DIR`), a finished video is copied there as `<title>.mp4` (` 2`, ` 3` added when that name is taken), once per job, and the copy's path is kept in `job.json` as `library`. With none set, nothing is copied.

## Opening it

On this computer, a video being made or made has "Show job files" in the app, which opens its job folder in Finder, Explorer or the file manager (`POST /v1/jobs/:id/files/show`, then the scenes service's `POST /videos/:id/show-files`). A paired phone never sees it.
