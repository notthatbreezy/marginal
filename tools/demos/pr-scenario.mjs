// The Pull requests tab's dev scenario: four PRs on a fake GitHub (a stack of three on acme/relay, and a merged one),
// the real PR service and watcher (with fast cadences), and a scripted reviewer:
//   +8 s   Copilot code review comments on #41 (handled up to Push & resolve: the canned Copilot fixes one,
//          declines the other, pushes, replies and resolves, all "with its own tools", i.e. on the fake GitHub)
//   +22 s  a reviewer replies on #42 (Read: a note in the chat, no agent turn)
// Used by tools/devserver.mjs --prs; the timeline's start is PR_REVIEW_MS (default 8000).
import { createGitHub } from "../../extensions/marginal/lib/prs/github.mjs";
import { createPrService } from "../../extensions/marginal/lib/prs/index.mjs";
import { fakeGitHub, fakeWorld } from "./fake-github.mjs";

export const DEV_LIMITS = { tickMs: 1000, checkMs: 2000, quietMs: 3000, reconcileMs: 15_000, fastReconcileMs: 4000, checksMs: 4000 };

const hunk = (header, lines) => `${header}\n${lines.join("\n")}`;
const H = {
    policy: hunk("@@ -36,9 +36,12 @@ export function retryPolicy(opts: RetryOptions): Policy {", [" export function retryPolicy(opts: RetryOptions): Policy {", "-  const max = opts.maxAttempts;", "+  const max = opts.maxAttempts ?? Infinity;", "+  if (max < 1) throw new RangeError(\"maxAttempts must be at least 1\");", "   return { max, delay: nextDelay };"]),
    backoff: hunk("@@ -12,8 +12,14 @@ import type { Policy } from \"./policy\";", [" export function nextDelay(attempt: number, base = 100): number {", "-  return base * 2 ** attempt;", "+  const d = Math.min(base * 2 ** attempt, MAX_DELAY_MS);", "+  return d + Math.random() * d * JITTER;", " }"]),
    executor: hunk("@@ -80,10 +80,15 @@ export class Executor {", ["     try {", "       return await job.run(ctx);", "-    } catch (e) {", "-      throw e;", "+    } catch (e) {", "+      this.log.warn(\"job failed\", { job: job.id });", "+      throw new JobError(\"job failed\", job.id);"]),
    jitter: hunk("@@ -4,6 +4,9 @@ export const JITTER = 0.2;", [" export const MAX_DELAY_MS = 30_000;", "+export function jittered(d: number, rand = Math.random): number {", "+  return d + rand() * d * JITTER;", "+}"]),
    queue: hunk("@@ -51,7 +51,9 @@ export class Queue {", ["   async requeue(job: Job, delayMs: number) {", "-    this.pending.push(job);", "+    job.runAfter = Date.now() + delayMs;", "+    await this.store.save(job);"]),
};

