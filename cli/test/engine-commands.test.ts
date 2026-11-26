import assert from "node:assert/strict";
import { quizText } from "../commands/readable.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeEngine, TOKEN } from "./fake-engine.ts";

const project = { id: "p1", title: "Course", settings: {}, createdAt: "t", updatedAt: "t" };
const source = (id: string, title: string, status = "ready") => ({ id, projectId: "p1", kind: "text", title, status, createdAt: "t", updatedAt: "t" });
const view = (id: string, title: string, text: string) => ({ source: { id, projectId: "p1", kind: "text", title }, extraction: { status: "ready", text, limitations: [] }, chunkCount: 2 });

test("project make remembers the project; later commands use it; the client token is sent and never printed", async () => {
  const fake = await fakeEngine({
    "POST /v1/projects": () => [201, { project }],
    "GET /v1/projects/:id/sources": () => ({ sources: [source("s1", "Notes")] }),
  });
  try {
    const made = await fake.command(["project", "make", "Course", "one", "--json"]);
    assert.equal(made.code, 0);
    assert.deepEqual(fake.calls[0]!.body, { title: "Course one" });
    assert.equal((made.json().project as { id: string }).id, "p1");
    assert.equal(made.json().url, "http://127.0.0.1:1/projects/p1");
    const listed = await fake.command(["source", "list", "--json"]);
    assert.equal(fake.calls.at(-1)!.path, "/v1/projects/p1/sources");
    assert.equal(fake.calls.at(-1)!.headers["x-client-token"], TOKEN);
    assert.deepEqual((listed.json().sources as unknown[]).length, 1);
    for (const r of [made, listed]) assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN));
  } finally {
    await fake.close();
  }
});

test("a project named with --project is kept for the next command once it worked; one the engine doesn't know is not", async () => {
  const fake = await fakeEngine({
    "GET /v1/projects/:id/sources": (c) => (c.path.includes("/nope/") ? [404, { error: "not_found", message: "Project not found" }] : { sources: [source("s1", "Notes")] }),
  });
  try {
    const before = await fake.command(["source", "list", "--json"]);
    assert.equal((before.json().error as { code: string }).code, "no_project");
    assert.equal((await fake.command(["source", "list", "--project", "p1", "--json"])).code, 0);
    const later = await fake.command(["source", "list", "--json"]);
    assert.equal(later.code, 0, later.out + later.err);
    assert.equal(fake.calls.at(-1)!.path, "/v1/projects/p1/sources");
    const wrong = await fake.command(["source", "list", "--project", "nope", "--json"]);
    assert.equal((wrong.json().error as { code: string }).code, "not_found");
    await fake.command(["source", "list", "--json"]);
    assert.equal(fake.calls.at(-1)!.path, "/v1/projects/p1/sources", "a failed command does not change the project used last");
  } finally {
    await fake.close();
  }
});

