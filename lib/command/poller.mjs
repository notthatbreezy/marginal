// Per-front worktree poller: observes `git diff <base>` + untracked files and turns changes into ChangeEvents.
// Attribution is worktree → front; agents never report edits. One loop per front, never overlapping,
// adaptive cadence (3 s while busy, backing off to 15 s when quiet).
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { gitOut, gitx } from "./gitx.mjs";
import { matchingActivePhases, offPlanMatcher } from "./patterns.mjs";
import { appendEvents, eventsSince, readState, writeState } from "./state.mjs";

export const CADENCE = { fast: 3000, slow: 15000, busyWindow: 60_000 };
const UNTRACKED_MAX = 1024 * 1024;

/** Parse `git diff --raw --numstat -z -M` into Map(path → {add, del, kind, binary, previousPath}). */
export function parseRawNumstat(out) {
    const t = out.split("\0");
    const files = new Map();
    const kinds = new Map();
    let i = 0;
    while (i < t.length && t[i].startsWith(":")) {
        const status = t[i].split(" ").pop();
        const letter = status[0];
        if (letter === "R" || letter === "C") {
            kinds.set(t[i + 2], { kind: letter === "R" ? "renamed" : "added", previousPath: t[i + 1] });
            i += 3;
        } else {
            kinds.set(t[i + 1], { kind: { A: "added", D: "deleted" }[letter] ?? "modified" });
            i += 2;
        }
    }
    while (i < t.length) {
        const rec = t[i];
        if (!rec) {
            i++;
            continue;
        }
        const [a, d, p] = rec.split("\t");
        let path = p;
        if (p === "") {
            path = t[i + 2];
            i += 3;
        } else i++;
        if (path === undefined) break;
        const binary = a === "-";
        files.set(path, { add: binary ? 0 : Number(a), del: binary ? 0 : Number(d), binary, ...(kinds.get(path) ?? { kind: "modified" }) });
    }
    return files;
}

async function countLines(abs) {
    try {
        const s = await stat(abs);
        if (s.size > UNTRACKED_MAX) return { add: 0, binary: true };
        const buf = await readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) return { add: 0, binary: true };
        if (!buf.length) return { add: 0 };
        let n = 0;
        for (const b of buf) if (b === 10) n++;
        return { add: buf[buf.length - 1] === 10 ? n : n + 1 };
    } catch {
        return null;
    }
}

/** One observation of a worktree against a base: Map(path → {add, del, kind, binary?, previousPath?}). */
export async function observe(worktree, base) {
    const [diff, others] = await Promise.all([gitOut(worktree, ["diff", "--raw", "--numstat", "-z", "-M", base], { kind: "diff" }), gitOut(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { kind: "ls-files" })]);
    if (diff === null) return null;
    const files = parseRawNumstat(diff);
    for (const p of (others ?? "").split("\0").filter(Boolean)) {
        const c = await countLines(join(worktree, p));
        if (c) files.set(p, { add: c.add, del: 0, kind: "untracked", ...(c.binary ? { binary: true } : {}) });
    }
    return files;
}

/**
 * Diff an observation against the previous totals and build ChangeEvents.
 * Pure (exported for tests). `prev`: Map(path → {add, del}). `initial` marks a front's first observation, which
 * establishes its starting totals and is excluded from velocity.
 */
export function computeEvents({ prev, next, frontId, plan, at, initial = false }) {
    const events = [];
    const off = offPlanMatcher(plan, frontId);
    const mk = (path, cur, kind) => {
        const before = prev.get(path) ?? { add: 0, del: 0 };
        const dAdd = cur.add - before.add;
        const dDel = cur.del - before.del;
        const ev = {
            at,
            frontId,
            file: path,
            kind,
            delta: { add: Math.abs(dAdd), del: Math.abs(dDel) },
            netDelta: dAdd - dDel,
            totals: { add: cur.add, del: cur.del },
            offPlan: off(path),
            phaseIds: matchingActivePhases(plan, path),
        };
        if (cur.binary) ev.binary = true;
        if (cur.previousPath) ev.previousPath = cur.previousPath;
        if (initial) ev.initial = true;
        return ev;
    };
    for (const [path, cur] of next) {
        const before = prev.get(path);
        const changed = !before || before.add !== cur.add || before.del !== cur.del || before.kind !== cur.kind;
        if (changed) events.push(mk(path, cur, cur.kind));
    }
    for (const [path, before] of prev) {
        if (next.has(path) || (before.add === 0 && before.del === 0 && !before.binary)) continue;
        events.push(mk(path, { add: 0, del: 0 }, "modified")); // reverted to base
    }
    return events;
}

