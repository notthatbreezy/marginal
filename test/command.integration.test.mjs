// Command center integration: temp repo + 2 worktrees, handlers driven directly, real polling, lease, dedupe, SSE.
// Run: node --test test/command.integration.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "wb-int-"));
process.env.COPILOT_HOME = join(tmp, "home");
const ext = fileURLToPath(new URL("..", import.meta.url));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const repo = join(tmp, "repo");
const wt1 = join(tmp, "wt-runner");
const wt2 = join(tmp, "wt-tests");
const other = join(tmp, "other");
const wt3 = join(tmp, "wt-extra");

const store = await import("../lib/store.mjs");
const gitm = await import("../lib/git.mjs");
const { ACTIONS, stats } = await import("../lib/command/actions.mjs");
const poller = await import("../lib/command/poller.mjs");
const { gitStats } = await import("../lib/command/gitx.mjs");
const { commandDir, eventsSince, readState, unwatchCommand } = await import("../lib/command/state.mjs");
const { stopHeartbeat } = await import("../lib/command/owner.mjs");

poller.CADENCE.fast = 150;
poller.CADENCE.slow = 400;

let doc, repoRec, ctxA, ctxB;
const call = (name, input, ctx = ctxA) => ACTIONS[name](input, ctx);
const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out");
};

