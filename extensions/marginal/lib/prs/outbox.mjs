// The outbox: batches of new review comments on their way to Copilot. Delivery is at least once (the session API
// has no idempotency key), and each batch is idempotent by its id. Every transition is saved before the next step:
//
//   prepared ──send──▶ admitted(messageId) ──user.message seen──▶ seen ──session idle──▶ done
//       ▲                    │
//       └──── timeout ───────┘  (never showed up in the session: send again, marked as a possible repeat)
//
// A crash after the chat accepted a message but before `admitted` was saved leaves the batch `prepared`, so it's
// sent again: a duplicate at most, never a loss. Pure functions over a PR's state (see state.mjs).

export const SEEN_TIMEOUT_IDLE_MS = 5 * 60_000; // admitted, session idle this long, message never seen → resend
export const SEEN_TIMEOUT_MS = 30 * 60_000; // admitted and never seen at all after this long → resend
const KEEP = 50;

export const outstanding = (st) => st.batches.find((b) => b.state === "prepared" || b.state === "admitted" || b.state === "seen") ?? null;

/** Freeze a batch: its items and units can't change after this. */
export function prepare(st, { prId, level, deliver, units, itemIds, now }) {
    const n = (st.batchSeq ?? 0) + 1;
    st.batchSeq = n;
    const batch = { id: `${prId}-b${n}`, state: "prepared", level, deliver, units, itemIds, createdAt: new Date(now).toISOString(), attempts: 0, repeat: false, messageId: null, admittedAt: null, seenAt: null, doneAt: null, pushedAfter: [] };
    st.batches.push(batch);
    if (st.batches.length > KEEP) st.batches = st.batches.filter((b, i) => i >= st.batches.length - KEEP || b.state !== "done");
    return batch;
}

export function admit(batch, messageId, now) {
    batch.state = "admitted";
    batch.messageId = messageId;
    batch.admittedAt = new Date(now).toISOString();
    batch.attempts++;
}

export function markSeen(batch, now) {
    if (batch.state !== "admitted") return false;
    batch.state = "seen";
    batch.seenAt = new Date(now).toISOString();
    return true;
}

/** Copilot's turn for the batch ended: its comments are handled. */
export function complete(st, batch, now) {
    batch.state = "done";
    batch.doneAt = new Date(now).toISOString();
    const handled = new Set(st.handled ?? []);
    for (const id of batch.itemIds) handled.add(id);
    st.handled = [...handled];
}

/** An admitted batch that never showed up in the session goes back to be sent again. Returns true if it did. */
export function expire(batch, now, { idleSince = null } = {}) {
    if (batch.state !== "admitted") return false;
    const age = now - Date.parse(batch.admittedAt);
    const idleLong = idleSince != null && idleSince >= Date.parse(batch.admittedAt) && now - idleSince >= SEEN_TIMEOUT_IDLE_MS;
    if (!(idleLong || age >= SEEN_TIMEOUT_MS)) return false;
    batch.state = "prepared";
    batch.repeat = true;
    batch.messageId = null;
    return true;
}
