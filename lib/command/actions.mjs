// command_* canvas actions: parse → validate (all issues, atomically) → apply. Results are plain values:
// { ok:true, revision, summary, … } or { ok:false, issues:[{path, code, message, hint?}] } — never a throw for bad input.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { gitOut } from "./gitx.mjs";
import { Issues, listHint } from "./issues.mjs";
import { locIndex } from "./loc.mjs";
import { FRONT_COLORS, FRONT_STATUS, LIMITS, MISSION_STATUS, PHASE_STATUS, Reader, findPhase, findStep, frontIdsHint, parsePlan, parseViewSpec, phaseIdsHint, stepIdsHint } from "./model.mjs";
import { claim, isOwner, readLease } from "./owner.mjs";
import { refFor, snapshotWorktree } from "./snapshot.mjs";
import { isPresentChange, offPlanMatcher, planPatterns } from "./patterns.mjs";
import { nudge, startPolling, stopPolling } from "./poller.mjs";
import { appendEvents, eventsSince, lastSeq, readPrefs, readState, writeState } from "./state.mjs";
import { commandDiff, commandWalkthrough } from "./walkthrough.mjs";

const now = () => new Date().toISOString();
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

async function commonDir(dir) {
    const out = await gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { kind: "rev-parse" });
    return out ? resolve(out.trim()) : null;
}
async function topLevel(dir) {
    const out = await gitOut(dir, ["rev-parse", "--show-toplevel"], { kind: "rev-parse" });
    return out ? resolve(out.trim()) : null;
}
async function resolveCommit(repoPath, ref) {
    if (typeof ref !== "string" || !ref.trim() || ref.startsWith("-")) return null;
    const out = await gitOut(repoPath, ["rev-parse", "--verify", "--quiet", `${ref.trim()}^{commit}`], { kind: "rev-parse" });
    return out ? out.trim() : null;
}

function notOwner(docId, what) {
    const lease = readLease(docId);
    const issues = new Issues();
    if (lease?.live) issues.add("", "not_owner", `${what} is owned by session ${lease.sessionId}`, `call it from session ${lease.sessionId}, or wait until its heartbeat is stale (30 s)`);
    else issues.add("", "not_owner", `no session owns this whiteboard's Command state yet`, `call command_plan {op:"set"} first; it claims the lease`);
    return issues.result();
}

/** Everything a handler needs about the document. */
export async function commandContext(doc, repo, sessionId) {
    return { docId: doc.id, doc, repo, sessionId };
}

