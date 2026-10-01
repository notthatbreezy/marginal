// A fake GitHub for tests and the dev server: a mutable pull request behind the same `gh` command lines Marginal
// runs. REST answers If-Modified-Since the way github.com does (304 when unchanged); GraphQL serves the model a
// page at a time. Resolving a thread doesn't change the PR's updated_at, and neither does your own reply: both
// measured on github.com (docs/dev/pr-capabilities.md).
import { QUERIES } from "../../extensions/marginal/lib/prs/github.mjs";

export const http = (status, headers = {}, body = "{}") => ({ code: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} X\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\n`).join("")}\n${body}`, stderr: status === 200 ? "" : `gh: HTTP ${status}` });

export function varsOf(args) {
    const v = {};
    for (let i = 0; i < args.length; i++)
        if (args[i] === "-f" || args[i] === "-F") {
            const [k, ...rest] = args[i + 1].split("=");
            v[k] = rest.join("=");
        }
    return v;
}
export const queryName = (args) => Object.entries(QUERIES).find(([, q]) => q === varsOf(args).query)?.[0] ?? null;

/**
 * accounts: {host: [{login, active, state?}]} (state "error": gh lists the login but its token is dead).
 * tokens: {login: "tok-<login>-v2"} for what `gh auth token` hands out now (default "tok-<login>"); change it to model
 * a refreshed token. missing: gh isn't installed. reply(args, login, token) -> {code, stdout, stderr}. Records calls;
 * `auth` counts the gh auth commands.
 */
export function fakeGh({ accounts = { "github.com": [{ login: "me", active: true }] }, tokens = {}, missing = false, reply }) {
    const calls = [];
    const auth = { status: 0, token: 0 };
    const exec = async (args, { env } = {}) => {
        if (missing) return { code: 127, missing: true, stdout: "", stderr: "The GitHub CLI (gh) isn't installed, or isn't on PATH." };
        if (args[0] === "auth" && args[1] === "status") {
            auth.status++;
            const host = args[args.indexOf("--hostname") + 1];
            const list = (accounts[host] ?? []).map((a) => ({ state: "success", host, ...a }));
            return { code: 0, stdout: JSON.stringify({ hosts: { [host]: list } }), stderr: "" };
        }
        if (args[0] === "auth" && args[1] === "token") {
            auth.token++;
            const user = args[args.indexOf("--user") + 1];
            return { code: 0, stdout: `${tokens[user] ?? `tok-${user}`}\n`, stderr: "" };
        }
        const token = env?.GH_TOKEN ?? null;
        const login = token?.replace(/^tok-/, "").replace(/-v\d+$/, "") ?? null;
        calls.push({ args, login, token, envHasAppToken: !!env && "GITHUB_TOKEN" in env, kind: args[1] === "graphql" ? `graphql:${queryName(args)}` : "rest" });
        return reply(args, login, token);
    };
    return { exec, calls, auth };
}

/** GraphQL served from an in-memory PR: lists paged 50 at a time with cursors "c:<offset>". */
export function graphqlModel(model) {
    const page = (list, after, size = 50) => {
        const start = after ? Number(after.split(":")[1]) : 0;
        return { nodes: list.slice(start, start + size), pageInfo: { hasNextPage: start + size < list.length, endCursor: `c:${start + size}` } };
    };
    const thread = ({ comments, ...t }) => ({ ...t, comments: page(comments, null) });
    const checks = (after) => ({ nodes: [{ commit: { oid: model.pr.headRefOid, statusCheckRollup: model.checks.length ? { state: "SUCCESS", contexts: page(model.checks, after) } : null } }] });
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
        else if (name === "checksOnly") data = { repository: { pullRequest: { headRefOid: model.pr.headRefOid, commits: checks(null) } } };
        else return { code: 1, stdout: "", stderr: "unknown query" };
        return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
    };
}

/**
 * A PR you can change: world.review(...), world.reply(...), world.resolve(...), world.push(...), world.merge().
 * world.exec is the fake gh; world.calls records what Marginal asked. `clock()` gives "now" for timestamps.
 */
