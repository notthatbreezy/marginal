// The chat transcript: reduced from a recorded session (history) and from scripted live events.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.MARGINAL_DATA_DIR = mkdtempSync(join(tmpdir(), "wb-transcript-"));

const T = await import("../extensions/marginal/lib/transcript.mjs");
const { parseUi, readUi, writeUi } = await import("../extensions/marginal/lib/ui.mjs");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "transcript-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

let n = 0;
const ev = (type, data = {}, extra = {}) => ({ type, id: `e${++n}`, timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(), data, ...extra });

test("recorded session: user messages, replies, folded activity and the questions asked", () => {
    const items = T.itemsFrom(fixture);
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of ["user", "reply", "activity", "question"]) assert.ok(kinds.has(k), `has ${k}`);
    const users = items.filter((i) => i.kind === "user");
    assert.equal(users.length, 4, "the autopilot continuation is not shown");
    assert.ok(users.every((u) => u.source === "app"));
    const qs = items.filter((i) => i.kind === "question");
    assert.equal(qs.length, 6);
    assert.ok(qs.every((q) => q.status === "answered" && !q.answerable && q.answer), "history questions are answered, and not answerable here");
    assert.match(qs.find((q) => /shortcut/.test(q.question)).answer, /Ctrl\/Cmd\+I/);
    // Replies with text only; no empty ones for tool-only turns.
    assert.ok(items.filter((i) => i.kind === "reply").every((r) => r.text.trim()));
    // Every activity line summarises its tools.
    for (const a of items.filter((i) => i.kind === "activity")) assert.ok(T.activitySummary(a.tools) || a.helpers.length, a.id);
    // Ids are unique.
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});

test("messages from Marginal, from another session, and ones that aren't shown", () => {
    const s = T.createState();
    T.reduce(s, ev("user.message", { messageId: "m1", content: "Why requeue?\n\nCommand chat on “Retry policy” · 2 focused", transformedContent: "<current_datetime>x</current_datetime>\n\n[Command center chat on \"Retry policy\"]" }));
    T.reduce(s, ev("user.message", { messageId: "m2", content: "What does this do?\n\nOn doc “Design” (md-4)", transformedContent: "[Marginal side-chat on \"Design\"]" }));
    T.reduce(s, ev("user.message", { messageId: "m3", content: "Review M1", source: "agent-abc" }));
    T.reduce(s, ev("user.message", { content: "", isAutopilotContinuation: true }));
    T.reduce(s, ev("user.message", { content: "<system_notification>Agent done</system_notification>" }));
    T.reduce(s, ev("user.message", { messageId: "m4", content: "helper chatter" }, { agentId: "a1" }));
    const u = s.items.filter((i) => i.kind === "user");
    assert.deepEqual(u.map((x) => [x.id, x.source, x.text, x.context ?? null]), [
        ["m1", "marginal", "Why requeue?", "Command chat on “Retry policy” · 2 focused"],
        ["m2", "marginal", "What does this do?", "On doc “Design” (md-4)"],
        ["m3", "session", "Review M1", null],
    ]);
});

test("a streamed reply: deltas then the final text; a tool-only preamble disappears", () => {
    const s = T.createState();
    T.reduce(s, ev("user.message", { messageId: "u", content: "hi" }));
    const r1 = T.reduce(s, ev("assistant.message_delta", { messageId: "r", deltaContent: "Hel" }));
    assert.deepEqual(r1.delta, { id: "r", text: "Hel" });
    T.reduce(s, ev("assistant.message_delta", { messageId: "r", deltaContent: "lo" }));
    assert.equal(s.byId.get("r").text, "Hello");
    assert.equal(s.byId.get("r").streaming, true);
    T.reduce(s, ev("assistant.message", { messageId: "r", content: "Hello there" }));
    assert.equal(s.byId.get("r").text, "Hello there");
    assert.equal(s.byId.get("r").streaming, undefined);
    T.reduce(s, ev("assistant.message_delta", { messageId: "p", deltaContent: "Let me look" }));
    const gone = T.reduce(s, ev("assistant.message", { messageId: "p", content: "" }));
    assert.ok(gone.changed.has("p"));
    assert.equal(s.byId.has("p"), false);
    // Helper messages stay out.
    T.reduce(s, ev("assistant.message", { messageId: "h", content: "helper" }, { agentId: "a" }));
    assert.equal(s.byId.has("h"), false);
});

