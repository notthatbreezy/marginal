// Progress collector: feeds this session's events and two read-only RPCs into progress.json for every doc whose
// Command lease this session holds. Reads are debounced (background_tasks_changed arrives in bursts of 20+), and the
// panel hears about changes at most once per `flushMs`.
import { heldHere, isOwner } from "./owner.mjs";
import { applyTasks, applyTodos, emptyProgress, readProgress, reduceProgress, summarizeProgress, writeProgress } from "./progress.mjs";
import { emitCommand, readState } from "./state.mjs";

const EVENTS = new Set(["assistant.intent", "subagent.started", "subagent.completed", "subagent.failed"]);

/** Trailing debounce that still fires at least every `maxWait` during a burst. */
function debounce(fn, wait, maxWait) {
    let timer = null;
    let first = 0;
    return () => {
        const now = Date.now();
        if (!timer) first = now;
        clearTimeout(timer);
        const delay = Math.max(0, Math.min(wait, maxWait - (now - first)));
        timer = setTimeout(() => {
            timer = null;
            fn();
        }, delay);
        timer.unref?.();
    };
}

export function attachProgress(session, { flushMs = 1000, todoWait = 300, taskWait = 500, maxWait = 2000, now = () => Date.now() } = {}) {
    const mem = new Map(); // docId -> Progress (this process is its owner)
    const flushTimers = new Map();
    const lastFlush = new Map();
    let stopped = false;

    const owned = () => heldHere().filter((docId) => isOwner(docId, session.sessionId) && readState(docId).plan);

    const flush = (docId) => {
        flushTimers.delete(docId);
        lastFlush.set(docId, now());
        const p = mem.get(docId);
        if (!p || stopped) return;
        try {
            writeProgress(docId, p);
            emitCommand({ documentId: docId, kind: "progress", progress: summarizeProgress(p, readState(docId).plan, now()) });
        } catch {}
    };
    const scheduleFlush = (docId) => {
        if (flushTimers.has(docId)) return;
        const wait = Math.max(0, flushMs - (now() - (lastFlush.get(docId) ?? -Infinity)));
        const t = setTimeout(() => flush(docId), Number.isFinite(wait) ? wait : 0);
        t.unref?.();
        flushTimers.set(docId, t);
    };

    const update = (fn) => {
        for (const docId of owned()) {
            const plan = readState(docId).plan;
            const cur = mem.get(docId) ?? readProgress(docId) ?? emptyProgress(now());
            if (!mem.has(docId)) mem.set(docId, cur);
            let next = cur;
            try {
                next = fn(cur, plan);
            } catch {}
            if (next !== cur) {
                mem.set(docId, next);
                scheduleFlush(docId);
            }
        }
    };

    const readTodos = async () => {
        if (stopped || !owned().length) return;
        try {
            const snap = await session.rpc.plan.readSqlTodosWithDependencies();
            update((p, plan) => applyTodos(p, snap, { plan, now: now() }));
        } catch {}
    };
    const readTasks = async () => {
        if (stopped || !owned().length) return;
        const readAt = now();
        try {
            const res = await session.rpc.tasks.list();
            update((p, plan) => applyTasks(p, res, { plan, readAt }));
        } catch {}
    };
    const todosSoon = debounce(readTodos, todoWait, maxWait);
    const tasksSoon = debounce(readTasks, taskWait, maxWait);

    // A doc this session just started owning (plan set, or re-adopted after a reload) gets a full read.
    const known = new Set();
    const noticeNew = () => {
        let fresh = false;
        for (const docId of owned())
            if (!known.has(docId)) {
                known.add(docId);
                fresh = true;
            }
        if (fresh) {
            todosSoon();
            tasksSoon();
        }
    };

    const off = session.on((ev) => {
        try {
            noticeNew();
            if (EVENTS.has(ev.type)) update((p, plan) => reduceProgress(p, ev, { plan, now: now() }));
            else if (ev.type === "session.todos_changed") todosSoon();
            else if (ev.type === "session.background_tasks_changed") tasksSoon();
        } catch {}
    });
    const tick = setInterval(noticeNew, 3000);
    tick.unref?.();
    noticeNew();

    return {
        /** Read both RPCs now (tests; after a plan is set). */
        refresh: () => Promise.all([readTodos(), readTasks()]),
        stop() {
            stopped = true;
            off?.();
            clearInterval(tick);
            for (const t of flushTimers.values()) clearTimeout(t);
        },
    };
}