// ---------- command_plan ----------
export async function commandPlan(input, ctx) {
    const r = new Reader(new Issues());
    const op = r.enumOf(input.op, "op", ["set", "phase", "step", "read"]);
    if (!r.issues.ok) return r.issues.result();
    const { docId, repo } = ctx;
    if (op === "read") return { ok: true, plan: readState(docId).plan, revision: readState(docId).revision, lease: readLease(docId) };

    if (op === "set") {
        const issues = r.issues;
        const lease = readLease(docId);
        if (lease?.live && lease.sessionId !== ctx.sessionId) return notOwner(docId, "Command state");
        const idx = await locIndex(repo.id, repo.path);
        const dirs = new Set();
        for (const [p] of idx.files) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
        const baseRef = input.plan?.base;
        const base = baseRef ? await resolveCommit(repo.path, baseRef) : ctx.doc.target?.base ?? null;
        if (!baseRef && !base) issues.add("plan.base", "required", "this whiteboard has no base commit", "pass plan.base (a ref or sha)");
        const prev = readState(docId).plan;
        const plan = parsePlan(issues, input.plan, { isTree: (p) => dirs.has(p), base, previous: prev?.id === input.plan?.id ? prev : null });
        if (!issues.ok) return issues.result();
        const c = claim(docId, ctx.sessionId);
        if (!c.ok) return notOwner(docId, "Command state");
        const next = writeState(docId, (s) => {
            s.plan = { ...plan, revision: (s.plan?.revision ?? 0) + 1 };
        });
        for (const f of next.fronts) startPolling(docId, f);
        const steps = plan.phases.reduce((n, p) => n + p.steps.length, 0);
        const pats = planPatterns(plan).length;
        return { ok: true, revision: next.revision, lease: c.renewed ? "renewed" : c.tookOver ? "taken over (previous owner was stale)" : "claimed", summary: `plan '${plan.id}' set: ${plan.phases.length} phases, ${steps} steps, ${pats} paths` };
    }

    if (!isOwner(docId, ctx.sessionId)) return notOwner(docId, "Command state");
    const state = readState(docId);
    const issues = r.issues;
    if (!state.plan) {
        issues.add("op", "unknown_id", "there is no plan yet", `call command_plan {op:"set"} first`);
        return issues.result();
    }

    if (op === "phase") {
        const phaseId = r.id(input.phaseId, "phaseId");
        const status = r.enumOf(input.status, "status", PHASE_STATUS);
        const phase = phaseId && findPhase(state.plan, phaseId);
        if (phaseId && !phase) issues.add("phaseId", "unknown_id", `no phase "${phaseId}"`, phaseIdsHint(state.plan));
        let frontIds;
        if (input.frontIds !== undefined) {
            frontIds = (r.arr(input.frontIds, "frontIds") ?? []).map((f, i) => r.id(f, `frontIds[${i}]`)).filter(Boolean);
            frontIds.forEach((f, i) => state.fronts.some((x) => x.id === f) || issues.add(`frontIds[${i}]`, "unknown_id", `no front "${f}"`, frontIdsHint(state.fronts)));
        }
        let commit;
        if (input.commit !== undefined) {
            if (status !== "done") issues.add("commit", "type", "commit is only meaningful with status \"done\"");
            commit = await resolveCommit(repo.path, input.commit);
            if (!commit) issues.add("commit", "ref_unresolvable", `cannot resolve ${JSON.stringify(input.commit)}`, "pass the sha you committed at this checkpoint");
        }
        if (!issues.ok) return issues.result();
        // A done phase must carry a real, attributable checkpoint: resolve or create it BEFORE persisting anything.
        let checkpoint = null;
        if (status === "done") {
            const fronts = frontIds ?? phase.state.frontIds ?? [];
            const frontId = fronts.find((f) => state.fronts.some((x) => x.id === f));
            if (!frontId) {
                issues.add("frontIds", "required", `phase "${phaseId}" has no front to attribute its checkpoint to`, `pass frontIds (${frontIdsHint(state.fronts)})`);
                return issues.result();
            }
            if (commit) checkpoint = { source: "commit", sha: commit, frontId };
            else {
                const front = state.fronts.find((f) => f.id === frontId);
                const ref = refFor(docId, phaseId);
                try {
                    const snap = await snapshotWorktree(front.worktree, { message: `whiteboard checkpoint ${state.plan.id}/${phaseId}`, ref });
                    checkpoint = { source: "snapshot", sha: snap.sha, frontId, ref };
                } catch (e) {
                    issues.add("commit", "ref_unresolvable", `could not snapshot ${front.worktree}: ${e.message}`, "commit at the checkpoint and pass commit, or retry");
                    return issues.result();
                }
            }
        }
        const next = writeState(docId, (s) => {
            const ph = findPhase(s.plan, phaseId);
            const fronts = frontIds ?? ph.state.frontIds ?? [];
            if (status === "pending") ph.state = { status: "pending" };
            else if (status === "active") ph.state = { status: "active", since: ph.state.status === "active" ? ph.state.since : now(), frontIds: fronts };
            else ph.state = { status: "done", since: now(), frontIds: fronts, checkpoint };
            s.plan.revision++;
        });
        for (const f of next.fronts) nudge(docId, f.id);
        return { ok: true, revision: next.revision, summary: `phase '${phaseId}' → ${status}${checkpoint ? ` @ ${checkpoint.sha.slice(0, 8)} (${checkpoint.source})` : ""}` };
    }

    // op === "step"
    const stepId = r.id(input.stepId, "stepId");
    const status = r.enumOf(input.status, "status", PHASE_STATUS);
    const hit = stepId && findStep(state.plan, stepId);
    if (stepId && !hit) issues.add("stepId", "unknown_id", `no step "${stepId}"`, stepIdsHint(state.plan));
    let frontId;
    if (input.frontId !== undefined) {
        frontId = r.id(input.frontId, "frontId");
        if (frontId && !state.fronts.some((f) => f.id === frontId)) issues.add("frontId", "unknown_id", `no front "${frontId}"`, frontIdsHint(state.fronts));
    }
    if (!issues.ok) return issues.result();
    const next = writeState(docId, (s) => {
        const { step } = findStep(s.plan, stepId);
        const fid = frontId ?? step.state.frontId;
        step.state = status === "pending" ? { status } : { status, since: now(), ...(fid ? { frontId: fid } : {}) };
        s.plan.revision++;
    });
    return { ok: true, revision: next.revision, summary: `step '${stepId}' → ${status}` };
}

