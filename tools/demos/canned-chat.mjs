// A stand-in for the Copilot session in demos and dev servers: every message gets a scripted reply, streamed the way
// real replies are (status → deltas → final message → done), so the chat UI behaves exactly as in the app.
//   const chat = createCannedChat({ reply: (m) => ({ text, statuses?, after? }) });
//   m = { instanceId, threadId?, prompt, displayPrompt }; after(m) runs once the reply has finished (e.g. edit the doc).
export function createCannedChat({ reply, wordMs = 35, thinkMs = 700 } = {}) {
    const listeners = new Set();
    let n = 0;
    const emit = (instanceId, threadId, event) => {
        for (const fn of listeners) fn({ type: "chat", threadId, instanceId, ...event });
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    async function play(m, threadId) {
        const r = reply(m) ?? { text: "OK." };
        emit(m.instanceId, threadId, { kind: "status", text: "Thinking" });
        await wait(thinkMs);
        for (const s of r.statuses ?? []) {
            emit(m.instanceId, threadId, { kind: "status", text: s });
            await wait(thinkMs);
        }
        await r.before?.(m);
        const messageId = `reply-${++n}`;
        const words = r.text.split(/(?<=\s)/);
        let shown = "";
        for (let i = 0; i < words.length; i += 3) {
            const chunk = words.slice(i, i + 3).join("");
            shown += chunk;
            emit(m.instanceId, threadId, { kind: "delta", messageId, text: chunk });
            await wait(wordMs * 3);
        }
        emit(m.instanceId, threadId, { kind: "message", messageId, text: r.text });
        emit(m.instanceId, threadId, { kind: "done" });
        await r.after?.(m);
    }
    return {
        subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
        async send(m) {
            const threadId = m.threadId ?? `canned-${++n}`;
            setTimeout(() => play(m, threadId).catch((e) => console.error("canned chat:", e)), 250);
            return { threadId, messageId: `msg-${++n}` };
        },
        end: () => {},
        activeThread: () => null,
    };
}