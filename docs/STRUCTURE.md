# Where things live

One page on how the repo is laid out and how to add to it. If you are adding a style, a piece, a skill, a pack or an agent, this is the page to read first. `docs/GLOSSARY.md` has the words, `docs/DECISIONS.md` has why.

## The four programs

Open Sourcebook runs on your own computer as four small programs. One command at the repo root starts them together (`cli/`).

| Folder | What it is | Talks to |
| --- | --- | --- |
| `engine/` | The engine. Holds projects, sources, plans and everything made. Checks every cite word for word | the web app, the phone, the connector |
| `web/` | The web app. Also the Mac app: the same page opened by the launcher | the engine |
| `services/agent-connector/` | Runs your own agent (Claude Code, Codex, OpenCode, Antigravity, Cursor, GitHub Copilot) for a chat turn or a piece of work, and hands it Open Sourcebook's tools | the engine, the scenes service |
| `services/scenes/` | Makes drawn videos (the scene language, the pieces, the styles, the render of the file) and voices audio; the voice and the sound are shared by both | the connector, the engine |

`ios/` is the iPhone app. `desktop/` is the desktop app: the web app in its own window, which starts and stops the four programs and keeps them up to date, with the programs and the person's data in the app data folder (`desktop/README.md`). `docs/` is the documents. `cli/` is the launcher and the `opensourcebook` command, and the door a paired phone opens the web app through (`cli/door.ts`): the only part of Open Sourcebook that listens beyond this computer, and only when the person turns the phone on.

## The six things you can add

Each kind has one home and one way in. Nothing outside that home names a single style, piece, skill, pack or agent: the rest of Open Sourcebook reads the list.

