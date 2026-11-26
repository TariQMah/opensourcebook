import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { PlanView } from "../api/types";
import { Link } from "react-router";
import { useApi } from "../app/context";
import { Confirm } from "../app/Confirm";
import { ErrorNotice } from "../app/Status";
import { FormatTile } from "../design/FormatTile";
import { lookFor } from "../design/formatLook";
import { Icon } from "../design/Icon";
import { AddItem, ItemDetails } from "./ItemForm";
import { JobFiles } from "./JobFiles";
import { itemKey } from "./itemDraft";
import { usePlan } from "./PlanContext";
import { buildStages, canEditItems, conditionText, FOLD_ITEMS, formatWords, partsOf, isFinished, playLabel, issueFix, newStageLevel, openStage, plannedLine, rowState, runningFor, sizeText, splitIssues, stageName, timeLeft, underwayText, type Row, type StageGroup } from "./planModel";
import { usePlanStart } from "./usePlanStart";
import { waitingLine } from "./waiting";
import { dayInWords, dueWords, hasLeft, localDay, missedStages, whenOf } from "./days";
import "./planCard.css";

export type Selection = { kind: "item"; id: string; edit?: boolean; /** Opens the editor at its sources. */ sources?: boolean } | { kind: "add"; level: number } | null;

/**
 * A plan as one message in the chat. Each thing to make is one line: its
 * format tile and title. Tapping it opens what it is for and what it reads,
 * with Edit; adding, removing, Start and live progress all happen inside the
 * card. No helper sentences: the layout says what is side by side and what
 * is a branch.
 */
export function PlanCard({ focused, inThisChat = true, onPlay }: { focused?: boolean; /** False when shown in a chat that did not make it. */ inThisChat?: boolean; /** Plays the plan from a made thing; without it, Play opens the thing's own page. */ onPlay?: (outputId: string) => void }) {
  const { view, editable } = usePlan();
  const [selection, setSelection] = useState<Selection>(null);
  const stages = buildStages(view.items, view.stages);
  const started = view.plan.kickedOffAt !== undefined;
  const lastLevel = newStageLevel(view.items);
  const addingStage = selection?.kind === "add" && selection.level === lastLevel;
  // A big plan opens folded, a stage per line with its size, the one to go on with open.
  const foldable = view.items.length > FOLD_ITEMS;
  // Until the person folds or opens one, the stage to go on with is open (it can change as the plan is written or gone through).
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null);
  // It folds by parts: a labelled stage and the unlabelled ones after it.
  const parts = partsOf(stages);
  const partOf = (level: number | undefined) => parts.find((part) => part.stages.some((stage) => stage.level === level));
  const first = partOf(openStage(stages))?.first;
  const unfolded = picked ?? new Set(first === undefined ? [] : [first]);
  const toggle = (level: number) => setPicked(new Set(unfolded.has(level) ? [...unfolded].filter((l) => l !== level) : [...unfolded, level]));

  return (
    <article className={`plancard${focused ? " focused" : ""}`} id={`plan-${view.plan.id}`} aria-label={`Plan: ${view.plan.title || "Untitled plan"}`}>
      <Header inThisChat={inThisChat} />
      {editable && view.items.length > 0 && <p className="edhint">Tick what you want made, open an item to change it, then press Start.</p>}
      {parts.flatMap((part) => {
        const folded = foldable ? !unfolded.has(part.first) : undefined;
        const shown = folded ? part.stages.slice(0, 1) : part.stages;
        return shown.map((stage, k) => (
          <StageBlock
            key={stage.level}
            stage={stage}
            selection={selection}
            onSelect={setSelection}
            started={started}
            onPlay={onPlay}
            {...(k === 0 && folded !== undefined ? { folded, onFold: () => toggle(part.first), part: part.stages } : {})}
            continued={foldable && k > 0}
            count={stages.length}
          />
        ));
      })}
      {addingStage && (
        <div className="pst">
          <AddItem level={lastLevel} onDone={(id) => setSelection(id ? { kind: "item", id } : null)} />
        </div>
      )}
      {editable && !addingStage && (
        <button className="addstage" type="button" onClick={() => setSelection({ kind: "add", level: lastLevel })}>
          <Icon name="plus" />
          {stages.length === 0 ? "Add the first item" : "Add a stage after these"}
          {stages.length > 0 && <small>made after the ones above</small>}
        </button>
      )}
      <CatchUp stages={stages} />
      <Footer onPlay={onPlay} />
    </article>
  );
}

