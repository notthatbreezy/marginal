// GitHub through the gh CLI: which account to use, the cheap "has it changed?" check, and the paginated GraphQL
// fetch. Every call goes through one injectable `exec(args, {env})`, the seam tests replace with a recorder.
//
// Accounts: gh may be logged in to several accounts per host (a personal one and an Enterprise Managed one, say).
// Marginal asks gh which accounts exist (`gh auth status --json hosts`), tries the active one first, and if a repo
// isn't visible to it tries the others, remembering per host and owner which worked. All of them count as "you"
// when deciding whose comments are someone else's.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_BUFFER = 64 * 1024 * 1024;
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"];

/** The real process boundary. */
export function execGh(args, { env } = {}) {
    return new Promise((resolve) => {
        execFile("gh", args, { env, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) =>
            resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: stdout ?? "", stderr: (stderr ?? "").trim() || (error && !stdout ? error.message : "") }),
        );
    });
}

export class GitHubError extends Error {
    constructor(message, { kind = "error", retryAt = null, status = null } = {}) {
        super(message);
        this.kind = kind; // "auth" | "not_found" | "rate_limit" | "error"
        this.retryAt = retryAt;
        this.status = status;
    }
}

const cleanEnv = (base) => {
    const env = { ...base };
    for (const k of TOKEN_VARS) delete env[k];
    env.GH_PROMPT_DISABLED = "1";
    env.NO_COLOR = "1";
    return env;
};

function classify(out, status) {
    const text = `${out.stderr}\n${out.stdout}`.slice(0, 2000);
    if (status === 429 || /rate limit/i.test(text) || (status === 403 && /secondary rate/i.test(text))) return "rate_limit";
    if (status === 401 || /HTTP 401|Bad credentials|authentication|gh auth login/i.test(text)) return "auth";
    if (status === 404 || /HTTP 404|Could not resolve to a (Repository|PullRequest)|NOT_FOUND|Not Found/i.test(text)) return "not_found";
    if (status === 403 || /HTTP 403|Resource not accessible|SAML/i.test(text)) return "auth";
    return "error";
}

