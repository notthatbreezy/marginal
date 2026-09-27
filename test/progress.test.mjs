// Passive progress: reducers against a recorded Copilot-app run, phase matching, and the collector's coalescing.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.MARGINAL_DATA_DIR = mkdtempSync(join(tmpdir(), "wb-progress-"));

const P = await import("../extensions/marginal/lib/command/progress.mjs");
const { attachProgress } = await import("../extensions/marginal/lib/command/collector.mjs");
const { claim, stopHeartbeat } = await import("../extensions/marginal/lib/command/owner.mjs");
const { onCommand, writeState } = await import("../extensions/marginal/lib/command/state.mjs");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "progress-run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const phase = (id, status = "pending") => ({ id, title: id.toUpperCase(), expects: [], steps: [], state: { status } });
const planOf = (...phases) => ({ id: "pp", title: "Passive progress", phases });

/** Replay the recording: events through reduceProgress, RPC results through applyTodos / applyTasks at their times. */
function replay(rows, plan, p = P.emptyProgress(Date.parse(rows[0].t) - 1000)) {
    for (const r of rows) {
        const now = Date.parse(r.t);
        if (r.type) p = P.reduceProgress(p, r, { plan, now });
        else if (r.read === "todos") p = P.applyTodos(p, r.result, { plan, now });
        else if (r.read === "tasks") p = P.applyTasks(p, r.result, { plan, readAt: now });
    }
    return p;
}

