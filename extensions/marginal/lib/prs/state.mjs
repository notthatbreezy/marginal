// Where a doc's pull requests live: <docs>/<docId>/prs/index.json (which PRs, their settings and stacking) and
// <docs>/<docId>/prs/<prId>.json (what Marginal last saw of each, its outbox and activity). Writes are atomic.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../errors.mjs";
import { atomicWriteJson, paths } from "../paths.mjs";
import { parsePrUrl, prIdFor, prKey } from "./identity.mjs";
import { DEFAULT_SETTINGS, normalizeSettings } from "./model.mjs";

export const MAX_PRS = 50;
export const ACTIVITY_MAX = 200;

export const prsDir = (docId) => join(paths.docs, docId, "prs");
const indexFile = (docId) => join(prsDir(docId), "index.json");
const prFile = (docId, prId) => join(prsDir(docId), `${prId}.json`);

const listeners = new Set();
/** fn(docId, {prId?, what}) after every write: the server turns it into an SSE event. */
export const onPrsChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (docId, what) => {
    for (const fn of listeners)
        try {
            fn(docId, what);
        } catch {}
};

function readJson(file, fallback) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

export function readIndex(docId) {
    const ix = readJson(indexFile(docId), null);
    return { v: 1, prs: Array.isArray(ix?.prs) ? ix.prs.map((p) => ({ ...p, settings: normalizeSettings(p.settings) })) : [] };
}

export function writeIndex(docId, mutate, what = { what: "index" }) {
    const ix = readIndex(docId);
    const r = mutate(ix);
    atomicWriteJson(indexFile(docId), ix);
    emit(docId, what);
    return r;
}

export const hasPrs = (docId) => existsSync(indexFile(docId)) && readIndex(docId).prs.length > 0;

export function getEntry(docId, prId) {
    const e = readIndex(docId).prs.find((p) => p.id === prId);
    if (!e) {
        const ids = readIndex(docId).prs.map((p) => p.id);
        throw new InputError(`No pull request ${prId} on this doc.${ids.length ? ` Its PRs: ${ids.join(", ")}.` : ""}`);
    }
    return e;
}

/** Would making `id` stack on `on` create a loop? */
function makesCycle(prs, id, on) {
    const byId = new Map(prs.map((p) => [p.id, p]));
    for (let cur = on, n = 0; cur && n <= prs.length; cur = byId.get(cur)?.stacksOn ?? null, n++) if (cur === id) return true;
    return false;
}

function resolveStacksOn(prs, stacksOn) {
    if (stacksOn == null || stacksOn === "") return null;
    if (typeof stacksOn !== "string") throw new InputError("stacksOn must be the id or URL of another PR on this doc.");
    const hit = prs.find((p) => p.id === stacksOn) ?? (/^https:\/\//.test(stacksOn) ? prs.find((p) => p.key === prKey(parsePrUrl(stacksOn))) : null);
    if (!hit) throw new InputError(`stacksOn: ${stacksOn} isn't a PR on this doc. Register it first.`);
    return hit.id;
}

/**
 * Add a PR. Returns {entry, created}. The same PR (by host/owner/repo/number, any URL form) is never added twice:
 * a repeat returns the existing entry with created:false, updating only what was passed.
 */
export function addPr(docId, { url, label, stacksOn, worktree, addedBy = "agent", settings } = {}) {
    const ident = parsePrUrl(url);
    const key = prKey(ident);
    return writeIndex(docId, (ix) => {
        const existing = ix.prs.find((p) => p.key === key);
        if (existing) {
            if (label !== undefined) existing.label = label || null;
            if (worktree !== undefined) existing.worktree = worktree || null;
            if (stacksOn !== undefined) {
                const on = resolveStacksOn(ix.prs, stacksOn);
                if (on && makesCycle(ix.prs, existing.id, on)) throw new InputError(`stacksOn: ${existing.id} can't stack on ${on}, which already builds on it.`);
                existing.stacksOn = on;
            }
            return { entry: existing, created: false };
        }
        if (ix.prs.length >= MAX_PRS) throw new InputError(`A doc tracks at most ${MAX_PRS} pull requests.`);
        const id = prIdFor(ident);
        const on = resolveStacksOn(ix.prs, stacksOn);
        const entry = {
            id,
            key,
            host: ident.host,
            owner: ident.owner,
            repo: ident.repo,
            number: ident.number,
            url: ident.url,
            label: label || null,
            stacksOn: on,
            worktree: worktree || null,
            addedBy,
            addedAt: new Date().toISOString(),
            settings: normalizeSettings(settings ?? DEFAULT_SETTINGS),
        };
        ix.prs.push(entry);
        return { entry, created: true };
    });
}

export function removePr(docId, prId) {
    getEntry(docId, prId);
    writeIndex(docId, (ix) => {
        ix.prs = ix.prs.filter((p) => p.id !== prId);
        for (const p of ix.prs) if (p.stacksOn === prId) p.stacksOn = null;
    });
    rmSync(prFile(docId, prId), { force: true });
}

export function setEntry(docId, prId, mutate) {
    return writeIndex(
        docId,
        (ix) => {
            const e = ix.prs.find((p) => p.id === prId);
            if (!e) throw new InputError(`No pull request ${prId} on this doc.`);
            return mutate(e);
        },
        { what: "settings", prId },
    );
}

// ---------- per-PR runtime state ----------

export const emptyPrState = () => ({
    v: 1,
    snapshot: null, // the last complete snapshot (see snapshot.mjs)
    staging: null, // an unfinished paginated fetch: {generation, cursors, …}
    lastModified: null, // for If-Modified-Since
    checkedAt: null,
    fetchedAt: null,
    seen: [], // ids of every comment-like item already accounted for (batched, or there before watching began)
    baselined: false, // the first complete fetch marks what's already there as seen
    pending: [], // new comments from others not yet in a batch: {id, unit, at, author, kind}
    lastArrivalAt: null,
    batches: [], // the outbox: see outbox.mjs
    batchSeq: 0,
    handled: [], // item ids in a finished batch
    heads: [], // head commits seen: [{sha, at}]
    facts: {}, // threadId -> {observed:[…], reported:[…]}
    activity: [], // newest last
    stopped: null, // "merged" | "closed": watching stopped by itself
    partial: null, // a first big fetch still counting: what's been seen so far
    login: null, // the gh account that reads this PR
    checksAt: null,
    nextAt: null, // when the next network check is due (cadence, backoff, rate limits)
    retryAt: null,
    error: null, // {kind, message, at, retryAt}
    errorNoted: false, // the chat was told this PR can't be checked (once per outage)
    backoffMs: 0,
});

export function readPr(docId, prId) {
    return { ...emptyPrState(), ...readJson(prFile(docId, prId), {}) };
}

export function writePr(docId, prId, mutate) {
    const st = readPr(docId, prId);
    const r = mutate(st);
    if (st.activity.length > ACTIVITY_MAX) st.activity = st.activity.slice(-ACTIVITY_MAX);
    // `seen` is never truncated: it's the dedupe for the PR's whole history (dropping an id would make an old
    // comment look new). It grows with the PR, one short id per comment.
    atomicWriteJson(prFile(docId, prId), st);
    emit(docId, { what: "pr", prId });
    return r;
}

/** Append to a PR's activity log (inside a writePr mutate). */
export const log = (st, text, extra = {}) => st.activity.push({ at: new Date().toISOString(), text, ...extra });

/** Docs that have PRs (for adopting watchers after a reload). */
export function docsWithPrs() {
    let dirs = [];
    try {
        dirs = readdirSync(paths.docs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {}
    return dirs.filter((d) => hasPrs(d));
}
