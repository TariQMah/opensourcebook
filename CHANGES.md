# What is new in Open Sourcebook

The newest first. `opensourcebook update` prints the lines here that your copy did not have yet, so each line is written for a person using Open Sourcebook: what they can now do or will notice, in a sentence. How to add one is in `CONTRIBUTING.md`.

## 2026-11-26

- Settings > Backups saves every project in one file, with its sources, chats, plans and everything made, videos included, and restores it here or on another computer. A project you have already is never changed unless you choose: keep both, or replace yours. Files of a linked folder stay where they are; the backup keeps where they were.
- Home can keep your projects in folders: make one with New folder, put a project in it from its menu with Move to folder, and search inside it. Deleting a folder puts its projects back on Home and deletes none.
- Open Sourcebook no longer slows your computer down while it reads a web page, and videos play without pausing every few seconds. The engine had kept trying to download a whole browser (about 150 MB) in the background, and every video seek read the whole video file again; now pages are read without that browser and a video sends only the part being played. Run `opensourcebook update` to get it.

## 2026-11-24

- Videos work on a copy installed with the one-line install. Before, every video failed at once with "Something went wrong while making this video", because the folder a video is made in sits inside `~/.opensourcebook` and was refused. Run `opensourcebook update` to get it; if you had set `SCENES_DATA_DIR` to get around it, you can keep it or take it out.
- Videos have more styles to pick from: twelve instead of four, among them Comic, Neon, Whiteboard, Collage, Kinetic type, Textbook plate, Map and timeline and Documentary. Each shows its picture when you choose.
- The iPhone app's code is now in one folder, `ios/`, under the name Open Sourcebook. If you build the app yourself, open `ios/OpenSourcebook.xcodeproj`, and move your own `Config/Local.xcconfig` to `ios/Config/Local.xcconfig`. Its ids did not change, so a build installs over the app you have.
- The name is now Open Sourcebook everywhere, not only in the web app. You have nothing to do: your projects, sources, paired phones, voice and settings are found as they are. The folder that keeps them inside your copy, `.re`, is renamed to `.opensourcebook` once, the first time you start after updating.
- The command is now `opensourcebook`, with no short form. `npm start` works as before. If you made `re` a command with `npm link`, run `npm link` once more in the folder to get `opensourcebook`; the `re` you already have keeps working until you remove it.
- Settings you wrote yourself under the old names (`RE_...` in an `.env` or `.dev.vars` file or in your shell) are still read. New files use `OPENSOURCEBOOK_...`.
- If you installed the skill for your own agent, run `opensourcebook skill install` once more: it takes away the old copy it wrote and puts the new one in its place.
- The licence is now MIT (it was Apache 2.0). The fonts, Remotion and the other things it ships or depends on keep their own licences, listed in `docs/THIRD-PARTY.md`.

## 2026-11-23

- The web app is redesigned and shows the name Open Sourcebook. Home is only your projects; a fresh install opens first-time setup (connect your agents, give videos a voice, try it); a project has Sources, the chat, and Make with Made here; on a phone Home shows your projects and Library is the feed.
- Every way of asking for one thing, a tile, a word in the chat or a plan item, opens the same make sheet, filled in, and nothing is made until you press its button. If you used to type `/quiz ...` and have it made at once, the sheet now opens first; `opensourcebook make` in a terminal still makes at once.
- Settings > What makes what is the one place for defaults: who answers the chat, who makes and who reviews each shape, and the voice. Picking something on a make sheet or a plan item now changes only that one thing and no longer becomes the next default.
- Nothing is preferred. Agents are listed A to Z, and when several are ready and none is picked, the app asks which one instead of choosing, and makes nothing until you pick.
- Each pick says how long it usually takes, from runs on your computer with the same agent, model and effort, and says "no time yet" when there are none, never a guess.
- The voice is set up in the app (first-time setup or Settings > Voice): a service, its key (kept in `.opensourcebook/voice.json`, never shown again but its last four characters) and a voice with a sample. It wins over `services/scenes/.env`, which still works.
- On a video's talk thread, Remake this scene makes one scene again from a note of yours, and the new video takes the old one's place.
- A made thing or a plan can be removed from Made here or the Library (it asks first), and one item of a running plan can be stopped while the rest goes on.
- Sources can be a whole folder or a Google Drive, Docs, Slides or Sheets link shared with anyone who has the link.
- The database gains new tables the first time Open Sourcebook starts after updating; your projects are kept.
- `opensourcebook makers` shows who answers the chat and who makes and reviews each shape, and `opensourcebook makers set`, `set-all` and `review` pick them; when several agents could do something and none is picked, Open Sourcebook says which thing needs a pick and the command that sets it.
- Starting Open Sourcebook no longer installs packages again just because the files are new (a fresh checkout), and it never installs into a `node_modules` that is a link to another folder.
- While a video's scenes are drawn, the step says "Drawing scene 3", and "of 5" only once the video is put together whole.
- Settings > Advanced > See what the agents are doing opens Activity: what is being made right now with its live step, and every agent turn with what it was for, how long it took, its tokens read and written and its tool calls, with totals for today and the last 7 days.

## 2026-11-22

- Projects now fill the full width under a top bar with Projects, Library and search, with a plus card in the grid to start a project from files, a link or text.
- Videos default to a balanced work model at high effort while chat and quick makers stay fast, and you can pick and remember the agent, model and effort for any video with rough time and plan usage shown.

## 2026-11-21

- Every agent turn now appends its token counts, cache tokens, reported cost, duration and tool calls to `.opensourcebook/logs/usage.jsonl`.

## 2026-11-20

- The chat's model picker and Settings show each agent's real logo (Claude Code, Codex, OpenCode), and each model shows the logo of the company that made it, such as Anthropic, OpenAI or Google.
- A quiz can be a practice exam: give it a time limit and the format your real exam has, in your own words, and it is written to match. It opens on a Start screen, counts down, ends as it stands when the time runs out, and gives your mark with a breakdown by topic.
- A quiz can now ask you to put things in order, match pairs, fill in the gaps of a worked solution, draw a line on a graph, or name the marked parts of a picture from your sources. Pick which kinds a quiz uses in its settings; `opensourcebook quiz show` and `opensourcebook quiz answer` take them too.
- Flashcards can now ask you to name the marked parts of a picture from your sources, or to draw a line on a grid, and the card marks itself by your answer.
- Give a plan's stages days: say "quiz me on this by Friday" or set a day on a stage, and Home lists what is due today, this week and what you missed. Missed a day? One press moves the days on from today. Turn on reminders in Settings to get a notification while Open Sourcebook is open.
- A new thing to make: a **guide**, a page or a few of notes from your sources with a cite at every claim. Print it, or change any point, heading or section yourself; a point you change keeps the original words so you can put them back. Ask for one with `/guide` in the chat, from the Studio, or `opensourcebook make guide`.
- Videos and audio can have a voice from Speechify, whose free account reads a few hours of narration a month: put `SPEECHIFY_API_KEY` in `services/scenes/.env`. An ElevenLabs key, when set, still wins.
- Videos and audio can have a voice with no key: Kokoro, a free voice that runs on your own computer and sends nothing anywhere. Run `npm run voice:kokoro` in `services/scenes` once, then set `SCENES_VOICE=kokoro` in `services/scenes/.env`. It is less natural than ElevenLabs.

## 2026-11-19

- `npm run update` (or `opensourcebook update`) gets the newest version of Open Sourcebook, installs again only what changed, restarts Open Sourcebook if it was running and says what is new. Your projects stay as they are.
- Open Sourcebook says at start, in one quiet line, when a newer version is out.
