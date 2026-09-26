// iOS-style overlay scrollbars: native bars are hidden (style.css); a thin pill floats over any
// scroll container while it is hovered or scrolling, then fades. Thumbs can be dragged.
const IDLE_MS = 900;
// Every pill sits INSET px inside its container's inner edge; track ends clear rounded corners.
const INSET = 3;
const T = 10; // track thickness (the pill inside is thinner)
const bars = new Map(); // element -> { v, h, timer, hovered }

/** Ends of the track: at least 4px, more for rounded containers so the pill never touches a curve. */
function endInset(el) {
    const r = parseFloat(getComputedStyle(el).borderTopRightRadius) || 0;
    return Math.max(4, Math.round(r * 0.6));
}

function scrollable(el) {
    if (!(el instanceof Element) || el === document.documentElement) return { y: false, x: false };
    const cs = getComputedStyle(el);
    const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    return { y, x };
}

function layer(el) {
    // Keep bars in the same visual layer as their container.
    if (el.closest("#chat")) return 41;
    if (el.closest("#tour")) return 31;
    if (el.closest("#peek")) return 21;
    return 5;
}

/** The part of el actually on screen, after clipping by scrolling ancestors. */
function visibleRect(el) {
    let r = el.getBoundingClientRect();
    let top = r.top,
        left = r.left,
        right = r.right,
        bottom = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = scrollable(p);
        if (!s.x && !s.y && getComputedStyle(p).overflow === "visible") continue;
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
        bottom = Math.min(bottom, pr.bottom);
    }
    return { top, left, right, bottom, full: r };
}

function makeBar(axis, el) {
    const track = document.createElement("div");
    track.className = `os-track os-${axis}`;
    const thumb = document.createElement("div");
    thumb.className = "os-thumb";
    track.append(thumb);
    track.style.zIndex = layer(el);
    document.body.append(track);
    thumb.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        thumb.setPointerCapture(e.pointerId);
        track.classList.add("dragging");
        const start = axis === "v" ? e.clientY : e.clientX;
        const startScroll = axis === "v" ? el.scrollTop : el.scrollLeft;
        const trackLen = axis === "v" ? track.clientHeight : track.clientWidth;
        const content = axis === "v" ? el.scrollHeight : el.scrollWidth;
        const view = axis === "v" ? el.clientHeight : el.clientWidth;
        const thumbLen = axis === "v" ? thumb.offsetHeight : thumb.offsetWidth;
        const ratio = (content - view) / Math.max(1, trackLen - thumbLen);
        const move = (ev) => {
            const d = ((axis === "v" ? ev.clientY : ev.clientX) - start) * ratio;
            if (axis === "v") el.scrollTop = startScroll + d;
            else el.scrollLeft = startScroll + d;
        };
        const up = () => {
            track.classList.remove("dragging");
            thumb.removeEventListener("pointermove", move);
            thumb.removeEventListener("pointerup", up);
            thumb.removeEventListener("pointercancel", up);
            touch(el);
        };
        thumb.addEventListener("pointermove", move);
        thumb.addEventListener("pointerup", up);
        thumb.addEventListener("pointercancel", up);
    });
    track.addEventListener("pointerenter", () => {
        const b = bars.get(el);
        if (b) b.onBar = true;
        show(el);
    });
    track.addEventListener("pointerleave", () => {
        const b = bars.get(el);
        if (b) b.onBar = false;
        touch(el);
    });
    return track;
}