// ---------- command_front ----------
export async function commandFront(input, ctx) {
    const r = new Reader(new Issues());
    const op = r.enumOf(input.op, "op", ["register", "status", "remove", "list"]);
    if (!r.issues.ok) return r.issues.result();
    const { docId, repo } = ctx;
    if (op === "list") return { ok: true, fronts: readState(docId).fronts };
    if (!isOwner(docId, ctx.sessionId)) return notOwner(docId, "Command state");
    const state = readState(docId);
    const issues = r.issues;

    if (op === "register") {
        const id = r.id(input.id, "id");
        const label = r.str(input.label, "label", { max: 60 });
        const worktree = r.str(input.worktree, "worktree", { max: 1000 });
        const sessionId = r.str(input.sessionId, "sessionId", { required: false, max: 200 });
        let top = null;
        if (worktree) {
            if (!isAbsolute(worktree)) issues.add("worktree", "format", "worktree must be an absolute path");
            else if (!existsSync(worktree) || !statSync(worktree).isDirectory()) issues.add("worktree", "worktree_not_repo", `no such directory: ${worktree}`);
            else {
                top = await topLevel(worktree);
                if (!top) issues.add("worktree", "worktree_not_repo", `${worktree} is not inside a git worktree`);
                else {
                    const [mine, theirs] = await Promise.all([commonDir(repo.path), commonDir(top)]);
                    if (!mine || !theirs || !samePath(mine, theirs)) issues.add("worktree", "worktree_other_repo", `${top} belongs to a different repository than this whiteboard (${repo.path})`, "register a worktree created from this repository (git worktree add)");
                }
            }
        }
        const existing = id && state.fronts.find((f) => f.id === id);
        if (top && issues.ok) {
            const dup = state.fronts.find((f) => samePath(f.worktree, top) && f.id !== id);
            if (dup) issues.add("worktree", "duplicate_worktree", `${top} is already registered as front "${dup.id}"`, `edits can't be told apart in one worktree; register it once and name it for both, or remove "${dup.id}" first`);
            if (existing && !samePath(existing.worktree, top)) issues.add("id", "duplicate_id", `front "${id}" is already registered for ${existing.worktree}`, `choose another id, or remove "${id}" first`);
        }
        if (!existing && state.fronts.length >= LIMITS.fronts) issues.add("id", "too_many", `at most ${LIMITS.fronts} fronts`);
        if (!issues.ok) return issues.result();
        const next = writeState(docId, (s) => {
            const f = s.fronts.find((x) => x.id === id);
            if (f) Object.assign(f, { label, sessionId: sessionId ?? f.sessionId });
            else {
                const used = new Set(s.fronts.map((x) => x.color));
                const color = [...Array(FRONT_COLORS).keys()].find((c) => !used.has(c)) ?? s.fronts.length % FRONT_COLORS;
                // sinceSeq starts a new incarnation: a re-used id never inherits an earlier registration's baseline.
                s.fronts.push({ id, label, worktree: top, ...(sessionId ? { sessionId } : {}), color, status: "active", registeredAt: now(), sinceSeq: lastSeq(docId) });
            }
        });
        if (next.plan) startPolling(docId, next.fronts.find((f) => f.id === id));
        return { ok: true, revision: next.revision, summary: `front '${id}' ${existing ? "updated" : "registered"} at ${top}${next.plan ? "; polling" : "; polling starts once a plan is set"}` };
    }

    const id = r.id(input.id, "id");
    const front = id && state.fronts.find((f) => f.id === id);
    if (id && !front) issues.add("id", "unknown_id", `no front "${id}"`, frontIdsHint(state.fronts));

    if (op === "status") {
        const status = r.enumOf(input.status, "status", FRONT_STATUS);
        const note = r.str(input.note, "note", { required: false, max: 240 });
        if (!issues.ok) return issues.result();
        const next = writeState(docId, (s) => {
            const f = s.fronts.find((x) => x.id === id);
            f.status = status;
            f.statusSince = now();
            if (note) f.note = note;
            else delete f.note;
        });
        nudge(docId, id);
        return { ok: true, revision: next.revision, summary: `front '${id}' → ${status}${note ? ` (${note})` : ""}` };
    }

    // remove
    if (!issues.ok) return issues.result();
    stopPolling(docId, id);
    // Its files leave the map: close every live file with a zero "baseline" marker (not churn).
    const at = now();
    const clears = currentFiles(docId)
        .filter((e) => e.frontId === id)
        .map((e) => ({ at, frontId: id, file: e.file, kind: "modified", delta: { add: 0, del: 0 }, netDelta: 0, totals: { add: 0, del: 0 }, offPlan: false, phaseIds: [], baseline: true }));
    if (clears.length) appendEvents(docId, clears);
    const next = writeState(docId, (s) => {
        s.fronts = s.fronts.filter((f) => f.id !== id);
        // Referential integrity: no phase or step (in any status) keeps pointing at the removed front.
        for (const ph of s.plan?.phases ?? []) {
            if (ph.state.frontIds) ph.state.frontIds = ph.state.frontIds.filter((f) => f !== id);
            for (const st of ph.steps) if (st.state.frontId === id) delete st.state.frontId;
        }
    });
    return { ok: true, revision: next.revision, summary: `front '${id}' removed (its change history is kept)` };
}

