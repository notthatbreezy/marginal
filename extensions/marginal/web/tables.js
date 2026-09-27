// Table width in docs, the Confluence way: a table can sit in the reading column, go wide (the width diagrams use) or
// span the full panel, and its column borders can be dragged. Tables that don't fit the column start wide on their
// own. These are reading preferences, so they're kept per viewer (localStorage), keyed by doc, block and table.
import { h } from "./core.js";

const STORE = "marginal.tables";
const MIN_COL = 48;
const MODES = [
    { id: "text", label: "Text width", title: "Fit the reading column" },
    { id: "wide", label: "Wide", title: "As wide as the diagrams" },
    { id: "full", label: "Full width", title: "Edge to edge of the panel" },
];
const icon = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
    text: icon('<rect x="4.5" y="3" width="7" height="10" rx="1"/><path d="M1.5 8h1M13.5 8h1"/>'),
    wide: icon('<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M5 8h6"/>'),
    full: icon('<rect x="1" y="3" width="14" height="10" rx="1"/><path d="M3.5 8h9M5 6.5 3.5 8 5 9.5M11 6.5 12.5 8 11 9.5"/>'),
};

function load() {
    try {
        return JSON.parse(localStorage.getItem(STORE) ?? "{}") ?? {};
    } catch {
        return {};
    }
}
function save(all) {
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete all[k]; // oldest first; stay small
    try {
        localStorage.setItem(STORE, JSON.stringify(all));
    } catch {}
}

