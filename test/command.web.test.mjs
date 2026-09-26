// Unit tests for the Command tab's pure browser modules (layout + derivations). Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildTree, weigh, squarify, findNode } = await import("../web/command/squarify.js");
const { changesAt, velocity, autoWindow, buckets, heatOf } = await import("../web/command/derive.js");

test("squarify: areas proportional to value, inside the rect, no overlap", () => {
    const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ id: i, value: v }));
    const W = 600;
    const H = 400;
    const out = squarify(items, 0, 0, W, H);
    const total = 24;
    for (const r of out) {
        assert.ok(Math.abs((r.w * r.h) / (W * H) - r.value / total) < 0.01, `area of ${r.id}`);
        assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6);
    }
    for (let i = 0; i < out.length; i++)
        for (let j = i + 1; j < out.length; j++) {
            const [a, b] = [out[i], out[j]];
            const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            assert.ok(!(ix > 1e-6 && iy > 1e-6), `tiles ${a.id} and ${b.id} overlap`);
        }
    // Squarified keeps aspect ratios reasonable.
    assert.ok(out.every((r) => Math.max(r.w / r.h, r.h / r.w) < 4));
});

test("squarify ignores zero values and degenerate rects", () => {
    assert.deepEqual(squarify([{ value: 0 }], 0, 0, 10, 10), []);
    assert.deepEqual(squarify([{ value: 1 }], 0, 0, 0, 10), []);
});

test("tree + weights: min weight, pins multiply subtrees, new files join", () => {
    const t = buildTree(
        [
            ["src/a.ts", 100],
            ["src/b.ts", 5],
            ["web/x.ts", 50],
        ],
        new Map([["src/new.ts", 30]]),
    );
    assert.equal(findNode(t, "src/new.ts").lines, 30);
    assert.equal(findNode(t, "src").children.length, 3);
    assert.equal(weigh(t), 100 + 20 + 30 + 50);
    assert.equal(weigh(t, { pins: new Map([["web", 3]]) }), 100 + 20 + 30 + 150);
});

const ev = (seq, at, frontId, file, add, del, extra = {}) => ({ seq, at: new Date(at).toISOString(), frontId, file, kind: "modified", delta: { add, del }, netDelta: add - del, totals: { add, del }, ...extra });

test("changesAt: latest totals per front+file as of a time; reverts drop out; leads + collisions", () => {
    const t0 = Date.parse("2026-01-01T10:00:00Z");
    const log = [ev(1, t0, "f1", "a.ts", 10, 2), ev(2, t0 + 1000, "f2", "a.ts", 3, 0), ev(3, t0 + 2000, "f1", "b.ts", 5, 0), { ...ev(4, t0 + 3000, "f1", "b.ts", 0, 0) }];
    const now = changesAt(log);
    assert.equal(now.has("b.ts"), false, "reverted file is gone");
    const a = now.get("a.ts");
    assert.equal(a.fronts.size, 2);
    assert.equal(a.lead, "f1");
    assert.deepEqual([a.add, a.del], [13, 2]);
    const past = changesAt(log, t0 + 2500);
    assert.equal(past.get("b.ts").add, 5, "replay sees b.ts before its revert");
    assert.equal(changesAt(log, t0 - 1).size, 0);
});

test("velocity: trailing bucket, initial/baseline excluded, auto window by age", () => {
    const t0 = Date.parse("2026-01-01T10:00:00Z");
    const log = [ev(1, t0, "f1", "a.ts", 100, 0, { initial: true }), ev(2, t0 + 10_000, "f1", "a.ts", 6, 2), ev(3, t0 + 20_000, "f2", "b.ts", 4, 0)];
    const v = velocity(log, { at: t0 + 30_000, windowKey: "1m" });
    assert.equal(v.churn, 12);
    assert.equal(v.net, 8);
    assert.equal(v.files, 2);
    assert.equal(v.events, 2);
    assert.equal(autoWindow(5 * 60_000).label, "1m");
    assert.equal(autoWindow(30 * 60_000).label, "5m");
    assert.equal(autoWindow(3 * 3600_000).label, "15m");
    assert.equal(autoWindow(9 * 3600_000).label, "1h");
    const b = buckets(log, { from: t0, to: t0 + 30_000, count: 3 });
    assert.deepEqual(b.get("f1"), [0, 8, 0]);
    assert.deepEqual(b.get("f2"), [0, 0, 4]);
    assert.deepEqual([heatOf(5), heatOf(30), heatOf(100), heatOf(500)], [8, 14, 22, 30]);
});

