# Third-party software and fonts

Open Sourcebook's own code is under the MIT licence (`LICENSE`). That licence covers what was written for Open Sourcebook and nothing else: the fonts, the sound files, the map data, the logos and every dependency keep their own terms. This page lists the notable things Open Sourcebook ships in the repo or installs as a dependency, with their licences. It is a guide, not a full list: each package's own licence is the authority, and `npm ls` in a program's folder shows the rest.

## Remotion (videos)

`services/scenes` draws and renders videos with Remotion (`remotion`, `@remotion/bundler`, `@remotion/renderer`). Remotion is **not** under the MIT licence. It has its own licence with two tiers:

- Free for an individual, for a non-profit or not-for-profit organisation, for a for-profit organisation of up to 3 employees, and for anyone evaluating it and not yet using it commercially.
- A for-profit organisation larger than that needs a Remotion company licence to use it, which includes running Open Sourcebook to make videos.

Open Sourcebook being open source does not change this. The terms are Remotion's and can change; read them in [Remotion's licence](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) (also in `services/scenes/node_modules/remotion/LICENSE.md` after install). Remotion's code is not copied into this repo; it is installed from npm.

## Fonts shipped in the repo

Every font a video uses is in `services/scenes/fonts/`, one folder per family, so a video looks the same on any computer. The fonts are not covered by `LICENSE`: all are under the SIL Open Font License 1.1, except Permanent Marker, which is under the Apache License 2.0. Each folder keeps its licence text (`OFL.txt`, or `LICENSE.txt` for Permanent Marker) unchanged beside the files, and a `font.json` naming the family and where it came from. The full list, with the styles that use each, is in `services/scenes/fonts/README.md`.