test("activity folds tools between replies and tracks helpers; status follows the turn", () => {
    const s = T.createState();
    T.reduce(s, ev("user.message", { messageId: "u", content: "go" }));
    assert.equal(s.status, "working");
    for (const [name, path] of [["view", "a.js"], ["view", "b.js"], ["edit", "a.js"], ["powershell", null], ["report_intent", null], ["read_powershell", null]]) T.reduce(s, ev("tool.execution_start", { toolCallId: `t-${n}`, toolName: name, arguments: path ? { path } : { description: "Run tests" } }));
    T.reduce(s, ev("subagent.started", { toolCallId: "sa", agentDisplayName: "reviewer" }, { agentId: "x" }));
    const a = s.items.find((i) => i.kind === "activity");
    assert.deepEqual(a.tools, { read: 2, edit: 1, run: 1 });
    assert.equal(T.activitySummary(a.tools), "Read 2 files · edited 1 file · ran 1 command");
    assert.deepEqual(a.helpers.map((h) => [h.name, h.status]), [["reviewer", "running"]]);
    T.reduce(s, ev("subagent.completed", { toolCallId: "sa" }, { agentId: "x" }));
    assert.equal(a.helpers[0].status, "done");
    T.reduce(s, ev("assistant.message", { messageId: "r", content: "Done" }));
    T.reduce(s, ev("tool.execution_start", { toolCallId: "t9", toolName: "grep", arguments: { pattern: "x" } }));
    assert.equal(s.items.filter((i) => i.kind === "activity").length, 2, "a reply starts a new activity line");
    T.reduce(s, ev("session.idle"));
    assert.equal(s.status, "idle");
    assert.ok(s.items.filter((i) => i.kind === "activity").every((x) => x.done));
});

test("questions: asked live (answerable), answered elsewhere, merged with the ask_user call", () => {
    const s = T.createState();
    T.reduce(s, ev("tool.execution_start", { toolCallId: "tc", toolName: "ask_user", arguments: { question: "Which?", choices: ["A", "B"] } }));
    T.reduce(s, ev("user_input.requested", { requestId: "rq", toolCallId: "tc", question: "Which?", choices: ["A", "B"], allowFreeform: true }));
    const q = s.byId.get("tc");
    assert.equal(s.items.filter((i) => i.kind === "question").length, 1, "one card for the call and its request");
    assert.deepEqual([q.requestId, q.answerable, q.status, s.status], ["rq", true, "pending", "waiting"]);
    T.reduce(s, ev("user_input.completed", { requestId: "rq", answer: "B" }));
    assert.deepEqual([q.status, q.answer, q.answerable, s.status], ["answered", "B", false, "working"]);
    // A plan approval.
    T.reduce(s, ev("exit_plan_mode.requested", { requestId: "pl", summary: "Do X", planContent: "# Plan", actions: ["interactive", "autopilot"], recommendedAction: "autopilot" }));
    assert.equal(s.byId.get("pl").answerable, true);
    T.reduce(s, ev("exit_plan_mode.completed", { requestId: "pl", approved: false, feedback: "Smaller" }));
    assert.deepEqual([s.byId.get("pl").approved, s.byId.get("pl").feedback], [false, "Smaller"]);
});

function fakeSession({ events = fixture, page = 60 } = {}) {
    const calls = { read: [], userInput: [], plan: [] };
    return {
        calls,
        rpc: {
            eventLog: {
                // Backward pages over the recorded events: newest window first, then older ones by cursor.
                read: async (p) => {
                    calls.read.push(p);
                    const end = p.cursor ? Number(p.cursor) : events.length;
                    const start = Math.max(0, end - Math.min(p.max ?? 200, page));
                    return { events: events.slice(start, end), cursor: String(start), hasMore: start > 0, cursorStatus: "ok" };
                },
            },
            ui: {
                handlePendingUserInput: async (p) => (calls.userInput.push(p), { success: true }),
                handlePendingExitPlanMode: async (p) => (calls.plan.push(p), { success: true }),
            },
        },
    };
}

