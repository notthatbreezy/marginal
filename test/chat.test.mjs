// Doc chat: Discuss turns hold Copilot's edits as a suggestion; apply/discard; notes lead the next message.
// Run: node --test test/chat.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "wb-chat-"));
process.env.MARGINAL_DATA_DIR = join(tmp, "data");
const store = await import("../extensions/marginal/lib/store.mjs");
const { createChat } = await import("../extensions/marginal/lib/chat.mjs");
after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeSession() {
    const sent = [];
    let n = 0;
    return { sent, send: async (m) => (sent.push(m), `m${++n}`) };
}

test("a Discuss turn is visible to the doc it is about, only while it runs", async () => {
    const s = fakeSession();
    const chat = createChat(() => s);
    const events = [];
    chat.subscribe((e) => events.push(e));
    const { threadId, messageId } = await chat.send({ instanceId: "p", prompt: "why?", displayPrompt: "why?", docId: "d1", discuss: true });
    assert.equal(chat.discussing("d1"), null, "queued, not running yet");
    chat.onEvent({ type: "user.message", id: messageId, data: {} });
    assert.equal(chat.discussing("d1")?.threadId, threadId);
    assert.equal(chat.discussing("d2"), null, "another doc is not affected");
    assert.equal(chat.hold(chat.discussing("d1"), [{ type: "remove", targetId: "x" }]), 1);
    assert.equal(chat.hold(chat.discussing("d1"), [{ type: "remove", targetId: "y" }]), 2, "one suggestion per turn");
    assert.deepEqual(
        events.filter((e) => e.kind === "proposal").map((e) => [e.proposalId, e.count]),
        [
            [messageId, 1],
            [messageId, 2],
        ],
    );
    assert.equal(chat.heldEdits(chat.discussing("d1")).length, 2);
    chat.onEvent({ type: "session.idle", data: {} });
    assert.equal(chat.discussing("d1"), null, "done: edits are allowed again");
    // An Edit message in the same thread is not held.
    const e2 = await chat.send({ instanceId: "p", threadId, prompt: "do it", displayPrompt: "do it", docId: "d1", discuss: false });
    chat.onEvent({ type: "user.message", id: e2.messageId, data: {} });
    assert.equal(chat.discussing("d1"), null);
    // The suggestion can be taken once.
    assert.equal(chat.takeProposal(threadId, messageId).edits.length, 2);
    assert.equal(chat.takeProposal(threadId, messageId), null);
});

test("the user's main-chat message ends a Discuss turn's hold", async () => {
    const s = fakeSession();
    const chat = createChat(() => s);
    const { messageId } = await chat.send({ instanceId: "p", prompt: "q", displayPrompt: "q", docId: "d1", discuss: true });
    chat.onEvent({ type: "user.message", id: messageId, data: {} });
    assert.ok(chat.discussing("d1"));
    chat.onEvent({ type: "user.message", id: "typed-in-main-chat", data: {} });
    assert.equal(chat.discussing("d1"), null);
});

test("closing the popup mid-reply keeps the doc protected, with nowhere to hold edits", async () => {
    const s = fakeSession();
    const chat = createChat(() => s);
    const { threadId, messageId } = await chat.send({ instanceId: "p", prompt: "q", displayPrompt: "q", docId: "d1", discuss: true });
    chat.onEvent({ type: "user.message", id: messageId, data: {} });
    chat.end(threadId);
    const meta = chat.discussing("d1");
    assert.ok(meta);
    assert.equal(chat.hold(meta, [{ type: "remove", targetId: "x" }]), 0);
});

test("an event that beats send() still marks the turn as Discuss", async () => {
    const s = fakeSession();
    const chat = createChat(() => s);
    s.send = async (m) => (chat.onEvent({ type: "user.message", id: "early", data: {} }), s.sent.push(m), "early");
    await chat.send({ instanceId: "p", prompt: "q", displayPrompt: "q", docId: "d1", discuss: true });
    assert.ok(chat.discussing("d1"));
    // ...but not when the whole turn finished before send() resolved.
    s.send = async (m) => (chat.onEvent({ type: "user.message", id: "fast", data: {} }), chat.onEvent({ type: "session.idle", data: {} }), "fast");
    await chat.send({ instanceId: "p", prompt: "q", displayPrompt: "q", docId: "d1", discuss: true });
    assert.equal(chat.discussing("d1"), null);
});

test("notes lead the thread's next message, once", async () => {
    const s = fakeSession();
    const chat = createChat(() => s);
    const { threadId } = await chat.send({ instanceId: "p", prompt: "one", displayPrompt: "one" });
    chat.note(threadId, "[applied]");
    await chat.send({ instanceId: "p", threadId, prompt: "two", displayPrompt: "two" });
    await chat.send({ instanceId: "p", threadId, prompt: "three", displayPrompt: "three" });
    assert.deepEqual(
        s.sent.map((m) => m.prompt),
        ["one", "[applied]\n\ntwo", "three"],
    );
});

test("checkEdits validates a batch in order without saving it", async () => {
    const doc = await store.create({ title: "Chat test" });
    const id = doc.documentId;
    const v0 = store.getDoc(id).version;
    const edits = [{ type: "insert", content: { type: "markdown", markdown: "Hello" } }];
    assert.equal(await store.checkEdits(id, edits), 1);
    assert.equal(store.getDoc(id).version, v0, "nothing saved");
    assert.equal(store.getDoc(id).content.length, 0);
    await assert.rejects(() => store.checkEdits(id, [...edits, { type: "remove", targetId: "nope" }]), /edits\[1\]/);
    await store.applyEdit(id, edits[0]);
    assert.equal(store.getDoc(id).content.length, 1);
});

test("immediate messages go into the running turn; others queue behind it", async () => {
    const s = fakeSession();
    const chat = createChat(() => s);
    const events = [];
    chat.subscribe((e) => events.push(e));
    await chat.send({ instanceId: "p", prompt: "a", displayPrompt: "a", immediate: true });
    await chat.send({ instanceId: "p", prompt: "b", displayPrompt: "b" });
    assert.deepEqual(
        s.sent.map((m) => m.mode),
        ["immediate", "enqueue"],
    );
    assert.match(events.filter((e) => e.kind === "status")[0].text, /current work; it reads it/);
    assert.match(events.filter((e) => e.kind === "status")[1].text, /^Queued/);
});

test("interrupt settings default per chat and survive partial updates", async () => {
    const { parseSettings, writeSettings, readSettings } = await import("../extensions/marginal/lib/settings.mjs");
    assert.deepEqual(parseSettings({}).interrupt, { doc: false, command: true });
    assert.deepEqual(parseSettings({ interrupt: { doc: "yes" } }).interrupt, { doc: false, command: true });
    writeSettings({ interrupt: { doc: true } });
    writeSettings({ theme: "dark" });
    assert.deepEqual(readSettings().interrupt, { doc: true, command: true });
});