function position(el) {
    const b = bars.get(el);
    if (!b) return;
    if (!el.isConnected) return drop(el);
    const s = scrollable(el);
    const vis = visibleRect(el);
    const { full } = vis;
    for (const axis of ["v", "h"]) {
        const on = axis === "v" ? s.y : s.x;
        if (!on) {
            b[axis]?.remove();
            b[axis] = null;
            continue;
        }
        b[axis] ??= makeBar(axis, el);
        const track = b[axis];
        const thumb = track.firstChild;
        // A container may lend its edge to a child scroller (e.g. the chat input box for its textarea).
        const rail = el.closest("[data-os-rail]") ?? el;
        const rr = rail.getBoundingClientRect();
        const rcs = getComputedStyle(rail);
        const railRight = rr.right - (parseFloat(rcs.borderRightWidth) || 0);
        const railBottom = rr.bottom - (parseFloat(rcs.borderBottomWidth) || 0);
        const edge = endInset(rail === el ? el : rail);
        let tl, tt, tw, th;
        if (axis === "v") {
            const len = el.clientHeight - edge * 2 - (s.x ? T : 0);
            const thumbLen = Math.max(24, (el.clientHeight / el.scrollHeight) * len);
            const pos = (el.scrollTop / (el.scrollHeight - el.clientHeight)) * (len - thumbLen);
            [tl, tt, tw, th] = [railRight - T, full.top + el.clientTop + edge, T, len];
            thumb.style.height = `${thumbLen}px`;
            thumb.style.width = "";
            thumb.style.transform = `translateY(${pos}px)`;
        } else {
            const len = el.clientWidth - edge * 2 - (s.y ? T : 0);
            const thumbLen = Math.max(24, (el.clientWidth / el.scrollWidth) * len);
            const pos = (el.scrollLeft / (el.scrollWidth - el.clientWidth)) * (len - thumbLen);
            [tl, tt, tw, th] = [full.left + el.clientLeft + edge, (rail === el ? full.top + el.clientTop + el.clientHeight : railBottom) - T, len, T];
            thumb.style.width = `${thumbLen}px`;
            thumb.style.height = "";
            thumb.style.transform = `translateX(${pos}px)`;
        }
        Object.assign(track.style, { left: `${tl}px`, top: `${tt}px`, width: `${tw}px`, height: `${th}px`, zIndex: layer(el) });
        // Clip to what is on screen so bars never paint over the header or other panes. A lent rail sits
        // outside its scroller (e.g. right of the send button), so clip against the rail, not the scroller.
        const clip = rail === el ? vis : visibleRect(rail);
        const inset = [Math.max(0, clip.top - tt), Math.max(0, tl + tw - clip.right), Math.max(0, tt + th - clip.bottom), Math.max(0, clip.left - tl)];
        const hidden = inset[0] + inset[2] >= th || inset[1] + inset[3] >= tw;
        track.style.clipPath = hidden ? "inset(100%)" : `inset(${inset.map((n) => `${n}px`).join(" ")})`;
    }
}

function show(el) {
    let b = bars.get(el);
    if (!b) bars.set(el, (b = { v: null, h: null, timer: 0, hovered: false, onBar: false }));
    position(el);
    for (const t of [b.v, b.h]) t?.classList.add("on");
    clearTimeout(b.timer);
}

function touch(el) {
    show(el);
    const b = bars.get(el);
    if (!b) return; // the container left the page while we were showing its bar
    b.timer = setTimeout(() => {
        if (b.hovered || b.onBar) return;
        for (const t of [b.v, b.h]) t?.classList.remove("on");
    }, IDLE_MS);
}

function drop(el) {
    const b = bars.get(el);
    b?.v?.remove();
    b?.h?.remove();
    bars.delete(el);
}

function scrollChain(target) {
    const chain = [];
    for (let el = target; el && el !== document.body; el = el.parentElement) {
        const s = scrollable(el);
        if (s.x || s.y) chain.push(el);
    }
    return chain;
}

let hoverChain = [];
document.addEventListener(
    "pointerover",
    (e) => {
        if (e.target.closest?.(".os-track")) return;
        const next = scrollChain(e.target);
        for (const el of hoverChain)
            if (!next.includes(el)) {
                const b = bars.get(el);
                if (b) {
                    b.hovered = false;
                    touch(el);
                }
            }
        for (const el of next) {
            show(el);
            const b = bars.get(el);
            if (b) b.hovered = true;
        }
        hoverChain = next;
    },
    { passive: true },
);
document.addEventListener(
    "pointerleave",
    () => {
        for (const el of hoverChain) {
            const b = bars.get(el);
            if (b) {
                b.hovered = false;
                touch(el);
            }
        }
        hoverChain = [];
    },
    { passive: true },
);
document.addEventListener(
    "scroll",
    (e) => {
        const el = e.target === document ? null : e.target;
        if (el instanceof Element) touch(el);
        // Nested bars move with their scrolled ancestor.
        for (const other of bars.keys()) if (other !== el) position(other);
    },
    { capture: true, passive: true },
);
addEventListener("resize", () => bars.forEach((_, el) => position(el)));
// Typing can make a field overflow (or move its caret) without any pointer or scroll event; show its bar then too.
document.addEventListener(
    "input",
    (e) => {
        const el = e.target;
        if (el instanceof HTMLTextAreaElement && scrollable(el).y) requestAnimationFrame(() => touch(el));
    },
    { passive: true },
);
new ResizeObserver(() => bars.forEach((_, el) => position(el))).observe(document.body);
