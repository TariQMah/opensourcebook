import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { FormatDescriptor, Item, PlanView } from "../api/types";
import { Ctx } from "../app/context";
import { forgetThisComputer } from "../app/thisComputer";
import { PlanCard } from "./PlanCard";
import { PlanContext } from "./PlanContext";
import { openStage, plannedLine, sizeText, buildStages } from "./planModel";

const formats: FormatDescriptor[] = [
  { id: "video", label: "video", plural: "videos", colorSlot: 1, icon: "play", ready: true, defaults: { minutes: 0 }, settings: [{ key: "minutes", label: "Length", kind: "number", unit: "min" }] },
  { id: "quiz", label: "quiz", plural: "quizzes", colorSlot: 3, icon: "check", ready: true, defaults: { questions: 0 }, settings: [{ key: "questions", label: "Questions", kind: "number" }] },
];

function item(id: string, level: number, type: string, extra: Partial<Item> = {}): Item {
  return { id, level, ord: 0, type, title: `Item ${id}`, settings: {}, enabled: true, status: "pending", sources: [], done: false, ...extra };
}

function view(items: Item[], stages: PlanView["stages"] = []): PlanView {
  return {
    plan: { id: "p", projectId: "pr", title: "Term", status: "draft", version: 1, createdAt: "", updatedAt: "" } as PlanView["plan"],
    stages,
    items,
    edges: [],
    counts: { total: items.length, done: 0 },
    estimateUsd: 0,
    issues: [],
  };
}

function show(items: Item[], stages: PlanView["stages"] = []) {
  const app = { client: {} as ApiClient, formats, edgeKinds: [], refreshInbox: () => undefined };
  const plan = { view: view(items, stages), formats, sources: [], editable: true, edit: async () => true, act: async () => true, busy: false };
  return render(
    <MemoryRouter>
      <Ctx.Provider value={app}>
        <PlanContext.Provider value={plan}>
          <PlanCard />
        </PlanContext.Provider>
      </Ctx.Provider>
    </MemoryRouter>,
  );
}

describe("a plan's size and what each item will be", () => {
  it("counts each format and adds up the minutes where there are any, leaving out what is left out", () => {
    const items = [
      item("a", 1, "video", { settings: { minutes: 60 } }),
      item("b", 1, "video", { settings: { minutes: 65 } }),
      item("c", 2, "quiz", { settings: { questions: 20 } }),
      item("d", 2, "video", { enabled: false, settings: { minutes: 9 } }),
    ];
    expect(sizeText(items, formats)).toBe("2 videos · about 2 h 5 min · 1 quiz");
    expect(plannedLine({ plannedAs: ["Drawn scenes", "Chalkboard", "about 8 min"] }, "video")).toBe("video · Drawn scenes · Chalkboard · about 8 min");
    // Once made, the row says what was made, not what was planned.
    expect(plannedLine({ plannedAs: ["Your agent", "8 questions"], madeAs: ["Your agent", "6 questions of 8 planned"] }, "quiz")).toBe("quiz · Your agent · 6 questions of 8 planned");
    expect(plannedLine({}, "quiz")).toBe("quiz");
  });

  it("says a length the same way in the size line as the engine says it on a row: seconds under a minute", () => {
    expect(sizeText([item("a", 1, "video", { settings: { minutes: 0.5 } })], formats)).toBe("1 video · about 30 s");
    expect(sizeText([item("a", 1, "video", { settings: { minutes: 1.5 } })], formats)).toBe("1 video · about 1.5 min");
  });

  it("opens the first stage with something not yet gone through", () => {
    const items = [item("a", 1, "video", { done: true }), item("b", 2, "video"), item("c", 3, "quiz")];
    expect(openStage(buildStages(items, []))).toBe(2);
  });
});