Archivo Black, Bangers, Barlow, Barlow Condensed, Baskervville, Cabin Sketch, Caveat Brush, Comic Neue, JetBrains Mono, Jost, Libre Caslon Display, Mulish, Patrick Hand and PT Mono (SIL Open Font License 1.1), Permanent Marker (Apache License 2.0), and a cut-down set of Noto Sans, Noto Sans Math and Noto Sans Symbols 2 (`fallback/`, with each one's licence text beside it). The files are taken from the Google Fonts repository; the fallback faces are subsets of the Noto fonts.

The web app also installs Inter through `@fontsource-variable/inter` (SIL Open Font License 1.1).

## Logos

The agent and model-maker logos in `services/agent-connector/src/agents/marks.ts` are each brand's own mark as [Simple Icons](https://simpleicons.org/) draws it (CC0 for the drawing; the trademark stays its owner's), shown unchanged only to say whose agent or model it is. Cursor's is Simple Icons' `cursor` (from cursor.com/brand), GitHub Copilot's is its `githubcopilot` (GitHub's Primer octicon `copilot-24`, MIT), and Google's models carry Gemini's spark, its `googlegemini`, all from Simple Icons 16.38.1; OpenAI's is from its 15.x release. Antigravity's, which Simple Icons does not have, is `antigravity` from [LobeHub Icons](https://github.com/lobehub/lobe-icons) 1.105.0 (`@lobehub/icons-static-svg`, MIT), unchanged. A mark whose owner asks Open Sourcebook not to show it goes back to a plain tile with initials.

## Map data

The map piece (`services/scenes/pieces/map/data.json`) draws countries and cities from [Natural Earth](https://www.naturalearthdata.com/), which is in the public domain. Where it came from, what was changed and a note on disputed borders are in `services/scenes/pieces/map/DATA.md`.

## Dependencies by program

Licences as published by each package when this page was written.

| Program | Package | Licence | Used for |
|---|---|---|---|
| scenes | `remotion`, `@remotion/*` | Remotion licence (above) | Rendering videos |
| scenes | `react`, `react-dom` | MIT | Drawing frames |
| scenes | `katex` | MIT | Maths on screen |
| scenes | `@napi-rs/canvas` | MIT | Measuring text |
| scenes | `unpdf` | MIT | Reading a PDF for the video agent |
| scenes | `@meta-sam/parser` | The SAM License (Meta); read it before use | Cut-outs, only when a `META_API_KEY` is set |
| engine | `@cloudflare/puppeteer` | Apache-2.0 | Reading pages |
| engine | `@mozilla/readability` | Apache-2.0 | Reading pages |
| engine | `linkedom` | ISC | Reading pages |
| engine | `unpdf` | MIT | Reading PDFs |
| web | `react`, `react-dom`, `react-router` | MIT | The app |
| web | `katex` | MIT | Maths on screen |
| scenes | `mediabunny`, `@mediabunny/*` (through Remotion) | MPL-2.0 | Reading and writing video and sound files |
| scenes, web | `caniuse-lite` (through the build tools) | CC-BY-4.0 | Which browsers support what, at build time |
| web | `lightningcss` (through `vite`) | MPL-2.0 | Building the app's CSS |
| engine, web | `@img/sharp-libvips-*` (through `wrangler`, a build tool, not shipped) | LGPL-3.0-or-later | The local Workers runtime's image support |
| all | `typescript`, `vitest`, `vite`, `wrangler` and other build and test tools | MIT, Apache-2.0 or both, unless named above | Building and testing |

Kokoro, the voice that runs on the computer (`services/scenes/voices/kokoro/`), is not part of Open Sourcebook's install: a person installs it from Settings > Voice or with `opensourcebook voice install kokoro`, into its own folder, and it runs in its own process.

| Program | Package | Licence | Used for |
|---|---|---|---|
| scenes (Kokoro, optional) | `kokoro-js` | Apache-2.0 | Running the voice |
| scenes (Kokoro, optional) | Kokoro-82M model (`onnx-community/Kokoro-82M-v1.0-ONNX`, downloaded from Hugging Face at install) and its voices | Apache-2.0 | The voice itself |
| scenes (Kokoro, optional) | `@huggingface/transformers` | Apache-2.0 | Loading the model |
| scenes (Kokoro, optional) | `onnxruntime-node`, `onnxruntime-web` | MIT | Running the model |
| scenes (Kokoro, optional) | `phonemizer` | published as Apache-2.0, but it is eSpeak NG compiled to WebAssembly, and eSpeak NG is GPL-3.0-or-later | Turning words into sounds before the model reads them |
| scenes (Kokoro, optional) | `sharp`, `@img/sharp-libvips-*` (through `@huggingface/transformers`) | Apache-2.0; libvips LGPL-3.0-or-later | Not used by the voice |

eSpeak NG's GPL applies to that package as installed. Open Sourcebook does not ship it, copy it or link it into its own code: the person's own npm install fetches it unchanged, and Open Sourcebook talks to the voice's process only by messages. Anyone who redistributes Open Sourcebook with Kokoro installed in it should read eSpeak NG's licence first.

MPL-2.0 and LGPL-3.0 are used here as unchanged packages from npm; Open Sourcebook changes no file of theirs, so their terms ask nothing more of Open Sourcebook than to keep their licences with them, which npm does.

## Sound

`services/scenes/audio/kit/src/` holds fourteen sound files that videos can use, and `services/scenes/audio/kit.json` names each one with the words it was made from, its length and its level.

| Files | What they are |
|---|---|
| `curious.mp3`, `documentary.mp3`, `focus.mp3`, `tension.mp3` | Four music beds, 60 seconds each |
| `engine-drone-fade.mp3`, `finger-tap.mp3`, `flip-blip.mp3`, `impact.mp3`, `number-tick.mp3`, `paper.mp3`, `pop.mp3`, `sorted-chime.mp3`, `whoosh.mp3`, `wobble-beat.mp3` | Ten short effects, each under two seconds |

- **Source.** They were made once with ElevenLabs's sound and music generation, from the text in `kit.json`, for the owner's earlier video engine, and came into this repository with it. They are not recordings and are not taken from a sound library.
- **Licence.** They are not covered by `LICENSE`. Generated sound is used under ElevenLabs's terms, which depend on the plan it was made under: a free plan allows non-commercial use with credit to ElevenLabs, and a paid plan allows commercial use. Read ElevenLabs's own terms, since they can change.
- **What is not known.** Which plan they were made under is not recorded, and nothing in the files says: they were encoded again with ffmpeg and carry no title, maker or source tag. No receipt or record of the generation is kept here.
- **What to do until it is known.** Treat all fourteen as non-commercial and credited to ElevenLabs. For commercial use, or if you pass Open Sourcebook on to others who may use it that way, replace them: make new ones under your own account from the text in `kit.json`, or put files you have the rights to under the same names. A video made with no sound placed uses none of them.

## Tools Open Sourcebook calls but does not ship

`ffmpeg` (you install it), `yt-dlp` and `faster-whisper` (installed in the optional sidecar image, `services/ytdlp-sidecar/`), and the coding agents themselves (Claude Code, Codex, OpenCode, Antigravity, Cursor, GitHub Copilot), which you install and sign in to under their own terms. Open Sourcebook launches them as they are.
