// Passive progress: what the orchestrator is doing now, its todo list and the helper agents it waits on, observed
// from its session (events + two read-only RPCs). Nothing here asks an agent to report anything.
//   assistant.intent (root agent only)           → intent
//   session.todos_changed → plan.readSqlTodosWithDependencies()  → todos (+ firstSeen: the phase each todo belongs to)
//   subagent.started / completed / failed         → helpers
//   session.background_tasks_changed → tasks.list() → helpers (fills gaps, e.g. across a reload)
// Stored per doc in command/progress.json by the lease owner; derived data, rebuilt from the RPCs if lost.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "../paths.mjs";
import { commandDir, noteProgressWritten } from "./state.mjs";

export const HELPERS_MAX = 200;
export const SPANS_MAX = 50;
export const TODOS_MAX = 500;
const TEXT_MAX = 200;

/** @typedef {"pending"|"in_progress"|"done"|"blocked"} TodoStatus */
/** @typedef {"running"|"done"|"failed"|"cancelled"} HelperStatus */
/** @typedef {{id:string,title:string,status:TodoStatus,changedAt:string}} Todo */
/** @typedef {{at:string,phaseId:string|null,skip?:true}} Seen  phaseId null = Other; skip = earlier work, not counted */
/** A helper's active stretches: [start, end|null]. A background helper resumed after idling gets a new one. */
/** @typedef {[string, string|null]} Span */
/** @typedef {{id:string,agentId:string|null,name:string,description:string,type:string,model:string|null,mode:string|null,startedAt:string,endedAt?:string,durationMs?:number,status:HelperStatus,phaseId:string|null,error?:string,spans:Span[]}} Helper */
/** @typedef {{since:string,planId:string|null,intent:{text:string,at:string}|null,todos:{rows:Todo[],at:string}|null,firstSeen:Record<string,Seen>,helpers:Helper[]}} Progress */

/** @returns {Progress} */
export const emptyProgress = (now = Date.now(), planId = null) => ({ since: new Date(now).toISOString(), planId, intent: null, todos: null, firstSeen: {}, helpers: [] });