// ---------- views, follow, auto-root, zero-line changes ----------
globalThis.location ??= { search: "" };
const views = await import("../web/command/views.js");

test("changesAt keeps zero-line renames/new files and carries off-plan per front", () => {
    const t0 = Date.parse("2026-01-01T10:00:00Z");
    const log = [ev(1, t0, "f1", "b.ts", 0, 0, { kind: "renamed", previousPath: "a.ts" }), ev(2, t0 + 1, "f1", "new.ts", 0, 0, { kind: "untracked", offPlan: true }), ev(3, t0 + 2, "f2", "c.ts", 0, 0)];
    const m = changesAt(log);
    assert.deepEqual([...m.keys()].sort(), ["b.ts", "new.ts"]);
    assert.equal(m.get("b.ts").previousPath, "a.ts");
    assert.equal(m.get("new.ts").fronts.get("f1").offPlan, true);
});

test("autoRoot: smallest subtree covering concrete expects (glob prefixes) and changed files", () => {
    const plan = (expects, steps = []) => ({ phases: [{ expects, steps }] });
    const d = (path) => ({ kind: "dir", path });
    const f = (path) => ({ kind: "file", path });
    assert.equal(views.autoRoot(plan([d("src/runner")]), ["src/runner/x.ts"]), "src/runner");
    assert.equal(views.autoRoot(plan([d("src/runner")]), ["src/util/t.ts"]), "src");
    assert.equal(views.autoRoot(plan([f("src/runner/a.ts")], [{ expects: [{ kind: "glob", glob: "src/runner/**/*.ts" }] }]), []), "src/runner");
    assert.equal(views.autoRoot(plan([d("src")]), ["README.md"]), "");
    assert.equal(views.autoRoot(null, []), "");
});

test("follow: applies the active phase's suggestion once; a user edit holds it; paused never applies", () => {
    const sv = { id: "p2v", title: "P2", root: "src" };
    const state = { plan: { phases: [{ id: "p1", state: { status: "done" }, suggestedView: { id: "p1v" } }, { id: "p2", state: { status: "active" }, suggestedView: sv }] } };
    assert.equal(views.followDecision({ state, prefs: { follow: true } })?.id, "p2");
    assert.equal(views.followDecision({ state, prefs: { follow: true, appliedPhase: "p2" } }), null, "already applied");
    assert.equal(views.followDecision({ state, prefs: { follow: false } }), null, "paused");
    assert.equal(views.followDecision({ state, prefs: { follow: true, appliedPhase: "p1", adjustedSince: "t", adjustedPhase: "p1" } })?.id, "p2", "an adjustment in P1 does not block P2");
    assert.equal(views.followDecision({ state, prefs: { follow: true, appliedPhase: "p1", adjustedSince: null } })?.id, "p2", "next phase applies when not adjusted");
    assert.ok(views.quietSinceZoom(Date.now() - 6000) && !views.quietSinceZoom(Date.now() - 1000));
});

test("layoutFromView normalizes pins/monitors; viewChoices merges agent, phase and user views", () => {
    const L = views.layoutFromView({ id: "v", root: "src", pins: [{ path: "src/a" }, "src/b"], monitors: [{ path: "src" }] });
    assert.deepEqual(L, { root: "src", pins: ["src/a", "src/b"], monitors: [{ path: "src", mode: "diff-feed" }], filters: {} });
    assert.ok(views.sameLayout(L, views.layoutFromView({ id: "w", root: "src", pins: ["src/a", "src/b"], monitors: [{ path: "src", mode: "diff-feed" }] })));
    const state = { plan: { phases: [{ id: "p2", suggestedView: { id: "p2v", title: "P2" } }] }, views: [{ id: "p2v", title: "dup" }, { id: "agent2", title: "A2", origin: "agent" }] };
    const ch = views.viewChoices(state, { savedViews: [{ id: "my-view-1", title: "Mine" }] });
    assert.deepEqual(ch.map((v) => [v.id, v.origin, v.phaseId ?? null]), [["p2v", "agent", "p2"], ["agent2", "agent", null], ["my-view-1", "user", null]]);
});