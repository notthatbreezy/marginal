// Pull requests tab, phase pr1: PR identity, the settings ladder, the snapshot and its diff, the GitHub client
// (accounts, the cheap check, paginated fetches) and the per-doc store. GitHub is a recorded fake (`exec`).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "wb-prs-unit-"));
process.env.MARGINAL_DATA_DIR = join(tmp, "data");
after(() => rmSync(tmp, { recursive: true, force: true }));

const { parsePrUrl, prKey, prIdFor } = await import("../extensions/marginal/lib/prs/identity.mjs");
const M = await import("../extensions/marginal/lib/prs/model.mjs");
const S = await import("../extensions/marginal/lib/prs/snapshot.mjs");
const { createGitHub, QUERIES, parseIncluded } = await import("../extensions/marginal/lib/prs/github.mjs");
const St = await import("../extensions/marginal/lib/prs/state.mjs");

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = JSON.parse(readFileSync(join(here, "fixtures", "prs", "sandbox-1.graphql.json"), "utf8")).data.repository.pullRequest;
const SANDBOX = { host: "github.com", owner: "notthatbreezy", repo: "marginal-sandbox", number: 1 };

/** A raw (assembled) PR from the recorded GraphQL response. */
const rawFromFixture = (p = sandbox) => ({ pr: p, threads: p.reviewThreads.nodes, reviews: p.reviews.nodes, comments: p.comments.nodes, checks: p.commits.nodes[0].commit.statusCheckRollup?.contexts?.nodes ?? [], complete: true });

// ---------- a recorded fake gh ----------
/**
 * accounts: {host: [{login, active}]}; reply(args, login) -> {code, stdout, stderr}. Records every call with the
 * login whose token it carried.
 */
function fakeGh({ accounts = { "github.com": [{ login: "me", active: true }] }, reply }) {
    const calls = [];
    const exec = async (args, { env }) => {
        if (args[0] === "auth" && args[1] === "status") {
            const host = args[args.indexOf("--hostname") + 1];
            const list = (accounts[host] ?? []).map((a) => ({ state: "success", host, ...a }));
            return { code: 0, stdout: JSON.stringify({ hosts: { [host]: list } }), stderr: "" };
        }
        if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: `tok-${args[args.indexOf("--user") + 1]}\n`, stderr: "" };
        const login = env.GH_TOKEN?.replace(/^tok-/, "") ?? null;
        calls.push({ args, login, envHasAppToken: "GITHUB_TOKEN" in env });
        return reply(args, login);
    };
    return { exec, calls };
}
const http = (status, headers = {}, body = "{}") => ({ code: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} X\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\n`).join("")}\n${body}`, stderr: status === 200 ? "" : `gh: HTTP ${status}` });
const varsOf = (args) => {
    const v = {};
    for (let i = 0; i < args.length; i++) if (args[i] === "-f" || args[i] === "-F") {
        const [k, ...rest] = args[i + 1].split("=");
        v[k] = rest.join("=");
    }
    return v;
};
const queryName = (args) => Object.entries(QUERIES).find(([, q]) => q === varsOf(args).query)?.[0] ?? null;