test("source add uploads a file with its name and type, then adds it to the project; a missing file is a plain sentence", async () => {
  const fake = await fakeEngine({
    "POST /v1/uploads": () => [201, { upload: { id: "u1" } }],
    "POST /v1/sources": (c) => [201, { source: { id: "s9", kind: "text", title: "Week one" }, extraction: { status: "ready" }, chunkCount: 3, sent: c.body }],
  });
  try {
    writeFileSync(join(fake.dir, "week one.md"), "# Week one\n\nWords.");
    const r = await fake.command(["source", "add", "week one.md", "--project", "p1", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    const upload = fake.calls[0]!;
    assert.equal(upload.headers["content-type"], "text/markdown");
    assert.equal(upload.headers["x-upload-filename"], "week one.md");
    assert.equal(upload.raw.toString(), "# Week one\n\nWords.");
    assert.deepEqual(fake.calls[1]!.body, { uploadId: "u1", projectId: "p1" });
    assert.deepEqual(r.json().sources, [{ source: { id: "s9", kind: "text", title: "Week one", status: "ready" }, chunkCount: 3 }]);

    const missing = await fake.command(["source", "add", "nope.pdf", "--project", "p1", "--json"]);
    assert.equal((missing.json().error as { code: string }).code, "file_not_found");
    const link = await fake.command(["source", "add", "https://example.com/a", "--project", "p1", "--json"]);
    assert.equal(link.code, 0);
    assert.deepEqual(fake.calls.at(-1)!.body, { url: "https://example.com/a", projectId: "p1" });
  } finally {
    await fake.close();
  }
});

test("source show, read and search work from the source's text, paragraph by paragraph", async () => {
  const text = "# Title\n\nFirst paragraph about magma cooling.\n\nSecond paragraph about layers of sediment.";
  const fake = await fakeEngine({
    "GET /v1/sources/:id": () => view("s1", "Notes", text),
    "GET /v1/projects/:id/sources": () => ({ sources: [source("s1", "Notes")] }),
  });
  try {
    const shown = (await fake.command(["source", "show", "s1", "--json"])).json();
    assert.equal(shown.paragraphs, 3);
    const read = (await fake.command(["source", "read", "s1", "--from", "2", "--to", "2", "--json"])).json();
    assert.deepEqual(read.paragraphs, [{ paragraph: 2, text: "First paragraph about magma cooling." }]);
    assert.equal(read.more, true);
    const found = (await fake.command(["source", "search", "sediment", "layers", "--project", "p1", "--json"])).json();
    assert.equal((found.found as Array<{ paragraph: number }>)[0]!.paragraph, 3);
  } finally {
    await fake.close();
  }
});

test("chat ask waits for a running reply and answers with numbered cites and their sources", async () => {
  let reads = 0;
  const done = {
    id: "m2", seq: 2, role: "assistant", text: "Slow cooling.",
    pieces: [{ kind: "text", text: "Slow cooling grows big crystals.", cites: [0] }],
    cites: [{ sourceId: "s1", spot: "passage", quote: "cools slowly" }],
    covered: true,
  };
  const fake = await fakeEngine({
    "POST /v1/projects/:id/chats": () => [201, { chat: { id: "c1", projectId: "p1" } }],
    "POST /v1/chats/:id/messages": () => ({ chat: { id: "c1", projectId: "p1" }, messages: [{ id: "m1", seq: 1, role: "user", text: "q" }, { id: "m2", seq: 2, role: "assistant", text: "", pieces: [], state: "running", steps: [] }] }),
    "GET /v1/chats/:id": () => (++reads < 3 ? { chat: { id: "c1", projectId: "p1" }, messages: [{ id: "m2", seq: 2, role: "assistant", text: "", state: "running", steps: [{ label: "Reading Notes", state: "running" }] }] } : { chat: { id: "c1", projectId: "p1" }, messages: [done] }),
    "GET /v1/projects/:id/sources": () => ({ sources: [source("s1", "Notes")] }),
  });
  try {
    const r = await fake.command(["chat", "ask", "why", "big", "crystals?", "--project", "p1", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.err, /Reading Notes/, "the live step goes to stderr");
    const a = r.json();
    assert.equal(a.chatId, "c1");
    assert.equal(a.answer, "Slow cooling grows big crystals. [1]");
    assert.deepEqual(a.cites, [{ n: 1, sourceId: "s1", source: "Notes", quote: "cools slowly" }]);
    assert.equal(a.covered, true);
    assert.deepEqual(fake.calls.find((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages")!.body, { text: "why big crystals?", from: "terminal" });
    const words = await fake.command(["chat", "ask", "again", "--chat", "c1", "--project", "p1"]);
    assert.match(words.out, /\[1\] Notes: "cools slowly"/);
  } finally {
    await fake.close();
  }
});

const item = (status: string, extra: Record<string, unknown> = {}) => ({ id: "i1", type: "quiz", title: "Check", level: 1, enabled: true, status, done: false, ...extra });
const planView = (status: string, itemStatus: string, extra: Record<string, unknown> = {}) => ({ plan: { id: "pl1", projectId: "p1", status }, items: [item(itemStatus, extra)], counts: { total: 1, done: 0 }, issues: [] });

test("plan make sends the request to the planner and answers with the plan it made", async () => {
  const fake = await fakeEngine({
    "GET /v1/projects/:id/sources": () => ({ sources: [source("s1", "Notes")] }),
    "POST /v1/projects/:id/chats": () => [201, { chat: { id: "c1", projectId: "p1" } }],
    "POST /v1/chats/:id/messages": () => ({ chat: { id: "c1", projectId: "p1" }, messages: [{ id: "m2", seq: 2, role: "assistant", text: "A plan.", pieces: [{ kind: "text", text: "A plan.", cites: [] }, { kind: "plan", planId: "pl1", action: "created" }] }] }),
    "GET /v1/plans/:id": () => planView("draft", "pending"),
  });
  try {
    const r = await fake.command(["plan", "make", "a", "short", "quiz", "--project", "p1", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal((fake.calls.find((c) => c.path === "/v1/chats/c1/messages")!.body as { text: string }).text, "/plan a short quiz");
    const plans = r.json().plans as Array<{ plan: { id: string } }>;
    assert.equal(plans[0]!.plan.id, "pl1");
  } finally {
    await fake.close();
  }
});

test("plan start approves a draft, starts it, and --wait follows it to the end with the live step", async () => {
  let reads = 0;
  const fake = await fakeEngine({
    "GET /v1/plans/:id": () => planView("draft", "pending"),
    "POST /v1/plans/:id/approve": () => planView("approved", "pending"),
    "POST /v1/plans/:id/start": () => planView("running", "queued"),
    "GET /v1/plans/:id/progress": () => (++reads < 3 ? planView("running", "running", { job: { step: "Writing question 2 of 3" } }) : planView("done", "done", { outputId: "o1" })),
  });
  try {
    const r = await fake.command(["plan", "start", "pl1", "--wait", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(fake.calls.filter((c) => c.method === "POST").map((c) => c.path), ["/v1/plans/pl1/approve", "/v1/plans/pl1/start"]);
    assert.match(r.err, /Check \(quiz\): running - Writing question 2 of 3/);
    assert.equal((r.json().plan as { status: string }).status, "done");
    const quick = await fake.command(["plan", "start", "pl1"]);
    assert.match(quick.out, /opensourcebook plan wait pl1/, "without --wait it returns at once and says how to follow");
  } finally {
    await fake.close();
  }
});

test("a failed item says why, and the wait ends with exit code 1", async () => {
  const fake = await fakeEngine({
    "GET /v1/plans/:id/progress": () => planView("failed", "failed", { errorMessage: "Your agent is not signed in." }),
  });
  try {
    const r = await fake.command(["plan", "wait", "pl1"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /failed - Your agent is not signed in\./);
  } finally {
    await fake.close();
  }
});

const quizPayload = {
  title: "Check",
  passMark: 0.5,
  feedback: "afterEach",
  questions: [
    { id: "q1", kind: "choice", topic: "Cooling", prompt: "What grows big crystals?", points: 1, options: ["Fast", "Slow"], answer: 1, feedback: { correct: "Yes.", incorrect: "No: slow." }, cites: [] },
    { id: "q2", kind: "choice", topic: "Layers", prompt: "What holds fossils?", points: 1, options: ["Sedimentary", "Igneous"], answer: 0, feedback: { correct: "Yes.", incorrect: "No." }, cites: [] },
  ],
};

test("quiz show hides the answers; quiz answer grades as the app does and records the result with the done tick", async () => {
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/plans/:id/progress": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/outputs/:id": () => ({ output: { id: "o1", type: "quiz", title: "Check", payload: quizPayload } }),
    "POST /v1/plans/:id/items/:item/done": (c) => ({ item: item("done", { done: true }), counts: { total: 1, done: 1 }, got: c.body }),
  });
  try {
    const shown = await fake.command(["quiz", "show", "i1", "--project", "p1", "--json"]);
    assert.ok(!JSON.stringify(shown.json()).includes('"answer"'), "no answers in quiz show");
    const r = await fake.command(["quiz", "answer", "i1", "1=B", "2=b", "--project", "p1", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    const result = r.json().result as { score: number; correct: number; passed: boolean };
    assert.equal(result.score, 0.5);
    assert.equal(result.correct, 1);
    const done = fake.calls.find((c) => c.path === "/v1/plans/pl1/items/i1/done")!.body as { done: boolean; outputId: string; result: { score: number } };
    assert.equal(done.done, true);
    assert.equal(done.outputId, "o1");
    assert.equal(done.result.score, 0.5);
    const bad = await fake.command(["quiz", "answer", "i1", "3=A", "--project", "p1", "--json"]);
    assert.match((bad.json().error as { message: string }).message, /no question 3; it has 2/);
  } finally {
    await fake.close();
  }
});

const kindsPayload = {
  title: "Kinds",
  passMark: 0.5,
  feedback: "afterEach",
  questions: [
    { id: "q1", kind: "order", topic: "t", prompt: "Order the stages", points: 1, items: ["egg", "larva", "adult"], shown: [2, 0, 1], feedback: { correct: "", incorrect: "" }, cites: [] },
    { id: "q2", kind: "match", topic: "t", prompt: "Match", points: 1, pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }], rights: [1, 0], feedback: { correct: "", incorrect: "" }, cites: [] },
    { id: "q3", kind: "label", topic: "t", prompt: "Name the parts", points: 1, picture: { url: "/v1/assets/x", caption: "A cell" }, marks: [{ mark: "A", answer: "nucleus" }, { mark: "B", answer: "wall" }], names: ["wall", "nucleus"], feedback: { correct: "", incorrect: "" }, cites: [] },
    { id: "q4", kind: "graph", topic: "t", prompt: "Draw it", points: 1, axes: { x: { min: 0, max: 10, step: 1 }, y: { min: 0, max: 50, step: 5 } }, line: [[0, 10], [4, 30]], feedback: { correct: "", incorrect: "" }, cites: [] },
    { id: "q5", kind: "complete", topic: "t", prompt: "Fill it in", points: 1, lines: ["v = d / t", "v = 120 / [[4]] = [[30]]"], feedback: { correct: "", incorrect: "" }, cites: [] },
  ],
};

test("quiz show and answer take every kind of question: an order, pairs, a picture's marks, a line and gaps", async () => {
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/plans/:id/progress": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/outputs/:id": () => ({ output: { id: "o1", type: "quiz", title: "Kinds", payload: kindsPayload } }),
    "POST /v1/plans/:id/items/:item/done": (c) => ({ item: item("done", { done: true }), counts: { total: 1, done: 1 }, got: c.body }),
  });
  try {
    const shown = await fake.command(["quiz", "show", "i1", "--project", "p1"]);
    assert.equal(shown.code, 0, shown.out + shown.err);
    assert.match(shown.out, /1\. adult\n   2\. egg\n   3\. larva/);
    assert.match(shown.out, /With: A\) 2  B\) 1/);
    assert.match(shown.out, /Marks: A, B/);
    assert.match(shown.out, /v = 120 \/ ___\(1\) = ___\(2\)/);
    const json = JSON.stringify((await fake.command(["quiz", "show", "i1", "--project", "p1", "--json"])).json());
    assert.ok(!json.includes('"answer"') && !json.includes("[[4]]") && !json.includes('"line"'), "no answers in quiz show");
    const r = await fake.command(["quiz", "answer", "i1", "1=2,3,1", "2=B,A", "3=b,a", "4=1:15,3:25", "5.1=4", "5.2=30", "--project", "p1", "--keep", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    const result = r.json().result as { score: number; questions: Array<{ outcome: string }> };
    assert.deepEqual(result.questions.map((q) => q.outcome), ["right", "right", "right", "right", "right"]);
    const wrong = await fake.command(["quiz", "answer", "i1", "2=A", "--project", "p1", "--keep", "--json"]);
    assert.match((wrong.json().error as { message: string }).message, /takes 2 answers separated by commas/);
  } finally {
    await fake.close();
  }
});

test("item get saves a video's file into the folder it is run in, and gives a set of flashcards as data", async () => {
  let type = "video";
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/plans/:id/progress": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/outputs/:id": () => ({ output: { id: "o1", type, title: "Cycle", payload: type === "video" ? { render: { assetId: "a1" } } : { cards: [] } } }),
    "GET /v1/assets/:id": () => [200, new Uint8Array([1, 2, 3])],
  });
  try {
    const r = await fake.command(["item", "get", "i1", "--project", "p1", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    const file = r.json().file as string;
    assert.equal(file, join(fake.dir, "i1.mp4"));
    assert.ok(existsSync(file));
    assert.deepEqual([...readFileSync(file)], [1, 2, 3]);
    type = "flashcards";
    const b = await fake.command(["item", "get", "i1", "--project", "p1", "--json"]);
    assert.deepEqual(b.json().payload, { cards: [] });
  } finally {
    await fake.close();
  }
});

test("item get prints a set of flashcards or a quiz as text to read, front and back, each cite a number with the words it quotes", async () => {
  let output: Record<string, unknown> = {
    id: "o1", type: "flashcards", title: "Heat",
    payload: {
      title: "How heat moves",
      cards: [
        { id: "c1", kind: "recall", section: "Basics", front: [{ type: "text", text: "Which way does heat flow?" }], back: [{ type: "text", text: "Heat flows **from warm to cool**." }, { type: "background", text: "Physicists call the end state equilibrium." }], cites: [{ sourceId: "s1", quote: "Heat moves from a warmer body", block: 1, locator: { page: 2 } }] },
        { id: "c2", kind: "cloze", front: [{ type: "cloze", text: "Insulators slow [[conduction]]." }], cites: [{ sourceId: "s1", quote: "slow conduction", block: 0 }] },
      ],
    },
  };
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/plans/:id/progress": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/outputs/:id": () => ({ output }),
    "GET /v1/sources/:id": () => ({ source: { id: "s1", title: "Heat notes" } }),
  });
  try {
    const r = await fake.command(["item", "get", "i1", "--project", "p1"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /A set of 2 flashcards\./);
    assert.match(r.out, /--- 1 of 2 · Basics · recall\nFront: Which way does heat flow\?\nBack: Heat flows from warm to cool\. \[1\]/);
    assert.match(r.out, /--- 2 of 2 · cloze\nFront: Insulators slow _____\.\nBack: Insulators slow \[conduction\]\. \[2\]/);
    assert.match(r.out, /\(Background, not from your source\) Physicists call/);
    assert.match(r.out, /\[1\] Heat notes, p\. 2: "Heat moves from a warmer body"/);
    output = { id: "o1", type: "quiz", title: "Check", payload: { title: "Check", questions: [{ id: "q1", kind: "worked", topic: "growth", prompt: "Work it out", steps: [{ prompt: "After a year?", input: "entries", values: ["1050"], unit: "dollars" }], feedback: { correct: "Each year adds 5%.", incorrect: "Multiply by 1.05." }, cites: [{ sourceId: "s1", quote: "multiplied by 1.05" }] }] } };
    const q = await fake.command(["item", "get", "i1", "--project", "p1"]);
    assert.match(q.out, /Step 1: After a year\?  -> 1050 dollars/);
    assert.match(q.out, /If not: Multiply by 1\.05\. \[1\]/);
  } finally {
    await fake.close();
  }
});

test("an engine error keeps its code and says what to do", async () => {
  const fake = await fakeEngine({
    "POST /v1/plans/:id/start": () => [422, { error: "plan_invalid", message: "The plan cannot start", issues: ["\"Quiz\" reads no sources: pick at least one"] }],
    "GET /v1/plans/:id": (c) => (c.path.endsWith("/nope") ? [404, { error: "not_found", message: "Plan not found" }] : planView("approved", "pending")),
  });
  try {
    const r = await fake.command(["plan", "start", "pl1", "--json"]);
    assert.deepEqual(r.json().error, { code: "plan_invalid", message: 'The plan cannot start. "Quiz" reads no sources: pick at least one.' });
    const missing = await fake.command(["plan", "show", "nope", "--json"]);
    assert.equal((missing.json().error as { code: string }).code, "not_found");
  } finally {
    await fake.close();
  }
});

test("project open gives the app's address of the project", async () => {
  const fake = await fakeEngine({ "GET /v1/projects/:id": () => ({ project }) });
  try {
    const r = await fake.command(["project", "open", "p1", "--json"]);
    // The browser is let in by a one-time address from the launcher, which then shows the project.
    assert.deepEqual(r.json(), { ok: true, url: "http://127.0.0.1:1/projects/p1", opened: false, open: "http://127.0.0.1:1/api/open?code=open-code-1&to=%2Fprojects%2Fp1" });
    const opener = await fake.command(["open", "--print", "--json"]);
    assert.deepEqual(opener.json(), { ok: true, url: "http://127.0.0.1:1", opened: false, open: "http://127.0.0.1:1/api/open?code=open-code-1&to=%2F" });
  } finally {
    await fake.close();
  }
});

test("pack on adds the pack to the project's settings and keeps the rest", async () => {
  let settings: Record<string, unknown> = { kept: 1 };
  const fake = await fakeEngine({
    "GET /v1/projects/:id": () => ({ project: { ...project, settings } }),
    "PATCH /v1/projects/:id": (c) => {
      settings = (c.body as { settings: Record<string, unknown> }).settings;
      return { project: { ...project, settings } };
    },
  });
  try {
    const on = await fake.command(["pack", "on", "study", "--project", "p1", "--json"]);
    assert.equal(on.code, 0, on.out);
    assert.deepEqual(settings, { kept: 1, packs: ["study"] });
    await fake.command(["pack", "on", "study", "--project", "p1"]);
    assert.deepEqual(settings.packs, ["study"], "turning it on twice keeps one");
    const unknown = await fake.command(["pack", "on", "nothing-like-it", "--project", "p1", "--json"]);
    assert.equal((unknown.json().error as { code: string }).code, "not_found");
    await fake.command(["pack", "off", "study", "--project", "p1"]);
    assert.deepEqual(settings, { kept: 1, packs: [] });
  } finally {
    await fake.close();
  }
});

test("item progress reads, sets and clears where the person stopped, through the item's progress route", async () => {
  let kept: unknown;
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "running" }] }),
    "GET /v1/plans/:id": () => planView("running", "done", { outputId: "o1" }),
    "GET /v1/plans/:id/progress": () => planView("running", "done", { outputId: "o1", ...(kept ? { progress: kept } : {}) }),
    "POST /v1/plans/:id/items/:item/progress": (c) => {
      kept = (c.body as { progress: unknown }).progress ?? undefined;
      return { item: item("done", kept ? { progress: kept } : {}) };
    },
  });
  try {
    assert.deepEqual((await fake.command(["item", "progress", "i1", "--project", "p1", "--json"])).json().progress, null);
    const set = await fake.command(["item", "progress", "i1", '{"bit": 3}', "--project", "p1", "--json"]);
    assert.deepEqual(set.json().progress, { bit: 3 });
    assert.deepEqual(fake.calls.at(-1)!.body, { progress: { bit: 3 } });
    await fake.command(["item", "progress", "i1", "--clear", "--project", "p1"]);
    assert.deepEqual(fake.calls.at(-1)!.body, { progress: null });
    const bad = await fake.command(["item", "progress", "i1", "{bit", "--project", "p1", "--json"]);
    assert.equal((bad.json().error as { code: string }).code, "bad_arguments");
  } finally {
    await fake.close();
  }
});

