// One pull request: its state, review decision and checks; its threads (Unresolved / All / Conversation) the way
// GitHub shows them; and a rail with what Marginal does about new comments (watching, the handling ladder, how a
// batch is delivered), the checkout, and the activity log.
import { h, put, api, toast, svc } from "../core.js";
import { ago, checksEl, markSeen, newOf, reviewLabel, stateLabel } from "./tab.js";
import { noteEl, threadEl } from "./thread.js";

const STEPS = [
    ["read", "Read", "marks it new, notes it in the chat"],
    ["assess", "Assess", "Copilot triages each thread"],
    ["remediate", "Remediate", "fixes and commits locally"],
    ["localReview", "Local review", "reviewer agents check the fix"],
    ["pushResolve", "Push & resolve", "pushes, replies and resolves"],
];
const LEVEL = ["none", ...STEPS.map((s) => s[0])];

let host = null;
let ctx = null; // {documentId, prId, back}
let data = null;
let filter = "unresolved";
let newIds = new Set();
let focusTimer = null;
let handleOpen = true;
let confirmRemove = false;

const q = (path) => `${path}?doc=${encodeURIComponent(ctx.documentId)}&pr=${encodeURIComponent(ctx.prId)}`;

async function load() {
    const c = ctx;
    const d = await api(q("/prs/detail"));
    if (c === ctx) data = d; // the panel moved on meanwhile: drop it
}

async function save(patch) {
    try {
        await api(q("/prs/settings"), { method: "POST", body: patch });
        await load();
        render();
    } catch (e) {
        toast(e.message);
    }
}

/** The ladder as checkboxes: checking a step checks the ones before it; unchecking one unchecks the ones after. */
function ladderEl(level) {
    const at = LEVEL.indexOf(level);
    const handling = at > 0;
    return h(
        "fieldset",
        { class: "pr-ladder" },
        h("legend", {}, "When new comments arrive"),
        h("label", { class: "pr-opt" }, h("input", { type: "radio", name: "pr-handle", checked: !handling, onchange: () => save({ handle: "none" }) }), h("span", {}, "Do nothing ", h("span", { class: "pr-muted" }, "(just show them)"))),
        h(
            "label",
            { class: "pr-opt" },
            h("input", { type: "radio", name: "pr-handle", checked: handling, onchange: () => save({ handle: "read" }) }),
            h(
                "span",
                {},
                h("b", {}, "Handle"),
                " ",
                handling
                    ? h("button", { class: "pr-link pr-fold", "aria-expanded": String(handleOpen), onclick: (e) => (e.preventDefault(), (handleOpen = !handleOpen), render()) }, `${handleOpen ? "▾" : "▸"} up to ${STEPS[at - 1][1]}`)
                    : null,
            ),
        ),
        handling && handleOpen
            ? h(
                  "div",
                  { class: "pr-steps-box", role: "group", "aria-label": "Handling steps (each includes the ones before it)" },
                  STEPS.map(([key, label, sub], i) =>
                      h(
                          "label",
                          { class: "pr-opt pr-step-opt", "data-step": key },
                          h("input", {
                              type: "checkbox",
                              checked: i + 1 <= at,
                              onchange: (e) => save({ handle: e.target.checked ? key : i === 0 ? "none" : STEPS[i - 1][0] }),
                          }),
                          h("span", {}, label, " ", h("span", { class: "pr-muted" }, sub)),
                      ),
                  ),
              )
            : null,
    );
}

