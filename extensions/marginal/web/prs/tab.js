// The Pull requests tab: a doc's PRs (list), and one PR's threads and settings (detail.js). Marginal's server
// watches GitHub; this only shows what it saw, live over SSE ("prs" events), and changes settings.
import { $, h, put, api, toast } from "../core.js";

let host = null;
let documentId = null;
let view = { kind: "list" };
let data = null;
let ticker = null;
let detailMod = null;
let loading = null;

export const isMounted = () => !!host;
export const currentView = () => view;

/** "40 s ago", "5 min ago", "2 h ago", "3 days ago". */
export function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return `${Math.round(s)} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} day${s >= 172800 ? "s" : ""} ago`;
}

// "New since you looked" is this panel's own: the newest comment it has shown for each PR, in localStorage.
const seenKey = (pr) => `mg-prs-seen:${documentId}:${pr.id}`;
export function seenAt(pr) {
    let v = localStorage.getItem(seenKey(pr));
    if (!v) {
        v = pr.recent?.[0]?.at ?? new Date(0).toISOString(); // first sight: nothing is "new" yet
        localStorage.setItem(seenKey(pr), v);
    }
    return v;
}
export const markSeen = (pr) => pr.recent?.[0]?.at && localStorage.setItem(seenKey(pr), pr.recent[0].at);
export const newOf = (pr) => {
    const since = seenAt(pr);
    return (pr.recent ?? []).filter((i) => !i.mine && i.at > since);
};

const STEP = { read: "Read", assess: "Assess", remediate: "Remediate", localReview: "Local review", pushResolve: "Push & resolve" };
export const stateLabel = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" };
export const reviewLabel = (d) => ({ APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" })[d] ?? "No decision";

export function checksEl(c) {
    if (!c) return h("span", { class: "pr-muted" }, "…");
    if (!c.total) return h("span", { class: "pr-muted" }, "No checks");
    const title = [c.failing.length ? `Failing: ${c.failing.join(", ")}` : null, `${c.passed} passed, ${c.failed} failed, ${c.pending} pending`].filter(Boolean).join("\n");
    return h(
        "span",
        { class: "pr-checks", title },
        h("span", { class: "ck ok" }, "✓ ", c.passed),
        c.failed ? h("span", { class: "ck bad" }, "✗ ", c.failed) : null,
        c.pending ? h("span", { class: "ck wait" }, "● ", c.pending) : null,
    );
}

/** The Watching column: what Marginal does with this PR, and what's happening now. */
export function watchingEl(p) {
    const line = (dot, text, sub, cls = "") => h("div", { class: `pr-watch ${cls}` }, h("div", {}, dot ? h("span", { class: `pr-dot ${dot}` }) : null, text), sub ? h("div", { class: "pr-sub" }, sub) : null);
    if (p.error?.kind === "cap") return line("warn", "Paused", p.error.message, "warn");
    if (!p.settings.watch) return line(null, "Off", null, "off");
    if (p.stopped) return line(null, `Stopped: ${p.stopped}`, "Turn watching on to start again", "off");
    if (p.error) return line("warn", p.settings.handle === "none" ? "Watching" : `Handling: ${STEP[p.settings.handle] ?? "…"}`, p.error.message, "warn");
    if (p.settings.handle === "none") return line("hollow", "Watching", "just shows new comments");
    if (p.settings.handle === "read") return line("hollow", "Watching", "notes new comments in the chat");
    const b = p.batch;
    const n = (k) => `${k} new comment${k === 1 ? "" : "s"}`;
    const sub = b
        ? b.state === "seen"
            ? `Copilot is on ${n(b.comments)}…`
            : b.state === "admitted"
              ? `${n(b.comments)} queued for Copilot`
              : `sending ${n(b.comments)}…`
        : p.pending
          ? `${n(p.pending)} waiting`
          : p.lastBatch
            ? `last batch done ${ago(p.lastBatch.doneAt)}`
            : null;
    return line(b ? "live" : "solid", `Handling: up to ${STEP[p.settings.handle]}`, sub);
}

/** Roots first, each followed by what stacks on it (depth-first), so a stack reads top to bottom. */
function stacked(prs) {
    const byParent = new Map();
    for (const p of prs) {
        const k = prs.some((x) => x.id === p.stacksOn) ? p.stacksOn : null;
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(p);
    }
    const out = [];
    const walk = (k, depth) => {
        for (const p of byParent.get(k) ?? []) {
            out.push({ p, depth });
            walk(p.id, depth + 1);
        }
    };
    walk(null, 0);
    return out;
}

async function load() {
    if (loading) return loading;
    loading = api(`/prs?doc=${encodeURIComponent(documentId)}`)
        .then((d) => (data = d))
        .finally(() => (loading = null));
    return loading;
}

function renderList() {
    if (!host) return;
    const prs = data?.prs ?? [];
    const own = data?.ownership;
    const checked = prs.map((p) => p.checkedAt).filter(Boolean).sort().at(-1);
    const input = h("input", { class: "pr-add-url", type: "url", placeholder: "Paste a pull request URL to add it…", "aria-label": "Pull request URL" });
    const add = async () => {
        const url = input.value.trim();
        if (!url) return input.focus();
        try {
            const r = await api(`/prs/add?doc=${encodeURIComponent(documentId)}`, { method: "POST", body: { url } });
            input.value = "";
            toast(r.created ? "Added. Marginal is fetching it." : "It's already on this doc.");
            await load();
            renderList();
        } catch (e) {
            toast(e.message);
        }
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), add()));
    const bar = h(
        "div",
        { class: "pr-bar" },
        input,
        h("button", { class: "pr-btn", onclick: add }, "Add"),
        h("span", { class: "pr-muted pr-checked", "data-at": checked ?? "" }, checked ? `Checked ${ago(checked)}` : prs.length ? "Not checked yet" : ""),
    );
    const notice =
        own && !own.here && own.watcher
            ? h("div", { class: "pr-note" }, `Another Copilot session (${own.watcher}) is watching these pull requests. This panel shows what it sees.`)
            : own && !own.here && prs.length
              ? h("div", { class: "pr-note" }, "No session is watching these pull requests right now. ", h("button", { class: "pr-link", onclick: async () => (await api(`/prs/watch-here?doc=${encodeURIComponent(documentId)}`, { method: "POST" }), await load(), renderList()) }, "Watch from this session"))
              : null;
    if (!prs.length) {
        put(
            host,
            h(
                "div",
                { class: "pr-wrap" },
                bar,
                notice,
                h("div", { class: "pr-empty" }, h("p", {}, h("b", {}, "No pull requests yet.")), h("p", { class: "pr-muted" }, "Paste a PR's URL above, or ask Copilot to add the ones this doc is about. Marginal watches them for new review comments; you choose, per PR, what Copilot does about them.")),
            ),
        );
        return;
    }
    const rows = stacked(prs).map(({ p, depth }) => {
        const fresh = newOf(p);
        const state = p.state ?? (p.counting ? null : "open");
        return h(
            "tr",
            { class: "pr-row", tabindex: "0", "data-pr": p.id, onclick: () => open(p.id), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(p.id)) },
            h(
                "td",
                { class: "pr-title-cell" },
                h(
                    "div",
                    { class: "pr-title", style: `padding-left:${depth * 18}px` },
                    depth ? h("span", { class: "pr-stack", "aria-label": "stacked on the PR above" }, "↳") : null,
                    h("span", { class: "pr-num" }, `#${p.number}`),
                    " ",
                    p.title ?? h("span", { class: "pr-muted" }, p.error ? "Couldn't fetch it yet" : "Fetching…"),
                    p.label ? h("span", { class: "pr-label" }, p.label) : null,
                ),
                h("div", { class: "pr-branch", style: `padding-left:${depth * 18}px` }, p.head ? `${p.head} → ${p.base}` : `${p.owner}/${p.repo}`, p.host !== "github.com" ? h("span", { class: "pr-host" }, p.host) : null),
            ),
            h("td", {}, state ? h("span", { class: `pr-pill st-${state}` }, stateLabel[state]) : h("span", { class: "pr-muted" }, "…")),
            h("td", {}, p.state ? h("span", { class: `pr-pill rv ${p.reviewDecision ?? "NONE"}` }, reviewLabel(p.reviewDecision)) : null),
            h("td", {}, checksEl(p.checks)),
            h(
                "td",
                { class: "pr-comments" },
                fresh.length ? h("span", { class: "pr-pill new", title: "Comments from others since this panel last showed this PR" }, `${fresh.length} new`) : null,
                p.threads ? h("span", {}, h("b", {}, p.threads.unresolved), ` unresolved / ${p.threads.total}`) : h("span", { class: "pr-muted" }, p.counting ? "counting…" : "…"),
            ),
            h("td", {}, watchingEl(p)),
        );
    });
    put(
        host,
        h(
            "div",
            { class: "pr-wrap" },
            bar,
            notice,
            h(
                "table",
                { class: "pr-list" },
                h("thead", {}, h("tr", {}, ["Pull request", "State", "Review", "Checks", "Comments", "Watching"].map((t) => h("th", {}, t)))),
                h("tbody", {}, rows),
            ),
        ),
    );
}

