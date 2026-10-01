// One review thread as GitHub shows it: file and line, the diff around it (commented lines marked), the
// conversation (Markdown, suggested changes as diffs), and a row of what's happened to it since: observed on GitHub,
// or reported by Copilot (marked so).
import { h, markdown } from "../core.js";
import { ago } from "./tab.js";

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const initials = (login) => (login ?? "?").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";

/** The diff hunk: header, then up to `max` lines ending at the comment; the last `span` lines are the commented ones. */
export function hunkEl(hunk, { span = 1, max = 12 } = {}) {
    const lines = String(hunk ?? "").replace(/\r\n/g, "\n").split("\n");
    if (!lines[0]) return null;
    const head = lines[0].startsWith("@@") ? lines[0] : null;
    const body = (head ? lines.slice(1) : lines).slice(-max);
    const mark = Math.max(1, Math.min(span, body.length));
    return h(
        "pre",
        { class: "pr-hunk", "aria-label": "Diff around the comment" },
        head ? h("span", { class: "hk" }, head) : null,
        body.map((l, i) => h("span", { class: `${l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx"}${i >= body.length - mark ? " hit" : ""}` }, l || " ")),
    );
}

/** A comment body: Markdown, with ```suggestion blocks shown as the change they propose. */
export function bodyEl(body, { removed = [] } = {}) {
    const parts = String(body ?? "").replace(/\r\n/g, "\n").split(/^```suggestion[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
            if (parts[i].trim()) out.push(h("div", { class: "pr-md md", html: markdown(parts[i]) }));
        } else {
            const add = parts[i].replace(/\n$/, "").split("\n");
            out.push(
                h(
                    "div",
                    { class: "pr-sugg" },
                    h("div", { class: "pr-sugg-h" }, "Suggested change"),
                    h("pre", { class: "pr-hunk" }, removed.map((l) => h("span", { class: "del" }, `-${l}`)), add.map((l) => h("span", { class: "add" }, `+${l}`))),
                ),
            );
        }
    }
    return out.length ? out : [h("div", { class: "pr-md pr-muted" }, "(no text)")];
}

export function commentEl(c, { isNew = false, removed = [] } = {}) {
    return h(
        "div",
        { class: `pr-cmt${isNew ? " is-new" : ""}`, "data-comment": c.id },
        h("span", { class: "pr-av", "aria-hidden": "true" }, initials(c.author)),
        h(
            "div",
            { class: "pr-cmt-body" },
            h(
                "div",
                { class: "pr-cmt-h" },
                h("b", {}, c.author ?? "a deleted account"),
                " ",
                h("span", { class: "pr-muted", title: when(c.createdAt) }, ago(c.createdAt)),
                c.editedAt ? h("span", { class: "pr-muted" }, " · edited") : null,
                isNew ? h("span", { class: "pr-pill new" }, "New") : null,
            ),
            bodyEl(c.body, { removed }),
        ),
    );
}

const STATUS = { assessed: "Assessed", fixed: "Fixed", reviewed: "Reviewed", declined: "Declined", question: "Question for you" };

/** What's happened to a thread: the batch it went in, what GitHub shows, and what Copilot reported. */
export function stepsOf(thread, { facts, batches }) {
    const steps = [];
    for (const b of batches ?? [])
        if (b.units?.includes(`thread:${thread.id}`)) {
            const at = b.doneAt ?? b.seenAt ?? b.admittedAt ?? b.createdAt;
            const label = b.state === "done" ? "Copilot handled it" : b.state === "seen" ? "Copilot is on it" : b.state === "admitted" ? "Queued for Copilot" : "Sending to Copilot";
            steps.push({ at, label, title: `Batch ${b.id}, up to ${b.level}`, kind: b.state === "done" ? "done" : "now" });
        }
    for (const r of facts?.reported ?? []) steps.push({ at: r.at, label: `${STATUS[r.status] ?? r.status}${r.commit ? ` ${r.commit.slice(0, 7)}` : ""}`, title: r.note ?? "", kind: "reported", note: r.note });
    for (const o of facts?.observed ?? []) {
        const label = o.kind === "replied" ? (o.commit ? `Replied: fixed in ${o.commit.slice(0, 7)}` : "Replied") : o.kind === "resolved" ? "Resolved" : o.kind === "reopened" ? "Reopened" : o.kind === "outdated" ? "Outdated (code changed)" : o.kind;
        steps.push({ at: o.at, label, title: o.by ? `by ${o.by}` : "", kind: "observed" });
    }
    return steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function stepsEl(steps) {
    if (!steps.length) return null;
    return h(
        "div",
        { class: "pr-steps", "aria-label": "What's happened to this thread" },
        steps.map((s, i) => [
            i ? h("span", { class: "pr-arrow", "aria-hidden": "true" }, "→") : null,
            h("span", { class: `pr-step ${s.kind}`, title: [s.title, s.at ? new Date(s.at).toLocaleString() : ""].filter(Boolean).join("\n") }, s.label, s.kind === "reported" ? h("span", { class: "pr-tag" }, "reported") : null),
        ]),
        steps.some((s) => s.note) ? h("div", { class: "pr-step-note" }, `“${steps.filter((s) => s.note).at(-1).note}”`) : null,
    );
}

/** A thread card. onAsk(thread) opens the chat about it. */
export function threadEl(t, { url, newIds, facts, batches, onAsk }) {
    const isNew = t.comments.some((c) => newIds.has(c.id));
    const span = t.startLine && t.line ? t.line - t.startLine + 1 : 1;
    const hunkLines = String(t.hunk ?? "").replace(/\r\n/g, "\n").split("\n").slice(1);
    const removed = hunkLines.slice(-span).filter((l) => l[0] !== "-").map((l) => l.slice(1));
    const where = t.line ? `line ${t.startLine && t.startLine !== t.line ? `${t.startLine}–` : ""}${t.line}` : t.originalLine ? `was line ${t.originalLine}` : "";
    const replies = t.comments.length - 1;
    return h(
        "article",
        { class: `pr-thread${isNew ? " is-new" : ""}${t.resolved ? " is-resolved" : ""}`, "data-thread": t.id },
        h(
            "header",
            { class: "pr-thread-h" },
            h("span", { class: "pr-file" }, t.path),
            where ? h("span", { class: "pr-muted" }, where) : null,
            isNew ? h("span", { class: "pr-pill new" }, "New") : null,
            t.outdated ? h("span", { class: "pr-pill" }, "Outdated") : null,
            t.resolved ? h("span", { class: "pr-pill" }, "Resolved") : null,
            h("span", { class: "pr-thread-meta pr-muted" }, `${t.comments[0]?.author ?? "a deleted account"} · ${ago(t.comments[0]?.createdAt)}${replies ? ` · ${replies} repl${replies === 1 ? "y" : "ies"}` : ""}`),
        ),
        hunkEl(t.hunk, { span }),
        t.comments.map((c) => commentEl(c, { isNew: newIds.has(c.id), removed })),
        stepsEl(stepsOf(t, { facts, batches })),
        h(
            "div",
            { class: "pr-thread-acts" },
            h("button", { class: "pr-btn", onclick: () => onAsk?.(t) }, "Ask in chat"),
            h("a", { class: "pr-btn", href: t.comments[0]?.url ?? url, target: "_blank", rel: "noopener noreferrer" }, "Open on GitHub ↗"),
        ),
    );
}

/** A review summary or a conversation comment, for the Conversation filter. */
export function noteEl(item, { newIds, kind }) {
    return h(
        "article",
        { class: `pr-thread pr-note-card${newIds.has(item.id) ? " is-new" : ""}`, "data-item": item.id },
        h(
            "header",
            { class: "pr-thread-h" },
            h("span", { class: "pr-file" }, kind === "review" ? `Review · ${item.state.toLowerCase().replace(/_/g, " ")}` : "Comment"),
            item.url ? h("a", { class: "pr-link pr-thread-meta", href: item.url, target: "_blank", rel: "noopener noreferrer" }, "Open on GitHub ↗") : null,
        ),
        commentEl(kind === "review" ? { ...item, createdAt: item.submittedAt } : item, { isNew: newIds.has(item.id) }),
    );
}
