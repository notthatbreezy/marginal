// Pull requests tab, phase pr2: the watcher over virtual time against a fake GitHub (the gh command lines Marginal
// really runs), with a spy for chat.send. Oracles from the plan's P4, P8, P11 and P13.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "wb-prs-watch-"));
process.env.MARGINAL_DATA_DIR = join(tmp, "data");
after(() => rmSync(tmp, { recursive: true, force: true }));

const { createGitHub } = await import("../extensions/marginal/lib/prs/github.mjs");
const { createWatcher } = await import("../extensions/marginal/lib/prs/watcher.mjs");
const St = await import("../extensions/marginal/lib/prs/state.mjs");
const { fakeWorld, fakeClock } = await import("../tools/demos/fake-github.mjs");

const MIN = 60_000;
let docN = 0;

/** A doc with one PR at the given level, a world, a clock, a send spy and a watcher. */
function setup({ handle = "assess", deliver = "queue", me = "me", world: wopts = {}, limits = {}, compose, messageInLog, docId = `doc-${++docN}`, existing } = {}) {
    const clock = existing?.clock ?? fakeClock();
    const world = existing?.world ?? fakeWorld({ me, clock: clock.now, ...wopts });
    if (!existing) St.addPr(docId, { url: world.ident.url, settings: { watch: true, handle, deliver } });
    const prId = St.readIndex(docId).prs[0].id;
    const sent = [];
    const notes = [];
    let n = 0;
    const gh = createGitHub({ exec: world.exec, env: {} });
    const watcher = createWatcher({
        gh,
        clock,
        limits,
        send: async (m) => (sent.push(m), { messageId: `msg-${++n}-${docId}` }),
        compose: compose ?? (({ units, batchId }) => ({ text: `[Marginal PR review] ${batchId}: ${units.join(", ")}`, displayPrompt: `Handle ${units.length} threads`, units })),
        note: (d, e, text) => notes.push(text),
        messageInLog,
    });
    const settle = () => watcher.settled();
    const advance = (ms) => clock.advance(ms, settle);
    const st = () => St.readPr(docId, prId);
    return { docId, prId, clock, world, gh, watcher, sent, notes, settle, advance, st, start: async () => (watcher.watch(docId), settle()) };
}
const kinds = (world, from = 0) => world.calls.slice(from).map((c) => c.kind);

test("P4: unchanged, it costs one free 304 a minute and a reconciliation every 10; nothing reaches Copilot", async () => {
    const s = setup({ handle: "read" });
    await s.start();
    assert.deepEqual(kinds(s.world), ["rest", "graphql:main"], "first: a check (to learn Last-Modified) and one full fetch");
    assert.equal(s.st().baselined, true);
    const mark = s.world.calls.length;
    await s.advance(10 * MIN);
    // minutes 1–9: a conditional check each (304); minute 10: the reconciliation's full fetch instead
    assert.deepEqual(kinds(s.world, mark), [...Array(9).fill("rest"), "graphql:main"]);
    assert.ok(s.world.calls.slice(mark, mark + 9).every((c) => c.args.some((a) => a.startsWith("If-Modified-Since: "))), "every check is conditional");
    assert.equal(s.sent.length, 0);
    assert.equal(s.notes.length, 0);
    // a scripted review: in the snapshot by the next minute's check
    s.world.review("reviewer", { comments: [{ body: "Should the cap apply after jitter?" }] });
    const before = s.world.calls.length;
    await s.advance(MIN);
    assert.deepEqual(kinds(s.world, before), ["rest", "graphql:main"]);
    assert.equal(s.st().snapshot.threads.length, 1);
    assert.equal(s.sent.length, 0, "Read: no agent turn");
    s.watcher.stopAll();
});

