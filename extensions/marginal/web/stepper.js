// Stepper: the shared shell for walking a list of stops (code tours, checkpoint walkthroughs).
// Owns layout, progress, navigation, keyboard and revision updates; callers supply the stage and stop renderers.
import { h, put } from "./core.js";

const CLOSE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
let active = null; // only one stepper handles the keyboard at a time

/**
 * @param {object} o
 * @param {HTMLElement} o.mount           where the stepper root is appended
 * @param {string} o.id                   element id / class variant ("tour" | "walkthrough")
 * @param {string} o.label                accessible name
 * @param {Array<{id:string,title:string}>} o.stops
 * @param {(stops:any[]) => Node} o.renderStage   left column; children with [data-i] are clickable stops
 * @param {(stop:any, i:number, api:object) => Node[]} o.renderStop
 * @param {(i:number) => void} [o.onStop]         after a stop becomes current (e.g. map linkage)
 * @param {() => void} [o.onAsk]
 * @param {string} [o.askLabel]
 * @param {() => void} [o.onClose]
 * @param {Node} [o.headerExtra]                  extra node in the top bar (e.g. revising chip)
 * @param {(stops:any[]) => number} [o.findStage] map a clicked [data-unit] to a stop index
 * @param {Array<{label:string,title?:string,onClick:(i:number,stop:any)=>void}>} [o.actions] extra footer buttons (per-stop actions)
 * @param {boolean|"stage"|"pane"} [o.dock] reserve a slot for a conversation that spans the whole walk (api.dock):
 *        "stage" puts it under the left column (keeps the stop's content unobstructed), "pane"/true above the footer
 */
export function createStepper(o) {
    let stops = o.stops;
    let i = 0;
    const stage = h("div", { class: "tour-stage" });
    const progress = h("div", { class: "tour-progress", role: "tablist", "aria-label": "Steps" });
    const body = h("div", { class: "tour-body" });
    const count = h("span", { class: "tour-count" });
    const prev = h("button", { class: "tour-prev", onclick: () => go(i - 1) }, h("kbd", {}, "←"), "Back");
    const next = h("button", { class: "tour-next primary", onclick: () => (i >= stops.length - 1 ? close() : go(i + 1)) });
    const dock = o.dock ? h("div", { class: `tour-dock dock-${o.dock === "stage" ? "stage" : "pane"}` }) : null;
    const inStage = o.dock === "stage";
    const pane = h(
        "div",
        { class: "tour-pane" },
        h("header", { class: "tour-top" }, progress, o.headerExtra ?? null, h("button", { class: "chat-icon tour-close", title: "Close (Esc)", "aria-label": "Close", onclick: () => close(), html: CLOSE_SVG })),
        body,
        inStage ? null : dock,
        h(
            "footer",
            { class: "tour-nav" },
            count,
            (o.actions ?? []).map((a) => h("button", { class: "tour-ask ghost", title: a.title ?? a.label, onclick: () => a.onClick(i, stops[i]) }, a.label)),
            o.onAsk ? h("button", { class: "tour-ask", onclick: () => o.onAsk(i, stops[i]) }, o.askLabel ?? "Ask about this step") : null,
            prev,
            next,
        ),
    );
    const root = h("div", { id: o.id, class: `stepper stepper-${o.id}`, role: "dialog", "aria-modal": o.modal === false ? "false" : "true", "aria-label": o.label }, inStage ? h("div", { class: "tour-left" }, stage, dock) : stage, pane);
    stage.addEventListener(
        "click",
        (e) => {
            const hit = e.target.closest("[data-i], [data-unit]");
            if (!hit) return;
            e.stopPropagation();
            e.preventDefault();
            const j = hit.dataset.i !== undefined ? Number(hit.dataset.i) : stops.findIndex((s) => s.id === hit.dataset.unit);
            if (j >= 0) go(j);
        },
        true,
    );

    function build() {
        put(stage, o.renderStage(stops));
        put(
            progress,
            stops.map((st, k) => h("button", { role: "tab", title: `${k + 1}. ${st.title}`, "aria-label": `Step ${k + 1}: ${st.title}`, onclick: () => go(k) })),
        );
    }

    function go(k, { animate = true } = {}) {
        if (!root.isConnected) return;
        const n = stops.length;
        i = Math.max(0, Math.min(n - 1, k));
        const st = stops[i];
        put(body, o.renderStop(st, i, api));
        if (animate) {
            body.classList.remove("enter");
            void body.offsetWidth; // restart the entrance
            body.classList.add("enter");
            body.scrollTop = 0;
        }
        progress.querySelectorAll("button").forEach((btn, j) => {
            btn.classList.toggle("done", j < i);
            btn.classList.toggle("on", j === i);
            btn.setAttribute("aria-selected", String(j === i));
        });
        count.textContent = `${i + 1} of ${n}`;
        prev.disabled = i === 0;
        next.replaceChildren(i >= n - 1 ? "Done" : "Next", h("kbd", {}, "→"));
        stage.querySelectorAll("[data-i]").forEach((el) => {
            const j = Number(el.dataset.i);
            el.classList.toggle("done", j < i);
            el.classList.toggle("active", j === i);
        });
        stage.querySelectorAll("[data-unit]").forEach((g) => g.classList.toggle("tour-active", g.dataset.unit === st.id));
        stage.querySelector("[data-i].active, .tour-active")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        o.onStop?.(i, st);
    }

    function close() {
        if (!root.isConnected) return;
        root.remove();
        if (active === api) active = null;
        o.onClose?.();
    }

    /** Replace stops in place (agent revisions); keeps the user on the same stop id, or its nearest neighbour. */
    function update(newStops, { focusId } = {}) {
        const currentId = stops[i]?.id;
        const oldIndex = i;
        stops = newStops;
        build();
        let k = stops.findIndex((s) => s.id === (focusId ?? currentId));
        if (k < 0) k = Math.min(oldIndex, stops.length - 1);
        go(k, { animate: !!focusId || stops[k]?.id !== currentId });
    }

    const api = {
        root,
        dock,
        go,
        close,
        update,
        get index() {
            return i;
        },
        get stops() {
            return stops;
        },
    };

    build();
    o.mount.append(root);
    active = api;
    go(0);
    next.focus({ preventScroll: true });
    return api;
}

document.addEventListener("keydown", (e) => {
    if (!active || !active.root.isConnected || e.target.closest?.("textarea, input, select, [contenteditable], [role=slider]") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = active.index;
    if (["ArrowRight", "ArrowDown", "j", "PageDown"].includes(e.key)) {
        e.preventDefault();
        active.go(k + 1);
    } else if (["ArrowLeft", "ArrowUp", "k", "PageUp"].includes(e.key)) {
        e.preventDefault();
        active.go(k - 1);
    } else if (e.key === "Home") active.go(0);
    else if (e.key === "End") active.go(active.stops.length - 1);
});

/** The currently active stepper, if any (Escape handling, FAB visibility). */
export const activeStepper = () => (active?.root.isConnected ? active : null);
