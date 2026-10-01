// The PR as Marginal last saw it, normalized from GitHub's GraphQL, and the diff between two such snapshots.
// Pure functions; the GitHub client assembles the raw pages, the watcher decides what a diff means.

const CHECK_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CHECK_FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR", "STALE"]);

const login = (a) => a?.login ?? null; // null: a deleted account ("ghost")

/** One check context → {name, result: passed|failed|pending, url}. */
function checkOf(n) {
    if (n.__typename === "StatusContext") {
        const s = n.state;
        return { name: n.context, result: s === "SUCCESS" ? "passed" : s === "FAILURE" || s === "ERROR" ? "failed" : "pending", url: n.targetUrl ?? null };
    }
    const result = n.status !== "COMPLETED" ? "pending" : CHECK_PASS.has(n.conclusion) ? "passed" : CHECK_FAIL.has(n.conclusion) ? "failed" : "passed";
    return { name: n.name, result, url: n.detailsUrl ?? null };
}

export function summarizeChecks(items) {
    const count = (r) => items.filter((c) => c.result === r).length;
    return { total: items.length, passed: count("passed"), failed: count("failed"), pending: count("pending"), failing: items.filter((c) => c.result === "failed").map((c) => c.name), items };
}

/**
 * raw: {pr, threads:[thread with comments.nodes complete], reviews:[], comments:[], checks:[] | null, complete}.
 * Returns a plain JSON snapshot. `ident` is the PR's {host, owner, repo, number}.
 */
export function normalize(raw, ident, { fetchedAt = new Date().toISOString() } = {}) {
    const p = raw.pr;
    const state = p.merged ? "merged" : p.state === "CLOSED" ? "closed" : "open";
    const threads = raw.threads.map((t) => {
        const comments = (t.comments?.nodes ?? []).map((c) => ({
            id: c.id,
            dbId: c.databaseId ?? null,
            author: login(c.author),
            body: c.body ?? "",
            createdAt: c.createdAt,
            editedAt: c.lastEditedAt ?? null,
            url: c.url ?? null,
            reviewId: c.pullRequestReview?.id ?? null,
            replyTo: c.replyTo?.id ?? null,
        }));
        return {
            id: t.id,
            path: t.path,
            line: t.line ?? null,
            startLine: t.startLine ?? null,
            originalLine: t.originalLine ?? null,
            side: t.diffSide ?? "RIGHT",
            resolved: !!t.isResolved,
            outdated: !!t.isOutdated,
            resolvedBy: login(t.resolvedBy),
            hunk: t.comments?.nodes?.[0]?.diffHunk ?? "",
            comments,
        };
    });
    // A reply is wrapped in its own COMMENTED review with an empty body: only reviews that say something are kept.
    const reviews = raw.reviews
        .filter((r) => (r.body ?? "").trim() || (r.state && r.state !== "COMMENTED" && r.state !== "PENDING"))
        .map((r) => ({ id: r.id, dbId: r.databaseId ?? null, author: login(r.author), state: r.state, body: r.body ?? "", submittedAt: r.submittedAt, url: r.url ?? null }));
    const conversation = raw.comments.map((c) => ({ id: c.id, dbId: c.databaseId ?? null, author: login(c.author), body: c.body ?? "", createdAt: c.createdAt, editedAt: c.lastEditedAt ?? null, url: c.url ?? null }));
    const checks = summarizeChecks((raw.checks ?? []).map(checkOf));
    return {
        v: 1,
        fetchedAt,
        complete: raw.complete !== false,
        pr: {
            ...ident,
            url: p.url,
            title: p.title,
            state,
            draft: !!p.isDraft,
            author: login(p.author),
            base: p.baseRefName,
            head: p.headRefName,
            headSha: p.headRefOid,
            reviewDecision: p.reviewDecision ?? null,
            updatedAt: p.updatedAt,
        },
        checks,
        threads,
        reviews,
        conversation,
    };
}

/** Every comment-like item: thread comments, review summaries and conversation comments. */
export function itemsOf(snap) {
    const out = [];
    for (const t of snap?.threads ?? []) for (const c of t.comments) out.push({ kind: "review_comment", threadId: t.id, ...c });
    for (const r of snap?.reviews ?? []) out.push({ kind: "review", id: r.id, author: r.author, body: r.body, createdAt: r.submittedAt, editedAt: null, reviewId: r.id, state: r.state, url: r.url });
    for (const c of snap?.conversation ?? []) out.push({ kind: "comment", ...c });
    return out;
}

/** Thread counts for the list: unresolved / total (review threads only). */
export const threadCounts = (snap) => ({ total: snap?.threads?.length ?? 0, unresolved: (snap?.threads ?? []).filter((t) => !t.resolved).length });

/**
 * What changed from prev to next. Deletions (and anything inferred from absence) are reported only when next is a
 * complete traversal: a partial snapshot never makes something look deleted.
 */
export function diffSnapshots(prev, next) {
    const before = new Map(itemsOf(prev).map((i) => [i.id, i]));
    const after = itemsOf(next);
    const afterIds = new Set(after.map((i) => i.id));
    const added = after.filter((i) => !before.has(i.id));
    const edited = after.filter((i) => {
        const b = before.get(i.id);
        return b && (b.body !== i.body || b.editedAt !== i.editedAt);
    });
    const deleted = prev && next.complete ? [...before.values()].filter((i) => !afterIds.has(i.id)) : [];
    const prevThreads = new Map((prev?.threads ?? []).map((t) => [t.id, t]));
    const resolved = [];
    const reopened = [];
    const outdated = [];
    for (const t of next.threads) {
        const b = prevThreads.get(t.id);
        if (!b) continue;
        if (t.resolved && !b.resolved) resolved.push(t.id);
        if (!t.resolved && b.resolved) reopened.push(t.id);
        if (t.outdated && !b.outdated) outdated.push(t.id);
    }
    const p0 = prev?.pr;
    const p1 = next.pr;
    return {
        added,
        edited,
        deleted,
        resolved,
        reopened,
        outdated,
        state: p0 && (p0.state !== p1.state || p0.draft !== p1.draft) ? { from: p0.draft && p0.state === "open" ? "draft" : p0.state, to: p1.draft && p1.state === "open" ? "draft" : p1.state } : null,
        pushed: p0 && p0.headSha !== p1.headSha ? { from: p0.headSha, to: p1.headSha } : null,
        checks: prev && (prev.checks.failed !== next.checks.failed || prev.checks.pending !== next.checks.pending || prev.checks.total !== next.checks.total) ? { from: prev.checks, to: next.checks } : null,
        reviewDecision: p0 && p0.reviewDecision !== p1.reviewDecision ? { from: p0.reviewDecision, to: p1.reviewDecision } : null,
    };
}

/** The status the list shows: draft / open / merged / closed. */
export const displayState = (pr) => (pr.state === "open" && pr.draft ? "draft" : pr.state);
