// Monitor panels (diff-feed and files modes). A monitor watches one directory/file subtree.
import { api, h, put } from "../core.js";
import { relTime } from "./derive.js";
import { fmtCounts } from "./treemap.js";

const inSub = (path, root) => !root || path === root || path.startsWith(`${root}/`);

/** o: { monitors: [{path, mode}], events, changes, fronts: Map, docId, now, onClose(path), onMode(path, mode), onFocus(path) } */
const goneShown = new Set(); // monitor paths where the reader chose to see edits to files no longer changed
let last = null;
export function renderMonitors(host, o) {
    last = [host, o];
    o = { ...o, showGone: (p) => goneShown.has(p), rerender: () => last && renderMonitors(...last) };
    host.hidden = !o.monitors.length;
    const open = new Set([...host.querySelectorAll(".feed li.open")].map((li) => li.dataset.key));
    const focused = document.activeElement?.closest?.(".feed li")?.dataset.key;
    const scroll = new Map([...host.querySelectorAll(".mon")].map((m) => [m.dataset.path, m.querySelector(".mon-b")?.scrollTop ?? 0]));
    put(
        host,
        o.monitors.map((mon) => {
            const files = [...o.changes].filter(([p]) => inSub(p, mon.path));
            const add = files.reduce((n, [, c]) => n + c.add, 0);
            const del = files.reduce((n, [, c]) => n + c.del, 0);
            const frontIds = new Set(files.flatMap(([, c]) => [...c.fronts.keys()]));
            return h(
                "div",
                { class: "mon", "data-path": mon.path },
                h(
                    "div",
                    { class: "mon-h" },
                    h("button", { class: "path mon-path", title: "Zoom the map here", onclick: () => o.onFocus(mon.path) }, `${mon.path || "/"}${files.length === 1 && files[0][0] === mon.path ? "" : "/"}`),
                    [...frontIds].map((id) => h("span", { class: `fdot f${(o.fronts.get(id)?.color ?? 5) + 1}`, title: o.fronts.get(id)?.label ?? id })),
                    h("span", { class: "num mon-ct" }, fmtCounts(add, del)),
                    h(
                        "span",
                        { class: "modes", role: "group", "aria-label": "Monitor mode" },
                        [
                            ["diff-feed", "Diff feed"],
                            ["files", "Files"],
                        ].map(([m, label]) => h("button", { class: mon.mode === m ? "on" : "", "aria-pressed": String(mon.mode === m), onclick: () => o.onMode(mon.path, m) }, label)),
                    ),
                    h("span", { class: "grow" }),
                    h("button", { class: "chat-icon", title: "Close monitor", "aria-label": "Close monitor", onclick: () => o.onClose(mon.path), html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
                ),
                h("div", { class: "mon-b" }, mon.mode === "files" ? filesTable(files, o) : feed(mon, o, open)),
            );
        }),
    );
    for (const m of host.querySelectorAll(".mon")) {
        const b = m.querySelector(".mon-b");
        if (b) b.scrollTop = scroll.get(m.dataset.path) ?? 0;
    }
    if (focused) host.querySelector(`.feed li[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

/**
 * What a row can show when opened: its file's diff as that front has it now. Edits to files the front no longer
 * changes (made then deleted, e.g. build output, or edited back to base) have nothing to show and are hidden by
 * default; binary files have no text diff; a peek that came back empty is remembered as having nothing.
 */
function rowState(e, o) {
    const cur = o.changes.get(e.file)?.fronts.get(e.frontId);
    if (!cur) return "gone";
    if (cur.binary) return "binary";
    const hit = peekCache.get(peekKey(e, o));
    if (hit && !(hit instanceof Promise) && !hit.error && !hit.hunks?.length) return "empty";
    return "diff";
}
const NO_DIFF = { gone: "No longer changed in this front (created then removed, or edited back)", binary: "Binary file: no text diff", empty: "No textual changes right now" };

function feed(mon, o, open) {
    const all = o.events.filter((e) => inSub(e.file, mon.path) && !e.initial && !e.baseline && (e.delta.add || e.delta.del));
    const showGone = o.showGone?.(mon.path) ?? false;
    const states = new Map(all.map((e) => [e, rowState(e, o)]));
    const gone = all.filter((e) => states.get(e) === "gone").length;
    const rows = all.filter((e) => showGone || states.get(e) !== "gone").slice(-40).reverse();
    const footer = gone
        ? h(
              "button",
              { class: "mon-gone", onclick: () => (goneShown.has(mon.path) ? goneShown.delete(mon.path) : goneShown.add(mon.path), o.rerender()) },
              showGone ? `Hide ${gone} edit${gone === 1 ? "" : "s"} to files no longer changed` : `${gone} edit${gone === 1 ? "" : "s"} to files no longer changed hidden · show`,
          )
        : null;
    if (!rows.length) return h("div", {}, h("p", { class: "mon-empty" }, gone ? "Nothing here is changed right now." : "No edits here yet. New changes appear at the top."), footer);
    return h(
        "div",
        {},
        h(
            "ul",
            { class: "feed" },
            rows.map((e) => {
                const key = `${e.seq}`;
                const f = o.fronts.get(e.frontId);
                const state = states.get(e);
                const can = state === "diff";
                const li = h(
                    "li",
                    {
                        class: `f${(f?.color ?? 5) + 1}${can && open.has(key) ? " open" : ""}${can ? "" : ` nodiff ${state}`}`,
                        "data-key": key,
                        tabindex: can ? "0" : null,
                        title: can ? "Show this file's current diff" : NO_DIFF[state],
                        "aria-expanded": can ? String(open.has(key)) : null,
                        onclick: can ? (ev) => !ev.target.closest(".peek") && toggle(li, e, o) : null,
                        onkeydown: can ? (ev) => (ev.key === "Enter" || ev.key === " ") && !ev.target.closest(".peek") && (ev.preventDefault(), toggle(li, e, o)) : null,
                    },
                    h("span", { class: "t" }, relTime(Date.parse(e.at), o.now).replace(" ago", "")),
                    h("span", { class: "fdot" }),
                    h("span", { class: "path" }, e.file.slice(mon.path ? mon.path.length + 1 : 0) || e.file),
                    can ? null : h("span", { class: "nd" }, state === "gone" ? "gone" : state === "binary" ? "binary" : "no diff"),
                    h("span", { class: "num" }, fmtCounts(e.delta.add, e.delta.del)),
                );
                if (can && open.has(key)) loadPeek(li, e, o);
                return li;
            }),
        ),
        footer,
    );
}

function toggle(li, e, o) {
    if (li.classList.contains("nodiff")) return;
    const on = li.classList.toggle("open");
    li.setAttribute("aria-expanded", String(on));
    if (on) loadPeek(li, e, o);
    else li.querySelector(".peek")?.remove();
}

// The peek shows the file's *current* diff for that front; cache it until the file's totals move (monitors re-render at 4 Hz).
const peekCache = new Map(); // `${doc}\0${front}\0${file}\0${add}/${del}` → {hunks} | {error} | Promise

function peekKey(e, o) {
    const cur = o.changes.get(e.file)?.fronts.get(e.frontId);
    return `${o.docId}\0${e.frontId}\0${e.file}\0${cur ? `${cur.add}/${cur.del}` : "none"}`;
}

function fillPeek(peek, d, e, o) {
    if (d.error) put(peek, h("div", { class: "error" }, d.error));
    else put(peek, d.hunks?.length ? o.renderDiff(d.hunks, e.file) : h("div", { class: "loading" }, "No textual changes right now (reverted or binary)."));
}

function loadPeek(li, e, o) {
    li.querySelector(".peek")?.remove();
    const peek = h("div", { class: "peek" });
    li.append(peek);
    const key = peekKey(e, o);
    const hit = peekCache.get(key);
    if (hit && !(hit instanceof Promise)) return fillPeek(peek, hit, e, o);
    put(peek, h("div", { class: "loading" }, "Loading diff…"));
    const p =
        hit ??
        api(`/command/patch?doc=${encodeURIComponent(o.docId)}&front=${encodeURIComponent(e.frontId)}&file=${encodeURIComponent(e.file)}`)
            .then((d) => ({ hunks: d.hunks ?? [] }))
            .catch((err) => ({ error: err.message }))
            .then((d) => {
                peekCache.set(key, d);
                if (peekCache.size > 200) peekCache.delete(peekCache.keys().next().value);
                return d;
            });
    peekCache.set(key, p);
    p.then((d) => {
        if (!peek.isConnected) return;
        // Nothing to show after all: say so once, then the row stops offering to open.
        if (!d.error && !d.hunks?.length) {
            li.classList.remove("open");
            li.classList.add("nodiff", "empty");
            li.removeAttribute("tabindex");
            li.removeAttribute("aria-expanded");
            li.title = NO_DIFF.empty;
            peek.remove();
            if (!li.querySelector(".nd")) li.querySelector(".num")?.before(h("span", { class: "nd" }, "no diff"));
            return;
        }
        fillPeek(peek, d, e, o);
    });
}

function filesTable(files, o) {
    if (!files.length) return h("p", { class: "mon-empty" }, "No changed files here yet.");
    const rows = files.sort((a, b) => b[1].lastAt - a[1].lastAt);
    return h(
        "table",
        { class: "mon-files" },
        h("thead", {}, h("tr", {}, ["File", "Front", "+", "−", "Last change"].map((c) => h("th", {}, c)))),
        h(
            "tbody",
            {},
            rows.map(([p, c]) =>
                h(
                    "tr",
                    {},
                    h("td", { class: "path" }, p),
                    h("td", {}, [...c.fronts.keys()].map((id) => h("span", { class: `fdot f${(o.fronts.get(id)?.color ?? 5) + 1}`, title: o.fronts.get(id)?.label ?? id }))),
                    h("td", { class: "num add" }, `+${c.add}`),
                    h("td", { class: "num del" }, `−${c.del}`),
                    h("td", { class: "num muted" }, c.lastAt ? relTime(c.lastAt, o.now) : "before start"),
                ),
            ),
        ),
    );
}
