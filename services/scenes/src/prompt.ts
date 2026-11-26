/**
 * What the agent is told for one video: what the work is, the few things Open Sourcebook itself needs, the skills (`skills/`), and,
 * whole, the skills' pages that bear on every video (src/knowledge.ts): what viewers notice, teaching, how an Open Sourcebook video
 * is made, the shelf and the scene language. It is added to the agent's own instructions rather than replacing them,
 * so the agent works as it always does. The rest of the skills (depicting, the cookbook, media and the worked
 * references) are files it opens when it wants them. Then the turn's prompt: the video asked for and its passages.
 */
import { languagePrompt, leansText } from "../engine/language/author.ts";
import { themeFrom } from "../engine/render/theme.ts";
import { sceneBuildOptions } from "../pipeline/stages/scene.ts";
import type { ExtraSkill, VideoRequest } from "./request.ts";
import { estimate } from "./voice.ts";
import { emptyToolbox } from "../engine/language/toolbox.ts";
import { extraSkills, skillFiles, skillIndex, type ForVideo } from "./skills.ts";
import { GIVEN_PAGES, knowledgeText, type Knowledge } from "./knowledge.ts";
import { sceneProject } from "./scene.ts";
import { allStyles, styleFile, type Style } from "./styles.ts";
import type { Draft } from "./tools.ts";

/** Who answers for a depicted thing in Open Sourcebook: the agent itself, in write_beat. */
const DEPICTER = 'Here you are the depicter: when a beat draws a thing that is not depicted yet, write_beat tells you what the depicter is asked, and you send its spec in depictions with the beat (the make-a-video skill, references/depicting.md).';

/** The scene language's whole guide (the engine's `languagePrompt`), filled in for this style and frame. */
export function languageGuide(request: VideoRequest, style: string): string {
  const scene = { id: "s1", narration: "one two three", onScreenText: [], visual: "", cites: [] };
  const opts = sceneBuildOptions(sceneProject({ title: request.title, idea: "", brief: request.brief, style, frame: request.frame, scene, timing: estimate(scene.narration) }), {}, emptyToolbox());
  const guide = languagePrompt(opts, { depicter: DEPICTER })
    .replace(/^You make the visuals[^\n]*\n\n/, "")
    .replace(/\nWrite the scene for the request below\.[^\n]*\n?$/, "\n");
  return `# The scene language\n\nThis guide was written for a writer who returns one scene as text. In Open Sourcebook each beat's scene is its own source, sent with write_beat, with that beat's own word numbers (@0 is its first word) and its pauses as holds (@h1, @h1.end). The abilities it describes are the engine's.\n\n${guide}`;
}

/** What is written into the skills for this video. */
export const forVideo = (request: VideoRequest, style: string): ForVideo => ({ language: languageGuide(request, style), extra: request.skills });

/** The pages given whole with the instructions (src/knowledge.ts): the video they are written for, and its style. */
export interface GivenKnowledge extends Knowledge {
  video: ForVideo;
}

/** The skills' files that are not given whole: to open when one would help. */
export const notGiven = (video: ForVideo): string[] => skillFiles(video).filter((f) => !GIVEN_PAGES.includes(f));

/**
 * The instructions for a video's turn: the work, what Open Sourcebook needs, where the skills are, and what the agent's own tools can
 * do in its folder, as the connector offered it: `files` its file tools only, `full` also its shell and the web
 * (`true` is `full`, as before), none without a folder. With `knowledge`, the skills' pages that bear on every video
 * follow, whole (src/knowledge.ts); without it, only the index of skills, as before. With `beside`, the agent may also
 * read its job folder around its own (its note, sources and what was read from them), and is told where that is.
 */
