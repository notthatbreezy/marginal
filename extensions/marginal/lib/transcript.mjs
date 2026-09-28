// The session's conversation as the Marginal chat shows it: one transcript for every tab, doc and panel, like the
// Copilot app's own chat. Built from the session's events (live) and its persisted event log (history, paged backward).
//
// Items (all carry id and at):
//   user      {text, source: "marginal"|"app"|"session", context?, delivery?}   a message from anywhere
//   reply     {text, streaming?}                                               the main agent's text
//   activity  {tools: {label: count}, recent: string[], helpers: [{id,name,status}], done}   what it did between replies
//   question  {question, choices, allowFreeform, requestId?, answerable, status: pending|answered, answer?}
//   plan      {summary, planContent, actions, recommendedAction, requestId?, answerable, status, approved?, feedback?}
// Questions and plan approvals are ephemeral events: only the live process knows their requestId, so ones seen only in
// history (an ask_user tool call) are shown but answered in the app.

export const LIVE_MAX = 400;
const TEXT_MAX = 20_000;

/** Event types the history read asks for (everything else is skipped by the runtime). */
export const HISTORY_TYPES = ["user.message", "assistant.message", "tool.execution_start", "tool.execution_complete", "subagent.started", "subagent.completed", "subagent.failed"];

// Tool name → the phrase it counts toward ("Read 3 files").
const TOOL_KIND = {
    view: "read", grep: "search", glob: "search", lsp: "search",
    edit: "edit", create: "edit", apply_patch: "edit",
    powershell: "run", bash: "run", read_powershell: null, read_bash: null, stop_powershell: null, stop_bash: null,
    web_fetch: "web", web_search: "web",
    invoke_canvas_action: "canvas", open_canvas: "canvas", marginal: "canvas",
    task: null, read_agent: null, write_agent: null, list_agents: null,
    report_intent: null, think: null, sql: "todo", ask_user: null, task_complete: null,
};
const KIND_LABEL = { read: ["Read", "file", "files"], search: ["Searched", "time", "times"], edit: ["Edited", "file", "files"], run: ["Ran", "command", "commands"], web: ["Looked up", "page", "pages"], canvas: ["Updated", "canvas", "canvases"], todo: ["Updated the todo list", "", ""], other: ["Used", "tool", "tools"] };

/** "Read 3 files · edited 1 file · ran 2 commands" */
export function activitySummary(tools) {
    const parts = Object.entries(tools).map(([k, n]) => {
        const [verb, one, many] = KIND_LABEL[k] ?? KIND_LABEL.other;
        return k === "todo" ? verb : `${verb} ${n} ${n === 1 ? one : many}`;
    });
    return parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(" · ");
}