test("checks: pending checks are polled alone every 2 minutes; they don't trigger handling", async () => {
    const s = setup({ handle: "assess" });
    s.world.checks([{ name: "build", status: "IN_PROGRESS", conclusion: null }]);
    await s.start();
    assert.equal(s.st().snapshot.checks.pending, 1);
    const mark = s.world.calls.length;
    await s.advance(2 * MIN);
    assert.deepEqual(kinds(s.world, mark), ["rest", "rest", "graphql:checksOnly"]);
    s.world.checks([{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }]);
    await s.advance(2 * MIN);
    assert.deepEqual(s.st().snapshot.checks.failing, ["build"]);
    assert.match(s.st().activity.at(-1).text, /Checks finished: 1 failed \(build\)/);
    const after2 = s.world.calls.length;
    await s.advance(2 * MIN);
    assert.ok(!kinds(s.world, after2).includes("graphql:checksOnly"), "nothing pending: no more checks-only queries");
    assert.equal(s.sent.length, 0);
    s.watcher.stopAll();
});

test("Do nothing and Read: shown and noted, never sent", async () => {
    const none = setup({ handle: "none" });
    const read = setup({ handle: "read" });
    for (const s of [none, read]) {
        await s.start();
        s.world.review("reviewer", { body: "Two things.", comments: [{ body: "One" }, { body: "Two" }] });
        await s.advance(2 * MIN);
        assert.equal(s.sent.length, 0);
        assert.equal(s.st().pending.length, 0);
        assert.equal(s.st().snapshot.threads.length, 2, "shown in the tab either way");
        s.watcher.stopAll();
    }
    assert.equal(none.notes.length, 0);
    assert.deepEqual(read.notes, ['3 new review comments on #7 "Add jitter and an onRetry hook" from reviewer.']);
});

test("a submitted review is one batch at once; a lone reply waits for 90 quiet seconds; one batch at a time", async () => {
    const s = setup({ handle: "assess" });
    await s.start();
    const [t1, t2] = s.world.review("reviewer", { body: "A few things.", comments: [{ body: "One" }, { body: "Two" }] });
    await s.advance(MIN);
    assert.equal(s.sent.length, 1, "the review went at once");
    assert.equal(s.sent[0].mode, "enqueue");
    const b1 = s.st().batches[0];
    assert.equal(b1.state, "admitted");
    assert.equal(b1.itemIds.length, 3);
    assert.deepEqual(b1.units.sort(), [`review:${s.world.model.reviews[0].id}`, `thread:${t1}`, `thread:${t2}`].sort());
    // more comments while that batch is out wait for the next one
    s.world.reply(t1, "reviewer", "Also this.");
    await s.advance(3 * MIN);
    assert.equal(s.sent.length, 1, "one batch at a time");
    assert.equal(s.st().pending.length, 1);
    // Copilot takes it up and finishes: the next batch can go (the reply has been quiet long enough)
    s.watcher.onSessionEvent({ type: "user.message", data: { messageId: b1.messageId } });
    assert.equal(s.st().batches[0].state, "seen");
    s.watcher.onSessionEvent({ type: "session.idle", data: {} });
    await s.settle();
    assert.equal(s.st().batches[0].state, "done");
    assert.equal(s.sent.length, 2);
    assert.deepEqual(s.st().batches[1].units, [`thread:${t1}`]);
    // a lone reply waits for quiet: not sent within 90 s of arriving
    s.watcher.onSessionEvent({ type: "user.message", data: { messageId: s.st().batches[1].messageId } });
    s.watcher.onSessionEvent({ type: "session.idle", data: {} });
    await s.settle();
    s.world.reply(t2, "reviewer", "And one more.");
    await s.advance(MIN);
    assert.equal(s.st().pending.length, 1);
    assert.equal(s.sent.length, 2, "still quiet-waiting");
    await s.advance(2 * MIN);
    assert.equal(s.sent.length, 3);
    s.watcher.stopAll();
});

test("you (any of your accounts) never trigger handling; deleted accounts do", async () => {
    const s = setup({ handle: "assess", world: { accounts: { "github.com": [{ login: "me", active: true }, { login: "me-at-work" }] } } });
    await s.start();
    s.world.converse("me", "A note from me");
    s.world.converse("me-at-work", "And from my other account");
    await s.advance(3 * MIN);
    assert.equal(s.st().pending.length, 0);
    assert.equal(s.sent.length, 0);
    s.world.converse(null, "From a deleted account");
    await s.advance(3 * MIN);
    assert.equal(s.sent.length, 1);
    s.watcher.stopAll();
});

