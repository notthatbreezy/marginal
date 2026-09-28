// A stand-in for the Copilot session in demos and dev servers: every message gets a scripted reply, streamed the way
// real replies are (status → deltas → final message → done), so the chat UI behaves exactly as in the app.
//   const chat = createCannedChat({ reply: (m) => ({ text, statuses?, after?, ask? }) });
//   m = { instanceId, threadId?, prompt, displayPrompt, docId?, discuss? }; after(m) runs once the reply has finished (e.g. edit the doc).
//   suggest: [edits] holds those edits as a suggestion under the reply (what a Discuss turn does with Copilot's edits).
//   ask: {question, choices?} asks the user first (as ask_user does) and waits for the answer, from Marginal or appMessage.
// It also plays the session's event stream into a real transcript (chat.transcript), so the chat shows the conversation
// as it would in the app; seed(events) puts earlier history in its log, appMessage(text) is a message typed in the app.
import { createTranscript } from "../../extensions/marginal/lib/transcript.mjs";

export function createCannedChat({ reply, wordMs = 35, thinkMs = 700 } = {}) {
    const listeners = new Set();
    let n = 0;
    const emit = (instanceId, threadId, event) => {
        for (const fn of listeners) fn({ type: "chat", threadId, instanceId, ...event });
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const proposals = new Map(); // `${threadId}\0${proposalId}` -> { docId, edits }

    // ---- the session's side: its event log and the transcript built from it
    const log = []; // persisted events, oldest first
    const waiting = new Map(); // requestId -> resolve(answer)
    let t0 = Date.now();
    const ev = (type, data, extra = {}) => ({ type, id: `ev-${++n}`, timestamp: new Date(Math.max(Date.now(), ++t0)).toISOString(), data, ...extra });
    const session = {
        rpc: {
            eventLog: {
                read: async ({ cursor, max = 200 } = {}) => {
                    const end = cursor ? Number(cursor) : log.length;
                    const start = Math.max(0, end - max);
                    return { events: log.slice(start, end), cursor: String(start), hasMore: start > 0, cursorStatus: "ok" };
                },
            },
            ui: {
                handlePendingUserInput: async ({ requestId, response }) => {
                    const done = waiting.get(requestId);
                    if (!done) return { success: false };
                    waiting.delete(requestId);
                    fire(ev("user_input.completed", { requestId, answer: response.answer, wasFreeform: response.wasFreeform }), { ephemeral: true });
                    done(response.answer);
                    return { success: true };
                },
                handlePendingExitPlanMode: async () => ({ success: true }),
            },
        },
    };
    const transcript = createTranscript(() => session);
    const fire = (e, { ephemeral = false } = {}) => {
        if (!ephemeral && e.type !== "assistant.message_delta") log.push(e);
        transcript.onEvent(e);
    };
    const TOOL = { "Reading the plan": "view", Thinking: null };

    async function play(m, threadId, userId) {
        const r = reply(m) ?? { text: "OK." };
        fire(ev("assistant.turn_start", {}));
        emit(m.instanceId, threadId, { kind: "status", text: "Thinking" });
        await wait(thinkMs);
        if (r.ask) {
            const requestId = `rq-${++n}`;
            const toolCallId = `tc-${++n}`;
            fire(ev("tool.execution_start", { toolCallId, toolName: "ask_user", arguments: { question: r.ask.question, choices: r.ask.choices ?? [] } }));
            const answered = new Promise((res) => waiting.set(requestId, res));
            fire(ev("user_input.requested", { requestId, toolCallId, question: r.ask.question, choices: r.ask.choices ?? [], allowFreeform: true }), { ephemeral: true });
            const answer = await answered;
            fire(ev("tool.execution_complete", { toolCallId, success: true, result: { content: `User responded: ${answer}` } }));
            r.text = typeof r.text === "function" ? r.text(answer) : r.text;
        }
        for (const s of r.statuses ?? []) {
            emit(m.instanceId, threadId, { kind: "status", text: s });
            const [, path] = /^Reading (.+)$/.exec(s) ?? [];
            fire(ev("tool.execution_start", { toolCallId: `tc-${++n}`, toolName: path ? "view" : TOOL[s] ?? "grep", arguments: path ? { path } : { pattern: s } }));
            await wait(thinkMs);
        }
        await r.before?.(m);
        const messageId = `reply-${++n}`;
        const text = String(typeof r.text === "function" ? r.text("") : r.text);
        const words = text.split(/(?<=\s)/);
        for (let i = 0; i < words.length; i += 3) {
            const chunk = words.slice(i, i + 3).join("");
            emit(m.instanceId, threadId, { kind: "delta", messageId, text: chunk });
            fire(ev("assistant.message_delta", { messageId, deltaContent: chunk }));
            await wait(wordMs * 3);
        }
        if (r.suggest?.length) {
            proposals.set(`${threadId}\0${userId}`, { docId: m.docId, edits: r.suggest });
            emit(m.instanceId, threadId, { kind: "proposal", proposalId: userId, count: r.suggest.length });
        }
        emit(m.instanceId, threadId, { kind: "message", messageId, text });
        fire(ev("assistant.message", { messageId, content: text }));
        emit(m.instanceId, threadId, { kind: "done" });
        fire(ev("session.idle", {}), { ephemeral: true });
        await r.after?.(m);
    }
    return {
        transcript,
        /** Earlier conversation, as persisted events (e.g. test/fixtures/transcript-events.jsonl). */
        seed(events) {
            log.unshift(...events);
        },
        /** A message typed in the Copilot app's own chat; it gets a scripted reply too. */
        appMessage(text, { replyText } = {}) {
            const messageId = `app-${++n}`;
            fire(ev("user.message", { messageId, content: text, transformedContent: text, delivery: "idle" }));
            const m = { instanceId: "", prompt: text, displayPrompt: text, fromApp: true, replyText };
            setTimeout(() => play(m, "app", messageId).catch((e) => console.error("canned chat:", e)), 250);
            return messageId;
        },
        subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
        async send(m) {
            const threadId = m.threadId ?? `canned-${++n}`;
            const messageId = `msg-${++n}`;
            fire(ev("user.message", { messageId, content: m.displayPrompt ?? m.prompt, transformedContent: m.prompt, delivery: "idle" }));
            setTimeout(() => play(m, threadId, messageId).catch((e) => console.error("canned chat:", e)), 250);
            return { threadId, messageId };
        },
        end: () => {},
        discussing: () => null,
        takeProposal(threadId, id) {
            const p = proposals.get(`${threadId}\0${id}`) ?? null;
            proposals.delete(`${threadId}\0${id}`);
            return p;
        },
        peekProposal: (threadId, id) => proposals.get(`${threadId}\0${id}`) ?? null,
        note: () => {},
        activeThread: () => null,
    };
}
