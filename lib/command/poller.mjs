// Per-front worktree poller: observes `git diff <base>` + untracked files and turns changes into ChangeEvents.
// Attribution is worktree → front; agents never report edits. One loop per front, never overlapping,
// adaptive cadence (3 s while busy, backing off to 15 s when quiet).
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { gitOut, gitx } from "./gitx.mjs";
import { isPresentChange, matchingActivePhases, offPlanMatcher } from "./patterns.mjs";
import { heldHere, readLease } from "./owner.mjs";
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
        const sig = `${s.size}:${Math.round(s.mtimeMs)}`;
        if (s.size > UNTRACKED_MAX) return { add: 0, binary: true, sig };
        const buf = await readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) return { add: 0, binary: true, sig };
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
        if (c) files.set(p, { add: c.add, del: 0, kind: "untracked", ...(c.binary ? { binary: true, sig: c.sig } : {}) });
    }
    // Binary files have no line totals, so a size:mtime signature is what tells two edits apart.
    await Promise.all(
        [...files].filter(([, v]) => v.binary && !v.sig && v.kind !== "deleted").map(async ([p, v]) => {
            const s = await stat(join(worktree, p)).catch(() => null);
            if (s) v.sig = `${s.size}:${Math.round(s.mtimeMs)}`;
        }),
    );
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
        if (cur.sig) ev.sig = cur.sig;
        if (cur.previousPath) ev.previousPath = cur.previousPath;
        if (initial) ev.initial = true;
        return ev;
    };
    for (const [path, cur] of next) {
        const before = prev.get(path);
        const changed = !before || before.add !== cur.add || before.del !== cur.del || before.kind !== cur.kind || (cur.binary && before.sig !== cur.sig);
        if (changed) events.push(mk(path, cur, cur.kind));
    }
    for (const [path, before] of prev) {
        if (next.has(path) || !isPresentChange({ totals: before, binary: before.binary, kind: before.kind ?? "modified" })) continue;
        events.push(mk(path, { add: 0, del: 0 }, "modified")); // reverted to base
    }
    return events;
}

/** Last known totals per file for a front, rebuilt from the log (so restarts don't replay history as new edits). */
export function totalsFromLog(docId, frontId) {
    const m = new Map();
    for (const e of eventsSince(docId, 0)) if (e.frontId === frontId) m.set(e.file, isPresentChange(e) ? { add: e.totals.add, del: e.totals.del, kind: e.kind, binary: e.binary, sig: e.sig } : null);
    for (const [k, v] of m) if (!v) m.delete(k);
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
// Invariants: at most one pending timer per loop; never two observations in flight; a process only polls (and
// writes) while it holds the document's lease, so a stale owner that wakes up stops instead of racing the new one.
const loops = new Map(); // `${docId}\0${frontId}` -> loop

const holdsLease = (docId) => {
    const l = readLease(docId);
    return !!l && l.live && l.pid === process.pid && heldHere().includes(docId);
};

export function startPolling(docId, front, { cadence = CADENCE } = {}) {
    const key = `${docId}\0${front.id}`;
    if (loops.has(key)) return loops.get(key);
    const loop = { docId, frontId: front.id, prev: null, base: null, running: false, again: false, stopped: false, timer: null, lastChange: 0, delay: cadence.fast, finalDone: false };
    loops.set(key, loop);
    const tick = async () => {
        clearTimeout(loop.timer);
        loop.timer = null;
        if (loop.stopped) return;
        if (loop.running) {
            loop.again = true; // run once more as soon as the current observation finishes
            return;
        }
        loop.running = true;
        try {
            await pollOnce(loop);
        } catch {
        } finally {
            loop.running = false;
            if (loop.again) {
                loop.again = false;
                loop.delay = cadence.fast;
                arm(0);
            } else schedule();
        }
    };
    const arm = (ms) => {
        if (loop.stopped) return;
        clearTimeout(loop.timer);
        loop.timer = setTimeout(tick, ms);
        loop.timer.unref?.();
    };
    const schedule = () => {
        const busy = Date.now() - loop.lastChange < cadence.busyWindow;
        loop.delay = busy ? cadence.fast : Math.min(cadence.slow, loop.delay * 2);
        arm(loop.delay);
    };
    loop.tick = tick;
    loop.arm = arm;
    arm(0);
    return loop;
}

export async function pollOnce(loop) {
    if (!holdsLease(loop.docId)) return stopAll(loop.docId);
    const state = readState(loop.docId);
    const front = state.fronts.find((f) => f.id === loop.frontId);
    if (!front || !state.plan) return stopPolling(loop.docId, loop.frontId);
    if (front.status === "done" && loop.finalDone) return;
    const info = await effectiveBase(front.worktree, state.plan.base);
    if (!info) return;
    const next = await observe(front.worktree, info.base);
    if (!next || loop.stopped || !holdsLease(loop.docId)) return; // ownership may have moved during the git calls
    if (!!front.baseDrift !== info.drift || front.effectiveBase !== info.base)
        writeState(loop.docId, (s) => {
            const f = s.fronts.find((x) => x.id === front.id);
            if (f) Object.assign(f, { baseDrift: info.drift, effectiveBase: info.base });
        });
    // A new base (plan re-set, or the worktree rebased) re-baselines: totals change without anyone editing.
    const knownBase = loop.base ?? front.effectiveBase ?? null;
    const rebased = knownBase !== null && knownBase !== info.base;
    const firstEver = loop.prev === null && !eventsSince(loop.docId, 0).some((e) => e.frontId === front.id);
    const initial = firstEver || rebased;
    const prev = loop.prev ?? totalsFromLog(loop.docId, front.id);
    const events = computeEvents({ prev, next, frontId: front.id, plan: state.plan, at: new Date().toISOString(), initial });
    loop.prev = next;
    loop.base = info.base;
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
/** Wake a front's loop now (status change, plan change); if it is mid-observation it runs again right after. */
export function nudge(docId, frontId) {
    const l = loops.get(`${docId}\0${frontId}`);
    if (!l) return;
    l.finalDone = false;
    l.delay = CADENCE.fast;
    if (l.running) l.again = true;
    else l.arm(0);
}
export const pollingFronts = (docId) => [...loops.values()].filter((l) => l.docId === docId).map((l) => l.frontId);