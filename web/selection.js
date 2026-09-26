// Selection: Ctrl/Cmd+click toggles, Shift+click selects a contiguous range, on any surface.
// Whiteboard paragraphs/blocks and Command map tiles each create one; the header #multibar shows whichever
// selection was changed most recently and routes its buttons to that selection's actions.
import { $ } from "./core.js";

let current = null;

/**
 * @param {object} o
 * @param {(el:Element) => string} o.keyOf        stable key for a unit element
 * @param {(key:string) => Element|null} o.elOf   resolve a key to its rendered element (null if not rendered)
 * @param {() => Element[]} o.units               every selectable unit in order (for Shift ranges)
 * @param {{comment?:(keys:string[])=>void, copy?:(keys:string[])=>void, chat?:(keys:string[])=>void}} o.actions
 * @param {(keys:string[]) => void} [o.onChange]
 */
export function createSelection(o) {
    const keys = new Set();
    const painted = new Set();
    let anchor = null;

    function ordered() {
        const withEl = [...keys].map((k) => [k, o.elOf(k)]);
        withEl.sort(([, a], [, b]) => (a && b ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : 0));
        return withEl.map(([k]) => k);
    }
    function paint() {
        for (const el of painted) el.classList.remove("picked");
        painted.clear();
        for (const k of keys) {
            const el = o.elOf(k);
            if (el) {
                el.classList.add("picked");
                painted.add(el);
            }
        }
    }
    function changed() {
        paint();
        if (keys.size) current = api;
        else if (current === api) current = null;
        syncBar();
        o.onChange?.(ordered());
    }

    const api = {
        get size() {
            return keys.size;
        },
        has: (k) => keys.has(k),
        keys: ordered,
        anchor: () => anchor,
        toggle(el) {
            const k = o.keyOf(el);
            if (keys.has(k)) keys.delete(k);
            else keys.add(k);
            anchor = k;
            changed();
        },
        range(el) {
            const list = o.units();
            const from = anchor ? list.indexOf(o.elOf(anchor)) : -1;
            const to = list.indexOf(el);
            if (from < 0 || to < 0) return api.toggle(el);
            for (let i = Math.min(from, to); i <= Math.max(from, to); i++) keys.add(o.keyOf(list[i]));
            changed();
        },
        clear() {
            if (!keys.size && anchor === null) return;
            keys.clear();
            anchor = null;
            changed();
        },
        paint, // re-apply classes after a re-render
        run(name) {
            o.actions[name]?.(ordered());
        },
        can: (name) => !!o.actions[name],
    };
    return api;
}

export const activeSelection = () => current;

/** Keep the header bar in sync with the current selection. Extra listeners (e.g. the center-slot priority) hook in here. */
export const multibar = { onSync: [] };
export function syncBar() {
    $("#multi-count").textContent = `${current?.size ?? 0} selected`;
    const chat = $("#multi-chat");
    if (chat) chat.hidden = !current?.can("chat");
    for (const fn of multibar.onSync) fn(current);
}
export function flashBar(text) {
    $("#multi-count").textContent = text;
    setTimeout(syncBar, 1200);
}
for (const [id, name] of [
    ["#multi-comment", "comment"],
    ["#multi-copy", "copy"],
    ["#multi-chat", "chat"],
])
    $(id)?.addEventListener("click", () => current?.run(name));
$("#multi-clear")?.addEventListener("click", () => current?.clear());

export const withModifier = (e) => e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey);