export function systemPrompt(workspace?: "files" | "full" | boolean, extra: readonly ExtraSkill[] = [], knowledge?: GivenKnowledge, beside = false): string {
  const access = workspace === true ? "full" : workspace || undefined;
  // With `beside`, the job folder around it is open to read (docs/JOB-FOLDER.md): where its note is, nothing more.
  const around = beside ? " It sits in this video's job folder, one level up (`..`), which you can read but not change: `../README.md` says what is there, the sources and what was read from them." : "";
  const folder =
    access === "full"
      ? `\n\n# Your folder\nYour current folder is this video's own. Your own tools work there: your shell, files, web search and fetch, walled in to that folder and the web.${around}`
      : access === "files"
        ? `\n\n# Your folder\nYour current folder is this video's own. Your own file tools work there${beside ? "" : " and only there"}: read, write, edit and search files, and keep notes. You have no shell and no web of your own in this turn; everything else goes through Open Sourcebook's tools.${around}`
        : "";
  const where = access
    ? "They are in skills/ in your folder, as files: each folder's SKILL.md first, and what it points to when you want more. read_skill reads them too."
    : "Read them with read_skill: a skill's SKILL.md first, and what it points to when you want more.";
  const skillsPart = knowledge
    ? `# Skills
The pages that bear on every video are given whole after these instructions: what viewers notice, the teaching skill with its four references, the make-a-video skill with the pieces on the shelf, and the scene language as reference. The skills:
${skillIndex(extra)}
Their other files are there to open when one would help, ${access ? "in skills/ in your folder (read_skill reads them too)" : "with read_skill"}:
${notGiven(knowledge.video).map((f) => `- ${f}`).join("\n")}`
    : `# Skills
${where}
${skillIndex(extra)}`;
  const head = `You are making one short video for Open Sourcebook, a study app, from passages of the person's own sources, with Open Sourcebook's tools (the opensourcebook tools). The person watches the finished video on their phone; it is for someone trying to understand this.

${skillsPart}${folder}

# What Open Sourcebook needs
- Every beat stands on the passages: at least one cite with a quote copied word for word (only spaces may differ). Say nothing the passages do not support.
- Never put ids like s2 or p1 in anything said or shown.
- Each beat is cut to from the one before: every scene starts with a plain state at @0, on screen from the beat's first frame.
- The narration is burned in as captions in a band near the bottom of the frame, which the engine keeps clear.

Do not stop to ask anything: nobody answers until the video is done. When the video is ready, call finish and stop.
`;
  return knowledge ? `${head}\n${knowledgeText(knowledge.video, knowledge)}\n` : head;
}

/** How many words a voice speaks in a second, as a rule of thumb for turning the asked length into words (the voices here run about 2.4 to 2.7). */
export const WORDS_PER_SECOND = 2.5;

/** A turn that carries on a video whose last turn was cut off: why, when that is known, and the draft as it was left. */
export interface CarryOn {
  /** A few words on why the last turn was cut off, e.g. "the service restarted". */
  why?: string;
  draft: Draft;
}

