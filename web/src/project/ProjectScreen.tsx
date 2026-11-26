import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { Cite, Json, PlanView, Project } from "../api/types";
import { useApi } from "../app/context";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { DeleteProject } from "../screens/DeleteProject";
import { Icon } from "../design/Icon";
import { Logo } from "../design/ui";
import { useDismiss } from "../design/useDismiss";
import { ChatPanel } from "./ChatPanel";
import { SourceReader } from "./SourceReader";
import { SourcesPanel } from "./SourcesPanel";
import { StudioPanel } from "./StudioPanel";
import type { Spot } from "./spot";
import { RightViewHost } from "./RightColumn";
import { RightPanelProvider, useRightPanel, useRightViewRenderer, type RightPanelContext } from "./rightPanel";
import { studioRows, unstartedOutsideChats } from "./studio";
import { StudioPlayer } from "./StudioPlayer";
import { saveNewChatTicks, tickedIds, usable } from "./ticks";
import { useProjectPlans } from "./useProjectPlans";
import { useTitle } from "../app/useTitle";
import "./project.css";

/**
 * A project: Sources, the chat, and Make with Made here, side by side and
 * filling the window; on a phone, tabs. `?source=` opens a source in the
 * left column at its cited spot; `?plan=` opens a plan on the right (or, with
 * no plan view plugged in, brings its card into view); `?play=`
 * plays a made thing in the right column. The right column also shows
 * whatever view is open in it (`rightPanel.tsx`), such as the make sheet.
 */
export function ProjectScreen() {
  const { id = "" } = useParams();
  // Another project is a fresh screen: nothing of the one before (its chat, ticks, panels) carries over.
  return (
    <RightPanelProvider key={id}>
      <ProjectView id={id} />
    </RightPanelProvider>
  );
}

type Tab = "chat" | "sources" | "made";

