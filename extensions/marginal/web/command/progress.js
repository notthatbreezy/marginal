// Passive progress in the Command tab (docs/command-center.md, "Progress"): all of it observed from the orchestrator's
// session, none of it reported by the agent.
//   A  the status line in the strip: Now · Todos n / m · k helpers running (the last two open popovers)
//   C  per-phase todo counts, the current todo and running helpers on the phase cards (phases.js)
//   D  helper lanes under the timeline's histogram
// `progress` is the server's summary (lib/command/progress.mjs summarizeProgress); absent pieces are null and hidden.
import { h, put } from "../core.js";
import { capLanes, packLanes } from "./derive.js";

/** 42s · 3m · 1h 5m (seconds matter: helpers often finish in under a minute). */
export function fmtDur(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

const TODO_ICON = { done: "✓", in_progress: "", pending: "", blocked: "!" };
const TODO_LABEL = { done: "done", in_progress: "in progress", pending: "pending", blocked: "blocked" };
const HELPER_LABEL = { running: "running", done: "done", failed: "failed", cancelled: "cancelled" };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const helperTime = (x, now) => (x.status === "running" ? fmtDur(now - Date.parse(x.startedAt)) : typeof x.durationMs === "number" ? fmtDur(x.durationMs) : x.endedAt ? fmtDur(Date.parse(x.endedAt) - Date.parse(x.startedAt)) : "");

/** A small done / total bar. */
export function todoBar(done, total, cls = "") {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h("span", { class: `tbar ${cls}`, "aria-hidden": "true" }, h("i", { style: `width:${pct}%` }));
}

/**
 * A · the status line. Rebuilt only when what it shows changes (a 4 Hz rebuild could swallow a click).
 * opts: { now, onTodos(anchor), onHelpers(anchor) }
 */
export function renderProgressLine(host, progress, opts) {
    const p = progress ?? {};
    const running = p.helpers?.running ?? 0;
    const key = JSON.stringify([p.now?.text, p.now?.source, p.todos?.done, p.todos?.total, running, p.helpers?.list?.length ?? 0]);
    host.hidden = !p.now && !p.todos && !p.helpers;
    if (host.dataset.key === key) return;
    host.dataset.key = key;
    const nowTitle = p.now ? `${p.now.source === "intent" ? "What the orchestrator says it's doing" : "Its todo in progress"} (${new Date(p.now.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})\n${p.now.text}` : null;
    put(
        host,
        p.now ? h("span", { class: "pg-now", title: nowTitle }, h("span", { class: "k" }, "Now"), h("span", { class: "t" }, p.now.text)) : null,
        p.todos
            ? h(
                  "button",
                  { class: "pg-pill pg-todos", title: "The orchestrator's todo list", "aria-haspopup": "dialog", "aria-label": `Todos: ${p.todos.done} of ${p.todos.total} done`, onclick: (e) => opts.onTodos(e.currentTarget) },
                  h("span", { class: "k" }, "Todos"),
                  h("span", { class: "num" }, `${p.todos.done} / ${p.todos.total}`),
                  todoBar(p.todos.done, p.todos.total),
              )
            : null,
        p.helpers
            ? h(
                  "button",
                  { class: `pg-pill pg-helpers${running ? " on" : ""}`, title: "Helper agents the orchestrator started", "aria-haspopup": "dialog", onclick: (e) => opts.onHelpers(e.currentTarget) },
                  running ? h("span", { class: "pulse" }) : null,
                  running ? `${plural(running, "helper")} running` : `None running · ${plural(p.helpers.list.length, "helper")}`,
              )
            : null,
    );
}

function popHead(title, onClose) {
    return h("div", { class: "pp-head" }, h("span", {}, title), h("button", { class: "chat-icon pp-x", title: "Close (Esc)", "aria-label": "Close", onclick: onClose, html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }));
}
const phaseTag = (id) => h("span", { class: `pg-tag${id ? "" : " other"}` }, id ? id.toUpperCase() : "Other");

/** The todos popover: grouped by the phase each todo was matched to, in plan order, then Other. */
export function todosPopover(progress, plan, { onClose }) {
    const t = progress?.todos;
    const groups = [...(plan?.phases ?? []).map((ph) => ({ id: ph.id, title: ph.title })), { id: null, title: "Not matched to a phase" }].map((g) => ({ ...g, rows: (t?.rows ?? []).filter((r) => r.phaseId === g.id) })).filter((g) => g.rows.length);
    return h(
        "div",
        { class: "cc-menu pin-pop prog-pop todos-pop", role: "dialog", "aria-label": "Todos" },
        popHead(t ? `Todos · ${t.done} of ${t.total} done` : "Todos", onClose),
        t ? null : h("p", { class: "pp-empty" }, "No todos yet. They appear as the orchestrator keeps its todo list."),
        groups.map((g) =>
            h(
                "div",
                { class: "pg-group" },
                h("div", { class: "pg-gh" }, phaseTag(g.id), h("span", { class: "gt" }, g.title), h("span", { class: "num gn" }, `${g.rows.filter((r) => r.status === "done").length}/${g.rows.length}`)),
                g.rows.map((r) => h("div", { class: `pg-todo ts-${r.status}`, title: `${r.id} · ${TODO_LABEL[r.status]}` }, h("span", { class: "ti", "aria-label": TODO_LABEL[r.status] }, r.status === "in_progress" ? h("span", { class: "pulse" }) : TODO_ICON[r.status]), h("span", { class: "tt" }, r.title))),
            ),
        ),
        h("div", { class: "pp-foot" }, h("span", {}, "Observed from the orchestrator's todo list. A todo whose id starts with a phase id (", h("code", {}, "p2-…"), ") counts for that phase; others count for the phase in play when they appeared.")),
    );
}

/** The helpers popover: running first, then the most recent. */
export function helpersPopover(progress, plan, { now, onClose }) {
    const list = [...(progress?.helpers?.list ?? [])].sort((a, b) => (a.status === "running") - (b.status === "running") || Date.parse(a.startedAt) - Date.parse(b.startedAt)).reverse();
    const shown = list.slice(0, 30);
    return h(
        "div",
        { class: "cc-menu pin-pop prog-pop helpers-pop", role: "dialog", "aria-label": "Helpers" },
        popHead(`Helpers · ${progress?.helpers?.running ?? 0} running`, onClose),
        list.length ? null : h("p", { class: "pp-empty" }, "No helper agents yet."),
        shown.map((x) =>
            h(
                "div",
                { class: `pg-helper hs-${x.status}`, title: [x.description, x.model, x.error].filter(Boolean).join("\n") || null },
                h("span", { class: "hi" }, x.status === "running" ? h("span", { class: "pulse" }) : x.status === "done" ? "✓" : x.status === "failed" ? "!" : "–"),
                h("span", { class: "hn" }, h("b", {}, x.name), x.description ? h("span", { class: "hd" }, x.description) : null),
                phaseTag(x.phaseId),
                h("span", { class: "num ht" }, x.status === "running" ? helperTime(x, now) : `${HELPER_LABEL[x.status]} · ${helperTime(x, now)}`),
            ),
        ),
        list.length > shown.length ? h("div", { class: "pp-foot" }, h("span", {}, `${list.length - shown.length} older not shown`)) : null,
    );
}

// ---------- D · helper lanes ----------
export const LANES_MAX = 4;

const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const stateIcon = (state) => h("span", { class: `hi hs-${state}` }, state === "running" ? h("span", { class: "pulse" }) : state === "done" ? "✓" : state === "failed" ? "!" : "–");
/** A run's state: an earlier run of a resumed helper ended with it going idle (done). */
const runState = (x) => (x.k === (Array.isArray(x.h.spans) && x.h.spans.length ? x.h.spans.length : 1) - 1 ? x.h.status : "done");

/**
 * Helper lanes on the histogram's time axis [from, now], one bar per active run: a helper idling between runs holds
 * no lane, and its next run returns to its lane when that's free (a dotted line joins them). At most LANES_MAX lanes;
 * past that, the extra runs merge into "+n" blocks on the last lane. Hovering (or focusing) a bar or block shows what's
 * in it, and a bar highlights all of that helper's runs. opts: { from, now, trimmedUntil? }
 */
export function renderLanes(host, helpers, { from, now, trimmedUntil = null }) {
    const all = helpers ?? [];
    const width = host.clientWidth || host.parentElement?.clientWidth || 800;
    const span = Math.max(1, now - from);
    // Bars in a lane stay ~6 px apart whatever the time span, so lanes track real overlap.
    const gap = (6 / width) * span;
    const packed = packLanes(all, now, gap, from);
    const shownIds = new Set(packed.flat().map((x) => x.h.id));
    host.hidden = !shownIds.size;
    if (!shownIds.size) return void put(host);
    const { lanes, overflow } = capLanes(packed, LANES_MAX, gap);
    const pos = (t) => Math.max(0, Math.min(100, ((t - from) / span) * 100));
    const running = all.filter((x) => shownIds.has(x.id) && x.status === "running").length;
    const label = `${plural(shownIds.size, "helper")}${running ? ` · ${running} running` : ""}`;
    const trimmed = trimmedUntil && Date.parse(trimmedUntil) >= from ? h("span", { class: "muted" }, ` · earlier helpers not kept (before ${hhmm(trimmedUntil)})`) : null;

    const tip = h("div", { class: "lane-tip", role: "tooltip", hidden: true });
    const showTip = (el, content) => {
        put(tip, content);
        tip.hidden = false;
        const r = el.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        const w = tip.offsetWidth;
        tip.style.left = `${Math.max(0, Math.min(r.left - hr.left + r.width / 2 - w / 2, hr.width - w))}px`;
        tip.style.bottom = `${hr.bottom - r.top + 6}px`;
    };
    const hideTip = () => (tip.hidden = true);
    const hl = (id, on) => {
        host.classList.toggle("hl-on", on);
        for (const el of host.querySelectorAll(`[data-h="${CSS.escape(id)}"]`)) el.classList.toggle("hl", on);
    };
    // The timeline is rebuilt several times a second: remember what's hovered or focused and restore it after.
    const hover = (el, content, id, key) => {
        el.dataset.key = key;
        el._on = () => (showTip(el, content()), id && hl(id, true));
        const on = () => ((host._hover = key), el._on());
        const off = () => ((host._hover = null), hideTip(), id && hl(id, false));
        el.addEventListener("mouseenter", on);
        el.addEventListener("mouseleave", off);
        el.addEventListener("focus", on);
        el.addEventListener("blur", off);
        return el;
    };
    const runLine = (x) => {
        const runs = Array.isArray(x.h.spans) && x.h.spans.length ? x.h.spans.length : 1;
        const state = runState(x);
        return h("div", { class: "lt-row" }, stateIcon(state), h("b", {}, x.h.name), h("span", { class: "lt-m" }, `${HELPER_LABEL[state]} · ${fmtDur(x.e - x.s)}${runs > 1 ? ` · run ${x.k + 1} of ${runs}` : ""}`), x.h.phaseId ? phaseTag(x.h.phaseId) : null);
    };
    const bar = (x) => {
        const state = runState(x);
        const left = pos(x.s);
        const el = h("b", { class: `lane-bar hs-${state}`, "data-h": x.h.id, tabindex: "0", "aria-label": `${x.h.name}, ${HELPER_LABEL[state]}`, style: `left:${left}%;width:${Math.max(0.6, pos(x.e) - left)}%` }, h("span", {}, x.h.name));
        return hover(el, () => [runLine(x), x.h.description ? h("div", { class: "lt-d" }, x.h.description) : null, state === "failed" && x.h.error ? h("div", { class: "lt-err" }, x.h.error) : null], x.h.id, `${x.h.id}:${x.k}`);
    };
    const laneEl = (items) => {
        const kids = [];
        items.forEach((x, i) => {
            const prev = items[i - 1];
            // The same helper's previous run in this lane: a dotted line over the idle gap between them.
            if (prev && prev.h.id === x.h.id && prev.k === x.k - 1) kids.push(h("i", { class: "lane-idle", "data-h": x.h.id, style: `left:${pos(prev.e)}%;width:${Math.max(0, pos(x.s) - pos(prev.e))}%`, "aria-hidden": "true" }));
            kids.push(bar(x));
        });
        return h("div", { class: "lane" }, kids);
    };
    const blockEl = (b) => {
        const ids = new Set(b.items.map((x) => x.h.id));
        const live = b.items.some((x) => runState(x) === "running");
        const bad = b.items.some((x) => runState(x) === "failed");
        const left = pos(b.s);
        const el = h("b", { class: `lane-bar lane-block${live ? " hs-running" : ""}${bad ? " has-failed" : ""}`, tabindex: "0", "aria-label": `${ids.size} more helpers`, style: `left:${left}%;width:${Math.max(0.6, pos(b.e) - left)}%` }, h("span", {}, `+${ids.size}`));
        const rows = [...b.items].sort((p, q) => (runState(q) === "running") - (runState(p) === "running") || p.s - q.s);
        return hover(el, () => [h("div", { class: "lt-h" }, `${plural(ids.size, "more helper")} · ${hhmm(b.s)}–${b.e >= now - 1000 ? "now" : hhmm(b.e)}`), rows.slice(0, 8).map(runLine), rows.length > 8 ? h("div", { class: "lt-d" }, `and ${rows.length - 8} more`) : null], null, `block:${b.items[0].h.id}:${b.items[0].k}`);
    };
    const focused = host.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
    put(
        host,
        h("div", { class: "lanes-h", title: "Helper agents the orchestrator started, on the timeline's time axis: one bar per run, and idle time holds no lane" }, label, overflow ? h("span", { class: "muted" }, ` · ${LANES_MAX} lanes, the rest grouped`) : null, trimmed),
        h("div", { class: "lanes" }, lanes.map(laneEl), overflow ? h("div", { class: "lane lane-over" }, overflow.map(blockEl)) : null),
        tip,
    );
    const find = (key) => key && [...host.querySelectorAll("[data-key]")].find((el) => el.dataset.key === key);
    find(focused)?.focus({ preventScroll: true });
    find(host._hover)?._on();
}
/** C · the progress line on a phase card, and the Other card for unmatched todos. */
export function phaseProgress(b) {
    if (!b || (!b.total && !b.helpers.length)) return null;
    return h(
        "div",
        { class: "pg-card" },
        b.total ? h("span", { class: "pg-count", title: `${b.done} of ${b.total} todos done` }, todoBar(b.done, b.total, "sm"), h("span", { class: "num" }, `${b.done}/${b.total}`), " todos") : null,
        b.helpers.slice(0, 3).map((x) => h("span", { class: "pg-chip", title: `${x.name} (running)` }, h("span", { class: "pulse" }), x.name)),
        b.helpers.length > 3 ? h("span", { class: "pg-chip more" }, `+${b.helpers.length - 3}`) : null,
    );
}
export function otherCard(b) {
    return h(
        "li",
        { class: "front phase-row ps-other", "data-phase": "__other", title: "Todos and helpers that appeared while no phase was in play, and aren't named for one (p2-…)" },
        h("div", { class: "row1" }, h("span", { class: "fdot" }), h("span", { class: "lbl" }, "Other"), h("span", { class: "sub" }, "not matched to a phase")),
        b.now ? h("div", { class: "where" }, "Now: ", h("b", {}, b.now)) : null,
        phaseProgress(b),
    );
}