/** When stages' days passed with something left in them: one line, and a press moves the days on from today. */
function CatchUp({ stages }: { stages: StageGroup[] }) {
  const { view, edit, busy } = usePlan();
  const client = useApi();
  const today = localDay();
  const missed = missedStages(stages, today);
  if (missed.length === 0 || view.plan.status === "discarded" || view.plan.status === "cancelled") return null;
  const words = missed.length === 1 ? `${stageName(missed[0]!, stages.length)} was meant for ${dayInWords(missed[0]!.dueOn!, today)}.` : `${missed.length} stages' days have passed.`;
  return (
    <div className="catchup" role="status">
      <span>{words}</span>
      <button className="mini go" type="button" disabled={busy} onClick={() => void edit(() => client.catchUp(view.plan.id, today))}>
        Move the days on
      </button>
    </div>
  );
}

/** A stage's day on its line: when it is, how it stands from today, and a press to change it. */
function StageDay({ stage, onChange }: { stage: StageGroup; onChange: () => void }) {
  if (!stage.dueOn) {
    return (
      <button className="setday" type="button" title="Give this stage a day" aria-label="Set a day" onClick={onChange}>
        <Icon name="calendar" />
        <span>Set a day</span>
      </button>
    );
  }
  const today = localDay();
  const when = hasLeft(stage) ? whenOf(stage.dueOn, today) : "later";
  return (
    <button className={`day ${when}`} type="button" title="Change this stage's day" onClick={onChange}>
      <Icon name="calendar" />
      {dueWords(stage.dueOn, when === "missed", today)}
    </button>
  );
}

/** Where the plan came from, said only when it is not this chat. */
function origin(chatId: string | undefined, inThisChat: boolean): string | undefined {
  if (chatId && inThisChat) return undefined;
  return chatId ? "From another chat" : "Made outside a chat";
}

function Header({ inThisChat }: { inThisChat: boolean }) {
  const { view, edit, formats } = usePlan();
  const client = useApi();
  const { plan, counts, items } = view;
  const size = sizeText(items, formats);
  // Before Start, the card says what each kind of thing it makes is: often where a person first meets the word.
  const words = formatWords(items, formats);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(plan.title ?? "");
  const started = plan.kickedOffAt !== undefined;
  const making = items.filter((i) => i.status === "running" || i.status === "queued").length;
  const included = items.filter((i) => i.enabled).length;
  const from = origin(plan.chatId, inThisChat);
  const status = planStatus(plan.status, counts, started);

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (await edit(() => client.updatePlan(plan.id, { title: title.trim() || null }))) setRenaming(false);
  }

  return (
    <div className="ph2">
      <div className="tt">
        {renaming ? (
          <form className="rename" onSubmit={rename}>
            <input className="ipt" autoFocus aria-label="Plan title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setTitle(plan.title ?? ""), setRenaming(false))} />
            <button className="mini go" type="submit">
              Save
            </button>
            <button className="mini" type="button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h3>
            <button type="button" title="Rename" onClick={() => setRenaming(true)}>
              {plan.title || "Untitled plan"}
            </button>
          </h3>
        )}
        <small>
          {from && <span>{from} · </span>}
          {started && plan.status === "cancelled" ? (
            // Stopped part way, what matters is how much was made before Resume.
            <span>
              {items.filter((i) => i.enabled && i.outputId).length} of {included} made
            </span>
          ) : started ? (
            <>
              <span>
                {counts.done} of {counts.total} gone through
              </span>
              {making > 0 && <span> · {making} being made</span>}
            </>
          ) : plan.status === "discarded" ? (
            <span>Never started</span>
          ) : (
            <span>{size || `${included} thing${included === 1 ? "" : "s"} to make`}</span>
          )}
        </small>
        {started && size && <small className="size">{size}</small>}
        {!started && plan.status !== "discarded" && words.length > 0 && (
          <small className="words">
            {words.map((w, i) => (
              <span key={w.label}>
                {i > 0 && " · "}
                <b>{w.label}</b>: {w.blurb}
              </span>
            ))}
          </small>
        )}
      </div>
      {status && <span className={`st ${status.cls}`}>{status.text}</span>}
      {started && (plan.status === "running" || plan.status === "done") && <Ring done={counts.done} total={counts.total} />}
    </div>
  );
}

