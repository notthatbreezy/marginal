// Side-chat threads: route the main session's replies back to the whiteboard popup that asked.
//
// Correlation, strongest first:
//   1. assistant.message.originatingMessageId names the user message that started the run.
//   2. Otherwise, the thread whose user.message was most recently admitted owns the turn,
//      until a foreign user.message arrives (the user typed in the main chat).
// Streaming deltas are tentative; a final message that belongs elsewhere retracts them.
import { randomBytes } from "node:crypto";

import { InputError } from "./errors.mjs";

const TOOL_STATUS = {
    invoke_canvas_action: "Updating the whiteboard",
    open_canvas: "Opening a canvas",
    view: "Reading files",
    grep: "Searching the code",
    glob: "Finding files",
    powershell: "Running a command",
    edit: "Editing files",
    create: "Creating a file",
    web_fetch: "Reading the web",
    web_search: "Searching the web",
    task: "Delegating to a helper agent",
    ask_user: "Asked you a question in the main chat",
};

export function createChat(getSession) {
    const threads = new Map(); // threadId -> { instanceId, messageIds:Set, pending:number }
    const byMessage = new Map(); // user message id -> threadId
    const streams = new Map(); // assistant messageId -> threadId (tentative)
    const listeners = new Set();
    let current = null; // threadId owning the active turn
    let lastUserIds = new Set(); // ids of the most recently admitted user message

    const emit = (threadId, event) => {
        const t = threads.get(threadId);
        if (!t) return;
        for (const fn of listeners) fn({ type: "chat", threadId, instanceId: t.instanceId, ...event });
    };

    function onEvent(ev) {
        const d = ev.data ?? {};
        // Subagent chatter is not part of the reply the user asked for.
        if (d.parentToolCallId || ev.agentId) return;
        switch (ev.type) {
            case "user.message": {
                const threadId = byMessage.get(ev.id) ?? (d.messageId && byMessage.get(d.messageId));
                current = threadId ?? null;
                lastUserIds = new Set([ev.id, d.messageId].filter(Boolean));
                if (threadId) emit(threadId, { kind: "status", text: "Thinking" });
                break;
            }
            case "assistant.message_delta": {
                if (!current || !d.deltaContent) break;
                streams.set(d.messageId, current);
                emit(current, { kind: "delta", messageId: d.messageId, text: d.deltaContent });
                break;
            }
            case "assistant.message": {
                const owner = (d.originatingMessageId && byMessage.get(d.originatingMessageId)) || current;
                const streamed = streams.get(ev.id) ?? streams.get(d.messageId);
                if (streamed && streamed !== owner) emit(streamed, { kind: "retract", messageId: d.messageId ?? ev.id });
                streams.delete(ev.id);
                if (d.messageId) streams.delete(d.messageId);
                if (owner && d.content?.trim()) emit(owner, { kind: "message", messageId: d.messageId ?? ev.id, text: d.content });
                break;
            }
            case "tool.execution_start": {
                if (!current) break;
                const name = d.toolName ?? "";
                emit(current, { kind: "status", text: TOOL_STATUS[name] ?? (name ? `Using ${name.replace(/[-_]/g, " ")}` : "Working") });
                break;
            }
            case "session.idle": {
                if (current) emit(current, { kind: "done" });
                current = null;
                break;
            }
        }
    }

    async function send({ instanceId, threadId, prompt, displayPrompt }) {
        const session = getSession();
        if (!session) throw new InputError("Still connecting to Copilot. Try again in a moment.");
        if (threadId && !threads.has(threadId)) throw new InputError("That conversation has ended; start a new one.");
        const id = threadId ?? randomBytes(8).toString("hex");
        if (!threads.has(id)) threads.set(id, { instanceId, messageIds: new Set() });
        const messageId = await session.send({ prompt, displayPrompt, mode: "enqueue" });
        threads.get(id).messageIds.add(messageId);
        byMessage.set(messageId, id);
        // The user.message event can arrive before send() resolves; if it already did, this thread owns the turn.
        if (lastUserIds.has(messageId)) current = id;
        emit(id, { kind: "status", text: current === id ? "Thinking" : "Queued — Copilot will reply after its current work" });
        return { threadId: id, messageId };
    }

    function end(threadId) {
        const t = threads.get(threadId);
        if (!t) return;
        for (const m of t.messageIds) byMessage.delete(m);
        threads.delete(threadId);
        if (current === threadId) current = null;
    }

    return {
        onEvent,
        send,
        end,
        subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
        /** The side-chat thread that owns the current turn (null = the user's own main-chat work). */
        activeThread: () => current,
    };
}
