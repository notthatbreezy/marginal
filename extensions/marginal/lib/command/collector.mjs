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

export function attachProgress(session, { flushMs = 1000, todoWait = 300, taskWait = 500, maxWait = 2000, tickMs = 3000, now = () => Date.now() } = {}) {
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
        // The lease may have moved (or the doc gone) since this was scheduled: only the owner writes progress.json.
        if (!isOwner(docId, session.sessionId) || !readState(docId).plan) return void mem.delete(docId);
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
            let cur = mem.get(docId) ?? readProgress(docId) ?? emptyProgress(now(), plan.id);
            // Progress belongs to one plan: a different plan on this doc starts afresh (a revision of it doesn't).
            // Files from before plan ids were recorded adopt the current plan.
            if (cur.planId !== plan.id) cur = cur.planId == null ? { ...cur, planId: plan.id } : emptyProgress(now(), plan.id);
            if (mem.get(docId) !== cur) {
                mem.set(docId, cur);
                scheduleFlush(docId);
            }
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

    // One read of each kind at a time, applied in order: a slow older result can't land after a newer one. A signal
    // during a read queues exactly one more.
    const serial = (fn) => {
        let running = null;
        let again = false;
        return async () => {
            if (running) {
                again = true;
                return running;
            }
            running = (async () => {
                do {
                    again = false;
                    await fn();
                } while (again && !stopped);
            })();
            try {
                await running;
            } finally {
                running = null;
            }
        };
    };
    const readTodos = serial(async () => {
        if (stopped || !owned().length) return;
        try {
            const snap = await session.rpc.plan.readSqlTodosWithDependencies();
            update((p, plan) => applyTodos(p, snap, { plan, now: now() }));
        } catch {}
    });
    const readTasks = serial(async () => {
        if (stopped || !owned().length) return;
        const readAt = now();
        try {
            const res = await session.rpc.tasks.list();
            update((p, plan) => applyTasks(p, res, { plan, readAt }));
        } catch {}
    });
    const todosSoon = debounce(readTodos, todoWait, maxWait);
    const tasksSoon = debounce(readTasks, taskWait, maxWait);

    // A doc this session just started owning, or whose plan was replaced, gets a full read (keyed by doc and plan).
    const known = new Map(); // docId -> plan id
    const noticeNew = () => {
        let fresh = false;
        for (const docId of owned()) {
            const planId = readState(docId).plan.id;
            if (known.get(docId) !== planId) {
                known.set(docId, planId);
                fresh = true;
            }
        }
        if (fresh) {
            todosSoon();
            tasksSoon();
        }
    };

    const off = session.on((ev) => {
        try {
            // Only the few event types progress uses touch the lease (every session event would otherwise read it).
            if (EVENTS.has(ev.type)) {
                noticeNew();
                update((p, plan) => reduceProgress(p, ev, { plan, now: now() }));
            } else if (ev.type === "session.todos_changed") todosSoon();
            else if (ev.type === "session.background_tasks_changed") tasksSoon();
        } catch {}
    });
    const tick = setInterval(noticeNew, tickMs);
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
