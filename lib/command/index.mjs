// Command center wiring: canvas action declarations (loose input schemas so our validator owns every issue),
// lease re-adoption after reloads, and the document/repository context each handler needs.
import { readdirSync } from "node:fs";

import { getRepository } from "../git.mjs";
import { paths } from "../paths.mjs";
import * as store from "../store.mjs";
import { ACTIONS } from "./actions.mjs";
import { Issues } from "./issues.mjs";
import { adoptIfMine, readLease, stopHeartbeat } from "./owner.mjs";
import { startPolling, stopAll } from "./poller.mjs";
import { readState, unwatchCommand } from "./state.mjs";

const OPS = {
    command_plan: ["set", "phase", "step", "read"],
    command_front: ["register", "status", "remove", "list"],
};

const DESCRIPTIONS = {
    command_plan: 'Command center plan. op "set" {plan:{id,title,base?,phases:[{id,title,expects[],steps:[{id,title,expects[]}],suggestedView?}]}} replaces the plan atomically and claims this whiteboard\'s Command lease for your session; "phase" {phaseId,status:pending|active|done,frontIds?,commit?}; "step" {stepId,status,frontId?}; "read". Invalid input returns {ok:false, issues[]} and changes nothing. See instructions topic "command".',
    command_front: 'Command center fronts (one per worktree a session edits). op "register" {id,label,worktree(absolute),sessionId?} starts polling that worktree; "status" {id,status:active|blocked|done,note?}; "remove" {id}; "list". Never report individual edits: the canvas observes worktrees.',
    command_status: "Report mission status {status:working|awaiting_operator|complete, prompt?} when the runtime cannot infer it.",
    command_read: 'Read what the Command tab shows: {include?:["plan","fronts","stats","offplan","focus","views","mission"]}.',
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

// Deleting a whiteboard stops its pollers, heartbeat and watcher first (Windows keeps watched dirs busy).
store.beforeRemove.push(async (docId) => {
    stopAll(docId);
    stopHeartbeat(docId);
    unwatchCommand(docId);
    for (const fn of cleanupHooks) await fn(docId);
});
/** Later milestones add cleanup (e.g. checkpoint refs). */
export const cleanupHooks = [];

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