before(async () => {
    mkdirSync(join(repo, "src", "runner"), { recursive: true });
    mkdirSync(join(repo, "tests"), { recursive: true });
    git(tmp, "init", "-q", "-b", "main", repo);
    git(repo, "config", "user.email", "t@x");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "src", "runner", "executor.ts"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n");
    writeFileSync(join(repo, "tests", "executor.test.ts"), "test('x', () => {});\n");
    writeFileSync(join(repo, "README.md"), "# relay\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    git(repo, "worktree", "add", "-q", wt1, "-b", "runner");
    git(repo, "worktree", "add", "-q", wt2, "-b", "tests");
    git(tmp, "init", "-q", other);
    repoRec = await gitm.registerRepository(repo);
    const pins = await gitm.resolvePins(repoRec.repositoryId, "main", "main");
    doc = await store.create({ title: "Retry policy", target: pins });
    const base = { docId: doc.documentId, doc: store.getDoc(doc.documentId), repo: gitm.getRepository(repoRec.repositoryId) };
    ctxA = { ...base, sessionId: "session-A" };
    ctxB = { ...base, sessionId: "session-B" };
});

after(() => {
    poller.stopAll();
    stopHeartbeat(doc.documentId);
    unwatchCommand();
    try {
        git(repo, "worktree", "remove", "--force", wt1);
        git(repo, "worktree", "remove", "--force", wt2);
        git(repo, "worktree", "remove", "--force", wt3);
    } catch {}
    rmSync(tmp, { recursive: true, force: true });
});

const planInput = {
    id: "retry",
    title: "Retry policy",
    phases: [
        { id: "p1", title: "Runner", expects: ["src/runner/"], steps: [{ id: "s1", title: "backoff", expects: ["src/runner/backoff.ts"] }] },
        { id: "p2", title: "Tests", expects: ["tests/"] },
    ],
};

test("mutations before a plan are rejected with a claim hint", async () => {
    const r = await call("command_front", { op: "register", id: "runner", label: "runner", worktree: wt1 });
    assert.equal(r.ok, false);
    assert.equal(r.issues[0].code, "not_owner");
    assert.match(r.issues[0].hint, /command_plan/);
});

test("invalid plan set returns all issues with hints and changes nothing", async () => {
    const before = JSON.stringify(readState(doc.documentId));
    const r = await call("command_plan", { op: "set", plan: { id: "Bad Id", title: "x", phases: [{ id: "p1", title: "a", expects: ["../up"] }, { id: "p1", title: "b" }] } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.issues.map((i) => i.code).sort(), ["duplicate_id", "format", "path_outside_repo"]);
    assert.ok(r.issues.every((i) => i.path && i.message));
    assert.equal(JSON.stringify(readState(doc.documentId)), before);
});

test("plan set claims the lease; another live session gets not_owner naming the owner", async () => {
    const r = await call("command_plan", { op: "set", plan: planInput });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.lease, "claimed");
    assert.match(r.summary, /2 phases, 1 steps, 3 paths/);
    const again = await call("command_plan", { op: "set", plan: planInput });
    assert.equal(again.lease, "renewed");
    const b = await call("command_plan", { op: "set", plan: planInput }, ctxB);
    assert.equal(b.ok, false);
    assert.equal(b.issues[0].code, "not_owner");
    assert.match(b.issues[0].hint, /session-A/);
});

test("front registration validates worktrees", async () => {
    const bad = await call("command_front", { op: "register", id: "x", label: "x", worktree: other });
    assert.equal(bad.issues[0].code, "worktree_other_repo");
    const rel = await call("command_front", { op: "register", id: "x", label: "x", worktree: "relative/path" });
    assert.equal(rel.issues[0].code, "format");
    const missing = await call("command_front", { op: "register", id: "x", label: "x", worktree: join(tmp, "nope") });
    assert.equal(missing.issues[0].code, "worktree_not_repo");
    assert.ok((await call("command_front", { op: "register", id: "runner", label: "runner-retry", worktree: wt1 })).ok);
    assert.ok((await call("command_front", { op: "register", id: "tests", label: "tests", worktree: wt2 })).ok);
    const dup = await call("command_front", { op: "register", id: "runner2", label: "dup", worktree: wt1 });
    assert.equal(dup.issues[0].code, "duplicate_worktree");
    const st = readState(doc.documentId);
    assert.deepEqual(
        st.fronts.map((f) => [f.id, f.color]),
        [
            ["runner", 0],
            ["tests", 1],
        ],
    );
});

test("edits in each worktree become events attributed to the right front within 5 s", async () => {
    await call("command_plan", { op: "phase", phaseId: "p1", status: "active", frontIds: ["runner"] });
    writeFileSync(join(wt1, "src", "runner", "backoff.ts"), "export const backoff = 1;\nexport const max = 5;\n");
    writeFileSync(join(wt1, "src", "runner", "executor.ts"), readFileSync(join(wt1, "src", "runner", "executor.ts"), "utf8") + "retry();\n");
    writeFileSync(join(wt1, "README.md"), "# relay\nchanged off plan\n");
    writeFileSync(join(wt2, "tests", "executor.test.ts"), "test('x', () => {});\ntest('retry', () => {});\n");
    const t0 = Date.now();
    const evs = await until(() => {
        const e = eventsSince(doc.documentId, 0);
        return e.some((x) => x.file === "src/runner/backoff.ts") && e.some((x) => x.file === "tests/executor.test.ts") && e.some((x) => x.file === "README.md") ? e : null;
    });
    assert.ok(Date.now() - t0 < 5000);
    const by = (f) => evs.filter((e) => e.file === f).at(-1);
    assert.equal(by("src/runner/backoff.ts").frontId, "runner");
    assert.equal(by("src/runner/backoff.ts").kind, "untracked");
    assert.deepEqual(by("src/runner/executor.ts").totals, { add: 1, del: 0 });
    assert.deepEqual(by("src/runner/executor.ts").phaseIds, ["p1"]);
    assert.equal(by("tests/executor.test.ts").frontId, "tests");
    assert.equal(by("README.md").offPlan, true);
    assert.equal(by("src/runner/executor.ts").offPlan, false);
});

test("stats reflect current totals and off-plan files", async () => {
    // Make a non-initial change so velocity counts it.
    writeFileSync(join(wt1, "src", "runner", "backoff.ts"), "export const backoff = 1;\nexport const max = 5;\nexport const jitter = true;\n");
    await until(() => eventsSince(doc.documentId, 0).some((e) => e.file === "src/runner/backoff.ts" && e.totals.add === 3));
    const s = stats(doc.documentId);
    const runner = s.fronts.find((f) => f.id === "runner");
    assert.equal(runner.files, 3);
    assert.deepEqual(runner.offPlan, ["README.md"]);
    assert.ok(s.churnPerMin > 0);
    const read = await call("command_read", { include: ["stats", "offplan"] }, ctxB);
    assert.ok(read.ok);
    assert.equal(read.stats.offPlan, 1);
    assert.deepEqual(read.offplan.runner, ["README.md"]);
});

test("reverting a file emits a zero-totals event", async () => {
    execFileSync("git", ["checkout", "--", "README.md"], { cwd: wt1 });
    const ev = await until(() => eventsSince(doc.documentId, 0).filter((e) => e.file === "README.md").at(-1)?.totals.add === 0 && eventsSince(doc.documentId, 0).filter((e) => e.file === "README.md").at(-1));
    assert.deepEqual(ev.totals, { add: 0, del: 0 });
});

test("phase/step/status transitions and their issues", async () => {
    const bad = await call("command_plan", { op: "phase", phaseId: "nope", status: "active" });
    assert.equal(bad.issues[0].code, "unknown_id");
    assert.match(bad.issues[0].hint, /p1, p2/);
    const badCommit = await call("command_plan", { op: "phase", phaseId: "p1", status: "done", commit: "deadbeef" });
    assert.equal(badCommit.issues[0].code, "ref_unresolvable");
    const head = git(repo, "rev-parse", "HEAD");
    const done = await call("command_plan", { op: "phase", phaseId: "p1", status: "done", commit: head });
    assert.ok(done.ok);
    assert.deepEqual(readState(doc.documentId).plan.phases[0].state.checkpoint, { source: "commit", sha: head, frontId: "runner" });
    assert.ok((await call("command_plan", { op: "step", stepId: "s1", status: "active", frontId: "runner" })).ok);
    assert.ok((await call("command_front", { op: "status", id: "tests", status: "blocked", note: "needs a decision" })).ok);
    assert.equal(readState(doc.documentId).fronts.find((f) => f.id === "tests").note, "needs a decision");
    const bs = await call("command_status", { status: "sleeping" });
    assert.equal(bs.issues[0].code, "enum");
    assert.ok((await call("command_status", { status: "awaiting_operator", prompt: "Pick A or B" })).ok);
    assert.equal(readState(doc.documentId).mission.status, "awaiting_operator");
    const nb = await call("command_status", { status: "working" }, ctxB);
    assert.equal(nb.issues[0].code, "not_owner");
});

test("status prompt is only accepted with awaiting_operator", async () => {
    const before = JSON.stringify(readState(doc.documentId));
    for (const status of ["working", "complete"]) {
        const r = await call("command_status", { status, prompt: "Choose a region" });
        assert.equal(r.ok, false);
        assert.equal(r.issues[0].path, "prompt");
    }
    assert.equal(JSON.stringify(readState(doc.documentId)), before);
});

test("removing a front revokes its phase/step associations (a re-registered id inherits nothing)", async () => {
    git(repo, "worktree", "add", "-q", wt3, "-b", "extra");
    assert.ok((await call("command_front", { op: "register", id: "extra", label: "extra", worktree: wt3 })).ok);
    assert.ok((await call("command_plan", { op: "phase", phaseId: "p2", status: "active", frontIds: ["tests", "extra"] })).ok);
    assert.ok((await call("command_plan", { op: "step", stepId: "s1", status: "active", frontId: "extra" })).ok);
    assert.ok((await call("command_front", { op: "remove", id: "extra" })).ok);
    let st = readState(doc.documentId);
    assert.deepEqual(st.plan.phases[1].state.frontIds, ["tests"]);
    assert.equal(st.plan.phases[0].steps[0].state.frontId, undefined);
    assert.ok((await call("command_front", { op: "register", id: "extra", label: "extra again", worktree: wt3 })).ok);
    st = readState(doc.documentId);
    assert.deepEqual(st.plan.phases[1].state.frontIds, ["tests"]);
    assert.ok((await call("command_front", { op: "remove", id: "extra" })).ok);
});

test("done without a commit snapshots into a hidden ref; HEAD, index and status untouched; no front → rejected atomically", async () => {
    await call("command_plan", { op: "set", plan: { ...planInput, phases: [...planInput.phases, { id: "p3", title: "Docs", expects: ["README.md"] }] } });
    const before = JSON.stringify(readState(doc.documentId));
    const orphan = await call("command_plan", { op: "phase", phaseId: "p3", status: "done" });
    assert.equal(orphan.ok, false);
    assert.equal(orphan.issues[0].code, "required");
    assert.equal(JSON.stringify(readState(doc.documentId)), before, "state unchanged");

    const head = git(wt2, "rev-parse", "HEAD");
    const status = git(wt2, "status", "--porcelain");
    const r = await call("command_plan", { op: "phase", phaseId: "p2", status: "done" });
    assert.ok(r.ok, JSON.stringify(r));
    const cp = readState(doc.documentId).plan.phases[1].state.checkpoint;
    assert.equal(cp.source, "snapshot");
    assert.equal(cp.frontId, "tests");
    assert.equal(cp.ref, `refs/whiteboard/checkpoints/${doc.documentId}/p2`);
    assert.equal(git(repo, "rev-parse", cp.ref), cp.sha);
    assert.match(git(repo, "show", `${cp.sha}:tests/executor.test.ts`), /retry/);
    assert.equal(git(wt2, "rev-parse", "HEAD"), head);
    assert.equal(git(wt2, "status", "--porcelain"), status);
});

test("a new plan base re-baselines totals as initial observations, not edits", async () => {
    git(wt1, "add", "-A");
    git(wt1, "commit", "-qm", "wip");
    const sha = git(wt1, "rev-parse", "HEAD");
    // Staging turned untracked files into "added" (a real observation); let the poller settle before re-basing.
    let last = -1;
    await until(async () => {
        const s = eventsSince(doc.documentId, 0).at(-1).seq;
        if (s === last) return true;
        last = s;
        await new Promise((r) => setTimeout(r, 700));
    }, 10_000);
    const seq0 = eventsSince(doc.documentId, 0).at(-1).seq;
    assert.ok((await call("command_plan", { op: "set", plan: { ...planInput, base: sha } })).ok);
    const evs = await until(() => {
        const e = eventsSince(doc.documentId, seq0).filter((x) => x.frontId === "runner");
        return e.some((x) => x.file === "src/runner/backoff.ts") ? e : null;
    });
    assert.ok(evs.every((e) => e.initial), JSON.stringify(evs));
    assert.deepEqual(evs.find((e) => e.file === "src/runner/backoff.ts").totals, { add: 0, del: 0 });
});

test("pollers dedupe: once per front in-process, zero in a non-owner process", async () => {
    const d = doc.documentId;
    const loops1 = poller.pollingFronts(d);
    poller.startPolling(d, readState(d).fronts[0]);
    assert.deepEqual(poller.pollingFronts(d), loops1, "second start is a no-op");
    const script = `
        process.env.COPILOT_HOME = ${JSON.stringify(process.env.COPILOT_HOME)};
        const { adoptLeases } = await import(${JSON.stringify(pathToFileURL(join(ext, "lib/command/index.mjs")).href)});
        const { gitStats } = await import(${JSON.stringify(pathToFileURL(join(ext, "lib/command/gitx.mjs")).href)});
        const adopted = adoptLeases("session-B");
        await new Promise((r) => setTimeout(r, 1500));
        console.log(JSON.stringify({ adopted, diffs: gitStats.byKind.diff ?? 0 }));
        process.exit(0);`;
    const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true });
        let s = "";
        child.stdout.on("data", (b) => (s += b));
        child.on("close", () => resolve(s));
    });
    const r = JSON.parse(out.trim().split("\n").pop());
    assert.deepEqual(r, { adopted: [], diffs: 0 });
    const before = gitStats.byKind.diff ?? 0;
    await new Promise((r2) => setTimeout(r2, 1200));
    assert.ok((gitStats.byKind.diff ?? 0) > before, "owner keeps polling");
});