// ---------- command_status ----------
export async function commandStatus(input, ctx) {
    const r = new Reader(new Issues());
    const status = r.enumOf(input.status, "status", MISSION_STATUS);
    const prompt = r.str(input.prompt, "prompt", { required: false, max: 400 });
    if (prompt !== undefined && status && status !== "awaiting_operator") r.issues.add("prompt", "type", "prompt is only meaningful with status \"awaiting_operator\"");
    if (!r.issues.ok) return r.issues.result();
    if (!isOwner(ctx.docId, ctx.sessionId)) return notOwner(ctx.docId, "Command state");
    const next = writeState(ctx.docId, (s) => {
        s.reportedMission = { status, source: "reported", since: now(), ...(prompt ? { prompt } : {}) };
        if (s.mission?.source !== "runtime") s.mission = s.reportedMission;
    });
    return { ok: true, revision: next.revision, summary: `mission reported as ${status}` };
}

// ---------- command_read ----------
/** Current per-front, per-file totals (latest observation), from the log. */
export function currentFiles(docId) {
    const m = new Map(); // `${front}\0${file}` -> event
    for (const e of eventsSince(docId, 0)) m.set(`${e.frontId}\0${e.file}`, e);
    return [...m.values()].filter(isPresentChange);
}

export function stats(docId, { windowMs = 5 * 60_000, at = Date.now() } = {}) {
    const state = readState(docId);
    const files = currentFiles(docId);
    const since = at - windowMs;
    const recent = eventsSince(docId, 0).filter((e) => !e.initial && Date.parse(e.at) >= since && Date.parse(e.at) <= at);
    const perMin = (n) => Math.round((n / (windowMs / 60_000)) * 10) / 10;
    const fronts = state.fronts.map((f) => {
        const mine = files.filter((e) => e.frontId === f.id);
        const off = offPlanMatcher(state.plan, f.id);
        return { id: f.id, status: f.status, add: mine.reduce((n, e) => n + e.totals.add, 0), del: mine.reduce((n, e) => n + e.totals.del, 0), files: mine.length, offPlan: mine.filter((e) => off(e.file)).map((e) => e.file) };
    });
    return {
        windowMinutes: windowMs / 60_000,
        churnPerMin: perMin(recent.reduce((n, e) => n + e.delta.add + e.delta.del, 0)),
        netPerMin: perMin(recent.reduce((n, e) => n + (e.netDelta ?? 0), 0)),
        filesPerMin: perMin(new Set(recent.map((e) => e.file)).size),
        eventsPerMin: perMin(recent.length),
        fronts,
        offPlan: fronts.reduce((n, f) => n + f.offPlan.length, 0),
    };
}