describe("the plan card", () => {
  it("shows a small plan whole, with its size and each item as planned", () => {
    show([item("a", 1, "video", { settings: { minutes: 8 }, plannedAs: ["Drawn scenes", "Chalkboard", "about 8 min"] }), item("b", 2, "quiz", { plannedAs: ["Your agent", "10 questions"] })]);
    expect(screen.getByText("1 video · about 8 min · 1 quiz")).toBeInTheDocument();
    expect(screen.getByText("video · Drawn scenes · Chalkboard · about 8 min")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Show|Hide) / })).toBeNull();
  });

  it("opens a made item when its title is clicked; what it was planned as is one more button away", () => {
    show([item("a", 1, "quiz", { outputId: "o1", status: "done" }), item("b", 2, "quiz")]);
    expect(screen.getByRole("link", { name: /^Item a/ })).toHaveAttribute("href", "/outputs/o1");
    expect(screen.getByRole("button", { name: "Details for Item a" })).toBeInTheDocument();
    // Not made yet: the title opens what it is for.
    expect(screen.getByRole("button", { name: "Details for Item b" })).toBeInTheDocument();
  });

  it("a made item's row says what was made and, when the maker left one, why its size differs from the plan", () => {
    show([item("a", 1, "quiz", { outputId: "o1", status: "done", plannedAs: ["Your agent", "8 questions"], madeAs: ["Your agent", "6 questions of 8 planned"], madeNote: "The notes settle six ideas worth testing." })]);
    expect(screen.getByText("quiz · Your agent · 6 questions of 8 planned")).toBeInTheDocument();
    expect(screen.getByText("The notes settle six ideas worth testing.")).toBeInTheDocument();
  });

  it("a made video Open Sourcebook kept over its checks says what they found on its row", () => {
    const NOTE = `Kept as rendered, though Open Sourcebook's checks found: scene 4's narration: names "passage 2", words only the writer saw.`;
    show([item("a", 1, "video", { outputId: "o1", status: "done", madeNote: NOTE })]);
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("a queued item in a started plan says what it waits for", () => {
    const STEP = "Waiting to start: “How a bill becomes a law” is being made first. Open Sourcebook carried it on after a restart.";
    const app = { client: {} as ApiClient, formats, edgeKinds: [], refreshInbox: () => undefined };
    const queued = item("a", 1, "video", { status: "queued", job: { id: "j", status: "queued", stage: "queued", progress: 0, attempt: 1, step: STEP } as Item["job"] });
    const started = { ...view([queued]), plan: { ...view([queued]).plan, status: "running", kickedOffAt: "2026-11-19T13:00:00.000Z" } as PlanView["plan"] };
    render(
      <MemoryRouter>
        <Ctx.Provider value={app}>
          <PlanContext.Provider value={{ view: started, formats, sources: [], editable: false, edit: async () => true, act: async () => true, busy: false }}>
            <PlanCard />
          </PlanContext.Provider>
        </Ctx.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText(STEP)).toBeInTheDocument();
  });

  describe("Show job files", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      forgetThisComputer();
    });
    const running = (files: boolean) => item("a", 1, "video", { status: "running", job: { id: "j1", status: "running", stage: "writing", progress: 0.2, attempt: 1, step: "Writing", ...(files ? { files: true } : {}) } as Item["job"] });
    const renderWith = (it: Item, client: Partial<ApiClient>) => {
      const app = { client: client as ApiClient, formats, edgeKinds: [], refreshInbox: () => undefined };
      const started = { ...view([it]), plan: { ...view([it]).plan, status: "running", kickedOffAt: "2026-11-19T13:00:00.000Z" } as PlanView["plan"] };
      return render(
        <MemoryRouter>
          <Ctx.Provider value={app}>
            <PlanContext.Provider value={{ view: started, formats, sources: [], editable: false, edit: async () => true, act: async () => true, busy: false }}>
              <PlanCard />
            </PlanContext.Provider>
          </Ctx.Provider>
        </MemoryRouter>,
      );
    };

    it("opens a video job's folder from its row, in the browser on this computer", async () => {
      vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "browser" }));
      const shown: string[] = [];
      renderWith(running(true), { showJobFiles: async (id: string) => (shown.push(id), { shown: true as const }) });
      await userEvent.click(await screen.findByRole("button", { name: "Show job files" }));
      expect(shown).toEqual(["j1"]);
    });

    it("is not offered on a paired phone, nor for a job with no folder", async () => {
      vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "device" }));
      renderWith(running(true), {});
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole("button", { name: "Show job files" })).toBeNull();
      forgetThisComputer();
      vi.stubGlobal("fetch", async () => Response.json({ in: true, as: "browser" }));
      renderWith(running(false), {});
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole("button", { name: "Show job files" })).toBeNull();
    });
  });

  it("a video that will have no sound says so quietly on its row, with what to do, until it is made", () => {
    const NOTE = "No voice set up: videos are made without sound, with captions carrying the words. For a voice, pick one in Settings, under Voice.";
    show([item("a", 1, "video", { notices: [NOTE] }), item("b", 2, "quiz")]);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
  });

  it("folds a big plan to a line per part with its size, the first open, and opens another on a tap", async () => {
    // Six parts of 20 lessons, each lesson its own stage; the first stage of each part is labelled.
    const items = Array.from({ length: 120 }, (_, k) => item(`i${k}`, k + 1, "video", { title: `Lesson ${k + 1}`, settings: { minutes: 6 } }));
    show(items, Array.from({ length: 6 }, (_, p) => ({ level: p * 20 + 1, label: `Part ${p + 1}` })));
    expect(screen.getByText("120 videos · about 12 h")).toBeInTheDocument();
    // Only the open stage's rows are drawn.
    expect(screen.getAllByTestId("item")).toHaveLength(20);
    const second = screen.getByRole("region", { name: "Stage 21" });
    expect(within(second).getByText("20 videos · about 2 h")).toBeInTheDocument();
    await userEvent.click(within(second).getByRole("button", { name: "Show Part 2" }));
    expect(screen.getAllByTestId("item")).toHaveLength(40);
    await userEvent.click(screen.getByRole("button", { name: "Hide Part 1" }));
    expect(screen.getAllByTestId("item")).toHaveLength(20);
    expect(screen.getByText("Lesson 21")).toBeInTheDocument();
  });
});