test("P8: what GitHub shows is recorded per thread; an unrelated push marks no thread", async () => {
    const s = setup({ handle: "assess" });
    await s.start();
    const [t1, t2] = s.world.review("reviewer", { comments: [{ body: "Fix the cap" }, { body: "Rename this" }] });
    await s.advance(MIN);
    const b = s.st().batches[0];
    s.watcher.onSessionEvent({ type: "user.message", data: { messageId: b.messageId } });
    s.world.push("b".repeat(40)); // an unrelated push
    await s.advance(MIN);
    assert.deepEqual(s.st().facts, {}, "a push alone says nothing about any thread");
    assert.deepEqual(s.st().batches[0].pushedAfter, ["b".repeat(40)], "it's recorded on the batch");
    s.world.push("c".repeat(40));
    s.world.reply(t1, "me", `Fixed in ${"c".repeat(7)}.`);
    s.world.resolve(t1);
    s.world.reply(t2, "me", "Left as is: the name matches the API.");
    s.world.resolve(t2);
    s.world.outdate(t2);
    await s.advance(MIN); // the push changes the PR: a full fetch sees the replies and resolutions too
    const f = s.st().facts;
    assert.deepEqual(f[t1].observed.map((x) => [x.kind, x.commit ?? null]), [["resolved", null], ["replied", "c".repeat(7)]]);
    assert.deepEqual(f[t2].observed.map((x) => [x.kind, x.commit ?? null]), [["resolved", null], ["outdated", null], ["replied", null]]);
    assert.ok(f[t1].observed.every((x) => x.kind !== "fixed"), "observation never claims a fix");
    s.watcher.stopAll();
});

test("resolving alone doesn't change the PR: the reconciliation finds it (every 2 minutes while a batch is out)", async () => {
    const s = setup({ handle: "assess" });
    await s.start();
    const [t1] = s.world.review("reviewer", { comments: [{ body: "One" }] });
    await s.advance(MIN);
    assert.equal(s.st().batches[0].state, "admitted");
    s.world.resolve(t1);
    await s.advance(MIN);
    assert.ok(!s.st().facts[t1], "a 304: not seen yet");
    await s.advance(MIN);
    assert.deepEqual(s.st().facts[t1].observed.map((x) => x.kind), ["resolved"]);
    s.watcher.stopAll();
});

test("P11: a restart catches up; only what arrived meanwhile is delivered, never what was handled", async () => {
    const s = setup({ handle: "assess" });
    await s.start();
    const [tA] = s.world.review("reviewer", { comments: [{ body: "Comment A" }] });
    await s.advance(MIN);
    assert.equal(s.sent.length, 1);
    s.watcher.onSessionEvent({ type: "user.message", data: { messageId: s.st().batches[0].messageId } });
    s.watcher.onSessionEvent({ type: "session.idle", data: {} });
    await s.settle();
    s.watcher.stopAll(); // the session stops
    await s.clock.advance(5 * MIN);
    s.world.review("reviewer", { comments: [{ body: "Comment B" }] });
    await s.clock.advance(5 * MIN);
    const r = setup({ docId: s.docId, existing: s }); // a new process: same data, new watcher
    await r.start();
    assert.equal(r.sent.length, 1, "one delivery");
    assert.match(r.sent[0].text, new RegExp(`thread:${s.world.model.threads[1].id}`));
    assert.doesNotMatch(r.sent[0].text, new RegExp(`thread:${tA}\\b`));
    await r.advance(5 * MIN);
    assert.equal(r.sent.length, 1, "and nothing twice");
    r.watcher.stopAll();
});