test("make sends the shape's own command and starts it at once; --wait follows it; an unknown shape lists what can be made", async () => {
  let reads = 0;
  const fake = await fakeEngine({
    "GET /v1/skills": () => ({ skills: [], commands: [{ command: "plan", label: "plan", about: "a plan", skill: "planning" }, { command: "quiz", label: "quiz", about: "questions that check you", skill: "make", format: "quiz" }] }),
    "GET /v1/projects/:id/sources": () => ({ sources: [source("s1", "Notes")] }),
    "POST /v1/projects/:id/chats": () => [201, { chat: { id: "c1", projectId: "p1" } }],
    "POST /v1/chats/:id/messages": () => ({ chat: { id: "c1", projectId: "p1" }, messages: [{ id: "m2", seq: 2, role: "assistant", text: "Making a quiz.", pieces: [{ kind: "text", text: "Making a five-question quiz.", cites: [] }, { kind: "plan", planId: "pl1", action: "created", made: "made" }] }] }),
    "GET /v1/plans/:id/progress": () => (++reads < 2 ? planView("running", "running", { job: { step: "Writing question 2 of 5" } }) : planView("done", "done", { outputId: "o1" })),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1" }),
  });
  try {
    const r = await fake.command(["make", "quiz", "the", "heart's", "loops", "--project", "p1", "--wait", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal((fake.calls.find((c) => c.path === "/v1/chats/c1/messages")!.body as { text: string }).text, "/quiz the heart's loops");
    // Nothing to approve or start: it was started by the engine.
    assert.equal(fake.calls.some((c) => /approve|start/.test(c.path)), false);
    assert.match(r.err, /Writing question 2 of 5/);
    assert.equal((r.json().plan as { plan: { status: string } }).plan.status, "done");
    const wrong = await fake.command(["make", "zine", "--project", "p1", "--json"]);
    assert.equal(wrong.code, 1);
    assert.equal((wrong.json().error as { code: string }).code, "unknown_shape");
    assert.match((wrong.json().error as { message: string }).message, /quiz \(questions that check you\)/);
    assert.doesNotMatch((wrong.json().error as { message: string }).message, /plan/);
    // With no project picked yet, a shape Open Sourcebook doesn't make still says so first.
    rmSync(join(fake.home, "command.json"), { force: true });
    const unpicked = await fake.command(["make", "podcast", "--json"]);
    assert.equal((unpicked.json().error as { code: string }).code, "unknown_shape");
  } finally {
    await fake.close();
  }
});

test("cards review gives the cards due (all of them the first time), and cards mark keeps each one with the app's spacing rule", async () => {
  const set = {
    title: "Heat",
    cards: [
      { id: "c1", kind: "recall", front: [{ type: "text", text: "Which way does heat flow?" }], back: [{ type: "text", text: "Warm to cool." }], cites: [] },
      { id: "c2", kind: "cloze", front: [{ type: "cloze", text: "Insulators slow [[conduction]]." }], cites: [] },
      { id: "c3", kind: "explain", front: [{ type: "text", text: "Heat is energy moving." }], cites: [] },
    ],
  };
  let progress: unknown;
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1", type: "flashcards", ...(progress ? { progress } : {}) }),
    "GET /v1/plans/:id/progress": () => planView("done", "done", { outputId: "o1", type: "flashcards" }),
    "GET /v1/outputs/:id": () => ({ output: { id: "o1", type: "flashcards", title: "Heat", payload: set } }),
    "POST /v1/plans/:id/items/:item/progress": (c) => {
      progress = (c.body as { progress: unknown }).progress;
      return { item: item("done") };
    },
  });
  try {
    const first = await fake.command(["cards", "review", "i1", "--project", "p1", "--json"]);
    assert.equal(first.code, 0, first.out + first.err);
    const shown = first.json().cards as Array<{ n: number; front: string; back: string; marked: string }>;
    assert.deepEqual(shown.map((c) => [c.n, c.front, c.back, c.marked]), [
      [1, "Which way does heat flow?", "Warm to cool.", "self"],
      [2, "Insulators slow _____.", "Insulators slow [conduction].", "self"],
      [3, "Heat is energy moving.", "", "none"],
    ]);
    const marked = await fake.command(["cards", "mark", "i1", "1=got", "c2=not", "--project", "p1"]);
    assert.equal(marked.code, 0, marked.out + marked.err);
    assert.match(marked.out, /c1: got it, back tomorrow\nc2: not yet, back in 10 minutes/);
    const kept = progress as { cards: Record<string, { box: number; seen: number }> };
    assert.equal(kept.cards.c1!.box, 1);
    assert.equal(kept.cards.c2!.box, 0);
    // Nothing is due right away now: the missed card waits ten minutes, the got one a day.
    const after = await fake.command(["cards", "review", "i1", "--project", "p1"]);
    assert.match(after.out, /Nothing is due now; the next card comes back in 10 minutes/);
    const bad = await fake.command(["cards", "mark", "i1", "3=got", "--project", "p1", "--json"]);
    assert.match((bad.json().error as { message: string }).message, /only read/);
  } finally {
    await fake.close();
  }
});