test("history pages backward until it has enough messages, and pages on by cursor without overlap", async () => {
    const session = fakeSession();
    const tr = T.createTranscript(() => session);
    const first = await tr.history({ want: 10 });
    assert.equal(session.calls.read[0].direction, "backward");
    assert.equal(session.calls.read[0].agentScope, "primary");
    assert.deepEqual(session.calls.read[0].types, T.HISTORY_TYPES);
    assert.ok(first.items.filter((i) => i.kind === "user" || i.kind === "reply").length >= 10);
    if (first.hasMore) assert.equal(first.items[0].kind, "user", "a page begins at the start of a turn");
    const all = [...first.items];
    let cur = first.cursor;
    while (cur) {
        const p = await tr.history({ cursor: cur, want: 10 });
        all.unshift(...p.items);
        cur = p.cursor;
    }
    assert.equal(new Set(all.map((i) => i.id)).size, all.length, "no item twice across pages");
    assert.equal(all.filter((i) => i.kind === "user").length, 4, "every user message, once");
});

test("live items merge into the first page; answering goes through the runtime and is shown", async () => {
    const session = fakeSession({ events: [] });
    const tr = T.createTranscript(() => session);
    const seen = [];
    tr.subscribe((e) => seen.push(e));
    tr.onEvent(ev("user.message", { messageId: "u1", content: "Plan it" }));
    tr.onEvent(ev("user_input.requested", { requestId: "rq1", question: "Which file?", choices: ["a", "b"] }));
    tr.onEvent(ev("assistant.message_delta", { messageId: "r1", deltaContent: "Stream" }));
    const h = await tr.history();
    assert.ok(h.items.some((i) => i.id === "rq1" && i.answerable), "the pending question is on the first page");
    assert.ok(h.items.some((i) => i.id === "r1" && i.streaming));
    const { seq, ...delta } = seen.find((e) => e.op === "delta");
    assert.deepEqual(delta, { op: "delta", id: "r1", text: "Stream" });
    assert.ok(seq > 0 && h.seq >= seq, "events are numbered; the snapshot says how far it includes");
    const bad = await tr.answer({ id: "rq1", answer: "  " });
    assert.equal(bad.ok, false);
    const ok = await tr.answer({ id: "rq1", answer: "b", wasFreeform: false });
    assert.equal(ok.ok, true);
    assert.deepEqual(session.calls.userInput[0], { requestId: "rq1", response: { answer: "b", wasFreeform: false } });
    assert.equal((await tr.answer({ id: "rq1", answer: "b" })).ok, false, "only once");
    tr.onEvent(ev("exit_plan_mode.requested", { requestId: "pl1", summary: "S", planContent: "P", actions: ["autopilot"], recommendedAction: "autopilot" }));
    assert.equal((await tr.answer({ id: "pl1", approved: true, selectedAction: "autopilot" })).ok, true);
    assert.deepEqual(session.calls.plan[0], { requestId: "pl1", response: { approved: true, selectedAction: "autopilot" } });
    // Already answered in the app: the runtime says so.
    session.rpc.ui.handlePendingUserInput = async () => ({ success: false });
    tr.onEvent(ev("user_input.requested", { requestId: "rq2", question: "Again?" }));
    assert.match((await tr.answer({ id: "rq2", answer: "yes" })).reason, /already answered/);
});

test("the live transcript stays bounded", () => {
    const tr = T.createTranscript(() => null);
    for (let i = 0; i < T.LIVE_MAX + 50; i++) tr.onEvent(ev("user.message", { messageId: `m${i}`, content: `msg ${i}` }));
    assert.equal(tr._state.items.length, T.LIVE_MAX);
    assert.equal(tr._state.byId.size, T.LIVE_MAX);
});