/** GraphQL served from an in-memory PR: lists paged 50 at a time with cursors "c:<offset>". */
function graphqlModel(model) {
    const page = (list, after, size = 50) => {
        const start = after ? Number(after.split(":")[1]) : 0;
        return { nodes: list.slice(start, start + size), pageInfo: { hasNextPage: start + size < list.length, endCursor: `c:${start + size}` } };
    };
    const thread = (t) => ({ ...t, comments: page(t.comments, null) });
    const checks = (after) => ({ nodes: [{ commit: { oid: model.pr.headRefOid, statusCheckRollup: { state: "SUCCESS", contexts: page(model.checks, after) } } }] });
    return (args) => {
        const name = queryName(args);
        const v = varsOf(args);
        let data;
        if (name === "main") {
            const th = page(model.threads, null);
            data = { rateLimit: { cost: 1 }, repository: { pullRequest: { ...model.pr, commits: checks(null), reviewThreads: { ...th, nodes: th.nodes.map(thread) }, reviews: page(model.reviews, null), comments: page(model.comments, null) } } };
        } else if (name === "threads") {
            const th = page(model.threads, v.after);
            data = { repository: { pullRequest: { reviewThreads: { ...th, nodes: th.nodes.map(thread) } } } };
        } else if (name === "threadComments") data = { node: { comments: page(model.threads.find((t) => t.id === v.id).comments, v.after) } };
        else if (name === "reviews") data = { repository: { pullRequest: { reviews: page(model.reviews, v.after) } } };
        else if (name === "comments") data = { repository: { pullRequest: { comments: page(model.comments, v.after) } } };
        else if (name === "checks") data = { repository: { pullRequest: { commits: checks(v.after) } } };
        else return { code: 1, stdout: "", stderr: `unknown query` };
        return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
    };
}
const comment = (i, extra = {}) => ({ id: `C${i}`, databaseId: i, author: { login: "reviewer" }, body: `comment ${i}`, createdAt: "2026-10-01T10:00:00Z", lastEditedAt: null, url: `u${i}`, diffHunk: "@@ -1 +1 @@\n+x", replyTo: null, pullRequestReview: { id: "R1" }, ...extra });
function bigModel({ threads = 120, longThread = 75, reviews = 60 } = {}) {
    return {
        pr: { ...sandbox, reviewThreads: undefined, reviews: undefined, comments: undefined, commits: undefined },
        threads: Array.from({ length: threads }, (_, i) => ({ id: `T${i}`, isResolved: false, isOutdated: false, path: "src/a.js", line: i + 1, originalLine: i + 1, startLine: null, diffSide: "RIGHT", resolvedBy: null, comments: Array.from({ length: i === 0 ? longThread : 1 }, (_, j) => comment(i * 1000 + j)) })),
        reviews: Array.from({ length: reviews }, (_, i) => ({ id: `R${i}`, databaseId: i, author: { login: "reviewer" }, state: "COMMENTED", body: `review ${i}`, submittedAt: "2026-10-01T10:00:00Z", url: null })),
        comments: [],
        checks: Array.from({ length: 3 }, (_, i) => ({ __typename: "CheckRun", name: `check ${i}`, status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null })),
    };
}

// ---------- identity ----------

test("PR URLs on any host parse to one canonical identity", () => {
    const a = parsePrUrl("https://github.com/NotThatBreezy/marginal-sandbox/pull/1");
    assert.deepEqual(a, { host: "github.com", owner: "NotThatBreezy", repo: "marginal-sandbox", number: 1, url: "https://github.com/NotThatBreezy/marginal-sandbox/pull/1" });
    const g = parsePrUrl("https://ACME.ghe.com/contoso/relay/pull/512/files?w=1#diff");
    assert.equal(g.host, "acme.ghe.com");
    assert.equal(g.url, "https://acme.ghe.com/contoso/relay/pull/512");
    assert.equal(prKey(a), prKey(parsePrUrl("https://github.com/notthatbreezy/MARGINAL-SANDBOX/pull/1/")));
    assert.notEqual(prKey(a), prKey(parsePrUrl("https://ghe.example.com/notthatbreezy/marginal-sandbox/pull/1")), "the host is part of the identity");
    assert.equal(prIdFor(a), prIdFor(parsePrUrl("https://github.com/notthatbreezy/marginal-sandbox/pull/1")));
    assert.match(prIdFor(a), /^marginal-sandbox-1-[0-9a-f]{4}$/);
    for (const bad of ["http://github.com/a/b/pull/1", "https://github.com/a/b/issues/1", "https://github.com/a/pull/1", "nope", "https://github.com/a/b/pull/0"]) assert.throws(() => parsePrUrl(bad), /pull request/i, bad);
});

// ---------- the handling ladder ----------