test("P11: a crash after the chat accepted a batch but before it was saved resends the same batch, marked", async () => {
    const s = setup({ handle: "assess" });
    let crash = true;
    const inner = s.watcher;
    await s.start();
    s.watcher.stopAll();
    // a watcher whose send "succeeds" at the chat but crashes before admitted is saved
    const accepted = [];
    const w2 = createWatcher({
        gh: s.gh,
        clock: s.clock,
        send: async (m) => {
            accepted.push(m);
            if (crash) {
                crash = false;
                throw new Error("process died");
            }
            return { messageId: "m-2" };
        },
        compose: ({ units, batchId }) => ({ text: `[Marginal PR review] ${batchId}: ${units.join(", ")}`, displayPrompt: "x", units }),
    });
    w2.watch(s.docId);
    await w2.settled();
    s.world.review("reviewer", { comments: [{ body: "One" }] });
    await s.clock.advance(MIN, () => w2.settled());
    assert.equal(accepted.length, 1);
    assert.equal(St.readPr(s.docId, s.prId).batches[0].state, "prepared", "never admitted");
    await s.clock.advance(15_000, () => w2.settled());
    assert.equal(accepted.length, 2);
    assert.equal(St.readPr(s.docId, s.prId).batches.length, 1, "the same batch, not a new one");
    assert.match(accepted[1].text, /-b1: /);
    assert.equal(St.readPr(s.docId, s.prId).batches[0].state, "admitted");
    w2.stopAll();
    void inner;
});

test("P11: an admitted batch that never shows up is resent after the timeout; one that did isn't", async () => {
    const s = setup({ handle: "assess" });
    await s.start();
    s.world.review("reviewer", { comments: [{ body: "One" }] });
    await s.advance(MIN);
    assert.equal(s.sent.length, 1);
    s.watcher.onSessionEvent({ type: "session.idle", data: {} }); // idle, but the message never appeared
    await s.advance(4 * MIN);
    assert.equal(s.sent.length, 1, "not yet: 5 idle minutes");
    await s.advance(2 * MIN);
    assert.equal(s.sent.length, 2);
    assert.match(s.sent[1].text, /may have reached you already/);
    assert.equal(s.st().batches.length, 1);
    s.watcher.stopAll();
    // a restart with an admitted batch whose message is in the session's log: no resend, and it completes
    const r = setup({ docId: s.docId, existing: s, messageInLog: async (id) => ({ found: id === s.st().batches[0].messageId, done: true }) });
    await r.start();
    assert.equal(r.sent.length, 0);
    assert.equal(r.st().batches[0].state, "done");
    r.watcher.stopAll();
});

test("P13: a big PR is fetched across ticks from saved cursors; nothing is inferred while it's incomplete", async () => {
    const s = setup({ handle: "assess", limits: { pageBudget: 2 } });
    s.world.bigPr(220); // 5 pages of threads
    await s.start();
    assert.equal(s.st().baselined, false, "not baselined from a partial fetch");
    assert.ok(s.st().staging);
    await s.advance(45_000);
    assert.equal(s.st().baselined, true);
    assert.equal(s.st().snapshot.threads.length, 220);
    // a new comment on thread 210 (page 5), and a tail thread deleted on GitHub
    const target = s.world.model.threads[210].id;
    s.world.reply(target, "reviewer", "Late comment far down the list");
    s.world.remove(s.world.model.threads[219].comments[0].id);
    const mark = s.world.calls.length;
    await s.advance(MIN);
    assert.ok(s.st().staging, "still paging");
    assert.ok(!s.st().activity.some((a) => a.kind === "deleted"), "nothing marked deleted from absence");
    assert.equal(s.st().snapshot.threads.length, 220, "the last complete snapshot stands until the next one is complete");
    await s.advance(3 * MIN);
    const resumed = s.world.calls.slice(mark).filter((c) => c.kind === "graphql:threads");
    assert.ok(resumed.length >= 3);
    assert.equal(s.world.calls.slice(mark, mark + 6).filter((c) => c.kind === "graphql:main").length, 1, "page one once, then resumed from cursors");
    assert.ok(s.st().activity.some((a) => a.kind === "deleted"), "once complete, the deletion is known");
    assert.equal(s.st().snapshot.threads.length, 219);
    assert.equal(s.sent.length, 1);
    assert.match(s.sent[0].text, new RegExp(`thread:${target}`));
    s.watcher.stopAll();
});