test("cards review puts a picture to label and a line to draw, each marked by its answer", async () => {
  const set = {
    title: "Heart",
    cards: [
      { id: "c1", kind: "ask", front: [{ type: "labelPicture", prompt: "Name the chambers.", url: "/v1/assets/a1", caption: "Figure 2", marks: [{ mark: "A", answer: "right atrium" }, { mark: "B", answer: "left ventricle" }], extra: ["aorta"] }], cites: [] },
      { id: "c2", kind: "ask", front: [{ type: "drawLine", prompt: "Draw the volume.", axes: { x: { min: 0, max: 10, step: 1, label: "minutes" }, y: { min: 0, max: 60, step: 5 } }, line: [[0, 5], [8, 45]] }], cites: [] },
    ],
  };
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1", type: "flashcards" }),
    "GET /v1/plans/:id/progress": () => planView("done", "done", { outputId: "o1", type: "flashcards" }),
    "GET /v1/outputs/:id": () => ({ output: { id: "o1", type: "flashcards", title: "Heart", payload: set } }),
  });
  try {
    const r = await fake.command(["cards", "review", "i1", "--project", "p1", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    const shown = r.json().cards as Array<{ front: string; marked: string }>;
    assert.deepEqual(shown.map((c) => c.marked), ["answer", "answer"]);
    assert.equal(shown[0]!.front, "Check: Name the chambers.\n  (a picture: Figure 2)\n  A: ...\n  B: ...\n  Names: aorta; left ventricle; right atrium");
    assert.equal(shown[1]!.front, "Check: Draw the volume.\n  (draw a straight line through two points: minutes from 0 to 10 in steps of 1; y from 0 to 60 in steps of 5)");
  } finally {
    await fake.close();
  }
});