| What | What it is | Where it lives | How you add one |
| --- | --- | --- | --- |
| **Style** | The look of a video: colours, fonts, motion, and what it suits | `services/scenes/styles/<name>.json`, its fonts in `services/scenes/fonts/` | One JSON file. It is listed, described to the agent and offered in the app by being there, unless it says `"offered": false` (kept, and still drawing videos that name it, but not offered to choose). A font not yet shipped is one folder in `fonts/`: the open-licensed files, their licence and a `font.json` naming the family |
| **Piece** | A ready-made thing the agent can put on screen, such as a number line, a timeline or a sorting animation | `services/scenes/pieces/<name>/`. Pieces that compute their steps (sorting, graphs, matrices) are kits in `services/scenes/engine/kits/` | One folder with the piece, one line on when to use it, and one built scene that uses it. Data it draws from (a map's outlines) sits beside it as `data.json`, with where it came from and its licence. A kit is one file and one entry in `kits/index.ts` |
| **Skill** | Knowledge the agent reads when it needs it: how to make a video, how to teach, how to use the command. Knowledge, never rules | `skills/<name>/SKILL.md` with `references/` beside it. The video skills are in `services/scenes/skills/` | One folder. The first lines of `SKILL.md` say what it is for, and the agent finds it by that |
| **Pack** | A bundle for one kind of work, such as exam prep: its skill, its pieces and one finished example | `packs/<name>/` | One folder holding a skill, any pieces of its own, and an example |
| **Agent** | A coding agent Open Sourcebook can run as yours | `services/agent-connector/src/agents/<name>.ts` | One adapter file and one line in `registry.ts` |
| **Example** | A finished project kept because it is good: the sources, what was made, the scene files | `examples/<name>/` | One folder. Only kept when it is good enough to show |

Inside the engine the same rule holds for what Open Sourcebook makes:

| What | Where it lives | How you add one |
| --- | --- | --- |
| **Shape** (video, flashcards, quiz, audio, guide) | `engine/src/engines/<shape>/` | Rare: a shape is a new way of holding a thing (watch, swipe, check, listen, keep), decided by the owner. Most new variety is a maker or a kind. The steps are below |
| **Video maker** | `engine/src/engines/video/`, registered in `makers.ts` | One maker module and one registration |
| **Kind of card** in flashcards | `engine/src/cards/kinds.ts` | One entry. The player draws a card from its sides, with nothing per kind |
| **Kind of quiz question** | `engine/src/engines/quiz/kind/<name>.ts`, listed in `default-kinds.ts` (the registry and the first two kinds are in `kinds.ts`) | One file and one line in the list; on the web, one piece in `web/src/player/quiz/` with one entry in its `pieces.tsx`, and its grading as one entry in `quizGrade.ts` (both graders are tested on `kind-cases.json`) |
| **Kind of block** in a chat reply | `engine/src/chat/blocks.ts`, drawn in `web/src/project/pieces.ts` | One entry on each side |
| **Voice** | `services/scenes/src/voice.ts` and the voice files beside it | One file. A voice must give a time for every word |

## Adding a shape

Audio was the first shape added after the registry was built, and these are the steps it took. Everything not on this list (the chat's `/<shape>` command, the Studio tile and its form, the settings form on a plan item, plan sizes, the feed, the Library's glimpse, threads, `opensourcebook make <shape>`) comes from the registry and needed no line naming the shape.

1. **Its home**, `engine/src/engines/<shape>/`: the payload (`contract.ts`, with its contract doc in `engine/docs/<shape>.md`), its settings (`settings.ts`: parse, defaults), its definition (`definition.ts`: the descriptor with `label`, `plural`, `singular`, `colorSlot`, `icon`, `about` for the planner, `blurb` for people, and `settings`; then `parseSettings`, `settle`, `describe`, `describeMade`, `glimpse`, `size`, `describeAnchor`, and `unavailable` when it needs something on the computer that may not be there), its makers (in the shape of `engines/makers.ts`), and its anchor.
2. **Register it**: one line in `engine/src/studio/default-registry.ts`, and one entry in `engine/src/wiring.ts` that hands its makers what they need (the agent connector, a local service).
3. **A player**: `web/src/player/<Shape>Player.tsx` and one entry in `web/src/player/registry.tsx`; an icon in `web/src/design/icons.ts` when the descriptor names a new one.
4. **What its maker knows**: a skill in `skills/<name>/`, and one line per file in `engine/src/chat/agent/work-skills.ts`, the list the engine bundles.
5. **What the planner knows**: a line or two in `skills/planner/SKILL.md` on what it is for beside the others. The planner's facts (settings, readiness) come from the descriptor.
6. **Words**: `docs/GLOSSARY.md`, and a row in `docs/DECISIONS.md`.
7. **The phone** (Swift) learns the format from `GET /v1/formats` like the others; it needs only a player of its own.

## Rules that keep it addable

- **Read the list, never name the member.** Code outside a kind's home must not mention one style, piece, skill, pack, agent, maker or kind by name. It asks the registry or reads the folder.
- **A thing describes itself.** A style says what it suits, a piece says when to use it, a skill says what it is for. The agent and the app show those words. Nobody keeps a second list.
- **Knowledge, tools and what it can see.** The agent is given skills to read, tools to call and pictures of its own work. No rules, gates or critic passes on it, and no examples tied to one topic.
- **Nothing hardcoded that the content should decide.** Lengths, counts, styles and shapes come from the sources and the person.
- **Each program has its own tests and its own check.** A change that breaks video shows red on the pull request that made it.

## Where a change goes

| You want to | Touch |
| --- | --- |
| Change what the app looks like | `web/src/design/`, `web/src/screens/` |
| Change how a chat turn or a plan is written | `engine/src/chat/` |
| Change how flashcards or a quiz are made or checked | `engine/src/engines/flashcards/`, `engine/src/engines/quiz/`, `engine/src/cards/` |
| Change how a video is drawn | `services/scenes/engine/` |
| Change what the video agent knows | `services/scenes/skills/` |
| Change what a video's job folder holds (its note, sources, what was read from them) | `services/scenes/src/folder.ts`, and [`docs/JOB-FOLDER.md`](JOB-FOLDER.md) first |
| Change what the planner knows (who Open Sourcebook is for, how big a plan is, how to write a brief) | `skills/planner/` |
| Change what an agent may do on the computer | `services/agent-connector/src/box.ts` |
| Add a command | `cli/commands/` |
| Order the phone's feed another way | `web/src/feed/order.ts`: one more entry in `FEED_ORDERS` |
| Change who may open Open Sourcebook from the home network | `cli/door.ts`, `cli/pairing.ts`, `cli/devices.ts` |
| Record a lasting decision | A new row at the end of `docs/DECISIONS.md` |

Some folders in the tables above are made by work that is still under way. The layout is settled here first so that work lands in the right place.