/** Four worlds, seeded. `clock` is real time (the dev server isn't virtual). */
export function seedWorlds({ me = "you" } = {}) {
    const mk = (number, title, head, base, prefix) => {
        const w = fakeWorld({ host: "github.com", owner: "acme", repo: "relay", number, me, title, prefix });
        Object.assign(w.model.pr, { headRefName: head, baseRefName: base, headRefOid: `${number}`.repeat(10).slice(0, 40).padEnd(40, "0") });
        return w;
    };
    const w41 = mk(41, "Retry cap and backoff", "feature/retry-cap", "main", "a");
    const w42 = mk(42, "Jitter for retry delays", "feature/retry-jitter", "feature/retry-cap", "b");
    const w43 = mk(43, "Retry metrics", "feature/retry-metrics", "feature/retry-jitter", "c");
    const w38 = mk(38, "Persist the queue's runAfter", "feature/queue-persist", "main", "d");

    const [t1, t2] = w41.review("maria-k", {
        state: "CHANGES_REQUESTED",
        body: "Close! Two things before this goes in.",
        comments: [
            { path: "src/runner/policy.ts", line: 39, body: "An unset `maxAttempts` now means **unlimited** retries. Shouldn't it default to 5, like the docs say?", diffHunk: H.policy },
            { path: "src/runner/backoff.ts", line: 16, body: "Doubling without a ceiling overflows after ~50 attempts. Cap it at `MAX_DELAY_MS`.", diffHunk: H.backoff },
        ],
    });
    w41.reply(t2, me, "Capped it at `MAX_DELAY_MS`; see the next commit.");
    w41.resolve(t2);
    for (let i = 0; i < 5; i++) {
        const [t] = w41.review("sam-o", { comments: [{ path: "src/runner/policy.ts", line: 10 + i, body: ["Typo: *recieve*.", "Could this be `const`?", "Nit: blank line.", "Name this `maxDelayMs` for consistency.", "Add a doc comment?"][i], diffHunk: H.policy }] });
        w41.resolve(t);
    }
    w41.checks([...Array.from({ length: 11 }, (_, i) => ({ name: ["build", "unit (node 20)", "unit (node 22)", "types", "integration", "docs", "coverage", "license", "bundle size", "e2e (chromium)", "e2e (firefox)"][i], status: "COMPLETED", conclusion: "SUCCESS" })), { name: "lint (eslint)", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://example.com/lint" }]);
    void t1;

    w42.review("maria-k", { state: "APPROVED", body: "LGTM.", comments: [{ path: "src/runner/backoff.ts", line: 6, body: "Nice: injecting `rand` makes this testable.", diffHunk: H.jitter }] });
    for (const t of w42.model.threads) w42.resolve(t.id);
    w42.checks([...Array.from({ length: 12 }, (_, i) => ({ name: `check ${i + 1}`, status: "COMPLETED", conclusion: "SUCCESS" })), { name: "e2e (webkit)", status: "IN_PROGRESS", conclusion: null }]);

    Object.assign(w43.model.pr, { isDraft: true });
    w43.checks([...Array.from({ length: 9 }, (_, i) => ({ name: `check ${i + 1}`, status: "COMPLETED", conclusion: "SUCCESS" })), ...Array.from({ length: 3 }, (_, i) => ({ name: `e2e ${i + 1}`, status: "QUEUED", conclusion: null }))]);

    for (let i = 0; i < 9; i++) {
        const [t] = w38.review("lee-p", { comments: [{ path: "src/runner/queue.ts", line: 52 + i, body: `Comment ${i + 1} on the queue change.`, diffHunk: H.queue }] });
        w38.resolve(t);
    }
    w38.review("lee-p", { state: "APPROVED", body: "Ship it." });
    w38.merge();
    w38.checks(Array.from({ length: 14 }, (_, i) => ({ name: `check ${i + 1}`, status: "COMPLETED", conclusion: "SUCCESS" })));
    return { w41, w42, w43, w38, me };
}

/**
 * The service on a fake GitHub, its PRs registered on the doc, and the scripted timeline. Returns
 * {service, worlds, reply} where reply(m) answers a "[Marginal PR review" batch like Copilot would.
 */
export async function setupPrs({ docId, chat, sessionId = "orchestrator-dev", timeline = true, startMs = Number(process.env.PR_REVIEW_MS ?? 8000) }) {
    const worlds = seedWorlds();
    const { w41, w42, w43, w38, me } = worlds;
    const router = fakeGitHub([w41, w42, w43, w38], { accounts: { "github.com": [{ login: me, active: true }] } });
    const gh = createGitHub({ exec: router.exec, env: {} });
    const service = createPrService({ getSession: () => chat.session(sessionId), getSessionId: () => sessionId, transcript: chat.transcript, gh, limits: DEV_LIMITS });
    chat.onSessionEvent((ev) => service.onSessionEvent(ev));
    const p41 = service.register(docId, { url: w41.ident.url, label: "base", settings: { handle: "pushResolve" }, by: "agent" }).entry.id;
    const p42 = service.register(docId, { url: w42.ident.url, stacksOn: p41, settings: { handle: "read" }, by: "agent" }).entry.id;
    service.register(docId, { url: w43.ident.url, stacksOn: p42, settings: { handle: "none" }, by: "agent" });
    service.register(docId, { url: w38.ident.url, settings: { handle: "read" }, by: "user" });

    if (timeline) {
        setTimeout(() => {
            w41.review("copilot-pull-request-reviewer", {
                body: "Copilot reviewed 2 files and left 2 comments.",
                comments: [
                    { path: "src/runner/backoff.ts", line: 17, body: "`Math.random()` makes the delay untestable. Consider injecting the random source:\n\n```suggestion\n  return d + rand() * d * JITTER;\n```", diffHunk: H.backoff },
                    { path: "src/runner/executor.ts", line: 86, body: "This `catch` replaces the original error, so its stack is lost. Pass it as `cause`.", diffHunk: H.executor },
                ],
            });
        }, startMs).unref?.();
        setTimeout(() => {
            const t = w42.model.threads[0];
            w42.model.threads[0].isResolved = false;
            w42.reply(t.id, "maria-k", "One more thought: should `JITTER` be configurable per job?");
        }, startMs + 14_000).unref?.();
    }

    /** Copilot's scripted answer to a batch: fix one, decline one, push, reply and resolve on the fake GitHub. */
    const reply = (m) => {
        const ids = [...m.prompt.matchAll(/threadId (\S+) ──/g)].map((x) => x[1]);
        const world = [w41, w42, w43, w38].find((w) => ids.some((id) => w.model.threads.some((t) => t.id === id))) ?? w41;
        const level = /Handle up to (Push & resolve|Local review|Remediate|Assess)/.exec(m.prompt)?.[1] ?? "Assess";
        const sha = "9c1e0d2b7a4f13e58c6d0a9b2e7f4c1d3a5b6e8f";
        return {
            statuses: ["Reading src/runner/backoff.ts", "Reading src/runner/executor.ts", "Running the tests", "Starting a reviewer agent", "Thinking"],
            text:
                level === "Push & resolve"
                    ? `Both were worth a look. I injected the random source (\`rand\`) and fixed it in ${sha.slice(0, 7)}; a reviewer agent checked it, then I pushed. The second I declined: the executor already rethrows with the original error as \`cause\` a few lines down. I replied on both threads and resolved them.`
                    : `I assessed ${ids.length} thread${ids.length === 1 ? "" : "s"}: the first is valid, the second I'd decline (the executor already keeps the cause).`,
            after: () => {
                if (level !== "Push & resolve" || ids.length < 1) return;
                world.push(sha);
                world.reply(ids[0], me, `Injected \`rand\` in ${sha.slice(0, 7)}.`);
                world.resolve(ids[0]);
                if (ids[1]) {
                    world.reply(ids[1], me, "Declining: the executor rethrows with the original error as `cause` a few lines below, so the stack is kept.");
                    world.resolve(ids[1]);
                }
            },
        };
    };
    return { service, worlds, reply, router };
}