describe("an item that waits for its voice", () => {
  type Call = [string, string, string | undefined];
  function started(items: Item[], calls: Call[]) {
    const client = { retryItem: async (planId: string, itemId: string, choice?: string) => (calls.push([planId, itemId, choice]), view(items)) } as unknown as ApiClient;
    const app = { client, formats, edgeKinds: [], refreshInbox: () => undefined };
    const v = view(items);
    v.plan = { ...v.plan, status: "running", kickedOffAt: "2026-11-19T10:00:00.000Z" };
    const plan = { view: v, formats, sources: [], editable: false, edit: async (run: () => Promise<PlanView>) => (await run(), true), act: async () => true, busy: false };
    return render(
      <MemoryRouter>
        <Ctx.Provider value={app}>
          <PlanContext.Provider value={plan}>
            <PlanCard />
          </PlanContext.Provider>
        </Ctx.Provider>
      </MemoryRouter>,
    );
  }
  const WORDS =
    "The voice account is out of credits, so the voice cannot speak. What was made of this video so far is kept. Add credits to the voice account and Open Sourcebook carries on by itself, or finish it now without sound, with the captions carrying the words.";
  const choice = { id: "without_sound", label: "Finish without sound" };
  const job = { id: "j", status: "waiting", stage: "waiting", progress: 0.6, attempt: 1, step: "Waiting for the voice…", waiting: { reason: "voice", words: WORDS, since: "", nextTryAt: "", tries: 1 }, choice };

  it("says why and what to do, and finishes it without sound when the person asks", async () => {
    const calls: Call[] = [];
    started([item("a", 1, "video", { status: "running", job })], calls);
    expect(screen.getByText(WORDS)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finish without sound" }));
    expect(calls).toEqual([["p", "a", "without_sound"]]);
  });

  it("after waiting a day it offers both: try again with the voice, or finish without sound", async () => {
    const calls: Call[] = [];
    const failedJob = { id: "j", status: "failed", stage: "failed", progress: 0.6, attempt: 1, choice };
    started([item("a", 1, "video", { status: "failed", errorMessage: "Open Sourcebook waited a day for the voice, and it still could not speak.", job: failedJob })], calls);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish without sound" }));
    expect(calls).toEqual([
      ["p", "a", undefined],
      ["p", "a", "without_sound"],
    ]);
  });
});