test("ui.json: one shared window box, per-panel open state, bad values dropped", () => {
    assert.deepEqual(readUi(), { box: null, open: {} });
    writeUi({ box: { x: 100, y: 50, w: 420, h: 500 } });
    writeUi({ instance: "p1", open: true });
    writeUi({ instance: "p2", open: true });
    writeUi({ instance: "p2", open: false });
    assert.deepEqual(readUi(), { box: { x: 100, y: 50, w: 420, h: 500 }, open: { p1: true } });
    assert.deepEqual(writeUi({ box: { x: "a" } }).box, { x: 100, y: 50, w: 420, h: 500 }, "a bad box keeps the old one");
    assert.equal(parseUi({ box: { x: 1, y: 2, w: 10, h: 20 } }).box.w, 200, "sizes are clamped");
});

test("live: the first delta of a reply also says the activity before it is done", () => {
    const tr = T.createTranscript(() => null);
    const seen = [];
    tr.subscribe((e) => seen.push(e));
    tr.onEvent(ev("user.message", { messageId: "u", content: "go" }));
    tr.onEvent(ev("tool.execution_start", { toolCallId: "t1", toolName: "view", arguments: { path: "a" } }));
    seen.length = 0;
    tr.onEvent(ev("assistant.message_delta", { messageId: "r", deltaContent: "Hi" }));
    assert.deepEqual(seen.map((e) => e.op), ["upsert", "delta"]);
    assert.equal(seen[0].item.kind, "activity");
    assert.equal(seen[0].item.done, true);
});
test("history: a question and its answer stay on one page even when the raw page boundary falls between them", async () => {
    const evs = [
        ev("user.message", { messageId: "u1", content: "first" }),
        ev("tool.execution_start", { toolCallId: "q1", toolName: "ask_user", arguments: { question: "Which?", choices: ["A"] } }),
        ...Array.from({ length: 30 }, (_, i) => ev("tool.execution_start", { toolCallId: `x${i}`, toolName: "view", arguments: { path: `f${i}` } })),
        ev("tool.execution_complete", { toolCallId: "q1", result: { content: "User selected: A" } }),
        ev("assistant.message", { messageId: "r1", content: "Done" }),
        ev("user.message", { messageId: "u2", content: "second" }),
        ev("assistant.message", { messageId: "r2", content: "OK" }),
    ];
    const tr = T.createTranscript(() => fakeSession({ events: evs, page: 10 }));
    const h = await tr.history({ want: 2 });
    const q = h.items.find((i) => i.id === "q1");
    assert.ok(q, "the question is on the first page with its answer");
    assert.equal(q.status, "answered");
    assert.equal(q.answer, "A");
});

