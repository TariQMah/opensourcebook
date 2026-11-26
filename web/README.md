# Open Sourcebook web Studio

The web app for Open Sourcebook (`docs/VISION.md`): projects, sources, plans
and the players, in the browser. React and TypeScript, built with Vite, hosted
on Cloudflare as static assets (`docs/DECISIONS.md` #32).

Words on screen follow `docs/GLOSSARY.md`.

## Running it

To run all of Open Sourcebook at once, run `npm start` at the repo root (`docs/DEVELOPING.md`): it starts this app with the others, with the shared secrets and ports filled in. It serves the app from a build made once after each update (`vite build` into `.opensourcebook/build/web`: the built pages and the `/api` proxy Worker, run in the local Workers runtime with nothing watched), with the engine's address and token from the launcher, never from `web/.dev.vars`; an edit here changes nothing until the next start, which builds again. **When you work on the web app, start Open Sourcebook with `npm start -- --dev`**: this app runs in `vite` and reloads as you save, and so does the engine. What follows is for working on the web app alone.

Node 24.

```bash
npm install
cp .dev.vars.example .dev.vars   # the engine's client token and URL
npm run dev        # http://localhost:5173, with the /api proxy
npm run lint
npm run typecheck
npm test
npm run build      # dist/
```

For a local engine, run `npm run dev` in `engine/` (port 8787) and set
`ENGINE_URL=http://localhost:8787` and the same `OPENSOURCEBOOK_CLIENT_TOKEN` as
`engine/.dev.vars`.

Everything on screen is made by a real maker: the person's own agent
through the connector, or a model API key on the engine. To see the screens
with something in them, run Open Sourcebook with `npm start` at the root, add a source,
and make a plan; nothing writes stand-in items into the local database. The
tests use their own fixtures (`src/test/`) and never need an engine.

## Layout

```
index.html, src/main.tsx   entry
src/App.tsx                routes
src/app/                   shared state (client, formats, providers), the shell with the top bar (TopBar.tsx) and its two links, the Open on your phone dialog, load hook, the page for a browser that was not let in (OpenGate.tsx), what the browser kept under the old name (oldStorage.ts)
src/api/                   typed client for the Studio API, its types and errors
src/design/                tokens, shared styles and parts (below)
src/screens/               Home (and its new-project dialog), Library, Settings and its sections (settings/), Activity, Inbox
src/firstrun/              first-time setup at /welcome: get set up, providers, voice, try it
src/setup/                 Get set up: what this computer needs, each with the launcher's button that fixes it
src/project/               the project page: top bar, Sources, the chat (mentions, / and @ lists), Make with Made here, the source reader, and the right-panel slot (rightPanel.tsx)
src/make/                  the one make sheet, the Made by box, the maker picker, the style picker, a shape's settings, and the making times
src/plan/                  the plan panel in the right column and the plan card in the chat; planModel.ts holds its logic (stages, branches, reorders, settings)
src/player/                the flashcards, quiz, video, audio and guide players, the one chrome they all wear (chrome.tsx), the block renderer, quiz grading, the spacing rule for cards (`spacing.ts`), the player registry, kept progress
src/thread/                the talk thread on a made thing, and Remake this scene
src/voice/                 voice setup (a service, its key, a voice with a sample) and the voice picker
src/feed/                  the phone: the feed, its order (order.ts, FEED_ORDERS), Settings > Phone
src/sources/               adding sources (files, a folder, YouTube, Google Drive, a link, pasted text) and source wording
src/test/                  test setup, a fake engine (mocked fetch) and sample rows for tests only
worker/                    the same-origin /api proxy (a Worker), and its tests
wrangler.jsonc             Cloudflare config: the app as static assets (SPA fallback), /api/* to the Worker
```

**The name.** The app had an earlier name, and a copy from then keeps working. What the browser kept under `re.` names (the theme, the reminders switch, the audio speed, open threads, a new chat's ticks) is copied once to `opensourcebook.` names when the app loads (`src/app/oldStorage.ts`; `index.html` reads the old theme name until then, so nothing flashes). The proxy reads a setting given under its old `RE_` name as the new `OPENSOURCEBOOK_` one (`withOldNames` in `worker/proxy.ts`), so a person's own `.dev.vars` still works.

## Screens

There is no sidebar. Every top-level page wears one top bar: the mark and name (a link Home), the two links Projects and Library, and search, which follows the link (it finds projects on Projects and what was made in Library). Open on your phone and Settings sit as two plain links at the foot of the page.

| Route | Screen | Uses |
|---|---|---|
| `/` | Home: only the projects grid, and nothing above it. The first card is "New project", a dialog with an optional name and the one source adder (files, a folder, YouTube, Google Drive, a link, pasted text); a name left empty is taken from the first source read. Every project is the same card: a picture of the newest thing made in it, its name and a footer with its source and made counts; its ⋯ menu renames, archives or deletes it (Delete asks, with Archive beside it). While something is made in it, the card's picture carries the making line, an amber dot, the word Making and Stop. Archived projects are listed below. With no projects at all the first finished example in the repo's `examples/` folder is a card too, opened as a project of the person's own (`src/screens/examples.ts`). On a fresh install `/` sends the person to `/welcome` first. No topics and nothing "on its own" (`docs/DECISIONS.md` #46) | projects, project outputs, plans, sources, uploads, projects/import, setup |
| `/welcome/:step?` | First-time setup, four steps: Get set up (one list of what this computer needs, a coding agent, signed in, ffmpeg and a voice, each with what is wrong and a button that fixes it through the launcher: install an agent, start its own sign-in and watch it finish, fetch ffmpeg, set up the free voice and make it the one in use, or a hosted voice's steps to a key; Check again asks everything anew), Providers (connect the coding agents you use, listed A to Z, each with how to install and sign in), Voice (the same voice setup as Settings; skipping it is remembered) and Try it (start a new project, or open the example, with a line on what it holds). It opens on a fresh install and on return resumes at the step left off; the engine keeps whether it is done (`GET` and `PUT /v1/setup`). Everything in it but Get set up is also in Settings | setup, providers, voice, launcher setup |
| `/projects/:id` | Fills the window, under its own slim bar instead of the app's: the mark (a link Home), a back arrow and Projects, then the project's name, which opens a list to switch project or start a new one, and the project's ⋯ menu (rename, archive, delete, asking first). Three columns: Sources, the chat, and the right column, which is Make above and Made here below, and which other views take over (below). On a phone, tabs show one at a time: Chat, Sources, Made. Sources fold to a rail. `?play=<output>` plays a made thing in the right column; `?source=` opens a source beside the chat (`&at=start-end&quote=` marks a cited spot, with the number of the cite it came from); `?plan=` opens a plan in the right column | project, sources, plans, plan views, outputs, chats, skills, make-times |
| `/library` | Everything made, each with its format tile and its size and done tick, as a Grid or a List, with one chip per shape (each with its count) and one search box ("Search what you made"). A thing made at once has a ⋯ menu with Delete…, asking first; one inside a larger plan has none. On a phone `/library` is the feed (below) | outputs |
| `/outputs/:id` | Full screen, the player for its format: flashcards, quiz, video, audio or guide (a storyboard made before that maker was taken out still plays, and says so inside its own frames) | outputs/:id, plan, done, assets (byte ranges) |
| `/settings` | One page with its sections on the left, each opened by its hash: **What makes what** (`#makers`), **Providers** (`#providers`), **Voice** (`#voice`, and `?voice=<service>` opens it on that service), **Phone** (`#phone`), **Reminders** (`#reminders`), **Appearance** (`#appearance`: system, light or dark, kept on this device) and **Advanced** (`#advanced`, set apart at the end: a link to Activity, how this site reaches the engine, the agent connector, the video makers). On a phone it is a list that opens each section on its own page | formats, providers, voice, phone, make-times |
| `/settings/activity` | Activity, from Settings > Advanced ("See what the agents are doing"): small totals for today and the last 7 days (turns, time, tokens read and written), a filter by shape and by project, what is being made now as the `Making` line (its live step, how long so far, its project and the maker picked, with Open), then every finished agent turn as a plain table, newest first: when, what for (opening the chat, the plan or the thing made), agent, model and effort, how long it took, tokens read (and how many from the cache), tokens written, tool calls, how it ended; "Show older turns" pages back. A quiet read again every 4 seconds while something is being made. On a phone each turn is a stacked row said in words ("took 4 min · 12 tool calls"). Says plainly when the connector isn't set up, can't be reached or keeps no log. No money | activity |
| `/feed` | The phone's feed, and what the Library link opens on a phone (a narrow screen worked with a finger). Everything made in every project, one thing per screen, filling it; the bar above names which projects it holds, all of them or one (`/feed?project=<id>`). Scroll down for the next, through a set of flashcards one card at a time or sideways through a quiz's questions, a quiz answered in place, a video playing muted when it comes into view until a tap turns the sound on; it plays inside the same player chrome as the computer's. Under each: its title, its project and plan, its sources (a cite opens the passage), and Ask. Order: one function from `FEED_ORDERS` (`src/feed/order.ts`); the one there is `dueFirst`: sets with cards due again first, then unfinished things, the newest plan first, each plan in its own order, finished things after. Where the person stopped is kept on the engine (`POST /v1/plans/:id/items/:itemId/progress`), so the desktop players open at the same place. When the computer can't be reached it says so and tries again by itself; a device that was unpaired is told to scan the code again | outputs, projects, plans, outputs/:id, done, progress |
| `/inbox` | Unfiled sources, one row each, with "File to project". Nothing links to it any more (the menus no longer show it, and a source's menu does not offer Move to the Inbox); the route and the engine's inbox remain, so an older link still opens | inbox, sources/:id/file, sources, uploads |
| `/plans/:id`, `/sources/:id`, `/projects` | Old links: a plan or a source opens in its project, and `/projects` goes Home | plan, source |

On a phone Home shows the projects and the Library link is the feed; a project's tabs are Chat, Sources and Made, and Settings is a list. A sheet in the right column rises from the bottom over one dimmed page.

**The project page's right column** shows Make and Made here until something else is opened in it. It is a slot (`src/project/rightPanel.tsx`): the make sheet, the plan panel, a new plan and other parts register a view there from their own folder, and the page draws whichever is open without naming it; Back returns to Make and Made here. The column is wider while a make sheet or a plan is open and the chat gives up the room. **Make** is one tile per shape from the format registry (`GET /v1/formats`) and a row for Plan a whole subject. **Made here** is every thing made or being made in the project, in the feed's order: each row is one `Making` line while it is made, and a card with Play (things to watch or go through) or Open (things to read, and plans) once made; every row has a ⋯ menu that deletes it, asking first for a made thing or a plan, and failed or stopped things can be cleared together with one line at the foot. A video that has one scene being made again shows that under its row, with Stop or Try again, and the new video takes the old one's place.

**One make sheet** (`src/make/`) makes any shape. A tile, a chat proposal and a plan item each open it in the right column, already filled in, and nothing is made until its button is pressed ("Make the video"); closing one with something changed asks before throwing it away. It has the sources it reads (outlined chips with a × to take one out, and + Add), the shape's own settings (two short ones share a row; a choice of up to four options is a switch, a longer one a list; a number is Auto or Custom; the style is picked by picture), and the **Made by** box: Made by, Reviewed by (where the shape offers one) and Voice, each a row that opens a picker, with how long that pick usually takes ("no time yet" when it has not run on this computer; nothing is estimated). A pick made here is for this one thing and never changes a default. With no agent set up the sheet says so, with Set one up, and its button stays off.

**The plan panel** (`src/plan/`) is a plan in the right column: before Start, a tick, a maker and a time per item and one Start; while it runs, one progress line per item and Stop all, and each item being made has its own Stop (a stopped one says Stopped, with Go on); once stopped, Resume and a new maker for what is left. "Change for all" sets the maker of every item not made yet. Plan a whole subject is a sheet in the same column that asks the chat for the plan. In the chat a plan is a small card (its title, where it stands and Open) and the panel is where it is changed; the days of a stage, what is due and "Move the days on" for a missed day are in the panel and the plan card.

**The players' one chrome** (`src/player/chrome.tsx`) is worn by every player, on the computer, in the Studio and in the phone's feed: back, title, talk, done, full view and a thin progress line, with each player's own tools and segments handed to it. Scroll and the arrow keys go on to the next thing, and a plan ends on an end card. A player in the project's right column starts right under the bar.

**The talk thread** (`src/thread/`, "Talk about this") opens on a made thing, beside it or as a sheet over it on a phone, at the spot the person is at. On a video it also offers **Remake this scene**, for the scene playing when the thread was opened, with the last message as the note; the new video is made as the item's, shown being made with Stop or Try again, and the old one plays until the new one is ready.

**Settings' sections.** *What makes what* is a table of the chat and every shape: Made by, Reviewed by, Voice and Usually takes, each cell opening a picker, with "Use one for all". These are the only place a default is set: a make sheet or a plan item changes one thing. *Providers* lists the agents A to Z (no provider is preferred) with how to connect each; with several ready and none picked the app asks which one. *Voice* is the voice setup: a service, its key (sent once and shown only as set, with its last four characters), the voices with a sample, and for one that runs on this computer its install command. *Phone* turns Open on your phone on and off, shows the pairing code and lists the paired devices with Remove. *Reminders* turns the browser's reminders for days given to stages on and off. *Appearance* picks the theme. *Advanced* is for whoever runs it. The voice picker (`src/voice/`) is the same choice as a small popover from What makes what and the make sheet: a ready service is picked on the spot, another goes to Settings to be set up.

**The chat** is a saved conversation (`engine/docs/api.md`, "Chats"); the
menu at its top lists the project's chats and starts a new one, which is
saved with its first message. A message goes to the engine with the ticked
sources and its @-mentions (sources, plan items, plans, past chats, what is
playing); a mentioned source becomes ticked, and the Sources panel follows
the open chat's ticks. The reply arrives whole as pieces drawn in order, each
kind by its view in `src/project/pieces.ts`: text with a numbered chip per
citation (a chip opens the source beside the chat with the cited passage, and
its quote, marked), a plan card, a make proposal (a quiet row that opens its
make sheet again), a question whose options answer back as the next message
(one single-pick question sends on a click; otherwise picks wait for "Send
answers"; typing an answer always works), a mind map and a teach-back verdict.
A kind the app does not know is shown by its text, or a note that it can't be
shown yet. Commands such as `/video` and `/plan` come from `GET /v1/skills`, grouped make, plan and chat; **a thing asked for in
the chat opens its make sheet** and is made only when the person presses
the sheet's button. Under the box is who answers (the model chip; it says it is
looking while providers load, "Couldn't reach the engine" with Try again when they
can't be read, and Set up a provider when there are none) and, when the agent
connector can't be reached, a banner with Check again. A chat shows only what
was said and made in it, so a new chat is empty.
No screen shows money (`docs/DECISIONS.md` #45): Start is just Start. The
engine still records what every call costs.

## How the browser reaches the engine

Every engine route needs the shared client token (`x-client-token`). That
token must never be in browser code, so the browser never calls the engine:

```
browser ── /api/v1/... (same origin) ──▶ worker/proxy.ts ── /v1/... + x-client-token ──▶ engine
```

- `src/api/client.ts` calls only `/api/v1/...` on the app's own origin.
- `worker/proxy.ts` runs on Cloudflare in front of the static assets
  (`run_worker_first: ["/api/*"]`). It adds `x-client-token` from the
  `OPENSOURCEBOOK_CLIENT_TOKEN` secret, forwards to `ENGINE_URL`, and passes back the
  engine's status and body. It forwards only the headers the engine reads
  (content type, upload filename, idempotency key), never cookies, replaces any
  token the browser sends, and refuses writes whose `Origin` is another site.
- Locally, `npm run dev` runs the same Worker in the Workers runtime through
  `@cloudflare/vite-plugin`, which reads `OPENSOURCEBOOK_CLIENT_TOKEN` and `ENGINE_URL`
  from `.dev.vars` (git-ignored; copy `.dev.vars.example`).

- `/api/phone/...` goes to the launcher's phone control (`cli/phone.ts`) the
  same way, with its own token (`PHONE_URL`, `PHONE_TOKEN`, set by `npm start`):
  Settings > Phone turns "Open on your phone" on and off, shows the pairing
  code and lists paired devices.

**Who the proxy serves.** Under `npm start` it serves the engine only to the
browser the launcher let in (a per-run key in a cookie scripts cannot read,
set by `/api/open` with a one-time code the launcher made and this proxy checks
with it; `opensourcebook open`, or `npm run open` in its folder, makes another), to what the launcher's door passes on
from a paired phone (marked with the door's per-run key, and never allowed
`/api/phone`, however the path is spelled), and to a caller that already holds
the engine's token. Anyone else gets 401 `not_opened`, and the app shows a page
that says how to open Open Sourcebook: first what to do without a terminal (start it again, and it opens the right page), then the command (`src/app/OpenGate.tsx`). An opening address that was used or ran out gets the same words on a plain page of its own. On your own computer the dev server listens on
127.0.0.1 only. A phone on the home network reaches it only through the
launcher's door (`cli/door.ts`, `docs/PHONE.md`), which lets in
only devices paired with a one-time QR code and checks the Host, the Origin
and the path. It is plain HTTP on the home network. A web app run alone
(`npm run dev` here, with `OPENSOURCEBOOK_BROWSER_GATE=off` from `.dev.vars.example`)
serves anyone who reaches its port. Before
the site is exposed anywhere else, put it behind a login gate (Cloudflare
Access on its hostname). Sign-in is still an open decision; until it is settled the app has no
login screens of its own.

## Design system

`src/design/` is the app's design system and the one source of truth for the
app:

- `tokens.css` holds the tokens (locked Nov 10, 2026), and the same
  design in the dark: a second set of colours under `data-theme="dark"`,
  which `theme.ts` (and a few lines in `index.html`, so nothing flashes) sets
  from Settings, following the device by default. Screens use tokens for every
  colour (`--inverse`, `--ink`, `--edge` and the rest), never a fixed one.
  The source reader's page is paper in both themes, light with dark ink
  (`--paper`, `--paperInk`, `--paperMark` for a cited spot and the rest), so
  a source reads like a page; `--scrim` dims the page under a sheet or a
  dialog, and `--dangerBorder` edges a row that failed.
  `tokens.test.ts` checks text against its background in both themes. Inter
  is bundled (`@fontsource-variable/inter`), not loaded from Google Fonts.
- `components.css` holds the shared pieces
  (shell, nav, badge, buttons, card, chip, segmented control, bar, checkbox)
  and the page styles the screens repeat (headings, fields, notices);
  `parts.css` styles the parts the redesign added (below).
- `Mark.tsx` is the Open Sourcebook mark: a violet rounded tile with a white
  open book and an amber dot under the spine, drawn from tokens (`--primary`,
  `--onPrimary`, `--logo-dot`) so it follows the theme. `Logo` in `ui.tsx` is
  the mark with the name beside it (the mark alone inside a project); the
  favicon and the app icon are the same drawing.
- The shared parts, each used by more than one screen: `Making` (the one
  progress look: an amber dot, the status words, a thin line and one Stop, in
  the five states waiting, making, stopped, failed and done, as a row or as a
  tag on a picture), `AutoCustom` (Auto, or Custom with a number within its
  limits), `Sheet` (the make sheet's frame: back, tile, title, a body that
  scrolls and a foot with Cancel and one filled button, rising from the bottom
  on a phone), `PickRow` (one row of the Made by box: the mark, the choice and
  how long it usually takes), `RowMenu` (the ⋯ at the end of a row and its small
  menu, placed against the window so a list never clips it) and the buttons
  (`Buttons.tsx`: the outlined pill for Play, Open and Stop, and the filled
  pill for "Make the video").
- `icons.ts` is the line icon set.
- `ProviderMark` draws an agent's or a model maker's own logo, as the engine
  passes it on from the agent's adapter; one with none gets its initial on a
  tinted tile.
- `GlimpseFace` is a made thing's picture wherever it is listed: a frame of
  its video, else what it says first on its format's colour, from the
  `glimpse` the engine's format registry writes; `thumb` draws it small for
  a list row.
- `FormatBadge` draws a format from the descriptors `GET /v1/formats` serves:
  label as written, colour slot (`--fmt-N-*`), icon by name. Aliases resolve;
  an id no descriptor knows keeps its text on the neutral slot 8. Nothing in
  the app lists formats.

## Deploying

Not done yet. When it is:

1. Put the hostname behind Cloudflare Access first.
2. `npx wrangler secret put OPENSOURCEBOOK_CLIENT_TOKEN` (the engine's token) and set
   `ENGINE_URL` as a variable (`--var` or the dashboard) to the deployed engine.
   Set `OPENSOURCEBOOK_BROWSER_GATE=off` too: there is no launcher to let a browser in, so
   the login gate in step 1 is what keeps others out. Without either the proxy
   serves nothing.
3. `npm run build`, then `npx wrangler deploy` from this folder. The build
   writes `dist/` with the config Wrangler reads; it publishes as the `re-web`
   Worker (the name it had before the app was called Open Sourcebook, kept because the launcher finds a
   build by the one Worker folder in it, and that folder is named after the Worker).

`.github/workflows/web.yml` runs lint, typecheck, tests and the build on every
push that touches `web/`.
