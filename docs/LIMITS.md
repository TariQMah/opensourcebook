# What works, and what is rough

What is supported, and how much of it has been run for real.

## Supported agents

Every agent here is supported: Open Sourcebook has the code to run it for the chat and for making things, and if one fails for you that is a bug to report.

| Agent | Chat | Flashcards, quiz, audio and guide | Video | What has been run for real |
|---|---|---|---|---|
| Claude Code (a Claude plan) | ✓ | ✓ | ✓ | Chat, flashcards, quiz and video, end to end. |
| Codex (a ChatGPT plan) | ✓ | ✓ | ✓ | A chat answer with checked cites, and a full video. |
| OpenCode | ✓ | ✓ | ✓ | A chat turn as far as the call to the model. |
| Cursor | ✓ | ✓ | ✓ | Its tests only, against a stand-in for its program. |
| Antigravity | ✓ | ✓ | ✓ | Its tests only. On your Google sign-in it runs once Open Sourcebook's own check of it has passed on your computer. |
| GitHub Copilot | ✓ | ✓ | ✓ | Its tests only, against a stand-in for its program. |
| A model API key (Gemini, DeepSeek, OpenRouter) | ✓ | flashcards and quiz | needs an agent | Not tried for this table. |

Used most with Claude Code and Codex. If an agent fails for you, open an issue and it gets fixed. On a plan alone (no API key), your agent works in a folder of its own with its file tools only: no shell, no web.

**A model API key instead of an agent.** Put a Gemini, DeepSeek or OpenRouter key in `engine/.dev.vars` in the app's folder (copy `engine/.dev.vars.example`; the launcher passes it on). Open Sourcebook then makes flashcards and quizzes and answers the chat with that key. Videos are made by an agent.

## What works where

| | Mac | Linux | Windows |
|---|---|---|---|
| The one-line install | tried in a throwaway home folder against local files, not yet from the public addresses | written, not run on a Linux computer | written, never run |
| Starting it, the web app, answers with cites | works | the four programs start in our automated checks; not tried by hand | not tested yet, help wanted |
| Flashcards and quiz | works | not tried by hand | not tested yet, help wanted |
| Video | works | not tried: needs ffmpeg and Chrome | not tested yet, help wanted |
| Audio | needs a voice (an ElevenLabs or Speechify key, or Kokoro); not available without one | made with Kokoro in our own runs; not tried by hand | not tested yet, help wanted |
| The video voice | your ElevenLabs or Speechify key, or Kokoro (not tried on a Mac yet); without any, no sound | your ElevenLabs or Speechify key, or Kokoro (voiced and rendered in our own runs); without any, no sound | your ElevenLabs or Speechify key, or Kokoro (not tried); without any, no sound |
| The agent's own tools in a sandbox (video work on an API key) | works, using the Mac's own sandbox | not available | not available |
| The video agent reading its job folder (the note, the sources, what was read from them) beside its own folder | read only, inside the Mac's own sandbox, for Claude Code, Codex and Antigravity; OpenCode, Cursor and GitHub Copilot run outside it and get their own folder alone | not available: no sandbox yet, so every agent gets its own folder alone and the sources in its instructions | not available, as on Linux |
| A phone on the same Wi-Fi | covered by tests; not tried on a real phone | same | same |

What the one-line install has and has not been tried on, in full: [`install/README.md`](../install/README.md).

## What it is not, and what is rough

- It is early and made by one person. Expect rough edges, and tell us about them: a good bug report is the most useful thing you can give.
- It is not a hosted service. There is no account and nothing to sign up for.
- Open Sourcebook checks every cite word for word against your sources, and a first test found no wrong fact about a source. But a made thing can still carry a line that is the agent's own reasoning or general knowledge without saying so, so a line with no cite is not from your files. Marking such lines is being worked on.
- Videos are good, not great. They depend a lot on the agent and model: they can be too slow, too busy or just wrong. A bad one is worth a report.
- Twelve styles are offered, but only Chalkboard, Flat illustrated, Editorial ink and Blueprint have been judged on finished videos. The other eight are offered to try, and one that does not hold up will be dropped. Sketchnote and Terminal are in the repo but not offered yet: some pieces still draw words too small or late in them.
- A video takes minutes, and the strongest model takes much longer. A big plan takes a while: your agent does real work for each item.
- A voice needs a key or Kokoro. Without one a video has no sound and audio cannot be made.
- A real phone has not been tried, and Windows is not tested yet (help wanted). Linux is only partly tried.
- Claude Code and Codex are the agents used most. The others are supported and have been run less ([table above](#supported-agents)).
- Video and audio links as sources need the yt-dlp sidecar in `services/ytdlp-sidecar/`, which the launcher does not start; links, PDFs, uploads and pasted text need nothing extra.
- The iPhone app in `ios/` is not part of the install and has not caught up with flashcards, audio and guides. See [`docs/IPHONE.md`](IPHONE.md).
- There is no stand-in mode. If no agent or key can make a thing, Open Sourcebook says what is missing before you start.