test("item ask writes in a made thing's thread at where the person stopped (or --at), waits, and prints the answer; item thread prints it", async () => {
  const at = { at: 0, responses: { q1: { choice: 0 } } };
  const about = { item: "i1", plan: "pl1", format: "quiz", title: "Check", at, label: "question 1 · wrong" };
  let reads = 0;
  const done = { id: "m2", seq: 2, role: "assistant", text: "A is wrong.", pieces: [{ kind: "text", text: "The notes say B.", cites: [0] }], cites: [{ sourceId: "s1", spot: "passage", quote: "it is B" }], about };
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1", progress: at }),
    "GET /v1/plans/:id/progress": () => planView("done", "done", { outputId: "o1" }),
    "POST /v1/plans/:id/items/:item/thread": () => ({ chat: { id: "c9", projectId: "p1" }, created: true, messages: [{ id: "m1", seq: 1, role: "user", text: "why not A?", about }, { id: "m2", seq: 2, role: "assistant", text: "", state: "running", steps: [], about }] }),
    "GET /v1/chats/:id": () => (++reads < 2 ? { chat: { id: "c9", projectId: "p1" }, messages: [{ id: "m2", seq: 2, role: "assistant", text: "", state: "running", steps: [{ label: "Reading Notes", state: "running" }] }] } : { chat: { id: "c9", projectId: "p1" }, messages: [done] }),
    "GET /v1/plans/:id/items/:item/thread": () => ({ chat: { id: "c9", projectId: "p1" }, messages: [{ id: "m1", seq: 1, role: "user", text: "why not A?", about }, done] }),
    "GET /v1/projects/:id/sources": () => ({ sources: [source("s1", "Notes")] }),
  });
  try {
    const r = await fake.command(["item", "ask", "i1", "why", "not", "A?", "--project", "p1", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(fake.calls.find((c) => c.method === "POST")!.body, { text: "why not A?", at, from: "terminal" });
    assert.match(r.err, /Reading Notes/);
    const a = r.json();
    assert.equal(a.chatId, "c9");
    assert.equal(a.created, true);
    assert.deepEqual(a.about, { item: "i1", label: "question 1 · wrong" });
    assert.equal(a.answer, "The notes say B. [1]");
    await fake.command(["item", "ask", "i1", "and", "here?", "--at", '{"at": 0}', "--project", "p1"]);
    assert.deepEqual((fake.calls.filter((c) => c.method === "POST").at(-1)!.body as { at: unknown }).at, { at: 0 });
    const bad = await fake.command(["item", "ask", "i1", "hm", "--at", "nope", "--project", "p1", "--json"]);
    assert.notEqual(bad.code, 0);
    const shown = await fake.command(["item", "thread", "i1", "--project", "p1"]);
    assert.equal(shown.code, 0, shown.out + shown.err);
    assert.match(shown.out, /You \(question 1 · wrong\): why not A\?/);
    assert.match(shown.out, /Open Sourcebook: The notes say B\. \[1\]/);
  } finally {
    await fake.close();
  }
});

