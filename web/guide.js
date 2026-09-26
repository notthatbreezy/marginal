// Guide: coach-mark tours over live UI (a spotlight on one element + a card beside it).
// Targets are resolved by selector on every frame because the Command tab re-renders its DOM several times a second;
// steps whose target isn't on screen are skipped, so one script works for every state of the page.
import { h, put } from "./core.js";

const GAP = 12;
const PAD = 6;

/**
 * steps: [{ id, target?: string | () => Element|null, title, body: string|Node|(() => Node), placement?: "right"|"left"|"bottom"|"top", when?: () => boolean, onEnter?: () => void }]
 * opts: { label, onClose(completed:boolean) }
 */
export function startGuide(steps, { label = "Guided tour", onClose } = {}) {
    document.querySelector(".guide")?.dispatchEvent(new Event("guide-close"));
    const live = () => steps.filter((s) => (s.when ? s.when() : true) && (!s.target || targetOf(s)));
    let list = live();
    let i = 0;
    let raf = 0;
    const hole = h("div", { class: "guide-hole", "aria-hidden": "true" });
    const title = h("h2", { class: "guide-t", id: "guide-title" });
    const body = h("div", { class: "guide-b" });
    const dots = h("div", { class: "guide-dots", "aria-hidden": "true" });
    const count = h("span", { class: "guide-n" });
    const back = h("button", { class: "guide-back", onclick: () => go(i - 1) }, "Back");
    const next = h("button", { class: "primary guide-next", onclick: () => (i >= list.length - 1 ? close(true) : go(i + 1)) });
    const card = h(
        "div",
        { class: "guide-card", role: "dialog", "aria-modal": "false", "aria-labelledby": "guide-title", "aria-describedby": "guide-body" },
        h("button", { class: "chat-icon guide-x", title: "End tour (Esc)", "aria-label": "End tour", onclick: () => close(false), html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
        title,
        body,
        h("div", { class: "guide-foot" }, count, dots, h("span", { class: "grow" }), back, next),
    );
    body.id = "guide-body";
    // The catcher keeps clicks off the page underneath while the card talks about it (the spotlit element stays visible).
    const root = h("div", { class: "guide", role: "presentation" }, h("div", { class: "guide-catch", onclick: () => card.querySelector(".guide-next")?.focus() }), hole, card);
    root.addEventListener("guide-close", () => close(false));
    document.body.append(root);
    const prevFocus = document.activeElement;

    function targetOf(s) {
        if (!s.target) return null;
        const el = typeof s.target === "function" ? s.target() : document.querySelector(s.target);
        if (!el || !el.isConnected) return null;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden" ? el : null;
    }

    function go(k) {
        list = live();
        i = Math.max(0, Math.min(list.length - 1, k));
        const s = list[i];
        s.onEnter?.();
        title.textContent = s.title;
        put(body, typeof s.body === "function" ? s.body() : s.body);
        count.textContent = `${i + 1} of ${list.length}`;
        put(dots, list.map((_, j) => h("i", { class: j === i ? "on" : j < i ? "done" : "" })));
        back.disabled = i === 0;
        next.replaceChildren(i >= list.length - 1 ? "Done" : "Next", h("kbd", {}, "→"));
        card.classList.remove("enter");
        void card.offsetWidth;
        card.classList.add("enter");
        place(true);
        next.focus({ preventScroll: true });
    }

    function place(force = false) {
        const s = list[i];
        const el = s && targetOf(s);
        const vw = innerWidth;
        const vh = innerHeight;
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        if (!el) {
            root.classList.add("centered");
            card.dataset.side = "center";
            hole.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
            card.style.left = `${Math.round((vw - cw) / 2)}px`;
            card.style.top = `${Math.round((vh - ch) / 2)}px`;
            return;
        }
        root.classList.remove("centered");
        const r = el.getBoundingClientRect();
        const t = { left: Math.max(4, r.left - PAD), top: Math.max(4, r.top - PAD), right: Math.min(vw - 4, r.right + PAD), bottom: Math.min(vh - 4, r.bottom + PAD) };
        const key = `${t.left}|${t.top}|${t.right}|${t.bottom}|${cw}|${ch}`;
        if (!force && key === place.last) return;
        place.last = key;
        hole.style.cssText = `left:${t.left}px;top:${t.top}px;width:${t.right - t.left}px;height:${t.bottom - t.top}px;border-radius:${radiusOf(el)}`;
        const fits = {
            right: vw - t.right - GAP >= cw + 8,
            left: t.left - GAP >= cw + 8,
            bottom: vh - t.bottom - GAP >= ch + 8,
            top: t.top - GAP >= ch + 8,
        };
        const order = [s.placement, "right", "left", "bottom", "top"].filter(Boolean);
        const side = order.find((p) => fits[p]);
        const clampX = (x) => Math.max(8, Math.min(vw - cw - 8, x));
        const clampY = (y) => Math.max(8, Math.min(vh - ch - 8, y));
        let x;
        let y;
        if (side === "right" || side === "left") {
            x = side === "right" ? t.right + GAP : t.left - GAP - cw;
            y = clampY(t.top + (t.bottom - t.top) / 2 - ch / 2);
        } else if (side === "bottom" || side === "top") {
            x = clampX(t.left + (t.right - t.left) / 2 - cw / 2);
            y = side === "bottom" ? t.bottom + GAP : t.top - GAP - ch;
        } else {
            // The target fills the screen (e.g. the map): float the card inside it, bottom-right.
            x = clampX(t.right - cw - 16);
            y = clampY(t.bottom - ch - 16);
        }
        card.dataset.side = side ?? "inside";
        card.style.left = `${Math.round(x)}px`;
        card.style.top = `${Math.round(y)}px`;
    }

    const loop = () => {
        place();
        raf = requestAnimationFrame(loop);
    };

    function keydown(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close(false);
        } else if (e.key === "ArrowRight" || (e.key === "Enter" && e.target === document.body)) {
            e.preventDefault();
            e.stopPropagation();
            if (i >= list.length - 1) close(true);
            else go(i + 1);
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            go(i - 1);
        } else if (e.key === "Tab") {
            // Keep keyboard focus in the card (the page underneath is inert while the tour talks).
            const f = [...card.querySelectorAll("button:not(:disabled)")];
            const k = f.indexOf(document.activeElement);
            e.preventDefault();
            f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
        }
    }
    document.addEventListener("keydown", keydown, true);

    let closed = false;
    function close(completed) {
        if (closed) return;
        closed = true;
        cancelAnimationFrame(raf);
        document.removeEventListener("keydown", keydown, true);
        root.remove();
        prevFocus?.focus?.({ preventScroll: true });
        onClose?.(completed);
    }

    if (!list.length) {
        close(false);
        return null;
    }
    go(0);
    raf = requestAnimationFrame(loop);
    return { close: () => close(false), go, get index() { return i; } };
}

/** Spotlight corner: circles stay circles, everything else gets the element's radius plus the padding (capped). */
function radiusOf(el) {
    const r = getComputedStyle(el).borderRadius;
    if (r.includes("%") || parseFloat(r) >= el.getBoundingClientRect().height / 2) return "999px";
    return `${Math.min(12, (parseFloat(r) || 2) + PAD)}px`;
}

/** Inline key cap. */
export const kbd = (k) => h("kbd", {}, k);