function ProjectView({ id }: { id: string }) {
  const [params, setParams] = useSearchParams();
  const client = useApi();
  const panel = useRightPanel();
  const project = useLoad(() => client.getProject(id), [client, id]);
  useTitle(project.data?.title);
  const sources = useLoad(() => client.all((q) => client.projectSources(id, q)), [client, id]);
  const plans = useProjectPlans(id);
  const [unselected, setUnselected] = useState<Set<string>>(new Set());
  // Words the right column asks the chat to send (a plan, while no plan panel is plugged in).
  const [outbox, setOutbox] = useState<{ id: number; text: string }>();
  // A thing opened at a spot (from a thread message in the chat), and a chat a thread just wrote into.
  const [playAt, setPlayAt] = useState<{ outputId: string; at: Json; n: number }>();
  const [refresh, setRefresh] = useState<{ chatId: string; n: number }>();
  // On a phone one panel shows at a time, picked by tabs: the chat first, Sources when a link opens a cited spot, Made when it opens something to play.
  const [tab, setTab] = useState<Tab>(() => (params.has("source") ? "sources" : params.has("play") ? "made" : "chat"));
  // The chat's ticks, applied to the Sources panel once the sources are loaded.
  const [chatTicks, setChatTicks] = useState<{ ids?: string[] }>();
  const [applied, setApplied] = useState<{ ids?: string[] }>();
  if (chatTicks && chatTicks !== applied && sources.data) {
    setApplied(chatTicks);
    const on = chatTicks.ids ? new Set(chatTicks.ids) : undefined;
    setUnselected(new Set(on ? sources.data.filter((s) => !on.has(s.id)).map((s) => s.id) : []));
  }
  // The chat on screen, so ticks the person changes are saved on it (or, for a new chat, in this browser).
  const shownChat = useRef<string | null | undefined>(undefined);
  const saving = useRef<number | undefined>(undefined);
  // Where the person is in each thing the Studio plays, as its player last said: the @ list reads it for Playing now.
  const moments = useRef(new Map<string, Json>());
  useEffect(() => () => window.clearTimeout(saving.current), []);
  /** The person ticked or unticked sources: shown at once, saved on the chat a moment later. */
  function changeTicks(next: Set<string>) {
    setUnselected(next);
    const ids = tickedIds(sources.data ?? [], next);
    const chatId = shownChat.current;
    if (chatId === undefined) return;
    if (chatId === null) return saveNewChatTicks(id, ids);
    window.clearTimeout(saving.current);
    saving.current = window.setTimeout(() => void client.updateChat(chatId, { sources: ids ?? null }).catch(() => undefined), 400);
  }
  const reading = params.get("source");
  const chatParam = params.get("chat");
  const focus = params.get("plan");
  const playing = params.get("play");
  // A player open in the right column holds it: a plan a reply wrote waits as its card instead of closing the player.
  const hold = panel.hold;
  useEffect(() => hold(Boolean(playing)), [playing, hold]);
  const playingAt = useCallback(() => (playing ? moments.current.get(playing) : undefined), [playing]);
  const spot = spotParam(params.get("at"), params.get("quote"), params.get("n"));

  function setParam(name: "source" | "plan" | "play" | "chat", value: string | null, push = false) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === "source") {
      next.delete("at");
      next.delete("quote");
    }
    setParams(next, { replace: !push });
  }
  /** The Sources panel follows the chat's ticked sources: undefined ticks every source. */
  function tick(ids: string[] | undefined) {
    setChatTicks({ ...(ids ? { ids } : {}) });
  }
  /** Opens a cited source at its spot: the passage's character span, and the quote within it. */
  function openCite(cite: Cite, n?: number) {
    // On a phone the source opens in its own tab, so the spot is seen.
    setTab("sources");
    const next = new URLSearchParams(params);
    next.set("source", cite.sourceId);
    const at = cite.locator;
    if (at?.charStart !== undefined && at.charEnd !== undefined) next.set("at", `${at.charStart}-${at.charEnd}`);
    else next.delete("at");
    if (cite.quote) next.set("quote", cite.quote);
    else next.delete("quote");
    if (n !== undefined) next.set("n", String(n));
    else next.delete("n");
    setParams(next, { replace: true });
  }
  const focusPlan = useCallback(
    (pid: string) => {
      setTab("chat");
      const next = new URLSearchParams(params);
      next.set("plan", pid);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // A plan named in the address (an old plan link, the menu's plans) opens in the right column when a plan view is plugged in there, once per plan named.
  const planPanel = useRightViewRenderer("plan") !== undefined;
  const openedPlan = useRef<string | null>(null);
  const openPanel = panel.open;
  useEffect(() => {
    if (!focus || !planPanel || openedPlan.current === focus) return;
    openedPlan.current = focus;
    openPanel({ kind: "plan", planId: focus });
  }, [focus, planPanel, openPanel]);

  if (!project.data)
    return (
      <div className="pw">
        <header className="ptop">
          <Link to="/" className="plogo" aria-label="Home" title="Home">
            <Logo markOnly />
          </Link>
        </header>
        <main className="pload">
          <LoadState loading={project.loading} error={project.error} what="this project" onRetry={() => void project.reload()} page />
        </main>
      </div>
    );
  const p = project.data;
  const list = sources.data ?? [];
  const selected = usable(list).filter((s) => !unselected.has(s.id));
  const play = (outputId: string, at?: Json) => {
    // Opened at a spot (a thread message's link back): the player starts there.
    if (at !== undefined) setPlayAt({ outputId, at, n: Date.now() });
    setTab("made");
    panel.close();
    // Playing closes an open source, so Play always shows what it plays.
    const next = new URLSearchParams(params);
    next.set("play", outputId);
    for (const name of ["source", "at", "quote"]) next.delete(name);
    setParams(next, { replace: true });
  };
  // The item playing in the right column, so @ can suggest it first.
  const playingItem = playing ? plans.views?.flatMap((v) => v.items).find((i) => i.outputId === playing)?.id : undefined;
  const madeCount = studioRows(plans.views ?? []).length;
  const ctx: RightPanelContext = { projectId: p.id, sources: selected.map((s) => s.id), close: panel.close, onPlanChange: plans.set, onPlay: play, ask: (text) => (setTab("chat"), setOutbox({ id: Date.now(), text })) };
  const tabName = (t: Tab) => (t === "chat" ? "Chat" : t === "sources" ? `Sources · ${selected.length}` : `Made · ${madeCount}`);

  return (
    <div className="pw">
      <TopBar project={p} onChange={project.set} outside={unstartedOutsideChats(plans.views ?? [])} onOpenPlan={(pid) => setParam("plan", pid)} />
      {p.archivedAt && <ArchivedNotice project={p} onChange={project.set} />}
      <div className="ptabs" role="tablist" aria-label="Panels">
        {(["chat", "sources", "made"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              // On a phone the Sources tab is the list; a source opens from it.
              if (t === "sources" && reading) setParam("source", null);
            }}
          >
            {tabName(t)}
          </button>
        ))}
      </div>
      <main className={`app3 tab-${tab}${reading ? " reading" : ""}${playing && !panel.view ? " playing" : ""}${panel.view ? " rv-open" : ""}`}>
        {reading ? (
          <SourceReader sourceId={reading} views={plans.views ?? []} onClose={() => setParam("source", null)} onRenamed={() => void sources.reload()} {...(spot ? { spot } : {})} />
        ) : (
          <SourcesPanel
            project={p}
            sources={list}
            loading={sources.loading && !sources.data}
            error={sources.error}
            reload={sources.reload}
            unselected={unselected}
            setUnselected={changeTicks}
            onOpen={(sid) => setParam("source", sid)}
            onRemoved={(r) => r.changedPlanIds.length > 0 && void plans.reload()}
            onFolderChanged={async () => {
              await Promise.all([project.reload(), sources.reload()]);
            }}
          />
        )}
        <ChatPanel
          project={p}
          chat={chatParam}
          onChat={(cid, push) => setParam("chat", cid ?? "new", push)}
          onShown={(cid) => (shownChat.current = cid)}
          sources={list} selected={selected} plans={plans} focus={focus} onOpenCite={openCite} onTicked={tick} onTicks={changeTicks} onSourcesAdded={() => void sources.reload()} onCloseFocus={() => setParam("plan", null)} onPlay={play} {...(playingItem ? { playingItem, playingAt } : {})} {...(outbox ? { outbox } : {})} {...(refresh ? { refresh } : {})} />
        {panel.view ? (
          <RightViewHost view={panel.view} ctx={ctx} onFocusPlan={focusPlan} />
        ) : playing ? (
          <StudioPlayer
            outputId={playing}
            projectId={p.id}
            views={plans.views ?? []}
            onGo={(id) => setParam("play", id)}
            onClose={() => setParam("play", null)}
            onPlanChange={plans.set}
            onOpenCite={(c) => openCite({ spot: "passage", ...c } as Cite)}
            {...(playAt ? { startAt: playAt } : {})}
            onOpenChat={(cid) => (setTab("chat"), setParam("chat", cid))}
            onThreadSent={(chatId) => setRefresh({ chatId, n: Date.now() })}
            onMoment={(o, at) => moments.current.set(o, at)}
          />
        ) : (
          <StudioPanel projectId={p.id} views={plans.views} error={plans.error} onFocus={focusPlan} onPlay={play} onChange={plans.set} onRemoved={plans.remove} archived={Boolean(p.archivedAt)} reading={Boolean(reading)} />
        )}
      </main>
    </div>
  );
}