test("rate limits back off until the reset; merged PRs stop; the cap pauses extra PRs; no lease, no calls", async () => {
    const s = setup({ handle: "assess" });
    await s.start();
    s.world.failNext(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor((s.clock.now() + 5 * MIN) / 1000)) }, '{"message":"API rate limit exceeded"}');
    await s.advance(MIN);
    assert.equal(s.st().error.kind, "rate_limit");
    const mark = s.world.calls.length;
    await s.advance(3 * MIN);
    assert.equal(s.world.calls.length, mark, "silent until the reset");
    await s.advance(3 * MIN);
    assert.ok(s.world.calls.length > mark);
    assert.equal(s.st().error, null);
    s.world.merge();
    await s.advance(MIN);
    assert.equal(s.st().stopped, "merged");
    const after = s.world.calls.length;
    await s.advance(15 * MIN);
    assert.equal(s.world.calls.length, after, "merged: no more calls");
    s.watcher.stopAll();

    const capped = setup({ handle: "read", limits: { maxWatched: 1 } });
    St.addPr(capped.docId, { url: "https://github.com/acme/app/pull/8" });
    await capped.start();
    const second = St.readIndex(capped.docId).prs[1].id;
    assert.equal(St.readPr(capped.docId, second).error.kind, "cap");
    assert.ok(capped.world.calls.every((c) => !c.args.some((a) => a.includes("/pulls/8"))));
    capped.watcher.stopAll();

    const clock = fakeClock();
    const world = fakeWorld({ clock: clock.now });
    St.addPr("doc-unowned", { url: world.ident.url });
    const w = createWatcher({ gh: createGitHub({ exec: world.exec, env: {} }), clock, owns: () => false, send: async () => ({}), compose: () => ({}) });
    w.watch("doc-unowned");
    await clock.advance(5 * MIN, () => w.settled());
    assert.equal(world.calls.length, 0);
    w.stopAll();
});

test("in a session that never goes idle (autopilot), the next request after a batch ends it", async () => {
    const s = setup({ handle: "assess" });
    await s.start();
    s.world.review("reviewer", { comments: [{ body: "One" }] });
    await s.advance(MIN);
    const b1 = s.st().batches[0];
    s.watcher.onSessionEvent({ type: "user.message", id: "x1", data: { messageId: b1.messageId } });
    assert.equal(s.st().batches[0].state, "seen");
    s.world.review("reviewer", { comments: [{ body: "Two" }] });
    await s.advance(2 * MIN);
    assert.equal(s.sent.length, 1, "b1 still with Copilot");
    s.watcher.onSessionEvent({ type: "user.message", id: "x2", data: { messageId: "steer", delivery: "steering" } });
    assert.equal(s.st().batches[0].state, "seen", "a steering message doesn't end the turn");
    s.watcher.onSessionEvent({ type: "user.message", id: "x3", data: { messageId: "autopilot-continue" } });
    await s.settle();
    assert.equal(s.st().batches[0].state, "done");
    assert.equal(s.sent.length, 2, "the next batch went without the session ever going idle");
    s.watcher.stopAll();
});

test("overflow: threads that don't fit a batch go in the next one, whole and in order", async () => {
    const s = setup({ handle: "assess", compose: ({ units, batchId }) => ({ text: `[Marginal PR review] ${batchId}: ${units.slice(0, 2).join(", ")}`, displayPrompt: "x", units: units.slice(0, 2) }) });
    await s.start();
    s.world.review("reviewer", { comments: [{ body: "1" }, { body: "2" }, { body: "3" }, { body: "4" }, { body: "5" }] });
    await s.advance(MIN);
    assert.equal(s.st().batches[0].units.length, 2);
    assert.equal(s.st().pending.length, 3, "3 threads wait (a review with no body has no summary)");
    for (let i = 0; i < 3; i++) {
        const b = s.st().batches.at(-1);
        s.watcher.onSessionEvent({ type: "user.message", data: { messageId: b.messageId } });
        s.watcher.onSessionEvent({ type: "session.idle", data: {} });
        await s.settle();
    }
    assert.equal(s.st().pending.length, 0);
    assert.deepEqual(s.st().batches.map((b) => b.units.length), [2, 2, 1]);
    assert.equal(new Set(s.st().batches.flatMap((b) => b.units)).size, 5, "every thread exactly once");
    assert.deepEqual(s.st().batches.map((b) => b.state), ["done", "done", "done"]);
    s.watcher.stopAll();
});