export async function commandRead(input, ctx) {
    const r = new Reader(new Issues());
    const all = ["plan", "fronts", "stats", "offplan", "focus", "views", "mission", "walkthrough"];
    const include = input.include === undefined ? all : (r.arr(input.include, "include") ?? []).map((x, i) => r.enumOf(x, `include[${i}]`, all)).filter(Boolean);
    if (!r.issues.ok) return r.issues.result();
    const state = readState(ctx.docId);
    const out = { ok: true, revision: state.revision, lease: readLease(ctx.docId) };
    if (include.includes("plan")) out.plan = state.plan;
    if (include.includes("fronts")) out.fronts = state.fronts;
    if (include.includes("mission")) out.mission = state.mission;
    if (include.includes("views")) out.views = state.views;
    const st = include.some((x) => x === "stats" || x === "offplan") ? stats(ctx.docId) : null;
    if (include.includes("stats")) out.stats = { ...st, fronts: st.fronts.map(({ offPlan, ...f }) => ({ ...f, offPlan: offPlan.length })) };
    if (include.includes("offplan")) out.offplan = Object.fromEntries(st.fronts.map((f) => [f.id, f.offPlan]));
    if (include.includes("focus")) {
        // What the user is pointing at: chat focus chips (sent with their last Command chat message) + the stop on screen.
        const p = readPrefs(ctx.docId);
        out.focus = { ...(p.focus ?? { items: [] }), ...(p.walkthroughStop ? { viewingStop: p.walkthroughStop } : {}) };
    }
    if (include.includes("walkthrough")) {
        const v = state.walkthroughView;
        out.walkthrough = v ? { view: v, current: state.walkthroughs.find((w) => w.id === v.id) ?? null } : null;
        out.walkthroughs = state.walkthroughs.map((w) => ({ id: w.id, title: w.title, revision: w.revision, stops: w.stops.length, labels: w.labels }));
    }
    return out;
}

export const ACTIONS = { command_plan: commandPlan, command_front: commandFront, command_status: commandStatus, command_read: commandRead, command_view: commandView, command_diff: commandDiff, command_walkthrough: commandWalkthrough };

// ---------- command_view ----------
export async function commandView(input, ctx) {
    const r = new Reader(new Issues());
    const op = r.enumOf(input.op, "op", ["set", "remove", "apply", "list"]);
    if (!r.issues.ok) return r.issues.result();
    const state = readState(ctx.docId);
    if (op === "list") return { ok: true, views: state.views, suggested: (state.plan?.phases ?? []).filter((p) => p.suggestedView).map((p) => ({ phaseId: p.id, view: p.suggestedView })) };
    if (!isOwner(ctx.docId, ctx.sessionId)) return notOwner(ctx.docId, "Command state");
    const issues = r.issues;
    if (op === "set") {
        const view = parseViewSpec(r, input.view, "view");
        let phaseId;
        if (input.phaseId !== undefined) {
            phaseId = r.id(input.phaseId, "phaseId");
            if (phaseId && !findPhase(state.plan, phaseId)) issues.add("phaseId", "unknown_id", `no phase "${phaseId}"`, phaseIdsHint(state.plan));
        }
        if (!issues.ok) return issues.result();
        if (!state.views.some((v) => v.id === view.id) && state.views.length >= LIMITS.views) {
            issues.add("view.id", "too_many", `at most ${LIMITS.views} views`);
            return issues.result();
        }
        const next = writeState(ctx.docId, (s) => {
            const v = { ...view, origin: "agent", ...(phaseId ? { phaseId } : {}) };
            s.views = [...s.views.filter((x) => x.id !== view.id), v];
            if (phaseId) findPhase(s.plan, phaseId).suggestedView = view;
        });
        return { ok: true, revision: next.revision, summary: `view '${view.id}' saved${phaseId ? ` as phase '${phaseId}' suggestion` : ""}` };
    }
    const id = r.id(input.id, "id");
    const known = [...state.views.map((v) => v.id), ...(state.plan?.phases ?? []).filter((p) => p.suggestedView).map((p) => p.suggestedView.id)];
    if (id && !known.includes(id)) issues.add("id", "unknown_id", `no view "${id}"`, listHint("view ids", known));
    if (!issues.ok) return issues.result();
    if (op === "remove") {
        const next = writeState(ctx.docId, (s) => {
            s.views = s.views.filter((v) => v.id !== id);
            for (const ph of s.plan?.phases ?? []) if (ph.suggestedView?.id === id) delete ph.suggestedView;
        });
        return { ok: true, revision: next.revision, summary: `view '${id}' removed` };
    }
    // apply: an explicit request (usually chat-initiated) always applies, regardless of the follow toggle.
    const next = writeState(ctx.docId, (s) => {
        s.applyRequest = { id, at: now(), seq: (s.applyRequest?.seq ?? 0) + 1 };
    });
    return { ok: true, revision: next.revision, summary: `view '${id}' applied` };
}
