// Command center wiring: canvas action declarations (loose input schemas so our validator owns every issue),
// lease re-adoption after reloads, and the document/repository context each handler needs.
import { readdirSync } from "node:fs";

import { getRepository } from "../git.mjs";
import { paths } from "../paths.mjs";
import * as store from "../store.mjs";
import { ACTIONS } from "./actions.mjs";
import { Issues } from "./issues.mjs";
import { adoptIfMine, heldHere, isOwner, readLease, stopHeartbeat } from "./owner.mjs";
import { reduceMission, tickMission } from "./mission.mjs";
import { startPolling, stopAll } from "./poller.mjs";
import { dropRefs } from "./snapshot.mjs";
import { readState, unwatchCommand, writeState } from "./state.mjs";

const OPS = {
    command_plan: ["set", "phase", "step", "read"],
    command_front: ["register", "status", "remove", "list"],
    command_view: ["set", "remove", "apply", "list"],
};

const DESCRIPTIONS = {
    command_plan: 'Command center plan. op "set" {plan:{id,title,base?,phases:[{id,title,expects[],steps:[{id,title,expects[]}],suggestedView?}]}} replaces the plan atomically and claims this whiteboard\'s Command lease for your session; "phase" {phaseId,status:pending|active|done,frontIds?,commit?}; "step" {stepId,status,frontId?}; "read". Invalid input returns {ok:false, issues[]} and changes nothing. See instructions topic "command".',
    command_front: 'Command center fronts (one per worktree a session edits). op "register" {id,label,worktree(absolute),sessionId?} starts polling that worktree; "status" {id,status:active|blocked|done,note?}; "remove" {id}; "list". Never report individual edits: the canvas observes worktrees.',
    command_status: "Report mission status {status:working|awaiting_operator|complete, prompt?} when the runtime cannot infer it.",
    command_read: 'Read what the Command tab shows: {include?:["plan","fronts","stats","offplan","focus","views","mission"]}.',
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
                issues.add("documentId", "required", e.message, "pass documentId, or show a whiteboard in this panel");
                return issues.result();
            }
            const doc = store.hasDoc(docId) ? store.getDoc(docId) : null;
            if (!doc?.target) {
                const issues = new Issues();
                issues.add("documentId", doc ? "type" : "unknown_id", doc ? `whiteboard ${docId} has no repository target (the scratchpad can't host a Command center)` : `no whiteboard ${docId}`, "create a whiteboard with a target first");
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
export function attachMission(session) {
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
        } catch {}
    });
    const t = setInterval(() => apply((m) => tickMission(m)), 5000);
    t.unref();
    return () => {
        off?.();
        clearInterval(t);
    };
}

// Deleting a whiteboard stops its pollers, heartbeat and watcher first (Windows keeps watched dirs busy).
store.beforeRemove.push(async (docId) => {
    stopAll(docId);
    stopHeartbeat(docId);
    unwatchCommand(docId);
    for (const fn of cleanupHooks) await fn(docId);
});
/** Extra per-document cleanup run before deletion. Checkpoint refs go with the whiteboard. */
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
        dirs = readdirSync(paths.whiteboards, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
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
