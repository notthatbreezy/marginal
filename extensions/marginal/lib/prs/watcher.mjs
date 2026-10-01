// Watches a doc's pull requests from inside the Marginal process, so no agent turn is ever spent asking GitHub
// "anything new?". Only the process holding the doc's lease runs one (see owns()).
//
// Every PR, on its own cadence:
//   - a cheap check each minute (If-Modified-Since: a 304 is free);
//   - a full fetch when that says something changed, and a reconciliation every 10 minutes regardless (every 2
//     while a batch is out or the PR is open in the detail view), because resolving a thread doesn't change the PR;
//   - checks alone every 2 minutes while some are pending (they change without the PR changing);
//   - a big PR's fetch resumes from its saved cursors across ticks (staging), and nothing is inferred from absence
//     until it completes.
// New comments from anyone but you wait in `pending`. What happens to them depends on the PR's handling level:
// Do nothing (shown only), Read (a line in the chat, no agent turn), or a batch for Copilot through the outbox.
import { needsAgent } from "./model.mjs";
import { complete as completeBatch, expire, markSeen, outstanding, prepare, admit } from "./outbox.mjs";
import { diffSnapshots, itemsOf, normalize } from "./snapshot.mjs";
import { log, readIndex, readPr, writePr } from "./state.mjs";

export const LIMITS = Object.freeze({
    tickMs: 15_000,
    checkMs: 60_000,
    reconcileMs: 10 * 60_000,
    fastReconcileMs: 2 * 60_000,
    checksMs: 2 * 60_000,
    quietMs: 90_000,
    maxBackoffMs: 10 * 60_000,
    pageBudget: 20,
    maxWatched: 20,
});

export const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

const short = (sha) => (sha ? sha.slice(0, 7) : "?");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const unitOf = (i) => (i.kind === "review_comment" ? `thread:${i.threadId}` : i.kind === "review" ? `review:${i.id}` : `comment:${i.id}`);