/** @param {{ main: HTMLElement, docId: () => string|null, onLayout?: (table: HTMLElement) => void }} o */
export function createTables(o) {
    let prefs = load();
    const natural = new WeakMap();

    const keyOf = (t) => {
        const block = t.closest(".block[data-id]");
        const all = [...block.querySelectorAll(":scope > .md table")];
        return `${o.docId()}|${block.dataset.id}|${all.indexOf(t)}|${columnsOf(t).length}`;
    };
    const columnsOf = (t) => [...(t.rows[0]?.cells ?? [])];
    const pref = (t) => prefs[keyOf(t)] ?? {};
    function setPref(t, patch) {
        const k = keyOf(t);
        const next = { ...(prefs[k] ?? {}), ...patch };
        for (const [f, v] of Object.entries(next)) if (v === undefined || v === null) delete next[f];
        delete prefs[k];
        if (Object.keys(next).length) prefs[k] = next; // re-insert: most recent last
        save(prefs);
    }

    /** The table's width with nothing wrapping, measured once per render. */
    function naturalWidth(t) {
        if (natural.has(t)) return natural.get(t);
        const saved = t.getAttribute("style");
        t.classList.remove("tw-out", "tw-cols");
        Object.assign(t.style, { display: "table", width: "max-content", tableLayout: "auto" });
        const w = t.offsetWidth;
        if (saved === null) t.removeAttribute("style");
        else t.setAttribute("style", saved);
        natural.set(t, w);
        return w;
    }
    function widths(t) {
        const column = t.closest(".md").getBoundingClientRect().width;
        const cs = getComputedStyle(o.main);
        // Full width still leaves a margin on each side for the comment/copy/width icons.
        const full = o.main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2 * 32;
        const doc = Math.min(t.closest(".doc")?.getBoundingClientRect().width ?? full, full);
        return { column, doc, full };
    }

    /** Resolve the mode (explicit, or auto: wide when the table doesn't fit the column) and lay the table out. */
    function apply(t) {
        const p = pref(t);
        const w = widths(t);
        const nat = naturalWidth(t);
        const auto = !p.mode;
        const mode = p.mode ?? (nat > w.column * 1.08 ? "wide" : "text");
        let width = null; // null = the default reading-column layout
        if (mode === "wide") width = auto ? Math.min(nat + 2, w.doc) : w.doc;
        else if (mode === "full") width = w.full;
        if (width !== null && width <= w.column + 1) width = null;
        t.dataset.tw = mode;
        t.dataset.twAuto = auto ? "1" : "";
        t.classList.toggle("tw-out", width !== null);
        if (width !== null) t.style.setProperty("--tw", `${Math.round(width)}px`);
        else t.style.removeProperty("--tw");
        const cols = Array.isArray(p.cols) && p.cols.length === columnsOf(t).length ? p.cols : null;
        t.classList.toggle("tw-cols", !!cols);
        let cg = t.querySelector(":scope > colgroup.tw");
        if (cols) {
            if (!cg) {
                cg = h("colgroup", { class: "tw" });
                t.prepend(cg);
            }
            cg.replaceChildren(...cols.map((f) => h("col", { style: `width:${(f * 100).toFixed(3)}%` })));
        } else cg?.remove();
    }

    function enhance() {
        for (const t of o.main.querySelectorAll(".block[data-id] > .md table")) apply(t);
    }
    let raf = 0;
    addEventListener("resize", () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            for (const t of o.main.querySelectorAll(".block[data-id] > .md table")) {
                natural.delete(t);
                apply(t);
            }
        });
    });

    // ---- width menu, opened from the margin button beside a hovered table ----
    let menuFor = null;
    const menu = h("div", { id: "tw-menu", role: "menu", "aria-label": "Table width", hidden: true });
    function openMenu(t, anchor) {
        menuFor = t;
        const cur = t.dataset.tw;
        const auto = t.dataset.twAuto === "1";
        const hasCols = !!pref(t).cols;
        const items = [
            ...MODES.map((m) =>
                h(
                    "button",
                    { role: "menuitemradio", "aria-checked": String(cur === m.id), class: cur === m.id ? "on" : "", title: m.title, onclick: () => choose(m.id) },
                    h("span", { class: "tw-ic", html: ICONS[m.id] }),
                    h("span", { class: "tw-l" }, m.label),
                    cur === m.id && auto ? h("span", { class: "tw-auto" }, "auto") : null,
                ),
            ),
            hasCols ? h("div", { class: "tw-sep" }) : null,
            hasCols ? h("button", { role: "menuitem", title: "Undo column resizing", onclick: () => resetCols() }, h("span", { class: "tw-ic" }), h("span", { class: "tw-l" }, "Reset columns")) : null,
            h("div", { class: "tw-hint" }, "Drag a column border to resize"),
        ];
        menu.replaceChildren(...items.filter(Boolean));
        anchor.append(menu);
        menu.hidden = false;
        menu.querySelector("button.on, button")?.focus({ preventScroll: true });
    }
    function closeMenu() {
        menu.hidden = true;
        menuFor = null;
    }
    function choose(mode) {
        const t = menuFor;
        if (!t) return;
        setPref(t, { mode });
        apply(t);
        closeMenu();
        o.onLayout?.(t);
    }
    function resetCols() {
        const t = menuFor;
        if (!t) return;
        setPref(t, { cols: undefined });
        apply(t);
        closeMenu();
        o.onLayout?.(t);
    }
    menu.addEventListener("keydown", (e) => {
        const items = [...menu.querySelectorAll("button")];
        const i = items.indexOf(document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeMenu();
        }
    });
    document.addEventListener("pointerdown", (e) => !menu.hidden && !e.target.closest?.("#tw-menu, #g-width") && closeMenu(), true);

    // ---- column borders: a grip line appears over the border under the pointer; drag it, double-click to reset ----
    const grip = h("div", { id: "col-grip", hidden: true, title: "Drag to resize · double-click to reset" });
    document.body.append(grip);
    let hover = null; // { t, i } the border right of column i
    function borders(t) {
        const cells = columnsOf(t);
        return cells.slice(0, -1).map((c) => c.getBoundingClientRect().right);
    }
    o.main.addEventListener(
        "pointermove",
        (e) => {
            if (e.buttons || drag) return;
            const t = e.target.closest?.(".block[data-id] > .md table");
            if (!t || columnsOf(t).length < 2) return hideGrip();
            const xs = borders(t);
            const i = xs.findIndex((x) => Math.abs(x - e.clientX) <= 4);
            if (i < 0) return hideGrip();
            const r = t.getBoundingClientRect();
            const view = o.main.getBoundingClientRect();
            const top = Math.max(r.top, view.top);
            const bottom = Math.min(r.bottom, view.bottom);
            if (bottom <= top) return hideGrip();
            hover = { t, i };
            Object.assign(grip.style, { left: `${xs[i] - 4}px`, top: `${top}px`, height: `${bottom - top}px` });
            grip.hidden = false;
        },
        { passive: true },
    );
    grip.addEventListener("pointerleave", () => !drag && hideGrip());
    o.main.addEventListener("scroll", () => !drag && hideGrip(), { passive: true });
    function hideGrip() {
        if (drag) return;
        grip.hidden = true;
        hover = null;
    }
    let drag = null;
    grip.addEventListener("pointerdown", (e) => {
        if (!hover || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        grip.setPointerCapture(e.pointerId);
        const { t, i } = hover;
        const start = columnsOf(t).map((c) => c.getBoundingClientRect().width);
        const total = start.reduce((a, b) => a + b, 0);
        drag = { t, i, x: e.clientX, start, total, gx: parseFloat(grip.style.left) };
        grip.classList.add("dragging");
        document.documentElement.classList.add("col-resizing");
    });
    grip.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const { t, i, start, total } = drag;
        const pair = start[i] + start[i + 1];
        const a = Math.max(MIN_COL, Math.min(pair - MIN_COL, start[i] + (e.clientX - drag.x)));
        const cols = start.map((w, k) => (k === i ? a : k === i + 1 ? pair - a : w) / total);
        drag.cols = cols;
        // Freeze the current table width so only these two columns trade space.
        if (!t.classList.contains("tw-out")) t.style.setProperty("--tw", `${Math.round(total)}px`);
        setPref(t, { cols });
        apply(t);
        grip.style.left = `${drag.gx + (a - start[i])}px`;
    });
    const endDrag = () => {
        if (!drag) return;
        const { t } = drag;
        drag = null;
        grip.classList.remove("dragging");
        document.documentElement.classList.remove("col-resizing");
        o.onLayout?.(t);
    };
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);
    grip.addEventListener("dblclick", () => {
        if (!hover) return;
        const { t } = hover;
        setPref(t, { cols: undefined });
        apply(t);
        hideGrip();
        o.onLayout?.(t);
    });

    return {
        enhance,
        toggleMenu(t, anchor) {
            if (!menu.hidden && menuFor === t) return closeMenu();
            openMenu(t, anchor);
        },
        menuOpen: () => !menu.hidden,
        closeMenu,
        isGrip: (el) => el === grip,
    };
}
