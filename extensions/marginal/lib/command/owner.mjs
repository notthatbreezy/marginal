// Owner lease: exactly one Copilot session drives a document's Command state.
// Claimed explicitly by `command_plan {op:"set"}`; opening a panel never claims. A live owner re-`set`ting just
// renews; another session may take over only after the heartbeat is stale. The owner process heartbeats every 10 s.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "../paths.mjs";
import { commandDir } from "./state.mjs";

export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
const heartbeats = new Map(); // docId -> interval (this process only)

const leaseFile = (docId) => join(commandDir(docId), "owner.json");

export function readLease(docId, now = Date.now()) {
    try {
        const l = JSON.parse(readFileSync(leaseFile(docId), "utf8"));
        return { ...l, live: now - Date.parse(l.heartbeatAt) < STALE_MS };
    } catch {
        return null;
    }
}

/** A short exclusive lock around read-modify-write of the lease, so two processes can't both claim. */
function withLock(docId, fn) {
    mkdirSync(commandDir(docId), { recursive: true });
    const lock = join(commandDir(docId), "owner.lock");
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const fd = openSync(lock, "wx");
            try {
                return fn();
            } finally {
                closeSync(fd);
                rmSync(lock, { force: true });
            }
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
            try {
                if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { force: true }); // abandoned lock
            } catch {}
            const until = Date.now() + 20;
            while (Date.now() < until); // brief spin; contention is rare and short
        }
    }
    throw new Error("could not acquire the command lease lock");
}

/**
 * Claim or renew. Returns { ok:true, lease, renewed, tookOver } or { ok:false, lease } when another live session owns it.
 */
export function claim(docId, sessionId, { now = Date.now() } = {}) {
    const result = withLock(docId, () => {
        const cur = readLease(docId, now);
        if (cur && cur.live && cur.sessionId !== sessionId) return { ok: false, lease: cur };
        const iso = new Date(now).toISOString();
        const lease = { sessionId, pid: process.pid, claimedAt: cur?.sessionId === sessionId ? cur.claimedAt : iso, heartbeatAt: iso };
        atomicWriteJson(leaseFile(docId), lease);
        return { ok: true, lease: { ...lease, live: true }, renewed: cur?.sessionId === sessionId, tookOver: !!cur && cur.sessionId !== sessionId };
    });
    if (result.ok) startHeartbeat(docId, sessionId);
    return result;
}

export function isOwner(docId, sessionId, now = Date.now()) {
    const l = readLease(docId, now);
    return !!l && l.live && l.sessionId === sessionId;
}

/** After an extension reload the same session's new process re-adopts its lease without a new `set`. */
export function adoptIfMine(docId, sessionId) {
    const l = readLease(docId);
    if (!l || l.sessionId !== sessionId) return false;
    claim(docId, sessionId);
    return true;
}

function startHeartbeat(docId, sessionId) {
    if (heartbeats.has(docId)) return;
    const t = setInterval(() => {
        try {
            withLock(docId, () => {
                const cur = readLease(docId);
                if (!cur || cur.sessionId !== sessionId) return stopHeartbeat(docId); // lost it
                atomicWriteJson(leaseFile(docId), { ...cur, live: undefined, pid: process.pid, heartbeatAt: new Date().toISOString() });
            });
        } catch {}
    }, HEARTBEAT_MS);
    t.unref();
    heartbeats.set(docId, t);
}

export function stopHeartbeat(docId) {
    clearInterval(heartbeats.get(docId));
    heartbeats.delete(docId);
}
export const heldHere = () => [...heartbeats.keys()];