test("doc changes during a turn are one item under it, finished when the turn ends", () => {
    const tr = T.createTranscript(() => null);
    const seen = [];
    tr.subscribe((e) => seen.push(e));
    tr.noteDocEdit("d1", "Doc", { type: "update", targetId: "md-1" });
    assert.equal(seen.length, 0, "no turn running: not a reply's change");
    tr.onEvent(ev("user.message", { messageId: "u9", content: "fix it" }));
    tr.noteDocEdit("d1", "Doc", { type: "update", targetId: "md-1" });
    tr.noteDocEdit("d1", "Doc", { type: "update", targetId: "md-1" });
    tr.noteDocEdit("d1", "Doc", { type: "insert", targetId: "md-2" });
    const it = tr._state.byId.get("chg-u9-d1");
    assert.deepEqual(it.edits.map((e) => e.targetId), ["md-1", "md-2"], "one entry per part");
    tr.onEvent(ev("session.idle"));
    assert.equal(it.done, true);
});
test("history: live-only items (doc changes, questions) are merged in where they happened", async () => {
    const evs = [ev("user.message", { messageId: "a", content: "one" }), ev("assistant.message", { messageId: "ra", content: "r1" })];
    const session = fakeSession({ events: evs });
    const tr = T.createTranscript(() => session);
    tr.onEvent(evs[0]);
    tr.noteDocEdit("d", "Doc", { type: "update", targetId: "x" });
    tr.onEvent(evs[1]);
    const later = [ev("user.message", { messageId: "b", content: "two" }), ev("assistant.message", { messageId: "rb", content: "r2" })];
    for (const e of later) (evs.push(e), tr.onEvent(e));
    const h = await tr.history();
    assert.deepEqual(h.items.map((i) => i.id), ["a", "ra", "chg-a-d", "b", "rb"], "under its turn's reply");
});
test("history: paging through many turns with tiny raw pages never splits a question from its answer", async () => {
    const evs = [];
    for (let i = 0; i < 23; i++) {
        evs.push(ev("user.message", { messageId: `u${i}`, content: `turn ${i}` }));
        evs.push(ev("tool.execution_start", { toolCallId: `q${i}`, toolName: "ask_user", arguments: { question: `Q${i}?` } }));
        for (let k = 0; k < i % 4; k++) evs.push(ev("tool.execution_start", { toolCallId: `v${i}-${k}`, toolName: "view", arguments: { path: "f" } }));
        evs.push(ev("tool.execution_complete", { toolCallId: `q${i}`, result: { content: `User responded: A${i}` } }));
        evs.push(ev("assistant.message", { messageId: `r${i}`, content: `R${i}` }));
    }
    const tr = T.createTranscript(() => fakeSession({ events: evs, page: 9 }));
    const all = [];
    let cur;
    let first = true;
    for (let guard = 0; guard < 50 && (first || cur); guard++) {
        const p = await tr.history({ cursor: cur, want: 3 });
        all.unshift(...p.items);
        cur = p.cursor;
        first = false;
    }
    const qs = all.filter((i) => i.kind === "question");
    assert.equal(qs.length, 23);
    assert.ok(qs.every((q) => q.status === "answered"), qs.filter((q) => q.status !== "answered").map((q) => q.id).join());
    assert.equal(all.filter((i) => i.kind === "user").length, 23);
    assert.equal(new Set(all.map((i) => i.id)).size, all.length);
});

test("doc changes belong to the turn that made them: a message steering it doesn't take them", () => {
    const tr = T.createTranscript(() => null);
    tr.onEvent(ev("user.message", { messageId: "A", content: "edit it", delivery: "idle" }));
    tr.noteDocEdit("d", "Doc", { type: "update", targetId: "x" });
    tr.onEvent(ev("user.message", { messageId: "B", content: "also this", delivery: "steering" }));
    tr.noteDocEdit("d", "Doc", { type: "update", targetId: "y" });
    assert.deepEqual(tr._state.byId.get("chg-A-d").edits.map((e) => e.targetId), ["x", "y"]);
    assert.equal(tr._state.byId.has("chg-B-d"), false);
    tr.onEvent(ev("assistant.message", { messageId: "R", content: "done" }));
    assert.equal(tr._state.byId.get("chg-A-d").afterId, "R", "listed under the turn's reply");
    assert.equal(tr._state.byId.get("R").turn, "A", "a reply knows its turn");
});

test("a queued message starts its own turn when Copilot takes it up", () => {
    const tr = T.createTranscript(() => null);
    tr.onEvent(ev("user.message", { messageId: "A", content: "edit it", delivery: "idle" }));
    tr.onEvent(ev("assistant.message", { messageId: "RA", content: "done A" }));
    tr.onEvent(ev("assistant.turn_end", {}));
    // logged when dequeued: after A's turn ended, with no idle in between
    tr.onEvent(ev("user.message", { messageId: "B", content: "then this", delivery: "queued" }));
    tr.noteDocEdit("d", "Doc", { type: "update", targetId: "z" });
    tr.onEvent(ev("assistant.message", { messageId: "RB", content: "done B" }));
    assert.equal(tr._state.byId.has("chg-A-d"), false);
    assert.deepEqual(tr._state.byId.get("chg-B-d").edits.map((e) => e.targetId), ["z"]);
    assert.equal(tr._state.byId.get("RA").turn, "A");
    assert.equal(tr._state.byId.get("RB").turn, "B");
});