async function open(prId) {
    view = { kind: "detail", prId };
    detailMod ??= await import("./detail.js");
    await detailMod.mountDetail(host, { documentId, prId, back: () => backToList() });
}

async function backToList() {
    detailMod?.unmountDetail();
    view = { kind: "list" };
    await load().catch(() => {});
    renderList();
}

export async function mountPrs(el, { documentId: id, prId = null }) {
    host = el;
    documentId = id;
    view = { kind: "list" };
    host.replaceChildren(h("div", { class: "pr-wrap pr-muted" }, "Loading pull requests…"));
    try {
        await load();
    } catch (e) {
        put(host, h("div", { class: "doc error" }, e.message));
        return;
    }
    if (prId && data.prs.some((p) => p.id === prId)) return open(prId);
    renderList();
    clearInterval(ticker);
    ticker = setInterval(() => {
        const c = host?.querySelector(".pr-checked");
        if (c?.dataset.at) c.textContent = `Checked ${ago(c.dataset.at)}`;
    }, 10_000);
}

export function unmountPrs() {
    detailMod?.unmountDetail();
    clearInterval(ticker);
    host = null;
    documentId = null;
    data = null;
}

/** An SSE "prs" event for the doc shown: refetch what's on screen. */
export async function onPrsEvent(ev) {
    if (!host || ev.documentId !== documentId) return;
    if (view.kind === "detail") return detailMod?.onPrsEvent(ev);
    await load().catch(() => {});
    renderList();
}

/** The number of PRs on a doc, for the tab's label. */
export async function countFor(docId) {
    const d = await api(`/prs?doc=${encodeURIComponent(docId)}`).catch(() => null);
    return d?.prs?.length ?? 0;
}
