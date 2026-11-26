# A voice

A video's narration and audio need a voice, and a voice needs one of two things: a key for a voice service, or Kokoro, a free voice that runs on your computer. Without either, a video is made without sound on every system and its captions carry the words; Open Sourcebook says so at start, before a video is made and on the video. Audio cannot be made then.

**In the app.** First-time setup has a Voice step, and Settings > Voice picks a service, takes its key once (the page never shows it back, only that one is set and its last four characters), and plays a sample of each voice before you choose. The choice is kept in `.opensourcebook/voice.json` in the app's folder, a private file on this computer, and it wins over `services/scenes/.env`, which still works.

**A key in a file instead.** Put `ELEVENLABS_API_KEY=<your key>` in `services/scenes/.env` in the app's folder (copy `services/scenes/.env.example`).

**A voice with a free allowance.** Speechify is a hosted voice whose free account reads 333,000 to 500,000 characters a month (a few hours of narration), with commercial use allowed, and gives real word times like ElevenLabs. Put `SPEECHIFY_API_KEY=<your key>` in `services/scenes/.env`; with no ElevenLabs key set, it is the voice. `SCENES_SPEECHIFY_VOICE` picks another of its voices (`geffen_32` by default) and `SCENES_SPEECHIFY_MODEL` its model (`simba-3.5` by default). It has been tested with a stand-in for its service, not yet with a real key.

**A voice with no key.** Kokoro needs no key and no account, and nothing you write leaves the computer. It reads English. In Settings > Voice, pick On this computer and press Install it, once: it installs about 600 MB into the app's folder (`services/scenes/voices/kokoro`), the voice model among it, downloaded once from Hugging Face, and takes several minutes. When it is done the screen checks again by itself and Kokoro can be picked (or put `SCENES_VOICE=kokoro` in `services/scenes/.env`). The same install in a terminal is `opensourcebook voice install kokoro`, from any folder. Both use the Node Open Sourcebook runs on, so nothing else needs installing first. `SCENES_KOKORO_VOICE` picks another of its voices (`af_heart` by default; `bf_emma`, `am_michael` and others) and `SCENES_KOKORO_SPEED` its pace (0.7 by default). It sounds less natural than ElevenLabs, and its word times are measured per sentence, so captions can run a little behind the voice. It has been run on Linux; it is built for a Mac and Windows too but not tried there yet. Kokoro's model is under Apache 2.0; what it installs is listed in [`docs/THIRD-PARTY.md`](THIRD-PARTY.md).

(This computer's own voice is there for a quick test only: `SCENES_VOICE=say`, robotic, off unless you set it.)

The app's folder is `~/.opensourcebook/app` after the one-line install, and the folder you cloned into for a clone.

In a clone, `npm run voice:kokoro` in `services/scenes` does the same as the command.