const NO_SOUND = "No voice set up: videos are made without sound, with captions carrying the words. For a voice, pick one in Settings, under Voice.";

test("a video without sound is said so in a line and in a field by make, item status, item get and maker list (and by check, in its own test)", async () => {
  const silent = (status: string, extra: Record<string, unknown> = {}) => ({ ...planView("done", status, { type: "video", title: "Levers", notices: [NO_SOUND], ...extra }) });
  const fake = await fakeEngine({
    "GET /v1/skills": () => ({ skills: [], commands: [{ command: "video", label: "video", about: "an explainer", skill: "make", format: "video" }] }),
    "GET /v1/projects/:id/sources": () => ({ sources: [source("s1", "Notes")] }),
    "POST /v1/projects/:id/chats": () => [201, { chat: { id: "c1", projectId: "p1" } }],
    "POST /v1/chats/:id/messages": () => ({ chat: { id: "c1", projectId: "p1" }, messages: [{ id: "m2", seq: 2, role: "assistant", text: "Making it.", pieces: [{ kind: "text", text: "Making a video. It will have no sound.", cites: [] }, { kind: "plan", planId: "pl1", action: "created" }] }], plans: [] }),
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    // The followed progress view has no notices; the plan itself does.
    "GET /v1/plans/:id/progress": () => planView("done", "done", { type: "video", title: "Levers", outputId: "o1" }),
    "GET /v1/plans/:id": () => silent("done", { outputId: "o1" }),
    "GET /v1/outputs/:id": () => ({ output: { id: "o1", type: "video", title: "Levers", payload: { render: { assetId: "a1" } } } }),
    "GET /v1/assets/:id": () => [200, new Uint8Array([1])],
    "GET /v1/formats": () => ({ formats: [] }),
    "GET /v1/video-makers": () => ({ makers: [{ id: "scenes", label: "Drawn scenes", available: true, styles: 2, notice: NO_SOUND }] }),
  });
  try {
    const made = await fake.command(["make", "video", "levers", "--project", "p1", "--wait", "--json"]);
    assert.equal(made.code, 0, made.out + made.err);
    assert.deepEqual(made.json().notices, [NO_SOUND]);
    const plain = await fake.command(["make", "video", "levers", "--project", "p1", "--wait"]);
    assert.ok(plain.out.trimEnd().endsWith(NO_SOUND), plain.out);
    const status = await fake.command(["item", "status", "i1", "--project", "p1"]);
    assert.ok(status.out.trimEnd().endsWith(NO_SOUND), status.out);
    assert.deepEqual((await fake.command(["item", "status", "i1", "--project", "p1", "--json"])).json().notices, [NO_SOUND]);
    const got = await fake.command(["item", "get", "i1", "--project", "p1", "--json"]);
    assert.deepEqual(got.json().notices, [NO_SOUND]);
    const makers = await fake.command(["maker", "list"]);
    assert.ok(makers.out.includes(`scenes: ready\n    ${NO_SOUND}`) || makers.out.includes(NO_SOUND), makers.out);
    assert.deepEqual(((await fake.command(["maker", "list", "--json"])).json().videoMakers as { notice: string }[])[0]!.notice, NO_SOUND);
  } finally {
    await fake.close();
  }
});

