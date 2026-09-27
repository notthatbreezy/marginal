// Doc navigation: a Contents card (top-left, minimizable, closable, reopened from the header) and a Ctrl/⌘-J jump
// palette, both over the outline in outline.js.
import { $, h } from "./core.js";
import { KIND_LABEL, outlineOf, rank } from "./outline.js";

const svg = (d, extra = "") => `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;
const ICON = {
    sequence: svg('<path d="M4 2.5v11M12 2.5v11M4 6h7M9.5 4.5 11 6 9.5 7.5M12 10.5H5M6.5 9 5 10.5 6.5 12"/>'),
    flow_diagram: svg('<rect x="1.8" y="2" width="5" height="4" rx="1"/><rect x="9.2" y="10" width="5" height="4" rx="1"/><path d="M4.3 6v3.2c0 .9.5 1.4 1.4 1.4h3.5"/>'),
    call_stack_diff: svg('<path d="M2.5 3.5h11M4.5 8h9M6.5 12.5h7"/>'),
    database_lens: svg('<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>'),
    code_peek: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
    code: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
    callout: svg('<path d="M8 2.2 14.3 13H1.7z"/><path d="M8 6.5v3M8 11.3v.2"/>'),
    heading: svg('<path d="M4 2.5 3 13.5M10 2.5l-1 11M1.8 6h12M1.3 10h12"/>'),
    image: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m2.5 11.5 3.5-3.5 3 3 2-2 2.5 2.5"/>'),
};
const CLOSE = svg('<path d="M4 4l8 8M12 4l-8 8"/>', ' stroke-width="1.6"');
const MIN = svg('<path d="M4 8.5h8"/>', ' stroke-width="1.6"');
const OUTLINE = svg('<path d="M2.5 3.5h11M5.5 8h8M5.5 12.5h8M2.5 8h.01M2.5 12.5h.01"/>');

/**
 * @param {{ main: HTMLElement, getDoc: () => any, active: () => boolean, expand: (blockId: string) => void,
 *           showBoard: () => Promise<void>|void, blocked: () => boolean }} o
 *   active: the Doc tab is showing a doc; expand: record a section as open; blocked: a modal (tour) owns the screen.
 */
export function createToc(o) {
    const KEY = "marginal.toc";
    let entries = [];
    const saved = () => {
        try {
            return localStorage.getItem(KEY);
        } catch {
            return null;
        }
    };
    const save = (v) => {
        try {
            localStorage.setItem(KEY, v);
        } catch {}
    };

    // ---- card ----
    const list = h("nav", { class: "toc-list", "aria-label": "Sections" });
    const minBtn = h("button", { class: "chat-icon toc-min", title: "Minimize", "aria-label": "Minimize contents", html: MIN, onclick: (e) => (e.stopPropagation(), setMode(mode === "min" ? "open" : "min", true)) });
    const closeBtn = h("button", { class: "chat-icon toc-x", title: "Close (reopen from the header)", "aria-label": "Close contents", html: CLOSE, onclick: (e) => (e.stopPropagation(), setMode("closed", true)) });
    const bar = h(
        "div",
        { class: "toc-bar", onclick: () => mode === "min" && setMode("open", true), title: "" },
        h("span", { class: "toc-ic", html: OUTLINE }),
        h("span", { class: "toc-h" }, "Contents"),
        h("kbd", { class: "toc-kbd", title: "Jump to a section" }, /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘J" : "Ctrl J"),
        minBtn,
        closeBtn,
    );
    const card = h("aside", { id: "toc", hidden: true, "aria-label": "Contents" }, bar, list);
    document.body.append(card);

    // Sit just under the header (which wraps on narrow panels) and never run off the bottom.
    const place = () => {
        const top = Math.round(o.main.getBoundingClientRect().top) + 12;
        card.style.top = `${top}px`;
        card.style.maxHeight = `${Math.max(120, innerHeight - top - 16)}px`;
    };
    new ResizeObserver(place).observe(o.main);
    addEventListener("resize", place);

    const btn = $("#toc-btn");
    btn.onclick = () => setMode(mode === "closed" ? "open" : "closed", true);

    let mode = "closed";
    /** Where the card should be when the user hasn't chosen: open if it fits beside the text, else a small pill. */
    function autoMode() {
        const docEl = o.main.querySelector(".doc");
        if (!docEl) return "min";
        const room = docEl.getBoundingClientRect().left - o.main.getBoundingClientRect().left;
        return room >= 262 ? "open" : "min";
    }
    function setMode(m, byUser = false) {
        mode = m;
        if (byUser) save(m);
        sync();
    }
    function sync() {
        const show = o.active() && entries.length > 1;
        btn.hidden = !show;
        card.hidden = !show || mode === "closed";
        card.classList.toggle("min", mode === "min");
        btn.setAttribute("aria-pressed", String(show && mode !== "closed"));
        btn.classList.toggle("on", show && mode !== "closed");
        minBtn.title = mode === "min" ? "Expand" : "Minimize";
        minBtn.setAttribute("aria-label", mode === "min" ? "Expand contents" : "Minimize contents");
        bar.title = mode === "min" ? "Show contents" : "";
    }

    function elementOf(e) {
        const block = o.main.querySelector(`.block[data-id="${CSS.escape(e.blockId)}"]`);
        if (!block || e.heading === undefined) return block;
        return block.querySelectorAll(":scope > .md h1, :scope > .md h2, :scope > .md h3, :scope > .md h4")[e.heading] ?? block;
    }

    function renderList() {
        list.replaceChildren(
            ...entries.map((e, i) =>
                h(
                    "button",
                    { class: `toc-i l${e.level} k-${e.kind}`, "data-i": i, title: e.label, onclick: () => jump(e) },
                    e.level > 1 ? h("span", { class: "toc-k", html: ICON[e.kind] ?? "" }) : null,
                    h("span", { class: "toc-t" }, e.label),
                    h("span", { class: "toc-dot", "aria-hidden": "true" }),
                ),
            ),
        );
    }

    /** Rebuild after every Doc render (the outline follows live edits). */
    function rebuild() {
        const doc = o.active() ? o.getDoc() : null;
        const next = doc ? outlineOf(doc) : [];
        const same = next.length === entries.length && next.every((e, i) => e.key === entries[i].key && e.label === entries[i].label && e.level === entries[i].level);
        entries = next;
        if (!same) renderList();
        const pref = saved();
        mode = pref === "open" || pref === "min" || pref === "closed" ? pref : autoMode();
        sync();
    }

    addEventListener("resize", () => {
        if (!saved()) rebuild();
    });

    /** Scroll an element into the reading position, opening any collapsed sections around it, and flash it. */
    function reveal(el, { flash = el } = {}) {
        if (!el) return;
        for (let s = el.closest(".section.collapsed"); s; s = s.parentElement?.closest(".section.collapsed")) {
            s.classList.remove("collapsed");
            const id = s.closest(".block[data-id]")?.dataset.id;
            if (id) o.expand(id);
        }
        const mr = o.main.getBoundingClientRect();
        const top = el.getBoundingClientRect().top - mr.top + o.main.scrollTop - 14;
        o.main.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        if (flash) {
            flash.classList.remove("jumped");
            void flash.offsetWidth;
            flash.classList.add("jumped");
            setTimeout(() => flash.classList.remove("jumped"), 1600);
        }
    }
    function jump(e) {
        const el = elementOf(e);
        // Jumping to a collapsed section opens it: you went there to read it.
        const sec = e.kind === "section" ? el?.querySelector(":scope > .section.collapsed") : null;
        if (sec) {
            sec.classList.remove("collapsed");
            o.expand(e.blockId);
        }
        // A whole section would flash as a wall of colour; its heading says "here" enough.
        reveal(el, { flash: (e.kind === "section" && el?.querySelector(":scope > .section > .section-head")) || el });
    }

    /** A Markdown heading "contains" what follows it in its text, up to the next heading of the same or higher rank. */
    function underHeading(hd, t) {
        if (hd === t || hd.contains(t)) return true;
        const md = hd.parentElement;
        if (!md?.contains(t) || !(hd.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        const rank = Number(hd.tagName[1]);
        for (let n = hd.nextElementSibling; n; n = n.nextElementSibling) {
            if (/^H[1-4]$/.test(n.tagName) && Number(n.tagName[1]) <= rank) return false;
            if (n === t || n.contains(t)) return true;
        }
        return false;
    }
    /** Dots on the entries that contain what the chat is about. */
    function marks(els) {
        const targets = els.filter(Boolean);
        entries.forEach((e, i) => {
            const b = list.querySelector(`[data-i="${i}"]`);
            if (!b) return;
            const el = elementOf(e);
            b.classList.toggle("asking", !!el && targets.some((t) => (e.heading === undefined ? el.contains(t) : underHeading(el, t))));
        });
    }
    /** A brief dot on the entries around something Copilot just changed. */
    function fresh(el) {
        if (!el) return;
        entries.forEach((e, i) => {
            const own = e.heading === undefined ? elementOf(e) : null;
            if (!own || !own.contains(el)) return;
            const b = list.querySelector(`[data-i="${i}"]`);
            b?.classList.remove("fresh");
            void b?.offsetWidth;
            b?.classList.add("fresh");
        });
    }

    // ---- jump palette ----
    const input = h("input", { class: "jump-in", type: "text", placeholder: "Jump to a section, diagram or heading…", "aria-label": "Jump to", autocomplete: "off", spellcheck: "false", role: "combobox", "aria-expanded": "true", "aria-controls": "jump-list" });
    const results = h("div", { id: "jump-list", class: "jump-list", role: "listbox" });
    const foot = h("div", { class: "jump-foot" }, h("span", {}, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " move"), h("span", {}, h("kbd", {}, "Enter"), " jump"), h("span", {}, h("kbd", {}, "Esc"), " close"));
    const box = h("div", { class: "jump-box", role: "dialog", "aria-label": "Jump to" }, h("div", { class: "jump-head" }, h("span", { class: "jump-ic", html: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>') }), input), results, foot);
    const palette = h("div", { id: "jump", hidden: true, onpointerdown: (e) => e.target === palette && closeJump() }, box);
    document.body.append(palette);
    let shown = [];
    let sel = 0;

    const labelWithMarks = (label, pos) => {
        if (!pos.length) return [label];
        const set = new Set(pos);
        const parts = [];
        let run = "";
        let on = false;
        for (let i = 0; i <= label.length; i++) {
            const m = set.has(i);
            if (i === label.length || m !== on) {
                if (run) parts.push(on ? h("mark", {}, run) : run);
                run = "";
                on = m;
            }
            if (i < label.length) run += label[i];
        }
        return parts;
    };
    function renderResults() {
        const q = input.value;
        shown = rank(entries, q);
        sel = Math.min(sel, Math.max(0, shown.length - 1));
        results.replaceChildren(
            ...(shown.length
                ? shown.map(({ e, pos }, i) =>
                      h(
                          "div",
                          { class: `jump-i${i === sel ? " sel" : ""}${!q.trim() && e.level > 1 ? " sub" : ""}`, role: "option", id: `jump-o${i}`, "aria-selected": String(i === sel), onpointermove: () => i !== sel && select(i), onclick: () => go(i) },
                          h("span", { class: `jump-k k-${e.kind}`, html: ICON[e.kind] ?? (e.kind === "section" ? svg('<path d="M3 4h10M3 8h10M3 12h6"/>') : "") }),
                          h("span", { class: "jump-t" }, ...labelWithMarks(e.label, pos)),
                          h("span", { class: "jump-trail" }, q.trim() ? e.trail.join(" › ") : e.kind === "section" ? "" : KIND_LABEL[e.kind] ?? ""),
                      ),
                  )
                : [h("div", { class: "jump-empty" }, "No sections, diagrams or headings match.")]),
        );
        input.setAttribute("aria-activedescendant", shown.length ? `jump-o${sel}` : "");
    }
    function select(i) {
        sel = i;
        results.querySelectorAll(".jump-i").forEach((el, k) => {
            el.classList.toggle("sel", k === i);
            el.setAttribute("aria-selected", String(k === i));
        });
        input.setAttribute("aria-activedescendant", `jump-o${i}`);
        results.querySelector(".jump-i.sel")?.scrollIntoView({ block: "nearest" });
    }
    function go(i) {
        const hit = shown[i];
        closeJump();
        if (hit) jump(hit.e);
    }
    let returnFocus = null;
    async function openJump() {
        if (o.blocked() || !o.getDoc()) return;
        if (!o.active()) await o.showBoard();
        if (!o.active() || entries.length === 0) return;
        returnFocus = document.activeElement;
        input.value = "";
        sel = 0;
        palette.hidden = false;
        renderResults();
        input.focus();
    }
    function closeJump() {
        if (palette.hidden) return;
        palette.hidden = true;
        if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
        returnFocus = null;
    }
    input.addEventListener("input", () => ((sel = 0), renderResults()));
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey) || (e.ctrlKey && e.key === "n")) {
            e.preventDefault();
            if (shown.length) select((sel + 1) % shown.length);
        } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) || (e.ctrlKey && e.key === "p")) {
            e.preventDefault();
            if (shown.length) select((sel - 1 + shown.length) % shown.length);
        } else if (e.key === "Enter") {
            e.preventDefault();
            go(sel);
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // the palette's Escape must not also close the chat or a selection
            closeJump();
        }
        e.stopPropagation(); // arrows here are not the tour's
    });
    document.addEventListener(
        "keydown",
        (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
                e.preventDefault();
                e.stopPropagation();
                if (palette.hidden) openJump();
                else closeJump();
            }
        },
        true,
    );

    return { rebuild, marks, fresh, reveal, openJump, closeJump, hide: () => ((entries = []), renderList(), sync(), closeJump()), get entries() { return entries; } };
}