function spotParam(at: string | null, quote: string | null, n: string | null): Spot | undefined {
  const m = at ? /^(\d+)-(\d+)$/.exec(at) : null;
  const num = n && /^\d+$/.test(n) ? { n: Number(n) } : {};
  // A cite that names only its words (a bit's cite) is found anywhere in the source.
  if (!m) return quote ? { charStart: 0, charEnd: Number.MAX_SAFE_INTEGER, quote, ...num } : undefined;
  return { charStart: Number(m[1]), charEnd: Number(m[2]), ...(quote ? { quote } : {}), ...num };
}

function TopBar({ project, onChange, outside, onOpenPlan }: { project: Project; onChange: (p: Project) => void; /** Plans never started that no chat made. */ outside: PlanView[]; onOpenPlan: (planId: string) => void }) {
  const client = useApi();
  const [menu, setMenu] = useState<"projects" | "project" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const [title, setTitle] = useState(project.title);
  const [error, setError] = useState<unknown>();
  const others = useLoad(() => (menu === "projects" ? client.all((q) => client.listProjects(q)) : Promise.resolve(undefined)), [client, menu]);
  const box = useDismiss<HTMLElement>(menu !== null, () => setMenu(null));

  async function act(run: () => Promise<Project>) {
    try {
      setError(undefined);
      onChange(await run());
      setRenaming(false);
      setMenu(null);
    } catch (e) {
      setError(e);
    }
  }
  function rename(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) void act(() => client.updateProject(project.id, { title: title.trim() }));
  }

  return (
    <header className="ptop" ref={box}>
      <Link to="/" className="plogo" aria-label="Home" title="Home">
        <Logo markOnly />
      </Link>
      <Link to="/" className="pback ib" aria-label="Back to projects" title="Projects">
        <Icon name="chev-l" />
      </Link>
      <Link to="/" className="pcrumb">
        Projects
      </Link>
      <span className="pslash" aria-hidden="true">
        /
      </span>
      {renaming ? (
        <form className="newform" onSubmit={rename}>
          <input
            className="ipt"
            autoFocus
            aria-label="Project title"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setTitle(project.title), setRenaming(false))}
          />
          <button className="mini go" type="submit">Save</button>
          <button className="mini" type="button" onClick={() => (setTitle(project.title), setRenaming(false))}>Cancel</button>
        </form>
      ) : (
        <span className="anchor">
          {/* The heading holds the button: inside a button a heading is not read as one. */}
          <h1 className="pname-h">
            <button className="pname" type="button" aria-expanded={menu === "projects"} aria-label={`${project.title}, switch project`} onClick={() => setMenu(menu === "projects" ? null : "projects")}>
              <span>{project.title}</span>
              <Icon name="down" />
            </button>
          </h1>
          {menu === "projects" && (
            <div className="menu" style={{ left: 0 }}>
              <div className="pt">Projects</div>
              {(others.data ?? []).map((o) => (
                <Link key={o.id} to={`/projects/${o.id}`} className={o.id === project.id ? "on" : undefined} onClick={() => setMenu(null)}>
                  {o.title}
                  {o.category && <small>{o.category}</small>}
                </Link>
              ))}
              {!others.data && <div className="muted">Loading…</div>}
              <Link to="/?new" className="new" onClick={() => setMenu(null)}>
                <span>New project</span>
                <Icon name="plus" />
              </Link>
            </div>
          )}
        </span>
      )}
      <span className="sp" />
      <Link to="/library" className="plib">
        Library
      </Link>
      <span className="anchor">
        <button className="ib" type="button" aria-label="Project menu" aria-expanded={menu === "project"} onClick={() => setMenu(menu === "project" ? null : "project")}>
          <Icon name="more" />
        </button>
        {menu === "project" && (
          <div className="menu" style={{ right: 0 }}>
            <button className="mi" type="button" onClick={() => { setRenaming(true); setMenu(null); }}>
              Rename
            </button>
            {project.archivedAt ? (
              <button className="mi" type="button" onClick={() => act(() => client.unarchiveProject(project.id))}>
                Restore
              </button>
            ) : (
              <button className="mi" type="button" onClick={() => act(() => client.archiveProject(project.id))}>
                Archive <small>keeps everything</small>
              </button>
            )}
            {outside.length > 0 && (
              <>
                <div className="pt">Plans not started, made outside a chat</div>
                {outside.map((v) => (
                  <button
                    key={v.plan.id}
                    className="mi"
                    type="button"
                    onClick={() => {
                      onOpenPlan(v.plan.id);
                      setMenu(null);
                    }}
                  >
                    {v.plan.title || "Untitled plan"}
                  </button>
                ))}
              </>
            )}
            <hr />
            <button className="mi danger" type="button" onClick={() => (setMenu(null), setDeleting(true))}>
              Delete…
            </button>
          </div>
        )}
      </span>
      {deleting && (
        <DeleteProject
          project={project}
          {...(project.archivedAt ? { archived: true } : {})}
          onCancel={() => setDeleting(false)}
          onArchived={(p) => (setDeleting(false), onChange(p))}
          onDone={(said) => navigate("/", { state: { said } })}
        />
      )}
      <ErrorNotice error={error} />
    </header>
  );
}

/** Says an archived project takes nothing new, with Restore right there. */
function ArchivedNotice({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function restore() {
    setBusy(true);
    setError(undefined);
    try {
      onChange(await client.unarchiveProject(project.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="notice warn archnote" role="status">
      <span>This project is archived. Its plans can still be opened; it takes no new sources or plans.</span>
      <button className="mini" type="button" disabled={busy} onClick={() => void restore()}>
        Restore
      </button>
      <ErrorNotice error={error} />
    </div>
  );
}
