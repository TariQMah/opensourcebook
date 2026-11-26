import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { OutputSummary, PlanView, Project, ProjectGroup } from "../api/types";
import { useApi, useFormats } from "../app/context";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { Making } from "../design/Making";
import { Icon } from "../design/Icon";
import { Empty } from "../design/ui";
import { RowMenu } from "../design/RowMenu";
import { DeleteProject } from "./DeleteProject";
import { FolderCard, FolderHead, MoveToFolder, NewFolderTile } from "./HomeFolders";
import { NewProjectDialog } from "./NewProjectDialog";
import { ExampleCard, ProjectCardFace, ProjectCardFooter } from "./StartHere";
import { EXAMPLES } from "./examples";
import { makingNow } from "./planStatus";
import "./home.css";

interface ProjectSummary {
  project: Project;
  /** The newest thing made in it, for its picture. */
  newest?: OutputSummary;
  sourceCount: number;
  madeCount: number;
  plans: PlanView[];
}

/**
 * The projects grid and nothing above it. Every project card is alike: a
 * picture (with a tag for Example, or the making line with its Stop), its name,
 * and a fixed footer showing source and made counts. Everything lives in a project
 * (docs/DECISIONS.md #46). Projects can be kept in folders: Home shows the folders first, then the projects in none;
 * `?folder=<id>` shows one folder's projects, and search looks inside it. Searching on Home looks everywhere.
 */
