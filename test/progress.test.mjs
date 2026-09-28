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
    assert.deepEqual(resumed.helpers[0].spans, [["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:09.000Z"], ["2026-01-01T00:00:20.000Z", null]], "a resumed helper starts a new run");
    const idle = { tasks: [{ type: "agent", id: "a-h1", toolCallId: "h1", status: "idle", startedAt: "2026-01-01T00:00:01Z", idleSince: "2026-01-01T00:00:30Z", activeTimeMs: 12000 }] };
    const settled = P.applyTasks(resumed, idle, { plan, readAt: Date.parse("2026-01-01T00:00:31Z") });
    assert.equal(settled.helpers[0].status, "done");
    assert.equal(settled.helpers[0].endedAt, "2026-01-01T00:00:30.000Z");
    assert.equal(settled.helpers[0].spans[1][1], "2026-01-01T00:00:30.000Z", "the second run ends when it went idle");
});

test("helpers are capped", () => {
    let p = P.emptyProgress(0);
    for (let i = 0; i < P.HELPERS_MAX + 20; i++) p = P.reduceProgress(p, started(`h${i}`, new Date(1000 + i).toISOString()), { plan: null });
    assert.equal(p.helpers.length, P.HELPERS_MAX);
    assert.equal(p.helpers[0].id, "h20");
    assert.ok(Date.parse(p.trimmedUntil) >= 1019, "notes until when older helpers were dropped");
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
    const since = Date.parse("2026-01-02T00:00:00.600Z");
    let p = P.emptyProgress(since);
    p = P.applyTodos(p, { rows: [
        { id: "old-done", title: "Old", status: "done", createdAt: "2026-01-01 10:00:00" },
        { id: "old-open", title: "Old but open", status: "pending", createdAt: "2026-01-01 10:00:00" },
        { id: "new-done", title: "New", status: "done", createdAt: "2026-01-02 10:00:00" },
        { id: "p1-old", title: "Named for a phase", status: "done", createdAt: "2026-01-01 10:00:00" },
        { id: "same-second", title: "Created in the second we started", status: "done", createdAt: "2026-01-02 00:00:00" },
    ] }, { plan, now: since + 1000 });
    const s = P.summarizeProgress(p, plan, since + 1000);
    assert.deepEqual([s.todos.done, s.todos.total], [3, 4]);
    assert.deepEqual(s.todos.rows.map((t) => t.id), ["old-open", "new-done", "p1-old", "same-second"]);
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

// ---------- review fixes ----------
test("matching by time: a todo created (or helper started) while P1 was in play stays on P1 even if read after P2 began", () => {
    const t = (s) => `2026-01-01T00:00:${String(s).padStart(2, "0")}Z`;
    const plan = planOf(
        { ...phase("p1"), state: { status: "done", startedAt: t(0), since: t(20) } },
        { ...phase("p2"), state: { status: "active", startedAt: t(20), since: t(20) } },
        { ...phase("p3"), state: { status: "blocked", startedAt: t(30), since: t(40), note: "x" } },
    );
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(10))), ["p1"]);
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(35))), ["p2", "p3"], "a blocked phase was in play until it got blocked");
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(45))), ["p2"]);
    let p = P.emptyProgress(0);
    p = P.applyTodos(p, { rows: [{ id: "wire", title: "Wire", status: "pending", createdAt: "2026-01-01 00:00:10" }] }, { plan, now: Date.parse(t(25)) });
    assert.equal(p.firstSeen.wire.phaseId, "p1");
    p = P.applyTasks(p, { tasks: [{ type: "agent", id: "a1", toolCallId: "h1", status: "running", startedAt: t(12) }] }, { plan, readAt: Date.parse(t(25)) });
    assert.equal(p.helpers[0].phaseId, "p1", "rebuilt after a reload: matched by its start");
    p = P.reduceProgress(p, started("h2", t(22)), { plan, now: Date.parse(t(22)) });
    assert.equal(p.helpers[1].phaseId, "p2");
});