test("handling steps nest: a level is a prefix, and a gap is refused, never stored", () => {
    assert.equal(M.parseHandle({ handle: "remediate" }), "remediate");
    assert.equal(M.parseHandle({ steps: ["read", "assess"] }), "assess");
    assert.equal(M.parseHandle({ steps: [] }), "none");
    assert.equal(M.parseHandle({ steps: ["assess", "read", "remediate"] }), "remediate", "order doesn't matter, only the set");
    assert.throws(() => M.parseHandle({ steps: ["read", "assess", "pushResolve"] }), /Push & resolve needs Remediate/);
    assert.throws(() => M.parseHandle({ steps: ["remediate"] }), /needs Read/);
    assert.throws(() => M.parseHandle({ handle: "everything" }), /handle must be one of/);
    assert.throws(() => M.parseHandle({ steps: ["read", "fix"] }), /steps must be/);
    for (const level of M.LEVELS) for (const step of M.STEPS) assert.equal(M.includes(level, step), M.LEVELS.indexOf(level) >= M.LEVELS.indexOf(step));
    assert.deepEqual(M.normalizeSettings({}), { watch: true, handle: "read", deliver: "queue" }, "new PRs: watched, at Read, queued");
    assert.deepEqual(M.normalizeSettings({ handle: "bogus", watch: "yes", deliver: "now" }), { watch: true, handle: "read", deliver: "queue" });
    const cur = { watch: true, handle: "assess", deliver: "queue" };
    assert.throws(() => M.updateSettings(cur, { steps: ["pushResolve"] }));
    assert.deepEqual(cur, { watch: true, handle: "assess", deliver: "queue" }, "a refused update changes nothing");
    assert.deepEqual(M.updateSettings(cur, { handle: "pushResolve", deliver: "interrupt", watch: false }), { watch: false, handle: "pushResolve", deliver: "interrupt" });
    assert.equal(M.needsAgent("read"), false);
    assert.equal(M.needsAgent("assess"), true);
});

// ---------- snapshot ----------

test("the recorded sandbox PR normalizes to threads, reviews that say something, and the conversation", () => {
    const s = S.normalize(rawFromFixture(), SANDBOX, { fetchedAt: "t" });
    assert.equal(s.complete, true);
    assert.deepEqual(s.pr, { ...SANDBOX, url: "https://github.com/notthatbreezy/marginal-sandbox/pull/1", title: "Add jitter and an onRetry hook", state: "open", draft: false, author: "notthatbreezy", base: "main", head: "feature/retry-jitter", headSha: "57454e217e0bfc279136c9fd3b0472b48c1b545e", reviewDecision: null, updatedAt: "2026-10-01T14:30:12Z" });
    assert.deepEqual(s.threads.map((t) => [t.path, t.line, t.side, t.resolved, t.outdated, t.comments.map((c) => c.author)]), [
        ["src/retry.mjs", 4, "RIGHT", false, false, ["github-actions", "github-actions"]],
        ["src/retry.mjs", 15, "RIGHT", false, false, ["github-actions", "notthatbreezy"]],
        ["src/retry.mjs", 9, "RIGHT", false, false, ["github-actions"]],
    ]);
    assert.match(s.threads[0].hunk, /^@@ -1,15 \+1,17 @@/);
    assert.equal(s.threads[1].comments[1].editedAt, "2026-10-01T14:29:19Z");
    assert.equal(s.threads[0].comments[1].replyTo, s.threads[0].comments[0].id);
    // 4 reviews on GitHub; the two empty COMMENTED ones are reply wrappers
    assert.deepEqual(s.reviews.map((r) => r.body), ["A couple of questions on the jitter change.", "One more nit."]);
    assert.deepEqual(s.conversation.map((c) => [c.author, c.body]), [["notthatbreezy", "Thanks for the review."]]);
    assert.deepEqual(S.threadCounts(s), { total: 3, unresolved: 3 });
    assert.deepEqual(S.itemsOf(s).map((i) => i.kind), ["review_comment", "review_comment", "review_comment", "review_comment", "review_comment", "review", "review", "comment"]);
    assert.equal(S.displayState(s.pr), "open");
    assert.equal(S.displayState({ state: "open", draft: true }), "draft");
    assert.equal(S.normalize({ ...rawFromFixture(), pr: { ...sandbox, merged: true, state: "MERGED" } }, SANDBOX).pr.state, "merged");
    assert.equal(S.normalize({ ...rawFromFixture(), pr: { ...sandbox, state: "CLOSED" } }, SANDBOX).pr.state, "closed");
});

