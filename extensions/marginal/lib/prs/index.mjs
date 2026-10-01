// The Pull requests service: one per Marginal process. It owns the watcher, decides which docs this process
// watches (the doc's lease, shared with the Command center), and is what the canvas actions and the panel's API
// call. Copilot hears from it only through batches and Read notes; it never needs to read GitHub itself.
import { InputError } from "../errors.mjs";
import * as store from "../store.mjs";
import { adoptIfMine, claim, isOwner, readLease } from "../command/owner.mjs";
import { github as sharedGitHub } from "./github.mjs";
import { parsePrUrl } from "./identity.mjs";
import { composeBatch, readText } from "./message.mjs";
import { STEP_LABEL, needsAgent, updateSettings } from "./model.mjs";
import { outstanding } from "./outbox.mjs";
import { displayState, itemsOf, threadCounts } from "./snapshot.mjs";
import { addPr, docsWithPrs, getEntry, log, readIndex, readPr, removePr, setEntry, writePr } from "./state.mjs";
import { createWatcher, realClock } from "./watcher.mjs";

const REPORT_STATUS = ["assessed", "fixed", "reviewed", "declined", "question"];

export function createPrService({ getSession, getSessionId, transcript = null, gh = null, clock = realClock, limits } = {}) {
    const client = () => gh ?? sharedGitHub();
    const focus = new Map(); // `${docId}/${prId}` -> expiry (a panel has the detail view open)
    const sessionId = () => getSessionId?.() ?? null;

    const watcher = createWatcher({
        gh: {
            check: (...a) => client().check(...a),
            selfLogins: (...a) => client().selfLogins(...a),
            fetchPullRequest: (...a) => client().fetchPullRequest(...a),
            fetchChecks: (...a) => client().fetchChecks(...a),
        },
        clock,
        limits,
        owns: (docId) => !!sessionId() && isOwner(docId, sessionId()),
        focused: (docId, prId) => (focus.get(`${docId}/${prId}`) ?? 0) > clock.now(),
        compose: ({ docId, entry, st, snapshot, units, batchId, level }) =>
            composeBatch({ entry, snapshot, units, batchId, level, newIds: st.pending.map((p) => p.id), docTitle: store.hasDoc(docId) ? store.getDoc(docId).title : null, docId }),
        send: async ({ text, displayPrompt, mode }) => {
            const session = getSession();
            if (!session) throw new Error("not connected to the Copilot session yet");
            const messageId = await session.send({ prompt: text, displayPrompt, mode });
            return { messageId };
        },
        note: (docId, entry, text) => transcript?.notice({ id: `pr-note-${entry.id}-${clock.now()}`, text: `${text}\n\nFrom Marginal · Pull requests`, docId, prId: entry.id, url: entry.url }),
        messageInLog: async (messageId) => {
            const session = getSession();
            if (!session?.rpc?.eventLog?.read) return null;
            const r = await session.rpc.eventLog.read({ direction: "backward", agentScope: "primary", includeEphemeral: false, types: ["user.message"], max: 300 });
            const ev = r.events ?? [];
            const i = ev.findIndex((e) => e.id === messageId || e.data?.messageId === messageId);
            if (i < 0) return { found: false };
            // Done if another request came after it, or the session is idle now.
            return { found: true, done: i < ev.length - 1 || transcript?.status?.() === "idle" };
        },
    });

    /** Is this process the one watching the doc's PRs? Claims the lease when nobody else holds it live. */
    function own(docId) {
        const sid = sessionId();
        if (!sid) return false;
        if (isOwner(docId, sid)) {
            watcher.watch(docId);
            return true;
        }
        const r = claim(docId, sid);
        if (r.ok) watcher.watch(docId);
        return r.ok;
    }

    function ownership(docId) {
        const l = readLease(docId);
        const sid = sessionId();
        return { here: !!sid && !!l?.live && l.sessionId === sid, watcher: l?.live ? l.sessionId : null };
    }

    /** A doc made from a PR has that PR on its list (and watched), without anyone registering it. */
    function ensureDocPr(docId) {
        const doc = store.hasDoc(docId) ? store.getDoc(docId) : null;
        const url = doc?.pullRequest?.url;
        if (!url) return;
        let key;
        try {
            key = parsePrUrl(url);
        } catch {
            return;
        }
        if (readIndex(docId).prs.some((p) => p.host === key.host && p.owner.toLowerCase() === key.owner.toLowerCase() && p.repo.toLowerCase() === key.repo.toLowerCase() && p.number === key.number)) return;
        const r = addPr(docId, { url, addedBy: "doc" });
        writePr(docId, r.entry.id, (st) => log(st, "Listed because this doc was made from it; watching: on, handling: Read.", { kind: "added" }));
        own(docId);
    }

    /** The logins that count as you on a host (cached by the client); none if gh can't say. */
    const selfOn = async (host) => new Set((await client().selfLogins(host).catch(() => [])).map((l) => l.toLowerCase()));

    function summary(docId, entry, self = new Set()) {
        const st = readPr(docId, entry.id);
        const snap = st.snapshot ?? st.partial;
        const ob = outstanding(st);
        const lastDone = st.batches.filter((b) => b.state === "done").at(-1) ?? null;
        return {
            ...entry,
            title: snap?.pr.title ?? null,
            state: snap ? displayState(snap.pr) : null,
            reviewDecision: snap?.pr.reviewDecision ?? null,
            head: snap?.pr.head ?? null,
            base: snap?.pr.base ?? null,
            author: snap?.pr.author ?? null,
            updatedAt: snap?.pr.updatedAt ?? null,
            checks: snap ? { total: snap.checks.total, passed: snap.checks.passed, failed: snap.checks.failed, pending: snap.checks.pending, failing: snap.checks.failing } : null,
            threads: snap ? threadCounts(snap) : null,
            counting: !st.snapshot || !!st.staging, // a big first fetch, or a traversal in progress
            // For each panel's own "new since you looked": the newest items, by time.
            recent: snap ? itemsOf(snap).map((i) => ({ id: i.id, at: i.createdAt, author: i.author, kind: i.kind, threadId: i.threadId ?? null, mine: !!i.author && self.has(i.author.toLowerCase()) })).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100) : [],
            pending: st.pending.length,
            batch: ob ? { id: ob.id, state: ob.state, level: ob.level, threads: ob.units.length, comments: ob.itemIds.length } : null,
            lastBatch: lastDone ? { id: lastDone.id, doneAt: lastDone.doneAt, threads: lastDone.units.length, comments: lastDone.itemIds.length } : null,
            stopped: st.stopped,
            error: st.error,
            checkedAt: st.checkedAt,
            fetchedAt: st.fetchedAt,
            login: st.login,
        };
    }

    async function list(docId) {
        ensureDocPr(docId);
        const prs = readIndex(docId).prs;
        const selves = new Map();
        for (const h of new Set(prs.map((e) => e.host))) selves.set(h, await selfOn(h));
        return { prs: prs.map((e) => summary(docId, e, selves.get(e.host))), ownership: ownership(docId) };
    }

    async function detail(docId, prId) {
        const entry = getEntry(docId, prId);
        const st = readPr(docId, prId);
        const self = await selfOn(entry.host);
        return {
            ...summary(docId, entry, self),
            self: [...self],
            snapshot: st.snapshot ?? st.partial,
            facts: st.facts,
            batches: st.batches.slice(-20).map(({ text, ...b }) => b),
            pendingItems: st.pending,
            activity: st.activity.slice(-80),
            ownership: ownership(docId),
        };
    }

    function register(docId, { url, label, stacksOn, worktree, settings, by = "agent" } = {}) {
        if (!store.hasDoc(docId)) throw new InputError(`No doc ${docId}.`);
        const patch = settings ? updateSettings({}, settings) : undefined;
        const r = addPr(docId, { url, label, stacksOn, worktree, addedBy: by, settings: patch });
        if (r.created) writePr(docId, r.entry.id, (st) => log(st, `Added by ${by === "user" ? "you" : by === "doc" ? "the doc" : "Copilot"}; watching: ${r.entry.settings.watch ? "on" : "off"}, handling: ${STEP_LABEL[r.entry.settings.handle] ?? "do nothing"}.`, { kind: "added" }));
        const watching = own(docId);
        if (watching) watcher.refresh(docId, r.entry.id).catch(() => {});
        return { ...r, watching };
    }

    function remove(docId, prId) {
        removePr(docId, prId);
        return { removed: prId };
    }

    function settings(docId, prId, patch, { by = "user" } = {}) {
        const before = getEntry(docId, prId).settings;
        const next = updateSettings(before, patch);
        setEntry(docId, prId, (e) => {
            e.settings = next;
            if (patch.label !== undefined) e.label = patch.label || null;
            if (patch.worktree !== undefined) e.worktree = patch.worktree || null;
        });
        const changes = [];
        if (before.watch !== next.watch) changes.push(next.watch ? "watching on" : "watching off");
        if (before.handle !== next.handle) changes.push(next.handle === "none" ? "do nothing" : `handle up to ${STEP_LABEL[next.handle]}`);
        if (before.deliver !== next.deliver) changes.push(next.deliver === "interrupt" ? "interrupt Copilot" : "queue behind Copilot's work");
        writePr(docId, prId, (st) => {
            if (next.watch && !before.watch) st.stopped = null; // turned back on (after a merge, say)
            if (changes.length) log(st, `${by === "user" ? "You" : "Copilot"} set ${changes.join(", ")}.`, { kind: "settings" });
        });
        if (own(docId) && next.watch) watcher.refresh(docId, prId).catch(() => {});
        return { settings: next, watching: ownership(docId).here };
    }

    function report(docId, prId, threads) {
        getEntry(docId, prId);
        if (!Array.isArray(threads) || !threads.length) throw new InputError('threads must be a list of {threadId, status, note?, commit?}.');
        const st0 = readPr(docId, prId);
        const known = new Set([...(st0.snapshot?.threads ?? []).map((t) => t.id), ...(st0.snapshot?.reviews ?? []).map((r) => r.id), ...(st0.snapshot?.conversation ?? []).map((c) => c.id)]);
        for (const [i, t] of threads.entries()) {
            if (!t || typeof t.threadId !== "string") throw new InputError(`threads[${i}].threadId is required.`);
            if (!known.has(t.threadId)) throw new InputError(`threads[${i}].threadId ${t.threadId} isn't on ${prId} (as Marginal last saw it).`);
            if (!REPORT_STATUS.includes(t.status)) throw new InputError(`threads[${i}].status must be one of ${REPORT_STATUS.join(", ")}.`);
            if (t.commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(String(t.commit))) throw new InputError(`threads[${i}].commit must be a commit sha.`);
        }
        writePr(docId, prId, (st) => {
            const at = new Date(clock.now()).toISOString();
            for (const t of threads) {
                const f = (st.facts[t.threadId] ??= { observed: [], reported: [] });
                f.reported.push({ at, status: t.status, ...(t.note ? { note: String(t.note).slice(0, 500) } : {}), ...(t.commit ? { commit: String(t.commit).toLowerCase() } : {}) });
                if (f.reported.length > 20) f.reported = f.reported.slice(-20);
            }
            const counts = Object.entries(threads.reduce((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`);
            log(st, `Copilot reported: ${counts.join(", ")}.`, { kind: "reported" });
        });
        return { recorded: threads.length };
    }

    function read(docId, prId, { threadId = null, threads = "unresolved" } = {}) {
        const entry = getEntry(docId, prId);
        const st = readPr(docId, prId);
        const snap = st.snapshot ?? st.partial;
        if (!snap) return { prId, text: "Marginal hasn't fetched this PR yet; try again in a minute (or pr {op:\"refresh\"})." };
        if (threadId && !snap.threads.some((t) => t.id === threadId) && !snap.reviews.some((r) => r.id === threadId) && !snap.conversation.some((c) => c.id === threadId)) throw new InputError(`No thread ${threadId} on ${prId}.`);
        if (!["unresolved", "new", "all"].includes(threads)) throw new InputError('threads must be "unresolved", "new" or "all".');
        return { prId, url: entry.url, fetchedAt: snap.fetchedAt, text: readText({ entry, snapshot: snap, threadId, which: threads, newIds: st.pending.map((p) => p.id) }) };
    }

    async function refresh(docId, prId) {
        getEntry(docId, prId);
        if (!own(docId)) throw new InputError(`Another session (${readLease(docId)?.sessionId}) watches this doc's pull requests.`);
        await watcher.refresh(docId, prId);
        return summary(docId, getEntry(docId, prId));
    }

    function setFocus(docId, prId, on) {
        const k = `${docId}/${prId}`;
        if (on) focus.set(k, clock.now() + 5 * 60_000);
        else focus.delete(k);
    }

    /** After an extension reload: watch the docs whose lease this session still holds. */
    function adopt() {
        const sid = sessionId();
        if (!sid) return [];
        const docs = docsWithPrs().filter((d) => adoptIfMine(d, sid) || isOwner(d, sid));
        for (const d of docs) watcher.watch(d);
        return docs;
    }

    /** Ask the agent: the Ask in chat payload for one thread, built from the snapshot. */
    function threadContext(docId, prId, threadId) {
        const r = read(docId, prId, { threadId });
        return `${r.text}\n\n(From the Pull requests tab: ${r.url}, prId ${prId}. Marginal fetched this ${r.fetchedAt}; you don't need to read it from GitHub.)`;
    }

    return { list, detail, register, remove, settings, report, read, refresh, setFocus, adopt, own, ownership, threadContext, onSessionEvent: (ev) => watcher.onSessionEvent(ev), watcher, needsAgent };
}
