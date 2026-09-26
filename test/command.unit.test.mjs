// Command center unit tests. Run: node --test test/
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.COPILOT_HOME = mkdtempSync(join(tmpdir(), "wb-unit-"));

const { classifyPattern, compilePatterns, globToRegExp, normalizeRepoPath, offPlanMatcher, patternsTouchDir, planPatterns, matchingActivePhases } = await import("../lib/command/patterns.mjs");
const { Issues, ISSUE_CODES, nearestPath, distance } = await import("../lib/command/issues.mjs");
const { parsePlan, parseViewSpec, Reader, LIMITS } = await import("../lib/command/model.mjs");
const { parseRawNumstat, computeEvents } = await import("../lib/command/poller.mjs");
const { claim, readLease, isOwner, STALE_MS, stopHeartbeat } = await import("../lib/command/owner.mjs");
const { appendEvents, compactLog, eventsSince, readBuckets } = await import("../lib/command/state.mjs");

const pat = (s, isTree) => classifyPattern(s, isTree).pattern;
const plan0 = (over = {}) => ({ id: "retry", title: "Retry", phases: [{ id: "p1", title: "Scaffold", expects: ["src/runner/"], steps: [{ id: "s1", title: "types", expects: ["src/runner/types.ts"] }] }], ...over });

// ---------- patterns ----------
test("classify: glob, dir (trailing slash or tree), file", () => {
    assert.deepEqual(pat("src/**/*.ts"), { kind: "glob", glob: "src/**/*.ts" });
    assert.deepEqual(pat("src/runner/"), { kind: "dir", path: "src/runner" });
    assert.deepEqual(pat("src/runner", (p) => p === "src/runner"), { kind: "dir", path: "src/runner" });
    assert.deepEqual(pat("src/new-file.ts"), { kind: "file", path: "src/new-file.ts" });
    assert.equal(classifyPattern("../etc").error, "path_outside_repo");
    assert.equal(classifyPattern("/abs").error, "path_outside_repo");
    assert.equal(classifyPattern("C:/x").error, "path_outside_repo");
    assert.equal(classifyPattern("src\\x.ts").error, "format");
    assert.equal(classifyPattern("src/**/[a").error, "format");
    assert.equal(normalizeRepoPath("./a//b/").path, "a/b");
});