test("checks: passed, failed and pending from check runs and status contexts", () => {
    const raw = {
        ...rawFromFixture(),
        checks: [
            { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
            { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://x/lint" },
            { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
            { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
            { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
            { __typename: "StatusContext", context: "deploy", state: "PENDING" },
        ],
    };
    const c = S.normalize(raw, SANDBOX).checks;
    assert.deepEqual([c.total, c.passed, c.failed, c.pending], [6, 2, 2, 2]);
    assert.deepEqual(c.failing, ["lint", "ci/legacy"]);
});

test("diff: new, edited, deleted, resolved, reopened, outdated, state and push", () => {
    const a = S.normalize(rawFromFixture(), SANDBOX);
    const b = structuredClone(a);
    b.threads[0].comments.push({ ...b.threads[0].comments[0], id: "NEW1", body: "and another thing", createdAt: "2026-10-01T15:00:00Z" });
    b.threads[1].comments[1].body = "edited";
    b.threads[1].comments[1].editedAt = "2026-10-01T15:01:00Z";
    b.threads[1].resolved = true;
    b.threads[2].outdated = true;
    b.conversation = [];
    b.pr.headSha = "abc";
    b.pr.draft = true;
    const d = S.diffSnapshots(a, b);
    assert.deepEqual(d.added.map((i) => i.id), ["NEW1"]);
    assert.deepEqual(d.edited.map((i) => i.body), ["edited"]);
    assert.deepEqual(d.deleted.map((i) => i.kind), ["comment"]);
    assert.deepEqual(d.resolved, [a.threads[1].id]);
    assert.deepEqual(d.outdated, [a.threads[2].id]);
    assert.deepEqual(d.state, { from: "open", to: "draft" });
    assert.deepEqual(d.pushed, { from: a.pr.headSha, to: "abc" });
    const back = S.diffSnapshots(b, a);
    assert.deepEqual(back.reopened, [a.threads[1].id]);
    // a partial snapshot never makes anything look deleted
    const partial = { ...structuredClone(b), complete: false, threads: b.threads.slice(0, 1), conversation: [] };
    assert.deepEqual(S.diffSnapshots(a, partial).deleted, []);
    assert.deepEqual(S.diffSnapshots(null, a).added.length, 8, "from nothing, everything is new");
});

// ---------- the GitHub client ----------

test("the cheap check sends If-Modified-Since to the PR's host; a 304 is unchanged", async () => {
    const g = fakeGh({
        accounts: { "acme.ghe.com": [{ login: "work-emu", active: true }] },
        reply: (args) => (args.some((a) => a.startsWith("If-Modified-Since")) ? http(304, { "x-ratelimit-remaining": "4900" }, "") : http(200, { "last-modified": "Thu, 01 Oct 2026 14:06:40 GMT", "x-ratelimit-remaining": "4899" })),
    });
    const gh = createGitHub({ exec: g.exec, env: { GITHUB_TOKEN: "app-token", PATH: "x" } });
    const pr = parsePrUrl("https://acme.ghe.com/contoso/relay/pull/512");
    const first = await gh.check(pr, null);
    assert.deepEqual(first, { changed: true, lastModified: "Thu, 01 Oct 2026 14:06:40 GMT", remaining: 4899, login: "work-emu" });
    const again = await gh.check(pr, first.lastModified);
    assert.equal(again.changed, false);
    assert.deepEqual(g.calls[1].args, ["api", "--hostname", "acme.ghe.com", "-i", "repos/contoso/relay/pulls/512", "-H", "If-Modified-Since: Thu, 01 Oct 2026 14:06:40 GMT"]);
    assert.ok(g.calls.every((c) => c.login === "work-emu" && !c.envHasAppToken), "uses gh's account for the host, never the app's own token");
    assert.deepEqual(parseIncluded("HTTP/2.0 304 Not Modified\r\nEtag: x\r\n\r\n"), { status: 304, headers: { etag: "x" }, body: "" });
});

test("accounts: a repo the active account can't see is tried with the others, and the one that works is remembered", async () => {
    const g = fakeGh({
        accounts: { "github.com": [{ login: "work-emu", active: true }, { login: "personal", active: false }] },
        reply: (args, login) => (login === "personal" ? http(200, { "last-modified": "L" }) : http(404, {}, '{"message":"Not Found"}')),
    });
    const gh = createGitHub({ exec: g.exec, env: {} });
    const pr = { host: "github.com", owner: "notthatbreezy", repo: "marginal-sandbox", number: 1 };
    assert.equal((await gh.check(pr, null)).login, "personal");
    assert.deepEqual(g.calls.map((c) => c.login), ["work-emu", "personal"]);
    await gh.check(pr, "L");
    assert.equal(g.calls.at(-1).login, "personal", "remembered: straight to the account that works");
    assert.equal(g.calls.length, 3);
    assert.deepEqual(await gh.selfLogins("github.com"), ["work-emu", "personal"], "every account counts as you");
    const none = createGitHub({ exec: fakeGh({ accounts: {}, reply: () => http(200) }).exec, env: {} });
    await assert.rejects(() => none.check({ ...pr, host: "ghe.example.com" }, null), /isn't logged in to ghe.example.com/);
});

test("a rate limit is an error with a retry time, not a reason to try another account", async () => {
    const g = fakeGh({ accounts: { "github.com": [{ login: "a", active: true }, { login: "b" }] }, reply: () => http(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }, '{"message":"API rate limit exceeded"}') });
    const gh = createGitHub({ exec: g.exec, env: {} });
    await assert.rejects(
        () => gh.check(SANDBOX, null),
        (e) => e.kind === "rate_limit" && e.retryAt === 1_800_000_000_000,
    );
    assert.equal(g.calls.length, 1);
});

test("fetch: one query for an ordinary PR; a big one resumes from its saved cursors, never from page one", async () => {
    const small = fakeGh({ reply: graphqlModel({ ...bigModel({ threads: 3, longThread: 2, reviews: 2 }) }) });
    const f0 = await createGitHub({ exec: small.exec, env: {} }).fetchPullRequest(SANDBOX);
    assert.equal(f0.complete, true);
    assert.equal(f0.pages, 1);
    assert.deepEqual(small.calls.map((c) => queryName(c.args)), ["main"]);
    assert.ok(small.calls[0].args.includes("--hostname") && small.calls[0].args.includes("github.com"));

    const model = bigModel();
    const g = fakeGh({ reply: graphqlModel(model) });
    const gh = createGitHub({ exec: g.exec, env: {} });
    const first = await gh.fetchPullRequest(SANDBOX, { budget: 2 });
    assert.equal(first.complete, false);
    assert.equal(first.raw.threads.length, 100);
    assert.equal(first.staging.cursors.threads, "c:100");
    const second = await gh.fetchPullRequest(SANDBOX, { staging: first.staging, budget: 2 });
    assert.equal(queryName(g.calls[2].args), "threads", "resumed with the next threads page");
    assert.equal(varsOf(g.calls[2].args).after, "c:100");
    assert.ok(!g.calls.slice(2).some((c) => queryName(c.args) === "main"), "never page one again");
    let st = second;
    for (let i = 0; !st.complete && i < 10; i++) st = await gh.fetchPullRequest(SANDBOX, { staging: st.staging, budget: 2 });
    assert.equal(st.complete, true);
    assert.equal(st.raw.threads.length, 120);
    assert.equal(st.raw.threads[0].comments.nodes.length, 75, "a long thread's comments are paged too");
    assert.equal(st.raw.reviews.length, 60);
    assert.deepEqual(g.calls.map((c) => queryName(c.args)), ["main", "threads", "threads", "threadComments", "reviews"]);
    const snap = S.normalize(st.raw, SANDBOX);
    assert.equal(snap.complete, true);
    assert.equal(S.itemsOf(snap).filter((i) => i.kind === "review_comment").length, 75 + 119);
});

test("GraphQL errors: NOT_FOUND tries the next account; anything else surfaces", async () => {
    const g = fakeGh({
        accounts: { "github.com": [{ login: "a", active: true }, { login: "b" }] },
        reply: (args, login) => (login === "a" ? { code: 1, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }), stderr: "" } : graphqlModel(bigModel({ threads: 1, longThread: 1, reviews: 0 }))(args)),
    });
    const r = await createGitHub({ exec: g.exec, env: {} }).fetchPullRequest(SANDBOX);
    assert.equal(r.complete, true);
    assert.deepEqual(g.calls.map((c) => c.login), ["a", "b"]);
    const bad = fakeGh({ reply: () => ({ code: 1, stdout: JSON.stringify({ errors: [{ type: "SOMETHING", message: "boom" }] }), stderr: "" }) });
    await assert.rejects(() => createGitHub({ exec: bad.exec, env: {} }).fetchPullRequest(SANDBOX), /boom/);
    assert.equal(bad.calls.length, 1);
});

// ---------- the doc's list of PRs ----------

test("registering: one entry per PR whatever the URL form, stacking by id or URL, cycles refused", () => {
    const doc = "doc-a";
    const a = St.addPr(doc, { url: "https://github.com/acme/app/pull/10", addedBy: "doc" });
    assert.equal(a.created, true);
    assert.deepEqual(a.entry.settings, { watch: true, handle: "read", deliver: "queue" });
    const again = St.addPr(doc, { url: "https://github.com/ACME/app/pull/10/files", label: "base layer" });
    assert.equal(again.created, false);
    assert.equal(again.entry.id, a.entry.id);
    assert.equal(St.readIndex(doc).prs.length, 1);
    assert.equal(St.readIndex(doc).prs[0].label, "base layer");
    const b = St.addPr(doc, { url: "https://github.com/acme/app/pull/11", stacksOn: a.entry.id });
    const c = St.addPr(doc, { url: "https://github.com/acme/app/pull/12", stacksOn: "https://github.com/acme/app/pull/11" });
    assert.equal(b.entry.stacksOn, a.entry.id);
    assert.equal(c.entry.stacksOn, b.entry.id);
    assert.throws(() => St.addPr(doc, { url: "https://github.com/acme/app/pull/10", stacksOn: c.entry.id }), /already builds on it/);
    assert.equal(St.readIndex(doc).prs.find((p) => p.id === a.entry.id).stacksOn, null, "the refused change left it alone");
    assert.throws(() => St.addPr(doc, { url: "https://github.com/acme/app/pull/13", stacksOn: "nope" }), /isn't a PR on this doc/);
    assert.throws(() => St.addPr(doc, { url: "https://github.com/acme/app/issues/13" }), /pull request URL/);
    const ghe = St.addPr(doc, { url: "https://acme.ghe.com/acme/app/pull/10" });
    assert.equal(ghe.created, true, "the same number on another host is another PR");
    St.removePr(doc, b.entry.id);
    assert.equal(St.readIndex(doc).prs.find((p) => p.id === c.entry.id).stacksOn, null, "removing a PR unstacks what built on it");
    assert.throws(() => St.getEntry(doc, b.entry.id), /No pull request/);
});

test("per-PR state round-trips, keeps its activity bounded, and notifies listeners", () => {
    const seen = [];
    const off = St.onPrsChange((docId, what) => seen.push([docId, what.what]));
    const doc = "doc-b";
    const { entry } = St.addPr(doc, { url: "https://github.com/acme/app/pull/1" });
    St.writePr(doc, entry.id, (st) => {
        st.lastModified = "L";
        for (let i = 0; i < 250; i++) St.log(st, `event ${i}`);
    });
    const st = St.readPr(doc, entry.id);
    assert.equal(st.lastModified, "L");
    assert.equal(st.activity.length, St.ACTIVITY_MAX);
    assert.equal(st.activity.at(-1).text, "event 249");
    assert.deepEqual(seen, [[doc, "index"], [doc, "pr"]]);
    off();
    assert.deepEqual(St.docsWithPrs().sort(), ["doc-a", "doc-b"]);
});