/** What a carry-on turn is told: that it was cut off, and what exists, read from the draft. Knowledge, not a rule. */
export function carryOnText(request: VideoRequest, carry: CarryOn): string {
  const d = carry.draft;
  const script = d.script;
  const style = request.style === "auto" ? (d.style ?? script?.style) : request.style;
  const beats = (script?.scenes ?? []).map((s) => {
    const scene = d.scenes[s.id];
    const words = s.narration.trim().replace(/\s+/g, " ");
    const start = words.length > 70 ? `${words.slice(0, 70).replace(/\s+\S*$/, "")}…` : words;
    const picture = !scene?.source ? "no picture yet" : !scene.built ? "its picture does not build" : scene.looked ? "its picture builds and you looked at it" : "its picture builds, not looked at since it last changed";
    return `- ${s.id}: "${start}", ${picture}.`;
  });
  const lines = [
    `You were making this video, and your turn was cut off${carry.why ? ` (${carry.why})` : ""}. What you made is kept as you left it, and so is this video's folder. Carry on from there; there is no need to start over.`,
    "What exists:",
    script ? `- The video: "${script.title}"${script.idea ? `, ${script.idea.replace(/[.!?]+$/, "")}` : ", no idea said yet"}.` : "- No title or idea said yet.",
    `- Style: ${style ? `${style}${request.style === "auto" ? " (your pick)" : " (set by the request)"}` : "none picked yet"}.`,
    ...(beats.length ? [`- ${beats.length} beat${beats.length === 1 ? "" : "s"}:`, ...beats.map((b) => `  ${b}`)] : ["- No beat written yet."]),
    d.sound ? `- Sound placed: ${d.sound.music.length ? `music ${d.sound.music.map((c) => c.name).join(", ")}` : "no music"}, ${d.sound.effects.length} effect${d.sound.effects.length === 1 ? "" : "s"}.` : "",
    d.cut ? `- A cut was rendered (cut ${d.cut.number}, ${(d.cut.durationMs / 1000).toFixed(1)} s); render says whether it is still the video as it stands.` : "- No cut rendered yet.",
    d.finished ? "- You had called finish." : "",
    "To read it back: write_beat with only a beat's id answers with that beat's words and times and the whole video so far, look shows a beat's picture, about_video with no fields says the title and style, and watch shows the last cut, or each beat's opening and end from the builds.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** A remake of one scene of a finished video: the beat the person asked to be made again, their note, and the draft as it was. */
export interface RemakeTurn {
  beat: string;
  note?: string;
  draft: Draft;
}

/** A beat's words, cut to their start, for a line that names it. */
function startOf(narration: string, chars = 70): string {
  const words = narration.trim().replace(/\s+/g, " ");
  return words.length > chars ? `${words.slice(0, chars).replace(/\s+\S*$/, "")}…` : words;
}

/**
 * What a remake turn is told: that the video was made and watched, which beat the person asked to be made again, in
 * their own words, that the rest stays as it is, and what exists. The person's ask, not a rule of Open Sourcebook's.
 */
export function remakeText(remake: RemakeTurn): string {
  const scenes = remake.draft.script?.scenes ?? [];
  const at = scenes.findIndex((s) => s.id === remake.beat);
  const beat = scenes[at];
  const said = beat?.narration.trim() ? `, the one that says "${startOf(beat.narration)}"` : "";
  const note = remake.note?.trim();
  return [
    `This video was made, and the person watched it. They asked for one scene of it to be made again: beat ${remake.beat} (scene ${at + 1} of ${scenes.length})${said}.`,
    note ? `What they said about it, in their own words: "${note.replace(/"/g, "'")}"` : "They said nothing more about it.",
    `Make that beat again as they ask. The rest of the video stays as it is: the other beats, their words and their pictures. A beat whose words do not change keeps its voice. Your script, scenes, sound and this video's folder are as you left them; this is a new copy of the video, and the one the person watched stays as it was until this one is done.`,
    `The beats:\n${scenes.map((s) => `- ${s.id}${s.id === remake.beat ? " (the one to make again)" : ""}: "${startOf(s.narration)}"`).join("\n")}`,
    "write_beat with only a beat's id answers with that beat's words and times, look shows its picture. When the beat is made again, finish.",
  ].join("\n");
}

/** The style's own picture of how it looks (its `art` line for a whole scene), beside its description; none when it has none. */
function artOf(style: string): string {
  try {
    const art = (styleFile(style) as { art?: { scene?: string } }).art?.scene?.trim();
    return art ? ` How a scene in it looks, in its own words: ${art}` : "";
  } catch {
    return "";
  }
}

/**
 * The turn's prompt: the video asked for, the styles when the agent picks one, and the passages; then, on a carry-on,
 * what exists; on a polish turn, a fresh viewer's notes on the finished video with the beats as they stand (src/review.ts);
 * on a remake, the beat the person asked to be made again and their note.
 */
export function turnPrompt(request: VideoRequest, styles: Style[], revise?: string[], carry?: CarryOn, polish?: string, remake?: RemakeTurn): string {
  const lines = [
    `Make the video "${request.title}".`,
    request.brief ? `Brief: ${request.brief}` : "",
    request.assumes.length ? `The viewer already knows: ${request.assumes.join("; ")}.` : "",
    extraSkills(request.skills ?? []).length
      ? `This project has packs on: knowledge for the kind of work the person is doing, among your skills like the others:\n${extraSkills(request.skills ?? []).map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
      : "",
    `Length: the person asked for about ${Math.round(request.targetSeconds ?? 60)} seconds of narration, about ${Math.round((request.targetSeconds ?? 60) * WORDS_PER_SECOND / 10) * 10} words at a voice's usual pace; each beat you write answers with the video's spoken length so far against it. Open Sourcebook takes ${request.limits.minScenes} to ${request.limits.maxScenes} scenes, at most ${request.limits.narrationMaxChars} characters of narration a scene.`,
    `Frame: ${request.frame.width} by ${request.frame.height}${request.frame.height > request.frame.width ? ", a phone held upright" : ""}.`,
    request.style === "auto"
      ? `Style: yours to pick, and no style is the default. Read what each looks like and suits, pick the one that fits this subject and its viewer best, and give its id as style in about_video. The styles:\n${styles.map((s) => `- ${s.id} (${s.label}): ${s.description}`).join("\n")}`
      : `Style: ${request.style}. ${allStyles().find((s) => s.id === request.style)?.description ?? ""}${artOf(request.style)}${leansText(themeFrom(request.style))}`,
    `Passages (read them with read_passages):\n${request.passages.map((p) => `- ${p.id}: ${p.sourceTitle}${p.locator ? `, ${p.locator}` : ""} (${p.text.length} characters): "${p.text.trim().replace(/\s+/g, " ").slice(0, 120)}…"`).join("\n")}`,
  ];
  if (remake) lines.push(remakeText(remake));
  if (carry) lines.push(carryOnText(request, carry));
  if (polish) lines.push(polish);
  if (revise?.length) {
    lines.push(
      `This video was made once already, and Open Sourcebook's own checker refused it. Your script and scenes are as you left them. Fix these problems with the tools, then finish:\n- ${revise.join("\n- ")}`,
    );
  }
  return lines.filter(Boolean).join("\n\n");
}

export const INSTRUCTIONS = "Open Sourcebook's tools for making one video: read_passages, read_skill, about_video, write_beat, look, render, watch, viewer_report, sound, find_piece and save_piece for the shelf of ready-made pieces, and finish to end; and, when listed, the tools for finding, making and keeping pictures.";
