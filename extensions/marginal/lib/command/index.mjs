// Command center wiring: canvas action declarations (loose input schemas so our validator owns every issue),
// lease re-adoption after reloads, and the document/repository context each handler needs.
import { readdirSync } from "node:fs";

import { getRepository } from "../git.mjs";
import { paths } from "../paths.mjs";
import * as store from "../store.mjs";
import { ACTIONS } from "./actions.mjs";
import { Issues } from "./issues.mjs";
import { adoptIfMine, heldHere, isOwner, readLease, stopHeartbeat } from "./owner.mjs";
import { ACTIVITY_MAX, activityOf, reduceMission, tickMission } from "./mission.mjs";
import { startPolling, stopAll } from "./poller.mjs";
import { dropRefs } from "./snapshot.mjs";
import { emitCommand, readState, unwatchCommand, writeState } from "./state.mjs";

const OPS = {
    command_plan: ["set", "phase", "step", "read"],
    command_front: ["register", "status", "remove", "list"],
    command_view: ["set", "remove", "apply", "list"],
    command_walkthrough: ["show", "edit", "close", "read"],
};

const DESCRIPTIONS = {
    command_plan: 'Command center plan. op "set" {plan:{id,title,base?,phases:[{id,title,expects[],steps:[{id,title,expects[]}],suggestedView?}]}} replaces the plan atomically and claims this doc\'s Command lease for your session; "phase" {phaseId,status:pending|active|done,frontIds?,commit?}; "step" {stepId,status,frontId?}; "read". Invalid input returns {ok:false, issues[]} and changes nothing. See instructions topic "command".',
    command_front: 'Command center fronts (one per worktree a session edits). op "register" {id,label,worktree(absolute),sessionId?} starts polling that worktree; "status" {id,status:active|blocked|done,note?}; "remove" {id}; "list". Never report individual edits: the canvas observes worktrees.',
    command_status: "Report mission status {status:working|awaiting_operator|complete, prompt?} when the runtime cannot infer it.",
    command_read: 'Read what the Command tab shows: {include?:["plan","fronts","stats","offplan","focus","views","mission","walkthrough"]}. "focus" is what the user pointed at in the Command chat (paths, fronts, phases, stops, code ranges) and the walkthrough stop on screen.',
    command_diff: 'Diff between two checkpoints (authoring aid for walkthroughs): {from, to, format?:"files"|"patch", paths?[], context?, maxBytes?}. A checkpoint ref is {phaseId} (a done phase), {ref:"base"} (plan base), {ref:"live",frontId} (a snapshot of that worktree now) or {sha}.',
    command_walkthrough: 'Checkpoint walkthrough pop-up over the Command map. op "show" {walkthrough:{id,title,from,to,stops:[{id,title,explanation(markdown),category?:feature|refactor|test|fix|risk|chore,ranges:[{file,side?:"head"|"base",startLine,endLine}],focus?}]}} (from/to are checkpoint refs as in command_diff; every range must be in that diff); "edit" {id, baseRevision, edits:[{op:"update_stop",stopId,stop:{…partial}} | {op:"insert_stop",afterId?,stop} | {op:"remove_stop",stopId} | {op:"focus_stop",stopId}]} revises in place (prefer it for follow-up questions); "close" {id}; "read" {id?}. Rejections return issues and show "agent is revising…" in the pop-up.',
    command_view: 'Command map layouts. op "set" {view:{id,title,root?,pins?[],monitors?[{path,mode?:"diff-feed"|"files"}],filters?{offPlanOnly?,frontIds?,hideTests?}}, phaseId?} (with phaseId it becomes that phase\'s suggestion, auto-applied on activation while the user follows); "apply" {id} applies now; "remove" {id}; "list".',
};

