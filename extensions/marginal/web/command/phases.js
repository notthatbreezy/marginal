// Phases rail: the plan's phases as the unit of work. Each is a deliverable: its stage, what it builds, what it has
// changed so far, and its recent pace. Fronts (worktrees) are plumbing; they only get a section when there are several.
import { h, put } from "../core.js";
import { spark } from "./fronts.js";
import { otherCard, phaseProgress } from "./progress.js";

/** Phase status (stored) → the stage shown. */
export const PHASE_STAGE = { pending: "planned", active: "implementing", review: "review", blocked: "blocked", done: "complete" };
const BADGE = {
    implementing: () => [h("span", { class: "pulse" }), "Implementing"],
    review: () => [h("span", { class: "eye", "aria-hidden": "true" }), "In review"],
    blocked: () => "Blocked",
    planned: () => "Planned",
    complete: () => "✓ Complete",
};
const ORDER = ["implementing", "review", "blocked", "planned", "complete"];

/** What a phase delivers, short: its first few expected paths. */
function deliverables(ph) {
    // Stored patterns are {kind:"dir"|"file", path} or {kind:"glob", glob}; show them as written.
    const text = (p) => (typeof p === "string" ? p : p.kind === "glob" ? p.glob : p.kind === "dir" ? `${p.path}/` : p.path);
    const pats = [...new Set([...(ph.expects ?? []), ...ph.steps.flatMap((s) => s.expects ?? [])].map(text))];
    if (!pats.length) return null;
    const shown = pats.slice(0, 3);
    return h("div", { class: "deliv", title: pats.join("\n") }, shown.map((p, i) => [i ? ", " : null, h("code", {}, p)]), pats.length > shown.length ? ` +${pats.length - shown.length}` : null);
}

/**
 * rows: [{ phase, stage, add, del, files, series:number[] }] in plan order.
 * opts: { focusId, onToggle(id), onHover(id|null), onAddChat?(phase), progress? (the server's progress summary) }
 */
export function renderPhases(host, rows, opts) {
    const counts = Object.fromEntries(ORDER.map((s) => [s, 0]));
    for (const r of rows) counts[r.stage]++;
    const header = h(
        "div",
        { class: "rail-h" },
        "Phases",
        h(
            "span",
            { class: "n" },
            ORDER.filter((s) => counts[s]).map((s) => h("span", { class: `rc ${s}`, title: `${counts[s]} ${s === "review" ? "in review" : s}` }, h("i"), counts[s])),
        ),
    );
    const focused = document.activeElement?.closest?.(".phase-row")?.dataset.phase; // re-renders keep keyboard focus
    const items = rows.map((r) => {
        const p = r.phase;
        const step = p.steps.find((s) => s.state.status === "active");
        const on = opts.focusId === p.id;
        const pg = opts.progress?.phases?.[p.id];
        // Now: the phase's todo in progress (observed), else the plan step marked active.
        const nowText = pg?.now ?? step?.title ?? null;
        return h(
            "li",
            {
                class: `front phase-row ps-${r.stage}${opts.focusId && !on ? " dimmed" : ""}${on ? " focused" : ""}`,
                tabindex: "0",
                "data-phase": p.id,
                "aria-pressed": String(on),
                title: on ? "Showing only this phase's files on the map (click to show all)" : "Click to show only this phase's files on the map",
                onclick: (e) => !e.target.closest(".addchat") && opts.onToggle(p.id),
                onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), opts.onToggle(p.id)),
                onmouseenter: () => opts.onHover?.(p.id),
                onmouseleave: () => opts.onHover?.(null),
            },
            h(
                "div",
                { class: "row1" },
                h("span", { class: "fdot" }),
                h("span", { class: "lbl" }, h("span", { class: "pid" }, p.id.toUpperCase()), " ", p.title),
                h("span", { class: `st ${r.stage}`, title: p.state.since ? `Since ${new Date(p.state.since).toLocaleString()}` : null }, BADGE[r.stage]()),
            ),
            deliverables(p),
            nowText ? h("div", { class: "where" }, "Now: ", h("b", {}, nowText)) : null,
            phaseProgress(pg),
            p.state.note ? h("div", { class: `note${r.stage === "blocked" ? " why" : ""}` }, p.state.note) : null,
            r.stage === "planned" && !r.files
                ? null
                : h("div", { class: "row3" }, h("span", { class: "add" }, `+${r.add}`), h("span", { class: "del" }, `−${r.del}`), h("span", { class: "files" }, `${r.files} file${r.files === 1 ? "" : "s"}`), r.stage !== "complete" && r.series?.some((v) => v) ? spark(r.series) : null),
            opts.onAddChat ? h("button", { class: "addchat", title: "Add phase to chat", "aria-label": `Add ${p.id} to chat`, html: opts.chatIcon ?? "", onclick: () => opts.onAddChat(p) }) : null,
        );
    });
    if (opts.progress?.other) items.push(otherCard(opts.progress.other));
    // Keep the scrolling list itself (replacing it mid-scroll snaps it back to the top), as the fronts rail does.
    const list = host.querySelector(":scope > ul.fronts");
    if (list) {
        const top = list.scrollTop;
        host.querySelector(":scope > .rail-h")?.replaceWith(header);
        list.replaceChildren(...(items.length ? items : [h("li", { class: "rail-empty" }, "No phases yet")]));
        list.scrollTop = top;
    } else put(host, header, h("ul", { class: "fronts phases" }, items.length ? items : h("li", { class: "rail-empty" }, "No phases yet")));
    if (focused) host.querySelector(`.phase-row[data-phase="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
