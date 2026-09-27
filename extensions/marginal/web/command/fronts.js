// Fronts rail (per-front sparklines live here only) and the checkpoint timeline (the plan's phases).
import { h, put } from "../core.js";
import { buckets } from "./derive.js";

const ADD_CHAT_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

export function spark(values, w = 48, hgt = 14) {
    const mx = Math.max(...values, 1);
    const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(hgt - (v / mx) * (hgt - 2) - 1).toFixed(1)}`);
    return h("span", { html: `<svg width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" aria-hidden="true"><polygon class="area" points="0,${hgt} ${pts.join(" ")} ${w},${hgt}"/><polyline points="${pts.join(" ")}"/></svg>` });
}

/** fronts: [{front, add, del, files, offPlan, where:{phase, step}}]; opts: {focusId, onToggle, onHover, onAddChat, series: Map} */
// Stages in the order the rail lists them: what's moving first, then what's waiting, then what's finished.
export const STAGES = ["implementing", "review", "blocked", "planned", "complete"];
const STAGE = {
    implementing: { badge: () => [h("span", { class: "pulse" }), "Implementing"], count: "implementing" },
    review: { badge: () => [h("span", { class: "eye", "aria-hidden": "true" }), "In review"], count: "in review" },
    blocked: { badge: () => "Blocked", count: "blocked" },
    planned: { badge: () => "Planned", count: "planned" },
    complete: { badge: () => "✓ Complete", count: "complete" },
};
const stageOf = (s) => (s === "active" ? "implementing" : s === "done" ? "complete" : STAGE[s] ? s : "implementing");