function railEl(d) {
    const s = d.settings;
    const own = d.ownership;
    return h(
        "aside",
        { class: "pr-rail" },
        own && !own.here ? h("div", { class: "pr-note" }, own.watcher ? `Session ${own.watcher} watches this PR. Settings you change here apply there.` : "No session is watching this PR right now.") : null,
        d.error ? h("div", { class: "pr-note warn", role: "status" }, d.error.message) : null,
        h(
            "section",
            {},
            h("h3", {}, "Watch this PR"),
            h(
                "label",
                { class: "pr-switch" },
                h("input", { type: "checkbox", role: "switch", checked: s.watch, onchange: (e) => save({ watch: e.target.checked }) }),
                h("span", {}, s.watch ? "Watching for new comments" : "Not watching", h("span", { class: "pr-sub" }, d.stopped && !s.watch ? "" : d.stopped ? `stopped: ${d.stopped}` : s.watch ? `checked ${d.checkedAt ? ago(d.checkedAt) : "soon"}, every minute while this session runs` : "Marginal won't check GitHub for it")),
            ),
        ),
        h("section", {}, ladderEl(s.handle)),
        LEVEL.indexOf(s.handle) >= 2
            ? h(
                  "section",
                  {},
                  h("h3", {}, "Sending it to Copilot"),
                  h("label", { class: "pr-opt" }, h("input", { type: "radio", name: "pr-deliver", checked: s.deliver !== "interrupt", onchange: () => save({ deliver: "queue" }) }), h("span", {}, "When Copilot is free ", h("span", { class: "pr-muted" }, "(queued behind its work)"))),
                  h("label", { class: "pr-opt" }, h("input", { type: "radio", name: "pr-deliver", checked: s.deliver === "interrupt", onchange: () => save({ deliver: "interrupt" }) }), h("span", {}, "Interrupt Copilot")),
              )
            : null,
        h("section", {}, h("h3", {}, "Checkout"), h("div", { class: d.worktree ? "pr-mono" : "pr-muted" }, d.worktree ?? "Not given: Copilot works in its current checkout.")),
        h(
            "section",
            {},
            h("h3", {}, "Activity"),
            h(
                "ol",
                { class: "pr-log", reversed: true },
                [...(d.activity ?? [])]
                    .reverse()
                    .slice(0, 40)
                    .map((a) => h("li", { class: `k-${a.kind ?? "info"}` }, h("time", { datetime: a.at, title: new Date(a.at).toLocaleString() }, new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), " ", a.text)),
            ),
        ),
        h(
            "section",
            { class: "pr-rail-acts" },
            h("button", { class: "pr-btn", onclick: () => refresh() }, "Check now"),
            h(
                "button",
                {
                    class: `pr-btn${confirmRemove ? " danger" : ""}`,
                    onclick: async () => {
                        if (!confirmRemove) {
                            confirmRemove = true;
                            render();
                            setTimeout(() => ((confirmRemove = false), host && render()), 4000);
                            return;
                        }
                        await api(q("/prs/remove"), { method: "POST" });
                        toast(`Removed #${d.number} from this doc.`);
                        ctx.back();
                    },
                },
                confirmRemove ? "Click again to remove" : "Remove from this doc",
            ),
        ),
    );
}

async function refresh() {
    try {
        await api(q("/prs/refresh"), { method: "POST" });
        await load();
        render();
    } catch (e) {
        toast(e.message);
    }
}

function askAbout(t) {
    const first = t.comments[0];
    svc.openChat({
        quote: `${first?.author ?? "someone"}: ${(first?.body ?? "").slice(0, 400)}`,
        ref: `PR #${data.number} · ${t.path.split("/").pop()}${t.line ? `:${t.line}` : ""}`,
        prThread: { prId: ctx.prId, threadId: t.id, label: `#${data.number} ${t.path}${t.line ? `:${t.line}` : ""}` },
    });
}