// ---------- the recorded run ----------
const recorded = planOf(...["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((id) => phase(id, id === "p0" ? "active" : "pending")));

test("recorded run: intent, todos and both helpers (background and synchronous)", () => {
    const p = replay(fixture, recorded);
    assert.equal(p.intent.text, "Record real progress events");
    assert.equal(p.todos.rows.length, 8);
    assert.equal(p.todos.rows.find((t) => t.id === "p0-record").status, "in_progress");
    const names = p.helpers.map((h) => h.name);
    assert.deepEqual(names, ["spike-helper", "spike-sync2"], "only helpers started during the run; earlier ones in tasks.list are left out");
    const [bg, sync] = p.helpers;
    assert.equal(bg.status, "done");
    assert.equal(bg.durationMs, 7557);
    assert.equal(bg.mode, "background");
    const ts = (type, name) => fixture.find((r) => r.type === type && r.data.agentDisplayName === name).timestamp;
    assert.equal(bg.startedAt, ts("subagent.started", "spike-helper"), "the runtime's event time");
    assert.equal(bg.endedAt, ts("subagent.completed", "spike-helper"));
    assert.equal(sync.status, "done");
    assert.equal(sync.durationMs, 3741);
    assert.equal(bg.phaseId, "p0", "helpers match by timing");
});

test("recorded run: todos match phases by name; summary counts each todo once", () => {
    const p = replay(fixture, recorded);
    for (const id of ["p0-record", "p3-helper-lanes", "p7-review"]) assert.equal(p.firstSeen[id].phaseId, id.slice(0, 2));
    const s = P.summarizeProgress(p, recorded, Date.parse(fixture.at(-1).t));
    assert.deepEqual({ done: s.todos.done, total: s.todos.total }, { done: 0, total: 8 });
    assert.equal(Object.values(s.phases).reduce((n, b) => n + b.total, 0) + (s.other?.total ?? 0), 8);
    assert.equal(s.phases.p0.now, "Record real progress events");
    assert.equal(s.helpers.running, 0);
    assert.equal(s.other, null);
});

test("recorded run: a reload mid-run rebuilds the same helpers from tasks.list, with no duplicates", () => {
    const full = replay(fixture, recorded);
    // Lose everything after the first helper started, then see only the RPC reads (events missed while reloading).
    const cut = fixture.findIndex((r) => r.type === "subagent.started");
    let p = replay(fixture.slice(0, cut), recorded);
    const since = p.since;
    for (const r of fixture.slice(cut)) if (r.read === "tasks") p = P.applyTasks(p, r.result, { plan: recorded, readAt: Date.parse(r.t) });
    assert.equal(p.since, since);
    assert.deepEqual(p.helpers.map((h) => [h.name, h.status]), full.helpers.map((h) => [h.name, h.status]));
    // Then the events arrive late as well: still no duplicates.
    for (const r of fixture.slice(cut)) if (r.type) p = P.reduceProgress(p, r, { plan: recorded, now: Date.parse(r.t) });
    assert.equal(p.helpers.length, 2);
});

test("reducers return the same object when nothing changes", () => {
    const p = replay(fixture, recorded);
    const again = replay(fixture, recorded, p);
    assert.equal(again, p);
});

// ---------- helpers ----------
const started = (id, t, extra = {}) => ({ type: "subagent.started", timestamp: t, agentId: `a-${id}`, data: { toolCallId: id, agentName: "explore", agentDisplayName: id, agentDescription: `do ${id}`, agentType: "explore", ...extra } });

test("helpers: failed and cancelled, and an intent from a helper is ignored", () => {
    const plan = planOf(phase("p1", "active"));
    let p = P.emptyProgress(0);
    p = P.reduceProgress(p, started("h1", "2026-01-01T00:00:01Z"), { plan });
    p = P.reduceProgress(p, started("h2", "2026-01-01T00:00:02Z"), { plan });
    p = P.reduceProgress(p, { type: "subagent.failed", timestamp: "2026-01-01T00:00:05Z", agentId: "a-h1", data: { toolCallId: "h1", error: "boom", durationMs: 4000 } }, { plan });
    p = P.reduceProgress(p, { type: "subagent.completed", timestamp: "2026-01-01T00:00:06Z", agentId: "a-h2", data: { toolCallId: "h2", cancelled: true, durationMs: 4000 } }, { plan });
    assert.deepEqual(p.helpers.map((h) => [h.id, h.status, h.error ?? null]), [["h1", "failed", "boom"], ["h2", "cancelled", null]]);
    const q = P.reduceProgress(p, { type: "assistant.intent", agentId: "a-h1", data: { intent: "Searching" } }, { plan });
    assert.equal(q, p);
});

test("tasks.list: idle means done; a read begun before the end can't reopen; a later one can (resumed)", () => {
    const plan = planOf(phase("p1", "active"));
    let p = P.emptyProgress(0);
    p = P.reduceProgress(p, started("h1", "2026-01-01T00:00:01Z"), { plan });
    p = P.reduceProgress(p, { type: "subagent.completed", timestamp: "2026-01-01T00:00:09Z", agentId: "a-h1", data: { toolCallId: "h1", durationMs: 8000 } }, { plan });
    const running = { tasks: [{ type: "agent", id: "a-h1", toolCallId: "h1", status: "running", startedAt: "2026-01-01T00:00:01Z" }, { type: "shell", id: "s1", status: "running", startedAt: "2026-01-01T00:00:02Z" }] };
    assert.equal(P.applyTasks(p, running, { plan, readAt: Date.parse("2026-01-01T00:00:08Z") }), p);
    const resumed = P.applyTasks(p, running, { plan, readAt: Date.parse("2026-01-01T00:00:20Z") });
    assert.equal(resumed.helpers[0].status, "running");
    assert.equal(resumed.helpers[0].endedAt, undefined);
    assert.equal(resumed.helpers.length, 1, "shell tasks are ignored");
    const idle = { tasks: [{ type: "agent", id: "a-h1", toolCallId: "h1", status: "idle", startedAt: "2026-01-01T00:00:01Z", idleSince: "2026-01-01T00:00:30Z", activeTimeMs: 12000 }] };
    const settled = P.applyTasks(resumed, idle, { plan, readAt: Date.parse("2026-01-01T00:00:31Z") });
    assert.equal(settled.helpers[0].status, "done");
    assert.equal(settled.helpers[0].endedAt, "2026-01-01T00:00:30.000Z");
});

test("helpers are capped", () => {
    let p = P.emptyProgress(0);
    for (let i = 0; i < P.HELPERS_MAX + 20; i++) p = P.reduceProgress(p, started(`h${i}`, new Date(1000 + i).toISOString()), { plan: null });
    assert.equal(p.helpers.length, P.HELPERS_MAX);
    assert.equal(p.helpers[0].id, "h20");
});

// ---------- phase matching ----------
test("matching: by name (id or title, longest phase id wins), else by timing, else Other; decided once", () => {
    const plan = planOf(phase("p1", "done"), phase("p10"), phase("p2", "active"), phase("p3", "review"));
    assert.equal(P.phaseByName(plan, "p10-wire"), "p10");
    assert.equal(P.phaseByName(plan, "p1-x"), "p1");
    assert.equal(P.phaseByName(plan, "x", "P3: tests"), "p3");
    assert.equal(P.phaseByName(plan, "p1x"), null, "a prefix needs a separator");
    assert.equal(P.matchTodo(plan, { id: "wire", title: "Wire it" }), "p2", "several in play: the first");
    assert.equal(P.matchTodo(planOf(phase("p1", "done")), { id: "wire", title: "Wire it" }), null, "none in play: Other");

    let p = P.emptyProgress(0);
    p = P.applyTodos(p, { rows: [{ id: "wire", title: "Wire it", status: "pending", createdAt: "2026-01-01 00:00:01" }] }, { plan, now: 5000 });
    assert.equal(p.firstSeen.wire.phaseId, "p2");
    const moved = planOf(phase("p1", "done"), phase("p10"), phase("p2", "done"), phase("p3", "active"));
    p = P.applyTodos(p, { rows: [{ id: "wire", title: "Wire it", status: "done", createdAt: "2026-01-01 00:00:01" }] }, { plan: moved, now: 9000 });
    assert.equal(p.firstSeen.wire.phaseId, "p2", "stable after the phase moves on");
    const s = P.summarizeProgress(p, moved, 9000);
    assert.deepEqual([s.phases.p2.done, s.phases.p2.total, s.phases.p3.total], [1, 1, 0]);
});

test("earlier work: a todo already done, created before the Command center started and not named for a phase, isn't counted", () => {
    const plan = planOf(phase("p1", "active"));
    const since = Date.parse("2026-01-02T00:00:00Z");
    let p = P.emptyProgress(since);
    p = P.applyTodos(p, { rows: [
        { id: "old-done", title: "Old", status: "done", createdAt: "2026-01-01 10:00:00" },
        { id: "old-open", title: "Old but open", status: "pending", createdAt: "2026-01-01 10:00:00" },
        { id: "new-done", title: "New", status: "done", createdAt: "2026-01-02 10:00:00" },
        { id: "p1-old", title: "Named for a phase", status: "done", createdAt: "2026-01-01 10:00:00" },
    ] }, { plan, now: since + 1000 });
    const s = P.summarizeProgress(p, plan, since + 1000);
    assert.deepEqual([s.todos.done, s.todos.total], [2, 3]);
    assert.deepEqual(s.todos.rows.map((t) => t.id), ["old-open", "new-done", "p1-old"]);
});

test("a todo whose phase was re-planned away lands in Other; nothing is counted twice", () => {
    let p = P.emptyProgress(0);
    const plan = planOf(phase("p1", "active"), phase("p2"));
    p = P.applyTodos(p, { rows: [{ id: "p2-x", title: "x", status: "pending" }, { id: "y", title: "y", status: "in_progress" }] }, { plan, now: 1000 });
    const s = P.summarizeProgress(p, planOf(phase("p1", "active")), 1000);
    assert.equal(s.phases.p1.total, 1);
    assert.equal(s.other.total, 1);
    assert.equal(s.phases.p1.now, "y");
});

// ---------- the panel's view ----------
test("summary: Now is the more recent of the intent and the in-progress todo; a stale intent drops out", () => {
    const plan = planOf(phase("p1", "active"));
    let p = P.emptyProgress(0);
    p = P.reduceProgress(p, { type: "assistant.intent", timestamp: new Date(1000).toISOString(), data: { intent: "Reading the plan" } }, { plan });
    assert.deepEqual(P.summarizeProgress(p, plan, 2000).now, { text: "Reading the plan", source: "intent", at: new Date(1000).toISOString() });
    p = P.applyTodos(p, { rows: [{ id: "a", title: "Wire the executor", status: "in_progress" }] }, { plan, now: 5000 });
    assert.equal(P.summarizeProgress(p, plan, 6000).now.text, "Wire the executor");
    p = P.reduceProgress(p, { type: "assistant.intent", timestamp: new Date(7000).toISOString(), data: { intent: "Running tests" } }, { plan });
    assert.equal(P.summarizeProgress(p, plan, 8000).now.text, "Running tests");
    assert.equal(P.summarizeProgress(p, plan, 7000 + 11 * 60_000).now.text, "Wire the executor");
});

test("summary degrades quietly: no todos, no helpers, no intent → those pieces are null", () => {
    const plan = planOf(phase("p1", "active"));
    const s = P.summarizeProgress(P.emptyProgress(0), plan, 1000);
    assert.equal(s.now, null);
    assert.equal(s.todos, null);
    assert.equal(s.helpers, null);
    assert.equal(s.other, null);
    assert.deepEqual(s.phases.p1, { done: 0, total: 0, now: null, helpers: [] });
    assert.equal(P.summarizeProgress(null, plan), null);
});

// ---------- the collector ----------
function fakeSession(sessionId, { todos, tasks }) {
    const handlers = new Set();
    const calls = { todos: 0, tasks: 0 };
    return {
        sessionId,
        calls,
        on(fn) {
            handlers.add(fn);
            return () => handlers.delete(fn);
        },
        emit(ev) {
            for (const fn of handlers) fn(ev);
        },
        rpc: {
            plan: { readSqlTodosWithDependencies: async () => (calls.todos++, todos()) },
            tasks: { list: async () => (calls.tasks++, tasks()) },
        },
    };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("collector: bursts are debounced and the panel hears at most one update per flush interval", async () => {
    const docId = "progress-doc-1";
    claim(docId, "s-1");
    writeState(docId, (s) => {
        s.plan = planOf(phase("p1", "active"), phase("p2"));
    });
    let rows = [{ id: "p1-a", title: "A", status: "in_progress" }];
    const s = fakeSession("s-1", { todos: () => ({ rows, dependencies: [] }), tasks: () => ({ tasks: [] }) });
    const seen = [];
    const off = onCommand((e) => e.documentId === docId && e.kind === "progress" && seen.push({ at: Date.now(), e }));
    const c = attachProgress(s, { flushMs: 400, todoWait: 50, taskWait: 50, maxWait: 200 });
    try {
        await sleep(120); // the first read (a newly owned doc)
        const reads = { ...s.calls };
        for (let i = 0; i < 30; i++) {
            s.emit({ type: "session.background_tasks_changed", data: {} });
            s.emit(started(`h${i}`, new Date().toISOString()));
        }
        rows = [{ id: "p1-a", title: "A", status: "done" }, { id: "p2-b", title: "B", status: "pending" }];
        s.emit({ type: "session.todos_changed", data: {} });
        await sleep(900);
        assert.ok(s.calls.tasks - reads.tasks <= 2, `tasks.list debounced (${s.calls.tasks - reads.tasks} calls)`);
        assert.ok(s.calls.todos - reads.todos <= 1, "one todo read for the burst");
        for (let i = 1; i < seen.length; i++) assert.ok(seen[i].at - seen[i - 1].at >= 380, "at most one update per flush interval");
        const last = seen.at(-1).e.progress;
        assert.equal(last.helpers.running, 30);
        assert.deepEqual([last.todos.done, last.todos.total], [1, 2]);
        assert.deepEqual([last.phases.p1.total, last.phases.p2.total], [1, 1]);
        const disk = P.readProgress(docId);
        assert.equal(disk.helpers.length, 30);
    } finally {
        off();
        c.stop();
        stopHeartbeat(docId);
    }
});

test("collector: ignores docs this session doesn't own", async () => {
    const docId = "progress-doc-2";
    claim(docId, "someone-else");
    writeState(docId, (s) => {
        s.plan = planOf(phase("p1", "active"));
    });
    const s = fakeSession("s-2", { todos: () => ({ rows: [{ id: "x", title: "x", status: "pending" }] }), tasks: () => ({ tasks: [] }) });
    const c = attachProgress(s, { flushMs: 50, todoWait: 10, taskWait: 10, maxWait: 50 });
    try {
        s.emit(started("h1", new Date().toISOString()));
        await sleep(150);
        assert.equal(P.readProgress(docId), null);
        assert.equal(s.calls.todos, 0);
    } finally {
        c.stop();
        stopHeartbeat(docId);
    }
});
