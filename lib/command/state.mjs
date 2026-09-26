// Command persistence per whiteboard document:
//   command/state.json   plan, fronts, views, walkthroughs, mission (owner-written, revisioned)
//   command/prefs.json   UI preferences (follow toggle, saved layout) — any panel may write
//   command/events.jsonl append-only change log (owner-written)
//   command/owner.json   lease (see owner.mjs)
// Non-owner processes render from disk; fs.watch keeps them live.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson, paths } from "../paths.mjs";
import { parsePrefs } from "./patterns.mjs";

export const commandDir = (docId) => join(paths.whiteboards, docId, "command");
const file = (docId, name) => join(commandDir(docId), name);

// ---------- bus ----------
const listeners = new Set();
export function onCommand(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
export function emitCommand(event) {
    for (const fn of listeners)
        try {
            fn(event);
        } catch {}
}

// ---------- state ----------
export const emptyState = () => ({ plan: null, fronts: [], views: [], walkthroughs: [], mission: { status: "unknown" }, revision: 0, updatedAt: null });
const stateCache = new Map(); // docId -> { mtimeMs, state }

export function readState(docId) {
    const f = file(docId, "state.json");
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(f).mtimeMs;
    } catch {
        return stateCache.get(docId)?.state ?? emptyState();
    }
    const hit = stateCache.get(docId);
    if (hit && hit.mtimeMs === mtimeMs) return hit.state;
    try {
        const state = { ...emptyState(), ...JSON.parse(readFileSync(f, "utf8")) };
        stateCache.set(docId, { mtimeMs, state });
        return state;
    } catch {
        return hit?.state ?? emptyState();
    }
}

/** Apply `mutate(draft)` to a fresh copy and persist it. Returns the new state. Owner-only (enforced by callers). */
export function writeState(docId, mutate) {
    const draft = structuredClone(readState(docId));
    mutate(draft);
    draft.revision = (draft.revision ?? 0) + 1;
    draft.updatedAt = new Date().toISOString();
    mkdirSync(commandDir(docId), { recursive: true });
    atomicWriteJson(file(docId, "state.json"), draft);
    stateCache.set(docId, { mtimeMs: statSync(file(docId, "state.json")).mtimeMs, state: draft });
    lastRevision.set(docId, draft.revision);
    emitCommand({ documentId: docId, kind: "state", revision: draft.revision });
    return draft;
}

export function readPrefs(docId) {
    try {
        return parsePrefs(JSON.parse(readFileSync(file(docId, "prefs.json"), "utf8")));
    } catch {
        return parsePrefs({});
    }
}
export function writePrefs(docId, patch) {
    const next = parsePrefs({ ...readPrefs(docId), ...(patch && typeof patch === "object" ? patch : {}) });
    mkdirSync(commandDir(docId), { recursive: true });
    atomicWriteJson(file(docId, "prefs.json"), next);
    emitCommand({ documentId: docId, kind: "prefs" });
    return next;
}

// ---------- event log ----------
const logs = new Map(); // docId -> { events, seq, size }
const COMPACT_AT = 20 * 1024 * 1024;

function loadLog(docId) {
    let log = logs.get(docId);
    if (log) return log;
    log = { events: [], seq: 0, size: 0 };
    const f = file(docId, "events.jsonl");
    if (existsSync(f)) {
        const text = readFileSync(f, "utf8");
        log.size = Buffer.byteLength(text);
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
                const ev = JSON.parse(line);
                log.events.push(ev);
                log.seq = Math.max(log.seq, ev.seq);
            } catch {}
        }
    }
    logs.set(docId, log);
    return log;
}

/** Read any bytes appended by another process since we last looked. */
export function refreshLog(docId) {
    const log = loadLog(docId);
    const f = file(docId, "events.jsonl");
    let size = 0;
    try {
        size = statSync(f).size;
    } catch {
        return [];
    }
    if (size < log.size) {
        // Compacted or rewritten elsewhere: reload from scratch.
        logs.delete(docId);
        const fresh = loadLog(docId);
        return fresh.events;
    }
    if (size === log.size) return [];
    const fd = openSync(f, "r");
    const buf = Buffer.alloc(size - log.size);
    readSync(fd, buf, 0, buf.length, log.size);
    closeSync(fd);
    const added = [];
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return []; // partial line; wait for the rest
    for (const line of text.slice(0, lastNl).split("\n")) {
        if (!line.trim()) continue;
        try {
            const ev = JSON.parse(line);
            if (ev.seq > log.seq) {
                log.events.push(ev);
                log.seq = ev.seq;
                added.push(ev);
            }
        } catch {}
    }
    log.size += Buffer.byteLength(text.slice(0, lastNl + 1));
    return added;
}

