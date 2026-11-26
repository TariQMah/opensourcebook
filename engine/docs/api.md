# Studio API

The HTTP routes a client uses to work a project: projects, sources in a
project and the Inbox, plans and their items, outputs and usage. The web
Studio and the phone's project screen are built against this file. Words
follow `docs/GLOSSARY.md`: an *item* is a `plan_nodes` row, a *format* is its
`type`, a *brief* is its `prompt`, a *stage* is a `level`.

The routes that existed before this file (`/v1/formats`, `/v1/sources`,
`/v1/uploads`, `/v1/assets`, plan progress, done ticks, answers and the
`/v1/jobs` wrapper) are listed in `engine/README.md`.

## Formats (Nov 12, 2026)

Open Sourcebook makes five shapes (`docs/DECISIONS.md` #33, and the rows that added audio and the guide): `GET /v1/formats` serves
`video`, `flashcards`, `quiz`, `audio` and `guide`, in that order, whether or not video
has a maker. The order is the registry's (`engine/src/studio/default-registry.ts`), the one
home of it; every list of the shapes (the chat's `/` commands in `GET /v1/skills`, Settings,
the Studio) follows it, and nothing sorts them elsewhere. `flashcards` and `quiz` are always `ready: true`.
`audio` (`engine/docs/audio.md`) is registered always; it is `ready: true` when the
scenes service on this computer says it can voice audio and the person's agent is
connected, else `ready: false` with `problem`.

**A format can say why it cannot be made here (Nov 18, 2026).** A registered
format may answer, from what it last heard, that nothing of it can be made on
this computer now (`unavailable` on its definition): audio with no voice set
up. It is then served `ready: false` with `problem`, one plain sentence with
what to do, in the words of what stops it (for audio, the scenes service's
own). Such a format is never in a plan; its chat command (`GET /v1/skills`,
`commands`) stays, with `about` set to the problem, and answers with it;
the planner reads the problem beside the format; a plan item in it shows the
problem as `cannot_make_now` before Start; and the web shows it on its tile.
A format with `ready: false` and no `problem` is one with no engine here.
`video` is `ready: true` only when the engine has at least one video
maker set up (DECISIONS #54, #69): the scenes maker, when the scenes
service on this computer is (`SCENES_SERVICE_URL`, `SCENES_SERVICE_TOKEN`;
local only, "Video makers" below). Otherwise it is declared with `ready: false` and no
settings, and an item of type `video` cannot be started.
The ids `read`, `bits`, `byte` and `check` are gone as formats; they are
listed as `aliases` (`flashcards`: `byte`, `bits`, `read`, `cards`; `quiz`:
`check`). The byte became flashcards on Nov 18, 2026. Rows stored under an
old id are served under the new one, a format filter finds them, and an old
id a client sends in a request is accepted and stored as the new one.
`guidedWork` is no longer a format.
Each descriptor may carry `plural` ("quizzes"), the word for more than one,
for counts such as a plan's size, and `blurb`, what it is in a few plain
words for a person meeting the word ("cards to swipe and flip,
brought back until they stick"), which clients show beside the label where the format is
first offered or planned (`about` is the longer sentence for the planner).

**Settings carry words (Nov 13, 2026).** Every setting whose values are
codes carries words for them. A `choice` setting stores one option's
`value`; a `choices` setting stores a list of them, at least `minItems` and
at most `maxItems`. Each option is `{ value, label, description }`: `label`
is the short word the form shows and `description` one plain line on what
picking it does, so clients show words and never the stored code. The
quiz's "Question kinds" setting is a `choices` field whose options come from
the question kind registry, so a new kind of question appears there by
itself. Stored settings are unchanged: they hold the same codes as before,
and an item that stored a value no longer offered (a set's old `saveOnly`
depth) still reads. A client that meets a field kind it does not know
leaves that field out. Every `label`, of a setting, an option or a special
value below, is in sentence case ("Multiple choice", "Auto"), so a client
shows it as it comes. A format that runs a coding agent may also declare a
`kind: "agent"` field (`{ key, label, help?, showWhen?, kind: "agent", effortKey?, turnKind?, role?, offValue? }`),
which clients draw with the shared `ModelPicker` (`turnKind: "work"` for
longer work, paired with `effortKey` for the provider's thinking effort).
`role` is `"make"` (who makes it; absent reads as make) or `"review"` (who
reads it fresh once made, which `offValue` turns off). Defaults per shape
are set only in Settings with `PUT /v1/providers/picks/:scope`; an item's
pick changes that item only, and `settle()` fills what an item leaves open
from the scope's default ("Makers and reviewers" below).

**Special number values (Nov 13, 2026).** A `number` setting may carry
`specialValues: [{ value, means, label, description }]`: values that do not mean
the number itself. A client shows the `label` in place of the number when
the setting holds that value, and may offer it as a pick beside the number.
`means` (Nov 23, 2026) says what the value stands for, so a client never
reads it from the words: `auto`, the brief and the sources decide the
number when it is made; `none`, there is no such limit. Every special
value carries it. Today `0` is one on each of these, with its `means`:
flashcards' `cards`, the quiz's `questions`, video's and audio's
`minutes` and the guide's `pages` (`auto`), and the quiz's `timeLimit`
(`none`), as `{ "value": 0, "means": "auto", "label": "Fit to the brief",
"description": "Counted when it is made, from the brief and the sources." }`.
The planner is told the same words. A setting's `help` says only what its
options and special values do not ("Target length in minutes."), so a
client can show help, option words and special values together without
saying anything twice.

**Settings shown only when they apply, options with pictures (Nov 15,
2026).** Any setting may carry `showWhen: { key, in }`: it is shown, and
read, only while the format's setting `key` holds one of the values in
`in` (that setting's default counts when the item sets none). The engine
refuses a descriptor whose `showWhen` names a setting it does not have or a
value that setting does not offer. A client that does not know `showWhen`
shows the field always; the value is still accepted and ignored by a maker
it does not apply to. An option of a `choice` may carry `preview`: a path on
this engine (`/v1/...`) to a picture of what picking it gives, loaded with
the client's own credentials (the web through its `/api` proxy). A client
may show a choice whose options have pictures as picture cards; an option
without one (the open pick) shows its words.

**A video's maker and style (Nov 15, 2026; DECISIONS #54).** With more
than one video maker set up, `video` has a `maker` choice: `auto` (the open pick)
and one option per maker, each with its own label and
description, which say what it is good at, how long it takes and what it
needs (the descriptions are what the planner and the person's agent read
to pick one). With one maker there is no `maker` field. When some maker
has styles, `video` has a `style` choice: `auto` (the maker
picks) and the makers' styles, each with a `preview`; it carries
`showWhen: { key: "maker", in: [...] }` naming the makers that have styles
(and `auto` when the one Open Sourcebook picks has them). Both default to `auto`. Every
option comes from the makers themselves; the engine lists none by hand.
Stored `maker` and `style` values are checked by shape only (`auto`, or
lowercase letters, digits, `-` and `_`), so an item that picked a maker or
a style that is not set up now still reads; the plan view says so before
Start (issue `cannot_make_now`, below) and the item fails with that said if
it runs, never quietly made by another maker. `auto` for the maker is
resolved once, when the item's job plans it, and kept on the job, so a
retry makes the same thing.

**Result numbers carry words (Nov 13, 2026).** A format's `reports` lists
the numbers its player puts in an item's result, each
`{ metric, label, about, unit? }`: `metric` is the key in the result and
what a branch condition names, `label` its name in sentence case for a
client to show ("Right answers"), `about` what it means (for the planner),
and `unit` how to show it: `share` is 0 to 1, shown as a percentage;
`count` a whole number shown as it is; absent, shown as it is. Today only
the quiz reports: `score` ("Score", `share`), `correct` ("Right answers",
`count`) and `answered` ("Questions answered", `count`).

**Edge kinds (Nov 13, 2026).** `GET /v1/edge-kinds` lists the kinds of link
between plan items that the plan runner reads, for a pick list:

```json
{ "edgeKinds": [
  { "id": "assumes", "label": "Builds on", "about": "May rely on what the earlier item made, without going over it again." },
  { "id": "fix_of", "label": "Fixes", "about": "Works on what was missed in the earlier item: reads what it made and the result recorded on it." }
] }
```

An edge goes from the earlier item to the later one, and the `label` is
said of the later one. They come from the runner's edge kind registry
(`engine/src/studio/edge-kinds.ts`); the kind on an edge stays open text,
and a kind not listed is read as an input (see "Editing items"). The
planner and the person's own agent are given the same list, each kind's
`id` with its `about`, so a kind registered there is one they can use.

Payloads:

- **flashcards**, schema version 3: an ordered list of cards, each one
  screen. The contract is [`flashcards.md`](flashcards.md). An output stored as
  a byte (version 2, Nov 12 to 18, 2026) or as `read` or `bits` (version 1,
  one page of blocks) is served as a set of cards at read time, marked
  `upgradedFrom: 2` or `1`.
- **quiz**, schema version 1: unchanged from the check payload
  (`engine/src/engines/quiz/schema.ts`, README "The quiz format").
- **video**, schema version 1: an ordered list of scenes (what is seen, what
  is said, text on screen, length, cites) and `render`, the file made from
  them. The contract is [`video.md`](video.md). `render.storyboard` is
  `true` only on a video the storyboard maker made before it was taken out
  (white frames with each scene's plan written on them, no sound); it still
  plays, and says so inside its own frames.

## Conventions

- **Auth.** Every route needs the `x-client-token` header (the shared client
  token; there are no users yet). Rows belong to a hash of the token. 401
  without a token, 403 for a wrong one or none configured on the Worker.
- **Ownership.** A project, plan, item, source or output that another token
  owns is answered exactly like one that does not exist: `404 not_found`.
- **Bodies** are JSON objects. A body that is not JSON is `400 invalid_json`;
  one that is not an object is `400 invalid_request`. Unknown fields are
  ignored.
- **Errors** are `{ "error": "<code>", "message": "..." }`. Plan checks add
  `"issues": string[]` and `"issueDetails": [{ code, message, short, itemId? }]`
  (see "Plan view"), settings checks add `"issues": [{ path, code, message, severity }]`.
  Anything the engine did not expect is `500 internal_error`, in the same
  shape and with the same CORS headers.
- **Optional fields** are left out of responses when they have no value; they
  are never `null`. In a PATCH body, `null` clears an optional field and a
  missing field keeps it.
- **Times** are ISO 8601 UTC strings from the engine's clock.
- **Paging.** List routes marked *paged* take `?limit=` (1 to 200, default
  50) and `?cursor=`. When more rows follow, the response has `nextCursor`;
  pass it back unchanged for the next page. Cursors are opaque. A bad
  `limit` or `cursor` is `400 invalid_request`.
- **Methods.** GET reads, POST creates or acts, PATCH edits, PUT sets a
  value at a known key, DELETE removes. CORS allows all five. A DELETE
  answers `200` with what it did, not `204`.

## Shapes

### Project

```json
{
  "id": "…", "title": "Calculus I",
  "icon": "book", "colorHex": 3355443, "category": "math",
  "settings": {},
  "createdAt": "…", "updatedAt": "…", "archivedAt": "…"
}
```

`icon`, `colorHex`, `category` and `archivedAt` are optional. `category` is
the screen word *topic*. `settings` is free JSON the clients own.

### Source (in lists)

```json
{
  "id": "…", "projectId": "…", "kind": "pdf", "title": "Week 3 notes",
  "url": "…", "uploadId": "…", "origin": "upload",
  "status": "ready", "accessLevel": "full", "errorMessage": "…",
  "detail": { "count": 24, "unit": "pages" },
  "createdAt": "…", "updatedAt": "…", "removedAt": "…"
}
```

- `title` (Nov 13, 2026) is always present and is the name a person should
  see, the same in every list, the Inbox, `GET /v1/sources/:id`, rename
  and filing answers, and wherever the engine names the source (the chat,
  the planner, briefs): the person's own name for it if they gave one
  (renamed, or sent a `title` when adding it), else the title read from it
  (for a PDF, the title written into the file unless an app filled it in,
  such as `Microsoft Word - lec07.docx`, else its first page's heading),
  else, for an upload, the name the file came with (`x-upload-filename`,
  without folders, and without its extension when the rest has a letter:
  "Memory notes" for `Memory notes.md`), else a fallback from what it is (a
  link's host and path, such as `example.com/notes/week-3`; "Pasted text";
  "PDF file" or "File" for an upload sent without a name; "Untitled
  source"). A client need not send the file name as `title`. The read title is shared by everyone who
  added the same content, so a source whose reading was reused shows it
  too. Renaming to `null` goes back to the read title.
- `errorMessage` (Nov 13, 2026) is present only while `status` is `failed`:
  why it could not be read, in plain words, as on its extraction.
- `retryable` (Nov 16, 2026) is present only while `status` is `failed`:
  whether reading it again could end differently. A link always can; an
  uploaded file whose reading finished and found nothing cannot (the same
  bytes read the same way), so clients offer to remove it rather than to
  try again.

`projectId` is absent for a source in the Inbox. `status` is its extraction's
status: `pending`, `extracting`, `ready` or `failed`. `GET /v1/sources/:id`
(README) gives the full extraction.

- `accessLevel` (Nov 13, 2026), once it has been read: `full`, `partial`,
  `metadata` or `none`. `metadata` means only a title and description could
  be read (a video link with no account for reading videos): a client
  should mark such a source, since there is little in it to read. A source
  that is `partial` or `metadata` always has at least one line in its
  extraction's `limitations` saying what was missed; a file read whole,
  however short, is `full`.
- `detail` (Nov 23, 2026), once it has been read: how long it is, from
  what reading it already found, as `{ count: number, unit: string }` for a
  list to show after its kind ("PDF · 24 pages"): a PDF's `pages`, a
  slide deck's `slides`, a workbook's `sheets`, a video link's running time
  and an audio file's length in `min` (or `s` under a minute). An audio
  file's length is read from its own header, nothing decoded (WAV, MP3,
  M4A/MP4, FLAC, Ogg; `engine/src/extract/audio-length.ts`); one whose
  header does not say has none. `unit` is singular or plural to suit
  `count`. Absent when reading counted nothing: pasted text, a web page,
  an audio file in another container, a source being read or one that
  failed. It is on every list of sources and on the source a
  rename or a filing answers. How far a reading has got is not served: a
  source being read is `pending` or `extracting`, read whole in one step,
  with no page count until it is done.
- `removedAt` is present only on a removed source that something still
  points at (see "Removing and deleting"). Lists never show one; reading it
  by id does.

- A source from which nothing could be read (a page that is not there, a
  host that does not answer, a file with no text) is `failed`, never
  `ready`; its extraction's `errorMessage` says why in plain words
  ("Nothing could be read from this source. …"). Adding the same link or
  file again tries again (Nov 13, 2026).
- An uploaded text file (`.txt`, `.md`, `.csv`, `.json`, by its type or,
  sent untyped, by its name) is read as text and is a `text` source. Its
  read title is a Markdown file's first `#` heading, else its first line or
  sentence when that is at most 80 characters, as for pasted text.
- Pasted text added without a `title` is named from its first line, or its
  first sentence, when that is at most 80 characters; otherwise it has none.

### Plan

```json
{
  "id": "…", "projectId": "…", "title": "Unit 1",
  "version": 1, "supersedesPlanId": "…",
  "status": "draft", "budgetUsd": 5, "chatId": "…",
  "createdAt": "…", "updatedAt": "…", "kickedOffAt": "…", "direct": true
}
```

`direct` (Nov 18, 2026) marks a plan of one thing made at once (below,
"Making one thing"): absent on every other plan.

`chatId` (Nov 12, 2026) is the chat whose planning skill made the plan;
absent for a plan made with `POST /v1/projects/:id/plans`.

`status` is `draft`, `approved`, `running`, `done`, `failed`, `cancelled` or
`discarded`. `cancelled` is a plan stopped after Start (it can be started
again, below); `discarded` (Nov 13, 2026) is one cancelled before Start,
which never ran and never will. Plans stored as `cancelled` with no
`kickedOffAt` are served as `discarded`.
`kickedOffAt` is set by Start and never changes after. `budgetUsd`, when
set, is the most the plan may spend: Start refuses a plan whose estimate is
over it, and each of its jobs may spend only what the plan has left.

### Plan view

What every plan read and plan edit returns:

```json
{
  "plan": { …Plan },
  "stages": [{ "level": 1, "label": "Practice", "dueOn": "2026-11-24" }],
  "items": [{ …Item }],
  "edges": [{ "from": "<itemId>", "to": "<itemId>", "kind": "fix_of" }],
  "counts": { "total": 3, "done": 1 },
  "estimateUsd": 0.42,
  "issues": ["\"Limits quiz\" reads no sources: pick at least one"],
  "issueDetails": [{ "code": "no_sources", "message": "\"Limits quiz\" reads no sources: pick at least one", "short": "Reads no sources: pick at least one", "itemId": "…" }]
}
```

- `stages` lists only stages with a label, a day (`dueOn`) or both, lowest
  level first; each has `label` and `dueOn` only when set.
- `items` are in run order: by `level`, then `ord`.
- Each item has `plannedAs` (Nov 18, 2026) when its format can say it: what
  it will be in a few of the format's own words, such as `["Drawn scenes",
  "Chalkboard", "about 8 min"]`, for a plan row to show after the format's
  label. A plan the chat writes leaves nothing open: what the planner did not
  set is settled as it would be made now (the maker, its default look, a
  length from the sources) before the plan is saved.
- An item has `notices` when its format has something to say that is not a
  reason it cannot be made: a list of quiet lines, each with what to do. Before
  it is made it is what it will be like (a video made without sound because the
  scenes service has no voice key); once made, what it is like (the video has
  no sound, and why). The line is the maker's own, from what it last said; no
  client words it.
- `counts` is over items that can still be done (enabled and not skipped),
  as in `/progress`.
- `estimateUsd` is the sum of `estCostUsd` over enabled items that have one.
- `issues` are the reasons Start would refuse the plan as it is now (the same
  checks Start runs, below). Empty means it could start, and is always empty
  for a started or discarded plan. Each names the item by its title, in
  plain words, never by id.
- `issueDetails` (Nov 13, 2026) are the same issues in the same order as
  `{ code, message, short, itemId? }`: `itemId` is the item the issue is
  about, so a client can point at it; absent for an issue about the whole
  plan (the budget, no enabled items). `message` is the full sentence (as
  in `issues`); `short` says the same without the item's title, in sentence
  case, for the item's own row. Every `422 plan_invalid` carries
  `issueDetails` beside `issues` too. `code` is stable; the kinds are
  defined in one place (`engine/src/studio/plan-issues.ts`):

  | `code` | About | Means |
  |---|---|---|
  | `no_sources` | item | Enabled but reads no source. |
  | `format_not_ready` | item | Its format can't be made yet (declared only, or unknown). |
  | `cannot_make_now` | item | Its format makes it, but not right now with its settings; `short` says why and what to do, in the format's words (Nov 15, 2026: a video whose maker is not set up here, or whose maker's service or agent on this computer is not running, from what the maker last heard). |
  | `branch_parent_missing` | item | Branches from an item not in the plan. |
  | `branch_parent_not_earlier` | item | Branches from an item that is not in an earlier stage. |
  | `condition_invalid` | item | Its condition is one no resolver reads; `short` says why. |
  | `condition_without_parent` | item | Has a condition but no earlier item to test it on. |
  | `edge_source_missing` | item | Uses (by an edge) an item not in the plan. |
  | `edge_source_not_earlier` | item | Uses (by an edge) an item that is not in an earlier stage. |
  | `item_status` | item | Not in the state the action needs (retrying an item that has not failed). |
  | `over_budget` | plan | The estimate is over the plan's budget. |
  | `no_enabled_items` | plan | No item would run. |
  | `plan_status` | plan | The plan is not in the state the action needs. |

  A client that meets a code it does not know shows `message` (or `short`
  on the item's row).

### Item

```json
{
  "id": "…", "parentId": "…",
  "level": 1, "ord": 0,
  "type": "quiz", "title": "Limits quiz",
  "prompt": "Diagnostic over sections 2.1–2.3; assume the earlier flashcards.",
  "settings": { "questions": 10 },
  "condition": { "kind": "metric", "metric": "score", "below": 0.7 },
  "enabled": true,
  "estCostUsd": 0.12,
  "status": "pending",
  "errorMessage": "…",
  "sources": [{ "sourceId": "…", "range": { "page": 3, "endPage": 9 } }],
  "outputId": "…",
  "done": false, "doneAt": "…",
  "result": { "score": 0.8 },
  "asking": { "question": "More practice?" }
}
```

- `type` is the format's current id; an item stored under an old id
  (`read`, `bits`, `byte`, `check`) shows the new one (`flashcards`, `quiz`), and a stored
  id no format declares is kept and returned as is.
- `parentId` and `condition` together make a branch. `condition` is a tagged
  object decided by a registered resolver (`metric`, `ask`, …; README "Plans").
- `status` is `pending`, `queued`, `running`, `done`, `failed`, `skipped` or
  `cancelled`.
- `errorMessage` (Nov 13, 2026) is present only on a `failed` item: why it
  could not be made, in one short plain line about the item ("The sources
  of this quiz have no text that could be read, so there was nothing to
  make it from. Pick a source with text, then try again."), the same words
  as `job.errorMessage` in `/progress`, or "This item could not be made."
  when it has no job. The line comes from the cause the failing step named
  (`engine/src/jobs/failure-words.ts`, the one place these lines live); a
  cause without one reads "Something went wrong while making this quiz.
  Try again." The technical text is never in `errorMessage`: it is in the
  log and in `job.errorDetail` in `/progress`. So a plan read is enough to
  show the reason and offer Retry.
- A job that **waits** (Nov 18, 2026) has `job.status` `waiting` while the
  item stays `running`: its maker went quiet (the engine, the connector or
  the scenes service restarted, the computer slept, a turn was dropped) or
  the person's agent reached its plan's limit. What was made is kept and
  the engine carries it on by itself (`engine/src/jobs/keeper.ts`,
  `waits.ts`). `job.step` is then "Carrying on after a restart…" or
  "Waiting for your agent's plan…", and `job.waiting` is `{ reason:
  "restart" | "agent_limit", words, since, nextTryAt, tries, resetsAt?,
  resets? }`: `words` is the sentence to show, with what is kept;
  `resetsAt` (ISO) and `resets` (the agent's own words) are there only
  when the agent said when its limit resets, never estimated. After a
  restart a job is carried on at most 4 times (waits of 3 s, 20 s, 1 min,
  3 min); a limit is checked with one cheap check for every waiting item
  (the connector's status, else its smallest turn; growing waits from 2
  to 30 minutes, or the reset time the agent gave) for at least a day, then
  the item fails with words saying it waited and that trying again carries
  on from what was made. `POST .../items/:itemId/retry` on a waiting item
  tries it now; Stop (plan cancel) works in every state.
- A job that **waits for the voice** (Nov 19, 2026) has `job.waiting.reason`
  `"voice"`: the voice could not speak (its account out of credits, its key
  refused, its service not answering), and `words` say why, that what was
  made is kept, and what to do. The engine checks the voice for free (the
  scenes service's `GET /voice`) with growing waits from 2 to 30 minutes,
  carries it on once it can speak, and gives up after a day, still keeping
  what was made. A wait may offer a way on that does not need what it
  waits for: `job.choice` is `{ id, label }` (for a video, `without_sound`,
  "Finish without sound"), on a waiting job and on one that failed after
  waiting. `POST .../items/:itemId/retry` with `{ "choice": id }` takes it:
  the job's maker reads it (`ctx.services.chosen`) and the item is carried
  on that way at once. A choice the job does not offer is refused (`409`).
- `range` is a `SourceLocator` (`page`, `endPage`, `slide`, `endSlide`,
  `startMs`, `endMs`, `charStart`, `charEnd`, `cell`; all optional).
- `outputId` is the output the person's done tick names when it names one,
  else the newest output made for the item. `done`, `doneAt`,
  `result` and `asking` are as in `/progress`.
- `progress` (Nov 18, 2026), when the person has stopped partway: where,
  in the format's own shape (the web's players keep `{ card, cards }` for flashcards (each card's box and due time),
  `{ at, responses, ended }` for a quiz, `{ time }` for a video). Written
  by `POST /v1/plans/:id/items/:itemId/progress` (README), kept apart from
  `result`: no branch reads it, and a tick or a result leaves it alone.

### Output (in lists)

```json
{
  "id": "…", "type": "flashcards", "title": "…", "summary": "…",
  "projectId": "…", "planId": "…", "itemId": "…",
  "category": "…", "schemaVersion": 3, "costUsd": 0.03,
  "size": { "count": 12, "unit": "cards" }, "done": false,
  "createdAt": "…", "updatedAt": "…"
}
```

`projectId` is absent for something made on its own (quick mode); `planId`
and `itemId` are absent when it was not made from a plan item. `size` and
`done` are under "Outputs" below.

### Output (full)

The list shape plus what was stored when it was made, and `archivedAt` when
it is archived:

```json
{
  …Output,
  "payload": { … },
  "citations": [{ … }],
  "prompt": "…",
  "settings": { … },
  "sources": [{ "sourceId": "…", "range": { … } }]
}
```

`payload` is the format's own shape at `schemaVersion` (a set of flashcards is
[`flashcards.md`](flashcards.md)). `type` and `schemaVersion` are what is
served, not what is stored: an old `read`, `bits` or `byte` row comes back as
`flashcards` at version 3. `citations` lists each card's cites, `anchor`ed at
the card (`cards[3]`) or the block (`cards[3].front[1]`, `cards[3].back[0]`)
they ground, plus a bare `{ sourceId }` for each source no card cites. `prompt`, `settings` and
`sources` are copies taken at generation time, so they stay true after the
item is edited.

### Usage totals

```json
{ "calls": 4, "failedCalls": 0, "unpricedCalls": 0, "timedOutCalls": 0, "tokensIn": 400, "tokensOut": 200, "usd": 0.01 }
```

`usd` is in dollars. `unpricedCalls` counts successful calls to a model with
no known price: they add nothing to `usd`, so when it is above 0 `usd`
understates the spend and a client should say so. `timedOutCalls` counts
calls the engine stopped waiting for (60 s by default). The provider may
still have produced and billed an answer nobody read, and the engine cannot
know its tokens, so these calls add nothing to `usd`: when `timedOutCalls` is
above 0, `usd` may be undercounted and a client should say so. Each usage row
keeps why a failed call failed (`error`: `timeout`, `http`, `network` or
`output`; migration 0008).

## Projects

| Route | Request | Response | Errors |
|---|---|---|---|
| `POST /v1/projects` | `{ title, icon?, colorHex?, category?, settings? }` | `201 { project }` | `400 invalid_request` |
| `GET /v1/projects` | *paged*; `?archived=include\|only` (default: not archived) | `200 { projects, nextCursor? }` most recently updated first | |
| `GET /v1/projects/:id` | `?counts=1` adds `counts` | `200 { project, counts? }` | `404` |
| `PATCH /v1/projects/:id` | `{ title?, icon?, colorHex?, category?, settings? }` | `200 { project }` | `400 invalid_request`, `404` |
| `POST /v1/projects/:id/archive` | none | `200 { project }` | `404` |
| `POST /v1/projects/:id/unarchive` | none | `200 { project }` | `404` |
| `DELETE /v1/projects/:id` | | `200 { projectId, deleted: { chats, plans, outputs, sources } }` | `404`, `409 project_busy` |

- `title` is 1 to 200 characters after trimming. `icon` and `category` are
  text up to 100 characters; `colorHex` an integer 0 to 0xFFFFFF; `settings`
  an object up to 16,000 characters of JSON. Renaming is a PATCH of `title`.
- Archiving hides a project from the default list and keeps everything in it.
  Archive and unarchive are idempotent. An archived project takes no new plans
  and no new sources (`409 project_archived`); its plans can still be read,
  edited, started and ticked. The archived list is
  `GET /v1/projects?archived=only`; restoring is `unarchive`.
- Deleting is for good and takes everything in the project with it; see
  "Removing and deleting". `deleted` counts what went.
- **What a project holds** (Nov 13, 2026): `GET /v1/projects/:id?counts=1`
  adds `counts: { chats, plans, outputs, sources }`, counted exactly as
  `DELETE` counts `deleted`: every chat and plan, every output made in it
  (archived ones too), and its sources not removed. Without `?counts=1`
  there is no `counts`.
- **A project as one file** (Nov 17, 2026; `src/studio/bundle.ts`):
  `GET /v1/projects/:id/export` answers `200 { bundle }`, and
  `POST /v1/projects/import` takes `{ bundle, example? }` and answers
  `201 { project, droppedCites, droppedOutputs }` (`400 invalid_bundle`).
  A bundle is `{ opensourcebook: "project", version: 1, project: { title }, sources,
  chats, plans? }` (a file exported before the rename says `re: "project"`
  instead, and is read the same): each source as the text read from it, each chat with its
  finished messages (a reply still being written is left out), each plan
  with its items and what they made. Rows are named by keys inside the
  bundle (`s1`, `c1`, `p1`), never by ids. On import every cite is looked
  up again word for word in the text the bundle brings; one whose words are
  not there is dropped and counted. A made thing pointing at a stored file
  (`/v1/assets/…`, such as a video's file) is not carried yet: its item comes
  back waiting to be made. A plan started when it was kept comes back
  stopped, not running. `example` is the name of the `examples/` folder the
  bundle came from; it is kept in the new project's `settings.example`.

## Sources in a project and the Inbox

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /v1/projects/:id/sources` | *paged* | `200 { sources, nextCursor? }` oldest first | `404` |
| `GET /v1/inbox` | *paged* | `200 { sources, nextCursor? }` newest first | |
| `POST /v1/sources/:id/file` | `{ projectId: string \| null }` | `200 { source }` | `400 invalid_request`, `404`, `404 project_not_found`, `409 project_archived` |
| `GET /v1/sources/:id/file` (Nov 23, 2026) | | `200` the uploaded file's bytes | `404` |
| `PATCH /v1/sources/:id` | `{ title: string \| null }` | `200 { source }` | `400 invalid_request`, `404` |
| `DELETE /v1/sources/:id` | | `200 { sourceId, deleted, changedPlanIds }` | `404` |
| `POST /v1/sources/:id/retry` | none | `200 { source, extraction, chunkCount }` (as `GET /v1/sources/:id`) | `404`, `409 source_not_failed`, `409 source_busy` |

- Adding a source is the existing `POST /v1/sources` (README); with a
  `projectId` it goes into that project, without one into the Inbox.
- Filing moves a source into a project, or back to the Inbox with `null`. It
  is idempotent. Items and outputs that use the source keep pointing at it.
- A source keeps up to 400,000 characters of text, whether read from a link
  or upload or pasted (pasted text above that is refused with
  `400 source_too_large`). What is made from it reads the whole of it or
  exactly an item's range (`engine/docs/long-sources.md`). A longer link or
  upload is cut at a paragraph or sentence end, and its extraction says so:
  `limitations` has a plain-words line with how much is used, and `metadata`
  has `textChars` (its full length, or as much as was read, up to
  1,000,000), `textUsedChars` and `textCut: "true"`. A client should show
  that line next to the source. Sources stored before Nov 13, 2026 were cut
  at 24,000 characters and stay so, with the same line.
- A PDF's chunks carry `page` as well as their character range.
- **Renaming** (Nov 13, 2026): `title` is 1 to 200 characters after
  trimming; `null` clears it. `source` is the list shape.
- **Removing** (Nov 13, 2026) takes the source out of its project or the
  Inbox. `deleted` is `true` when it is gone for good, `false` when it is
  kept hidden because something still points at it; `changedPlanIds` are
  plans not started yet whose items no longer read it. Removing it again
  checks again. What happens to everything that used it is in "Removing and
  deleting".
- **Trying again** (Nov 13, 2026) reads a source whose reading failed (or
  never ran) once more, in the request, and answers like
  `GET /v1/sources/:id`: `extraction.status` is `ready` when it worked and
  `failed`, with `errorMessage`, when it failed again. A source that was
  read is `409 source_not_failed`; one being read right now is
  `409 source_busy`. The reading is shared by everyone who added the same
  content, so it is read again for all of them.
- A removed source takes no rename, retry or filing (`404`).
- **A source's own file** (Nov 23, 2026): `GET /v1/sources/:id/file` sends
  the file a source was uploaded as, its stored bytes with the type it was
  stored as, to the person who holds the source (a removed one too, while
  its file is kept). It is checked like every other route (the client
  token, and the source's owner) and sent with the asset safety headers
  (`x-content-type-options: nosniff`, and a sandboxing
  `content-security-policy`, which a PDF goes without so the browser's own
  viewer can draw it), with `cache-control: private, no-store`.
  `content-disposition` is `inline` for a picture, sound, video or PDF and
  `attachment` for anything else, with the file's own name as an ASCII
  `filename` (anything that could end the header replaced by `_`) and in
  full as `filename*` (UTF-8). A source from a link or pasted text, one of
  someone else's, an unknown one, or one whose file is no longer kept is
  `404`.
- **What could not be read** (Nov 13, 2026). `limitations` on a source's
  extraction is a list of plain sentences for the person, shown under "What
  could not be read": what is missing, what was left out, or that only a
  title and description could be read ("Only this video's title and channel
  name could be read, not what is said in it."). The lines use the words
  source, page, video and file; they never name a service or a model, and
  never describe how the reading was done. An empty list means nothing was
  missed. The technical lines behind them are stored beside them as
  `extractionNotes`, for logs only; the API does not serve them. Sources
  read before this date stored technical lines in `limitations`: when they
  are read back, each known old line is shown as its plain line and lines
  that only described the reading are left out. A line the engine does not
  recognise is shown as it is.
- **Page furniture** (Nov 13, 2026). Reading a web page leaves out what is
  not the article: navigation, tables of contents, reference and footnote
  lists and their marks (`[1]`), edit links, and back matter at the end
  ("See also", "References", "External links", "Further reading", …). It
  goes by roles and structure first, so it works on any site that marks
  them; sources read before stay as they were read.

## Plans

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /v1/projects/:id/plans` | | `200 { plans: [{ …Plan, counts }] }` oldest first | `404` |
| `POST /v1/projects/:id/plans` | `{ title?, budgetUsd? }` | `201` plan view of a new `draft` | `400 invalid_request`, `404`, `409 project_archived` |
| `GET /v1/plans/:id` | | `200` plan view | `404` |
| `PATCH /v1/plans/:id` | `{ title?, budgetUsd? }`, `null` clears either | `200` plan view | `400 invalid_request`, `404` |
| `DELETE /v1/plans/:id` (Nov 23, 2026) | | `200 { planId, deleted: { items, outputs, jobs, files } }` | `404`, `409 plan_running` |
| `PUT /v1/plans/:id/stages/:level` | `{ label?: string \| null, dueOn?: string \| null }`, at least one | `200` plan view | `400 invalid_request`, `404` |
| `POST /v1/plans/:id/catch-up` | `{ today }` | `200` plan view | `400 invalid_request`, `404` |
| `GET /v1/due` | `?today=YYYY-MM-DD[&ahead=7]` | `200 { today, stages }` | `400 invalid_request` |

- The title, the budget and stage labels and days can change in any status
  and never send an approved plan back to draft (Start checks the budget
  again). `budgetUsd` is a number ≥ 0. A blank or `null` label
  clears it. `:level` is a non-negative integer. A label is at most 200
  characters, a title the same.

### Days and what is due (Nov 20, 2026)

A stage may carry `dueOn`, a day on the person's calendar written
`YYYY-MM-DD` with no time or zone, set only when the person gives one (by
hand, or the planner from their words). It changes nothing about what is
made or in what order. The engine never reads its own clock for days:
`today` always comes from the person's app, and a message may carry
`today` too so the agent can turn "by Friday" into a day.

- `GET /v1/due` lists, across the person's plans, the dated stages with
  something left (an item in the plan, not skipped, not ticked done) whose
  day is before `today` (`when: "missed"`), on it (`"today"`) or within
  `ahead` days after it (`"soon"`, 0 to 60, default 7), earliest first. Each
  is `{ planId, planTitle?, projectId, projectTitle?, level, number, label?,
  dueOn, when, left, total, started }`; `number` is its place among the
  plan's stages and `started` is false while the plan waits for Start. Plans
  discarded or cancelled, made for one thing at once, superseded, or in an
  archived project are left out.
- `POST /v1/plans/:id/catch-up` moves missed days on: the first stage with
  something left whose day is before `today` moves to today, and every later
  dated stage with something left moves by as many days, so the gaps stay. A
  stage already gone through keeps its day. With nothing missed it changes
  nothing.

### Editing items

Allowed while the plan is `draft` or `approved`. Once a plan has started
(`kickedOffAt` set) its items, edges and order are fixed: `409 plan_locked`.
A plan cancelled before Start takes no edits either: `409 plan_finished`.
Any edit below sends an `approved` plan back to `draft`, so an approval always
covers exactly what runs.

| Route | Request | Response | Errors |
|---|---|---|---|
| `POST /v1/plans/:id/items` | `{ type, title, level, ord?, prompt?, settings?, sources?, parentId?, condition?, enabled?, estCostUsd? }` | `201` plan view | see below |
| `PATCH /v1/plans/:id/items/:itemId` | any of `{ type, title, level, ord, prompt, settings, sources, parentId, condition, enabled, estCostUsd }` | `200` plan view | see below |
| `DELETE /v1/plans/:id/items/:itemId` | | `200` plan view | `404`, `409 plan_locked` |
| `POST /v1/plans/:id/reorder` | `{ items: [{ id, level, ord }] }` | `200` plan view | see below |
| `POST /v1/plans/:id/edges` | `{ from, to, kind }` | `200` plan view | see below |
| `DELETE /v1/plans/:id/edges?from=&to=&kind=` | | `200` plan view | `404`, `409 plan_locked` |

Fields:
- `type`: a format id the registry declares (by id or alias), stored as sent.
  A format that is declared but has no engine yet is allowed in a draft; it
  shows in `issues` and blocks Start while the item is enabled.
- `title`: 1 to 200 characters. `prompt` (the brief): up to 20,000.
- `level`: integer ≥ 0. `ord`: integer; on add it defaults to one past the
  highest `ord` on that level.
- `settings`: an object. When the format has an engine its `parseSettings`
  must accept it, else `400 invalid_settings` with the format's issues.
  `{}` means the format's defaults. Stored as sent.
- `sources`: `[{ sourceId, range? }]`, replacing the item's whole list. Each
  source must be in the plan's project (`400 source_not_in_project`).
- `parentId` + `condition`: a branch. `null` in a PATCH clears either.
- `enabled`: false keeps the item in the plan unchecked; it never runs.
- `estCostUsd`: a number ≥ 0, or `null` to clear. Without one, the engine
  prices the item itself: its format's `estimateCost` for its settings and
  the text of its sources (within their ranges), when the item is added and
  again whenever its format, settings or sources change. A cost the client
  sends is kept until the next such change. An item whose format's model has
  no price, or whose source has not been read yet, has no `estCostUsd`
  (never $0); the plan view prices it once its sources are read, and approve
  writes that estimate to the item so the budget check has it.
- `reorder` sets `level` and `ord` of the listed items in one step; items not
  listed keep theirs. Every id must be an item of this plan.
- Edge `kind` is open text in lower snake or camel case (`assumes`,
  `fix_of`, …; README "Plans"). The kinds the runner knows, in words, are
  `GET /v1/edge-kinds` (see "Formats"); `assumes` lets the later item rely
  on the earlier one's output, and any other kind hands it the earlier
  item's output and recorded result as an input. `from` and `to` must be
  items of this plan and differ. Adding an edge that exists is a no-op.
- Deleting an item also deletes its branches (items whose `parentId` is it),
  its edges and its source links.

Every edit is checked against the plan's structure as it would be after the
edit, with the same structural checks Start runs: a parent or edge source on
a lower level than the item, a parent present, a condition that a resolver
reads and that has a parent. An edit that would add a problem is refused with
`422 plan_invalid` and `issues`, and nothing is written. Problems that were
already there do not block unrelated edits.

Other errors: `400 invalid_request` (a field of the wrong type or range),
`400 unknown_format`, `400 invalid_settings`, `400 source_not_in_project`,
`404` (plan, item, or for `DELETE` an edge that is not there),
`409 plan_locked`, `409 plan_finished`. A parent that is not an item of
this plan is a structural problem, `422 plan_invalid`.

### Approve, Start, cancel

| Route | Request | Response | Errors |
|---|---|---|---|
| `POST /v1/plans/:id/approve` | none | `200` plan view, `approved` | `404`, `409 plan_locked`, `409 plan_finished`, `422 plan_invalid` |
| `POST /v1/plans/:id/start` | none | `200` plan view, `running` (or already `done` if nothing could run) | `404`, `409 plan_not_approved`, `409 plan_finished`, `422 plan_invalid`, `503 plans_unavailable` |
| `POST /v1/plans/:id/cancel` | none | `200` plan view, `cancelled` | `404`, `409 plan_finished`, `503 plans_unavailable` |
| `POST /v1/plans/:id/items/:itemId/stop` (Nov 23, 2026) | none | `200` plan view, `running` (or `cancelled` when nothing else is left to make) | `404`, `409 item_not_running`, `503 plans_unavailable` |
| `POST /v1/plans/:id/items/:itemId/retry` | none, or `{ choice }` (a way on its job offers: `job.choice.id`) | `200` plan view, `running` | `404`, `409 plan_not_running`, `409 item_not_failed`, `503 plans_unavailable` |
| `POST /v1/plans/:id/resume` | none | `200` plan view, `running` | `404`, `409 plan_not_stopped`, `422 plan_invalid`, `503 plans_unavailable` |
| `POST /v1/plans/:id/maker` (Nov 22, 2026) | `{ agent: string \| null, effort?, reviewer?, reviewEffort?, items? }` | `200` plan view with `changed` and `unchanged` | `400 invalid_request`, `404`, `409 plan_running`, `409 plan_finished`, `422 invalid_settings`, `503 plans_unavailable` |

- **Approve** runs every check Start runs (structure, conditions, an engine
  for every enabled item's format, every enabled item reading at least one
  source, and the estimate against `budgetUsd`) and refuses with their
  `issues`. An item that reads no source shows in the plan view's `issues`
  as `"<title>" reads no sources: pick at least one`.
  A plan with no enabled items is refused too. Approving an approved plan is
  a no-op.
- **Start** hands an approved plan to the plan runner, which runs the same
  checks again, sets `running` and `kickedOffAt`, skips unchecked items and
  queues the first stage. Starting a running plan is a no-op that returns it;
  a plan already `done`, `failed` or `cancelled` is `409 plan_finished`.
  A refusal is `422 plan_invalid` with the runner's issues.
- **Retry** (Nov 13, 2026) makes a failed item of a `running` or `failed`
  plan again: its job is queued once more whatever the failure was (the
  person may have fixed its cause, such as the model account), a `failed`
  plan goes back to `running`, and later items that were skipped are
  decided again (those that waited on it now run). The item's brief,
  settings and sources are the ones it started with: a started plan's items
  stay fixed.
- **Stop one item** (Nov 23, 2026) stops one item of a `running` plan while
  the rest goes on. Its job, `queued`, `running` or `waiting`, is cancelled
  as Cancel cancels a plan's jobs, so its maker stops and the steps it had
  saved are kept; the item's `status` is `cancelled`. An output that
  finished a moment before keeps the item `done`. Items on later stages go
  on as usual; an item that depends on the stopped one (its parent, or the
  source of one of its edges) is `skipped`, as it would be for a failed
  item. When everything else has settled the plan is `cancelled` (stopped),
  not `failed`, unless another item failed. An item that is not being made
  (`pending`, `done`, `failed`, `skipped`, `cancelled`, or a plan that is
  not `running`) is `409 item_not_running`; an unknown plan or item is
  `404`. The answer is the plan view.
- **Retry** also carries on a stopped item (`status: "cancelled"`), in a
  `running`, `failed` or `cancelled` plan: its job is queued again keeping
  its saved steps, the plan goes back to `running`, and later items that
  were skipped for want of it are decided again. Resume on a stopped plan
  carries on every stopped item at once.
- Status moves are compare-and-set, so two requests at once cannot both act
  on the same old status: an edit that lands while Start runs either makes
  Start answer `409 plan_not_approved` (approve again) or is itself refused
  `409 plan_locked`; an approve that loses to a cancel is `409 plan_finished`;
  a cancel is never undone by a job settling at the same moment.
- **Cancel** stops a draft, approved or running plan and cancels its queued
  and running jobs; an output that finished a moment before keeps its item
  `done`. A running plan becomes `cancelled` (stopped); a draft or approved
  one becomes `discarded`. A plan already `done`, `failed`, `cancelled` or
  `discarded` is `409 plan_finished`. A discarded plan takes no edits,
  approve or Start (`409 plan_finished`).
- **Resume** (Nov 13, 2026) starts a stopped (`cancelled`) plan again from
  what is not made yet: items that were cancelled, and later ones skipped
  for want of them, are decided again in plan order, and an item's job that
  was cancelled is queued once more, keeping the steps it had finished.
  Made items stay as they are; failed ones stay failed (retry them). The
  items are the ones it started with. Resuming a running plan is a no-op
  that returns it. Any other status, including `discarded`, is
  `409 plan_not_stopped`. An item whose format can no longer be made is
  `422 plan_invalid` with its issues.
- **Maker** (Nov 22, 2026) changes who makes the items not made yet: before
  Start ("Change for all") or while the plan is stopped or failed ("Change
  maker for what's left"). It is the one change a started plan's items take
  ("Makers and reviewers", below).

### Only real makers (Nov 18, 2026)

Start makes an item only with a real maker: the person's own agent through
the connector, or Open Sourcebook's own writer on a model API key (flashcards and quizzes),
or a video maker. There is no mock mode and no offline stand-in any more
(they were `RE_ENGINE_MODE=mock` and `GENERATION_PROVIDER=offline`, Nov 13
to Nov 18, 2026; DECISIONS #69 takes out #50 and #51). With nothing that can
make an item now, the plan says so before Start in the item's issues (what
is missing and what to do), and a job run anyway fails with that said.
Outputs a stand-in made earlier open as they are; a job it planned (its
`state.mode` was `mock`) is planned again by a real maker when retried.

Progress, done ticks and "ask me" answers on a running plan are the existing
`/v1/plans/:id/progress`, `/items/:itemId/done` and `/items/:itemId/answer`
routes (README).

### Making one thing (Nov 18, 2026; the make sheet Nov 22, 2026)

One thing asked for on its own is made from its make sheet; a path through
the material is a plan, shown as its card and started by the person. A
thing made is a plan of one item with `direct: true` that approves and
starts itself when it is saved, so its job, steps, progress, done tick, the
feed, the Library and `opensourcebook` treat it as any plan. When nothing can make it on
this computer now (no maker ready), nothing is saved and the reason is said.
A remake (a follow-up such as "make it shorter") is a new direct plan from
the old item with the change, its `supersedesPlanId` the old one and its
`version` one more; the old one stays. It is stopped with
`POST /v1/plans/:id/cancel` like any plan.

**Asked in the chat, the sheet opens; nothing is made yet.** A request
typed in the chat (a `/quiz` command or plain words, to the person's agent
or to Open Sourcebook's own model) saves nothing: the reply carries a `make` piece, the
thing settled and checked as `/make/settle` would, for the web to open as
the make sheet filled in.

```ts
interface MakePiece {
  kind: "make";
  format: string;
  title: string;
  about: string;          // the brief, what the sheet's "What it covers" shows
  sources: string[];      // source ids
  settings: JsonObject;   // settled as /make/settle settles them
  plannedAs: string;
  notices: string[];
  issues: string[];       // what would stop it now; the sheet keeps Make off while there are any
  remakes?: { planId: string; itemId: string };   // a follow-up about something made
  state: "open" | "made" | "closed";
  planId?: string;        // once made from this piece
}
```

The thing is made only when the sheet's button calls `POST
/v1/projects/:id/make` with `proposal: { messageId, piece }` (the reply and
the piece's index in it): the piece is then marked `made` with its
`planId`, so reloading the chat never opens it again. Sending the piece's
`about` unchanged keeps its brief and title as written; changed, it is the
person's own words, as from the Studio. A remake sends the piece's
`remakes` too. `POST /v1/chats/:id/messages/:messageId/pieces/:piece/close`
is the sheet's Cancel: `200 { message }` with the piece `closed` (again is a
no-op), `404` when there is no make piece there, `409 proposal_used` once
something was made from it. A message sent from a terminal (`from:
"terminal"`, the `opensourcebook` command) still makes at once, since there is no sheet
there.

Ways in:

- **The chat's commands.** `GET /v1/skills` answers `{ skills, commands }`:
  `commands` is every command the chat takes now, `{ command, title, group,
  about, skill, format?, label, action?, chatOnly? }`. `title` is the one
  name on screen everywhere (the `/` list, the Tools list, the Studio, the
  docs); `group` is what it does: `make` (opens one thing's make sheet),
  `plan` (opens a plan to look over before Start) or `chat` (makes nothing).
  Commands come in the group order make, plan, chat, and in registry order
  inside a group: one per format that can be made, by the format's id,
  titled by its `label`, with its `blurb` (else its `about`, else what stops
  it now) from the descriptor; then the skills' own: Plan a whole subject
  (`/plan`), Explain it back (`/teachback`), Map the ideas (`/mindmap`). A
  format registered later is a command with no other change. No two
  commands share a word or a title. `label`, `action` and `chatOnly`
  (`group: "chat"`) are kept for one release for older clients (the phone)
  and will be removed; use `title` and `group`.
- **A plain request** for one thing in the chat: the agent decides from what
  was asked (the planner's skill, "One thing, or a plan"), and the sheet
  opens as for a command.
- **The make sheet, and the Studio**: `POST /v1/projects/:id/make` `{ format,
  about?, sources?, settings?, chatId?, remakes?: { planId, itemId },
  proposal?: { messageId, piece } }` makes it and answers `200 PlanView`,
  `409 cannot_make_now { message, issues }` when nothing can make it now,
  `422 invalid_item { issues }`, `400 invalid_proposal` (no make piece there
  in this project), `409 proposal_used` (that sheet was made from or
  closed), or `400 invalid_request` (`remakes` is not a thing of this
  project). Without `chatId`, a thing made from a sheet belongs to the
  sheet's chat. `POST /v1/projects/:id/make/settle` with the
  same body saves nothing and answers `{ settings, plannedAs, issues, notices }`: the
  settings filled as a plan fills what is left open, what it will be in the
  format's own words, what would stop it, and what to know before making it
  (`notices`, as on a plan item). An agent pick in `settings` (a format's
  `kind: "agent"` field and its effort) makes that one thing with it and is
  never saved as the default; defaults are set only with
  `PUT /v1/providers/picks/:scope`.

A message may carry `opened` (an item id): the thing open in front of the
person as they wrote, which a follow-up about "it" means. The agent's turn
lists the things made at once in its chat, newest first, with which is open.
A reply piece for a thing made (from a terminal, or `stop_making`) is a plan
piece with `made: "made"` or `"remade"`; the web draws it as the thing's own row (its live step, Stop, then Play), not a
card.

## Removing and deleting (Nov 13, 2026)

Nothing that was made, cited or started breaks when something it used goes.
DECISIONS #52.

**A source.** Removing it unticks it in every chat of its project and takes
it out of the items of plans not started yet (an approved one goes back to
draft, and an item left reading nothing shows the usual issue). Then:

- If nothing else points at it, it is deleted for good: the source, and its
  reading (text and passages) and uploaded file when no other source,
  anyone's, was made from the same content.
- If something still points at it (an item of a started plan, something made
  from it or citing it, a cite or @-mention in a chat message), it is kept
  hidden, with `removedAt`: lists, chats, ticks, mentions and new plan items
  leave it out, but `GET /v1/sources/:id` still reads it, so a cite in an
  old reply or in something made still opens the exact spot, and a started
  plan's item still reads it. A client says it was removed. Being ticked in
  a message does not count as pointing at it.
- It is deleted for good once nothing points at it any more (the chat or
  project that cited it was deleted). Adding the same content to the same
  place again brings it back, with what pointed at it.
- Pictures kept while reading it are shared by content and stay.

**A chat.** Its messages go. Plans it made that were never started go too;
started ones stay, with everything they made, and no `chatId`. Usage rows
stay as the record of spend.

**A plan** (Nov 23, 2026; a thing made at once is a plan of one item, so
this is how one goes too). `DELETE /v1/plans/:id` deletes it for good, in
any status but running: its items with their sources, edges, results, done
ticks and kept progress, its stages and days, everything its items made
(archived too; they leave the Library and the project's counts), its jobs
with the steps their makers saved, and the files those made things kept
(`/v1/assets/…`), each once nothing left points at it, by the project rule
below. A removed source only it pointed at goes for good. Nothing else is
touched: another plan, even one showing the same file, keeps everything; a
plan remade from it keeps going and no longer names it in
`supersedesPlanId`; chat messages that showed it stay and show nothing for
it. Usage rows and making times stay as the record of spend. `deleted`
counts what went: `items`, `outputs`, `jobs`, and `files` actually deleted.
A plan still being made (running, or with a job of it queued or running,
such as a scene being made again) is `409 plan_running`: stop it first. A
job of it the queue delivers after it went makes nothing.

```json
{ "planId": "…", "deleted": { "items": 1, "outputs": 1, "jobs": 1, "files": 1 } }
```

**A project.** Everything in it goes for good: its chats and messages, its
plans with their items, results and done ticks, everything made in it
(outputs leave the Library), and its sources with their readings and
uploaded files, by the source rule above (a source of it that a plan
elsewhere still reads is kept hidden). The files its made things kept
(`/v1/assets/…`: a video's file, an audio's, their pictures) go too
(Nov 23, 2026), each once nothing left points at it: files are kept by
their content, so one that another project's made thing, a source's
reading, a chat message or a job not finished yet still shows stays.
Nothing of another project is touched. Usage and job rows stay as the
record of spend. A project with a running plan or a reply being written is
`409 project_busy`: stop the plan first.

## Outputs

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /v1/outputs` | *paged*; `?project=none` for things made outside a project; `?type=`; `?q=` | `200 { outputs, nextCursor? }` newest first | `400 invalid_request` |
| `GET /v1/projects/:id/outputs` | *paged*; `?type=`; `?q=` | `200 { outputs, nextCursor? }` newest first | `404` |
| `GET /v1/plans/:id/outputs` | | `200 { outputs }` in item run order, newest first within an item | `404` |
| `GET /v1/outputs/:id` | | `200 { output }` (full) | `404` |
| `PUT /v1/outputs/:id/payload` | the whole thing as the person changed it, in its format's shape | `200 { output }` (full) as kept | `400 invalid_edit`, `409 not_editable`, `404` |

- Lists leave out archived outputs and the payload; `GET /v1/outputs/:id`
  returns everything, archived or not.
- `GET /v1/outputs` without `project` is the Library: everything this token
  made. `?type=` filters by format: `?type=flashcards` also finds rows stored as
  `byte`, `read` or `bits`, and an old id finds the same rows as its new one.
- An item that was made more than once lists each output; the item's
  `outputId` in the plan view is the newest.
- `?q=` (Nov 16, 2026) keeps the outputs whose title or summary holds every
  word given, in any case and order.
- `glimpse` (Nov 16, 2026), on listed and full outputs when the format has
  one: what a list shows besides the title, as `{ text?, media? }`. `text`
  is a plain line of what it says first (a set's first card, a quiz's first
  question, a video's idea); `media` is `{ kind: "image" | "video", url }`,
  for a video its file, so a list can show a frame. Each format writes its
  own (`FormatDefinition.glimpse`); a client shows what is there.
- `size` (Nov 23, 2026), on listed and full outputs when the format says
  it: how big the thing made is, `{ count: number, unit: string }`, for a
  list to show as `${count} ${unit}` ("3 min", "12 cards", "10 questions",
  "2 pages"). Each format counts its own (`FormatDefinition.size`) from
  what was made, never from what was asked: a video's and an audio's
  length from their file (whole minutes, or seconds under a minute: unit
  `min` or `s`), a set's cards, a quiz's questions, a guide's printed
  pages by halves (`count` 0.5 is half a page). `unit` is already singular
  or plural to suit `count`. Absent when the payload does not say (a video
  not rendered yet). A quiz's score ("8 of 10") is not a size: it is the
  item's `result` in the plan view.
- `done` (Nov 23, 2026), on listed and full outputs made from a plan item:
  whether the person ticked it done. True when the item's done tick names
  this output, or names none and this is the item's newest output (the one
  the plan view's `outputId` is); false otherwise. Absent on something not
  made from a plan item, where the engine keeps no tick.
- `PUT /v1/outputs/:id/payload` (Nov 20, 2026) keeps a made thing as the
  person changed it by hand, for a format that takes it (`FormatDefinition.edit`;
  the guide, `guide.md`, "Changing it by hand"). The body is the whole thing
  as they now have it; the format lays it over what it keeps, writes the
  output's `citations` and `title` again, and answers `400 invalid_edit`
  with every problem in plain sentences when it cannot. A format that is not
  changed by hand answers `409 not_editable`.

### Remaking one scene (Nov 23, 2026)

From the talk thread on a made video, a person can ask for one scene of it to be made again, with a note; the rest
of the video is kept, and the old one stays (and plays) until the new one is ready, which then takes its place.

| Route | Request | Response | Errors |
|---|---|---|---|
| `POST /v1/outputs/:id/scenes/:scene/remake` | `{ note?: string (≤ 2,000), agent?: string, model?: string, effort?: string }`; optional `Idempotency-Key` header | `202 { job: { id, status, stage, progress }, remakeOf: { outputId, scene } }` | `404` unknown output or scene; `409 being_made`; `409 cannot_remake { message }`; `400 invalid_request` |

- Only a format that declares it can take it (`FormatDefinition.remakeScene`;
  today video), and only for a made output whose maker can: a drawn scenes
  video, never an old storyboard. `GET /v1/outputs/:id` says
  `"remakesScene": true` on such an output, and nothing otherwise; its
  scenes are `payload.scenes`, by `id` (`s1`, `s2`, …), the `:scene` this
  route takes.
- `note` is the person's own words about the scene, passed to whoever
  remakes it as their ask. With no `agent`, it is made with the agent,
  model and effort the thing was made with (for a video,
  `render.maker.agent`), `model` or `effort` given replacing that one;
  with `agent`, that agent with only the `model` and `effort` given, so no
  model crosses from one agent to another.
- It starts an ordinary job of the output's format on the output's own
  item, with `input.remakeOf: { outputId, scene, note?, madeBy?, kept? }`
  (`madeBy` the job that made the output, `kept` what its maker kept on
  that job, `EngineOutput.keep`: for a video its id on the scenes service).
  The job writes a new output on that item, in the same project and plan.
  Until it is written, the item's `outputId` is the old one, and the old
  one is in every list.
- **The new video takes the old one's place (Nov 23, 2026).** Once the new
  output is written, the old one is archived as outputs are (`archivedAt`),
  so `GET /v1/plans/:id/outputs` (Made here), `GET /v1/projects/:id/outputs`,
  the Library (`GET /v1/outputs`) and the item's `outputId` show only the
  new one. The old one's row and files stay for whatever still points at it
  (a thread, a cite, a player open on it): `GET /v1/outputs/:id` still
  answers it, archived, and its files go only when nothing points at them,
  as for any deleted plan or project. A done tick that named the old output
  now names the new one; a tick that names no output is left as it is. Only
  the old output of the same item is retired; a redelivered job retires it
  once.
- Progress, Stop and times are any job's: the item in
  `GET /v1/plans/:id/progress` carries `remaking: { outputId, scene,
  note?, job }` while the remake is queued, running, waiting or failed
  (`job` as an item's own job is shown, with `step`, `doneBy`,
  `errorMessage`), and loses it once it is done or stopped;
  `POST /v1/jobs/:id/cancel` stops it; its making time is kept like any
  other (`make_times`).
- The new output, `GET /v1/outputs/:id`, says `remakeOf: { outputId,
  scene }`: which output it remade and which scene.
- `409 being_made`: the item is being made now (its own job, or a remake
  of what it made, is queued, running or waiting). `409 cannot_remake`:
  the format or this output cannot have a scene made again, or what it was
  made from is gone, with `message` in plain words ("What this video was
  made from is no longer on this computer, so one scene of it can't be
  made again. Make the whole video again instead."), or the scenes service
  is not running. A remake job that finds the draft gone after all fails
  with the failure code `draft_gone`.

### Assets

`GET /v1/assets/:id` (public, no token) answers a `Range: bytes=…` header
with `206 Partial Content` and `content-range`, and says `accept-ranges:
bytes` on every answer, so a video can be seeked in a browser or on the
phone. A range it cannot satisfy is `416` with `content-range: bytes */<size>`.
Only the asked bytes are read from storage, streamed as they are sent; an
open range (`bytes=N-`) is the rest of the file.


## A job's files on this computer

`POST /v1/jobs/:id/files/show` opens the folder a job works in, in this
computer's file manager (Finder, Explorer, or the desktop's own), for a
format whose jobs have one (`FormatDefinition.jobFiles`; today a video made
by the scenes service, whose job folder is laid out in
`docs/JOB-FOLDER.md`). An item's job in `GET /v1/plans/:id/progress` says
`files: true` when it has such a folder. `200 { shown: true }`; `409
no_files` with `message` in plain words when it has none, or its folder was
cleaned up, or the scenes service is not running. The web app offers it
only in the browser on this computer; a paired phone is refused by its
proxy.
## Usage

| Route | Response | Errors |
|---|---|---|
| `GET /v1/projects/:id/usage` | `200 { usage }` | `404` |
| `GET /v1/plans/:id/usage` | `200 { usage, items: [{ id, usage }] }` items in run order | `404` |

`usage` is the totals shape above, summed from the `usage` table (one row per
provider call). A call with no known price adds $0 to `usd` and 1 to
`unpricedCalls`.

## Chats (Nov 12, 2026; replies as pieces Nov 13, 2026)

A project has chats. A chat is a saved conversation: the person's messages
and Open Sourcebook's replies, in order. A reply answers from the project's sources,
with a citation at the exact spot each claim came from, or uses a
**skill**. Planning is the first skill. A reply is an ordered list of
**pieces** the client draws in order: some text, then a plan card, then
more text, or a question with options to pick. Starting and following a
plan stay on the plan routes above.

Chats are `sessions` and `messages` rows (migration 0004, 0007). Spend is
logged per call in `usage` with the chat's id (`session_id`) and project.

### Chat

```json
{
  "id": "…", "projectId": "…", "title": "Limits before the midterm",
  "sources": ["src_1", "src_4"],
  "answerer": "agent:claude:sonnet",
  "effort": "high",
  "messageCount": 6,
  "createdAt": "…", "updatedAt": "…", "busySince": "…"
}
```

- `title` is set from the first message when the chat is made without one,
  without a leading skill command and starting with a capital:
  "/plan limits for the midterm" titles it "Limits for the midterm". A
  message that is only a command titles it
  from the plan its reply made, if any; otherwise the next message does.
- `sources` are the chat's ticked sources (the Sources panel's
  checkboxes): the ones the last message sent, plus any source a message
  @-mentioned. Absent means none were ever sent: all of the project's.
- `answerer` is who answers this chat, as picked ("Who answers" below).
  Absent means none was picked: the engine's default answers.
- `effort` is how hard it thinks, one of the provider's `efforts`, as
  picked. Absent means the provider's own default.
- `busySince` is set while Open Sourcebook is writing a reply in this chat.

### Message

```json
{
  "id": "…", "chatId": "…", "seq": 3, "role": "assistant",
  "text": "A limit exists only when both one-sided limits agree. Want a plan to practise this?",
  "pieces": [
    { "kind": "text", "text": "A limit exists only when both one-sided limits agree.", "cites": [0] },
    { "kind": "question", "id": "q1", "text": "Want a plan to practise this?",
      "options": [{ "id": "o1", "label": "Yes, plan it", "skill": "planning" }, { "id": "o2", "label": "Not now" }],
      "multiple": false }
  ],
  "cites": [{ "sourceId": "src_7", "spot": "passage", "chunkId": "chk_12", "locator": { "charStart": 1200, "charEnd": 1840 }, "quote": "A limit exists only when both one-sided limits agree." }],
  "covered": true,
  "createdAt": "…"
}
```

- `role` is `user` or `assistant`.
- A **user** message has `text`, and may have `mentions`, `sources` and
  `answer`:
  - `mentions`: `[{ kind, id, label? }]`, what was @-mentioned. `kind` is
    `source`, `plan`, `item` or `chat`; a client that sends another kind gets
    it stored and ignored.
  - `sources`: the ids ticked for this turn.
  - `answer`: `{ messageId, picks: [{ questionId, optionIds }] }` when the
    message answers questions of an earlier reply by picking options.
- An **assistant** message has `text` (the whole reply, plain, for search
  and history) and `pieces`, in the order they are shown. Each piece has a
  `kind`:
  - The written blocks of the reply (Nov 15, 2026; "Reply blocks" below):
    `text` (a paragraph, `{ kind, text, cites }`; `cites` are indexes into
    the message's `cites`, a client shows a chip per cite at the end),
    `heading`, `list`, `table`, `note`, `math`, `code`, `teachback` and
    `mindmap`.
  - `plan`: `{ kind, planId, action, changes? }`. `action` is `created` or
    `edited`; `changes` lists, in words, what an edit changed and what it
    left alone because the person had changed it by hand. The client draws
    the plan card from the plan view (`GET /v1/plans/:id`), once per plan:
    on the newest piece about it.
  - `make` (Nov 22, 2026): one thing asked for in the chat, as its make
    sheet filled in, saved nowhere: `{ kind, format, title, about, sources,
    settings, plannedAs, notices, issues, remakes?, state, planId? }`
    ("Making one thing").
  - `question`: `{ kind, id, text, options, multiple }`. `options` are
    `[{ id, label, skill? }]`; `multiple` says whether more than one may be
    picked. The person may always type an answer instead of picking. An
    option with `skill` forces that skill when it is picked.

  The list of kinds is open: a new kind is added in the engine's piece
  registry without touching the chat core. A client draws a kind it does
  not know by its `text` when it has one, and otherwise says that this part
  of the reply can't be shown here; it never drops it silently.
- `cites` are the flashcards contract's `Cite` ([`flashcards.md`](flashcards.md), "Cite"):
  `sourceId`, `spot`, `chunkId`, `locator`, and a `quote` the engine has
  checked is word for word in that passage. A quote that is not there is
  dropped; the cite still points at the passage. `block` is not used in a
  chat; the piece says where a cite applies. A checked quote is stored
  widened to the whole sentences it sits in (Nov 13, 2026), so the spot a
  reader highlights starts and ends on a sentence: still the passage's own
  words, at most 400 characters (a sentence too long to fit leaves the
  quote as written). A line with no stop, such as a list item, ends where
  the line does. This holds however the reply was written: Open Sourcebook's own model
  or the person's own agent.
- `covered` is `false` when the sources did not hold the answer; the reply
  says so instead of answering from elsewhere. Absent on replies that make
  no claim from a source (a greeting, a skill's reply).
- `skill`: the id of the skill that wrote the reply, when one did.
- `failed`: present only on a reply Open Sourcebook could not write, as
  `{ reason, budgetUsd? }`. Its one `text` piece says what happened in
  plain words, so a client that ignores `failed` still shows something
  true. `reason` is one of:
  - `outOfCredit`: the model account is out of credit (HTTP 402);
  - `keyRefused`: the model key was refused (HTTP 401 or 403);
  - `budget`: the turn reached its `budgetUsd` (given back as
    `budgetUsd`) before the reply was done;
  - `error`: anything else (a model call failed); sending the message
    again may work;
  - the person's own agent adds its own reasons ("Your agent" below).

  A client may draw such a reply as an error and offer to send the
  message again, or point to the provider settings for the account
  reasons. Replies stored before this field existed have no `failed`,
  even when they said they failed; they read as ordinary replies.
- `usage`: the usage totals of the calls that wrote this reply. It is a
  record, not something the chat shows: spend totals are shown in
  Settings.

### Reply blocks (Nov 15, 2026)

What a reply says is an ordered list of blocks, the same whoever wrote it:
the person's own agent or Open Sourcebook's own model. Every
block is stored as a piece and keeps its words in plain `text`, so a client
that does not know a kind still shows it. Kinds sit in one registry in the
engine (`chat/blocks.ts`, which validates them and describes them to every
writer) and one in the web (`project/pieces.ts`, which draws them); a new
kind, such as a picture from a source, is one entry on each side.

| Kind | Stored | Writers name it |
|---|---|---|
| `text` | `{ kind, text, cites, unchecked? }` | `paragraph` |
| `heading` | `{ kind, text }` | `heading` |
| `list` | `{ kind, ordered, items: [{ text, cites, unchecked? }], text, cites }` | `bullets`, `numbered` |
| `table` | `{ kind, header: [..], rows: [{ cells: [..], cites, unchecked? }], text, cites }` | `table` |
| `note` | `{ kind, text, cites, unchecked? }` | `note` |
| `math` | `{ kind, text, cites }`, `text` is LaTeX | `math` |
| `code` | `{ kind, text, lang? }` | `code` |
| `teachback` | `{ kind, items: [{ verdict, text, cites, unchecked? }], text, cites }` | `teachback`, `teach-back` |
| `mindmap` | `{ kind, nodes: [{ id, text, detail?, cites, unchecked? }], links: [{ from, to, text }], text, cites }` | `mindmap`, `mind-map` |

- **A teach-back** (Nov 20, 2026) answers the person's own explanation of
  an idea. Each item is one point, with `verdict` `right` (what they said
  that the sources bear out), `missing` (what the sources say that matters
  and they left out) or `wrong` (what they said that the sources
  contradict, saying what the sources say instead), cited at the spot that
  shows it. Items are stored grouped in that order; `text` is the same
  grouped under "What you got right", "What you left out" and "What the
  sources say differently", for a client that does not draw the kind.
- **A mind map** (Nov 20, 2026) lays out the main ideas of the sources, or
  of a topic in them, and how they connect. The first node is the central
  idea; each node names an idea in a few words (`text`), says it in one
  sentence (`detail`) and carries the cites that open its passages. Each
  link reads from one node to another in a few words ("Sunlight *powers*
  Photosynthesis"). At most 16 nodes and 32 links; ids are the writer's
  own and unique; every node is linked, through others if need be, to the
  centre, and a map that is not is sent back to its writer. `text` is the
  map as a list of ideas and a list of connections. The web draws it round
  the centre; tapping an idea shows its sentence, cites and links.

- **Cites sit where the claim is**: on the block, the list item or the table
  row that says it, never inside the words; a client draws them small at the
  end of that block, item or row. Each is checked word for word as above;
  an item or row whose cites all failed carries `unchecked`.
- **Inline marks** are the flashcards contract's ([`flashcards.md`](flashcards.md), "Inline marks"):
  `**bold**`, `*italic*`, `` `code` ``, `$maths$`, plus a link to a cited
  spot, stored `[words](cite:N)` with `N` an index into `cites`. A writer
  links words with `[words](S1#4)` (its passage label); a link to any other
  address keeps only its words, and passage labels left in the words are
  taken out.
- A block of a kind the engine does not know but with words is read as a
  paragraph; one with nothing to show is sent back to the writer (the
  person's agent) or left out (Open Sourcebook's own model).
- The older `parts` (paragraphs) are still read, and replies stored before
  blocks (only `text` pieces) still draw.

### Routes

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /v1/projects/:id/chats` | | `200 { chats }` most recently used first | `404` |
| `POST /v1/projects/:id/chats` | `{ title?, sources? }` | `201 { chat }` | `400 invalid_request`, `404`, `409 project_archived` |
| `GET /v1/chats/:id` | `?after=<seq>` | `200 { chat, messages }` oldest first, at most 500 after `seq` | `404` |
| `PATCH /v1/chats/:id` | `{ title?, sources?, answerer?, effort? }`, `null` clears any | `200 { chat }` | `400 invalid_request`, `404`, `409 answerer_unavailable` |
| `DELETE /v1/chats/:id` | | `200 { chatId, deletedPlanIds, keptPlanIds }` | `404`, `409 chat_busy` |
| `POST /v1/chats/:id/messages` | `{ text, mentions?, sources?, skill?, answer?, budgetUsd?, answerer?, effort?, from?, opened?, today? }` | `200 { chat, messages, plans }` | see below |
| `GET /v1/chats/:id/usage` | | `200 { usage }` | `404` |
| `GET /v1/skills` | | `200 { skills, commands }` | `commands`: every command the chat takes now ("Making one thing") |
| `GET /v1/providers` | | `200 { connector, providers }` ("Providers", below) | |

- Renaming a chat is a PATCH of `title`. **Deleting** (Nov 13, 2026) a chat
  deletes its messages and the plans it made that were never started
  (`deletedPlanIds`); plans it made that were started stay in the project
  with everything they made, and lose their `chatId` (`keptPlanIds`). A
  chat with a reply being written is `409 chat_busy`.
- `sources` (chat or message) is a list of source ids in the chat's
  project, at most 500 (`400 source_not_in_project` otherwise). A message's
  `sources` are also saved as the chat's. A source the message
  @-mentions is read even when it is not ticked, and is added to the
  chat's `sources`, so the returned `chat` shows it ticked.
- **Sending a message** stores it, writes the reply, stores that, and
  answers with both (`messages`, the person's first). `plans` holds the
  plan view of every plan the reply's pieces carry (empty when none).
  Nothing is stored when the turn is refused before the reply is written;
  when writing the reply fails, the person's message stays and the reply is
  a short `assistant` message that says it failed and carries `failed`
  (see Message), so the chat never shows a question with nothing after it. When the model account was refused
  (out of credit, or the key refused) that message says so in plain words,
  naming the provider, and the call is not retried; a plan item's job fails
  the same way, once, with the same words as its `errorMessage`.
- `text` is 1 to 20,000 characters. `skill` names a skill to use (what
  `/plan` sends); without it Open Sourcebook decides. A text that starts with a skill's
  command (`/plan …`) is the same as naming it, and the rest of the text is
  what is asked of it.
- `answer` picks options of question pieces of one earlier reply in this
  chat: `messageId` is that reply, each pick names a `questionId` of it and
  one or more of its `optionIds` (exactly one unless the question is
  `multiple`). `text` still carries what the person's message says (a
  client sends the picked labels). When the picked options name a skill,
  that skill is used for the turn, unless the message also names one.
- `answerer`, when sent, is who answers this turn and is kept on the chat
  for the next ones ("Who answers" below); `409 answerer_unavailable` when
  this engine can't answer with it, and nothing is stored.
- `budgetUsd`, when sent, is the most this turn may spend; calls stop once
  it is reached and the reply says so (with `failed: { reason: "budget" }`
  when it ended the reply). Clients send none by default.
- Errors: `400 invalid_request`, `400 invalid_answer` (the reply, a
  question or an option is not in this chat, or a single-pick question got
  more than one), `400 unknown_skill`, `400 source_not_in_project`, `404`,
  `409 chat_busy` (a reply is being written in this chat; a turn left busy
  for more than five minutes is taken over), `409 project_archived`,
  `503 chat_unavailable` (no model provider is configured on the Worker).
- With the person's own agent set up, the reply comes back running and
  fills in later; see "Your agent" below.

### Who answers (Nov 16, 2026)

A chat is answered by one of the person's own agents, their **providers**
(`docs/DECISIONS.md` #62), with a model the person picks in the chat.
`GET /v1/providers` lists them ("Providers" under "Your agent", below).

- A pick is `agent` (the connector's own agent), `agent:<provider>` (that
  provider with its own default model) or `agent:<provider>:<model>`.
  Every provider and model lists its `pick`.
- A chat keeps its pick (`answerer` on the chat), set by `PATCH` or with a
  message. With none, the chat's remembered pick (`picks.chat`, set in
  Settings) answers; with none of those either, the one provider that is
  added, on and ready, when there is exactly one. No provider is preferred:
  with several and nothing picked the turn is `409 pick_needed` and nothing
  is stored. The same rule picks who makes a thing (`resolvePick` in
  `chat/providers.ts`): a make with nothing picked and several providers
  ready is `409 pick_needed` too.
- A `409 pick_needed` is `{ error, message, scope, scopes }`: `scope` is the
  pick that blocks it first (`chat`, a format id, or `<format>.review`),
  `scopes` every pick the same request needs, and the message names them
  ("pick who makes flashcards in Settings, What makes what"), so a client
  opens the right picker or says the command that sets it. A message from
  the terminal that makes one thing at once (`/<format> ...` with
  `from: "terminal"`) checks that format's maker before its chat turn runs,
  so the maker is named first and the chat after it when the chat has no
  pick either (its turn settles the thing). A make with no chat turn
  (`POST /v1/projects/:id/make`, a plan's Start) never needs the chat's
  pick.
- Every turn the engine hands the connector names an agent, since the
  connector has none of its own unless the person set `OPENSOURCEBOOK_AGENT`. An item
  whose agent is open is made by its shape's default from Settings, else the
  agent named for the engine or the connector, else the only provider that
  can. `POST /v1/projects/:id/make` and a plan's Start check this first and
  answer `409 pick_needed` with nothing kept or started. A job that still
  meets it (a retry after the person connected a second provider) fails
  saying to pick who makes it, or that no provider can.
- While a connector is set up the chat never falls back to Open Sourcebook's own model.
  A pick of a provider turned off or removed from the list, or a turn when
  nothing in the list and on can answer, is
  `409 answerer_unavailable` and nothing is stored. Whether the agent can
  run right now (connector down, signed out) is said in the reply, as for
  any agent turn.
- A chat keeps its effort (`effort` on the chat) the same way; it goes to
  whoever answers. Without one, the provider thinks with its own default.
- `from: "terminal"` says the message comes from the `opensourcebook` command, not the
  app: the reply then points at commands (`opensourcebook plan start`) rather than at a
  plan card or a button the person cannot see. Anything else is the app.
- With no connector set up, a pick is refused (`409`) and Open Sourcebook's own model
  answers when a model key is set; with neither, the chat answers
  `503 chat_unavailable`.

### Threads (Nov 18, 2026)

Everything made can be talked back to in place: a **thread** on a made
thing, opened and closed on it, at the spot the person is at. A thread is
not stored apart: each message in it is a message of the chat that made the
thing (the plan's chat), carrying `about`, and the reply to it carries the
same `about`. So the chat shows every message and the thread only those
about its thing, and an answer written once shows in both. A thing no chat
made (a Studio tile, or its chat deleted) gets a new chat the first time
someone writes in its thread, titled from the thing and linked to its plan.

| Method | Path | Body / query | Answer |
|---|---|---|---|
| `GET` | `/v1/plans/:id/items/:itemId/thread` | `?after=<seq>`, `?at=<json>` | `200 { item: { id, planId, projectId, title, type, outputId? }, chat?, messages, here?: { label } }` |
| `POST` | `/v1/plans/:id/items/:itemId/thread` | `{ text, at?, answerer?, effort?, from? }` | `200 { chat, created, messages: [user, reply] }`, as a chat message: the reply runs while the person's agent writes it |
| `GET` | `/v1/threads` | `?project=<id>` | `200 { threads: [{ itemId, chatId, count, lastAt }] }`: which things have a thread and how many messages each holds |

- `at` is where the person is in the thing, in its player's own shape: the
  same JSON an item's kept progress holds (a video's `{ time }`, a set of flashcards'
  `{ card, cards }`, a quiz's `{ at, responses, ended }`). At most 20,000
  characters of JSON.
- `about` on a message: `{ item, plan, output?, format, title, at?, label? }`.
  `label` is the spot in the format's own few words ("at 0:42", "question 2
  · wrong"), from the format's `describeAnchor`; a format without it keeps
  `at` as given and has no label. `here` is the same for a spot not sent yet.
- The turn is told, as generated facts, which thing it is, its brief and
  settings in the format's words, what it covers, and the spot: what the
  format's `describeAnchor` says is there (for a video, the scene then, what
  it shows, the words on screen and what the voice says around that time;
  for a quiz, the question, its options, the answer given, whether it was
  right, the right answer and the explanation the quiz gave). The thing is
  also the one open in front of the person, so a remake knows which.
- A chat busy with another reply refuses the message (`409 chat_busy`)
  before anything is stored.

## Your agent (Nov 13, 2026; local only)

The person can bring their own agent (`docs/DECISIONS.md` #53): their
Claude Code (later Codex), installed and logged in on their own computer
with their own subscription, answers the chat inside Open Sourcebook instead of Open Sourcebook's
model. A small connector on that computer (`services/agent-connector`)
runs it boxed in: an empty directory, its own tools off, no prompts, and
only Open Sourcebook's tools. It is one more way a turn is answered; everything about
chats above still holds, with the differences below.

It is on only when the engine has `CHAT_AGENT_URL` (a connector on this
machine; any other host is refused) and `CHAT_AGENT_TOKEN`, and the engine
says so once in its log. With it set, the same agent also makes flashcards and
quizzes (DECISIONS #66).

### A turn

- `POST /v1/chats/:id/messages` answers at once. The person's message is
  stored as always; the reply is stored **running**:
  `{ …, "role": "assistant", "text": "", "pieces": [], "state": "running", "agent": "claude", "steps": [] }`.
  The chat stays busy (`busySince`) until the turn ends.
- `GET /v1/chats/:id` shows a running reply with the `steps` taken so far
  and, as soon as the agent writes them, the reply's blocks (`pieces`,
  `cites`, `text`) drawn as they will stay. A client polls it (the web every
  600 ms, asking only for messages from the running one on with `after`)
  while a reply has `state: "running"`. When the turn ends the same message
  (same `id` and `seq`) has its `pieces`, `cites` and `covered` like any
  reply, no `state`, and keeps `steps`. Polling was chosen over server-sent
  events: a turn is many small tool calls and drafts that each land in the
  database anyway, the Worker has nothing to push from without a Durable
  Object, and nothing has to hold a connection open through the proxy.
- **Blocks while they are written**: the engine names to the connector the
  tools that show while written (`drafts: ["reply"]`); the connector reads
  the agent's partial tool input (Claude Code's `--include-partial-messages`)
  and posts the newest of it at most every 250 ms to
  `POST /v1/agent-turns/:id/draft`. The engine reads the cut-off JSON as far
  as it goes and keeps one draft per turn (`agent_turns.draft_json`,
  migration 0012): the blocks so far, the last perhaps half a sentence, with
  only the cites that already pass the check and no "not checked" marks. A
  draft carries `calls`, the tool calls before it, and is shown only while
  no call but sent-back tries of the same tool has landed since, so a late
  draft never shows over the checked reply.
- The `reply` tool may also be called more than once with `more: true` on
  all but the last call; each call adds its blocks after those shown, with
  the cites of earlier calls keeping their numbers. A second whole reply
  after the last call is sent back.
- A **step** is one tool call: `{ tool, label, state, startedAt, endedAt? }`.
  `label` is plain words for the person ("Searching Lecture 7", "Making a
  plan"); `state` is `running`, `done` or `failed` (the tool refused the
  call, for example a cite that failed the check, and the agent tried again).
  While the reply is being written, before its call lands, the last step is
  that call (`state: "running"`, "Writing the reply").
- Once the turn ends the reply also has `stepLines`: the steps in fewer
  lines, said in the past, `[{ text, steps, state }]`. Steps in a row of one
  tool that did the same kind of thing are one line ("Read 9 passages of
  Lecture 7", "Searched your sources for “mole” and “molar mass”", "Wrote
  the reply, after fixing quotes that weren't word for word"); each tool
  says its own words (`AgentTool.said`), and one that does not shows its
  label.
- The reply is assembled from the steps through the piece registry: the
  blocks the agent gave the `reply` tool first, then what other steps made
  in the order they ran (a plan card once per plan, its changes gathered;
  questions), then the reply's closing words. With no `reply` call, the
  agent's last words stand in, marked `unchecked`.
- **Cites** are checked as for any reply, and more strictly: every cite must
  name a passage of the ticked sources and quote its words exactly. A reply
  with a cite that fails, or that read the sources but cites none, is sent
  back to the agent with what is wrong (up to twice). After that it is kept
  with those cites dropped, and a part left without any carries
  `"unchecked": true`: a client says it is not checked against the sources
  instead of showing it as cited.
- **Failures** end the reply with `failed: { reason }` and one plain `text`
  piece marked `failure: true`; plan cards the turn already made stay in
  the reply after it. Blocks the reply tool had already shown stay before
  it, the words say the reply is cut short, and `failed.cutShort` is true.
  A turn stopped after the reply's last call landed keeps the whole reply.
  Reasons beyond those above:
  - `agentUnreachable`: the connector is not running (the reply ends at once);
  - `agentMissing`: the agent is not installed on that computer;
  - `agentSignedOut`: the agent is not signed in;
  - `agentLimit`: the agent's plan has reached its usage limit;
  - `timedOut`: the turn ran past `CHAT_AGENT_TIMEOUT_MS` (default 10
    minutes); a turn the connector never ends is closed this way when the
    chat is next read or written;
  - `stopped`: the person stopped it.
- **Usage**: one row per turn with provider `agent:<id>` (for example
  `agent:claude`), the model the agent used, its token counts and `usd` 0.

### Routes

| Route | Request | Response | Errors |
|---|---|---|---|
| `POST /v1/chats/:id/stop` | | `200 { chat, messages }`: the stopped reply, with what it made | `404`, `409 not_running` |
| `GET /v1/agent` | | `200 { agent: { configured, reachable?, id?, label?, installed?, signedIn?, version?, model? } }` | |

A chat that picked a provider or a model ("Who answers" above) is run with
it: the engine hands the connector that agent and model. A picked agent
other than the configured one runs on its own default model.

### Providers (Nov 16, 2026)

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /v1/providers[?fresh=1]` | | `200 { connector: { configured, reachable, checkedAt? }, providers, picks? }` | |
| `PATCH /v1/providers/:id` | `{ added?, enabled?, hiddenModels?, favoriteModels? }` | `200 { connector, providers, picks? }` | `400 invalid_request`, `404`, `503 agent_unavailable` (no connector set up) |
| `PUT /v1/providers/picks/:scope` | `{ agent?: string \| null, model?: string \| null, effort?: string \| null, off?: boolean \| null }` | `200 { ok: true, scope, pick }` | `400 invalid_request`, `400 unknown_scope`, `404` |
| `PUT /v1/providers/picks` | `{ picks: { [scope]: { agent?, model?, effort?, off? } } }` | `200 { picks }` (every pick after the write) | `400 invalid_request`, `400 unknown_scope` |

```json
{
  "connector": { "configured": true, "reachable": true, "checkedAt": "2026-11-16T17:20:00.000Z" },
  "providers": [
    { "id": "claude", "label": "Claude Code", "mark": { "path": "m4.71 15.96 4.72-2.65…", "color": "#D97757" }, "local": true, "added": true, "enabled": true, "state": "ready", "headline": "Ready",
      "signIn": "claude auth login", "install": { "command": "curl -fsSL https://claude.ai/install.sh | bash", "url": "https://code.claude.com/docs/en/setup" },
      "version": "2.1.0", "default": true, "defaultModel": "haiku", "defaultEffort": "medium", "workDefault": true, "workDefaultModel": "sonnet", "workDefaultEffort": "high", "pick": "agent:claude",
      "models": [{ "id": "haiku", "pick": "agent:claude:haiku", "label": "Haiku", "shown": true, "favorite": false, "maker": "anthropic", "tier": "fast" },
                 { "id": "opus", "pick": "agent:claude:opus", "label": "Opus", "shown": false, "favorite": false, "maker": "anthropic", "tier": "strong" }],
      "makers": { "anthropic": { "label": "Anthropic", "mark": { "path": "M17.3 3.54h-3.67…" } } },
      "efforts": [{ "id": "low", "label": "Low", "weight": "light" }, { "id": "max", "label": "Max", "weight": "max" }] },
    { "id": "codex", "label": "Codex", "local": true, "added": true, "enabled": true, "state": "ready", "headline": "Ready",
      "detail": "Answers with the OpenAI API key in Open Sourcebook's connector settings, billed to that key, as Codex is not signed in.", "pick": "agent:codex",
      "models": [{ "id": "gpt-6-luna", "pick": "agent:codex:gpt-6-luna", "label": "GPT-6-Luna", "shown": true, "favorite": false }], "efforts": [] }
  ],
  "picks": {
    "video": { "agent": "claude", "model": "opus", "effort": "high" }
  }
}
```

- A provider is an agent the connector can run, as it reports it. Providers
  are listed A to Z by `label` (case aside), whatever order the connector
  has them in, and none is preferred. Its adapter names its models, the
  command that signs in to it (`signIn`, run on the person's computer; Open Sourcebook
  never holds a credential) and where it is installed from (`install`:
  `{ command?, url }`, its own install page over https and the one-line
  command that page gives, when it gives one). Both are served whatever its
  state, for its "How to connect": install it, sign in once, then check
  again (`?fresh=1`).
- `default: true` marks the chat's remembered pick (`picks.chat`) and
  nothing else; `defaultModel` and `defaultEffort` are what that pick names.
  With no `picks.chat`, no provider is the default. `state` is `ready`, `signedOut`, `missing` or
  `unavailable`; `headline` and `detail` say it in words. One that is not
  signed in but answers with an API key the person gave the connector is
  `ready`, and its adapter's `note` (how it answers) is the `detail`.
- `added`, `enabled`, which models are `shown` and which are `favorite`
  are the person's (`provider_settings`, migrations 0013 and 0014). A
  provider the connector finds installed is in the list until they remove
  it (`added: false`); one not installed joins it when they add it.
  Every provider is on with every model shown and none starred until they
  change it. A provider not in the list or turned off is never used; a
  model not shown is left out of the chat's picker; starred ones are
  listed first, under the picker's star.
- `efforts` are what may be picked for how hard it thinks, lightest
  first, as its adapter names them, each with optional `weight`
  (`"light" | "medium" | "high" | "max"`); empty when it takes none.
  Similarly each model may declare `tier` (`"fast" | "balanced" | "strong"`),
  and providers may declare `workDefault`, `workDefaultModel`, and
  `workDefaultEffort` for longer work (`turnKind: "work"`).
- `picks` (`agent_picks`, migrations 0018 and 0019) holds the defaults
  `{ agent?, model?, effort?, off? }` keyed by scope, omitted when empty;
  `PUT /v1/providers/picks/:scope` saves or updates a scope, and clearing
  every field with `null` deletes it. The scopes are those the formats
  declare ("Makers and reviewers" below); any other is `400 unknown_scope`.
- With no connector set up or an unreachable connector, `providers` is empty;
  remembered `picks` stay available.
- `mark` is the provider's logo, from its adapter, and `makers` the
  makers of its models by id, each `{ label, mark }`; a model's `maker`
  names one of them. A mark is `{ path, color? }`: one filled path in a
  24×24 box, in that colour or the text's. Anything but plain drawing
  commands and a `#rrggbb` colour is dropped. A provider with no `mark` is
  shown with a plain one, and a model with no `maker` with its provider's.
- `?fresh=1` has the connector check each agent again instead of answering
  from its last check (kept 30 seconds); `checkedAt` is when this answer
  was made.
- An unreachable connector lists no providers.
| `POST /v1/agent-turns/:id/tools` | `{ name, arguments }`, turn token | `200 { text, isError }` | `404`, `409` (the turn is over) |
| `POST /v1/agent-turns/:id/draft` | `{ tool, input, calls }`, turn token; `input` is the tool's JSON so far | `200 { ok }` | `400`, `404` |
| `POST /v1/agent-turns/:id/finish` | `{ outcome, problem?, text?, model?, tokensIn?, tokensOut?, durationMs? }`, turn token | `200 { ok }` | `404` |

`GET /v1/agent` never carries a credential; `configured: false` means the
chat is answered by Open Sourcebook's own model. The `agent-turns` routes are for the
connector only: they take the turn's own token (`Authorization: Bearer`),
made for that turn and stored only as a hash (`agent_turns`, migration
0010), never the client token. A call after the turn ended does nothing.

### First-time setup (Nov 22, 2026)

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /v1/setup` | | `200 SetupState` | |
| `PUT /v1/setup` | `{ done?: boolean, voice?: { skipped: boolean } }` | `200 SetupState` | `400 invalid_request` |

```ts
interface SetupState {
  done: boolean;                                    // set by the last step, or "Skip" on it
  providers: { connected: number; ready: number };  // added and on / of those, ready
  voice: { set: boolean; skipped: boolean };        // a voice service is chosen / the person skipped the voice step
}
```

- The app walks the person through three steps: providers, voice, try it.
  Only `done` and `voice.skipped` are kept (`owner_settings`, migration 0021,
  keys `setup.done` and `setup.voice.skipped`); `false` clears either. A
  `PUT` sends one or both. `providers` and `voice.set` are read fresh on
  every answer from what is set up now, so the app can tell which step still
  needs something.
- "Skip" on the voice step is `PUT /v1/setup { voice: { skipped: true } }`:
  a person who skipped it is not sent back to it, though `voice.set` stays
  false; choosing a voice later in Settings needs no change here.
- Step 1 lists `GET /v1/providers` (A to Z, none preferred). "Connect" is
  `PATCH /v1/providers/:id { added: true, enabled: true }`; "How to connect"
  shows the provider's `install` and `signIn`; "Check again" is
  `GET /v1/providers?fresh=1`.
- Step 2 is the voice routes; `voice.set` is false when there is no scenes
  service to ask. Step 3 ("Try it") uses the example import.
- With no connector set up, `providers` is `{ connected: 0, ready: 0 }`.

### Open Sourcebook's tools

Defined once in `chat/agent/default-tools.ts`, each with its name, what it
does for the agent, its input schema, its step label and its handler; the
connector lists whatever the engine sends with the turn. Every tool acts on
the one chat, its project and the sources ticked in it. Sources keep their
label for the whole turn (S1 is the first readable source in project
order), passages are `S1#4`, and plan items `I1`, `I2` as `read_plan` shows
them.

| Tool | What it does |
|---|---|
| `list_sources` | The project's sources: label, title, kind, passages, ticked or not. |
| `outline_sources` | The ticked sources passage by passage, as the planner sees them. |
| `search_passages` | Ranked passages of the ticked sources for a query, word for word. |
| `read_passages` | A run of passages of one ticked source. |
| `tick_source` | Ticks a source for the chat. |
| `read_plan` | A plan of this chat, its state in plain words and its size, with its items as I1, I2; a big plan without briefs, or one `stage` in full. |
| `make_plan` | A new plan in the planner's own shape, read, priced, checked and written by the same code as `/plan` (`chat/planning/commit.ts`), or every problem back. With `plan`, the next part of a plan written in parts: its stages go after the plan's last one. |
| `read_skill` | A file of Open Sourcebook's skills; the planner's guide (`skills/planner`) is given whole with every turn, its references are read with this. |
| `change_plan` | Ops on a plan that has not started, the planner's own ops and rules (items the person changed by hand are left alone unless named). |
| `start_plan` | Approves and starts a plan, only when the person asks. |
| `plan_progress` | Each item's status and done tick. |
| `make_item` | One thing's make sheet, settled and checked as a plan item, added to the reply as a `make` piece; nothing is saved or made until the person presses the sheet's button. From a terminal it is made at once. |
| `remake_item` | The make sheet for a made thing (by its thing id or an item id) again with only what changes (settings merged, a new brief, title, sources or format), carrying `remakes`; once made it is linked to the old one. From a terminal it is remade at once. |
| `stop_making` | Stops a thing made at once while it is being made. |
| `ask` | Question pieces with options; the answer is the person's next message. |
| `reply` | The reply as blocks with cites, checked word for word, shown as it is written; ends the turn. |

## Video makers (Nov 15, 2026; the scenes maker is local only)

A video is made by a **maker** (`docs/DECISIONS.md` #54): one way of making
the one video shape, behind a registry in the engine
(`engine/src/engines/video/makers.ts`). One exists now; the storyboard
maker (Open Sourcebook's model writing the scenes, the file white frames with each
scene's plan on them) was taken out on Nov 18, 2026 (DECISIONS #69):

- **Drawn scenes** (`scenes`): the person's own agent (Claude Code, through
  the agent connector on their computer) writes the video in a scene
  language inside the scenes service (`services/scenes`), building each
  scene, looking at its frames and fixing it; the service voices and renders
  it. Set up when `SCENES_SERVICE_URL` (this machine only; any other host is
  refused) and `SCENES_SERVICE_TOKEN` are; local only, like the chat's own
  agent. Its label, description and styles come from the service
  (`GET /status`, kept 20 seconds, 3 when the service did not answer). Open Sourcebook
  sends the item's passages, brief, earlier items, length and style; shows
  the service's own step words on the item while it works (`job.step`);
  checks the script it comes back with like any video (quotes word for
  word, lengths, no passage labels) and sends what fails back once; then
  stores the file and writes `render` with `storyboard: false`, `by:
  "scenes"` and `render.maker` (`{ id, label, style?, agent?, voice? }`).
  It calls no Open Sourcebook model: the estimate is `usd: 0` ("written by your own
  agent on this computer"), and the job records one usage row with
  provider `agent:<id>` at cost 0. Stop on the plan stops the agent on the
  service. A redelivered job follows the video already being made; a retry
  after a failed video starts a new one.

`auto` picks the maker named by `VIDEO_MAKER_DEFAULT`, else the first
set up. An item whose `maker` is still `storyboard` reads as `auto`,
and a job the storyboard maker planned is planned again by the maker it
resolves to now. A failed scenes video says why in
plain words: the maker isn't running on this computer, the agent can't be
reached, isn't installed, isn't signed in or is at its usage limit, it took
too long, it was stopped, or its script did not pass Open Sourcebook's checks
(`jobs/failure-words.ts`). An item whose maker is not set up here fails
with that said.

### Routes

| Route | Response | Errors |
|---|---|---|
| `GET /v1/video-makers` | `200 { makers: [{ id, label, description, local?, default?, styles, available, problem?, notice?, agent?: { id?, label?, model?, effort? } }] }` | |
| `GET /v1/video-makers/:maker/styles/:style/preview` | `200` the picture (`image/*`, `cache-control: private, max-age=3600`) | `404 not_found` (no such maker or style, or no picture now) |

Both take the client token. `GET /v1/video-makers` asks each maker that
needs something on this computer whether it is there now; `problem` says
what to do in plain words. `styles` is how many it has. The preview route
passes on the picture the maker's own service makes (a real frame of a
small sample scene in that style); clients cannot reach that service or
hold its token. The `preview` of each `style` option in `GET /v1/formats`
is this route.

### Who watches it, and how long it took (Nov 22, 2026)

The scenes maker sends the item's reviewer (`reviewer`, `reviewEffort`,
read with `reviewerPickOf`) with the video: nothing for `"auto"` (the
service's own setting: on, with the video's own pick), `review: false` for
`"off"`, and for a pick `review: true` with `reviewAgent`, `reviewModel` and
`reviewEffort`. A model or effort goes only with the agent it was picked
for; a reviewer pick that names no agent watches on the video's agent.

A finished video's output carries `timing` (`MakeTiming`): the service's
own `makingSeconds` (the agent's turns, the voice and the drawing, never a
wait) and its fresh viewer's seconds apart, under the pick it ran on (the
item's agent, model and effort, else what the service ran by itself). It is
kept through a send-back and the saving. The maker says no time before
making from guesses: no drawing speed, no other model's runs, no other
videos; `job.doneBy` is said before the last drawing only from a run on
this very pick and length (`madeIn`, from `make_times`), and while drawing
from this run's own pace.

### The iPhone app

Nothing here breaks it: its decoders read named keys and ignore the rest
(`showWhen`, `preview`, `render.maker`, `job.step`). A scenes video plays
like any video and is not marked a storyboard (`render.storyboard` is
false). What it would need to show more: `job.step` on a running item, the
"Made by" words from `render.maker`, and, if the phone ever edits plans
(it does not, DECISIONS #10), `showWhen` and picture cards for `preview`
(the picture route needs the client token, as every route but assets).

## Makers and reviewers (Nov 22, 2026)

Who makes each thing, and who reads it fresh once it is made, is the
person's choice per shape. The agent fields live in one place
(`engine/src/engines/agent-fields.ts`); a format declares them through it.

**Fields.** A format whose maker runs the person's agent declares one
`kind: "agent"` field with `role: "make"` (`key: "agent"`, `effortKey:
"effort"`); flashcards, quiz, audio and guide declare it with `turnKind:
"chat"`, video with `"work"`. Where a format also has Open Sourcebook's own writer
(flashcards and quiz with a model API key), the field carries `showWhen`
on the maker choice. A format that has a review turn also declares
`role: "review"` (`key: "reviewer"`, `effortKey: "reviewEffort"`,
`offValue: "off"`). Today only video does: its fresh viewer of the drawn
video. A format has at most one field of each role. Values: `"auto"` (the
scope's default), `"off"` (a reviewer only), or a pick id (`"agent"`,
`"agent:<provider>"`, `"agent:<provider>:<model>"`); efforts `"auto"` or an
effort id. An item's own values reach its agent turns; `"auto"` leaves the
engine's own agent, model and effort.

**Scopes.** A default is kept per scope: `chat`, the id of each format
with a `role: "make"` field, and `<format>.review` for each format with a
`role: "review"` field. Scopes are derived from the formats, never listed.
`off` is kept only on a review scope (`400 invalid_request` elsewhere).

**Settling.** What an item leaves open is filled from its scope's default:
the agent (with its model) when the item has none, and the default's
effort only when the agent used is the default's own agent. A reviewer's
default comes from `<format>.review`, and may be `off`. With no review
default, an open reviewer stays `"auto"`: on, with the maker's own pick.

**Use one for all.** `PUT /v1/providers/picks` with every make scope
(`chat` and the formats whose descriptor has an agent field with `role`
other than `"review"`) sets them in one write. Review scopes are never part
of it. One unknown scope refuses the whole write.

**The chat.** A chat with no `answerer` of its own reads the `chat` default
each turn (nothing is copied onto the chat, so changing the default
changes every chat that never picked); its effort rides along only with
its own agent. A default whose provider is now off or removed is passed
over.

**The make sheet and a plan item** change one thing only; they never
write a default.

### Changing the maker of a plan's items

`POST /v1/plans/:id/maker`

```json
{ "agent": "agent:codex:gpt-5", "effort": "high", "reviewer": "off", "items": ["n2", "n3"] }
```

- `agent`: a pick id, or `null` for `"auto"` (back to the defaults).
  `effort`: an effort id, or `null`/absent, which clears the old effort
  (it was the old agent's). `reviewer` (a pick id, `"off"`, or `null` for
  auto) and `reviewEffort` change only items whose format has a reviewer,
  and only when sent. `items` limits the change to those items; absent,
  every item not made yet.
- Items changed: enabled items whose status is not `done`. Items of a
  format without a maker's agent field are left as they are and listed in
  `unchanged` as `{ itemId, why: "Made without your agent" }`. Each new
  value is checked by its format; one refused is `422 invalid_settings`
  and nothing changes.
- A `draft` or `approved` plan takes it as an edit (approved goes back to
  draft). A `cancelled` (stopped) or `failed` plan takes it as the one
  exception to "a started plan's items stay fixed": only the agent and
  reviewer settings of items not made change, and each changed item's job,
  when it has one, gets the new settings and loses its saved steps (they
  were the old maker's; `attempt` back to 0). A `running` plan is
  `409 plan_running` (stop it first); `done` or `discarded` is
  `409 plan_finished`.
- Nothing starts: Resume (or Start) makes them, with the new maker. A
  failed item is made again with Retry.
- The answer is the plan view with `changed: string[]` (item ids) and
  `unchanged: Array<{ itemId, why }>`.

## Making times (Nov 22, 2026)

How long things took to make, from past runs on this computer only. The
engine records one time when a job finishes `done`, from the `timing` its
maker reports; nothing is estimated and nothing falls back to another pick.

| Route | Response | Errors |
|---|---|---|
| `GET /v1/make-times[?scope=<scope>]` | `200 { times: MakeTime[] }` | `400 invalid_request` (a scope that cannot be one) |

```json
{
  "scope": "video", "agent": "claude", "model": "opus", "effort": "high",
  "bucket": "le4", "runs": 5, "seconds": 312.5, "lastAt": "…"
}
```

- `scope` is `chat`, a format id, or `<format>.review` (the time of the
  fresh read of something made). `model`, `effort` and `bucket` are left out
  when the pick or the shape has none.
- `bucket` is the length bucket, only for a shape whose descriptor declares
  `timing: { setting, edges }` (today video and audio): `auto` when the length
  setting is 0, `le<edge>` for the first edge the length does not exceed,
  else `gt<last edge>`. A length left on Auto that settling filled in keeps
  `autoLength` (the number filled in) beside it and is still kept under `auto`
  while the length holds that number. Clients compute it the same way; the cases both sides
  test are `engine/tests/fixtures/time-buckets.json`.
- `seconds` is the middle (median) of the newest 12 runs of that exact key;
  `runs` says how many that was (at most 12). `lastAt` is the newest run.
- Look a time up by the exact `(scope, agent, model, effort, bucket)`. A key
  with no run is not in the list: say "no time yet". Never use another model's,
  another effort's, another agent's or another length's time instead.
- A job records at most one time (and one review time under
  `<format>.review`), however often it is run again. A job that fails records
  none, and neither does a maker that reports no `timing`.
- Which pick a time is under is the pick the maker named in its `timing`: the
  agent id; the model picked, else the adapter's default for that kind of turn,
  else the model the connector reported; the effort picked, else the adapter's
  default, else none.

**The chat's replies.** A chat reply that finishes `done` records one time
under scope `chat`, from the `durationMs` the connector reports at
`POST /v1/agent-turns/:id/finish` (a reply with no `durationMs`, or one that
failed or was stopped, records none). Its key is the agent that answered; the
model the chat picked for that agent, else the adapter's default for chat,
else the model the connector reported; the chat's effort, else the adapter's
default. A chat has no length bucket.

## Activity (Nov 23, 2026; local only)

What the person's agents are doing and what each run took, on this
computer. It joins what is being made now (the jobs running, waiting or
queued) with the finished turns the agent connector keeps in its usage log.
The engine cannot read files, so the log comes from the connector's
`GET /usage` (`services/agent-connector/README.md`), with the connector's
token. No money: the cost the log keeps is never read or served (DECISIONS
#45).

| Route | Response | Errors |
|---|---|---|
| `GET /v1/activity[?limit=&cursor=&shape=&project=&dayStart=]` *paged* | `200` the shape below | `400 invalid_request` |

```json
{
  "connector": "ready",
  "making": [{
    "jobId": "…", "shape": "video", "title": "The spindle",
    "project": { "id": "…", "title": "Cell biology" },
    "open": { "projectId": "…", "planId": "…" },
    "status": "running", "step": "Drawing scene 3 of 7", "progress": 0.3,
    "since": "…", "seconds": 312, "doneBy": "…",
    "maker": { "agent": "claude", "model": "opus", "effort": "high" }
  }],
  "turns": [{
    "turnId": "…", "at": "…", "shape": "video", "review": true, "title": "The spindle",
    "project": { "id": "…", "title": "Cell biology" },
    "open": { "projectId": "…", "planId": "…", "outputId": "…" },
    "agent": "claude", "agentLabel": "Claude Code", "model": "opus", "effort": "high",
    "seconds": 600, "inputTokens": 120, "outputTokens": 9000,
    "cacheReadTokens": 800000, "cacheWriteTokens": 40000,
    "toolCalls": 41, "outcome": "done"
  }],
  "nextCursor": "412",
  "totals": {
    "today": { "turns": 12, "seconds": 2400, "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
    "week": { "turns": 80, "seconds": 9000, "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 }
  },
  "shapes": [{ "id": "chat", "label": "chat" }, { "id": "video", "label": "video" }],
  "projects": [{ "id": "…", "title": "Cell biology" }]
}
```

- `connector` is `ready`, `notSetUp` (the engine has no `CHAT_AGENT_URL`)
  or `unreachable` (it did not answer, or is too old to have `/usage`).
  Neither is an error: the answer is `200` with no `turns` and no `totals`,
  and `making` still lists what is being made. `log: "off"` says the
  connector keeps no log (`OPENSOURCEBOOK_USAGE_LOG=off`).
- `making`: running first, then waiting, then queued, each oldest first.
  `step` is the item's live step in plain words (the same as on the plan,
  the scenes service's own words for a video), `waiting` is
  `{ reason, words }` while it waits, `since` is when it started (when it was
  asked for, while queued) and `seconds` how long ago that was. `maker` is
  the agent, model and effort the person picked for it; absent when it was
  left to Open Sourcebook. `doneBy` as on a plan item.
- `turns`: newest first. `shape` is the format the turn was for (served
  under its id now), `chat` for a chat reply, or the turn's own type; a
  format's fresh read once it is made (`<format>-review`) is the format with
  `review: true`. A turn that named nothing has no `shape`. Each turn is
  placed by the target it named: a chat (`open.chatId`), a plan item
  (`open.planId`, and `open.outputId` once made), or a job (a video's run
  on the scenes service is named by its job, `<job>` or `<job>-<n>`).
  `open` is where the web opens it; a turn whose target is gone is kept
  with no `title`, `project` or `open`, and one for something another owner
  holds is left out. `seconds` is the turn's own time, to a tenth;
  `inputTokens` are the tokens read fresh, `cacheReadTokens` the ones read
  from the cache, `cacheWriteTokens` the ones written to it,
  `outputTokens` the ones written; each is left out when the agent did not
  report it. `outcome` is `done`, `failed` or `stopped`.
- `totals`: `today` is from `dayStart` (the start of the person's day, as
  an ISO time; UTC midnight when absent), `week` the 7 days that end with
  today. Both count only what the filter keeps.
- `shape` and `project` filter `making`, `turns` and `totals`; `shapes` and
  `projects` are what the person can filter by (what is being made and the
  week's turns), never narrowed by the filter. A filtered page looks at
  most 2000 turns; `nextCursor` then carries on from there, so a page may
  have fewer than `limit` turns and still a `nextCursor`.

## Sources from a folder and from Google Drive (Nov 22, 2026)

**A folder.** There is no folder route: a client walks the folder the person
chose, keeps the files Open Sourcebook takes, and adds each one through the two calls
every file uses (`POST /v1/uploads`, then `POST /v1/sources { uploadId,
projectId }`), so each file has its own result. What Open Sourcebook takes is one list,
the one `POST /v1/uploads` checks:

| Method | Path | Response |
|---|---|---|
| `GET` | `/v1/uploads/types` | `200 { maxBytes: number; types: UploadType[] }` |

```ts
interface UploadType {
  contentType: string;   // "application/pdf", or "image/*" for every type under image/
  extensions: string[];  // file name endings, without the dot, in lower case
  group: string;         // the plain word: "PDF", "slides", "docs", "spreadsheets", "images", "audio", "video"
}
```

The groups in order, joined, are what the adder says it takes. A file sent
with no type, or as `application/octet-stream` (a browser that does not
know a `.md`), takes the type its `x-upload-filename` ending says. A file
the list does not take is `415 unsupported_media_type`, and a file over
`maxBytes` is `413 upload_too_large`; both messages start with the file's
name, so a client adding a folder can show one plain line per file.

**Google Drive, by a shared link.** Open Sourcebook does not sign in to Google Drive. A
Drive, Docs, Slides or Sheets link is added like any link (`POST
/v1/sources { url, projectId }`) and is read as the file it shares, through
its public export, never as its viewer page (`src/extract/ladders/drive.ts`,
chosen by host in `src/extract/kinds.ts`):

| Link | Read as |
|---|---|
| `docs.google.com/document/d/<id>/...` | `…/document/d/<id>/export?format=pdf`, pages kept, so a cite opens its page |
| `docs.google.com/presentation/d/<id>/...` | `…/presentation/d/<id>/export?format=pdf`, a page per slide |
| `docs.google.com/spreadsheets/d/<id>/...` | `…/spreadsheets/d/<id>/export?format=xlsx`, read as a spreadsheet |
| `drive.google.com/file/d/<id>/...`, `open?id=`, `uc?id=` | `drive.usercontent.google.com/download?id=<id>&export=download`, read by its content type (or its file name) as an upload of that type |
| `drive.google.com/drive/folders/<id>` | nothing: fails with "A folder link can't be read. Add the files one by one, or download the folder and choose it." |

The export is fetched with the same address checks as every link (each
redirect hop checked by its bytes) and the same 25 MB cap as an upload. A
link that answers with a sign-in page or a refusal is a file not shared
with anyone who has the link: the source fails with "This file can't be
read because it isn't shared with anyone who has the link. Share it that
way, or download it and add the file." Neither line names a service. The
source keeps the link the person gave as its `url`; its extraction's
`metadata.drive` says which kind of link it was. Other links on those hosts
(a form, a page published to the web) are read as web pages.

## Voice (Nov 22, 2026; local only)

The voice that speaks videos and audio is set up in the app. It lives in the
scenes service on this computer (`services/scenes/src/voices.ts`, the one list
of voice services); the engine passes each call on through `ScenesClient`
and reads each answer field by field, so nothing the service did not mean to
say reaches the browser. The choice and the key are kept by the scenes
service in a private file on this computer (`SCENES_VOICE_FILE`, `.opensourcebook/voice.json`
under the launcher), written for its owner alone and laid over
`services/scenes/.env`, which keeps working. **A key goes in and never comes
back**: answers say only `keySet` and `keyHint`, its last four characters
(none for a short key), and no log line names it. After a change the engine
reads the scenes service's status again at once, so audio's `ready` and the
video maker's voice notice follow it.

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| `GET` | `/v1/voice` | | `200 VoiceSetup` | `503 voice_unavailable` (no scenes service, or it did not answer) |
| `PUT` | `/v1/voice` | `{ service: string \| null; voice?: string \| null }` | `200 VoiceSetup` | `400 invalid_request`, `400 unknown_voice_service`, `409 voice_needs_key`, `409 voice_not_installed` |
| `PUT` | `/v1/voice/services/:service/key` | `{ key: string }` (1 to 400 characters) | `200 { service: VoiceServiceView }` with `health` | `400 invalid_request`, `404 not_found`, `422 key_refused` (nothing kept) |
| `DELETE` | `/v1/voice/services/:service/key` | | `200 VoiceSetup` | `404 not_found` |
| `GET` | `/v1/voice/services/:service/voices` | | `200 { voices: VoiceOption[] }` | `404 not_found`, `409 voice_needs_key`, `502 voice_service_unreachable` |
| `GET` | `/v1/voice/services/:service/voices/:voiceId/sample` | | `200` audio (`audio/mpeg` or as the service gives), `cache-control: private, max-age=3600` | `404 not_found` |

```ts
interface VoiceServiceView {
  id: string;
  label: string;                    // a voice on this computer says "On this computer"
  where: "hosted" | "local";
  about: string;
  needsKey: boolean;
  keyLabel?: string;
  keyHelpUrl?: string;              // where the person gets a key
  keySet?: boolean;
  keyHint?: string;                 // the key's last four characters, never more
  installed?: boolean;              // local
  install?: { command: string; folder: string };   // local: run once, then GET /v1/voice again
  listsVoices: boolean;
  samples: boolean;                 // it offers a sample of its voices to hear (Nov 23, 2026)
  health?: { ok: true } | { ok: false; trouble: "credits" | "refused" | "unreachable"; message: string };
}
interface VoiceSetup {
  service?: string;                 // absent: no voice, videos without sound
  voice?: { id: string; label: string };
  from: "app" | "env" | "none";
  note?: string;                    // the plain line to show
  services: VoiceServiceView[];     // hosted A to Z, then local; only those offered
}
interface VoiceOption { id: string; label: string; description?: string; language?: string; sample: boolean }
```

- **Samples (Nov 23, 2026).** `sample: true` on a voice means
  `.../voices/:voiceId/sample` plays it: the service's own preview, sent with
  the audio type its bytes say when its storage serves it as another type
  (ElevenLabs' previews come as `text/plain`, which was answered `404`
  before). A service with no previews says `samples: false`, and every voice
  in its list says `sample: false`, so no play button is shown for one.

- `service: null` is no voice: videos are made without sound, captions
  carrying the words, and audio cannot be made. `voice: null` goes back to
  the service's own voice.
- A key the service answers as out of credits is kept (the key is good) and
  `health` says so; a refused key is not kept. A key that could not be
  checked (no answer) is kept with `health.trouble: "unreachable"`.
- `DELETE` forgets the app's key only; a key in `services/scenes/.env`
  still counts. A service chosen in the app with no key left anywhere is
  unchosen.
- A voice on this computer that needs a large download is not installed
  from the app: `install.command` is run once in `install.folder`, and
  `GET /v1/voice` reads `installed` again ("Check again").
- The voice changes at once for what starts next; a video or an audio
  already being voiced keeps the voice it started with.
- `FormatDescriptor.voiced: true` marks the shapes the voice speaks (video,
  audio), so a client shows the voice beside them without naming them.