export function createWatcher({
    gh,
    clock = realClock,
    owns = () => true,
    send,
    compose,
    note = () => {},
    focused = () => false,
    messageInLog = null,
    limits: over = {},
} = {}) {
    const L = { ...LIMITS, ...over };
    const docs = new Map(); // docId -> {timer, running: Promise|null}
    const rt = new Map(); // `${docId}/${prId}` -> {fresh, sending, looked}
    const inflight = new Set();
    const session = { idleSince: null }; // when the session last went idle (null: busy or unknown)
    const active = new Set(); // PR keys being polled (for the cap)

    const runtime = (docId, prId) => {
        const k = `${docId}/${prId}`;
        if (!rt.has(k)) rt.set(k, { fresh: true, sending: false, looked: new Set() });
        return rt.get(k);
    };
    const track = (p) => {
        inflight.add(p);
        p.finally(() => inflight.delete(p));
        return p;
    };

    function schedule(docId) {
        const d = docs.get(docId);
        if (!d) return;
        clock.clearTimeout(d.timer);
        d.timer = clock.setTimeout(() => {
            tick(docId).finally(() => schedule(docId));
        }, L.tickMs);
        d.timer?.unref?.();
    }

    /** Start watching a doc's PRs (this process holds its lease). The first tick runs now. */
    function watch(docId) {
        if (docs.has(docId)) return;
        docs.set(docId, { timer: null, running: null });
        tick(docId).finally(() => schedule(docId));
    }

    function unwatch(docId) {
        const d = docs.get(docId);
        if (!d) return;
        clock.clearTimeout(d.timer);
        docs.delete(docId);
        for (const k of [...rt.keys()]) if (k.startsWith(`${docId}/`)) rt.delete(k);
    }

    /** One pass over a doc's PRs: network where due, then batching and delivery. Serial per doc. */
    function tick(docId) {
        const d = docs.get(docId);
        if (!d) return Promise.resolve();
        if (d.running) return d.running;
        d.running = track(
            (async () => {
                if (!owns(docId)) return;
                for (const entry of readIndex(docId).prs) {
                    try {
                        await tickPr(docId, entry);
                    } catch (e) {
                        if (process.env.MARGINAL_DEBUG_PRS) process.stderr.write(`PRS-ERR ${docId}/${entry.id}: ${e.stack}\n`);
                        writePr(docId, entry.id, (st) => log(st, `Unexpected error: ${e.message}`, { kind: "error" }));
                    }
                }
            })().finally(() => {
                d.running = null;
            }),
        );
        return d.running;
    }

    /** Check GitHub now (an agent's `pr refresh`, or the panel's Refresh). */
    async function refresh(docId, prId) {
        runtime(docId, prId).fresh = true;
        writePr(docId, prId, (st) => {
            st.retryAt = null;
            st.nextAt = null;
        });
        if (!docs.has(docId)) return;
        await docs.get(docId).running;
        await tick(docId);
    }

    async function tickPr(docId, entry) {
        const now = clock.now();
        const r = runtime(docId, entry.id);
        let st = readPr(docId, entry.id);
        const key = entry.key;
        if (!entry.settings.watch || st.stopped) active.delete(key);
        else if (!active.has(key) && active.size >= L.maxWatched) {
            if (st.error?.kind !== "cap") writePr(docId, entry.id, (s) => (s.error = { kind: "cap", message: `Marginal watches at most ${L.maxWatched} pull requests at once; this one is paused.`, at: new Date(now).toISOString() }));
        } else {
            active.add(key);
            // nextAt carries the cadence, backoff and rate limits; refresh() clears it.
            if (now >= (st.nextAt ?? 0)) {
                try {
                    await network(docId, entry, st, r, now);
                    writePr(docId, entry.id, (s) => {
                        if (s.error && s.error.kind !== "cap") log(s, "GitHub is answering again.");
                        s.error = null;
                        s.backoffMs = 0;
                        s.retryAt = null;
                        s.nextAt = now + (s.staging ? L.tickMs : L.checkMs); // a big fetch carries on at the next tick
                    });
                } catch (e) {
                    writePr(docId, entry.id, (s) => {
                        s.backoffMs = Math.min(L.maxBackoffMs, Math.max(L.checkMs, (s.backoffMs || L.checkMs / 2) * 2));
                        s.retryAt = e.retryAt && e.retryAt > now ? e.retryAt : null;
                        s.nextAt = Math.max(now + s.backoffMs, s.retryAt ?? 0);
                        const message = e.kind === "rate_limit" ? `GitHub's rate limit: waiting until ${new Date(s.nextAt).toLocaleTimeString()}.` : e.message;
                        if (s.error?.message !== message) log(s, message, { kind: "error" });
                        s.error = { kind: e.kind ?? "error", message, at: new Date(now).toISOString(), retryAt: s.nextAt };
                    });
                }
            }
        }
        await deliver(docId, entry, now);
    }

    async function network(docId, entry, st0, r, now) {
        const pr = entry;
        const fast = !!outstanding(st0) || focused(docId, entry.id);
        let full = r.fresh || !st0.snapshot || !!st0.staging || now - Date.parse(st0.fetchedAt ?? 0) >= (fast ? L.fastReconcileMs : L.reconcileMs);
        let lastModified = st0.lastModified;
        if (!st0.staging && (!full || !lastModified)) {
            const c = await gh.check(pr, st0.lastModified);
            writePr(docId, entry.id, (s) => {
                s.checkedAt = new Date(now).toISOString();
                s.login = c.login ?? s.login ?? null;
            });
            if (c.changed) {
                full = true;
                lastModified = c.lastModified;
            }
        }
        if (full) {
            const self = await gh.selfLogins(pr.host);
            const f = await gh.fetchPullRequest(pr, { staging: st0.staging, budget: L.pageBudget });
            const snap = normalize(f.raw, { host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number }, { fetchedAt: new Date(now).toISOString() });
            writePr(docId, entry.id, (s) => {
                s.lastModified = lastModified;
                s.checkedAt = new Date(now).toISOString();
                absorb(s, snap, f, self, now, entry);
            });
            r.fresh = false;
            return;
        }
        r.fresh = false;
        if (st0.snapshot?.checks?.pending && now - Date.parse(st0.checksAt ?? 0) >= L.checksMs) {
            const c = await gh.fetchChecks(pr);
            writePr(docId, entry.id, (s) => {
                s.checksAt = new Date(now).toISOString();
                if (!s.snapshot || (c.headSha && c.headSha !== s.snapshot.pr.headSha)) {
                    r.fresh = true; // a push the cheap check hasn't seen yet: fetch everything next time
                    return;
                }
                const before = s.snapshot.checks;
                const checks = normalize({ pr: { ...s.snapshot.pr, state: "OPEN" }, threads: [], reviews: [], comments: [], checks: c.checks }, s.snapshot.pr).checks;
                s.snapshot.checks = c.more ? { ...checks, total: Math.max(checks.total, before.total) } : checks;
                if (before.pending && !checks.pending) log(s, checks.failed ? `Checks finished: ${checks.failed} failed (${checks.failing.join(", ")}).` : `Checks finished: all ${checks.passed} passed.`, { kind: "checks" });
            });
        }
    }

    /** Fold a fetch into the PR's state: the snapshot, what's observed, and what's new. */
    function absorb(st, snap, f, self, now, entry) {
        const at = new Date(now).toISOString();
        const mine = new Set(self.map((l) => l.toLowerCase()));
        const isOther = (i) => i.author == null || !mine.has(i.author.toLowerCase());
        if (f.complete) {
            const d = st.snapshot ? diffSnapshots(st.snapshot, snap) : null;
            if (d && st.baselined) observe(st, d, snap, mine, at);
            if (d?.deleted.length) {
                const gone = new Set(d.deleted.map((i) => i.id));
                const before = st.pending.length;
                st.pending = st.pending.filter((p) => !gone.has(p.id));
                log(st, `${plural(d.deleted.length, "comment")} deleted on GitHub${before !== st.pending.length ? `; ${before - st.pending.length} dropped from what's waiting` : ""}.`, { kind: "deleted" });
            }
            if (d?.edited.length) log(st, `${plural(d.edited.length, "comment")} edited on GitHub.`, { kind: "edited" });
            st.snapshot = snap;
            st.staging = null;
            st.fetchedAt = at;
            st.checksAt = at; // a full fetch brings the checks too
            if (snap.pr.state !== "open" && !st.stopped) {
                st.stopped = snap.pr.state;
                log(st, `${snap.pr.state === "merged" ? "Merged" : "Closed"}: stopped watching.`, { kind: "state" });
            }
            if (!(st.heads ?? []).some((h) => h.sha === snap.pr.headSha)) st.heads = [...(st.heads ?? []), { sha: snap.pr.headSha, at }].slice(-100);
        } else {
            st.staging = f.staging;
            if (!st.snapshot) st.partial = snap; // something to show while a first big fetch is still counting
        }
        if (!st.baselined) {
            // What's there when watching starts isn't news. Only a complete traversal can say what's there.
            if (!f.complete) return;
            st.seen = itemsOf(snap).map((i) => i.id);
            st.baselined = true;
            st.partial = null;
            const unresolved = snap.threads.filter((t) => !t.resolved).length;
            log(st, `Watching from now: ${plural(snap.threads.length, "thread")} (${unresolved} unresolved), ${plural(snap.conversation.length, "conversation comment")}.`, { kind: "start" });
            return;
        }
        const seen = new Set(st.seen);
        const fresh = itemsOf(snap).filter((i) => !seen.has(i.id));
        const others = [];
        for (const i of fresh) {
            st.seen.push(i.id);
            if (isOther(i) && (i.kind !== "review" || i.body.trim())) {
                // A comment that opens a thread came in a submitted review (GitHub publishes a review's comments
                // together): those go at once. Replies and conversation comments wait for a quiet spell.
                st.pending.push({ id: i.id, unit: unitOf(i), at, author: i.author, kind: i.kind, ...(i.kind === "review" || (i.kind === "review_comment" && !i.replyTo) ? { review: true } : {}) });
                others.push(i);
            }
        }
        if (others.length) {
            const who = [...new Set(others.map((i) => i.author ?? "a deleted account"))].join(", ");
            log(st, `${plural(others.length, "new comment")} from ${who}.`, { kind: "new", ids: others.map((i) => i.id) });
            st.lastArrivalAt = at;
        }
        if (snap.pr.state === "open" && st.partial) st.partial = snap;
    }

    /** Facts GitHub shows about each thread; never a claim about who meant what. */
    function observe(st, d, snap, mine, at) {
        const add = (threadId, fact) => {
            const f = (st.facts[threadId] ??= { observed: [], reported: [] });
            f.observed.push({ at, ...fact });
            if (f.observed.length > 30) f.observed = f.observed.slice(-30);
        };
        const byThread = new Map(snap.threads.map((t) => [t.id, t]));
        for (const id of d.resolved) add(id, { kind: "resolved", by: byThread.get(id)?.resolvedBy ?? null });
        for (const id of d.reopened) add(id, { kind: "reopened" });
        for (const id of d.outdated) add(id, { kind: "outdated" });
        const heads = [...(st.heads ?? []).map((h) => h.sha), snap.pr.headSha];
        for (const i of d.added) {
            if (i.kind !== "review_comment" || !i.author || !mine.has(i.author.toLowerCase())) continue;
            const sha = (i.body.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).find((h) => heads.some((s) => s?.toLowerCase().startsWith(h.toLowerCase())));
            add(i.threadId, { kind: "replied", by: i.author, commentId: i.id, ...(sha ? { commit: sha.toLowerCase() } : {}) });
        }
        if (d.resolved.length) log(st, `${plural(d.resolved.length, "thread")} resolved.`, { kind: "resolved" });
        if (d.reopened.length) log(st, `${plural(d.reopened.length, "thread")} reopened.`, { kind: "reopened" });
        if (d.pushed) {
            log(st, `New commits on ${snap.pr.head}: ${short(d.pushed.from)} → ${short(d.pushed.to)}.`, { kind: "pushed", sha: d.pushed.to });
            for (const b of st.batches) if (b.admittedAt && b.state !== "done") b.pushedAfter = [...new Set([...(b.pushedAfter ?? []), d.pushed.to])];
            const last = st.batches.at(-1);
            if (last?.state === "done" && Date.parse(at) - Date.parse(last.doneAt) < 30 * 60_000) last.pushedAfter = [...new Set([...(last.pushedAfter ?? []), d.pushed.to])];
        }
        if (d.state) log(st, `Now ${d.state.to} (was ${d.state.from}).`, { kind: "state" });
        if (d.reviewDecision) log(st, `Review decision: ${(d.reviewDecision.to ?? "none").toLowerCase().replace(/_/g, " ")}.`, { kind: "review" });
        if (d.checks && d.checks.from.pending && !d.checks.to.pending) log(st, d.checks.to.failed ? `Checks finished: ${d.checks.to.failed} failed (${d.checks.to.failing.join(", ")}).` : `Checks finished: all ${d.checks.to.passed} passed.`, { kind: "checks" });
    }

    /** What's waiting goes where the handling level says; a prepared batch is sent. */
    async function deliver(docId, entry, now) {
        const level = entry.settings.handle;
        const r = runtime(docId, entry.id);
        let st = readPr(docId, entry.id);
        const ob = outstanding(st);
        // After a restart: was an admitted batch's message taken up while we weren't watching?
        if (ob?.state === "admitted" && messageInLog && !r.looked.has(ob.id)) {
            r.looked.add(ob.id);
            const found = await messageInLog(ob.messageId).catch(() => null);
            if (found?.found)
                st = writePr(docId, entry.id, (s) => {
                    const b = s.batches.find((x) => x.id === ob.id);
                    if (markSeen(b, now) && found.done) {
                        completeBatch(s, b, now);
                        log(s, `Copilot finished batch ${b.id}.`, { kind: "done", batchId: b.id });
                    }
                    return s;
                });
        }
        writePr(docId, entry.id, (s) => {
            const b = outstanding(s);
            if (b && expire(b, now, { idleSince: session.idleSince })) log(s, `Copilot never took up batch ${b.id}; sending it again.`, { kind: "resend", batchId: b.id });
        });
        st = readPr(docId, entry.id);
        if (st.pending.length) {
            if (level === "none") writePr(docId, entry.id, (s) => (s.pending = []));
            else if (level === "read") {
                if (quiet(st, now)) {
                    const text = `${plural(st.pending.length, "new review comment")} on #${entry.number}${st.snapshot ? ` "${st.snapshot.pr.title}"` : ""} from ${[...new Set(st.pending.map((p) => p.author ?? "a deleted account"))].join(", ")}.`;
                    writePr(docId, entry.id, (s) => {
                        s.pending = [];
                        log(s, `Noted in the chat: ${text}`, { kind: "read" });
                    });
                    note(docId, entry, text);
                }
            } else if (needsAgent(level) && !outstanding(st) && quiet(st, now) && st.snapshot) {
                const units = [...new Set(st.pending.map((p) => p.unit))];
                const batchNo = (st.batchSeq ?? 0) + 1;
                const composed = compose({ docId, entry, st, snapshot: st.snapshot, units, batchId: `${entry.id}-b${batchNo}`, level, now });
                const included = new Set(composed.units?.length ? composed.units : units.slice(0, 1));
                writePr(docId, entry.id, (s) => {
                    const items = s.pending.filter((p) => included.has(p.unit));
                    const b = prepare(s, { prId: entry.id, level, deliver: entry.settings.deliver, units: [...included], itemIds: items.map((p) => p.id), now });
                    b.text = composed.text;
                    b.display = composed.displayPrompt;
                    s.pending = s.pending.filter((p) => !included.has(p.unit));
                    log(s, `Batch ${b.id}: ${plural(items.length, "comment")} in ${plural(included.size, "thread")} for Copilot (up to ${level}).${s.pending.length ? ` ${s.pending.length} more wait for the next batch.` : ""}`, { kind: "batch", batchId: b.id });
                });
            }
        }
        st = readPr(docId, entry.id);
        const b = outstanding(st);
        if (b?.state === "prepared" && !r.sending && needsAgent(b.level)) {
            r.sending = true;
            try {
                const res = await send({ docId, entry, batch: b, text: b.repeat ? `[This batch (${b.id}) may have reached you already: if you've handled it, skip it.]\n\n${b.text}` : b.text, displayPrompt: b.display, mode: b.deliver === "interrupt" ? "immediate" : "enqueue" });
                writePr(docId, entry.id, (s) => {
                    const x = s.batches.find((y) => y.id === b.id);
                    admit(x, res.messageId, clock.now());
                    log(s, `Sent batch ${b.id} to Copilot${b.deliver === "interrupt" ? " (interrupting)" : " (queued behind its current work)"}.`, { kind: "sent", batchId: b.id });
                });
            } catch (e) {
                writePr(docId, entry.id, (s) => log(s, `Couldn't send batch ${b.id}: ${e.message}. Trying again shortly.`, { kind: "error" }));
            } finally {
                r.sending = false;
            }
        }
    }

    const quiet = (st, now) => st.pending.some((p) => p.review) || now - Date.parse(st.lastArrivalAt ?? st.pending.at(-1)?.at ?? 0) >= L.quietMs;

    /** Session events: a batch's message showing up, and the turn for it ending. */
    function onSessionEvent(ev) {
        const now = clock.now();
        if (ev.type === "user.message" || ev.type === "assistant.turn_start") session.idleSince = null;
        const ids = ev.type === "user.message" ? [ev.id, ev.data?.messageId].filter(Boolean) : [];
        if (ids.length) {
            for (const docId of docs.keys())
                for (const entry of readIndex(docId).prs) {
                    const st = readPr(docId, entry.id);
                    if (st.batches.some((b) => b.state === "admitted" && ids.includes(b.messageId)))
                        writePr(docId, entry.id, (s) => {
                            const b = s.batches.find((x) => ids.includes(x.messageId));
                            if (markSeen(b, now)) log(s, `Copilot took up batch ${b.id}.`, { kind: "seen", batchId: b.id });
                        });
                }
        }
        if (ev.type === "session.idle") {
            session.idleSince = now;
            for (const docId of docs.keys())
                for (const entry of readIndex(docId).prs) {
                    const st = readPr(docId, entry.id);
                    if (st.batches.some((b) => b.state === "seen"))
                        writePr(docId, entry.id, (s) => {
                            for (const b of s.batches.filter((x) => x.state === "seen")) {
                                completeBatch(s, b, now);
                                log(s, `Copilot finished batch ${b.id}.`, { kind: "done", batchId: b.id });
                            }
                        });
                }
            for (const docId of docs.keys()) tick(docId); // the next batch can go now
        }
    }

    return {
        watch,
        unwatch,
        tick,
        refresh,
        onSessionEvent,
        watching: () => [...docs.keys()],
        settled: async () => {
            while (inflight.size) await Promise.allSettled([...inflight]);
        },
        stopAll: () => {
            for (const id of [...docs.keys()]) unwatch(id);
        },
    };
}
