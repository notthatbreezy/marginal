// Mission lamp from the orchestrator's own session events (the extension only sees its joined session).
// Explicit events only (D9): no text sniffing of assistant messages.
//   working           assistant.turn_start / tool.execution_start
//   awaiting_operator user_input / exit_plan_mode / elicitation / permission ".requested" (+ prompt), until ".completed"
//   complete          session.task_complete, or idle with every phase and front done
//   idle otherwise    hold "working" 30 s, then awaiting_operator (the orchestrator stopped and is waiting on the user)

export const IDLE_HOLD_MS = 30_000;
const ASK = ["user_input.requested", "exit_plan_mode.requested", "elicitation.requested", "permission.requested"];
const ANSWER = ["user_input.completed", "exit_plan_mode.completed", "elicitation.completed", "permission.completed"];

function promptOf(ev) {
    const d = ev.data ?? {};
    return d.question ?? d.summary ?? d.message ?? (ev.type === "permission.requested" ? "Permission requested" : undefined);
}

/**
 * Pure reducer: (mission, event, ctx) → mission. ctx: { now, allDone(): boolean }.
 * Returns the same object when nothing changes, so callers can skip writes.
 */
export function reduceMission(m, ev, { now = Date.now(), allDone = () => false } = {}) {
    const since = new Date(now).toISOString();
    const set = (next) => (m && m.status === next.status && m.prompt === next.prompt && m.source === "runtime" ? m : { source: "runtime", since, ...next });
    if (ev.data?.parentToolCallId || ev.agentId) return m; // subagent chatter
    if (ASK.includes(ev.type)) return set({ status: "awaiting_operator", prompt: promptOf(ev), pending: ev.data?.requestId ?? true });
    if (ANSWER.includes(ev.type)) return set({ status: "working" });
    if (ev.type === "session.task_complete") return ev.data?.success === false ? set({ status: "awaiting_operator", prompt: ev.data?.summary ?? ev.data?.reason }) : set({ status: "complete" });
    if (ev.type === "assistant.turn_start" || ev.type === "tool.execution_start" || ev.type === "user.message") {
        if (m?.status === "awaiting_operator" && m.pending) return m; // still waiting on an answer
        return set({ status: "working" });
    }
    if (ev.type === "session.idle") {
        if (m?.status === "awaiting_operator" && m.pending) return m;
        if (allDone()) return set({ status: "complete" });
        return { ...(m ?? { status: "working" }), source: "runtime", idleSince: since };
    }
    return m;
}

/** Idle hold: an idle orchestrator that stays idle becomes "awaiting operator". */
export function tickMission(m, now = Date.now()) {
    if (m?.idleSince && m.status === "working" && now - Date.parse(m.idleSince) >= IDLE_HOLD_MS) return { status: "awaiting_operator", source: "runtime", since: new Date(now).toISOString(), prompt: "The orchestrator is idle" };
    return m;
}

// ---------- orchestrator activity feed (spec §7.9) ----------
// Root-session assistant messages (first line) and tool starts, excluding turns that answer a Command/side chat.
export const ACTIVITY_MAX = 50;
const QUIET_TOOLS = new Set(["report_intent", "think", "sql", "read_agent", "list_agents", "read_powershell"]);

/** Pure: event → activity item or null. */
export function activityOf(ev, { isChatTurn = () => false, now = Date.now() } = {}) {
    const d = ev.data ?? {};
    if (d.parentToolCallId || ev.agentId || isChatTurn()) return null;
    const at = new Date(now).toISOString();
    if (ev.type === "assistant.message") {
        const line = String(d.content ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        return line ? { at, kind: "message", text: line.replace(/[*_`#>]+/g, "").slice(0, 160) } : null;
    }
    if (ev.type === "tool.execution_start") {
        const name = d.toolName ?? "";
        if (!name || QUIET_TOOLS.has(name)) return null;
        const a = d.arguments ?? {};
        const what = a.description ?? a.intent ?? a.path ?? a.pattern ?? a.name ?? a.actionName ?? "";
        return { at, kind: "tool", text: `${name.replace(/[-_]/g, " ")}${what ? ` · ${String(what).slice(0, 100)}` : ""}` };
    }
    return null;
}