export function appendEvents(docId, events) {
    if (!events.length) return [];
    const log = loadLog(docId);
    const stamped = events.map((e) => ({ seq: ++log.seq, ...e }));
    const text = stamped.map((e) => JSON.stringify(e)).join("\n") + "\n";
    mkdirSync(commandDir(docId), { recursive: true });
    appendFileSync(file(docId, "events.jsonl"), text);
    log.size += Buffer.byteLength(text);
    log.events.push(...stamped);
    emitCommand({ documentId: docId, kind: "events", events: stamped, seq: log.seq });
    if (log.size > COMPACT_AT) compactLog(docId);
    return stamped;
}

export const eventsSince = (docId, seq = 0) => loadLog(docId).events.filter((e) => e.seq > seq);
export const lastSeq = (docId) => loadLog(docId).seq;

/**
 * One-time compaction (D4): events older than 6 h fold into one `baseline` event per front+file (their final totals)
 * plus per-minute velocity buckets, so replay and velocity stay correct while the file shrinks.
 */
export function compactLog(docId, { keepMs = 6 * 3600_000, now = Date.now() } = {}) {
    const log = loadLog(docId);
    const cutoff = now - keepMs;
    const old = log.events.filter((e) => Date.parse(e.at) < cutoff && !e.baseline);
    if (!old.length) return { compacted: 0 };
    const keep = log.events.filter((e) => !(Date.parse(e.at) < cutoff) || e.baseline);
    const last = new Map();
    const buckets = new Map();
    for (const e of old) {
        last.set(`${e.frontId}\0${e.file}`, e);
        if (e.initial) continue;
        const minute = new Date(Math.floor(Date.parse(e.at) / 60000) * 60000).toISOString();
        const k = `${minute}\0${e.frontId}`;
        const b = buckets.get(k) ?? { minute, frontId: e.frontId, churn: 0, net: 0, files: new Set(), events: 0 };
        b.churn += e.delta.add + e.delta.del;
        b.net += e.netDelta ?? 0;
        b.files.add(e.file);
        b.events++;
        buckets.set(k, b);
    }
    const baselines = [...last.values()].map((e) => ({ ...e, baseline: true, delta: { add: 0, del: 0 } }));
    const events = [...baselines, ...keep].sort((a, b) => a.seq - b.seq);
    const f = file(docId, "events.jsonl");
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    renameSync(tmp, f);
    const prevBuckets = readBuckets(docId);
    atomicWriteJson(file(docId, "buckets.json"), [...prevBuckets, ...[...buckets.values()].map((b) => ({ ...b, files: b.files.size }))]);
    log.events = events;
    log.size = statSync(f).size;
    emitCommand({ documentId: docId, kind: "compacted" });
    return { compacted: old.length, baselines: baselines.length };
}
export function readBuckets(docId) {
    try {
        return JSON.parse(readFileSync(file(docId, "buckets.json"), "utf8"));
    } catch {
        return [];
    }
}

// ---------- cross-process live updates ----------
const lastRevision = new Map();
const lastLease = new Map();
const watchers = new Map();
const leaseText = (docId) => {
    try {
        return readFileSync(file(docId, "owner.json"), "utf8");
    } catch {
        return "";
    }
};

/** Watch a document's command dir so panels in non-owner processes stay live. Idempotent. */
export function watchCommand(docId) {
    if (watchers.has(docId)) return;
    mkdirSync(commandDir(docId), { recursive: true });
    let timer = null;
    const check = () => {
        const s = readState(docId);
        if ((lastRevision.get(docId) ?? -1) < s.revision) {
            lastRevision.set(docId, s.revision);
            emitCommand({ documentId: docId, kind: "state", revision: s.revision });
        }
        // Heartbeats rewrite owner.json every 10 s; forwarding them lets panels age the lease locally (live < 30 s).
        const lt = leaseText(docId);
        if (lt !== lastLease.get(docId)) {
            lastLease.set(docId, lt);
            let lease = null;
            try {
                lease = lt ? JSON.parse(lt) : null;
            } catch {}
            emitCommand({ documentId: docId, kind: "lease", lease });
        }
        const added = refreshLog(docId);
        if (added.length) emitCommand({ documentId: docId, kind: "events", events: added, seq: lastSeq(docId) });
    };
    try {
        const w = watch(commandDir(docId), () => {
            clearTimeout(timer);
            timer = setTimeout(check, 120);
        });
        w.on("error", () => {});
        w.unref?.(); // never keep the extension (or a test) alive just for this
        watchers.set(docId, w);
    } catch {
        // Fall back to polling where fs.watch is unavailable.
        watchers.set(docId, setInterval(check, 1500).unref());
    }
    lastRevision.set(docId, readState(docId).revision);
}

/** Stop watching one document (or all). Needed before its directory is deleted: Windows keeps watched dirs busy. */
export function unwatchCommand(docId) {
    for (const [id, w] of [...watchers]) {
        if (docId && id !== docId) continue;
        if (typeof w.close === "function") w.close();
        else clearInterval(w);
        watchers.delete(id);
    }
}
