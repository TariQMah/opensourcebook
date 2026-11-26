/**
 * `opensourcebook voice install <voice>`: installs a voice that runs on this computer (cli/voice.ts) with the Node this
 * command runs on, so it needs no npm of the person's own. Works whether Open Sourcebook is running or not; a running
 * one sees the voice at its next check (Settings > Voice).
 */
import { join } from "node:path";
import { installVoice, localVoices } from "../voice.ts";
import { Problem, type Group } from "./table.ts";

export const voice: Group = {
  thing: "voice",
  aliases: ["voices"],
  about: "the voices that run on this computer, with no key",
  commands: [
    {
      thing: "voice",
      action: "install",
      summary: "install a voice that runs on this computer (it downloads a few hundred MB, once)",
      args: [{ name: "voice", help: "which one: the folders in services/scenes/voices (kokoro)" }],
      shape: "{ voice: string, installed: true, log: string }",
      more: "Uses the Node this command runs on, so no npm of your own is needed. When it is done, pick the voice in Settings > Voice.",
      async run(ctx) {
        const id = ctx.args.voice!;
        const known = localVoices(ctx.root);
        if (!known.includes(id)) throw new Problem("not_found", `"${id}" is not a voice that runs on this computer. ${known.length ? `There is ${known.join(", ")}.` : "There are none in this copy."}`);
        ctx.progress(`Installing ${id}. It downloads a few hundred MB once, so this can take several minutes.`);
        let last = 0;
        const result = await installVoice(ctx.root, id, join(ctx.home, "logs", `voice-${id}.log`), {
          env: ctx.env,
          // A sign of life now and then, not npm's every line.
          onLine: () => {
            if (Date.now() - last < 15_000) return;
            last = Date.now();
            ctx.progress("Still installing...");
          },
        });
        if (!result.ok) throw new Problem("install_failed", `${id} did not finish installing. What it said is in ${result.log}. Run this again to try once more.`);
        return { data: { voice: id, installed: true, log: result.log }, text: `${id} is installed. Pick it in Open Sourcebook in Settings > Voice.` };
      },
    },
  ],
};
