// Fetches Kokoro's model once, when it is installed (npm's postinstall), the same model and precision src/kokoro.ts
// speaks with. While it downloads it prints how far it is, in bytes over every file it has started so far, as lines
// `progress {"loaded":n,"total":n}`, at most a few a second; the launcher reads them to show a bar (cli/voice.ts).
// Already fetched, it prints none.
import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";

const files = new Map();
let last = 0;
function say(force) {
  const now = Date.now();
  if (!force && now - last < 250) return;
  last = now;
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  if (total > 0) console.log(`progress ${JSON.stringify({ loaded, total })}`);
}

await KokoroTTS.from_pretrained(MODEL, {
  dtype: DTYPE,
  device: "cpu",
  progress_callback: (p) => {
    if (p.status !== "progress" || !p.file || !(p.total > 0)) return;
    files.set(p.file, { loaded: Math.min(p.loaded ?? 0, p.total), total: p.total });
    say(p.loaded >= p.total);
  },
});
say(true);
console.log("Kokoro is ready. Pick it in Settings > Voice.");