export function Home() {
  const client = useApi();
  const [params, setParams] = useSearchParams();
  const search = (params.get("q") ?? "").trim();
  const folderId = params.get("folder");
  const [creating, setCreating] = useState(() => params.has("new"));

  const summaries = useLoad(async (): Promise<ProjectSummary[]> => {
    const projects = await client.all((q) => client.listProjects(q));
    return Promise.all(
      projects.map(async (project) => {
        const [made, counts, planList] = await Promise.all([
          client.projectOutputs(project.id, { limit: 1 }),
          client.projectCounts(project.id).catch(() => undefined),
          client.listPlans(project.id).catch(() => []),
        ]);
        let sourceCount = counts?.sources;
        let madeCount = counts?.outputs;
        if (sourceCount === undefined || madeCount === undefined) {
          const [sources, outputs] = await Promise.all([
            client.all((q) => client.projectSources(project.id, q)).catch(() => []),
            client.all((q) => client.projectOutputs(project.id, q)).catch(() => []),
          ]);
          sourceCount = sources.length;
          madeCount = outputs.length;
        }
        const relevant = planList.filter((p) => p.status === "running" || (p.status === "done" && p.counts.done < p.counts.total));
        const loadedPlans = await Promise.all(relevant.map((p) => client.getPlan(p.id).catch(() => undefined)));
        return {
          project,
          ...(made.rows[0] ? { newest: made.rows[0] } : {}),
          sourceCount,
          madeCount,
          plans: loadedPlans.filter((p): p is PlanView => p !== undefined),
        };
      }),
    );
  }, [client]);

  const hasRunning = (summaries.data ?? []).some((s) => s.plans.some((p) => p.plan.status === "running"));
  const reloadSummaries = summaries.reload;
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => void reloadSummaries(), 10_000);
    return () => window.clearInterval(timer);
  }, [hasRunning, reloadSummaries]);

  const archived = useLoad(() => client.all((q) => client.listProjects({ ...q, archived: "only" })), [client]);
  // An engine from before folders has none; Home is then one flat list as before.
  const groups = useLoad(() => client.listGroups().catch((): ProjectGroup[] => []), [client]);
  const example = useLoad(() => (EXAMPLES[0] ? EXAMPLES[0].load() : Promise.resolve(undefined)), []);

  const list = summaries.data ?? [];
  const folders = groups.data ?? [];
  const known = new Set(folders.map((g) => g.id));
  const folderOf = (p: Project) => (p.groupId && known.has(p.groupId) ? p.groupId : undefined);
  const folder = folderId ? folders.find((g) => g.id === folderId) : undefined;
  const folderGone = Boolean(folderId) && groups.data !== undefined && !folder;
  const firstTime = !folderId && summaries.data !== undefined && list.length === 0 && archived.data !== undefined && archived.data.length === 0 && folders.length === 0;
  const matches = (title: string) => title.toLowerCase().includes(search.toLowerCase());
  // In a folder: its projects. On Home: the projects in no folder, or, while searching, every project that matches.
  const inView = folder ? list.filter((s) => folderOf(s.project) === folder.id) : search ? list : list.filter((s) => !folderOf(s.project));
  const visible = search ? inView.filter((s) => matches(s.project.title)) : inView;
  const shownFolders = folderId ? [] : search ? folders.filter((g) => matches(g.title)) : folders;
  const countIn = (id: string) => list.filter((s) => folderOf(s.project) === id).length;
  const exampleMatches = firstTime && Boolean(EXAMPLES[0]) && (!search || Boolean(example.data?.project.title.toLowerCase().includes(search.toLowerCase())));
  // What the last delete took, said once under the list (the list itself may be gone with it).
  const arrived = useLocation().state as { said?: string } | null;
  const [gone, setGone] = useState<string | undefined>(typeof arrived?.said === "string" ? arrived.said : undefined);

  function clearSearch() {
    const nextParams = new URLSearchParams(params);
    nextParams.delete("q");
    setParams(nextParams, { replace: true });
  }

  function closeCreate() {
    setCreating(false);
    if (params.has("new")) {
      const nextParams = new URLSearchParams(params);
      nextParams.delete("new");
      setParams(nextParams, { replace: true });
    }
  }

  function reloadAll() {
    void summaries.reload();
    void archived.reload();
    void groups.reload();
  }

  function leaveFolder(said: string) {
    const nextParams = new URLSearchParams(params);
    nextParams.delete("folder");
    setParams(nextParams, { replace: true });
    setGone(said);
    reloadAll();
  }

  return (
    <>
      {folder ? <FolderHead group={folder} count={countIn(folder.id)} onChange={reloadAll} onDeleted={leaveFolder} /> : <h1 className="sr-only">Projects</h1>}
      <LoadState loading={summaries.loading && !summaries.data} error={summaries.error} what="projects" onRetry={() => void summaries.reload()} />
      {folderGone ? (
        <Empty title="This folder is no longer here">
          Its projects are on <Link to="/">Home</Link>.
        </Empty>
      ) : folder && summaries.data && visible.length === 0 && !search ? (
        <Empty title="Nothing in this folder yet">Move a project here from its menu (⋯), with Move to folder.</Empty>
      ) : search && summaries.data && visible.length === 0 && shownFolders.length === 0 && !exampleMatches ? (
        <Empty title={`Nothing matches “${search}”`}>
          Try fewer words, or{" "}
          <button className="link" type="button" onClick={clearSearch}>
            clear the search
          </button>
          .
        </Empty>
      ) : (
        summaries.data && (
          <div className="grid">
            {!search && !folder && (
              <button type="button" className="pc-new" onClick={() => setCreating(true)}>
                <Icon name="plus" />
                <span>New project</span>
              </button>
            )}
            {!search && !folder && list.length > 0 && <NewFolderTile onMade={() => void groups.reload()} />}
            {firstTime && <ExampleCard {...(example.data ? { bundle: example.data } : {})} filter={search} />}
            {shownFolders.map((group) => (
              <FolderCard key={group.id} group={group} count={countIn(group.id)} />
            ))}
            {visible.map((summary) => (
              <ProjectCard key={summary.project.id} summary={summary} folders={folders} onChange={reloadAll} onDeleted={setGone} />
            ))}
          </div>
        )
      )}
      {!search && !folderId && archived.data && archived.data.length > 0 && (
        <Archived projects={archived.data} onChange={reloadAll} onDeleted={setGone} />
      )}
      {gone && (
        <p className="gone-note" role="status">
          {gone}
        </p>
      )}
      {creating && <NewProjectDialog onClose={closeCreate} />}
    </>
  );
}