const MARGINAL_TAG = /^(?:<current_datetime>[^<]*<\/current_datetime>\s*)?\[(?:Marginal side-chat|Command center chat|Command center: initialize)/;
// The last paragraph of a Marginal message's display text says where it was asked from.
const CONTEXT_LINE = /^(?:On doc “|From the doc|Command chat on “|Command center on “)/;

function parseArgs(a) {
    if (a && typeof a === "object") return a;
    try {
        return JSON.parse(a);
    } catch {
        return {};
    }
}
function toolLabel(name, args) {
    const a = parseArgs(args);
    const what = a.description ?? a.intent ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.action ?? a.actionName ?? "";
    return `${name.replace(/[-_]/g, " ")}${what ? ` · ${String(what).replace(/\s+/g, " ").slice(0, 90)}` : ""}`;
}

export function createState() {
    return { items: [], byId: new Map(), activity: null, status: "idle", tools: new Map() };
}

function put(s, item, changed) {
    if (!s.byId.has(item.id)) {
        s.items.push(item);
        s.byId.set(item.id, item);
    }
    changed.add(item.id);
    return item;
}

/**
 * Apply one event. Returns the ids of the items it added or changed (and "status" when the working state changed).
 * Deltas are returned as {delta:{id, text}} so a live stream can send just the new text.
 */
export function reduce(s, ev) {
    const changed = new Set();
    // What the agent did since its last text ends when something else is said (or asked).
    const closeActivity = () => {
        if (s.activity && !s.activity.done) {
            s.activity.done = true;
            changed.add(s.activity.id);
        }
        s.activity = null;
    };
    const d = ev?.data ?? {};
    const at = ev?.timestamp ?? new Date().toISOString();
    const setStatus = (v) => {
        if (s.status !== v) {
            s.status = v;
            changed.add("status");
        }
    };
    // Helpers' own conversation stays out; their start and end are shown on the orchestrator's activity line.
    const helper = !!(ev?.agentId || d.parentToolCallId) && !ev?.type?.startsWith("subagent.");
    if (helper) return { changed };
    switch (ev?.type) {
        case "user.message": {
            if (d.isAutopilotContinuation) break;
            const content = String(d.content ?? "");
            if (!content.trim() || /^\s*<system_notification>/.test(content)) break;
            const marginal = MARGINAL_TAG.test(String(d.transformedContent ?? ""));
            let text = content;
            let context;
            if (marginal) {
                const paras = content.split(/\n\n/);
                if (paras.length > 1 && CONTEXT_LINE.test(paras.at(-1))) {
                    context = paras.pop();
                    text = paras.join("\n\n");
                }
            }
            const source = marginal ? "marginal" : typeof d.source === "string" && d.source.startsWith("agent-") ? "session" : "app";
            put(s, { kind: "user", id: d.messageId ?? ev.id, at, text: text.slice(0, TEXT_MAX), source, ...(context ? { context } : {}), ...(d.delivery && d.delivery !== "idle" ? { delivery: d.delivery } : {}) }, changed);
            closeActivity();
            setStatus("working");
            break;
        }
        case "assistant.turn_start":
            setStatus("working");
            break;
        case "session.idle":
        case "session.task_complete":
            closeActivity();
            setStatus("idle");
            break;
        case "assistant.message_delta": {
            const id = d.messageId;
            if (!id || !d.deltaContent) break;
            let item = s.byId.get(id);
            if (!item) {
                item = put(s, { kind: "reply", id, at, text: "", streaming: true }, changed);
                closeActivity();
            }
            if (!item.streaming) break;
            item.text = (item.text + d.deltaContent).slice(0, TEXT_MAX);
            return { changed, delta: { id, text: d.deltaContent } };
        }
        case "assistant.message": {
            const id = d.messageId ?? ev.id;
            const text = String(d.content ?? "").trim();
            const existing = s.byId.get(id);
            if (!text) {
                if (existing) {
                    // A streamed preamble that ended up as tool calls only.
                    s.items = s.items.filter((x) => x !== existing);
                    s.byId.delete(id);
                    changed.add(id);
                }
                break;
            }
            const item = existing ?? put(s, { kind: "reply", id, at, text: "" }, changed);
            item.text = text.slice(0, TEXT_MAX);
            delete item.streaming;
            changed.add(id);
            closeActivity();
            break;
        }
        case "tool.execution_start": {
            const name = d.toolName ?? "";
            if (name === "ask_user") {
                const a = parseArgs(d.arguments);
                if (!s.byId.has(d.toolCallId)) put(s, { kind: "question", id: d.toolCallId, at, question: String(a.question ?? "").slice(0, 4000), choices: Array.isArray(a.choices) ? a.choices.map(String).slice(0, 12) : [], allowFreeform: true, answerable: false, status: "pending" }, changed);
                closeActivity();
                break;
            }
            if (!(name in TOOL_KIND) || TOOL_KIND[name] !== null) {
                const kind = TOOL_KIND[name] ?? "other";
                if (!s.activity) s.activity = put(s, { kind: "activity", id: `act-${d.toolCallId ?? ev.id}`, at, tools: {}, recent: [], helpers: [], done: false }, changed);
                const a = s.activity;
                a.tools[kind] = (a.tools[kind] ?? 0) + 1;
                a.recent = [...a.recent, toolLabel(name, d.arguments)].slice(-12);
                changed.add(a.id);
            }
            if (d.toolCallId) s.tools.set(d.toolCallId, name);
            break;
        }
        case "tool.execution_complete": {
            const q = d.toolCallId && s.byId.get(d.toolCallId);
            if (q?.kind === "question" && q.status === "pending") {
                q.status = "answered";
                const r = d.result?.content ?? d.result;
                if (typeof r === "string" && !q.answer) q.answer = r.replace(/^User (selected|responded):\s*/i, "").slice(0, 2000);
                changed.add(q.id);
            }
            break;
        }
        case "subagent.started": {
            if (!s.activity) s.activity = put(s, { kind: "activity", id: `act-${d.toolCallId ?? ev.id}`, at, tools: {}, recent: [], helpers: [], done: false }, changed);
            const a = s.activity;
            if (!a.helpers.some((h) => h.id === d.toolCallId)) a.helpers = [...a.helpers, { id: d.toolCallId, name: String(d.agentDisplayName || d.agentName || "helper").slice(0, 80), status: "running" }].slice(-20);
            changed.add(a.id);
            break;
        }
        case "subagent.completed":
        case "subagent.failed": {
            for (const it of s.items)
                if (it.kind === "activity") {
                    const h = it.helpers.find((x) => x.id === d.toolCallId);
                    if (h) {
                        h.status = ev.type === "subagent.failed" ? "failed" : d.cancelled ? "cancelled" : "done";
                        changed.add(it.id);
                    }
                }
            break;
        }
        case "user_input.requested": {
            const id = (d.toolCallId && s.byId.has(d.toolCallId) && d.toolCallId) || d.requestId;
            const q = s.byId.get(id) ?? put(s, { kind: "question", id, at, question: "", choices: [], status: "pending" }, changed);
            Object.assign(q, { question: String(d.question ?? q.question).slice(0, 4000), choices: Array.isArray(d.choices) ? d.choices.map(String).slice(0, 12) : q.choices, allowFreeform: d.allowFreeform !== false, requestId: d.requestId, answerable: true });
            changed.add(q.id);
            closeActivity();
            setStatus("waiting");
            break;
        }
        case "user_input.completed": {
            const q = s.items.find((x) => x.kind === "question" && x.requestId === d.requestId);
            if (q) {
                Object.assign(q, { status: "answered", answerable: false, ...(d.answer !== undefined ? { answer: String(d.answer).slice(0, 2000) } : {}) });
                changed.add(q.id);
            }
            setStatus("working");
            break;
        }
        case "exit_plan_mode.requested": {
            const p = put(s, { kind: "plan", id: d.requestId, at, summary: String(d.summary ?? "").slice(0, 4000), planContent: String(d.planContent ?? "").slice(0, TEXT_MAX), actions: Array.isArray(d.actions) ? d.actions : [], recommendedAction: d.recommendedAction ?? null, requestId: d.requestId, answerable: true, status: "pending" }, changed);
            changed.add(p.id);
            closeActivity();
            setStatus("waiting");
            break;
        }
        case "exit_plan_mode.completed": {
            const p = s.byId.get(d.requestId);
            if (p) {
                Object.assign(p, { status: "answered", answerable: false, approved: !!d.approved, ...(d.feedback ? { feedback: String(d.feedback).slice(0, 2000) } : {}), ...(d.selectedAction ? { selectedAction: d.selectedAction } : {}) });
                changed.add(p.id);
            }
            setStatus("working");
            break;
        }
    }
    return { changed };
}

/** Items from a batch of persisted events (chronological), as the history read returns them. */
export function itemsFrom(events) {
    const s = createState();
    for (const ev of events) reduce(s, ev);
    // A history page ends where it ends: nothing in it is still streaming or running.
    for (const it of s.items) {
        if (it.kind === "reply") delete it.streaming;
        if (it.kind === "activity") it.done = true;
        if (it.kind === "question" && it.status === "pending") it.answerable = false;
    }
    return s.items;
}

/**
 * The live transcript for a session: reduces its events, keeps the newest LIVE_MAX items, and tells listeners what
 * changed. history() pages the persisted log backward for what came before (or after a reload).
 */
export function createTranscript(getSession, { now = () => Date.now() } = {}) {
    const s = createState();
    const listeners = new Set();
    const emit = (e) => {
        for (const fn of listeners)
            try {
                fn(e);
            } catch {}
    };
    function onEvent(ev) {
        const r = reduce(s, ev);
        if (r.delta) return emit({ op: "delta", ...r.delta });
        for (const id of r.changed) {
            if (id === "status") emit({ op: "status", status: s.status });
            else {
                const it = s.byId.get(id);
                emit(it ? { op: "upsert", item: it } : { op: "remove", id });
            }
        }
        if (s.items.length > LIVE_MAX) {
            for (const it of s.items.splice(0, s.items.length - LIVE_MAX)) s.byId.delete(it.id);
        }
    }

    /**
     * The newest part of the conversation. `cursor` continues further back. Pages the persisted log until it has
     * `want` messages (user + reply) or runs out, within `maxPages`. Live-only items (questions still pending,
     * a reply still streaming) are merged in on the first page.
     */
    async function history({ cursor, want = 40, maxPages = 6, max = 500 } = {}) {
        const session = getSession();
        if (!session?.rpc?.eventLog?.read) return { items: cursor ? [] : [...s.items], cursor: null, hasMore: false, status: s.status, live: true };
        let events = [];
        let next = cursor ?? undefined;
        let hasMore = true;
        const t0 = now();
        for (let page = 0; page < maxPages && hasMore; page++) {
            const r = await session.rpc.eventLog.read({ direction: "backward", agentScope: "primary", includeEphemeral: false, types: HISTORY_TYPES, max, ...(next ? { cursor: next } : {}) });
            events = [...(r.events ?? []), ...events];
            next = r.cursor;
            hasMore = !!r.hasMore && r.cursorStatus !== "expired";
            const talk = itemsFrom(events).filter((i) => i.kind === "user" || i.kind === "reply").length;
            if (talk >= want) break;
        }
        const items = itemsFrom(events);
        // A page can start mid-turn (its user message is on the next, older page): that's fine, it reads on.
        if (!cursor) {
            const have = new Set(items.map((x) => x.id));
            for (const it of s.items) {
                if (have.has(it.id)) {
                    const i = items.findIndex((x) => x.id === it.id);
                    items[i] = it; // the live copy knows more (streaming, answerable questions)
                } else if (it.kind === "question" || it.kind === "plan" || (it.kind === "reply" && it.streaming) || Date.parse(it.at) >= Date.parse(items.at(-1)?.at ?? 0)) items.push(it);
            }
        }
        return { items, cursor: hasMore ? next : null, hasMore, status: s.status, ms: now() - t0 };
    }

    /** Answer a pending question or plan approval from Marginal. */
    async function answer({ id, answer, wasFreeform = false, approved, selectedAction, feedback }) {
        const session = getSession();
        const it = s.byId.get(id);
        if (!it || !it.answerable || !it.requestId) return { ok: false, reason: "That question is no longer waiting for an answer here; answer it in the Copilot app." };
        if (it.kind === "question") {
            const text = String(answer ?? "").trim();
            if (!text) return { ok: false, reason: "An answer is required." };
            const r = await session.rpc.ui.handlePendingUserInput({ requestId: it.requestId, response: { answer: text.slice(0, 4000), wasFreeform: !!wasFreeform } });
            if (r?.success === false) return { ok: false, reason: "It was already answered (in the app, perhaps)." };
            Object.assign(it, { status: "answered", answerable: false, answer: text.slice(0, 2000) });
        } else {
            const response = { approved: !!approved, ...(selectedAction ? { selectedAction } : {}), ...(feedback ? { feedback: String(feedback).slice(0, 4000) } : {}) };
            const r = await session.rpc.ui.handlePendingExitPlanMode({ requestId: it.requestId, response });
            if (r?.success === false) return { ok: false, reason: "It was already answered (in the app, perhaps)." };
            Object.assign(it, { status: "answered", answerable: false, approved: !!approved, ...(feedback ? { feedback } : {}) });
        }
        emit({ op: "upsert", item: it });
        return { ok: true, item: it };
    }

    return { onEvent, history, answer, status: () => s.status, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)), _state: s };
}
