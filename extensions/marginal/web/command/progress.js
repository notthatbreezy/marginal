// Passive progress in the Command tab (docs/command-center.md, "Progress"): all of it observed from the orchestrator's
// session, none of it reported by the agent.
//   A  the status line in the strip: Now · Todos n / m · k helpers running (the last two open popovers)
//   C  per-phase todo counts, the current todo and running helpers on the phase cards (phases.js)
//   D  helper lanes under the timeline's histogram
// `progress` is the server's summary (lib/command/progress.mjs summarizeProgress); absent pieces are null and hidden.
import { h, put } from "../core.js";
import { packLanes } from "./derive.js";

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
                  running ? `${plural(running, "helper")} running` : plural(p.helpers.list.length, "helper"),
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
export const LANES_MAX = 3;

/**
 * Helper lanes on the histogram's time axis [from, now]. Up to LANES_MAX lanes; more collapse into one summary row
 * (how many ran at once over time) that expands on click. opts: { from, now, open, onToggle() }
 */
export function renderLanes(host, helpers, { from, now, open, onToggle }) {
    const list = (helpers ?? []).filter((x) => (x.endedAt ? Date.parse(x.endedAt) : now) >= from);
    host.hidden = !list.length;
    if (!list.length) return void put(host);
    const span = Math.max(1, now - from);
    const pos = (t) => Math.max(0, Math.min(100, ((t - from) / span) * 100));
    // Bars in one lane keep a little room between them (3% of the axis) so their names stay readable.
    const lanes = packLanes(list, now, span * 0.03);
    const bar = (x) => {
        const s = Math.max(from, Date.parse(x.startedAt));
        const e = x.endedAt ? Date.parse(x.endedAt) : now;
        const left = pos(s);
        const width = Math.max(0.6, pos(e) - left);
        const dur = helperTime(x, now);
        return h("b", { class: `lane-bar hs-${x.status}`, style: `left:${left}%;width:${width}%`, title: `${x.name} · ${HELPER_LABEL[x.status]}${dur ? ` · ${dur}` : ""}${x.phaseId ? ` · ${x.phaseId.toUpperCase()}` : ""}${x.description ? `\n${x.description}` : ""}${x.error ? `\n${x.error}` : ""}` }, h("span", {}, x.name));
    };
    const running = list.filter((x) => x.status === "running").length;
    const label = `${plural(list.length, "helper")}${running ? ` · ${running} running` : ""}`;
    const many = lanes.length > LANES_MAX;
    if (many && !open) {
        // Concurrency over time: how many helpers were running in each slice.
        const N = 72;
        const counts = new Array(N).fill(0);
        const failed = new Array(N).fill(false);
        for (const x of list) {
            const s = Math.max(from, Date.parse(x.startedAt));
            const e = x.endedAt ? Date.parse(x.endedAt) : now;
            for (let i = Math.floor(((s - from) / span) * N); i <= Math.min(N - 1, Math.floor(((e - from) / span) * N)); i++) {
                if (i < 0) continue;
                counts[i]++;
                if (x.status === "failed") failed[i] = true;
            }
        }
        const mx = Math.max(1, ...counts);
        put(
            host,
            h("button", { class: "lanes-h", title: "Show one lane per helper", "aria-expanded": "false", onclick: onToggle }, "▸ ", label, h("span", { class: "muted" }, ` · at most ${mx} at once`)),
            h("div", { class: "lanes-sum", role: "img", "aria-label": `${label}; at most ${mx} at once` }, counts.map((c, i) => h("i", c ? { title: `${c} running`, class: failed[i] ? "f" : "" } : {}, c ? h("b", { style: `height:${(c / mx) * 12}px` }) : null))),
        );
        return;
    }
    put(
        host,
        h("button", { class: "lanes-h", title: many ? "Collapse into one row" : "Helper agents the orchestrator started, on the same time axis", "aria-expanded": String(!!(many && open)), onclick: many ? onToggle : null, disabled: many ? null : "" }, many ? "▾ " : "", label),
        h("div", { class: `lanes${many ? " scroll" : ""}` }, lanes.map((items) => h("div", { class: "lane" }, items.map(bar)))),
    );
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