const clip = (s, n = TEXT_MAX) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const iso = (t, fallback) => {
    const ms = typeof t === "string" ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(fallback).toISOString();
};
// SQLite CURRENT_TIMESTAMP is UTC without a zone ("2026-09-26 06:48:04").
const sqliteTime = (s) => (typeof s === "string" ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`) : NaN);

const TODO_STATUS = new Set(["pending", "in_progress", "done", "blocked"]);
const todoStatus = (s) => {
    const v = String(s ?? "").toLowerCase().replace(/[\s-]/g, "_");
    if (TODO_STATUS.has(v)) return v;
    if (v === "completed" || v === "complete") return "done";
    if (v === "active" || v === "doing" || v === "running") return "in_progress";
    return "pending";
};

// ---------- matching to phases ----------

/** Phases in play (implementing or in review), in plan order. */
export function inPlay(plan) {
    return (plan?.phases ?? []).filter((p) => p.state?.status === "active" || p.state?.status === "review").map((p) => p.id);
}

/**
 * Phases in play at time `t`, reconstructed from each phase's startedAt and its current stage's since: an active or
 * in-review phase from its start on, a done or blocked one from its start until it got there. Matching by when a todo
 * was created (or a helper started) rather than when a read happened to land keeps a P1 todo on P1 even if the read
 * arrives after P2 began (or after a reload). Without `t`, the phases in play now.
 */
export function inPlayAt(plan, t) {
    if (!Number.isFinite(t)) return inPlay(plan);
    return (plan?.phases ?? [])
        .filter((p) => {
            const st = p.state ?? {};
            // Exact when the stage history is recorded: the stage the phase was in at t.
            if (Array.isArray(st.history) && st.history.length) {
                let at = null;
                for (const [status, when] of st.history) if (Date.parse(when) <= t) at = status;
                return at === "active" || at === "review";
            }
            // Older plans: approximate from the first start and the current stage.
            const start = Date.parse(st.startedAt ?? st.since);
            if (st.status === "active" || st.status === "review") return !Number.isFinite(start) || start <= t;
            if (st.status === "done" || st.status === "blocked") return Number.isFinite(start) && start <= t && t < Date.parse(st.since);
            return false;
        })
        .map((p) => p.id);
}

/** By name: an id or title that starts with a phase id followed by a separator (`p2-…`, `P2: …`). Longest id wins. */
export function phaseByName(plan, ...texts) {
    const ids = (plan?.phases ?? []).map((p) => p.id).sort((a, b) => b.length - a.length);
    for (const raw of texts) {
        const s = String(raw ?? "").trim().toLowerCase();
        for (const id of ids) {
            const k = id.toLowerCase();
            if (s === k || (s.startsWith(k) && /[\s\-_:./)\]]/.test(s[k.length]))) return id;
        }
    }
    return null;
}

/** Todos: by name, else the first phase in play when it was created (`at`), else Other (null). */
export const matchTodo = (plan, todo, at) => phaseByName(plan, todo.id, todo.title) ?? inPlayAt(plan, at)[0] ?? null;
/** Helpers: by timing only (when it started). */
export const matchHelper = (plan, at) => inPlayAt(plan, at)[0] ?? null;

// ---------- helper spans ----------

/** A helper's spans (older files have none: one span from start to end). */
export const spansOf = (h) => (Array.isArray(h.spans) && h.spans.length ? h.spans : [[h.startedAt, h.endedAt ?? null]]);
const closeSpan = (h, at) => {
    const sp = spansOf(h).map((x) => [...x]);
    if (sp.at(-1)[1] === null) sp.at(-1)[1] = at;
    return sp;
};
const openSpan = (h, at) => {
    const sp = [...spansOf(h).map((x) => [...x]), [at, null]];
    // Past the cap the oldest run is dropped (never merged: that would draw its idle gap as activity).
    while (sp.length > SPANS_MAX) sp.shift();
    return sp;
};
/**
 * The runs of a helper first seen in tasks.list (missed while reloading). Earlier runs of a resumed helper can't be
 * placed, so none of its idle time is drawn as activity: a running one shows its current run (activeStartedAt). An
 * idle one that was active its whole life (active time ≈ start to idle) shows that run; otherwise when it ran is
 * unknown (activeTimeMs is a total), so it's a marker where it went idle, flagged `unplaced`.
 */
function recoveredSpans(t, started, status, end) {
    const active = Date.parse(t.activeStartedAt);
    if (status === "running") return { spans: [[new Date(Number.isFinite(active) && active >= started ? active : started).toISOString(), null]] };
    const e = end ? Date.parse(end) : NaN;
    if (!Number.isFinite(e)) return { spans: [[new Date(started).toISOString(), null]] };
    const whole = typeof t.activeTimeMs !== "number" || Math.abs(e - started - t.activeTimeMs) <= 5000;
    const at = new Date(e).toISOString();
    return whole ? { spans: [[new Date(started).toISOString(), at]] } : { spans: [[at, at]], unplaced: true };
}
/** Keep the newest HELPERS_MAX; note until when older ones were dropped (the lanes say so). */
function capHelpers(p, helpers) {
    if (helpers.length <= HELPERS_MAX) return { ...p, helpers };
    const gone = helpers.slice(0, helpers.length - HELPERS_MAX);
    const until = Math.max(Date.parse(p.trimmedUntil ?? 0) || 0, ...gone.map((h) => Date.parse(h.endedAt ?? h.startedAt)));
    return { ...p, helpers: helpers.slice(-HELPERS_MAX), trimmedUntil: new Date(until).toISOString() };
}

// ---------- reducers (pure; return the same object when nothing changes) ----------

/** @returns {Progress} */
export function reduceProgress(p, ev, { plan, now = Date.now() } = {}) {
    const d = ev?.data ?? {};
    const at = iso(ev?.timestamp, now);
    if (ev?.type === "assistant.intent") {
        if (ev.agentId || d.parentToolCallId) return p; // a helper's intent, not the orchestrator's
        const text = clip(d.intent, 160);
        if (!text || p.intent?.text === text) return p;
        return { ...p, intent: { text, at } };
    }
    if (ev?.type === "subagent.started") {
        const id = d.toolCallId ?? ev.agentId;
        if (!id || p.helpers.some((h) => h.id === id)) return p;
        /** @type {Helper} */
        const h = {
            id,
            agentId: ev.agentId ?? null,
            name: clip(d.agentDisplayName || d.agentName || "helper", 80),
            description: clip(d.agentDescription),
            type: clip(d.agentType || d.agentName || "", 40),
            model: d.model ? clip(d.model, 60) : null,
            mode: d.executionMode ? clip(d.executionMode, 20) : null,
            startedAt: at,
            status: "running",
            phaseId: matchHelper(plan, Date.parse(at)),
            spans: [[at, null]],
        };
        return capHelpers(p, [...p.helpers, h]);
    }
    if (ev?.type === "subagent.completed" || ev?.type === "subagent.failed") {
        const id = d.toolCallId ?? null;
        const i = p.helpers.findIndex((h) => (id && h.id === id) || (ev.agentId && h.agentId === ev.agentId));
        if (i < 0) return p;
        const h = p.helpers[i];
        const status = ev.type === "subagent.failed" ? "failed" : d.cancelled ? "cancelled" : "done";
        if (h.status === status && h.endedAt) return p;
        const next = { ...h, status, endedAt: at, spans: closeSpan(h, at), ...(typeof d.durationMs === "number" ? { durationMs: d.durationMs } : {}), ...(status === "failed" ? { error: clip(String(d.error?.message ?? d.error ?? "failed")) } : {}) };
        const helpers = p.helpers.slice();
        helpers[i] = next;
        return { ...p, helpers };
    }
    return p;
}

/**
 * A todo snapshot from readSqlTodosWithDependencies(). Each todo's phase is decided the first time it's seen and kept.
 * At first sight, a todo that's already done, was created before this Command center started and isn't named for a
 * phase is earlier work: it's remembered but not counted.
 * @returns {Progress}
 */
export function applyTodos(p, snapshot, { plan, now = Date.now() } = {}) {
    const at = new Date(now).toISOString();
    const src = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const before = new Map((p.todos?.rows ?? []).map((t) => [t.id, t]));
    const since = Math.floor(Date.parse(p.since) / 1000) * 1000; // createdAt has whole seconds
    const firstSeen = { ...p.firstSeen };
    const rows = [];
    for (const r of src.slice(0, TODOS_MAX)) {
        const id = clip(String(r?.id ?? ""), 120);
        if (!id) continue;
        const title = clip(r.title) || id;
        const status = todoStatus(r.status);
        const old = before.get(id);
        rows.push({ id, title, status, changedAt: old && old.status === status ? old.changedAt : at });
        if (!firstSeen[id]) {
            // Named for a phase: always this plan's work. Otherwise, done before we started watching: earlier work.
            const named = phaseByName(plan, id, title);
            const created = sqliteTime(r.createdAt);
            const earlier = !named && status === "done" && Number.isFinite(created) && created < since;
            firstSeen[id] = earlier ? { at, phaseId: null, skip: true } : { at, phaseId: named ?? matchTodo(plan, { id, title }, Number.isFinite(created) ? created + 999 : now) }; // createdAt has whole seconds
        }
    }
    const ids = new Set(rows.map((t) => t.id));
    for (const id of Object.keys(firstSeen)) if (!ids.has(id)) delete firstSeen[id];
    const same = p.todos && p.todos.rows.length === rows.length && rows.every((t, i) => { const o = p.todos.rows[i]; return o.id === t.id && o.title === t.title && o.status === t.status; });
    if (same && Object.keys(firstSeen).length === Object.keys(p.firstSeen).length) return p;
    return { ...p, todos: { rows, at }, firstSeen };
}

const TASK_STATUS = { running: "running", idle: "done", completed: "done", failed: "failed", cancelled: "cancelled", canceled: "cancelled", killed: "cancelled" };

/**
 * A tasks.list() result. Adds agent helpers started since this Command center began that the events missed (a reload),
 * and settles running helpers the list reports finished. `readAt` is when the read began: a read that started before a
 * helper ended can't reopen it. Shell tasks are ignored.
 * @returns {Progress}
 */
export function applyTasks(p, result, { plan, readAt = Date.now() } = {}) {
    const tasks = (Array.isArray(result?.tasks) ? result.tasks : []).filter((t) => t?.type === "agent" && (t.toolCallId || t.id));
    const since = Date.parse(p.since);
    let helpers = p.helpers;
    const edit = (i, h) => {
        if (helpers === p.helpers) helpers = helpers.slice();
        helpers[i] = h;
    };
    for (const t of tasks) {
        const id = t.toolCallId ?? t.id;
        const status = TASK_STATUS[String(t.status ?? "").toLowerCase()] ?? "running";
        const i = helpers.findIndex((h) => h.id === id || (t.id && h.agentId === t.id));
        const ended = t.completedAt ?? (status !== "running" ? t.idleSince : undefined);
        if (i < 0) {
            const started = Date.parse(t.startedAt);
            if (!Number.isFinite(started) || started < since) continue; // earlier work
            const h = { id, agentId: t.id ?? null, name: clip(t.displayName || t.agentType || "helper", 80), description: clip(t.description), type: clip(t.agentType || "", 40), model: t.model ? clip(t.model, 60) : null, mode: t.executionMode ? clip(t.executionMode, 20) : null, startedAt: new Date(started).toISOString(), status, phaseId: matchHelper(plan, started) };
            if (status !== "running" && ended) h.endedAt = iso(ended, readAt);
            const rs = recoveredSpans(t, started, status, h.endedAt);
            h.spans = rs.spans;
            if (rs.unplaced) h.unplaced = true;
            if (status !== "running" && typeof t.activeTimeMs === "number") h.durationMs = t.activeTimeMs;
            helpers = [...(helpers === p.helpers ? helpers.slice() : helpers), h];
            continue;
        }
        const h = helpers[i];
        if (h.status === "running" && status !== "running") {
            const end = iso(ended, readAt);
            edit(i, { ...h, status, endedAt: end, spans: closeSpan(h, end), ...(typeof t.activeTimeMs === "number" && h.durationMs === undefined ? { durationMs: t.activeTimeMs } : {}) });
        }
        else if (h.status === "done" && status === "running" && h.endedAt && readAt > Date.parse(h.endedAt)) {
            // Resumed (a follow-up message to a background helper): the runtime sends no subagent event for it, so this
            // read is the first sign. A new active stretch starts; the idle gap before it holds no lane.
            const { endedAt, durationMs, ...rest } = h;
            // The run began at activeStartedAt (when the runtime gives it and it's after the last run ended), else
            // about when this read began.
            const active = Date.parse(t.activeStartedAt);
            const began = Number.isFinite(active) && active >= Date.parse(h.endedAt) ? active : readAt;
            edit(i, { ...rest, status: "running", spans: openSpan(h, new Date(began).toISOString()) });
        }
    }
    if (helpers === p.helpers) return p;
    return capHelpers(p, helpers);
}

// ---------- what the panel shows ----------

const FRESH_INTENT_MS = 10 * 60_000;
// A todo's change is seen when the debounced read lands, up to ~2 s after the runtime made it.
const READ_LAG_MS = 3000;

/**
 * The panel's view: `now`, todo counts, helpers, and per-phase progress. Absent pieces are null (the UI hides them).
 */
export function summarizeProgress(p, plan, now = Date.now()) {
    if (!p) return null;
    const counted = (p.todos?.rows ?? []).filter((t) => !p.firstSeen[t.id]?.skip).map((t) => ({ ...t, phaseId: p.firstSeen[t.id]?.phaseId ?? null }));
    const phaseIds = new Set((plan?.phases ?? []).map((ph) => ph.id));
    for (const t of counted) if (t.phaseId && !phaseIds.has(t.phaseId)) t.phaseId = null; // its phase was re-planned away
    const doing = counted.filter((t) => t.status === "in_progress").sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
    const intentAt = p.intent ? Date.parse(p.intent.at) : -Infinity;
    let nowLine = null;
    if (p.intent && (!doing.length || intentAt + READ_LAG_MS >= Date.parse(doing[0].changedAt)) && now - intentAt < FRESH_INTENT_MS) nowLine = { text: p.intent.text, source: "intent", at: p.intent.at };
    else if (doing.length) nowLine = { text: doing[0].title, source: "todo", at: doing[0].changedAt, todoId: doing[0].id };
    const helpers = p.helpers.map((h) => ({ ...h, spans: spansOf(h), phaseId: h.phaseId && phaseIds.has(h.phaseId) ? h.phaseId : null }));
    const bucket = () => ({ done: 0, total: 0, now: null, helpers: [] });
    const phases = {};
    for (const id of phaseIds) phases[id] = bucket();
    const other = bucket();
    for (const t of counted) {
        const b = t.phaseId ? phases[t.phaseId] : other;
        b.total++;
        if (t.status === "done") b.done++;
    }
    for (const t of doing) {
        // The most recently started one.
        const b = t.phaseId ? phases[t.phaseId] : other;
        if (b.now === null) b.now = t.title;
    }
    for (const h of helpers) if (h.status === "running") (h.phaseId ? phases[h.phaseId] : other).helpers.push({ id: h.id, name: h.name });
    return {
        since: p.since,
        now: nowLine,
        todos: counted.length ? { done: counted.filter((t) => t.status === "done").length, total: counted.length, rows: counted, at: p.todos.at } : null,
        helpers: helpers.length ? { running: helpers.filter((h) => h.status === "running").length, list: helpers, trimmedUntil: p.trimmedUntil ?? null } : null,
        phases,
        other: other.total || other.helpers.length ? other : null,
    };
}

// ---------- storage ----------

const progressFile = (docId) => join(commandDir(docId), "progress.json");

/** @returns {Progress|null} */
export function readProgress(docId) {
    try {
        const p = JSON.parse(readFileSync(progressFile(docId), "utf8"));
        if (!p || typeof p !== "object" || typeof p.since !== "string") return null;
        return { ...emptyProgress(Date.parse(p.since)), ...p, firstSeen: p.firstSeen && typeof p.firstSeen === "object" ? p.firstSeen : {}, helpers: Array.isArray(p.helpers) ? p.helpers : [] };
    } catch {
        return null;
    }
}
export function writeProgress(docId, p) {
    atomicWriteJson(progressFile(docId), p);
    noteProgressWritten(docId);
}
