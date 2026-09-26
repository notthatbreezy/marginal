// Fronts rail (spec §7.7, D5: sparklines live here only) and the checkpoint timeline + scrub replay (§7.8, D3).
import { h, put } from "../core.js";
import { buckets } from "./derive.js";

const ADD_CHAT_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

export function spark(values, w = 48, hgt = 14) {
    const mx = Math.max(...values, 1);
    const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(hgt - (v / mx) * (hgt - 2) - 1).toFixed(1)}`);
    return h("span", { html: `<svg width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" aria-hidden="true"><polygon class="area" points="0,${hgt} ${pts.join(" ")} ${w},${hgt}"/><polyline points="${pts.join(" ")}"/></svg>` });
}

/** fronts: [{front, add, del, files, offPlan, where:{phase, step}}]; opts: {focusId, onToggle, onHover, onAddChat, series: Map} */
export function renderFronts(host, rows, opts) {
    const counts = { active: 0, blocked: 0, done: 0 };
    for (const r of rows) counts[r.front.status]++;
    const label = [counts.active && `${counts.active} active`, counts.blocked && `${counts.blocked} blocked`, counts.done && `${counts.done} done`].filter(Boolean).join(" · ");
    const status = { active: [h("span", { class: "pulse" }), "Active"], blocked: "Blocked", done: "✓ Done" };
    const focused = document.activeElement?.closest?.(".front")?.dataset.front; // re-renders must not steal keyboard focus
    put(
        host,
        h("div", { class: "rail-h" }, "Fronts", h("span", { class: "n" }, label || "none yet")),
        rows.length
            ? h(
                  "ul",
                  { class: "fronts" },
                  rows.map((r) => {
                      const f = r.front;
                      const li = h(
                          "li",
                          {
                              class: `front f${f.color + 1}${opts.focusId && opts.focusId !== f.id ? " dimmed" : ""}${opts.focusId === f.id ? " focused" : ""}`,
                              tabindex: "0",
                              "aria-pressed": String(opts.focusId === f.id),
                              title: opts.focusId === f.id ? "Showing only this front on the map (click to show all)" : "Click to show only this front on the map",
                              "data-front": f.id,
                              onclick: (e) => !e.target.closest(".addchat") && opts.onToggle(f.id),
                              onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), opts.onToggle(f.id)),
                              onmouseenter: () => opts.onHover(f.id),
                              onmouseleave: () => opts.onHover(null),
                          },
                          h("div", { class: "row1" }, h("span", { class: "fdot" }), h("span", { class: "lbl" }, f.label), h("span", { class: `st ${f.status}` }, status[f.status])),
                          r.where.phase || r.where.step ? h("div", { class: "where" }, r.where.phase ? h("b", {}, r.where.phase) : null, r.where.phase && r.where.step ? h("br") : null, r.where.step ?? null) : null,
                          f.note ? h("div", { class: "note" }, f.note) : null,
                          f.baseDrift ? h("div", { class: "drift", title: "This worktree's HEAD no longer contains the plan base (rebased or merged); changes are measured from their merge-base." }, "⚠ base moved") : null,
                          h("div", { class: "row3" }, h("span", { class: "add" }, `+${r.add}`), h("span", { class: "del" }, `−${r.del}`), h("span", { class: "files" }, `${r.files} file${r.files === 1 ? "" : "s"}`), f.status !== "done" && opts.series.get(f.id) ? spark(opts.series.get(f.id)) : null),
                          r.offPlan ? h("div", { class: "opc" }, h("span", { class: "hatch-swatch" }), `${r.offPlan} off-plan`) : null,
                          opts.onAddChat ? h("button", { class: "addchat", title: "Add front to chat", "aria-label": `Add ${f.label} to chat`, html: ADD_CHAT_SVG, onclick: () => opts.onAddChat(f.id) }) : null,
                      );
                      return li;
                  }),
              )
            : h("p", { class: "rail-empty" }, "The orchestrator registers each worktree it edits as a front."),
    );
    if (focused) host.querySelector(`.front[data-front="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

/**
 * Timeline: phase track (widths ∝ elapsed for done/active), churn histogram stacked by front, scrubber + Live.
 * o: { plan, fronts, events, from, to, at (null = live), onScrub(ms|null), onPhase(phase, el) }
 */
export function renderTimeline(host, o) {
    const now = o.to;
    const phases = o.plan?.phases ?? [];
    const starts = phases.map((p) => (p.state.since ? Date.parse(p.state.since) : null));
    const seg = phases.map((p, i) => {
        const dur = p.state.status === "active" ? now - (starts[i] ?? now) : p.state.status === "done" ? Math.max(0, Date.parse(p.state.since) - (activeStart(p, i) ?? Date.parse(p.state.since))) : 0;
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
    function activeStart(p) {
        // When a phase is done its "since" is the completion time; approximate its start from the first event matching it.
        const ev = o.events.find((e) => e.phaseIds?.includes(p.id) && !e.initial);
        return ev ? Date.parse(ev.at) : null;
    }
    const N = 72;
    const b = buckets(o.events, { from: o.from, to: o.to, count: N });
    const totals = new Array(N).fill(0);
    for (const arr of b.values()) arr.forEach((v, i) => (totals[i] += v));
    const mx = Math.max(1, ...totals);
    const order = o.fronts.map((f) => f.id);
    const bars = totals.map((_, i) =>
        h(
            "i",
            {},
            order.filter((id) => b.get(id)?.[i]).map((id) => h("b", { class: `f${(o.fronts.find((f) => f.id === id)?.color ?? 5) + 1}`, style: `height:${(b.get(id)[i] / mx) * 22}px` })),
        ),
    );
    const pos = o.at === null ? 1 : (o.at - o.from) / Math.max(1, o.to - o.from);
    const live = o.at === null;
    // The skeleton persists across renders so an in-progress drag, pointer capture and keyboard focus survive the
    // 4 Hz live refresh; only its contents are replaced. Handlers read the latest options from host._tl.
    host._tl = o;
    if (!host._skel) host._skel = buildTimelineSkeleton(host);
    const { track, ctl, hist, playhead } = host._skel;
    const focused = document.activeElement?.closest?.(".seg")?.dataset.phase;
    put(track, seg.length ? seg : h("span", { class: "muted" }, "No checkpoints yet"));
    if (focused) track.querySelector(`.seg[data-phase="${CSS.escape(focused)}"]`)?.focus();
    put(
        ctl,
        h("span", { class: "replay-badge", style: live ? "visibility:hidden" : "" }, live ? "REPLAY 00:00" : `REPLAY ${new Date(o.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`),
        h("button", { class: `live-btn${live ? " is-live" : ""}`, title: live ? "You are watching live" : "Return to live", onclick: () => host._tl.onScrub(null) }, h("i"), live ? "Live" : "◀ Live"),
    );
    put(hist, bars);
    hist.setAttribute("aria-valuemin", String(o.from));
    hist.setAttribute("aria-valuemax", String(o.to));
    hist.setAttribute("aria-valuenow", String(o.at ?? o.to));
    hist.setAttribute("aria-valuetext", live ? "Live" : new Date(o.at).toLocaleTimeString());
    playhead.style.left = `calc(${(pos * 100).toFixed(2)}% - 1px)`;
}

function buildTimelineSkeleton(host) {
    const track = h("div", { class: "track" });
    const ctl = h("div", { class: "tl-ctl" });
    const hist = h("div", { class: "hist", role: "slider", "aria-label": "Replay position", tabindex: "0" });
    const playhead = h("div", { class: "playhead" });
    const wrap = h("div", { class: "hist-wrap" }, hist, playhead);
    const scrubAt = (clientX) => {
        const o = host._tl;
        const r = hist.getBoundingClientRect();
        const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
        o.onScrub(t > 0.995 ? null : Math.round(o.from + t * (o.to - o.from)));
    };
    wrap.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        hist.focus({ preventScroll: true, focusVisible: false });
        wrap.setPointerCapture(e.pointerId);
        scrubAt(e.clientX);
        const move = (ev) => scrubAt(ev.clientX);
        const up = () => {
            wrap.removeEventListener("pointermove", move);
            wrap.removeEventListener("pointerup", up);
            wrap.removeEventListener("lostpointercapture", up);
        };
        wrap.addEventListener("pointermove", move);
        wrap.addEventListener("pointerup", up);
        wrap.addEventListener("lostpointercapture", up);
    });
    hist.addEventListener("keydown", (e) => {
        const o = host._tl;
        const step = (o.to - o.from) / 60;
        const cur = o.at ?? o.to;
        if (e.key === "ArrowLeft") o.onScrub(Math.max(o.from, cur - step));
        else if (e.key === "ArrowRight") o.onScrub(cur + step >= o.to ? null : cur + step);
        else if (e.key === "Home") o.onScrub(o.from);
        else if (e.key === "End") o.onScrub(null);
        else return;
        e.preventDefault();
    });
    put(host, track, ctl, wrap);
    return { track, ctl, hist, playhead };
}
export function fmtDur(ms) {
    const m = Math.round(ms / 60_000);
    if (m < 1) return "<1m";
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