test("server: /api/command/state + tree, and SSE pushes command events", async () => {
    const { startServer } = await import("../lib/server.mjs");
    const instances = new Map([["panel-1", { documentId: doc.documentId }]]);
    instances.save = () => {};
    const chat = { subscribe: () => () => {} };
    const s = await startServer({ chat, instances, getSessionId: () => "session-A" });
    const u = new URL(s.urlFor("panel-1"));
    const tok = u.searchParams.get("t");
    const get = (p) => fetch(`${u.origin}${p}`, { headers: { "x-wb-token": tok } }).then((r) => r.json());
    const st = await get(`/api/command/state?doc=${doc.documentId}`);
    assert.equal(st.isOwnerHere, true);
    assert.equal(st.state.fronts.length, 2);
    const tree = await get(`/api/command/tree?doc=${doc.documentId}`);
    assert.deepEqual(Object.fromEntries(tree.files)["src/runner/executor.ts"], 40);
    const pat = await fetch(`${u.origin}/command/patterns.js`).then((r) => r.text());
    assert.match(pat, /export function compilePatterns/);
    const ac = new AbortController();
    const res = await fetch(`${u.origin}/api/events?instance=panel-1&t=${tok}`, { signal: ac.signal });
    const reader = res.body.getReader();
    writeFileSync(join(wt2, "tests", "new.test.ts"), "test('n', () => {});\n");
    let buf = "";
    const got = await until(async () => {
        const { value } = await reader.read();
        buf += new TextDecoder().decode(value);
        return buf.split("\n\n").map((c) => c.replace(/^data: /, "")).filter((c) => c.startsWith("{")).map((c) => JSON.parse(c)).find((e) => e.type === "command" && e.kind === "events" && e.events.some((x) => x.file === "tests/new.test.ts"));
    });
    assert.equal(got.events.find((x) => x.file === "tests/new.test.ts").frontId, "tests");
    ac.abort();
    s.server.closeAllConnections?.();
    s.server.close();
});