/** Split `gh api -i` output into status, lower-cased headers and body. */
export function parseIncluded(stdout) {
    const text = stdout.replace(/\r\n/g, "\n");
    const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(text);
    if (!m) return { status: null, headers: {}, body: text };
    const end = text.indexOf("\n\n", m.index);
    const head = end < 0 ? text : text.slice(0, end);
    const headers = {};
    for (const line of head.split("\n").slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { status: Number(m[1]), headers, body: end < 0 ? "" : text.slice(end + 2) };
}

const PR_FIELDS = `id number title url state isDraft merged closed updatedAt author{login} baseRefName headRefName headRefOid reviewDecision`;
const COMMENT_FIELDS = `id databaseId author{login} body createdAt lastEditedAt url diffHunk replyTo{id} pullRequestReview{id}`;
const THREAD_FIELDS = `id isResolved isOutdated path line originalLine startLine diffSide resolvedBy{login} comments(first:50){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}`;
const REVIEW_FIELDS = `id databaseId author{login} state body submittedAt url`;
const ISSUE_COMMENT_FIELDS = `id databaseId author{login} body createdAt lastEditedAt url`;
const CHECK_FIELDS = `__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}`;
const checksConn = (after) => `commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:50${after ? ",after:$after" : ""}){pageInfo{hasNextPage endCursor} nodes{${CHECK_FIELDS}}}}}}}`;

export const QUERIES = {
    main: `query($owner:String!,$repo:String!,$number:Int!){rateLimit{cost remaining resetAt}repository(owner:$owner,name:$repo){pullRequest(number:$number){${PR_FIELDS} ${checksConn(false)}
reviewThreads(first:50){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}
reviews(first:50){pageInfo{hasNextPage endCursor} nodes{${REVIEW_FIELDS}}}
comments(first:50){pageInfo{hasNextPage endCursor} nodes{${ISSUE_COMMENT_FIELDS}}}}}}`,
    threads: `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}}}}`,
    threadComments: `query($id:ID!,$after:String!){node(id:$id){... on PullRequestReviewThread{comments(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}}}}`,
    reviews: `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{${REVIEW_FIELDS}}}}}}`,
    comments: `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){pullRequest(number:$number){comments(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{${ISSUE_COMMENT_FIELDS}}}}}}`,
    checks: `query($owner:String!,$repo:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$repo){pullRequest(number:$number){${checksConn(true)}}}}`,
    checksOnly: `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid ${checksConn(false)}}}}`,
};

export function createGitHub({ exec = execGh, env = process.env } = {}) {
    const accountCache = new Map(); // host -> Promise<[{login, active}]>
    const tokens = new Map(); // host\0login -> token
    const remembered = new Map(); // host/owner -> login
    const base = cleanEnv(env);
    const calls = { rest: 0, graphql: 0 };

    function accounts(host) {
        if (!accountCache.has(host)) {
            const p = exec(["auth", "status", "--json", "hosts", "--hostname", host], { env: base }).then((out) => {
                try {
                    const list = JSON.parse(out.stdout || "{}").hosts?.[host] ?? [];
                    return list.filter((a) => a.state === "success" && a.login).map((a) => ({ login: a.login, active: !!a.active }));
                } catch {
                    return [];
                }
            });
            accountCache.set(host, p);
            p.then((l) => !l.length && setTimeout(() => accountCache.delete(host), 60_000).unref?.());
        }
        return accountCache.get(host);
    }

    async function tokenFor(host, login) {
        const k = `${host}\0${login}`;
        if (!tokens.has(k)) {
            const out = await exec(["auth", "token", "--hostname", host, "--user", login], { env: base });
            if (out.code !== 0 || !out.stdout.trim()) throw new GitHubError(`gh has no token for ${login} on ${host}: ${out.stderr}`, { kind: "auth" });
            tokens.set(k, out.stdout.trim());
        }
        return tokens.get(k);
    }

    /** Every login gh has for this host: comments from these are yours. */
    async function selfLogins(host) {
        return (await accounts(host)).map((a) => a.login);
    }

    /**
     * Run gh for a repository, trying accounts in order (the one that worked last for this owner, the active one,
     * then the others). `attempt(out)` returns {retry:true} to try the next account, or a result.
     */
    async function withAccount(host, owner, args, attempt) {
        const list = await accounts(host);
        if (!list.length) throw new GitHubError(`gh isn't logged in to ${host}. Run: gh auth login --hostname ${host}`, { kind: "auth" });
        const key = `${host}/${owner}`.toLowerCase();
        const order = [...list].sort((a, b) => (b.login === remembered.get(key)) - (a.login === remembered.get(key)) || b.active - a.active);
        let last = null;
        for (const acct of order) {
            let token;
            try {
                token = await tokenFor(host, acct.login);
            } catch (e) {
                last = e;
                continue;
            }
            const out = await exec(args, { env: { ...base, GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token } });
            const r = attempt(out, acct.login);
            if (r?.retry) {
                last = r.error;
                continue;
            }
            remembered.set(key, acct.login);
            return r;
        }
        throw last ?? new GitHubError(`No gh account on ${host} can see ${owner}.`, { kind: "not_found" });
    }

    /**
     * The cheap check: GET the PR with If-Modified-Since. A 304 is free. Returns {changed, lastModified, remaining,
     * login}. Throws GitHubError (rate_limit carries retryAt).
     */
    function check(pr, lastModified) {
        calls.rest++;
        const args = ["api", "--hostname", pr.host, "-i", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`];
        if (lastModified) args.push("-H", `If-Modified-Since: ${lastModified}`);
        return withAccount(pr.host, pr.owner, args, (out, login) => {
            const { status, headers } = parseIncluded(out.stdout);
            if (status === 304) return { changed: false, lastModified, remaining: num(headers["x-ratelimit-remaining"]), login };
            if (status === 200) return { changed: true, lastModified: headers["last-modified"] ?? null, remaining: num(headers["x-ratelimit-remaining"]), login };
            const kind = classify(out, status);
            const err = new GitHubError(`GitHub said ${status ?? "no response"} for ${pr.owner}/${pr.repo}#${pr.number}: ${out.stderr || "(no detail)"}`.slice(0, 300), { kind, status, retryAt: retryAtOf(headers) });
            if (kind === "auth" || kind === "not_found") return { retry: true, error: err };
            throw err;
        });
    }

    async function graphql(pr, query, vars) {
        calls.graphql++;
        const args = ["api", "graphql", "--hostname", pr.host, "-f", `query=${query}`];
        for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
        return withAccount(pr.host, pr.owner, args, (out) => {
            let json = null;
            try {
                json = JSON.parse(out.stdout || "null");
            } catch {}
            const errors = json?.errors ?? [];
            if (out.code === 0 && json?.data && !errors.length) return json.data;
            const text = errors.map((e) => `${e.type ?? ""} ${e.message}`).join("; ") || out.stderr;
            const kind = errors.some((e) => e.type === "NOT_FOUND") ? "not_found" : errors.some((e) => e.type === "RATE_LIMITED") ? "rate_limit" : classify({ stdout: "", stderr: text }, null);
            const err = new GitHubError(`GitHub GraphQL failed for ${pr.owner}/${pr.repo}#${pr.number}: ${text}`.slice(0, 300), { kind });
            if (kind === "auth" || kind === "not_found") return { retry: true, error: err };
            throw err;
        });
    }

    const vars = (pr) => ({ owner: pr.owner, repo: pr.repo, number: pr.number });

    /**
     * Fetch the whole PR, at most `budget` GraphQL pages per call. A PR that needs more pages is carried in `staging`
     * (its cursors and what's been fetched so far): pass it back in to resume where it stopped, not from page one.
     * Returns {raw, complete, staging, pages}. `raw` holds everything fetched so far (raw.complete says whether it's all).
     */
    async function fetchPullRequest(pr, { staging = null, budget = 20 } = {}) {
        let s = staging;
        let pages = 0;
        if (!s) {
            const d = await graphql(pr, QUERIES.main, vars(pr));
            pages++;
            const p = d.repository?.pullRequest;
            if (!p) throw new GitHubError(`${pr.owner}/${pr.repo}#${pr.number} wasn't found.`, { kind: "not_found" });
            const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup;
            s = {
                generation: randomUUID(),
                startedAt: new Date().toISOString(),
                pr: Object.fromEntries(Object.entries(p).filter(([k]) => !["reviewThreads", "reviews", "comments", "commits"].includes(k))),
                threads: p.reviewThreads.nodes,
                cursors: {
                    threads: p.reviewThreads.pageInfo.hasNextPage ? p.reviewThreads.pageInfo.endCursor : null,
                    reviews: p.reviews.pageInfo.hasNextPage ? p.reviews.pageInfo.endCursor : null,
                    comments: p.comments.pageInfo.hasNextPage ? p.comments.pageInfo.endCursor : null,
                    checks: rollup?.contexts?.pageInfo?.hasNextPage ? rollup.contexts.pageInfo.endCursor : null,
                },
                threadCursors: Object.fromEntries(p.reviewThreads.nodes.filter((t) => t.comments.pageInfo.hasNextPage).map((t) => [t.id, t.comments.pageInfo.endCursor])),
                reviews: p.reviews.nodes,
                comments: p.comments.nodes,
                checks: rollup?.contexts?.nodes ?? [],
            };
        } else s = structuredClone(s);
        const pending = () => !!(s.cursors.threads || s.cursors.reviews || s.cursors.comments || s.cursors.checks || Object.keys(s.threadCursors).length);
        while (pending() && pages < budget) {
            pages++;
            if (s.cursors.threads) {
                const c = (await graphql(pr, QUERIES.threads, { ...vars(pr), after: s.cursors.threads })).repository.pullRequest.reviewThreads;
                s.threads.push(...c.nodes);
                for (const t of c.nodes) if (t.comments.pageInfo.hasNextPage) s.threadCursors[t.id] = t.comments.pageInfo.endCursor;
                s.cursors.threads = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
            } else if (Object.keys(s.threadCursors).length) {
                const [id, after] = Object.entries(s.threadCursors)[0];
                const c = (await graphql(pr, QUERIES.threadComments, { id, after })).node?.comments;
                const t = s.threads.find((x) => x.id === id);
                if (c && t) t.comments.nodes.push(...c.nodes);
                if (c?.pageInfo.hasNextPage) s.threadCursors[id] = c.pageInfo.endCursor;
                else delete s.threadCursors[id];
            } else if (s.cursors.reviews) {
                const c = (await graphql(pr, QUERIES.reviews, { ...vars(pr), after: s.cursors.reviews })).repository.pullRequest.reviews;
                s.reviews.push(...c.nodes);
                s.cursors.reviews = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
            } else if (s.cursors.comments) {
                const c = (await graphql(pr, QUERIES.comments, { ...vars(pr), after: s.cursors.comments })).repository.pullRequest.comments;
                s.comments.push(...c.nodes);
                s.cursors.comments = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
            } else if (s.cursors.checks) {
                const c = (await graphql(pr, QUERIES.checks, { ...vars(pr), after: s.cursors.checks })).repository.pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
                s.checks.push(...(c?.nodes ?? []));
                s.cursors.checks = c?.pageInfo?.hasNextPage ? c.pageInfo.endCursor : null;
            }
        }
        const complete = !pending();
        return { raw: { pr: s.pr, threads: s.threads, reviews: s.reviews, comments: s.comments, checks: s.checks, complete }, complete, staging: complete ? null : s, pages };
    }

    /** Checks alone (cheap): while any are pending they change without the PR changing. */
    async function fetchChecks(pr) {
        const d = await graphql(pr, QUERIES.checksOnly, vars(pr));
        const p = d.repository?.pullRequest;
        return { headSha: p?.headRefOid ?? null, checks: p?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [], more: !!p?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage };
    }

    /** Any gh command against this PR's repository, with the account fallback. Returns stdout. */
    function run(pr, args) {
        return withAccount(pr.host, pr.owner, args, (out) => {
            if (out.code === 0) return out.stdout;
            const kind = classify(out, null);
            const err = new GitHubError(`gh ${args[0]} ${args[1] ?? ""} failed: ${out.stderr || "(no detail)"}`.slice(0, 300), { kind });
            if (kind === "auth" || kind === "not_found") return { retry: true, error: err };
            throw err;
        });
    }

    return { accounts, selfLogins, check, graphql, fetchPullRequest, fetchChecks, run, calls };
}

const num = (v) => (v == null || v === "" ? null : Number(v));

function retryAtOf(headers) {
    const after = num(headers["retry-after"]);
    if (after != null) return Date.now() + after * 1000;
    if (headers["x-ratelimit-remaining"] === "0" && headers["x-ratelimit-reset"]) return Number(headers["x-ratelimit-reset"]) * 1000;
    return null;
}

let shared = null;
/** The process-wide client (tests make their own with createGitHub({exec})). */
export const github = () => (shared ??= createGitHub());
export const setGitHub = (client) => {
    shared = client;
};