test("collector: overlapping reads apply in order (a slow older result can't land after a newer one)", async () => {
    const docId = "progress-doc-3";
    claim(docId, "s-3");
    writeState(docId, (s) => {
        s.plan = planOf(phase("p1", "active"));
    });
    const replies = [];
    const s = fakeSession("s-3", { todos: () => ({ rows: [] }), tasks: () => ({ tasks: [] }) });
    // First read is slow and returns an old snapshot; the second is fast and newer.
    let call = 0;
    s.rpc.plan.readSqlTodosWithDependencies = () => {
        const n = ++call;
        replies.push(n);
        const slow = n === 2; // the read after the first signal: slow, and older than the one after it
        return new Promise((r) => setTimeout(() => r({ rows: [{ id: "p1-a", title: "A", status: slow ? "pending" : "done" }] }), slow ? 150 : 5));
    };
    const c = attachProgress(s, { flushMs: 20, todoWait: 1, taskWait: 1, maxWait: 5 });
    try {
        await c.refresh();
        await sleep(30);
        s.emit({ type: "session.todos_changed" });
        await sleep(30); // the slow read is in flight
        s.emit({ type: "session.todos_changed" });
        await sleep(400);
        assert.equal(P.readProgress(docId).todos.rows[0].status, "done");
    } finally {
        c.stop();
        stopHeartbeat(docId);
    }
});

test("collector: a flush scheduled before the lease moved doesn't write; a new plan starts progress afresh", async () => {
    const docId = "progress-doc-4";
    claim(docId, "s-4");
    writeState(docId, (s) => {
        s.plan = planOf(phase("p1", "active"));
    });
    const s = fakeSession("s-4", { todos: () => ({ rows: [] }), tasks: () => ({ tasks: [] }) });
    const c = attachProgress(s, { flushMs: 200, todoWait: 1, taskWait: 1, maxWait: 5 });
    try {
        await c.refresh();
        await sleep(250);
        s.emit(started("h1", new Date().toISOString()));
        await sleep(30);
        assert.equal(P.readProgress(docId).helpers.length, 1);
        s.emit(started("h2", new Date().toISOString())); // flush pending (throttled)
        const { atomicWriteJson } = await import("../extensions/marginal/lib/paths.mjs");
        const { commandDir } = await import("../extensions/marginal/lib/command/state.mjs");
        const lease = JSON.parse(readFileSync(join(commandDir(docId), "owner.json"), "utf8"));
        atomicWriteJson(join(commandDir(docId), "owner.json"), { ...lease, sessionId: "someone-else" });
        await sleep(300);
        assert.equal(P.readProgress(docId).helpers.length, 1, "the old owner's pending flush was dropped");
        atomicWriteJson(join(commandDir(docId), "owner.json"), { ...lease, heartbeatAt: new Date().toISOString() });
        writeState(docId, (st) => {
            st.plan = { ...planOf(phase("q1", "active")), id: "other-plan" };
        });
        s.emit(started("h3", new Date().toISOString()));
        await sleep(300);
        const fresh = P.readProgress(docId);
        assert.equal(fresh.planId, "other-plan");
        assert.deepEqual(fresh.helpers.map((h) => h.id), ["h3"]);
    } finally {
        c.stop();
        stopHeartbeat(docId);
    }
});
test("matching by time with stage history: a blocked or delivered gap isn't in play, even after the phase resumes", () => {
    const t = (s) => `2026-01-01T00:00:${String(s).padStart(2, "0")}Z`;
    const plan = planOf(
        { ...phase("p1"), state: { status: "active", startedAt: t(0), since: t(30), history: [["active", t(0)], ["blocked", t(10)], ["active", t(20)], ["done", t(25)], ["review", t(30)]] } },
        { ...phase("p2"), state: { status: "active", startedAt: t(12), since: t(12), history: [["active", t(12)]] } },
    );
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(5))), ["p1"]);
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(15))), ["p2"], "P1 was blocked then");
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(22))), ["p1", "p2"]);
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(27))), ["p2"], "P1 was delivered then");
    assert.deepEqual(P.inPlayAt(plan, Date.parse(t(40))), ["p1", "p2"], "reopened for review");
});