/** A project card: picture with tags, name, and fixed counts footer; its menu renames, archives or deletes it. */
function ProjectCard({ summary, folders, onChange, onDeleted }: { summary: ProjectSummary; folders: ProjectGroup[]; onChange: () => void; onDeleted: (said: string | undefined) => void }) {
  const client = useApi();
  const formats = useFormats();
  const { project, newest, sourceCount, madeCount, plans } = summary;
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [error, setError] = useState<unknown>();

  const making = makingNow(plans, formats);
  const narrow = useNarrow();

  async function act(run: () => Promise<unknown>) {
    setError(undefined);
    try {
      await run();
      setRenaming(false);
      onChange();
    } catch (e) {
      setError(e);
    }
  }
  function rename(e: FormEvent) {
    e.preventDefault();
    if (title.trim() && title.trim() !== project.title) void act(() => client.updateProject(project.id, { title: title.trim() }));
    else setRenaming(false);
  }

  if (renaming)
    return (
      <form className="card pc renaming" onSubmit={rename}>
        <input
          className="ipt"
          autoFocus
          aria-label="Project title"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (setTitle(project.title), setRenaming(false))}
        />
        <span className="acts">
          <button className="mini go" type="submit">
            Save
          </button>
          <button className="mini" type="button" onClick={() => (setTitle(project.title), setRenaming(false))}>
            Cancel
          </button>
        </span>
        <ErrorNotice error={error} />
      </form>
    );
  return (
    <div className="pcw">
      <Link className="card pc" to={`/projects/${project.id}`}>
        <ProjectCardFace {...(newest ? { newest } : {})} formats={formats} example={project.settings.example !== undefined} />
        <div className="pbody">
          <h3 title={project.title}>{project.title}</h3>
          <ProjectCardFooter sources={sourceCount} made={madeCount} />
        </div>
      </Link>
      {making && (
        <span className="ptags live">
          <Making
            look="tag"
            state={making.waiting ? "waiting" : "making"}
            text={makingText(making, narrow)}
            onStop={() => void act(() => client.cancel(making.planId))}
          />
        </span>
      )}
      <RowMenu
        className="pmenu"
        name={project.title}
        items={[
          { label: "Rename", run: () => setRenaming(true) },
          { label: "Move to folder…", run: () => setMoving(true) },
          { label: "Archive", note: "keeps everything", run: () => void act(() => client.archiveProject(project.id)) },
          { label: "Delete…", danger: true, run: () => (onDeleted(undefined), setDeleting(true)) },
        ]}
      />
      <ErrorNotice error={error} />
      {moving && (
        <MoveToFolder
          project={project}
          groups={folders}
          onCancel={() => setMoving(false)}
          onMoved={() => {
            setMoving(false);
            onChange();
          }}
        />
      )}
      {deleting && (
        <DeleteProject
          project={project}
          onCancel={() => setDeleting(false)}
          onArchived={() => {
            setDeleting(false);
            onChange();
          }}
          onDone={(said) => {
            setDeleting(false);
            onDeleted(said);
            onChange();
          }}
        />
      )}
    </div>
  );
}

/** The words of the making tag: "Making video · 4 min"; on a phone only the minutes ("4 min"), or "Making" when none are known. */
function makingText(m: { what?: string; waiting: boolean; minutes?: number }, narrow: boolean): string {
  const left = m.minutes !== undefined ? `${m.minutes} min` : undefined;
  if (narrow) return left ?? (m.waiting ? "Waiting" : "Making");
  const head = `${m.waiting ? "Waiting" : "Making"}${m.what ? ` ${m.what}` : ""}`;
  return left ? `${head} · ${left}` : head;
}

const NARROW = "(max-width: 640px)";
/** Whether the window is phone width, so a card keeps its tag short. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia?.(NARROW);
      query?.addEventListener?.("change", notify);
      return () => query?.removeEventListener?.("change", notify);
    },
    () => window.matchMedia?.(NARROW).matches ?? false,
    () => false,
  );
}

/**
 * Archived projects, folded under one quiet line; each opens, comes back with
 * Restore, or is deleted for good. Archive is the everyday way to put one
 * away, so deleting is offered only here.
 */
function Archived({ projects, onChange, onDeleted }: { projects: Project[]; onChange: () => void; onDeleted: (said: string | undefined) => void }) {
  const client = useApi();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const [deleting, setDeleting] = useState<Project>();
  async function restore(id: string) {
    setError(undefined);
    try {
      await client.unarchiveProject(id);
      onChange();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <section className="archived" aria-label="Archived projects">
      <button className="link" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Archived ({projects.length})
        <Icon name={open ? "up" : "down"} />
      </button>
      {open && (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}>{p.title}</Link>
              <button className="mini" type="button" onClick={() => void restore(p.id)}>
                Restore
              </button>
              <button className="mini quietdanger" type="button" aria-label={`Delete ${p.title}`} onClick={() => (onDeleted(undefined), setDeleting(p))}>
                Delete…
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={error} />
      {deleting && (
        <DeleteProject
          project={deleting}
          archived
          onCancel={() => setDeleting(undefined)}
          onDone={(said) => {
            setDeleting(undefined);
            onDeleted(said);
            onChange();
          }}
        />
      )}
    </section>
  );
}