/**
 * The plan's state in one word beside its title. "Done" is kept for when the
 * person has been through everything; a plan whose items are all made but not
 * all gone through says "All made", so it never reads "Done · 0 of 3 done".
 */
function planStatus(status: string, counts: { done: number; total: number }, started: boolean): { text: string; cls: string } | undefined {
  if (status === "failed") return { text: "Failed", cls: "fail" };
  // Stopped part way can be resumed; discarded before Start is final.
  if (status === "cancelled") return { text: "Stopped", cls: "" };
  if (status === "discarded") return { text: "Discarded", cls: "" };
  if (status !== "done" || !started) return undefined;
  return counts.total > 0 && counts.done >= counts.total ? { text: "Done", cls: "done" } : { text: "All made", cls: "" };
}

function Ring({ done, total }: { done: number; total: number }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  const f = total ? done / total : 0;
  return (
    <svg className={`ring${f === 1 ? " full" : ""}`} viewBox="0 0 28 28" role="progressbar" aria-label="Items done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <circle cx="14" cy="14" r={r} className="track" />
      {f > 0 && <circle cx="14" cy="14" r={r} className="fill" strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 14 14)" />}
    </svg>
  );
}

function StageBlock({
  stage,
  selection,
  onSelect,
  started,
  onPlay,
  folded,
  onFold,
  part,
  continued = false,
  count,
}: {
  stage: StageGroup;
  selection: Selection;
  onSelect: (s: Selection) => void;
  started: boolean;
  onPlay?: (outputId: string) => void;
  /** True when the stage shows only its line; undefined when the plan is small enough never to fold. */
  folded?: boolean;
  onFold?: () => void;
  /** The stages of the part this stage opens, when it opens one: its line says the part's size. */
  part?: StageGroup[];
  /** A stage that carries on its part with no label of its own: its line stays quiet until hovered. */
  continued?: boolean;
  /** How many stages the plan has, for the words that name this one. */
  count: number;
}) {
  const { view, edit, editable, formats } = usePlan();
  const client = useApi();
  const [labelling, setLabelling] = useState(false);
  const [label, setLabel] = useState(stage.label ?? "");
  const [dating, setDating] = useState(false);
  const [day, setDay] = useState(stage.dueOn ?? "");
  const main = stage.rows.filter((r) => r.depth === 0);
  const branches = stage.rows.filter((r) => r.depth > 0);
  const allDone = started && stage.rows.every((r) => r.item.done || !r.item.enabled || r.item.status === "skipped");
  const selectedHere = selection?.kind === "item" ? stage.rows.find((r) => r.item.id === selection.id) : undefined;
  const name = stageName(stage, count);

  async function saveLabel(e: FormEvent) {
    e.preventDefault();
    if (await edit(() => client.setStageLabel(view.plan.id, stage.level, label.trim() || null))) setLabelling(false);
  }

  async function saveDay(dueOn: string | null) {
    if (await edit(() => client.setStageDay(view.plan.id, stage.level, dueOn))) setDating(false);
  }
  // A plan thrown away or stopped has no days to keep.
  const datable = view.plan.status !== "discarded" && view.plan.status !== "cancelled";

  const partRows = (part ?? [stage]).flatMap((s) => s.rows);
  const size = sizeText(
    partRows.map((r) => r.item),
    formats,
  );
  const doneHere = partRows.filter((r) => r.item.done).length;
  return (
    <section className={`pst${allDone ? " done" : ""}${folded ? " folded" : ""}${continued && !stage.label && !stage.dueOn ? " cont" : ""}`} aria-label={`Stage ${stage.number}`}>
      <div className="lab">
        {folded !== undefined && (
          <button className="fold" type="button" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} ${name}`} onClick={onFold}>
            <Icon name="chev-r" />
          </button>
        )}
        {labelling ? (
          <form className="rename" onSubmit={saveLabel}>
            <input className="ipt" autoFocus aria-label="Stage label" maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setLabel(stage.label ?? ""), setLabelling(false))} />
            <button className="mini go" type="submit">
              Save
            </button>
            <button className="mini" type="button" onClick={() => setLabelling(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="lbl" type="button" title="Name this stage" onClick={() => setLabelling(true)}>
            {name}
          </button>
        )}
        {dating ? (
          <form
            className="rename"
            onSubmit={(e) => {
              e.preventDefault();
              if (day) void saveDay(day);
            }}
          >
            <input className="ipt" type="date" autoFocus aria-label="Stage day" value={day} onChange={(e) => setDay(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setDay(stage.dueOn ?? ""), setDating(false))} />
            <button className="mini go" type="submit" disabled={!day}>
              Save
            </button>
            {stage.dueOn && (
              <button className="mini" type="button" onClick={() => void saveDay(null)}>
                No day
              </button>
            )}
            <button className="mini" type="button" onClick={() => (setDay(stage.dueOn ?? ""), setDating(false))}>
              Cancel
            </button>
          </form>
        ) : (
          !labelling && datable && <StageDay stage={stage} onChange={() => (setDay(stage.dueOn ?? ""), setDating(true))} />
        )}
        {folded !== undefined && !labelling && (
          <span className="sz">
            {size}
            {started && doneHere > 0 ? ` · ${doneHere} done` : ""}
          </span>
        )}
        {editable && !folded && !(selection?.kind === "add" && selection.level === stage.level) && (
          <button className="addn" type="button" aria-label={`Add an item to ${name}`} onClick={() => onSelect({ kind: "add", level: stage.level })}>
            <Icon name="plus" />
            Add
          </button>
        )}
      </div>
      {folded ? null : (
        <>
      {main.length > 0 && (
        <div className={`prow${main.length > 1 && !(selectedHere && selectedHere.depth === 0) ? " two" : ""}`}>
          {main.map((r) => (
            <ItemRow key={r.item.id} row={r} selected={selectedHere?.item.id === r.item.id} onSelect={onSelect} onPlay={onPlay} />
          ))}
        </div>
      )}
      {selectedHere && selectedHere.depth === 0 && <ItemDetails key={itemKey(selectedHere.item)} item={selectedHere.item} edit={selection?.kind === "item" && selection.edit === true} toSources={selection?.kind === "item" && selection.sources === true} onClose={() => onSelect(null)} />}
      {branches.map((r) => (
        <div key={r.item.id} className="fork" style={{ marginLeft: 20 + (r.depth - 1) * 24 }}>
          <div className="cond">{conditionText(r.item.condition, r.parent?.title)}</div>
          <ItemRow row={r} selected={selectedHere?.item.id === r.item.id} onSelect={onSelect} onPlay={onPlay} />
          {selectedHere?.item.id === r.item.id && <ItemDetails key={itemKey(r.item)} item={r.item} edit={selection?.kind === "item" && selection.edit === true} toSources={selection?.kind === "item" && selection.sources === true} onClose={() => onSelect(null)} />}
        </div>
      ))}
      {selection?.kind === "add" && selection.level === stage.level && <AddItem level={stage.level} onDone={(id) => onSelect(id ? { kind: "item", id } : null)} />}
        </>
      )}
    </section>
  );
}

/** The way on an item's job offers instead of waiting (finishing a video without sound), as its own small button. */
export function ChoiceButton({ choice, busy, onChoose }: { choice: { id: string; label: string }; busy: boolean; onChoose: (id: string) => unknown }) {
  return (
    <button className="mini" type="button" disabled={busy} onClick={() => void onChoose(choice.id)}>
      {choice.label}
    </button>
  );
}

function ItemRow({ row, selected, onSelect, onPlay }: { row: Row; selected: boolean; onSelect: (s: Selection) => void; onPlay?: (outputId: string) => void }) {
  const { view, formats, editable, edit, act, busy } = usePlan();
  const client = useApi();
  const { item } = row;
  const started = view.plan.kickedOffAt !== undefined;
  // Before Start, what would stop the plan because of this item is said on its row, with its fix one click away.
  const issues = editable ? (splitIssues(view).byItem.get(item.id) ?? []) : [];
  const fix = issues[0] && issueFix(issues[0].code);
  const failed = started && item.status === "failed";
  const canRetry = failed && (view.plan.status === "running" || view.plan.status === "failed");
  const st = rowState(item, started);
  const made = Boolean(item.outputId);
  const word = started && !made && item.enabled ? st.text : !item.enabled ? "left out" : undefined;
  const changed = useTickChange(item.done);
  return (
    <div className="itw">
      <div className={`it${selected ? " sel" : ""}${item.enabled ? "" : " off"}`} data-testid="item" data-depth={row.depth}>
        <FormatTile id={item.type} formats={formats} solid={made} done={item.done} />
        {made ? (
          // Once made, the obvious click opens it; what it was planned as is one more button away.
          <PlayLink outputId={item.outputId!} label={playLabel(item.title)} onPlay={onPlay} cls="body">
            <b>{item.title}</b>
            <span>{plannedLine(item, lookFor(formats, item.type).label)}</span>
          </PlayLink>
        ) : (
          <button id={`item-${item.id}`} className="body" type="button" aria-expanded={selected} aria-label={`Details for ${item.title}`} onClick={() => onSelect(selected ? null : { kind: "item", id: item.id })} onKeyDown={(e) => selected && e.key === "Escape" && onSelect(null)}>
            <b>{item.title}</b>
            <span>{plannedLine(item, lookFor(formats, item.type).label)}</span>
          </button>
        )}
        <span className="rt">
          {made && (
            <button id={`item-${item.id}`} className="more" type="button" aria-expanded={selected} aria-label={`Details for ${item.title}`} title="What it is for and what it reads" onClick={() => onSelect(selected ? null : { kind: "item", id: item.id })}>
              <Icon name="more" />
            </button>
          )}
          {word && (
            <span className={`w ${st.tone}`}>
              {st.tone === "gen" && <i className="shimmer" aria-hidden="true" />}
              {word}
            </span>
          )}
          {editable && (
            <button
              type="button"
              role="checkbox"
              aria-checked={item.enabled}
              aria-label={`Include ${item.title}`}
              title={item.enabled ? "Will be made. Untick to leave it out." : "Left out. Tick to make it."}
              className={`inc${item.enabled ? " on" : ""}`}
              disabled={busy}
              onClick={() => edit(() => client.updateItem(view.plan.id, item.id, { enabled: !item.enabled }))}
            >
              {item.enabled && <Icon name="check" />}
            </button>
          )}
          {started && made && item.done && (
            // Only a done item has a tick on its row, so a stray click never marks one done; Mark done is in its details.
            <button
              type="button"
              role="checkbox"
              aria-checked
              aria-label={`Done: ${item.title}`}
              title="Done. Click to undo."
              className="dn on"
              disabled={busy}
              onClick={() => act(() => client.markDone(view.plan.id, item.id, { done: false }))}
            >
              <Icon name="check" />
            </button>
          )}
          {made && <PlayLink outputId={item.outputId!} label={playLabel(item.title)} onPlay={onPlay} small />}
        </span>
      </div>
      {made && item.madeNote && (
        <div className="itnote note">
          <span>{item.madeNote}</span>
        </div>
      )}
      {changed !== undefined && started && made && (
        <div className="itnote tick" role="status">
          <span>{changed ? "Marked done." : "Marked not done."}</span>
          <button className="mini" type="button" disabled={busy} onClick={() => act(() => client.markDone(view.plan.id, item.id, changed ? { done: false } : { done: true, outputId: item.outputId! }))}>
            Undo
          </button>
        </div>
      )}
      {!made && !started && editable && item.enabled && item.notices && item.notices.length > 0 && (
        <div className="itnote quiet" role="note">
          <span>{item.notices.join(" ")}</span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="itnote" role="status">
          <span>{issues.map((i) => i.short || i.message).join(" ")}</span>
          {fix && !selected && (
            <button className="mini go" type="button" onClick={() => onSelect({ kind: "item", id: item.id, edit: true, ...(fix.toSources ? { sources: true } : {}) })}>
              {fix.label}
            </button>
          )}
        </div>
      )}
      {started && (item.status === "running" || item.status === "queued") && item.job?.step && (
        <div className="itnote step" role="status">
          {item.job.waiting ? (
            <>
              <span>
                {item.job.step} <small className="waitwhy">{waitingLine(item.job)}</small>
              </span>
              {item.job.choice && <ChoiceButton choice={item.job.choice} busy={busy} onChoose={(id) => edit(() => client.retryItem(view.plan.id, item.id, id))} />}
            </>
          ) : (
            <span>
              {item.job.step}
              {runningFor(item.job.startedAt)}
              {timeLeft(item.job) && ` · ${timeLeft(item.job)}`}
            </span>
          )}
        </div>
      )}
      {started && item.job?.files && <JobFiles jobId={item.job.id} />}
      {failed && (
        <div className="itnote fail" role="status">
          <span>{item.errorMessage ?? "It could not be made."}</span>
          {canRetry && (
            <button className="mini" type="button" disabled={busy} onClick={() => edit(() => client.retryItem(view.plan.id, item.id))}>
              <Icon name="retry" />
              Try again
            </button>
          )}
          {canRetry && item.job?.choice && <ChoiceButton choice={item.job.choice} busy={busy} onChoose={(id) => edit(() => client.retryItem(view.plan.id, item.id, id))} />}
        </div>
      )}
      {item.asking && view.plan.status === "running" && (
        <div className="asking">
          <span>{item.asking.question || "Make this one?"}</span>
          <button className="mini go" type="button" disabled={busy} onClick={() => act(() => client.answer(view.plan.id, item.id, true))}>
            Yes
          </button>
          <button className="mini" type="button" disabled={busy} onClick={() => act(() => client.answer(view.plan.id, item.id, false))}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

/** How long a row says its done tick changed, with Undo beside it. */
const TICK_NOTE_MS = 8_000;

/**
 * Whether an item's done tick just changed (true: now done), for a few
 * seconds after it does, so a tick nobody meant is seen and undone at once.
 */
function useTickChange(done: boolean): boolean | undefined {
  const [changed, setChanged] = useState<boolean>();
  const was = useRef(done);
  useEffect(() => {
    if (was.current === done) return;
    was.current = done;
    setChanged(done);
    const t = window.setTimeout(() => setChanged(undefined), TICK_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [done]);
  return changed;
}

/**
 * Where a started plan is, said once more at the end of the chat that made
 * it: the reply above was written before Start, and the chat should not
 * still read as if nothing has started. Play is here once something is made.
 */
export function PlanUnderway({ view, onPlay }: { view: PlanView; onPlay?: (outputId: string) => void }) {
  const said = underwayText(view);
  if (!said) return null;
  const next = view.items.find((i) => i.enabled && i.outputId && !i.done) ?? view.items.find((i) => i.enabled && i.outputId);
  const running = view.plan.status === "running";
  return (
    <div className={`m ai underway${running ? " live" : ""}`} role="status">
      <span>{said}</span>
      {next && (
        <PlayLink outputId={next.outputId!} label={playLabel(next.title)} onPlay={onPlay}>
          Play
        </PlayLink>
      )}
    </div>
  );
}

/** Plays a made thing: in the Studio panel when the screen offers it, else on its own page. */
function PlayLink({ outputId, label, onPlay, small, cls, children }: { outputId: string; label: string; onPlay?: (outputId: string) => void; small?: boolean; /** Its own look (a row's body), with no play icon. */ cls?: string; children?: ReactNode }) {
  const look = cls ?? (small ? "play" : "btn");
  const icon = cls ? null : <Icon name="play" />;
  // A button with words says them; one with only the icon is named by what it plays.
  const name = children && !cls ? `${label}` : children ? undefined : label;
  if (onPlay)
    return (
      <button className={look} type="button" aria-label={name} title={cls ? label : undefined} onClick={() => onPlay(outputId)}>
        {icon}
        {children}
      </button>
    );
  return (
    <Link className={look} to={`/outputs/${outputId}`} aria-label={name} title={cls ? label : undefined}>
      {icon}
      {children}
    </Link>
  );
}

function Footer({ onPlay }: { onPlay?: (outputId: string) => void }) {
  const { view, edit, busy, error } = usePlan();
  const client = useApi();
  const { plan, items } = view;
  const included = items.filter((i) => i.enabled).length;
  // An issue about one item is said on its row; the list here keeps the ones about the whole plan.
  const issues = splitIssues(view).plan;
  const finished = isFinished(plan.status);
  const next = items.find((i) => i.enabled && i.outputId && !i.done);

  // Pressing Start is the approval; with several agents ready and none picked, it asks who makes them first.
  const { start, picker } = usePlanStart();

  const editing = canEditItems(plan.status);
  const stopped = plan.status === "cancelled";
  const [discarding, setDiscarding] = useState(false);
  const showNext = (plan.status === "running" || finished) && next;
  if (!editing && plan.status !== "running" && !stopped && !showNext && !error) return null;
  return (
    <>
      {editing && issues.length > 0 && items.length > 0 && (
        <div className="notice warn" role="status">
          <div>
            Before it can start:
            <ul>
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <ErrorNotice error={error} />
      <div className="ft">
        {editing && (
          <button className="quiet" type="button" disabled={busy} onClick={() => setDiscarding(true)}>
            Discard
          </button>
        )}
        {discarding && (
          <Confirm
            title={`Discard “${plan.title || "Untitled plan"}”?`}
            action="Discard plan"
            busy={busy}
            onConfirm={() => void edit(() => client.cancel(plan.id)).then(() => setDiscarding(false))}
            onCancel={() => setDiscarding(false)}
          >
            <p>It stays in the chat, marked discarded, and can't be edited or started. Nothing has been made from it yet.</p>
          </Confirm>
        )}
        {picker}
        {plan.status === "running" && (
          <button className="quiet" type="button" disabled={busy} onClick={() => edit(() => client.cancel(plan.id))}>
            Stop
          </button>
        )}
        <span className="sp" />
        {stopped && (
          <button className={showNext ? "btn ghost" : "btn"} type="button" disabled={busy} title="Makes what is not made yet" onClick={() => edit(() => client.resume(plan.id))}>
            <Icon name="play" />
            Resume
          </button>
        )}
        {editing && (
          <button className="btn" type="button" disabled={busy || included === 0} onClick={start}>
            <Icon name="play" />
            Start
          </button>
        )}
        {showNext && (
          <PlayLink outputId={next.outputId!} label={playLabel(next.title)} onPlay={onPlay}>
            Play
          </PlayLink>
        )}
      </div>
    </>
  );
}