export function renderFronts(host, rows, opts) {
    rows = rows.map((r) => ({ ...r, stage: stageOf(r.front.status) })).sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const r of rows) counts[r.stage]++;
    const label = STAGES.filter((s) => counts[s]).map((s) => h("span", { class: `rc ${s}`, title: `${counts[s]} ${STAGE[s].count}` }, h("i"), counts[s]));
    const focused = document.activeElement?.closest?.(".front")?.dataset.front; // re-renders must not steal keyboard focus
    const [header, body] = [
        h("div", { class: "rail-h" }, "Fronts", h("span", { class: "n" }, label.length ? label : "none yet")),
        rows.length
            ? h(
                  "ul",
                  { class: "fronts" },
                  rows.map((r) => {
                      const f = r.front;
                      // A planned front has nothing on the map yet, so it can't be picked to filter it.
                      const idle = !f.worktree;
                      const below = f.stacksOn && rows.find((x) => x.front.id === f.stacksOn)?.front;
                      const heir = f.handedTo && rows.find((x) => x.front.id === f.handedTo)?.front;
                      const li = h(
                          "li",
                          {
                              class: `front f${f.color + 1} s-${r.stage}${idle ? " idle" : ""}${opts.focusId && opts.focusId !== f.id ? " dimmed" : ""}${opts.focusId === f.id ? " focused" : ""}`,
                              tabindex: idle ? null : "0",
                              "aria-pressed": idle ? null : String(opts.focusId === f.id),
                              "aria-disabled": idle ? "true" : null,
                              title: idle ? "Planned: shows on the map once its worktree is registered" : opts.focusId === f.id ? "Showing only this front on the map (click to show all)" : "Click to show only this front on the map",
                              "data-front": f.id,
                              onclick: (e) => !idle && !e.target.closest(".addchat") && opts.onToggle(f.id),
                              onkeydown: (e) => !idle && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), opts.onToggle(f.id)),
                              onmouseenter: () => !idle && opts.onHover(f.id),
                              onmouseleave: () => !idle && opts.onHover(null),
                          },
                          h("div", { class: "row1" }, h("span", { class: "fdot" }), h("span", { class: "lbl" }, f.label), h("span", { class: `st ${r.stage}`, title: f.statusSince ? `Since ${new Date(f.statusSince).toLocaleString()}` : null }, STAGE[r.stage].badge())),
                          r.where.phase || r.where.step ? h("div", { class: "where" }, r.where.phase ? h("b", {}, r.where.phase) : null, r.where.phase && r.where.step ? h("br") : null, r.where.step ?? null) : null,
                          below || heir ? h("div", { class: "stack" }, below ? h("span", { title: `A stacked layer: its changes are measured from "${below.label}"` }, "▴ on ", h("b", {}, below.label)) : null, below && heir ? " · " : null, heir ? h("span", { title: `Its worktree now belongs to "${heir.label}"; these totals are where it finished` }, "handed to ", h("b", {}, heir.label)) : null) : null,
                          f.note ? h("div", { class: `note${r.stage === "blocked" ? " why" : ""}` }, f.note) : null,
                          f.baseDrift ? h("div", { class: "drift", title: f.stacksOn ? "This worktree no longer contains the layer below's latest commit (it moved on, or this one was rebased); changes are measured from their merge-base." : "This worktree's HEAD no longer contains the plan base (rebased or merged); changes are measured from their merge-base." }, "⚠ base moved") : null,
                          // A planned front has no worktree yet, so nothing to count.
                          r.stage === "planned" && !f.worktree
                              ? h("div", { class: "row3 muted" }, "No worktree yet")
                              : h("div", { class: "row3" }, h("span", { class: "add" }, `+${r.add}`), h("span", { class: "del" }, `−${r.del}`), h("span", { class: "files" }, `${r.files} file${r.files === 1 ? "" : "s"}`), r.stage !== "complete" && opts.series.get(f.id) ? spark(opts.series.get(f.id)) : null),
                          r.offPlan ? h("div", { class: "opc" }, h("span", { class: "hatch-swatch" }), `${r.offPlan} off-plan`) : null,
                          opts.onAddChat ? h("button", { class: "addchat", title: "Add front to chat", "aria-label": `Add ${f.label} to chat`, html: ADD_CHAT_SVG, onclick: () => opts.onAddChat(f.id) }) : null,
                      );
                      return li;
                  }),
              )
            : h("p", { class: "rail-empty" }, "The orchestrator lists the fronts it plans, then registers each one's worktree as its work starts."),
    ];
    // Keep the scrolling list element itself: replacing it mid-scroll strands the wheel's smooth scroll on a detached
    // node, so the list snaps back to the top on every update.
    const list = host.querySelector(":scope > ul.fronts");
    if (list && body.tagName === "UL") {
        const top = list.scrollTop;
        const old = host.querySelector(":scope > .rail-h");
        if (old) old.replaceWith(header);
        else host.prepend(header);
        list.replaceChildren(...body.childNodes);
        list.scrollTop = top;
    } else put(host, header, body);
    if (focused) host.querySelector(`.front[data-front="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

/**
 * Timeline: the plan's phases in order (widths ∝ elapsed for done/active; click one for its menu), over a histogram
 * of edits across the same span, stacked by front. The histogram is read-only.
 * o: { plan, fronts, events, from, now, onPhase(phase, el) }
 */
export function renderTimeline(host, o) {
    const now = o.now;
    const phases = o.plan?.phases ?? [];
    const starts = phases.map((p) => (p.state.since ? Date.parse(p.state.since) : null));
    function activeStart(p) {
        // When a phase is done its "since" is the completion time; approximate its start from the first event matching it.
        const ev = o.events.find((e) => e.phaseIds?.includes(p.id) && !e.initial);
        return ev ? Date.parse(ev.at) : null;
    }
    const seg = phases.map((p, i) => {
        const dur = p.state.status === "active" ? now - (starts[i] ?? now) : p.state.status === "done" ? Math.max(0, Date.parse(p.state.since) - (activeStart(p) ?? Date.parse(p.state.since))) : 0;
        const flex = p.state.status === "pending" ? 1 : Math.max(1.4, Math.min(8, 1 + dur / 300_000));
        const glyph = p.state.status === "done" ? "✓" : "";
        return h(
            "button",
            { class: `seg ${p.state.status === "pending" ? "" : p.state.status}`, "data-phase": p.id, style: `flex:${flex}`, title: `${p.title} · ${p.state.status}`, onclick: (e) => o.onPhase?.(p, e.currentTarget) },
            h("span", { class: "gl" }, glyph),
            h("span", { class: "ttl" }, `${p.id.toUpperCase()} · ${p.title}`),
            dur ? h("span", { class: "dur" }, fmtDur(dur)) : null,
        );
    });
    // Track and histogram persist across the 4 Hz refresh so keyboard focus on a phase survives it.
    if (!host._track) {
        host._track = h("div", { class: "track" });
        host._hist = h("div", { class: "hist", role: "img" });
        put(host, host._track, host._hist);
    }
    const focused = document.activeElement?.closest?.(".seg")?.dataset.phase;
    put(host._track, seg.length ? seg : h("span", { class: "muted" }, "No checkpoints yet"));
    if (focused) host._track.querySelector(`.seg[data-phase="${CSS.escape(focused)}"]`)?.focus();
    const N = 72;
    const from = Math.min(o.from ?? now, now - 60_000);
    const b = buckets(o.events, { from, to: now, count: N });
    const totals = new Array(N).fill(0);
    for (const arr of b.values()) arr.forEach((v, i) => (totals[i] += v));
    const mx = Math.max(1, ...totals);
    const fronts = o.fronts ?? [];
    const span = (now - from) / N;
    const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    put(
        host._hist,
        totals.map((tot, i) =>
            h(
                "i",
                tot ? { title: `${hhmm(from + i * span)}–${hhmm(from + (i + 1) * span)} · ${tot} line${tot === 1 ? "" : "s"} changed` } : {},
                fronts.filter((f) => b.get(f.id)?.[i]).map((f) => h("b", { class: `f${f.color + 1}`, style: `height:${(b.get(f.id)[i] / mx) * 22}px` })),
            ),
        ),
    );
    host._hist.setAttribute("aria-label", `Edits over time by front, ${hhmm(from)} to now`);
}

export function fmtDur(ms) {
    const m = Math.round(ms / 60_000);
    if (m < 1) return "<1m";
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