export function fakeWorld({ host = "github.com", owner = "acme", repo = "app", number = 7, me = "me", accounts, clock = () => Date.now(), title = "Add jitter and an onRetry hook", prefix = "" } = {}) {
    let n = 0;
    const iso = () => new Date(clock()).toISOString();
    const model = {
        pr: { id: `${prefix}PR_1`, number, title, url: `https://${host}/${owner}/${repo}/pull/${number}`, state: "OPEN", isDraft: false, merged: false, closed: false, updatedAt: iso(), author: { login: me }, baseRefName: "main", headRefName: "feature/x", headRefOid: "a".repeat(40), reviewDecision: null },
        threads: [],
        reviews: [],
        comments: [],
        checks: [],
    };
    const touch = () => (model.pr.updatedAt = new Date(Math.max(clock(), Date.parse(model.pr.updatedAt) + 1000)).toISOString()); // time moves on
    let failNext = null;
    const gql = graphqlModel(model);
    const { exec, calls } = fakeGh({
        accounts: accounts ?? { [host]: [{ login: me, active: true }] },
        reply: (args) => {
            if (failNext) {
                const f = failNext;
                failNext = null;
                return http(f.status, f.headers, f.body);
            }
            if (args[1] === "graphql") return gql(args);
            const since = args.find((a) => a.startsWith("If-Modified-Since: "))?.slice(19);
            const lm = new Date(Math.floor(Date.parse(model.pr.updatedAt) / 1000) * 1000).toUTCString();
            if (since && Date.parse(since) >= Date.parse(lm)) return http(304, { "x-ratelimit-remaining": "4999" }, "");
            return http(200, { "last-modified": lm, "x-ratelimit-remaining": "4998" }, JSON.stringify({ number, updated_at: model.pr.updatedAt }));
        },
    });
    const comment = (author, body, extra = {}) => ({ id: `${prefix}C${++n}`, databaseId: n, author: author ? { login: author } : null, body, createdAt: iso(), lastEditedAt: null, url: `${model.pr.url}#c${n}`, diffHunk: "@@ -1,4 +1,5 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;", replyTo: null, pullRequestReview: null, ...extra });
    const world = {
        model,
        exec,
        calls,
        ident: { host, owner, repo, number, url: model.pr.url },
        failNext: (status, headers = {}, body = "{}") => (failNext = { status, headers, body }),
        /** A submitted review: line comments (each a new thread) and an optional summary. Returns thread ids. */
        review(author, { body = "", comments = [], state = "COMMENTED" } = {}) {
            const rid = `${prefix}R${++n}`;
            model.reviews.push({ id: rid, databaseId: n, author: author ? { login: author } : null, state, body, submittedAt: iso(), url: `${model.pr.url}#r${n}` });
            const ids = comments.map((c) => {
                const t = { id: `${prefix}T${++n}`, isResolved: false, isOutdated: false, path: c.path ?? "src/retry.mjs", line: c.line ?? 4, originalLine: c.line ?? 4, startLine: null, diffSide: "RIGHT", resolvedBy: null, comments: [comment(author, c.body, { pullRequestReview: { id: rid }, ...(c.diffHunk ? { diffHunk: c.diffHunk } : {}) })] };
                model.threads.push(t);
                return t.id;
            });
            if (state !== "COMMENTED" && author !== me) model.pr.reviewDecision = state === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED";
            touch();
            return ids;
        },
        reply(threadId, author, body) {
            const t = model.threads.find((x) => x.id === threadId);
            const rid = `${prefix}R${++n}`;
            model.reviews.push({ id: rid, databaseId: n, author: { login: author }, state: "COMMENTED", body: "", submittedAt: iso(), url: null });
            const c = comment(author, body, { replyTo: { id: t.comments[0].id }, pullRequestReview: { id: rid }, diffHunk: t.comments[0].diffHunk });
            t.comments.push(c);
            if (author !== me) touch(); // measured: your own reply may not change updated_at
            return c.id;
        },
        converse(author, body) {
            model.comments.push(comment(author, body, { diffHunk: undefined }));
            touch();
        },
        resolve(threadId, by = me) {
            const t = model.threads.find((x) => x.id === threadId);
            t.isResolved = true;
            t.resolvedBy = { login: by }; // measured: doesn't change updated_at
        },
        outdate(threadId) {
            model.threads.find((x) => x.id === threadId).isOutdated = true;
        },
        edit(commentId, body) {
            for (const t of model.threads) for (const c of t.comments) if (c.id === commentId) Object.assign(c, { body, lastEditedAt: iso() });
            touch();
        },
        remove(commentId) {
            for (const t of model.threads) t.comments = t.comments.filter((c) => c.id !== commentId);
            model.threads = model.threads.filter((t) => t.comments.length);
            touch();
        },
        push(sha) {
            model.pr.headRefOid = sha;
            touch();
        },
        merge() {
            Object.assign(model.pr, { state: "MERGED", merged: true, closed: true });
            touch();
        },
        checks(list) {
            model.checks = list.map((c) => ({ __typename: "CheckRun", detailsUrl: null, ...c })); // doesn't touch the PR
        },
        bigPr(threads) {
            for (let i = 0; i < threads; i++) model.threads.push({ id: `${prefix}T${++n}`, isResolved: false, isOutdated: false, path: "src/a.js", line: i + 1, originalLine: i + 1, startLine: null, diffSide: "RIGHT", resolvedBy: null, comments: [comment("old-reviewer", `old ${i}`)] });
            touch();
        },
    };
    return world;
}

/**
 * Several fake PRs behind one gh: REST and GraphQL calls go to the world whose host/owner/repo/number they name
 * (a thread-comments page, to the world that has that thread). Give each world its own prefix.
 */
export function fakeGitHub(worlds, { accounts } = {}) {
    const find = (host, owner, repo, number) => worlds.find((w) => w.ident.host === host && w.ident.owner.toLowerCase() === String(owner).toLowerCase() && w.ident.repo.toLowerCase() === String(repo).toLowerCase() && w.ident.number === Number(number));
    const hosts = [...new Set(worlds.map((w) => w.ident.host))];
    const { exec, calls } = fakeGh({
        accounts: accounts ?? Object.fromEntries(hosts.map((h) => [h, [{ login: "me", active: true }]])),
        reply: async (args, login) => {
            const host = args[args.indexOf("--hostname") + 1];
            let w;
            if (args[1] === "graphql") {
                const v = varsOf(args);
                w = v.id ? worlds.find((x) => x.model.threads.some((t) => t.id === v.id)) : find(host, v.owner, v.repo, v.number);
            } else {
                const m = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(args.find((a) => a.startsWith("repos/")) ?? "");
                w = m && find(host, m[1], m[2], m[3]);
            }
            if (!w) return args[1] === "graphql" ? { code: 1, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }), stderr: "" } : http(404, {}, '{"message":"Not Found"}');
            return w.exec(args, { env: { GH_TOKEN: `tok-${login}` } }).then((r) => (w.calls.pop(), r));
        },
    });
    return { exec, calls };
}

/** A virtual clock for watcher tests: advance() runs due timers in order and waits for the watcher to settle. */
export function fakeClock(start = Date.parse("2026-10-01T12:00:00Z")) {
    let now = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (fn, ms) => {
            const id = ++seq;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        async advance(ms, settle) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await settle?.();
            }
            now = end;
            await settle?.();
        },
    };
}