/** Build canvas actions. `resolveDoc(input, ctx)` returns a document id (throws InputError when none is shown). */
export function commandActions({ resolveDoc, getSessionId, extraContext = () => ({}) }) {
    return Object.entries(ACTIONS).map(([name, handler]) => ({
        name,
        description: DESCRIPTIONS[name],
        // Deliberately loose: the runtime's schema check would otherwise pre-empt the structured Issue contract.
        inputSchema: { type: "object", properties: { documentId: { type: "string" }, ...(OPS[name] ? { op: { type: "string", description: OPS[name].join(" | ") } } : {}) } },
        handler: async (cctx) => {
            const input = cctx.input ?? {};
            let docId;
            try {
                docId = resolveDoc(input, cctx);
            } catch (e) {
                const issues = new Issues();
                issues.add("documentId", "required", e.message, "pass documentId, or show a doc in this panel");
                return issues.result();
            }
            const doc = store.hasDoc(docId) ? store.getDoc(docId) : null;
            if (!doc?.target) {
                const issues = new Issues();
                issues.add("documentId", doc ? "type" : "unknown_id", doc ? `doc ${docId} has no repository target (the scratchpad can't host a Command center)` : `no doc ${docId}`, "create a doc with a target first");
                return issues.result();
            }
            const repo = getRepository(doc.target.repositoryId);
            return handler(input, { docId, doc, repo, sessionId: getSessionId() ?? cctx.sessionId, ...extraContext(docId) });
        },
    }));
}

/** After an extension reload, re-adopt leases this session owns and restart their pollers. */
export function adoptLeases(sessionId) {
    return adoptLeasesInner(sessionId);
}

/**
 * Feed this session's events into the mission lamp of every document it owns (the orchestrator's runtime state).
 * Writes only on change; an idle-hold ticker promotes a lingering idle to "awaiting operator".
 */
/** In-memory activity lane of this (owner) process; panels fetch it via /api/command/activity and get SSE deltas. */
export const activity = [];

export function attachMission(session, { isChatTurn = () => false } = {}) {
    const apply = (fn) => {
        for (const docId of heldHere()) {
            if (!isOwner(docId, session.sessionId)) continue;
            const st = readState(docId);
            const allDone = () => !!st.plan && st.plan.phases.every((p) => p.state.status === "done") && st.fronts.every((f) => f.status === "done");
            const next = fn(st.mission?.source === "runtime" ? st.mission : null, allDone);
            if (next && next !== st.mission && JSON.stringify(next) !== JSON.stringify(st.mission))
                writeState(docId, (s) => {
                    s.mission = next;
                });
        }
    };
    const off = session.on((ev) => {
        try {
            apply((m, allDone) => reduceMission(m, ev, { allDone }));
            const item = activityOf(ev, { isChatTurn });
            if (item) {
                activity.push(item);
                if (activity.length > ACTIVITY_MAX) activity.shift();
                for (const docId of heldHere()) emitCommand({ documentId: docId, kind: "activity", item });
            }
        } catch {}
    });
    const t = setInterval(() => apply((m) => tickMission(m)), 5000);
    t.unref();
    return () => {
        off?.();
        clearInterval(t);
    };
}

// Deleting a doc stops its pollers, heartbeat and watcher first (Windows keeps watched dirs busy).
store.beforeRemove.push(async (docId) => {
    stopAll(docId);
    stopHeartbeat(docId);
    unwatchCommand(docId);
    for (const fn of cleanupHooks) await fn(docId);
});
/** Extra per-document cleanup run before deletion. Checkpoint refs go with the doc. */
export const cleanupHooks = [
    async (docId) => {
        try {
            const repoId = store.getDoc(docId)?.target?.repositoryId;
            if (repoId) await dropRefs(getRepository(repoId).path, docId);
        } catch {}
    },
];

function adoptLeasesInner(sessionId) {
    let dirs = [];
    try {
        dirs = readdirSync(paths.docs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {}
    const adopted = [];
    for (const docId of dirs) {
        if (readLease(docId)?.sessionId !== sessionId) continue;
        if (!adoptIfMine(docId, sessionId)) continue;
        const st = readState(docId);
        if (st.plan) for (const f of st.fronts) startPolling(docId, f);
        adopted.push(docId);
    }
    return adopted;
}