test("collector: a replaced plan gets fresh reads without waiting for another event", async () => {
    const docId = "progress-doc-5";
    claim(docId, "s-5");
    writeState(docId, (s) => {
        s.plan = { ...planOf(phase("p1", "active")), id: "one" };
    });
    const s = fakeSession("s-5", { todos: () => ({ rows: [{ id: "x", title: "X", status: "pending" }] }), tasks: () => ({ tasks: [] }) });
    const c = attachProgress(s, { flushMs: 20, todoWait: 1, taskWait: 1, maxWait: 5, tickMs: 50 });
    try {
        await sleep(120);
        assert.equal(P.readProgress(docId).planId, "one");
        const reads = s.calls.todos;
        writeState(docId, (st) => {
            st.plan = { ...planOf(phase("q1", "active")), id: "two" };
        });
        await sleep(200);
        assert.ok(s.calls.todos > reads, "read again for the new plan");
        const p = P.readProgress(docId);
        assert.equal(p.planId, "two");
        assert.equal(p.firstSeen.x.phaseId, "q1");
    } finally {
        c.stop();
        stopHeartbeat(docId);
    }
});
test("collector: owning a doc again (same plan) reads afresh", async () => {
    const docId = "progress-doc-6";
    claim(docId, "s-6");
    writeState(docId, (s) => {
        s.plan = { ...planOf(phase("p1", "active")), id: "same" };
    });
    const s = fakeSession("s-6", { todos: () => ({ rows: [] }), tasks: () => ({ tasks: [] }) });
    const c = attachProgress(s, { flushMs: 20, todoWait: 1, taskWait: 1, maxWait: 5, tickMs: 40 });
    try {
        await sleep(100);
        const { atomicWriteJson } = await import("../extensions/marginal/lib/paths.mjs");
        const { commandDir } = await import("../extensions/marginal/lib/command/state.mjs");
        const file = join(commandDir(docId), "owner.json");
        const lease = JSON.parse(readFileSync(file, "utf8"));
        atomicWriteJson(file, { ...lease, sessionId: "someone-else" });
        await sleep(100);
        const reads = s.calls.todos;
        atomicWriteJson(file, { ...lease, heartbeatAt: new Date().toISOString() });
        await sleep(150);
        assert.ok(s.calls.todos > reads, "read again after owning it again");
    } finally {
        c.stop();
        stopHeartbeat(docId);
    }
});
test("runs: a resume starts at activeStartedAt; a helper recovered after a reload never draws its idle time; the oldest run is dropped past the cap", () => {
    const T = (m, s = 0) => `2026-01-01T00:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
    const plan = planOf(phase("p1", "active"));
    let p = P.emptyProgress(0);
    p = P.reduceProgress(p, started("h1", T(0)), { plan });
    p = P.reduceProgress(p, { type: "subagent.completed", timestamp: T(1), agentId: "a-h1", data: { toolCallId: "h1" } }, { plan });
    // resumed at 00:30, first seen by a read at 00:30:30
    p = P.applyTasks(p, { tasks: [{ type: "agent", id: "a-h1", toolCallId: "h1", status: "running", startedAt: T(0), activeStartedAt: T(30) }] }, { plan, readAt: Date.parse(T(30, 30)) });
    assert.deepEqual(p.helpers[0].spans, [[T(0), T(1)], [T(30), null]]);
    // recovered after a reload: running since its latest resume, or idle with 3 min of activity in total
    const q = P.applyTasks(P.emptyProgress(0), { tasks: [
        { type: "agent", id: "a2", toolCallId: "h2", status: "running", startedAt: T(0), activeStartedAt: T(40) },
        { type: "agent", id: "a3", toolCallId: "h3", status: "idle", startedAt: T(0), idleSince: T(50), activeTimeMs: 3 * 60_000 },
    ] }, { plan, readAt: Date.parse(T(55)) });
    assert.deepEqual(q.helpers.map((h) => h.spans), [[[T(40), null]], [[T(50), T(50)]]], "idle, runs unknown: a marker where it went idle");
    assert.equal(q.helpers[1].unplaced, true);
    const once = P.applyTasks(P.emptyProgress(0), { tasks: [{ type: "agent", id: "a5", toolCallId: "h5", status: "idle", startedAt: T(0), idleSince: T(3), activeTimeMs: 3 * 60_000 - 800 }] }, { plan, readAt: Date.parse(T(55)) });
    assert.deepEqual(once.helpers[0].spans, [[T(0), T(3)]], "active its whole life: that run, exactly");
    assert.equal(q.helpers[0].startedAt, T(0), "the helper keeps its real start");
    // past SPANS_MAX runs, the oldest goes (its idle gap is never filled in)
    let r = P.reduceProgress(P.emptyProgress(0), started("h4", T(0)), { plan });
    for (let i = 1; i <= P.SPANS_MAX + 2; i++) {
        r = P.reduceProgress(r, { type: "subagent.completed", timestamp: new Date(Date.parse(T(0)) + i * 10_000 - 5_000).toISOString(), agentId: "a-h4", data: { toolCallId: "h4" } }, { plan });
        r = P.applyTasks(r, { tasks: [{ type: "agent", id: "a-h4", toolCallId: "h4", status: "running", startedAt: T(0), activeStartedAt: new Date(Date.parse(T(0)) + i * 10_000).toISOString() }] }, { plan, readAt: Date.parse(T(0)) + i * 10_000 + 100 });
    }
    const sp = r.helpers[0].spans;
    assert.equal(sp.length, P.SPANS_MAX);
    for (const [s, e] of sp.slice(0, -1)) assert.equal(Date.parse(e) - Date.parse(s), 5_000, "every kept run is its own 5 s");
});