function render() {
    if (!host || !data) return;
    const d = data;
    const snap = d.snapshot;
    const threads = snap?.threads ?? [];
    const conv = [...(snap?.reviews ?? []).map((r) => ({ ...r, _kind: "review", _at: r.submittedAt })), ...(snap?.conversation ?? []).map((c) => ({ ...c, _kind: "comment", _at: c.createdAt }))].sort((a, b) => (a._at < b._at ? -1 : 1));
    const unresolved = threads.filter((t) => !t.resolved);
    const shown = filter === "unresolved" ? unresolved : filter === "all" ? threads : [];
    const seg = (key, label, n) => h("button", { class: `pr-seg${filter === key ? " on" : ""}`, "aria-pressed": String(filter === key), onclick: () => ((filter = key), render()) }, `${label} · ${n}`);
    const state = d.state;
    const body = !snap
        ? h("div", { class: "pr-muted pr-loading" }, d.error ? d.error.message : "Fetching it from GitHub…")
        : [
              h(
                  "div",
                  { class: "pr-filters" },
                  h("div", { class: "pr-segs", role: "group", "aria-label": "Show" }, seg("unresolved", "Unresolved", unresolved.length), seg("all", "All", threads.length), seg("conversation", "Conversation", conv.length)),
                  newIds.size ? h("span", { class: "pr-muted" }, `${newIds.size} new since you looked`) : null,
                  d.counting ? h("span", { class: "pr-muted" }, "· still counting (a big PR)") : null,
              ),
              filter === "conversation"
                  ? conv.length
                      ? conv.map((c) => noteEl(c, { newIds, kind: c._kind }))
                      : h("p", { class: "pr-muted" }, "No conversation comments or review summaries.")
                  : shown.length
                    ? shown.map((t) => threadEl(t, { url: d.url, newIds, facts: d.facts?.[t.id], batches: d.batches, onAsk: askAbout }))
                    : h("p", { class: "pr-muted" }, filter === "unresolved" ? (threads.length ? "Every thread is resolved." : "No review threads yet.") : "No review threads yet."),
          ];
    put(
        host,
        h(
            "div",
            { class: "pr-wrap pr-detail" },
            h(
                "div",
                { class: "pr-head" },
                h("button", { class: "pr-btn", onclick: () => ctx.back() }, "← All pull requests"),
                h("h2", { class: "pr-h" }, h("span", { class: "pr-num" }, `#${d.number}`), " ", d.title ?? "…"),
            ),
            h(
                "div",
                { class: "pr-meta" },
                state ? h("span", { class: `pr-pill st-${state}` }, stateLabel[state]) : null,
                state ? h("span", { class: `pr-pill rv ${d.reviewDecision ?? "NONE"}` }, reviewLabel(d.reviewDecision)) : null,
                d.head ? h("span", { class: "pr-branch" }, `${d.head} → ${d.base}`) : null,
                d.author ? h("span", { class: "pr-muted" }, `by ${d.author}${d.updatedAt ? ` · updated ${ago(d.updatedAt)}` : ""}`) : null,
                h("a", { class: "pr-btn pr-gh", href: d.url, target: "_blank", rel: "noopener noreferrer" }, "Open on GitHub ↗"),
            ),
            h("div", { class: "pr-checksline" }, "Checks: ", checksEl(d.checks), d.checks?.failing?.length ? h("span", { class: "pr-failing" }, ` failing: ${d.checks.failing.join(", ")}`) : null),
            h("div", { class: "pr-grid" }, h("div", { class: "pr-main" }, body), railEl(d)),
        ),
    );
}

export async function mountDetail(el, c) {
    host = el;
    ctx = c;
    filter = "unresolved";
    confirmRemove = false;
    host.replaceChildren(h("div", { class: "pr-wrap pr-muted" }, "Loading…"));
    await load();
    // What's new is marked for this visit; after it, this panel has seen it.
    newIds = new Set(newOf(data).map((i) => i.id));
    markSeen(data);
    render();
    host.scrollTop = 0;
    const ping = () => api(q("/prs/focus"), { method: "POST", body: { on: true } }).catch(() => {});
    ping();
    clearInterval(focusTimer);
    focusTimer = setInterval(ping, 2 * 60_000);
}

export function unmountDetail() {
    clearInterval(focusTimer);
    if (ctx && host) api(q("/prs/focus"), { method: "POST", body: { on: false } }).catch(() => {});
    host = null;
    ctx = null;
    data = null;
}

export async function onPrsEvent(ev) {
    if (!host || !ctx || ev.documentId !== ctx.documentId) return;
    if (!ev.prIds.includes(ctx.prId) && !ev.prIds.includes("*")) return;
    try {
        await load();
    } catch {
        return ctx?.back(); // removed
    }
    for (const i of newOf(data)) newIds.add(i.id);
    markSeen(data);
    render();
}