/** Last known totals per file for a front, rebuilt from the log (so restarts don't replay history as new edits). */
export function totalsFromLog(docId, frontId) {
    const m = new Map();
    for (const e of eventsSince(docId, 0)) if (e.frontId === frontId) m.set(e.file, { add: e.totals.add, del: e.totals.del, kind: e.kind, binary: e.binary });
    for (const [k, v] of m) if (v.add === 0 && v.del === 0 && !v.binary) m.delete(k);
    return m;
}

/** Resolve the diff base for a front: plan.base while it is an ancestor of HEAD, else their merge-base (drift). */
async function effectiveBase(worktree, planBase) {
    const head = (await gitOut(worktree, ["rev-parse", "HEAD"], { kind: "rev-parse" }))?.trim();
    if (!head) return null;
    const anc = await gitx(worktree, ["merge-base", "--is-ancestor", planBase, head], { kind: "merge-base" });
    if (anc.ok) return { base: planBase, head, drift: false };
    const mb = (await gitOut(worktree, ["merge-base", planBase, head], { kind: "merge-base" }))?.trim();
    return { base: mb || planBase, head, drift: true };
}

// ---------- the loops ----------
const loops = new Map(); // `${docId}\0${frontId}` -> loop

export function startPolling(docId, front, { cadence = CADENCE } = {}) {
    const key = `${docId}\0${front.id}`;
    if (loops.has(key)) return loops.get(key);
    const loop = { docId, frontId: front.id, prev: null, running: false, stopped: false, timer: null, lastChange: 0, delay: cadence.fast, baseInfo: null, finalDone: false };
    loops.set(key, loop);
    const tick = async () => {
        if (loop.stopped) return;
        if (loop.running) return schedule(); // never overlap
        loop.running = true;
        try {
            await pollOnce(loop);
        } catch {
        } finally {
            loop.running = false;
            schedule();
        }
    };
    const schedule = () => {
        if (loop.stopped) return;
        const busy = Date.now() - loop.lastChange < cadence.busyWindow;
        loop.delay = busy ? cadence.fast : Math.min(cadence.slow, loop.delay * 2);
        loop.timer = setTimeout(tick, loop.delay);
        loop.timer.unref?.();
    };
    loop.tick = tick;
    setTimeout(tick, 0).unref?.();
    return loop;
}

export async function pollOnce(loop) {
    const state = readState(loop.docId);
    const front = state.fronts.find((f) => f.id === loop.frontId);
    if (!front || !state.plan) return stopPolling(loop.docId, loop.frontId);
    if (front.status === "done" && loop.finalDone) return;
    const info = await effectiveBase(front.worktree, state.plan.base);
    if (!info) return;
    if (!!front.baseDrift !== info.drift || front.effectiveBase !== info.base)
        writeState(loop.docId, (s) => {
            const f = s.fronts.find((x) => x.id === front.id);
            if (f) Object.assign(f, { baseDrift: info.drift, effectiveBase: info.base });
        });
    const next = await observe(front.worktree, info.base);
    if (!next) return;
    const initial = loop.prev === null && !eventsSince(loop.docId, 0).some((e) => e.frontId === front.id);
    const prev = loop.prev ?? totalsFromLog(loop.docId, front.id);
    const events = computeEvents({ prev, next, frontId: front.id, plan: state.plan, at: new Date().toISOString(), initial });
    loop.prev = next;
    if (events.length) {
        appendEvents(loop.docId, events);
        if (!initial) loop.lastChange = Date.now();
    }
    if (front.status === "done") loop.finalDone = true; // one final observation, then pause
}

export function stopPolling(docId, frontId) {
    const key = `${docId}\0${frontId}`;
    const loop = loops.get(key);
    if (!loop) return;
    loop.stopped = true;
    clearTimeout(loop.timer);
    loops.delete(key);
}
export function stopAll(docId) {
    for (const l of [...loops.values()]) if (!docId || l.docId === docId) stopPolling(l.docId, l.frontId);
}
/** Wake a front's loop now (status change, plan change). */
export function nudge(docId, frontId) {
    const l = loops.get(`${docId}\0${frontId}`);
    if (l) {
        if (frontId) l.finalDone = false;
        clearTimeout(l.timer);
        l.delay = CADENCE.fast;
        l.tick();
    }
}
export const pollingFronts = (docId) => [...loops.values()].filter((l) => l.docId === docId).map((l) => l.frontId);