test("quiz show and item get say a quiz's time limit, which the app keeps", async () => {
  const timed = { ...quizPayload, feedback: "atEnd", timeLimit: 30 };
  const fake = await fakeEngine({
    "GET /v1/projects/:id/plans": () => ({ plans: [{ id: "pl1", status: "done" }] }),
    "GET /v1/plans/:id": () => planView("done", "done", { outputId: "o1" }),
    "GET /v1/outputs/:id": () => ({ output: { id: "o1", type: "quiz", title: "Check", payload: timed } }),
  });
  try {
    const shown = await fake.command(["quiz", "show", "i1", "--project", "p1", "--json"]);
    assert.equal(shown.json().timeLimit, 30);
    const text = await fake.command(["quiz", "show", "i1", "--project", "p1"]);
    assert.match(text.out, /^Check \(2 questions, 30 minutes in the app\)/m);
  } finally {
    await fake.close();
  }
  assert.match(quizText(timed, new Map()), /^A quiz of 2 questions with 30 minutes to answer\.$/m);
  assert.match(quizText(quizPayload, new Map()), /^A quiz of 2 questions\.$/m);
});

test("an engine that took a call and is still reading says busy, and one that is not there says unreachable", async () => {
  const { createServer } = await import("node:http");
  const { engineAt } = await import("../commands/connect.ts");
  const held: import("node:http").ServerResponse[] = [];
  const slow = createServer((_req, res) => void held.push(res));
  await new Promise<void>((done) => slow.listen(0, "127.0.0.1", done));
  const port = (slow.address() as { port: number }).port;
  try {
    await assert.rejects(engineAt(`http://127.0.0.1:${port}`, "", TOKEN, 200).call("POST", "/v1/sources/s1/retry"), (e: { code?: string; message?: string }) => {
      assert.equal(e.code, "engine_busy");
      assert.match(e.message ?? "", /busy reading, please wait/);
      return true;
    });
  } finally {
    for (const res of held) res.destroy();
    await new Promise<void>((done) => slow.close(() => done()));
  }
  await assert.rejects(engineAt(`http://127.0.0.1:${port}`, "", TOKEN, 200).call("GET", "/v1/projects"), (e: { code?: string }) => e.code === "engine_unreachable");
});