test("losing the lease stops this process's pollers; a stale takeover restarts them", async () => {
    const d = doc.documentId;
    assert.ok(poller.pollingFronts(d).length > 0);
    const lease = join(commandDir(d), "owner.json");
    const iso = (ms) => new Date(ms).toISOString();
    writeFileSync(lease, JSON.stringify({ sessionId: "session-B", pid: 1, claimedAt: iso(Date.now()), heartbeatAt: iso(Date.now()) }));
    await until(() => poller.pollingFronts(d).length === 0);
    writeFileSync(lease, JSON.stringify({ sessionId: "session-B", pid: 1, claimedAt: iso(Date.now() - 120_000), heartbeatAt: iso(Date.now() - 60_000) }));
    const r = await call("command_plan", { op: "set", plan: planInput });
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(r.lease, /taken over/);
    assert.ok(poller.pollingFronts(d).length > 0);
});

test("deleting the whiteboard stops its pollers first", async () => {
    await import("../lib/command/index.mjs"); // registers the store hook
    assert.ok(poller.pollingFronts(doc.documentId).length > 0);
    assert.ok(git(repo, "for-each-ref", `refs/whiteboard/checkpoints/${doc.documentId}/`).length > 0);
    await store.remove(doc.documentId);
    assert.deepEqual(poller.pollingFronts(doc.documentId), []);
    assert.equal(git(repo, "for-each-ref", `refs/whiteboard/checkpoints/${doc.documentId}/`), "", "checkpoint refs dropped");
});