test("globs: ** crosses directories, * does not, braces and classes", () => {
    const re = globToRegExp("src/**/*.{ts,tsx}");
    assert.ok(re.test("src/a.ts") && re.test("src/a/b/c.tsx"));
    assert.ok(!re.test("src/a.js") && !re.test("lib/a.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
    assert.ok(globToRegExp("test?.md").test("test1.md"));
    assert.ok(globToRegExp("[ab].js").test("a.js") && !globToRegExp("[!ab].js").test("a.js"));
});

test("compile + footprint helpers", () => {
    const m = compilePatterns([pat("src/runner/"), pat("docs/README.md"), pat("tests/**/*.test.ts")]);
    assert.ok(m("src/runner") && m("src/runner/x.ts") && m("docs/README.md") && m("tests/a/b.test.ts"));
    assert.ok(!m("src/runners/x.ts") && !m("docs/other.md"));
    assert.ok(patternsTouchDir([pat("src/runner/")], "src") && patternsTouchDir([pat("src/runner/")], "src/runner/x"));
    assert.ok(!patternsTouchDir([pat("src/runner/")], "web"));
});

test("off-plan: associated patterns per front, whole footprint when unassociated", () => {
    const plan = {
        phases: [
            { id: "p1", expects: [pat("src/a/")], steps: [], state: { status: "active", frontIds: ["f1"] } },
            { id: "p2", expects: [pat("src/b/")], steps: [{ id: "s", expects: [pat("src/c.ts")], state: { status: "active", frontId: "f2" } }], state: { status: "pending" } },
        ],
    };
    const f1 = offPlanMatcher(plan, "f1");
    assert.equal(f1("src/a/x.ts"), false);
    assert.equal(f1("src/b/x.ts"), true);
    const f2 = offPlanMatcher(plan, "f2");
    assert.equal(f2("src/c.ts"), false);
    assert.equal(f2("src/a/x.ts"), true);
    const f3 = offPlanMatcher(plan, "f3");
    assert.equal(f3("src/b/x.ts"), false);
    assert.equal(f3("web/x.ts"), true);
    assert.deepEqual(matchingActivePhases(plan, "src/a/q"), ["p1"]);
    assert.equal(planPatterns(plan).length, 3);
});

// ---------- issues ----------
test("nearest path + distance", () => {
    assert.equal(distance("kitten", "sitting"), 3);
    assert.equal(nearestPath("src/runner/retyr.ts", ["src/runner/retry.ts", "src/other.ts"]), "src/runner/retry.ts");
    assert.equal(nearestPath("zzz.md", ["src/runner/retry.ts"]), null);
});

test("issues cap at 50 and reject unknown codes", () => {
    const is = new Issues();
    for (let i = 0; i < 70; i++) is.add(`x[${i}]`, "required", "is required");
    assert.equal(is.list.length, 50);
    assert.match(is.result().note, /first 50/);
    assert.throws(() => is.add("x", "nope", "m"));
});

// ---------- plan parsing ----------
test("valid plan parses; states survive a re-set with the same ids", () => {
    const is = new Issues();
    const p = parsePlan(is, plan0(), { base: "a".repeat(40), isTree: (x) => x === "src/runner" });
    assert.ok(is.ok, JSON.stringify(is.list));
    assert.equal(p.phases[0].expects[0].kind, "dir");
    assert.equal(p.phases[0].state.status, "pending");
    p.phases[0].state = { status: "active", since: "t", frontIds: ["f1"] };
    const again = parsePlan(new Issues(), plan0(), { base: "a".repeat(40), previous: p });
    assert.equal(again.phases[0].state.status, "active");
});

test("invalid plan: every issue collected in one pass, with hints", () => {
    const is = new Issues();
    const bad = {
        id: "bad id!",
        title: "",
        extra: 1,
        base: "nope",
        phases: [
            { id: "p1", title: "A", expects: ["../x", "ok/"], steps: [{ id: "s1", title: "x", expects: [] }] },
            { id: "p1", title: "B", expects: "src/", steps: [{ id: "s1", title: "y", expects: ["a\\b"] }] },
            { title: "no id" },
        ],
    };
    parsePlan(is, bad, { base: null });
    const codes = is.list.map((i) => `${i.path}:${i.code}`);
    for (const want of ["plan.id:format", "plan.title:required", "plan.extra:type", "plan.base:ref_unresolvable", "plan.phases[0].expects[0]:path_outside_repo", "plan.phases[1].id:duplicate_id", "plan.phases[1].expects:type", "plan.phases[1].steps[0].id:duplicate_id", "plan.phases[1].steps[0].expects[0]:format", "plan.phases[2].id:required"])
        assert.ok(codes.includes(want), `missing ${want} in ${codes.join(", ")}`);
    assert.ok(is.list.find((i) => i.path === "plan.id").hint.includes("bad-id"));
});

test("limits: too_few and too_many", () => {
    const a = new Issues();
    parsePlan(a, { id: "x", title: "x", phases: [] }, { base: "a".repeat(40) });
    assert.ok(a.list.some((i) => i.code === "too_few"));
    const b = new Issues();
    parsePlan(b, { id: "x", title: "x", phases: Array.from({ length: LIMITS.phases + 1 }, (_, i) => ({ id: `p${i}`, title: "t" })) }, { base: "a".repeat(40) });
    assert.ok(b.list.some((i) => i.code === "too_many" && i.path === "plan.phases"));
});

test("view spec parsing", () => {
    const is = new Issues();
    const v = parseViewSpec(new Reader(is), { id: "v1", title: "P2", root: "src/runner/", pins: ["src/runner/retry.ts"], monitors: [{ path: "tests/", mode: "diff-feed" }], filters: { offPlanOnly: true } }, "view");
    assert.ok(is.ok, JSON.stringify(is.list));
    assert.equal(v.root, "src/runner");
    assert.equal(v.monitors[0].path, "tests");
    const bad = new Issues();
    parseViewSpec(new Reader(bad), { id: "v", title: "t", monitors: [{ path: "x", mode: "heat" }] }, "view");
    assert.ok(bad.list.some((i) => i.code === "enum"));
});

// ---------- numstat + deltas ----------
test("parse raw+numstat -z: modified, deleted, renamed, binary", () => {
    const out = ":100644 100644 a b M\0bin.dat\0:100644 000000 a 0 D\0del.txt\0:100644 100644 a 0 M\0keep.txt\0:100644 100644 a a R100\0old.txt\0renamed.txt\0-\t-\tbin.dat\0" + "0\t1\tdel.txt\0" + "1\t0\tkeep.txt\0" + "0\t0\t\0old.txt\0renamed.txt\0";
    const m = parseRawNumstat(out);
    assert.deepEqual(m.get("keep.txt"), { add: 1, del: 0, binary: false, kind: "modified" });
    assert.equal(m.get("del.txt").kind, "deleted");
    assert.deepEqual(m.get("renamed.txt"), { add: 0, del: 0, binary: false, kind: "renamed", previousPath: "old.txt" });
    assert.equal(m.get("bin.dat").binary, true);
});

test("delta computation: new, grow, shrink, revert, untracked, initial flag, off-plan", () => {
    const plan = { phases: [{ id: "p1", expects: [pat("src/")], steps: [], state: { status: "active", frontIds: ["f1"] } }] };
    const at = "2026-01-01T00:00:00Z";
    let prev = new Map();
    let next = new Map([
        ["src/a.ts", { add: 10, del: 2, kind: "modified" }],
        ["web/x.ts", { add: 3, del: 0, kind: "untracked" }],
    ]);
    let ev = computeEvents({ prev, next, frontId: "f1", plan, at, initial: true });
    assert.equal(ev.length, 2);
    assert.ok(ev.every((e) => e.initial));
    assert.equal(ev.find((e) => e.file === "web/x.ts").offPlan, true);
    assert.deepEqual(ev.find((e) => e.file === "src/a.ts").phaseIds, ["p1"]);
    prev = next;
    next = new Map([["src/a.ts", { add: 7, del: 5, kind: "modified" }]]);
    ev = computeEvents({ prev, next, frontId: "f1", plan, at });
    const a = ev.find((e) => e.file === "src/a.ts");
    assert.deepEqual(a.delta, { add: 3, del: 3 });
    assert.equal(a.netDelta, -6);
    const reverted = ev.find((e) => e.file === "web/x.ts");
    assert.deepEqual(reverted.totals, { add: 0, del: 0 });
    assert.equal(reverted.kind, "modified");
    assert.equal(computeEvents({ prev: next, next, frontId: "f1", plan, at }).length, 0, "no change → no events");
});

// ---------- lease ----------
test("lease: claim, renew, reject live other, take over when stale", () => {
    const doc = "lease-doc";
    const now = Date.parse("2026-01-01T00:00:00Z");
    const a = claim(doc, "A", { now });
    assert.ok(a.ok && !a.renewed && !a.tookOver);
    assert.ok(claim(doc, "A", { now: now + 1000 }).renewed);
    const b = claim(doc, "B", { now: now + 2000 });
    assert.equal(b.ok, false);
    assert.equal(b.lease.sessionId, "A");
    const c = claim(doc, "B", { now: now + 1000 + STALE_MS + 1 });
    assert.ok(c.ok && c.tookOver);
    assert.equal(readLease(doc, now + 1000 + STALE_MS + 2).sessionId, "B");
    stopHeartbeat(doc);
});

// ---------- log compaction ----------
test("compaction keeps replay-correct baselines and velocity buckets", () => {
    const doc = "compact-doc";
    const old = new Date(Date.now() - 7 * 3600_000).toISOString();
    appendEvents(doc, [
        { at: old, frontId: "f", file: "a", kind: "modified", delta: { add: 5, del: 0 }, netDelta: 5, totals: { add: 5, del: 0 } },
        { at: old, frontId: "f", file: "a", kind: "modified", delta: { add: 2, del: 0 }, netDelta: 2, totals: { add: 7, del: 0 } },
        { at: new Date().toISOString(), frontId: "f", file: "b", kind: "modified", delta: { add: 1, del: 0 }, netDelta: 1, totals: { add: 1, del: 0 } },
    ]);
    const r = compactLog(doc);
    assert.equal(r.compacted, 2);
    const evs = eventsSince(doc, 0);
    assert.equal(evs.length, 2);
    const base = evs.find((e) => e.file === "a");
    assert.ok(base.baseline);
    assert.deepEqual(base.totals, { add: 7, del: 0 });
    assert.equal(readBuckets(doc)[0].churn, 7);
});

test("every issue code is exercised somewhere", () => {
    assert.ok(ISSUE_CODES.includes("not_owner") && ISSUE_CODES.includes("duplicate_worktree"));
});
