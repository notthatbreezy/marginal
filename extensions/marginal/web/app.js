// Marginal canvas renderer. Vanilla JS, no dependencies.
import { TOKEN, INSTANCE, $, h, s, esc, put, api, toast, slugify, inline, markdown, highlight, langOf, svc, bus } from "./core.js";
import { defaultBox, dragBox, fitBox, resizeBox } from "./chat-geometry.js";
import { activeSelection, createSelection, flashBar, withModifier, multibar } from "./selection.js";
import { createToc } from "./toc.js";
import { createTables } from "./tables.js";
import { createProseEditor, editableKind } from "./edit.js";
import { loadSettings, onSettings, settingsChanged, shortcut } from "./settings.js";
import { captureGone, decorate as decorateSuggestion } from "./suggest.js";

const INITIAL_TAB = new URLSearchParams(location.search).get("tab");

// ---------------- state ----------------
const state = {
    documentId: null,
    doc: null,
    repository: null,
    tab: "board",
    viewVersion: null, // historical snapshot being viewed
    preview: null, // { threadId, proposalId, doc, changes, gone, hits, at }: a held suggestion shown in the doc, not applied
    collapsed: new Map(), // blockId -> bool (user overrides)
    lastSeenVersion: null,
    catalog: [],
};
const sourceCache = new Map();
let toc = null; // Contents card + Ctrl/⌘-J jump palette (created at boot, below)
let tables = null; // table width modes + column resizing (created at boot, below)
let prose = null; // in-place prose editing (created at boot, below)
let pendingRefresh = false; // the doc changed while the reader was editing: re-render when they finish
let pendingShow = null; // Copilot opened another doc while the reader was editing


// ---------------- source fetch + code listing ----------------
function sourceKey(src) {
    return JSON.stringify([state.documentId, state.doc?.target?.head, state.doc?.target?.base, src.file, src.side ?? "head", src.startLine, src.endLine, src.pins, !!src.diff]);
}
function fetchSource(src) {
    const key = sourceKey(src);
    if (!sourceCache.has(key)) sourceCache.set(key, api(`/docs/${encodeURIComponent(state.documentId)}/source`, { method: "POST", body: { source: src } }).catch((e) => (sourceCache.delete(key), Promise.reject(e))));
    return sourceCache.get(key);
}
const srcLabel = (src) => `${src.side === "base" ? "base · " : ""}${src.file}${src.startLine ? `:${src.startLine}${src.endLine && src.endLine !== src.startLine ? `–${src.endLine}` : ""}` : ""}`;

function codeListing(lines, lang, { highlightLines } = {}) {
    const pre = h("div", { class: "code" });
    for (const l of lines) {
        const row = h("div", { class: `ln${highlightLines?.has(l.n) ? " hl" : ""}` }, h("span", { class: "n" }, l.n), h("span", { class: "t", html: highlight(l.text, lang) || " " }));
        pre.append(row);
    }
    return pre;
}
function diffListing(rows, lang) {
    const pre = h("div", { class: "code" });
    for (const r of rows) {
        const cls = r.kind === "add" ? "add" : r.kind === "del" ? "del" : "";
        pre.append(
            h(
                "div",
                { class: `ln ${cls}` },
                h("span", { class: "n n2" }, r.base ?? ""),
                h("span", { class: "n n2" }, r.head ?? ""),
                h("span", { class: "mark" }, r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""),
                h("span", { class: "t", html: highlight(r.text, lang) || " " }),
            ),
        );
    }
    return pre;
}

async function loadInto(container, src, opts = {}) {
    container.replaceChildren(h("div", { class: "loading" }, "Loading code…"));
    try {
        const data = await fetchSource({ ...src, diff: opts.diff ?? src.diff });
        const lang = langOf(src.file);
        container.replaceChildren(data.diff ? diffListing(data.diff, lang) : codeListing(data.lines, lang));
        return data;
    } catch (e) {
        container.replaceChildren(h("div", { class: "error" }, e.message));
    }
}

// ---------------- side panel: code, and Inspect for diagrams ----------------
// With room to spare the panel moves the doc over instead of covering it (the doc re-centres beside it). Otherwise it
// overlays the doc, and an inspected diagram shrinks to the part left uncovered, scrolling sideways to its current step.
const peekEl = $("#peek");
const PUSH_MIN = 980; // width the doc keeps beside the panel for the panel to move it over rather than cover it
function openPeek(title, sections) {
    endInspect();
    $("#peek-title").textContent = title;
    const body = $("#peek-body");
    body.replaceChildren();
    for (const sec of sections) {
        if (sec.text !== undefined) {
            body.append(h("div", { class: "peek-section" }, sec.heading ? h("div", { class: "ph" }, sec.heading) : null, h("div", { class: "peek-text md", html: markdown(sec.text) })));
        } else if (sec.code) {
            body.append(h("div", { class: "peek-section pad" }, illustrativeCode(sec.code, sec.heading)));
        } else if (sec.source) {
            body.append(h("div", { class: "peek-section pad" }, codeView(sec.source, { diff: !!sec.diff, label: sec.heading && sec.heading !== srcLabel(sec.source) ? sec.heading.split(" · ")[0] : undefined })));
        }
    }
    showPeek();
}
function showPeek() {
    peekEl.hidden = false;
    layoutPeek();
}
function hidePeek() {
    if (peekEl.hidden) return;
    peekEl.hidden = true;
    endInspect();
    if (gutterState.unit?.closest?.("#peek")) hideGutter();
    layoutPeek();
}
let peekRelayout = false;
function layoutPeek() {
    const open = !peekEl.hidden;
    peekEl.style.top = `${Math.round($("#main").getBoundingClientRect().top)}px`; // under the header, never over the tabs
    const w = open ? peekEl.getBoundingClientRect().width : 0;
    const push = open && innerWidth - w >= PUSH_MIN;
    const was = document.body.classList.contains("peek-push");
    document.body.classList.toggle("peek-push", push);
    document.documentElement.style.setProperty("--peek-w", `${Math.round(w)}px`);
    coverInspected();
    if (open) keepChatClear(w);
    if (push !== was) {
        // The doc column changed width: let tables, contents and scrollbars re-measure.
        peekRelayout = true;
        dispatchEvent(new Event("resize"));
        peekRelayout = false;
    }
}
addEventListener("resize", () => !peekRelayout && !peekEl.hidden && layoutPeek());
/** Overlay mode: the inspected diagram ends where the panel begins, so all of it stays reachable. */
function coverInspected() {
    const el = inspBlockEl();
    if (!el) return;
    el.style.marginRight = "";
    if (peekEl.hidden || document.body.classList.contains("peek-push")) return;
    const cover = el.getBoundingClientRect().right - peekEl.getBoundingClientRect().left;
    if (cover > 0) el.style.marginRight = `${Math.ceil(cover + 16)}px`;
}
/** The chat popup steps out from under the panel. */
function keepChatClear(w) {
    if (chatBox.hidden || chat.docked) return;
    const r = chatBox.getBoundingClientRect();
    if (r.right > innerWidth - w - 8) {
        chat.box = fitBox({ x: innerWidth - w - 16 - r.width, y: r.top, w: r.width, h: r.height }, innerWidth, innerHeight);
        placeBox();
    }
}

// ---------------- code view (shared by peeks and Inspect) ----------------
// A readable file path + range header with a Code/Diff switch; the cited lines are tinted and the
// surrounding context is dimmed so the eye lands on what the explanation is about.
const detab = (t) => t.replace(/\t/g, "    ");

function cvLines(lines, lang, s, e, side = "head") {
    const code = h("div", { class: "cv-code" });
    for (const l of lines) {
        const cite = s && l.n >= s && l.n <= e;
        const row = h("div", { class: `cv-ln${cite ? " cite" : s ? " ctx" : ""}` }, h("span", { class: "cv-g" }), h("span", { class: "cv-n" }, l.n), h("span", { class: "cv-t", html: highlight(detab(l.text), lang) || " " }));
        row.dataset[side === "base" ? "base" : "head"] = l.n;
        code.append(row);
    }
    return code;
}

function cvDiff(rows, lang, s, e, side) {
    const key = side === "base" ? "base" : "head";
    const code = h("div", { class: "cv-code diff" });
    for (const r of rows) {
        const n = r[key];
        const cite = s && n !== undefined && n >= s && n <= e;
        const kind = r.kind === "add" ? " add" : r.kind === "del" ? " del" : "";
        const row = h(
            "div",
            { class: `cv-ln${kind}${cite ? " cite" : ""}`, "data-mark": r.kind === "add" ? "+" : r.kind === "del" ? "-" : " " },
            h("span", { class: "cv-g" }),
            h("span", { class: "cv-n cv-n2" }, r.base ?? ""),
            h("span", { class: "cv-n cv-n2" }, r.head ?? ""),
            h("span", { class: "cv-m" }, r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""),
            h("span", { class: "cv-t", html: highlight(detab(r.text), lang) || " " }),
        );
        if (r.base !== undefined) row.dataset.base = r.base;
        if (r.head !== undefined) row.dataset.head = r.head;
        code.append(row);
    }
    return code;
}

// ---------------- line selection inside code (GitHub-style) ----------------
// Hover a line for a "+" in the left gutter; click it (or the line number) to select, drag or Shift+click to
// extend, "−" on a selected line clears. The range stays contiguous; an inline bar under it offers Comment/Copy.
let activeLineSel = null;

function attachLineSelect(body, src, info) {
    let a = null;
    let f = null;
    let drag = false;
    const rows = () => [...body.querySelectorAll(".cv-ln")];
    const range = () => (a === null ? null : [Math.min(a, f), Math.max(a, f)]);
    function describe(list, r) {
        const sel = list.slice(r[0], r[1] + 1);
        const heads = sel.map((x) => x.dataset.head).filter(Boolean).map(Number);
        const bases = sel.map((x) => x.dataset.base).filter(Boolean).map(Number);
        const [nums, suffix] = heads.length ? [heads, ""] : [bases, " (before)"];
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        const label = `${lo === hi ? `Line ${lo}` : `Lines ${lo}–${hi}`}${suffix}`;
        const text = sel.map((x) => `${info.diff() ? x.dataset.mark ?? "" : ""}${x.querySelector(".cv-t").textContent}`).join("\n");
        return { label, text, ascii: label.replace("–", "-") };
    }
    function paint() {
        const r = range();
        const list = rows();
        list.forEach((row, i) => row.classList.toggle("sel", !!r && i >= r[0] && i <= r[1]));
        body.querySelector(".cv-selbar")?.remove();
        if (!r || drag || !list[r[1]]) return;
        const d = describe(list, r);
        const status = h("span", { class: "cv-sel-label" }, d.label);
        const commit = info.commit();
        const bar = h(
            "div",
            { class: "cv-selbar" },
            h(
                "div",
                { class: "cv-selbar-in" },
                status,
                h(
                    "button",
                    {
                        type: "button",
                        class: "primary",
                        onclick: () => {
                            const where = `${src.file}, ${d.ascii.toLowerCase()}${commit ? ` @ ${commit.slice(0, 8)}` : ""}`;
                            // The commented lines stay marked (purple) while the chat is about them.
                            const askRows = list.slice(r[0], r[1] + 1);
                            openChat({ quote: `${where}\n${d.text}`, ref: `${src.file.slice(src.file.lastIndexOf("/") + 1)} · ${d.label.replace(/^L/, "l")}`, askRows });
                            clear();
                        },
                    },
                    "Comment",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        onclick: async () => {
                            const ok = await copyText(d.text);
                            status.textContent = ok ? "Copied" : "Copy failed";
                            setTimeout(() => (status.textContent = d.label), 1200);
                        },
                    },
                    "Copy",
                ),
                h("button", { type: "button", class: "x", title: "Clear selection (Esc)", "aria-label": "Clear selection", onclick: () => clear(), html: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' }),
            ),
        );
        list[r[1]].after(bar);
    }
    function clear() {
        a = f = null;
        paint();
        if (activeLineSel === api) activeLineSel = null;
    }
    const api = { clear, reset: () => ((a = f = null), activeLineSel === api && (activeLineSel = null)) };
    body.addEventListener("pointerdown", (e) => {
        const g = e.target.closest(".cv-g, .cv-n");
        if (!g || e.button !== 0) return;
        const list = rows();
        const i = list.indexOf(g.closest(".cv-ln"));
        if (i < 0) return;
        e.preventDefault();
        getSelection()?.removeAllRanges();
        const r = range();
        if (activeLineSel && activeLineSel !== api) activeLineSel.clear();
        activeLineSel = api;
        if (e.shiftKey && a !== null) f = i;
        else if (r && i >= r[0] && i <= r[1] && g.matches(".cv-g")) return clear(); // the "−"
        else a = f = i;
        drag = true;
        paint();
        const move = (ev) => {
            const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".cv-ln");
            const j = rows().indexOf(row);
            if (j >= 0 && j !== f) {
                f = j;
                paint();
            }
        };
        const up = () => {
            drag = false;
            paint();
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", up);
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
    });
    return api;
}

function codeView(src, { diff: wantDiff = false, context = 8, label } = {}) {
    const canDiff = hasBase(src);
    let diff = wantDiff && canDiff;
    const cut = src.file.lastIndexOf("/") + 1;
    const s = src.startLine;
    const e = src.endLine ?? src.startLine;
    const range = s ? (e !== s ? `L${s}–${e}` : `L${s}`) : "";
    const body = h("div", { class: "cv-body" }, h("div", { class: "loading" }, "Loading code…"));
    const bCode = h("button", { type: "button", onclick: () => ((diff = false), load()) }, "Code");
    const bDiff = h("button", { type: "button", onclick: () => ((diff = true), load()) }, "Diff");
    const seg = canDiff ? h("div", { class: "cv-seg", role: "group", "aria-label": "View" }, bCode, bDiff) : null;
    const el = h(
        "section",
        { class: "cv" },
        h(
            "header",
            { class: "cv-head" },
            label ? h("span", { class: "cv-label" }, label) : null,
            h("span", { class: "cv-path", title: src.file }, h("span", { class: "cv-dir" }, src.file.slice(0, cut)), h("span", { class: "cv-file" }, src.file.slice(cut))),
            range ? h("span", { class: "cv-range" }, range) : null,
            src.side === "base" ? h("span", { class: "badge" }, "before") : null,
            seg,
        ),
        body,
    );
    const lang = langOf(src.file);
    let commit = null;
    const lineSel = attachLineSelect(body, src, { diff: () => diff, commit: () => commit });
    async function load() {
        lineSel.reset();
        bCode.classList.toggle("on", !diff);
        bDiff.classList.toggle("on", diff);
        try {
            if (diff) {
                const data = await fetchSource({ ...src, diff: true });
                commit = data.commit;
                if (!data.diff) {
                    // New files and unchanged ranges read better as plain code; there is nothing to compare.
                    diff = false;
                    if (seg) seg.hidden = true;
                    return load();
                }
                body.replaceChildren(cvDiff(data.diff, lang, s, e, src.side));
            } else {
                const data = await fetchSource({ ...src, startLine: s ? Math.max(1, s - context) : undefined, endLine: e ? e + context : undefined, diff: false });
                commit = data.commit;
                body.replaceChildren(cvLines(data.lines, lang, s, e, src.side));
            }
            const first = body.querySelector(".cite");
            if (first && body.scrollHeight > body.clientHeight) body.scrollTop = Math.max(0, first.offsetTop - 40);
        } catch (err) {
            body.replaceChildren(h("div", { class: "error" }, err.message));
        }
    }
    load();
    return el;
}

function illustrativeCode(code, label) {
    return h(
        "section",
        { class: "cv" },
        h("header", { class: "cv-head" }, h("span", { class: "cv-label" }, label ?? "Illustrative code"), h("span", { class: "cv-range" }, code.language)),
        h("div", { class: "cv-body" }, h("div", { class: "cv-code illus", html: highlight(detab(code.text), code.language) })),
    );
}
$("#peek-close").onclick = () => hidePeek();
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (state.preview) return; // Esc closes the preview first (below), and nothing else
        if (activeLineSel) activeLineSel.clear();
        else if (picks.size) clearPicks();
        else if (!$("#chat").hidden && !chat.docked) closeChat();
        else hidePeek();
    }
});
const hasBase = (src) => !!((src.pins ?? state.doc?.target)?.base && (src.pins ?? state.doc?.target)?.base !== (src.pins ?? state.doc?.target)?.head);

document.addEventListener("click", (e) => {
    // Links being edited are text to change, not places to go.
    if (e.target.closest('[contenteditable="true"] a')) return e.preventDefault();
    const a = e.target.closest("a.src");
    if (a) {
        e.preventDefault();
        const blockEl = a.closest("[data-pins]");
        const pins = blockEl ? JSON.parse(blockEl.dataset.pins) : undefined;
        const src = { file: a.dataset.file, side: a.dataset.side, pins };
        if (a.dataset.start) {
            src.startLine = Number(a.dataset.start);
            src.endLine = Number(a.dataset.end || a.dataset.start);
        }
        openPeek(a.textContent, [{ source: src }]);
        return;
    }
    const anchor = e.target.closest("a.anchor");
    if (anchor) {
        e.preventDefault();
        document.getElementById(anchor.getAttribute("href").slice(1))?.scrollIntoView({ behavior: "smooth" });
    }
});

// ---------------- block renderers ----------------
let animate = null; // { lastEdit, fresh:boolean } set while rendering after a live edit

function frame(kind, title, body, { right, caption } = {}) {
    return h("div", { class: "frame" }, h("div", { class: "frame-head" }, h("span", { class: "kind" }, kind), h("span", { class: "name", title }, title ?? ""), right), body, caption ? h("div", { class: "caption md", html: inline(caption) }) : null);
}

function blockText(b) {
    switch (b.type) {
        case "markdown":
            return b.markdown;
        case "code":
            return b.text;
        case "section":
        case "callout":
            return b.title ?? "";
        case "sequence":
            return `${b.title}\n${b.steps.map((st) => `${b.actors[st.from]} → ${b.actors[st.to]}: ${st.label}`).join("\n")}`;
        case "flow_diagram":
            return `${b.title}\n${b.nodes.map((n) => n.label).join(" / ")}`;
        case "code_peek":
            return `${srcLabel(b.source)}${b.caption ? ` — ${b.caption}` : ""}`;
        case "trace_quote":
            return b.text;
        case "call_stack_diff": {
            const side = (frames) => {
                const depth = new Map();
                return frames.map((f) => {
                    const d = f.parentKey ? (depth.get(f.parentKey) ?? 0) + 1 : 0;
                    if (f.key) depth.set(f.key, d);
                    return `${"  ".repeat(d)}- ${f.label ?? f.source.file.split("/").pop()} (${srcLabel(f.source)})`;
                });
            };
            return [b.title, "Before:", ...(b.base.length ? side(b.base) : ["  (none)"]), "After:", ...(b.head.length ? side(b.head) : ["  (none)"])].join("\n");
        }
        case "database_lens":
            return [b.title, ...b.useCases.map((u) => `${u.label}: ${u.operations.map((o) => `${o.kind} ${o.store}.${o.collection}${o.field ? `.${o.field}` : ""} (${o.label})`).join("; ")}`)].join("\n");
        case "callout":
            return [b.title, ...b.children.map(blockText)].filter(Boolean).join("\n\n");
        case "image":
            return `${b.alt}${b.caption ? ` — ${b.caption}` : ""}`;
        default:
            return b.title ?? b.type;
    }
}

function renderBlock(b, depth = 0) {
    const el = h("div", { class: `block b-${b.type}`, "data-id": b.id });
    // Every block is commented on and copied through the shared margin controls (see "paragraph controls").
    const R = renderers[b.type];
    el.append(R ? R(b, depth) : h("div", { class: "error" }, `Unknown block ${b.type}`));
    if (animate?.lastEdit && (animate.lastEdit.blockId === b.id || animate.lastEdit.targetId === b.id)) {
        if (animate.lastEdit.type === "insert" && !animate.lastEdit.unit) el.classList.add("enter");
        else if (!["remove", "move"].includes(animate.lastEdit.type) || animate.lastEdit.unit) el.classList.add("flash");
        animate.scrollTo = el;
    }
    return el;
}

const renderers = {
    markdown(b) {
        const div = h("div", { class: "md", html: markdown(b.markdown, true) });
        if (b.pins) div.dataset.pins = JSON.stringify(b.pins);
        return div;
    },
    divider: () => h("hr", { class: "divider" }),
    code(b) {
        return frame("code", b.language, h("div", { class: "frame-body" }, h("div", { class: "code", style: "padding:8px 12px", html: highlight(b.text, b.language) })), { caption: b.caption });
    },
    section(b, depth) {
        const override = state.collapsed.get(b.id);
        const collapsed = override ?? !!b.defaultCollapsed;
        const el = h("div", { class: `section depth-${Math.min(depth, 1)}${collapsed ? " collapsed" : ""}` });
        const head = h(
            "div",
            {
                class: "section-head",
                onclick: () => {
                    const now = !el.classList.contains("collapsed");
                    el.classList.toggle("collapsed", now);
                    state.collapsed.set(b.id, now);
                },
            },
            h("span", { class: "chev" }, "▾"),
            h("h2", { id: slugify(b.title) }, b.title),
        );
        el.append(head, h("div", { class: "children" }, b.children.map((c) => renderBlock(c, depth + 1))));
        return el;
    },
    callout(b, depth) {
        return h("div", { class: `callout ${b.tone ?? "info"}` }, b.title ? h("div", { class: "callout-title" }, b.title) : null, b.children.map((c) => renderBlock(c, depth + 1)));
    },
    code_peek(b) {
        const body = h("div", { class: "frame-body" });
        const canDiff = hasBase(b.source);
        let diff = !!b.diff && canDiff;
        const load = () =>
            loadInto(body, b.source, { diff }).then((data) => {
                if (data && diff && !data.diff) {
                    diff = false;
                    toggle.hidden = true;
                    load();
                }
            });
        const toggle = canDiff ? h("button", { onclick: () => ((diff = !diff), (toggle.textContent = diff ? "Code" : "Diff"), load()) }, diff ? "Code" : "Diff") : h("span");
        const open = h("a", { href: "#", onclick: (e) => (e.preventDefault(), openPeek(srcLabel(b.source), [{ source: b.source }])) }, srcLabel(b.source));
        load();
        return frame("code", "", body, { right: h("span", { style: "display:flex;gap:6px;align-items:center" }, open, toggle), caption: b.caption });
    },
    trace_quote(b) {
        return h("div", { class: "quote" }, h("div", { class: "who" }, [b.role ?? "quote", b.attribution].filter(Boolean).join(" · ")), h("div", { class: "qt" }, b.text));
    },
    image(b) {
        return h("figure", { class: "img", style: "margin:0" }, h("img", { src: b.url, alt: b.alt, loading: "lazy" }), b.caption ? h("figcaption", { class: "caption" }, b.caption) : null);
    },
    sequence: renderSequence,
    flow_diagram: renderFlow,
    call_stack_diff: renderStack,
    database_lens: renderDatabase,
};

// ---------------- text measuring & wrapping ----------------
const measureCtx = document.createElement("canvas").getContext("2d");
function textWidth(t, size = 12, weight = 400) {
    measureCtx.font = `${weight} ${size}px ${getComputedStyle(document.body).fontFamily}`;
    return measureCtx.measureText(t).width;
}
function wrap(t, maxWidth, size = 12, maxLines = 4) {
    const words = String(t).split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
        const next = cur ? `${cur} ${w}` : w;
        if (textWidth(next, size) > maxWidth && cur) {
            lines.push(cur);
            cur = w;
        } else cur = next;
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
        lines.length = maxLines;
        lines[maxLines - 1] += "…";
    }
    return lines;
}

function markers(svg) {
    const defs = s("defs");
    for (const [id, cls, open] of [
        ["ah-muted", "arrowhead", false],
        ["ah-fg", "arrowhead fg", false],
        ["ah-purple", "arrowhead purple", true],
    ])
        defs.append(s("marker", { id: `${id}-${svg.dataset.uid}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: open ? "M1,1 L9,5 L1,9" : "M0,0 L10,5 L0,10 z", class: cls, ...(open ? { fill: "none", stroke: "var(--purple)", "stroke-width": 1.5 } : {}) })));
    svg.append(defs);
}
let uid = 0;

/** Which diagram units should play their drawing animation this render. */
function animationPlan(b, unitIds) {
    const le = animate?.lastEdit;
    if (!le || le.blockId !== b.id) return { isNew: () => false, delay: () => 0 };
    if (le.type === "insert" && !le.unit) {
        const order = new Map(unitIds.map((id, i) => [id, i]));
        return { isNew: (id) => order.has(id), delay: (id) => Math.min(order.get(id) ?? 0, 40) * 90 };
    }
    if (le.type === "replace" && !le.unit) {
        const order = new Map(unitIds.map((id, i) => [id, i]));
        return { isNew: (id) => order.has(id), delay: (id) => Math.min(order.get(id) ?? 0, 40) * 50 };
    }
    const fresh = new Set([le.unit ?? le.targetId, le.linkId].filter(Boolean));
    return { isNew: (id) => fresh.has(id), delay: (id) => (id === le.linkId ? 250 : 0) };
}

function drawAnim(pathEl, plan, id) {
    if (!plan.isNew(id)) return;
    pathEl.classList.add("draw");
    pathEl.style.animationDelay = `${plan.delay(id)}ms`;
    requestAnimationFrame(() => {
        try {
            pathEl.style.setProperty("--len", Math.ceil(pathEl.getTotalLength?.() ?? 400));
        } catch {}
    });
}
function popAnim(g, plan, id) {
    if (!plan.isNew(id)) return;
    g.classList.add("pop");
    g.style.animationDelay = `${plan.delay(id)}ms`;
}

// ---------------- sequence diagram ----------------
function renderSequence(b) {
    const keys = Object.keys(b.actors);
    const colW = Math.max(130, ...keys.map((k) => textWidth(b.actors[k], 12, 600) + 40));
    const pad = 20;
    const headH = 34;
    const stepGap = 18;
    const x = (k) => pad + colW / 2 + keys.indexOf(k) * colW;
    const rows = b.steps.map((st) => {
        const self = st.from === st.to;
        const span = self ? colW * 0.9 : Math.abs(x(st.to) - x(st.from)) - 16;
        const lines = wrap(`${st.label}`, Math.max(90, span), 12, 3);
        return { st, self, lines, h: lines.length * 15 + (self ? 30 : 16) };
    });
    const width = pad * 2 + colW * keys.length;
    const height = headH * 2 + 20 + rows.reduce((a, r) => a + r.h + stepGap, 0);
    const svg = s("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
    svg.dataset.uid = ++uid;
    markers(svg);
    const plan = animationPlan(
        b,
        b.steps.map((st) => st.id),
    );
    const actor = (k, y) => {
        const w = colW - 24;
        return s("g", { class: "actor" }, s("rect", { x: x(k) - w / 2, y, width: w, height: headH - 6, rx: 6 }), s("text", { x: x(k), y: y + (headH - 6) / 2 + 4, "text-anchor": "middle" }, b.actors[k]));
    };
    for (const k of keys) {
        svg.append(s("line", { class: "lifeline", x1: x(k), x2: x(k), y1: headH, y2: height - headH }));
        svg.append(actor(k, 2), actor(k, height - headH + 4));
    }
    let y = headH + 20;
    rows.forEach(({ st, self, lines, h: rh }, idx) => {
        const linked = !!(st.source || st.explanation || st.code);
        const g = s("g", { class: `msg ${st.style}${linked ? " linked" : ""}`, "data-unit": st.id });
        const x1 = x(st.from);
        const x2 = x(st.to);
        const marker = `url(#${st.style === "async" ? "ah-purple" : st.style === "return" ? "ah-muted" : "ah-fg"}-${svg.dataset.uid})`;
        const labelY = y + 12;
        const lineY = y + lines.length * 15 + 6;
        const cx = self ? x1 + 8 : (x1 + x2) / 2;
        g.append(s("rect", { class: "hit", x: Math.min(x1, x2) - 6, y: y - 4, width: Math.abs(x2 - x1) + (self ? colW * 0.6 : 12), height: rh + 6, rx: 4 }));
        lines.forEach((l, li) => {
            const t = s("text", { class: "lbl", x: self ? x1 + 10 : cx, y: labelY + li * 15, "text-anchor": self ? "start" : "middle" });
            if (li === 0) t.append(s("tspan", { class: "num" }, `${idx + 1}  `));
            t.append(document.createTextNode(l));
            g.append(t);
        });
        let path;
        if (self) path = s("path", { d: `M${x1},${lineY} h36 v16 h-34`, "marker-end": marker });
        else path = s("line", { x1: x1 + (x2 > x1 ? 2 : -2), x2: x2 + (x2 > x1 ? -3 : 3), y1: lineY, y2: lineY, "marker-end": marker });
        g.append(path);
        drawAnim(path, plan, st.id);
        if (plan.isNew(st.id)) {
            g.querySelectorAll("text").forEach((t) => {
                t.classList.add("fadein");
                t.style.animationDelay = `${plan.delay(st.id) + 150}ms`;
            });
        }
        g.addEventListener("click", () => openInspect(b.id, st.id));
        g.append(s("title", {}, `Inspect step ${idx + 1}`));
        svg.append(g);
        y += rh + stepGap;
    });
    return frame("sequence", b.title, h("div", { class: "diagram" }, svg), { right: inspectButton(b) });
}

// ---------------- flow diagram (layered layout) ----------------
function layoutFlow(b) {
    const keys = b.nodes.map((n) => n.key);
    const out = new Map(keys.map((k) => [k, []]));
    const indeg = new Map(keys.map((k) => [k, 0]));
    // Break cycles with DFS: edges to nodes on the current stack are back-edges.
    const state = new Map();
    const back = new Set();
    const adj = new Map(keys.map((k) => [k, []]));
    b.edges.forEach((e, i) => adj.get(e.from)?.push([e.to, i]));
    const dfs = (k) => {
        state.set(k, 1);
        for (const [t, i] of adj.get(k)) {
            if (state.get(t) === 1) back.add(i);
            else if (!state.get(t)) dfs(t);
        }
        state.set(k, 2);
    };
    const roots = keys.filter((k) => !b.edges.some((e) => e.to === k && e.from !== k));
    for (const k of [...roots, ...keys]) if (!state.get(k)) dfs(k);
    b.edges.forEach((e, i) => {
        if (back.has(i) || e.from === e.to) return;
        out.get(e.from).push(e.to);
        indeg.set(e.to, indeg.get(e.to) + 1);
    });
    const rank = new Map(keys.map((k) => [k, 0]));
    const queue = keys.filter((k) => indeg.get(k) === 0);
    const deg = new Map(indeg);
    while (queue.length) {
        const k = queue.shift();
        for (const t of out.get(k)) {
            rank.set(t, Math.max(rank.get(t), rank.get(k) + 1));
            deg.set(t, deg.get(t) - 1);
            if (deg.get(t) === 0) queue.push(t);
        }
    }
    const layers = [];
    for (const k of keys) (layers[rank.get(k)] ??= []).push(k);
    // One barycenter sweep to reduce crossings.
    const pos = new Map();
    layers.forEach((layer) => layer.forEach((k, i) => pos.set(k, i)));
    for (let li = 1; li < layers.length; li++) {
        const bc = (k) => {
            const preds = b.edges.filter((e) => e.to === k && rank.get(e.from) < li).map((e) => pos.get(e.from));
            return preds.length ? preds.reduce((a, c) => a + c, 0) / preds.length : pos.get(k);
        };
        layers[li].sort((a, c) => bc(a) - bc(c));
        layers[li].forEach((k, i) => pos.set(k, i));
    }
    return { layers: layers.filter(Boolean), rank, back };
}

function renderFlow(b) {
    const right = b.direction === "right";
    const { layers, back } = layoutFlow(b);
    const W = 176;
    const size = new Map();
    for (const n of b.nodes) {
        const lines = wrap(n.label, W - 24, 12, 3);
        const sub = n.description ? wrap(n.description, W - 24, 10.5, 2) : [];
        const clip = n.attachments?.length ? 1 : 0;
        size.set(n.key, { lines, sub, h: Math.max(n.kind === "decision" ? 54 : 40, 18 + lines.length * 15 + sub.length * 13 + clip * 13) });
    }
    const gapMain = right ? Math.max(70, ...b.edges.map((e) => (e.label ? textWidth(e.label, 11) + 30 : 0))) : 54;
    const gapCross = right ? 22 : 26;
    const layerExtent = layers.map((layer) => (right ? Math.max(...layer.map((k) => size.get(k).h)) : W));
    const layerCross = layers.map((layer) => layer.reduce((a, k) => a + (right ? size.get(k).h : W) + gapCross, -gapCross));
    const crossMax = Math.max(...layerCross);
    const pos = new Map();
    let main = 20;
    layers.forEach((layer, li) => {
        const mainSize = right ? W : Math.max(...layer.map((k) => size.get(k).h));
        let cross = 20 + (crossMax - layerCross[li]) / 2;
        for (const k of layer) {
            const sz = size.get(k);
            const w = W;
            const hh = sz.h;
            if (right) pos.set(k, { x: main, y: cross, w, h: hh });
            else pos.set(k, { x: cross, y: main + (mainSize - hh) / 2, w, h: hh });
            cross += (right ? hh : w) + gapCross;
        }
        main += (right ? W : mainSize) + gapMain;
        void layerExtent;
    });
    const width = right ? main - gapMain + 40 : crossMax + 40;
    const height = right ? crossMax + 40 : main - gapMain + 40;
    const svg = s("svg", { width, height: height + (back.size ? 20 : 0), viewBox: `0 0 ${width} ${height + (back.size ? 20 : 0)}` });
    svg.dataset.uid = ++uid;
    markers(svg);
    const plan = animationPlan(b, [...b.nodes.map((n) => n.id), ...b.edges.map((e) => e.id)]);
    // Edges beneath nodes. When a whole diagram is drawn, each edge waits for its later endpoint.
    const nodeDelay = new Map(b.nodes.map((n) => [n.key, plan.delay(n.id)]));
    const edgeLayer = s("g");
    svg.append(edgeLayer);
    b.edges.forEach((e, i) => {
        const a = pos.get(e.from);
        const c = pos.get(e.to);
        if (!a || !c) return;
        let d;
        let lx;
        let ly;
        if (e.from === e.to) {
            d = right ? `M${a.x + a.w - 20},${a.y} c 0,-26 40,-26 40,0` : `M${a.x + a.w},${a.y + 10} c 30,0 30,20 0,20`;
            lx = a.x + a.w + 10;
            ly = a.y - 14;
        } else if (back.has(i)) {
            if (right) {
                const yb = Math.max(a.y + a.h, c.y + c.h) + 18;
                d = `M${a.x + a.w / 2},${a.y + a.h} C${a.x + a.w / 2},${yb} ${c.x + c.w / 2},${yb} ${c.x + c.w / 2},${c.y + c.h + 2}`;
                lx = (a.x + c.x + a.w) / 2;
                ly = yb - 4;
            } else {
                const xb = Math.max(a.x + a.w, c.x + c.w) + 26;
                d = `M${a.x + a.w},${a.y + a.h / 2} C${xb},${a.y + a.h / 2} ${xb},${c.y + c.h / 2} ${c.x + c.w + 2},${c.y + c.h / 2}`;
                lx = xb - 6;
                ly = (a.y + c.y + c.h) / 2;
            }
        } else if (right) {
            const x1 = a.x + a.w;
            const y1 = a.y + a.h / 2;
            const x2 = c.x - 2;
            const y2 = c.y + c.h / 2;
            const mx = (x1 + x2) / 2;
            d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
            lx = mx;
            ly = (y1 + y2) / 2 - 4;
        } else {
            const x1 = a.x + a.w / 2;
            const y1 = a.y + a.h;
            const x2 = c.x + c.w / 2;
            const y2 = c.y - 2;
            const my = (y1 + y2) / 2;
            d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
            lx = (x1 + x2) / 2;
            ly = my;
        }
        const g = s("g", { class: `edge${e.style === "dashed" ? " dashed" : ""}`, "data-unit": e.id });
        const path = s("path", { d, "marker-end": `url(#ah-muted-${svg.dataset.uid})` });
        g.append(path);
        const edgePlan = {
            isNew: plan.isNew,
            delay: (id) => (animate?.lastEdit?.type === "insert" && !animate.lastEdit.unit ? Math.max(nodeDelay.get(e.from) ?? 0, nodeDelay.get(e.to) ?? 0) + 200 : plan.delay(id)),
        };
        drawAnim(path, edgePlan, e.id);
        if (e.label) {
            const tw = textWidth(e.label, 11) + 8;
            const lbl = s("g", { class: "elbl" }, s("rect", { x: lx - tw / 2, y: ly - 9, width: tw, height: 15, rx: 3 }), s("text", { x: lx, y: ly + 2, "text-anchor": "middle" }, e.label));
            popAnim(lbl, { isNew: edgePlan.isNew, delay: (id) => edgePlan.delay(id) + 250 }, e.id);
            g.append(lbl);
        }
        edgeLayer.append(g);
    });
    for (const n of b.nodes) {
        const p = pos.get(n.key);
        const sz = size.get(n.key);
        const linked = !!(n.attachments?.length || n.description);
        const g = s("g", { class: `node ${n.kind ?? "process"}${n.attachments?.length ? " linked" : ""}`, "data-unit": n.id });
        let shape;
        if (n.kind === "decision") {
            const k = 14;
            shape = s("polygon", { class: "shape", points: `${p.x + k},${p.y} ${p.x + p.w - k},${p.y} ${p.x + p.w},${p.y + p.h / 2} ${p.x + p.w - k},${p.y + p.h} ${p.x + k},${p.y + p.h} ${p.x},${p.y + p.h / 2}` });
        } else shape = s("rect", { class: "shape", x: p.x, y: p.y, width: p.w, height: p.h, rx: n.kind === "terminal" ? p.h / 2 : 7 });
        g.append(shape);
        const total = sz.lines.length * 15 + sz.sub.length * 13 + (n.attachments?.length ? 13 : 0);
        let ty = p.y + (p.h - total) / 2 + 11;
        for (const l of sz.lines) {
            g.append(s("text", { x: p.x + p.w / 2, y: ty, "text-anchor": "middle", "font-weight": 600 }, l));
            ty += 15;
        }
        for (const l of sz.sub) {
            g.append(s("text", { class: "sub", x: p.x + p.w / 2, y: ty, "text-anchor": "middle" }, l));
            ty += 13;
        }
        if (n.attachments?.length) g.append(s("text", { class: "clip", x: p.x + p.w / 2, y: ty, "text-anchor": "middle" }, `‹/› ${n.attachments.length === 1 ? n.attachments[0].label : `${n.attachments.length} code links`}`));
        g.append(s("title", {}, n.description ?? n.label));
        popAnim(g, plan, n.id);
        if (linked || n.notes?.length) g.addEventListener("click", () => openInspect(b.id, n.id));
        if (linked) g.style.cursor = "pointer";
        svg.append(g);
    }
    return frame("flow", b.title, h("div", { class: "diagram" }, b.description ? h("p", { class: "desc" }, b.description) : null, svg), { right: inspectButton(b) });
}

// ---------------- call stack diff ----------------
function renderStack(b) {
    const keyOf = (f) => f.key ?? `${f.source.file}:${f.source.startLine}`;
    const baseKeys = new Set(b.base.map(keyOf));
    const headKeys = new Set(b.head.map(keyOf));
    const col = (side, frames) => {
        const depth = new Map();
        const el = h("div", { class: "col" }, h("div", { class: "col-h" }, side === "base" ? "Before (base)" : "After (head)"));
        if (!frames.length) el.append(h("div", { class: "loading" }, side === "base" ? "No path before this change." : "Path removed."));
        for (const f of frames) {
            const d = f.parentKey ? (depth.get(f.parentKey) ?? 0) + 1 : 0;
            if (f.key) depth.set(f.key, d);
            const k = keyOf(f);
            const status = side === "head" && !baseKeys.has(k) ? "added" : side === "base" && !headKeys.has(k) ? "removed" : "";
            const name = f.label ?? `${f.source.file.split("/").pop()}:${f.source.startLine}`;
            const row = h(
                "div",
                {
                    class: `fr ${status}`,
                    title: status ? `${status} in this change` : "",
                    "data-unit": f.id,
                    onclick: () => openInspect(b.id, f.id),
                },
                h("span", { class: "tree" }, d ? `${"  ".repeat(d - 1)}└ ` : ""),
                h("span", { class: "fn" }, name),
                f.via ? h("span", { class: "via", title: f.via.reason }, f.via.kind) : null,
                status ? h("span", { class: `st ${status === "added" ? "added" : "deleted"}` }, status === "added" ? "new" : "gone") : null,
                h("span", { class: "loc" }, `${f.source.file.split("/").pop()}:${f.source.startLine}`),
            );
            el.append(row);
        }
        return el;
    };
    return frame("call stack", b.title, h("div", { class: "stack" }, col("base", b.base), col("head", b.head)), { right: inspectButton(b) });
}

// ---------------- database lens ----------------
function renderDatabase(b) {
    let selected = 0;
    const wrapEl = h("div");
    const actorLabel = (k) => (typeof b.actors[k] === "string" ? b.actors[k] : (b.actors[k]?.label ?? k));
    const draw = () => {
        const uc = b.useCases[selected];
        const touched = new Map(); // "store.coll" or "store.coll.field" -> kind
        for (const op of uc.operations) {
            touched.set(`${op.store}.${op.collection}`, op.kind);
            if (op.field) touched.set(`${op.store}.${op.collection}.${op.field}`, op.kind);
        }
        const fieldsEl = (store, coll, fields, prefix = "") =>
            Object.entries(fields).flatMap(([name, f]) => {
                const path = prefix ? `${prefix}.${name}` : name;
                const kind = touched.get(`${store}.${coll}.${path}`);
                const row = h(
                    "div",
                    { class: `db-field${kind ? ` ${kind}` : ""}`, style: prefix ? `padding-left:${4 + prefix.split(".").length * 12}px` : "" },
                    h("span", {}, `${f.primaryKey ? "🔑 " : ""}${f.label}`),
                    f.example !== undefined ? h("span", { class: "ex", title: "example" }, JSON.stringify(f.example).slice(0, 30)) : null,
                    h("span", { class: "ty" }, `${f.dataType}${f.nullable ? "?" : ""}${f.references ? ` → ${f.references.collection}.${f.references.field}` : ""}`),
                );
                return [row, ...(f.fields ? fieldsEl(store, coll, f.fields, path) : [])];
            });
        put(
            wrapEl,
            h(
                "div",
                { class: "db-cases" },
                b.useCases.map((u, i) => h("button", { class: i === selected ? "on" : "", onclick: () => ((selected = i), draw()) }, u.label)),
            ),
            uc.summary ? h("div", { class: "db-summary md", html: inline(uc.summary) }) : null,
            h(
                "div",
                { class: "db-stores" },
                Object.entries(b.stores).map(([sk, st]) =>
                    h(
                        "div",
                        { class: "db-store" },
                        h("div", { class: "h" }, `${st.label}`, h("span", { class: "badge", style: "margin-left:6px" }, st.dataStoreKind ?? st.storage)),
                        Object.entries(st.collections).map(([ck, c]) => h("div", { class: `db-coll${touched.has(`${sk}.${ck}`) ? " touched" : ""}` }, h("div", { class: "ch" }, c.label), fieldsEl(sk, ck, c.fields))),
                    ),
                ),
            ),
            h(
                "div",
                { class: "db-ops" },
                uc.operations.map((op) =>
                    h(
                        "div",
                        { class: "db-op", onclick: () => openPeek(`${op.kind} ${op.collection}${op.field ? `.${op.field}` : ""}: ${op.label}`, [...(op.detail ? [{ text: op.detail }] : []), { source: op.source, diff: hasBase(op.source) }]) },
                        h("span", { class: `k ${op.kind}` }, op.kind),
                        h("span", {}, op.label),
                        h("span", { class: "who" }, `${actorLabel(op.actor)} · ${b.stores[op.store]?.label ?? op.store}.${op.collection}${op.field ? `.${op.field}` : ""}`),
                    ),
                ),
            ),
        );
    };
    draw();
    return frame("data", b.title, wrapEl);
}

// ---------------- views ----------------
function setHeader() {
    const doc = state.doc;
    if (!renaming) {
        $("#title").textContent = doc ? doc.title : "Marginal";
        $("#title").title = doc ? `${doc.title}${canRename() ? "\n\nClick to rename" : ""}` : "";
        $("#title").classList.toggle("renamable", canRename());
    }
    // Subtitle parts; the branch names are the ones that give way (in the middle) when space runs out.
    const sub = [];
    if (doc?.kind === "scratchpad") sub.push({ t: "Scratchpad — newest first" });
    if (doc?.target) {
        const t = doc.target;
        sub.push({ t: state.repository ?? t.repositoryId }, { t: " · " }, { t: t.baseRef ?? t.base.slice(0, 8), branch: true }, { t: " … " }, { t: t.headRef ?? t.head.slice(0, 8), branch: true });
        if (t.headRef) sub.push({ t: ` (${t.head.slice(0, 8)})` });
    }
    if (doc?.pullRequest) sub.push({ t: "  ·  " }, { t: `PR ${doc.pullRequest.url.split("/").slice(-1)[0]}` });
    if (doc) sub.push({ t: "  ·  " }, { t: `v${doc.version}` });
    subParts = sub;
    const full = sub.map((p) => p.t).join("");
    $("#subtitle").title = doc?.target ? `${full}\n\nbase ${doc.target.base}\nhead ${doc.target.head}` : full;
    fitHeader();
    $("#tabs").hidden = !doc;
    // Offered inside the Copilot panel only; a browser window opened from it is already "outside".
    $("#open-external").hidden = INSTANCE.startsWith("browser-");
    for (const btn of document.querySelectorAll("#tabs button")) {
        const tab = btn.dataset.tab;
        btn.hidden = !doc || (!doc.target && (tab === "diff" || tab === "commits" || tab === "command"));
        btn.classList.toggle("on", tab === state.tab);
    }
    const banner = $("#banner");
    document.body.classList.toggle("previewing", !!state.preview);
    banner.classList.toggle("sg-bar", !!state.preview);
    if (state.preview) {
        banner.hidden = false;
        const p = state.preview;
        const n = p.hits?.length ?? 0;
        const btn = (cls, label, title, fn, extra = {}) => h("button", { class: cls, title, onclick: fn, ...extra }, label);
        put(
            banner,
            h("span", { class: "sg-title" }, "Previewing Copilot's suggestion", h("span", { class: "sg-sub" }, ` · not applied · ${n} change${n === 1 ? "" : "s"}`)),
            n > 1 ? h("span", { class: "sg-step" }, btn("sg-nav", "‹", "Previous change", () => stepPreview(-1), { "aria-label": "Previous change" }), h("span", { class: "sg-at" }, `${(p.at ?? 0) + 1} / ${n}`), btn("sg-nav", "›", "Next change", () => stepPreview(1), { "aria-label": "Next change" })) : null,
            h("span", { class: "sg-acts" }, btn("cs-apply", "Apply", "Make this change in the doc", () => chat.suggestionActs.get(p.proposalId)?.("apply")), btn("cs-dismiss", "Dismiss", "Leave the doc as it is", () => chat.suggestionActs.get(p.proposalId)?.("discard")), btn("sg-close", "Close preview", "Back to the doc as it is (Esc)", () => closePreview())),
        );
    } else if (state.viewVersion !== null) {
        banner.hidden = false;
        banner.replaceChildren(`Viewing version ${state.viewVersion} (read-only). `, h("a", { href: "#", onclick: (e) => (e.preventDefault(), (state.viewVersion = null), loadDoc()) }, "Back to latest"));
    } else banner.hidden = true;
    syncChatFab();
    syncChatModeToTab();
}

let activityOn = false;
function setActivity(list) {
    const a = (list ?? []).find((x) => x.scope === "document") ?? (list ?? [])[0];
    activityOn = !!a;
    if (a) $("#activity-text").textContent = a.focus ? `Copilot: ${a.focus}` : a.scope === "lenses" ? "Copilot is grouping files…" : "Copilot is drawing…";
    updateCenter();
}

/** The header's center slot shows one thing at a time: selection bar > hover hint > activity. */
let hintOn = false;
// Any selection (doc units or Command map tiles) owns the bar while it has picks.
multibar.onSync.push(() => updateCenter());
/** Priority: a selection, then typing in the chat, the hover hint, Copilot's activity, and when nothing else is going
 *  on, how to get around. (Editing prose takes the whole slot; see edit.js.) */
function updateCenter() {
    const multi = (activeSelection()?.size ?? 0) > 0;
    const typing = document.activeElement === chatText && !chatText.disabled && !$("#chat").hidden;
    $("#multibar").hidden = !multi;
    $("#chat-hint").hidden = multi || !typing;
    $("#hint").hidden = multi || typing || !hintOn;
    $("#activity").hidden = multi || typing || hintOn || !activityOn;
    $("#idle-hint").hidden = multi || typing || hintOn || activityOn || state.tab !== "board" || !state.doc || state.viewVersion !== null || !toc?.entries?.length;
}
if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#idle-hint .k-jump").textContent = "⌘";
// With the jump shortcut off, the reading hint only mentions what still works.
onSettings(() => {
    const on = shortcut("jump");
    for (const el of $("#idle-hint").querySelectorAll("kbd, .jh")) el.hidden = !on;
    updateCenter();
});

// ---- header: titles fit the room left of the centre slot; long branch names lose their middle, not their ends ----
let subParts = [];
let renaming = false;
const canRename = () => !!state.doc && state.doc.kind !== "scratchpad" && state.viewVersion === null;
const measure = document.createElement("canvas").getContext("2d");
function textW(el, s) {
    const cs = getComputedStyle(el);
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return measure.measureText(s).width;
}
const midCut = (s, n) => (s.length <= n ? s : n < 5 ? "…" : `${s.slice(0, Math.ceil((n - 1) * 0.55))}…${s.slice(s.length - Math.floor((n - 1) * 0.45))}`);
function fitHeader() {
    const titles = $("#titles");
    const bar = $("#bar");
    // A hint that would run into the tabs (narrow panels) steps aside; the titles take the room instead.
    const center = $("#center");
    center.classList.remove("tight");
    const shown = [...center.children].find((x) => !x.hidden);
    // Where the header's right-hand controls begin: the tabs, or the chat, settings and browser buttons without them.
    const rightEdge = () => Math.min(bar.getBoundingClientRect().right, ...[...document.querySelectorAll("#tabs:not([hidden]), #chat-btn:not([hidden]), #settings-btn, #open-external:not([hidden])")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => r.left));
    const tabsLeft = rightEdge();
    if (shown && (shown.id === "hint" || shown.classList.contains("hint")) && shown.getBoundingClientRect().right > tabsLeft - 8) center.classList.add("tight");
    // Room: up to the centre slot when it shows something, else up to the tabs.
    const tl = titles.getBoundingClientRect().left;
    const centre = center.classList.contains("tight") ? null : [...center.children].find((x) => !x.hidden);
    const stop = centre ? centre.getBoundingClientRect().left : rightEdge();
    titles.style.maxWidth = `${Math.max(140, stop - tl - 16)}px`;
    const sub = $("#subtitle");
    const room = Math.max(60, Math.min(titles.getBoundingClientRect().width || Infinity, stop - tl - 16)) - 2;
    const parts = subParts.map((p) => ({ ...p }));
    const width = () => textW(sub, parts.map((p) => p.t).join(""));
    // Shorten the longest branch name a few characters at a time until the line fits (or both are stubs).
    for (let guard = 0; guard < 400 && width() > room; guard++) {
        const br = parts.filter((p) => p.branch && p.t.length > 12);
        if (!br.length) break;
        const p = br.reduce((a, b) => (b.t.length > a.t.length ? b : a));
        p.t = midCut(subParts[parts.indexOf(p)].t, p.t.replace("…", "").length - 2);
    }
    put(sub, parts.map((p) => (p.branch ? h("span", { class: "st-br" }, p.t) : p.t)));
}
addEventListener("resize", () => fitHeader());
new MutationObserver(() => fitHeader()).observe($("#center"), { subtree: true, attributes: true, attributeFilter: ["hidden"] });

// Rename: click the title, type, Enter saves, Esc cancels.
$("#title").addEventListener("click", () => {
    if (!canRename() || renaming || prose?.active()) return;
    renaming = true;
    const el = $("#title");
    const input = h("input", { class: "title-in", value: state.doc.title, "aria-label": "Doc title", maxlength: 200, spellcheck: "false" });
    el.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        renaming = false;
        if (save && next && next !== state.doc.title) {
            try {
                await api(`/docs/${encodeURIComponent(state.documentId)}/rename`, { method: "POST", body: { title: next } });
                state.doc.title = next;
            } catch (e) {
                toast(`Couldn't rename: ${e.message}`);
            }
        }
        setHeader();
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // not the doc's shortcuts
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
});

function renderHome() {
    state.doc = null;
    setHeader();
    toc?.rebuild();
    setActivity([]);
    const main = $("#main");
    const pad = state.catalog.find((d) => d.kind === "scratchpad");
    const others = state.catalog.filter((d) => d.kind !== "scratchpad");
    const card = (d) =>
        h(
            "div",
            { class: "card", onclick: () => showDoc(d.documentId) },
            h("div", { class: "grow" }, h("div", { class: "t" }, d.title), h("div", { class: "m" }, [d.repository, d.pullRequest ? `PR ${d.pullRequest.url.split("/").pop()}` : null, `${d.blocks} blocks`, `updated ${new Date(d.updatedAt).toLocaleString()}`].filter(Boolean).join(" · "))),
            d.activity?.length ? h("span", { class: "badge live" }, "live") : null,
        );
    main.replaceChildren(
        h(
            "div",
            { class: "doc home" },
            pad ? [h("h2", {}, "Scratchpad"), card(pad)] : null,
            h("h2", {}, "Docs"),
            others.length ? others.map(card) : h("div", { class: "empty" }, "No docs yet. Ask Copilot to ", h("code", {}, "explain my branch in Marginal"), "."),
        ),
    );
}

function renderBoard() {
    const doc = state.preview?.doc ?? state.doc;
    const main = $("#main");
    const container = h("div", { class: "doc" });
    if (!doc.content.length)
        container.append(
            h(
                "div",
                { class: "empty" },
                doc.kind === "scratchpad" ? "The scratchpad is empty. Ask Copilot to sketch something here — a flow, a call path, a data shape." : "This doc is empty. Copilot's drawing will appear here live.",
            ),
        );
    const prevScroll = main.scrollTop;
    const prevHeight = main.querySelector(":scope > .doc")?.offsetHeight ?? 0;
    // Anchor: the first block on screen keeps its place, even if something above it grew or shrank.
    const mTop = main.getBoundingClientRect().top;
    const anchorEl = [...main.querySelectorAll(".block[data-id]:not(.b-section)")].find((el) => el.getBoundingClientRect().bottom > mTop + 1);
    const anchor = anchorEl && { id: anchorEl.dataset.id, top: anchorEl.getBoundingClientRect().top - mTop };
    animate = animate ?? null;
    for (const b of doc.content) container.append(renderBlock(b));
    // Code views load a moment after a re-render; hold the old height meanwhile so the reader's place isn't clamped.
    if (prevHeight) {
        container.style.minHeight = `${prevHeight}px`;
        setTimeout(() => (container.style.minHeight = ""), 2000);
    }
    main.replaceChildren(container);
    queueMicrotask(updateCenter); // the idle hint depends on the doc and its outline
    tables?.enhance(); // before restoring the scroll: wide tables change the page height
    main.scrollTop = prevScroll;
    const again = anchor && main.querySelector(`.block[data-id="${CSS.escape(anchor.id)}"]`);
    if (again) main.scrollTop += again.getBoundingClientRect().top - main.getBoundingClientRect().top - anchor.top;
    toc?.rebuild();
    // A live edit flashes where it is but never moves the page: the reader may be reading elsewhere. The chat reply
    // that made it lists it, and the Contents card marks it, for when they want to go look.
    if (animate?.scrollTo) toc?.fresh(animate.scrollTo);
    animate = null;
    if (state.preview) markPreview(main);
    markAsking(); // keep the discussed paragraph marked across live re-renders
    paintPicks();
    if (insp.blockId) decorateDiagram(); // the inspected diagram was just re-rendered
}

async function renderDiff() {
    const main = $("#main");
    main.replaceChildren(h("div", { class: "doc" }, h("div", { class: "loading" }, "Loading changes…")));
    const { files, lenses } = await api(`/docs/${encodeURIComponent(state.documentId)}/diff`);
    const matches = (lens, p) => lens.paths.some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x));
    const groups = lenses.map((l) => ({ lens: l, files: files.filter((f) => matches(l, f.path)) }));
    const rest = files.filter((f) => !lenses.some((l) => matches(l, f.path)));
    if (rest.length) groups.push({ lens: { id: "uncategorized", title: lenses.length ? "Uncategorized" : "Changed files", collapsed: false }, files: rest });
    const total = files.reduce((a, f) => [a[0] + f.additions, a[1] + f.deletions], [0, 0]);
    const fileEl = (f) => {
        const body = h("div", { class: "file-body", hidden: true });
        let loaded = false;
        const head = h(
            "div",
            {
                class: "file-h",
                onclick: async () => {
                    body.hidden = !body.hidden;
                    if (!body.hidden && !loaded) {
                        loaded = true;
                        body.replaceChildren(h("div", { class: "loading" }, "Loading…"));
                        try {
                            const data = await api(`/docs/${encodeURIComponent(state.documentId)}/diff?path=${encodeURIComponent(f.path)}`);
                            const lang = langOf(f.path);
                            body.replaceChildren(...data.hunks.flatMap((hk) => [h("div", { class: "code" }, h("div", { class: "gap" }, hk.header)), diffListing(hk.lines, lang)]));
                            if (!data.hunks.length) body.replaceChildren(h("div", { class: "loading" }, f.binary ? "Binary file." : "No textual changes."));
                        } catch (e) {
                            body.replaceChildren(h("div", { class: "error" }, e.message));
                        }
                    }
                },
            },
            h("span", { class: `st ${f.status}` }, f.status),
            h("span", { class: "p", title: f.previousPath ? `${f.previousPath} → ${f.path}` : f.path }, f.previousPath ? `${f.previousPath} → ${f.path}` : f.path),
            h("span", { class: "stat-a" }, `+${f.additions}`),
            h("span", { class: "stat-d" }, `−${f.deletions}`),
        );
        return h("div", { class: "file" }, head, body);
    };
    main.replaceChildren(
        h(
            "div",
            { class: "doc" },
            h("div", { class: "m", style: "color:var(--muted);font-size:12px;margin-bottom:10px" }, `${files.length} files changed · `, h("span", { class: "stat-a" }, `+${total[0]}`), " ", h("span", { class: "stat-d" }, `−${total[1]}`)),
            groups.map(({ lens, files: fs }) => {
                const el = h("div", { class: `lens${lens.collapsed ? " collapsed" : ""}` });
                el.append(h("div", { class: "lens-h", onclick: () => el.classList.toggle("collapsed") }, h("span", { class: "chev" }, "▾"), lens.title, h("span", { class: "badge" }, fs.length)), h("div", { class: "files" }, fs.map(fileEl)));
                return el;
            }),
        ),
    );
}

async function renderCommits() {
    const main = $("#main");
    const commits = await api(`/docs/${encodeURIComponent(state.documentId)}/commits`);
    main.replaceChildren(
        h(
            "div",
            { class: "doc" },
            commits.length ? commits.map((c) => h("div", { class: "list-row" }, h("span", { class: "sha" }, c.sha.slice(0, 8)), h("span", {}, c.subject), h("span", { class: "m" }, `${c.author} · ${new Date(c.date).toLocaleDateString()}`))) : h("div", { class: "empty" }, "No commits between base and head."),
        ),
    );
}

async function renderHistory() {
    const main = $("#main");
    const versions = (await api(`/docs/${encodeURIComponent(state.documentId)}/history`)).reverse();
    const verb = { insert: "Added", update: "Edited", replace: "Redrew", move: "Moved", remove: "Removed", lens_insert: "Added file group", lens_update: "Edited file group", lens_remove: "Removed file group" };
    const noun = (k = "") => ({ flow_node: "flow node", flow_edge: "flow edge", flow_diagram: "flow diagram", call_stack_diff: "call stack", database_lens: "data lens", code_peek: "code peek", trace_quote: "quote", markdown: "text", lens: "" })[k] ?? k.replace(/_/g, " ");
    const describe = (v) => {
        if (v.reason === "create") return "Created";
        if (v.reason === "rename") return `Renamed to “${v.title}”`;
        if (v.reason === "repin") return "Repinned to new commits";
        if (v.reason?.startsWith("restore:")) return `Restored version ${v.reason.split(":")[1]}`;
        if (v.lastEdit?.by === "user") return h("span", {}, "You edited text", " ", h("span", { class: "m-id" }, (v.lastEdit.blocks ?? [v.lastEdit.targetId]).join(", ")));
        if (v.lastEdit) return h("span", {}, `${verb[v.lastEdit.type] ?? v.lastEdit.type} ${noun(v.lastEdit.kind)}`.trim(), " ", h("span", { class: "m-id" }, v.lastEdit.targetId ?? ""));
        return v.reason ?? "";
    };
    main.replaceChildren(
        h(
            "div",
            { class: "doc" },
            versions.map((v) =>
                h(
                    "div",
                    {
                        class: `list-row clickable${v.version === state.doc.version ? " current" : ""}`,
                        onclick: () => {
                            state.viewVersion = v.version === state.doc.version ? null : v.version;
                            state.tab = "board";
                            loadDoc();
                        },
                    },
                    h("span", { class: "sha" }, `v${v.version}`),
                    h("span", {}, describe(v)),
                    h("span", { class: "m" }, new Date(v.at).toLocaleString()),
                ),
            ),
        ),
    );
}

async function render() {
    queueMicrotask(() => updateCenter());
    if (!state.documentId) return renderHome();
    if (!state.doc) return;
    setHeader();
    try {
        if (state.tab !== "command") command.unmount();
        if (state.tab === "board") renderBoard();
        else if (state.tab === "command") await command.mount();
        else if (state.tab === "diff") await renderDiff();
        else if (state.tab === "commits") await renderCommits();
        else if (state.tab === "history") await renderHistory();
    } catch (e) {
        $("#main").replaceChildren(h("div", { class: "doc error" }, e.message));
    }
    if (state.tab !== "board") {
        toc?.rebuild(); // hides the Contents card off the Doc tab
        if (insp.blockId) hidePeek(); // Inspect belongs to the doc's diagrams
    }
}

/** The Command tab lives in web/command/ and loads on first use. */
const command = {
    mod: null,
    async mount() {
        if (!state.doc?.target) {
            state.tab = "board";
            return render();
        }
        this.mod ??= await import("./command/tab.js");
        if (this.mod.isMounted() && this.docId === state.documentId) return;
        this.docId = state.documentId;
        await this.mod.mountCommand($("#main"), { documentId: state.documentId });
    },
    unmount() {
        this.mod?.unmountCommand();
        this.docId = null;
    },
};

async function loadDoc(lastEdit) {
    if (!state.documentId) return render();
    try {
        if (state.viewVersion !== null) {
            state.doc = await api(`/docs/${encodeURIComponent(state.documentId)}/versions/${state.viewVersion}`);
        } else {
            const data = await api(`/docs/${encodeURIComponent(state.documentId)}`);
            state.doc = data.doc;
            state.repository = data.repository;
            setActivity(data.activity);
            if (lastEdit && state.lastSeenVersion !== null && data.doc.version > state.lastSeenVersion) animate = { lastEdit: data.doc.lastEdit };
            state.lastSeenVersion = data.doc.version;
        }
        await render();
        refreshInspect();
    } catch (e) {
        state.doc = null;
        $("#main").replaceChildren(h("div", { class: "doc error" }, e.message));
    }
}

function showDoc(documentId) {
    clearPicks();
    state.preview = null; // a suggestion belongs to the doc it was made on
    state.documentId = documentId;
    state.viewVersion = null;
    state.tab = "board";
    state.lastSeenVersion = null;
    state.collapsed.clear();
    hidePeek();
    api(`/instance/${encodeURIComponent(INSTANCE)}/show`, { method: "POST", body: { documentId } }).catch(() => {});
    loadDoc();
}

const finishEditingFirst = () => {
    if (!prose?.active()) return false;
    toast("Finish editing first: Shift+Enter saves, Esc cancels");
    return true;
};
$("#home").onclick = async () => {
    if (finishEditingFirst()) return;
    state.catalog = await api("/catalog");
    showDoc(null);
};
for (const btn of document.querySelectorAll("#tabs button"))
    btn.onclick = () => {
        if (finishEditingFirst()) return;
        state.preview = null;
        state.tab = btn.dataset.tab;
        if (state.tab !== "board") state.viewVersion = state.viewVersion;
        render();
    };

// ---------------- live updates ----------------
let refreshTimer = null;
function scheduleRefresh() {
    // Never re-render under the reader's cursor: changes wait until they finish editing.
    if (prose?.active()) {
        pendingRefresh = true;
        return;
    }
    // Coalesce bursts of edits; each version still animates its own lastEdit when it is the newest.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        if (state.preview) refreshPreview();
        else if (state.viewVersion === null) loadDoc(true);
    }, 60);
}

function connect() {
    const es = new EventSource(`/api/events?instance=${encodeURIComponent(INSTANCE)}&t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = async (msg) => {
        const ev = JSON.parse(msg.data);
        if (ev.type === "show") {
            if (prose?.active() && ev.documentId !== state.documentId && state.booted) {
                pendingShow = ev;
                toast("Copilot opened another doc; it will show when you finish editing");
                return;
            }
            if (ev.documentId !== state.documentId || !state.booted) {
                const first = !state.booted;
                state.booted = true;
                clearPicks();
                state.preview = null;
                state.catalog = await api("/catalog").catch(() => state.catalog);
                state.documentId = ev.documentId;
                state.viewVersion = null;
                // ?tab= deep-links the first render (e.g. headless screenshots of the Command tab).
                state.tab = first && ["command", "diff", "commits", "history"].includes(INITIAL_TAB) ? INITIAL_TAB : "board";
                state.lastSeenVersion = null;
                await loadDoc();
                // This panel had the chat open before it reloaded: open it again, where it was.
                if (first && chat.reopen) openChat({});
            }
        } else if (ev.type === "version" && ev.documentId === state.documentId) {
            if (ev.lastEdit && ev.lastEdit.by !== "user" && ev.reason === "edit") recordChange(ev.lastEdit);
            if (state.tab === "board") scheduleRefresh();
            else if (state.viewVersion === null) {
                const data = await api(`/docs/${encodeURIComponent(state.documentId)}`);
                state.doc = data.doc;
                state.lastSeenVersion = data.doc.version;
                setHeader();
                if (state.tab === "history") renderHistory();
            }
        } else if (ev.type === "chat") onChatEvent(ev);
        else if (ev.type === "transcript") onTranscript(ev);
        else if (ev.type === "settings") settingsChanged(ev.settings);
        else if (ev.type === "command") bus.emit("command", ev);
        else if (ev.type === "activity" && ev.documentId === state.documentId) setActivity(ev.activity);
        else if (ev.type === "deleted" && ev.documentId === state.documentId) {
            state.catalog = await api("/catalog");
            showDoc(null);
        } else if (ev.type === "catalog" && !state.documentId) {
            state.catalog = await api("/catalog");
            renderHome();
        }
    };
    es.onerror = () => {
        // EventSource retries on its own; if the token rotated (extension reload), the host reopens the iframe.
    };
}

// ---------------- the chat ----------------
// One chat for every tab, doc and panel: it shows this session's whole conversation (lib/transcript.mjs), including
// what's typed in the Copilot app's own chat, and stays where it was put (ui.json). What a message carries depends on
// the tab it's sent from: on a doc, what it's about (a paragraph, a diagram, a selection) and Discuss/Edit; on the
// Command tab, the focus chips. Ctrl/Cmd+I (or the header's chat button) opens and closes it; Esc closes it.
const chat = { threadId: null, blockId: null, unit: null, quote: null, quoteLabel: null, awaiting: false, bubbles: new Map(), suggestions: new Map(), suggestionActs: new Map(), statusEl: null, mode: "board", focus: [], blocked: null, ref: null, askRows: null, askRange: null };
const chatLog = $("#chat-log");
const chatText = $("#chat-text");

/** Mark what the open chat is about: one paragraph (unit = its data-l range), a whole block, several picks,
 *  code lines (askRows) or an exact text selection (askRange, painted with the CSS Highlight API: no DOM changes). */
function markAsking() {
    document.querySelectorAll(".asking").forEach((el) => el.classList.remove("asking"));
    CSS.highlights?.delete("ask");
    markAskingInner();
    joinRuns();
    renderRef();
    const asking = chat.mode === "board" && !chat.docked && !$("#chat").hidden;
    toc?.marks(asking ? [...document.querySelectorAll("#main .asking"), chat.askRange && nodeElement(chat.askRange.startContainer)] : []);
}
function markAskingInner() {
    if ($("#chat").hidden) return;
    for (const row of chat.askRows ?? []) if (row.isConnected) row.classList.add("asking");
    if (chat.askRange && globalThis.Highlight && CSS.highlights) CSS.highlights.set("ask", new Highlight(chat.askRange));
    if (chat.picks?.length) {
        for (const key of chat.picks) elOf(key)?.classList.add("asking");
        return;
    }
    if (!chat.blockId) return;
    const block = document.querySelector(`.block[data-id="${CSS.escape(chat.blockId)}"]`);
    const target = chat.unit ? block?.querySelector(`.md [data-l="${chat.unit}"]`) : block;
    target?.classList.add("asking");
}

/** Leaving a conversation's context: a preview of one of its suggestions closes. The conversation itself goes on. */
function endThread() {
    if (state.preview) closePreview();
}

/** What the next message carries follows the tab: a doc's target and Discuss/Edit, or the Command tab's focus. */
function switchChatMode(mode) {
    if (chat.mode === mode && (mode !== "command" || chat.docId === state.documentId)) return;
    // Focus chips belong to one doc's Command center; a doc target belongs to the doc tab.
    if (mode === "command" && chat.docId !== state.documentId) chat.focus = [];
    if (mode === "command") chat.blockId = chat.unit = chat.picks = chat.ref = chat.askRows = chat.askRange = null;
    chat.quote = chat.quoteLabel = null;
    chat.docId = state.documentId;
    chat.mode = mode;
    chat.blocked = mode === "command" ? (svc.commandChatBlocked?.() ?? null) : null;
    syncBlocked();
    chatBox.classList.toggle("cmd-chat", mode === "command");
    chatText.placeholder = mode === "command" ? "Ask the orchestrator…" : "Ask Copilot…";
    $("#chat").setAttribute("aria-label", mode === "command" ? "Chat with the orchestrator" : "Chat with Copilot");
    renderChips();
    renderChatMode();
    markAsking();
}
/** The open chat follows the tab being looked at. */
function syncChatModeToTab() {
    if ($("#chat").hidden || chat.docked) return;
    switchChatMode(state.tab === "command" && state.doc?.target ? "command" : "board");
}

/** Focus chips (Command chat): items are {key, kind, label, cls?, item} where item is a Focus payload entry (docs/command-center.md). */
function addFocus(items) {
    for (const it of items) if (!chat.focus.some((f) => f.key === it.key)) chat.focus.push(it);
    chat.focus = chat.focus.slice(-40);
    renderChips();
}
function renderChips() {
    const host = $("#chat-chips");
    const quote = chat.mode === "command" && chat.quote ? h("span", { class: "chip quotec", title: chat.quote.slice(0, 400) }, h("span", { class: "k" }, "quote"), chat.quoteLabel ?? "selection", h("button", { class: "x", "aria-label": "Remove quote", onclick: () => ((chat.quote = chat.quoteLabel = null), renderChips()) }, "✕")) : null;
    const chips = chat.mode === "command" ? chat.focus.map((f) => h("span", { class: `chip ${f.cls ?? ""}`, title: f.title ?? f.label }, f.kindLabel ? h("span", { class: "k" }, f.kindLabel) : null, f.dot ? h("span", { class: "fdot" }) : null, h("span", { class: "lbl" }, f.label), h("button", { class: "x", "aria-label": `Remove ${f.label}`, onclick: () => ((chat.focus = chat.focus.filter((x) => x.key !== f.key)), renderChips(), svc.onFocusChange?.(chat.focus)) }, "✕"))) : [];
    put(host, quote, chips);
    host.hidden = !quote && !chips.length;
    fitHeight();
}

function openChat(ctx) {
    $("#ask-float").hidden = true;
    const mode = ctx.mode ?? (state.tab === "command" && state.doc?.target ? "command" : "board");
    const wasHidden = $("#chat").hidden;
    switchChatMode(mode);
    if (mode === "command") {
        if (ctx.focus?.length) addFocus(ctx.focus);
        if (ctx.quote) {
            chat.quote = ctx.quote;
            chat.quoteLabel = ctx.quoteLabel ?? null;
            renderChips();
        }
        chat.blocked = svc.commandChatBlocked?.() ?? null;
        syncBlocked();
        showChatBox(wasHidden);
        svc.onCommandChatOpen?.();
        markAsking(); // clears any doc-side marks and relabels the bar for the Command chat
        fitHeight();
        if (!chat.blocked) focusChatInput();
        svc.onFocusChange?.(chat.focus);
        return;
    }
    const open = !$("#chat").hidden && !chat.docked;
    const sameTarget = open && ctx.blockId === chat.blockId && ctx.quote === chat.quote && (ctx.unit ?? null) === chat.unit && (ctx.picks ?? []).join() === (chat.picks ?? []).join() && (ctx.range ?? null) === chat.askRange;
    if (!sameTarget) {
        // Commenting on something else moves what the next message is about; the conversation goes on.
        chat.quoteFresh = true; // the next message carries the new target's quote (and says what it's about)
        chat.focusGen = (chat.focusGen ?? 0) + 1;
        chat.blockId = ctx.blockId ?? null;
        chat.unit = ctx.unit ?? null;
        chat.picks = ctx.picks ?? null;
        chat.quote = ctx.quote ?? null;
        chat.ref = ctx.ref ?? null;
        chat.askRows = ctx.askRows ?? null;
        chat.askRange = ctx.range ?? null;
    }
    showChatBox(wasHidden);
    if (!peekEl.hidden) keepChatClear(peekEl.getBoundingClientRect().width);
    markAsking();
    renderChatMode(); // the doc may have changed since (the mode is remembered per doc)
    fitHeight();
    focusChatInput();
}

/** Show the window where it was (fitted to this viewport), load the conversation, and remember it's open. */
function showChatBox(wasHidden) {
    $("#chat").hidden = false;
    if (!chat.docked) placeBox();
    loadTranscript();
    if (wasHidden && !chat.docked && !chat.docking) persistOpen(true);
    syncChatFab();
}
function persistOpen(open) {
    api(`/ui?instance=${encodeURIComponent(INSTANCE)}`, { method: "POST", body: { open } }).catch(() => {});
}

/** Put the caret in the chat input, ready to type. In the Copilot app's panel the click that opened the chat can
 *  land focus back on the page after we set it, so re-assert it once the click has settled (unless the reader has
 *  since moved focus somewhere real). */
function focusChatInput() {
    if (chatText.disabled || chatBox.hidden) return;
    const put = () => {
        if (chatBox.hidden || chatText.disabled) return;
        const at = document.activeElement;
        if (at === chatText || (at && at !== document.body && !at.closest?.("#gutter, #multibar, #ask-float, #chat"))) return;
        if (!document.hasFocus()) window.focus();
        chatText.focus({ preventScroll: true });
        const end = chatText.value.length;
        chatText.setSelectionRange(end, end);
    };
    chatText.focus({ preventScroll: true });
    requestAnimationFrame(put);
    setTimeout(put, 120);
}
// The buttons that open the chat must not take focus themselves (a click would otherwise pull it back to them).
for (const sel of ["#gutter", "#multibar", "#ask-float"]) $(sel)?.addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());

/** Command chat is only live in the orchestrator's session (the lease owner); elsewhere say where to go. */
function syncBlocked() {
    const note = $("#chat-blocked") ?? h("div", { id: "chat-blocked", class: "chat-blocked", role: "note" });
    if (!note.isConnected) chatLog.before(note);
    note.textContent = chat.blocked ?? "";
    note.hidden = !chat.blocked;
    chatText.disabled = !!chat.blocked;
    $("#chat-send").disabled = !!chat.blocked || !chatText.value.trim() || chat.awaiting;
}

// ---- docking: the same chat, embedded at the bottom of a stepper (the Command walkthrough) for the whole walk ----
const chatHome = { parent: $("#chat").parentNode, next: $("#chat").nextSibling };
/** ctx: { mode: "board"|"command", blockId?, kind?, placeholder?, ref(): string, context(): string } */
function dockChat(slot, ctx) {
    if (!slot) return;
    if (chat.docked) undockChat();
    const floating = { style: chatBox.getAttribute("style"), hidden: chatBox.hidden };
    chat.docking = true; // opening to dock isn't the floating chat being opened
    if (ctx.mode === "command") openChat({ mode: "command" });
    else {
        switchChatMode("board");
        Object.assign(chat, { blockId: null, unit: null, picks: null, quote: null, ref: null, askRows: null, askRange: null });
        openChat({ mode: "board", blockId: ctx.blockId });
    }
    chat.docking = false;
    chat.docked = { slot, kind: ctx.kind, ref: ctx.ref, context: ctx.context, floating, placeholder: chatText.placeholder };
    if (ctx.placeholder) chatText.placeholder = ctx.placeholder;
    chatBox.removeAttribute("style");
    chatBox.classList.add("docked");
    slot.append(chatBox);
    chatBox.hidden = false;
    markAsking();
    syncChatFab();
}
function undockChat() {
    const d = chat.docked;
    if (!d) return;
    chat.docked = null;
    chatBox.classList.remove("docked");
    chatHome.parent.insertBefore(chatBox, chatHome.next?.parentNode === chatHome.parent ? chatHome.next : null);
    if (d.floating.style) chatBox.setAttribute("style", d.floating.style);
    chatText.placeholder = d.placeholder;
    // Back to how it was before the walk: open where it sat, or closed.
    chatBox.hidden = !!d.floating.hidden;
    if (!chatBox.hidden) placeBox();
    syncChatModeToTab();
    markAsking();
    syncChatFab();
}

/** A quiet line in the chat's drag bar naming what the conversation is about (the popup never covers the header). */
function renderRef() {
    let el = $("#chat-ref");
    if (!el) {
        el = h("span", { id: "chat-ref" });
        $("#chat-bar").insertBefore(el, $("#chat-clear") ?? $("#chat-close"));
    }
    const text = chat.docked?.ref?.() ?? (chat.mode === "command" ? "Copilot · Command center" : (chat.ref ?? "Copilot"));
    const marked = !chat.docked && chat.mode !== "command" && !!(chat.askRows?.length || chat.askRange || chat.picks?.length || chat.blockId);
    put(el, marked ? h("i", { class: "swatch", "aria-hidden": "true" }) : null, h("span", { class: "t" }, text));
    el.title = chat.quote ? chat.quote.slice(0, 600) : text;
    $("#chat").setAttribute("aria-description", text);
}

/** Short, single-line excerpt for labels. */
const excerpt = (t, n = 40) => {
    const s = String(t ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};
const BLOCK_NOUN = { code_peek: "Code peek", code: "Code", sequence: "Sequence", flow_diagram: "Flow", call_stack_diff: "Call stack", database_lens: "Data lens", trace_quote: "Quote", callout: "Callout", image: "Image", markdown: "Text", section: "Section" };
/** Where an element sits: the nearest heading above it in its text, else its section's title. */
function sectionOf(el) {
    const md = el?.closest(".md");
    if (md) {
        const heads = [...md.querySelectorAll("h1, h2, h3, h4")].filter((hd) => hd !== el && hd.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (heads.length) return excerpt(heads.at(-1).textContent, 30);
    }
    const sec = el?.closest(".block.b-section, .block.b-callout");
    const b = sec && findBlock(state.doc?.content, sec.dataset.id);
    return b?.title ? excerpt(b.title, 30) : null;
}
const UNIT_KIND = { P: "paragraph", LI: "list item", H1: "heading", H2: "heading", H3: "heading", H4: "heading", BLOCKQUOTE: "quote", TABLE: "table", PRE: "code", UL: "list", OL: "list" };
/** Label for a comment target: where it is (section · kind of text), or the block kind + title for diagrams and code. */
function refOf(t, selection, el) {
    if (el?.dataset.pk) return selection ? `${el.dataset.ref.split(" · ").slice(0, 2).join(" · ")} · selection` : el.dataset.ref;
    if (t.unit || (selection && el?.matches?.("[data-l]"))) {
        const kind = UNIT_KIND[el?.tagName] ?? "text";
        const where = sectionOf(el);
        return `${where ? `${where} · ` : ""}${selection ? `selection in ${kind}` : kind}`;
    }
    const b = t.blockId && findBlock(state.doc?.content, t.blockId);
    if (!b) return selection ? `${sectionOf(el) ?? "Doc"} · selection` : null;
    const title = b.title ?? b.caption ?? b.source?.file?.split("/").pop();
    return `${BLOCK_NOUN[b.type] ?? "Block"}${title ? ` · ${excerpt(title, 34)}` : ""}`;
}

function closeChat() {
    if (chat.docked) return;
    const was = !$("#chat").hidden;
    $("#chat").hidden = true;
    // The conversation stays; what a doc message was about is let go.
    chat.blockId = chat.unit = chat.picks = chat.ref = chat.askRows = chat.askRange = null;
    if (chat.mode === "board") chat.quote = null;
    markAsking();
    if (was) persistOpen(false);
    syncChatFab();
}
function toggleChat() {
    if (chat.docked) return focusChatInput();
    if ($("#chat").hidden) openChat({});
    else closeChat();
}

/** The header's chat button shows whether the chat is open. */
function syncChatFab() {
    const btn = $("#chat-btn");
    if (!btn) return;
    const open = !$("#chat").hidden;
    btn.setAttribute("aria-pressed", String(open));
    btn.classList.toggle("on", open);
    btn.title = `${open ? "Close the chat" : "Open the chat"}${shortcut("chat") ? ` (${MAC_KEYS ? "⌘" : "Ctrl"}+I)` : ""}`;
}
$("#chat-btn").onclick = () => toggleChat();
$("#chat-btn").addEventListener("mousedown", (e) => e.preventDefault());
document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "i" || !shortcut("chat")) return;
    // Italic while editing prose.
    if (e.target.closest?.('[contenteditable="true"]')) return;
    e.preventDefault();
    toggleChat();
});

function scrollChat() {
    chatLog.scrollTop = chatLog.scrollHeight;
    fitHeight(); // the first message ends the compact empty state
    updateFades();
}

function updateFades() {
    const { scrollTop, scrollHeight, clientHeight } = chatLog;
    chatLog.classList.toggle("more-above", scrollTop > 2);
    chatLog.classList.toggle("more-below", scrollTop + clientHeight < scrollHeight - 2);
}
chatLog.addEventListener("scroll", updateFades, { passive: true });
new ResizeObserver(updateFades).observe(chatLog);

// Move and resize. The window is placed by its top-left corner and size: a drag only moves it (the bar follows the
// pointer exactly) and the corner handle only resizes it. Either way the whole window stays in the viewable area,
// shrinking only when the viewport is smaller than it. One box for every tab, doc, panel and window (ui.json).
const chatBox = $("#chat");
function placeBox() {
    if (chat.docked) return;
    const b = fitBox(chat.box ?? defaultBox(innerWidth, innerHeight), innerWidth, innerHeight);
    Object.assign(chatBox.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, right: "auto", bottom: "auto", maxHeight: "none" });
}
let saveBoxT = 0;
function saveBox() {
    clearTimeout(saveBoxT);
    saveBoxT = setTimeout(() => api(`/ui?instance=${encodeURIComponent(INSTANCE)}`, { method: "POST", body: { box: chat.box } }).catch(() => {}), 200);
}
/** The window keeps the size it was given; nothing about its contents changes it. */
function fitHeight() {}
function track(handle, onMove) {
    handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || chat.docked || e.target.closest("#chat-close, #chat-clear")) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const r = chatBox.getBoundingClientRect();
        const start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top, w: r.width, h: r.height };
        chatBox.classList.add("dragging");
        const move = (ev) => {
            onMove(start, ev.clientX - start.px, ev.clientY - start.py);
            placeBox();
        };
        const up = () => {
            chatBox.classList.remove("dragging");
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            saveBox();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    });
}
track($("#chat-bar"), (s, dx, dy) => (chat.box = dragBox(s, dx, dy, innerWidth, innerHeight)));
track($("#chat-resize"), (s, dx, dy) => (chat.box = resizeBox(s, dx, dy, innerWidth, innerHeight)));
addEventListener("resize", () => !chatBox.hidden && placeBox());

function setStatus(text) {
    if (!text) {
        chat.statusEl?.remove();
        chat.statusEl = null;
        return;
    }
    if (!chat.statusEl) chat.statusEl = h("div", { class: "chat-status" }, h("span", { class: "pulse" }), h("span", { class: "t" }));
    chat.statusEl.querySelector(".t").textContent = text;
    chatLog.append(chat.statusEl); // keep it last
    scrollChat();
}

function bubble(messageId) {
    let el = chat.bubbles.get(messageId);
    if (!el) {
        el = h("div", { class: "chat-msg bot md" });
        el.dataset.raw = "";
        chat.bubbles.set(messageId, el);
        chatLog.insertBefore(el, chat.statusEl);
    }
    return el;
}

function onChatEvent(ev) {
    // Suggestions held from a Discuss turn show wherever the chat is.
    if (ev.kind === "proposal") return void showSuggestion(ev);
    if (!chat.threadId && chat.awaiting) chat.threadId = ev.threadId; // events can beat the HTTP response
    if (ev.threadId !== chat.threadId) return;
    if (ev.kind === "done") {
        const turn = chat.turn;
        if (turn) {
            if (turn.el) chatLog.insertBefore(turn.el, chat.statusEl); // under the final reply
            if (turn.suggest) chatLog.insertBefore(turn.suggest, chat.statusEl);
            setTimeout(() => turn === chat.turn && (turn.open = false), 2500); // edits can land just after the reply
        }
    }
}

// ---- the conversation: the session's transcript, the same in every tab, doc, panel and window ----
const TR = { loaded: false, loading: null, buffer: null, cursor: null, els: new Map() };
const SOURCE_NOTE = { app: "In the Copilot app", session: "From another session" };
const PLAN_ACTION = { interactive: "Approve", autopilot: "Approve, autopilot", autopilot_fleet: "Approve, autopilot with helpers", exit_only: "Approve, don't start" };
async function loadTranscript() {
    if (TR.loaded || TR.loading) return TR.loading;
    TR.buffer = [];
    TR.loading = (async () => {
        try {
            const r = await api("/transcript");
            TR.seq = r.seq ?? 0;
            for (const it of r.items) upsertItem(it, { at: "end" });
            TR.cursor = r.cursor;
            for (const p of r.proposals ?? []) showSuggestion(p);
            syncOlder();
            setTrStatus(r.status);
            TR.loaded = true;
            // Events that arrived while it loaded: the snapshot already includes those numbered up to its seq.
            const late = TR.buffer.splice(0).filter((e) => !(e.seq <= TR.seq));
            TR.buffer = null;
            for (const e of late) onTranscript(e);
        } catch (e) {
            chatLog.append(h("div", { class: "chat-error" }, `Couldn't load the conversation: ${e.message}`));
        } finally {
            TR.buffer = null;
            TR.loading = null;
            scrollChat();
        }
    })();
    return TR.loading;
}
async function loadOlder(btn) {
    if (!TR.cursor) return;
    btn.disabled = true;
    const before = chatLog.scrollHeight;
    try {
        const r = await api(`/transcript?cursor=${encodeURIComponent(TR.cursor)}`);
        for (const it of [...r.items].reverse()) upsertItem(it, { at: "start" });
        TR.cursor = r.cursor;
    } catch (e) {
        toast(e.message);
    }
    btn.disabled = false;
    syncOlder();
    chatLog.scrollTop += chatLog.scrollHeight - before; // keep what was on screen in place
}
function syncOlder() {
    let btn = chatLog.querySelector(":scope > .chat-older");
    if (!TR.cursor) return void btn?.remove();
    if (!btn) {
        btn = h("button", { class: "chat-older", onclick: () => loadOlder(btn) }, "Show earlier");
        chatLog.prepend(btn);
    }
}
function onTranscript(e) {
    if (TR.buffer) return void TR.buffer.push(e);
    if (!TR.loaded) return; // nothing shown yet: the first load reads the current state
    if (e.op === "status") return setTrStatus(e.status);
    if (e.op === "remove") {
        TR.els.get(e.id)?.remove();
        TR.els.delete(e.id);
        return;
    }
    if (e.op === "delta") {
        const el = TR.els.get(e.id) ?? upsertItem({ kind: "reply", id: e.id, text: "", streaming: true }, { at: "end" });
        el.dataset.raw = (el.dataset.raw ?? "") + e.text;
        el.innerHTML = markdown(el.dataset.raw);
        return void scrollChatIfNear();
    }
    if (e.op === "upsert") {
        upsertItem(e.item, { at: "end" });
        scrollChatIfNear();
    }
}
function setTrStatus(status) {
    chat.trStatus = status;
    setStatus(status === "working" ? "Working" : status === "waiting" ? "Waiting on you" : null);
    chat.statusEl?.classList.toggle("waiting", status === "waiting");
}
/** Stay at the bottom while new messages arrive, unless the reader scrolled up to read. */
function scrollChatIfNear() {
    const near = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 120;
    if (near) scrollChat();
    else updateFades();
}
function upsertItem(it, { at }) {
    const old = TR.els.get(it.id);
    // A message sent from here shows at once; the transcript's copy takes its place. Copilot starting on it makes
    // its turn the one that doc changes are listed under.
    let pending = null;
    if (!old && it.kind === "user" && it.source === "marginal") pending = [...chatLog.querySelectorAll(":scope > .chat-u.pending")].find((el) => el.dataset.text === it.text.trim());
    if (pending?._turn) chat.turn = pending._turn;
    const el = itemEl(it, old ?? pending);
    TR.els.set(it.id, el);
    if (old || pending) {
        if ((old ?? pending) !== el) (old ?? pending).replaceWith(el);
        if (it.kind === "changes") placeUnder(el, it.afterId);
        return el;
    }
    if (it.kind === "changes" && it.afterId && TR.els.get(it.afterId)?.isConnected) return (placeUnder(el, it.afterId), el);
    if (at === "start") (chatLog.querySelector(":scope > .chat-older")?.nextSibling ? chatLog.querySelector(":scope > .chat-older").after(el) : chatLog.prepend(el));
    else chatLog.insertBefore(el, chat.statusEl);
    return el;
}
/** Put an element right under a transcript item (a reply), or at the end if that isn't shown. */
function placeUnder(el, afterId) {
    const ref = afterId && TR.els.get(afterId);
    if (ref?.isConnected) ref.after(el);
    else chatLog.insertBefore(el, chat.statusEl);
}
/** Where a turn's reply ends: after its user message, before the next one. */
function endOfTurn(userId) {
    const u = userId && TR.els.get(userId);
    if (!u?.isConnected) return null;
    let el = u;
    while (el.nextElementSibling && !el.nextElementSibling.matches(".chat-u, .chat-status")) el = el.nextElementSibling;
    return el;
}
function itemEl(it, reuse) {
    if (it.kind === "reply") {
        const el = reuse?.classList.contains("bot") ? reuse : h("div", { class: "chat-msg bot md" });
        el.dataset.id = it.id;
        el.dataset.raw = it.text;
        el.innerHTML = markdown(it.text);
        el.classList.toggle("streaming", !!it.streaming);
        return el;
    }
    if (it.kind === "user") {
        const discuss = reuse?.querySelector(".chat-msg.me.discuss");
        const note = SOURCE_NOTE[it.source] ?? it.context ?? null;
        return h(
            "div",
            { class: `chat-u src-${it.source}`, "data-id": it.id },
            h("div", { class: `chat-msg me${discuss ? " discuss" : ""}`, title: discuss?.title ?? null }, it.text),
            note || it.delivery === "steering" ? h("div", { class: "chat-meta" }, [note, it.delivery === "steering" ? "sent while it was working" : null].filter(Boolean).join(" · ")) : null,
        );
    }
    if (it.kind === "activity") {
        const summary = activitySummaryText(it);
        const open = reuse?.open ?? false;
        const running = it.helpers.filter((x) => x.status === "running").length;
        return h(
            "details",
            { class: `chat-act${it.done ? "" : " live"}`, "data-id": it.id, open: open || null },
            h("summary", {}, it.done ? null : h("span", { class: "pulse" }), h("span", { class: "t" }, summary), running ? h("span", { class: "n" }, ` · ${running} helper${running === 1 ? "" : "s"} running`) : null),
            h("ul", {}, it.recent.map((r) => h("li", {}, r)), it.helpers.map((x) => h("li", { class: `hlp ${x.status}` }, `helper · ${x.name} · ${x.status}`))),
        );
    }
    if (it.kind === "changes") return changesItemEl(it);
    if (it.kind === "question") return questionEl(it);
    if (it.kind === "plan") return planEl(it);
    return h("div", { "data-id": it.id });
}
const ACT_KIND = { read: ["Read", "file", "files"], search: ["Searched", "time", "times"], edit: ["Edited", "file", "files"], run: ["Ran", "command", "commands"], web: ["Looked up", "page", "pages"], canvas: ["Updated", "canvas", "canvases"], todo: ["Updated the todo list"], other: ["Used", "tool", "tools"] };
/** What Copilot changed in a doc during a turn: on that doc, each change one click away; elsewhere, a count. */
function changesItemEl(it, again = true) {
    const here = it.docId === state.documentId;
    const all = it.edits;
    const shown = all.slice(-6);
    const el = h(
        "div",
        { class: "chat-changes", "data-id": it.id, role: "group", "aria-label": "Doc changes in this reply" },
        h("span", { class: "cc-h" }, here ? "Changed" : `Changed “${excerpt(it.title || "a doc", 40)}”`),
        here
            ? shown.map((le) =>
                  le.type === "remove"
                      ? h("span", { class: "chg gone", title: "Removed from the doc" }, changeLabel(le))
                      : h("button", { class: "chg", title: "Show in the doc", onclick: () => showChange(le) }, h("span", { class: "chg-ic", "aria-hidden": "true", html: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M5 11l6-6M6 5h5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }), changeLabel(le)),
              )
            : h("span", { class: "chg more" }, `${all.length} part${all.length === 1 ? "" : "s"}`),
        here && all.length > shown.length ? h("span", { class: "chg more" }, `+${all.length - shown.length} more`) : null,
    );
    // Labels read the doc, which reloads a moment after the edit.
    if (here && again)
        setTimeout(() => {
            if (!el.isConnected || TR.els.get(it.id) !== el) return;
            const fresh = changesItemEl(it, false);
            el.replaceWith(fresh);
            TR.els.set(it.id, fresh);
        }, 400);
    return el;
}
function activitySummaryText(it) {
    const parts = Object.entries(it.tools).map(([k, n]) => {
        const [verb, one, many] = ACT_KIND[k] ?? ACT_KIND.other;
        return one === undefined ? verb : `${verb} ${n} ${n === 1 ? one : many}`;
    });
    if (it.helpers.length && !parts.length) parts.push(`Started ${it.helpers.length} helper${it.helpers.length === 1 ? "" : "s"}`);
    return parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(" · ") || "Working";
}
async function answerItem(it, body, card) {
    for (const b of card.querySelectorAll("button, textarea")) b.disabled = true;
    try {
        await api("/transcript/answer", { method: "POST", body: { id: it.id, ...body } });
    } catch (e) {
        for (const b of card.querySelectorAll("button, textarea")) b.disabled = false;
        toast(e.message);
    }
}
function questionEl(it) {
    const card = h("div", { class: `chat-q${it.status === "pending" ? " pending" : ""}`, "data-id": it.id, role: "group", "aria-label": "Copilot's question" });
    const head = h("div", { class: "q-h" }, h("span", { class: "q-ic", "aria-hidden": "true" }, "?"), it.status === "pending" ? "Copilot is asking" : "Copilot asked");
    const q = h("div", { class: "q-t md", html: markdown(it.question) });
    if (it.status !== "pending") {
        put(card, head, q, h("div", { class: "q-done" }, it.answer ? ["Answer: ", h("b", {}, it.answer)] : "Answered"));
        return card;
    }
    if (!it.answerable) {
        put(card, head, q, it.choices?.length ? h("div", { class: "q-choices" }, it.choices.map((c) => h("span", { class: "q-choice static" }, c))) : null, h("div", { class: "q-note" }, "Answer it in the Copilot app's chat."));
        return card;
    }
    const text = h("textarea", { class: "q-text", rows: "1", placeholder: it.choices?.length ? "Or type an answer…" : "Type your answer…", "aria-label": "Your answer" });
    const sendFree = () => text.value.trim() && answerItem(it, { answer: text.value.trim(), wasFreeform: true }, card);
    text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendFree();
        }
    });
    put(
        card,
        head,
        q,
        it.choices?.length ? h("div", { class: "q-choices" }, it.choices.map((c) => h("button", { class: "q-choice", onclick: () => answerItem(it, { answer: c, wasFreeform: false }, card) }, c))) : null,
        it.allowFreeform !== false ? h("div", { class: "q-free" }, text, h("button", { class: "q-send", onclick: sendFree }, "Answer")) : null,
    );
    return card;
}
function planEl(it) {
    const card = h("div", { class: `chat-q plan${it.status === "pending" ? " pending" : ""}`, "data-id": it.id, role: "group", "aria-label": "Copilot's plan" });
    const head = h("div", { class: "q-h" }, h("span", { class: "q-ic", "aria-hidden": "true" }, "✓"), it.status === "pending" ? "Copilot's plan is ready" : "Copilot's plan");
    const sum = h("div", { class: "q-t md", html: markdown(it.summary || "") });
    const full = it.planContent ? h("details", { class: "q-plan" }, h("summary", {}, "Show the plan"), h("div", { class: "md", html: markdown(it.planContent) })) : null;
    if (it.status !== "pending") {
        put(card, head, sum, full, h("div", { class: "q-done" }, it.approved ? `Approved${it.selectedAction ? ` (${PLAN_ACTION[it.selectedAction] ?? it.selectedAction})` : ""}` : it.feedback ? ["Sent back: ", h("b", {}, it.feedback)] : "Not approved"));
        return card;
    }
    if (!it.answerable) {
        put(card, head, sum, full, h("div", { class: "q-note" }, "Approve it in the Copilot app."));
        return card;
    }
    const fb = h("textarea", { class: "q-text", rows: "1", placeholder: "What should change?", "aria-label": "Feedback on the plan" });
    const actions = (it.actions?.length ? it.actions : ["interactive"]).filter((a) => PLAN_ACTION[a]);
    put(
        card,
        head,
        sum,
        full,
        h("div", { class: "q-choices" }, actions.map((a) => h("button", { class: `q-choice${a === it.recommendedAction ? " rec" : ""}`, onclick: () => answerItem(it, { approved: true, selectedAction: a }, card) }, PLAN_ACTION[a]))),
        h("div", { class: "q-free" }, fb, h("button", { class: "q-send", onclick: () => fb.value.trim() && answerItem(it, { approved: false, feedback: fb.value.trim() }, card) }, "Send back")),
    );
    return card;
}

// ---- changes Copilot made while answering: listed under the reply, one click away ----
const CHANGE_NOUN = { step: "step", flow_node: "flow node", flow_edge: "flow edge", frame: "frame", markdown: "text", section: "section", callout: "callout", code: "code", code_peek: "code peek", sequence: "sequence", flow_diagram: "flow", call_stack_diff: "call stack", database_lens: "data lens", image: "image", trace_quote: "quote" };
function changeEl(le) {
    const q = (id) => id && (document.querySelector(`#main [data-unit="${CSS.escape(id)}"]`) ?? document.querySelector(`#main .block[data-id="${CSS.escape(id)}"]`));
    return q(le.targetId) ?? q(le.blockId) ?? q(le.topBlockId);
}
function changeLabel(le) {
    const verb = le.type === "insert" ? "Added" : le.type === "remove" ? "Removed" : le.fields?.includes("notes") ? "Added notes to" : "Changed";
    const noun = CHANGE_NOUN[le.kind] ?? "part";
    const b = findBlock(state.doc?.content, le.targetId);
    const el = le.type === "remove" ? null : changeEl(le);
    const title = b?.title ?? b?.caption ?? el?.querySelector?.("text.lbl, .fn, .shape + text")?.textContent?.replace(/^\d+\s+/, "");
    const where = el ? sectionOf(el.matches(".block") ? el : el.closest(".block") ?? el) : null;
    return `${verb} ${noun}${title ? ` “${excerpt(title, 30)}”` : where ? ` in ${where}` : ""}`;
}
function recordChange(le) {
    const turn = chat.turn;
    // A reply's changes are on the transcript; this lists what applying a held suggestion changed, under it.
    if (!turn?.open || !turn.anchor) return;
    const key = le.targetId ?? le.blockId;
    if (!key) return;
    turn.changes.set(key, le);
    turn.el ??= h("div", { class: "chat-changes", role: "group", "aria-label": "Doc changes in this reply" });
    if (turn.anchor?.isConnected) turn.anchor.after(turn.el);
    else chatLog.insertBefore(turn.el, chat.statusEl); // follows the reply as it streams
    // Labels read the updated doc, which loads a moment after the event.
    setTimeout(() => renderChanges(turn), 250);
    renderChanges(turn);
}
function renderChanges(turn) {
    if (!turn.el) return;
    const all = [...turn.changes.values()];
    const shown = all.slice(0, 6);
    put(
        turn.el,
        h("span", { class: "cc-h" }, "Changed"),
        shown.map((le) =>
            le.type === "remove"
                ? h("span", { class: "chg gone", title: "Removed from the doc" }, changeLabel(le))
                : h(
                      "button",
                      { class: "chg", title: "Show in the doc", onclick: () => showChange(le) },
                      h("span", { class: "chg-ic", "aria-hidden": "true", html: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M5 11l6-6M6 5h5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
                      changeLabel(le),
                  ),
        ),
        all.length > shown.length ? h("span", { class: "chg more" }, `+${all.length - shown.length} more`) : null,
    );
    scrollChat();
}
async function showChange(le) {
    if (prose?.active()) return toast("Finish editing first: Shift+Enter saves, Esc cancels");
    if (state.tab !== "board" || state.viewVersion !== null) {
        state.tab = "board";
        state.viewVersion = null;
        await loadDoc();
    }
    // Notes on a diagram step are read in Inspect.
    if (le.fields?.includes("notes") && ["step", "flow_node", "frame"].includes(le.kind) && le.blockId) return openInspect(le.blockId, le.targetId);
    const el = changeEl(le);
    if (!el) return toast("That part is no longer in the doc.");
    toc?.reveal(el, { flash: el.matches(".block") ? el : (el.closest(".block") ?? el) });
}

// ---- previewing a held suggestion in the doc ----
async function openPreview(threadId, proposalId) {
    if (finishEditingFirst()) return;
    if (state.preview?.proposalId === proposalId) return stepPreview(0);
    let res;
    try {
        res = await api(`/ask/preview?threadId=${encodeURIComponent(threadId)}&proposalId=${encodeURIComponent(proposalId)}`);
    } catch (e) {
        return toast(e.message);
    }
    if (state.tab !== "board" || state.viewVersion !== null) {
        state.tab = "board";
        state.viewVersion = null;
        await loadDoc();
    }
    clearPicks();
    state.preview = { threadId, proposalId, doc: res.doc, changes: res.changes, gone: captureGone($("#main"), res.changes), at: 0 };
    await render();
    stepPreview(0);
}
/** The doc changed underneath the preview: show the suggestion against the doc as it is now. */
async function refreshPreview() {
    const p = state.preview;
    if (!p) return;
    try {
        const [res, data] = await Promise.all([api(`/ask/preview?threadId=${encodeURIComponent(p.threadId)}&proposalId=${encodeURIComponent(p.proposalId)}`), api(`/docs/${encodeURIComponent(state.documentId)}`)]);
        if (state.preview !== p) return;
        state.doc = data.doc;
        state.lastSeenVersion = data.doc.version;
        // What a removal would take away is read from the doc as it is now, rendered off the page.
        const base = h("div", { class: "doc" }, data.doc.content.map((b) => renderBlock(b)));
        Object.assign(p, { doc: res.doc, changes: res.changes, gone: captureGone(base, res.changes) });
        await render();
    } catch (e) {
        toast(e.message);
        closePreview();
    }
}
function closePreview({ reload = true } = {}) {
    if (!state.preview) return;
    state.preview = null;
    if (reload) loadDoc();
    else setHeader();
}
function markPreview(main) {
    const p = state.preview;
    const base = new Map();
    // What each changed Markdown block says now, rendered off the page for its text.
    const oldBlock = (id) => {
        if (!base.has(id)) {
            const b = findBlock(state.doc?.content, id);
            base.set(id, b?.type === "markdown" ? renderBlock(b) : null);
        }
        return base.get(id);
    };
    p.hits = decorateSuggestion(main, p.changes, { oldBlock, gone: p.gone });
    p.at = Math.min(p.at ?? 0, Math.max(0, p.hits.length - 1));
    setHeader();
}
function stepPreview(d) {
    const p = state.preview;
    if (!p?.hits?.length) return;
    p.at = (p.at + d + p.hits.length) % p.hits.length;
    for (const x of p.hits) x.classList.toggle("sg-cur", x === p.hits[p.at]);
    const el = p.hits[p.at];
    const r = el.getBoundingClientRect();
    const m = $("#main").getBoundingClientRect();
    if (r.top < m.top + 40 || r.bottom > m.bottom - 40) $("#main").scrollBy({ top: r.top - m.top - Math.max(60, (m.height - r.height) / 3), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setHeader();
}
addEventListener("keydown", (e) => {
    if (!state.preview || e.defaultPrevented || e.target.closest?.("input, textarea, [contenteditable]")) return;
    if (e.key === "Escape") (e.preventDefault(), closePreview());
});

// ---- Discuss / Edit: whether Copilot may change the doc while it answers (remembered per doc) ----
const MAC_KEYS = /Mac|iPhone|iPad/.test(navigator.platform);
const modeKey = () => `marginal.chat.mode.${state.documentId ?? "none"}`;
function chatDiscuss() {
    try {
        return localStorage.getItem(modeKey()) === "discuss";
    } catch {
        return false;
    }
}
function setChatDiscuss(on) {
    try {
        localStorage.setItem(modeKey(), on ? "discuss" : "edit");
    } catch {}
    renderChatMode();
}
function renderChatMode() {
    const el = $("#chat-mode");
    el.hidden = chat.mode !== "board";
    if (el.hidden) return;
    const d = chatDiscuss();
    const seg = (on, label, tip) =>
        h("button", { class: `cm-seg${d === on ? " on" : ""}`, role: "radio", "aria-checked": String(d === on), title: tip, onmousedown: (e) => e.preventDefault(), onclick: () => setChatDiscuss(on) }, label);
    put(
        el,
        seg(true, "Discuss", "Answers only: Copilot won't change the doc. A change it suggests waits under its reply for you to apply."),
        seg(false, "Edit", "Copilot may change the doc as it answers."),
        h("span", { class: "cm-hint", title: `Send one message as ${d ? "Edit" : "Discuss"} without switching` }, h("kbd", {}, MAC_KEYS ? "⌘" : "Ctrl"), "+", h("kbd", {}, "Shift"), "+", h("kbd", {}, "Enter"), ` as ${d ? "Edit" : "Discuss"}`),
    );
}

/** A change Copilot suggested in a Discuss turn: held until you apply it. */
function showSuggestion(ev) {
    // The suggestion belongs to the message that asked (its id is the proposal's).
    const turn = chat.turns?.get(ev.proposalId) ?? chat.turn;
    const count = `${ev.count} edit${ev.count === 1 ? "" : "s"}`;
    let el = chat.suggestions.get(ev.proposalId);
    if (!el) {
        el = h("div", { class: "chat-suggest", role: "group", "aria-label": "Suggested doc change" });
        chat.suggestions.set(ev.proposalId, el);
        const end = !turn && endOfTurn(ev.proposalId);
        if (end) end.after(el);
        else chatLog.insertBefore(el, chat.statusEl); // follows the reply as it streams
        if (turn) turn.suggest = el;
    }
    const threadId = ev.threadId ?? chat.threadId;
    const act = async (what) => {
        chat.suggestionActs.delete(ev.proposalId);
        for (const b of el.querySelectorAll("button")) b.disabled = true;
        if (state.preview?.proposalId === ev.proposalId) closePreview({ reload: what !== "apply" });
        // Edits landing now are listed right under the suggestion, like a reply's changes.
        const t = what === "apply" && !chat.turn?.open ? (chat.turn = { open: true, changes: new Map(), el: null, anchor: el }) : null;
        try {
            await api(`/ask/${what}`, { method: "POST", body: { threadId, proposalId: ev.proposalId } });
            put(el, h("span", { class: `cs-done ${what}` }, what === "apply" ? `✓ Applied the suggested change (${count})` : "Suggestion dismissed"));
        } catch (e) {
            put(el, h("span", { class: "cs-done err" }, e.message));
        } finally {
            if (t) setTimeout(() => (t.open = false), 2500);
        }
    };
    chat.suggestionActs.set(ev.proposalId, act);
    put(
        el,
        h("span", { class: "cs-h" }, h("span", { class: "cs-ic", "aria-hidden": "true" }, "✎"), "Suggested change ", h("span", { class: "cs-n" }, `· ${count}`)),
        h("button", { class: "cs-preview", title: "Show it in the doc, marked like tracked changes, before deciding", onclick: () => openPreview(threadId, ev.proposalId) }, "Preview"),
        h("button", { class: "cs-apply", title: "Make this change in the doc", onclick: () => act("apply") }, "Apply"),
        h("button", { class: "cs-dismiss", title: "Leave the doc as it is", onclick: () => act("discard") }, "Dismiss"),
    );
    scrollChat();
}

/**
 * What the message is about, as the doc's own addresses: paragraphs (a Markdown block and the lines the page marks on
 * it) and whole elements. The server turns them into refs ("m4.r1") the agent can rewrite without re-reading.
 */
function chatRegions() {
    const out = [];
    const add = (el) => {
        if (!el) return;
        if (el.dataset.pk) return void (el.dataset.uid && out.push({ blockId: el.dataset.uid })); // a step in Inspect
        const blockEl = el.closest(".block[data-id]");
        if (!blockEl) return;
        if (el.dataset.l && el.closest(".md")) out.push({ blockId: blockEl.dataset.id, unit: el.dataset.l });
        else out.push({ blockId: el.dataset.unit ?? blockEl.dataset.id });
    };
    const block = chat.blockId && document.querySelector(`#main .block[data-id="${CSS.escape(chat.blockId)}"]`);
    if (chat.picks?.length) chat.picks.forEach((k) => add(elOf(k)));
    else if (chat.unit && block) add(block.querySelector(`.md [data-l="${chat.unit}"]`));
    else if (chat.askRange?.startContainer?.isConnected) {
        const r = chat.askRange;
        for (const u of document.querySelectorAll("#main .md [data-l]")) if (!u.parentElement.closest("[data-l]") && r.intersectsNode(u)) add(u);
        for (const b of document.querySelectorAll("#main .block[data-id]:not(.b-markdown):not(.b-section):not(.b-callout)")) if (r.intersectsNode(b)) add(b);
    } else if (block) add(block);
    return out.slice(0, 20);
}

async function sendChat({ flip = false } = {}) {
    const message = chatText.value.trim();
    if (!message || chat.awaiting) return;
    const discuss = chat.mode === "board" && chatDiscuss() !== flip;
    const board = chat.mode === "board" && !chat.docked;
    // In a conversation that moves around the doc, each change of focus is labelled on the message that starts it.
    if (board && chat.quoteFresh && chat.ref) chatLog.insertBefore(aboutLabel(), chat.statusEl);
    const mine = h("div", { class: "chat-u src-marginal pending", "data-text": message.slice(0, 2000).trim() }, h("div", { class: `chat-msg me${discuss ? " discuss" : ""}`, title: discuss ? "Sent as Discuss: Copilot answers without changing the doc" : null }, message));
    chatLog.insertBefore(mine, chat.statusEl);
    chatText.value = "";
    autosize();
    scrollChat();
    chat.awaiting = true;
    $("#chat-send").disabled = true;
    const gen = chat.focusGen;
    // Doc edits Copilot makes while answering are listed under its reply: each message has its own turn, which
    // becomes current when Copilot starts on it (a message sent while it works waits its turn).
    const turn = chat.mode === "board" ? { open: true, changes: new Map(), el: null } : null;
    mine._turn = turn;
    if (!chat.statusEl) chat.turn = turn;
    try {
        const first = !chat.threadId;
        const cmd = chat.mode === "command";
        const docked = chat.docked;
        const res = await api(`/ask?instance=${encodeURIComponent(INSTANCE)}`, {
            method: "POST",
            body: cmd
                ? { documentId: state.documentId, tab: "command", quote: chat.quote ?? undefined, message, threadId: chat.threadId ?? undefined, focus: svc.commandFocusPayload?.(chat.focus) ?? { items: chat.focus.map((f) => f.item) }, context: chat.nextContext ?? docked?.context?.() }
                : { documentId: state.documentId, blockId: chat.blockId, quote: first || chat.quoteFresh ? chat.quote : undefined, regions: first || chat.quoteFresh ? chatRegions() : undefined, message, threadId: chat.threadId ?? undefined, context: chat.docked?.context?.() ?? inspContext(), kind: chat.docked?.kind ?? (inspecting() ? "inspect" : undefined), discuss },
        });
        chat.threadId = res.threadId;
        if (turn) (chat.turns ??= new Map()).set(res.messageId, turn);
        chat.nextContext = null;
        if (!cmd && chat.focusGen === gen) chat.quoteFresh = false; // unless the focus moved while this was sending
        if (cmd && chat.quote) {
            chat.quote = chat.quoteLabel = null; // a quote rides along with one message; focus chips stay
            renderChips();
        }
    } catch (e) {
        mine.classList.remove("pending");
        mine.after(h("div", { class: "chat-error" }, `Not sent: ${e.message}`));
        scrollChat();
    } finally {
        chat.awaiting = false;
        $("#chat-send").disabled = !chatText.value.trim();
    }
}

/** "About: Design · paragraph" above a message; clicking it scrolls back to what that message was about. */
function aboutLabel() {
    const snap = { blockId: chat.blockId, unit: chat.unit, picks: chat.picks ? [...chat.picks] : null, range: chat.askRange, row: chat.askRows?.[0] ?? null };
    return h(
        "button",
        { class: "chat-about", title: chat.quote ? `Show in the doc\n\n${chat.quote.slice(0, 300)}` : "Show in the doc", onclick: () => toc?.reveal(targetElement(snap)) },
        h("i", { class: "swatch", "aria-hidden": "true" }),
        h("span", { class: "t" }, chat.ref),
    );
}
function targetElement(t) {
    if (t.picks?.length) return elOf(t.picks[0]);
    if (t.row?.isConnected) return t.row;
    if (t.range && t.range.startContainer.isConnected) return nodeElement(t.range.startContainer);
    const block = t.blockId && document.querySelector(`#main .block[data-id="${CSS.escape(t.blockId)}"]`);
    return (t.unit && block?.querySelector(`.md [data-l="${t.unit}"]`)) || block || null;
}

// ---- Clear: tidy the chat's view (the conversation itself goes on); earlier messages can be shown again ----
const chatClear = $("#chat-clear");
function syncClear() {
    const has = [...chatLog.children].some((el) => keepOnClear(el) === false);
    chatClear.hidden = !has;
    chatClear.disabled = !!chat.statusEl; // not mid-reply
}
/** What Clear leaves: the reply in progress, and suggestions still waiting for Apply or Dismiss. */
const keepOnClear = (el) => el === chat.statusEl || el.classList.contains("chat-earlier") || el.classList.contains("chat-older") || (el.classList.contains("chat-suggest") && !!el.querySelector("button:not(:disabled)"));
function clearChatView() {
    if (chat.statusEl) return;
    const gone = [...chatLog.children].filter((el) => !keepOnClear(el));
    if (!gone.length) return;
    chat.hiddenLog ??= [];
    chat.hiddenLog.push(...gone);
    for (const el of gone) el.remove();
    let more = chatLog.querySelector(".chat-earlier");
    if (!more) {
        more = h("button", { class: "chat-earlier", title: "Put the cleared messages back", onclick: () => showEarlierChat() });
        chatLog.prepend(more);
    }
    more.textContent = `Show ${chat.hiddenLog.filter((el) => el.matches(".chat-msg")).length} earlier message${chat.hiddenLog.filter((el) => el.matches(".chat-msg")).length === 1 ? "" : "s"}`;
    syncClear();
    fitHeight();
}
function showEarlierChat() {
    const more = chatLog.querySelector(".chat-earlier");
    if (more) more.after(...(chat.hiddenLog ?? []));
    more?.remove();
    chat.hiddenLog = [];
    syncClear();
    scrollChat();
}
chatClear.onclick = clearChatView;
chatClear.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret in the input
new MutationObserver(syncClear).observe(chatLog, { childList: true });

function autosize() {
    chatText.style.height = "auto";
    chatText.style.height = `${Math.min(chatText.scrollHeight, 140)}px`;
    $("#chat-send").disabled = !chatText.value.trim() || chat.awaiting;
    fitHeight(); // a taller input raises the window's minimum height
}

$("#chat-send").onclick = sendChat;
$("#chat-close").onclick = closeChat;
chatText.addEventListener("input", autosize);
for (const ev of ["focus", "blur"]) chatText.addEventListener(ev, () => updateCenter()); // the send hint in the header
chatText.addEventListener("keydown", (e) => {
    // Shift+Enter sends; plain Enter inserts a newline; Ctrl/⌘+Shift+Enter sends one message in the other mode.
    if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        sendChat({ flip: chat.mode === "board" && (e.ctrlKey || e.metaKey) });
    }
});
// ---------------- paragraph controls in the margin ----------------
// Hovering a prose unit (paragraph, list item, heading, quote, table, code) shows Comment and Copy
// beside the text column. A text selection inside one unit retargets both to the selection.
const gutter = $("#gutter");
const gComment = $("#g-comment");
const gCopy = $("#g-copy");
const gutterState = { unit: null, selection: null }; // unit: element with data-l; selection: selected text
const gWidth = $("#g-width");
const gEdit = $("#g-edit");
/** The units the pencil would edit: the selection's prose, or the hovered unit. */
function editTargets() {
    if (state.viewVersion !== null || state.tab !== "board" || state.preview) return [];
    if (picks.size) return picks.keys().map(elOf).filter((el) => editableKind(el));
    const el = gutterState.unit ?? gutterState.placedFor;
    return editableKind(el) ? [el] : [];
}
function startEditing(els, opts) {
    if (!els.length || !prose) return;
    const sel = getSelection();
    const range = opts?.keepSelection && sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    hideGutter();
    clearPicks();
    prose.start(els, { selection: range });
}
gEdit.onclick = (e) => {
    if (withModifier(e)) return pickFromGutter(e);
    startEditing(editTargets(), { keepSelection: !!gutterState.selection });
};
gWidth.onclick = (e) => {
    e.stopPropagation();
    const t = gutterState.unit ?? gutterState.placedFor;
    if (t?.matches("table")) tables?.toggleMenu(t, gutter);
};
let lastPointer = null;

function findBlock(list, id) {
    for (const b of list ?? []) {
        if (b.id === id) return b;
        const hit = b.children && findBlock(b.children, id);
        if (hit) return hit;
    }
    return null;
}

/** The unit's source: a paragraph's exact Markdown lines, or a block's text form. */
function unitSource(el) {
    if (el.dataset.pk) {
        // Inspect panel: a step heading carries its own text; prose gives its exact Markdown lines.
        const md = el.closest(".md");
        const src = md && panelMd.get(md);
        const [from, to] = (el.dataset.l ?? "").split("-").map(Number);
        const text = el.dataset.src ?? (src && el.dataset.l ? src.replace(/\r\n/g, "\n").split("\n").slice(from, to + 1).join("\n").trim() : el.innerText.trim());
        return { blockId: el.dataset.uid, text };
    }
    const blockEl = el.closest(".block[data-id]");
    const b = blockEl && findBlock(state.doc?.content, blockEl.dataset.id);
    if (!el.dataset.l) {
        // Whole non-prose block: code as code, everything else in its readable text form.
        const code = b?.type === "code" ? b.text : b?.type === "code_peek" ? [...el.querySelectorAll(".code .t")].map((t) => t.textContent.replace(/\r/g, "")).join("\n") : null;
        return { blockId: b?.id ?? blockEl?.dataset.id, text: code ?? (b ? blockText(b) : el.innerText.trim()) };
    }
    if (!b?.markdown) return { blockId: blockEl?.dataset.id, text: el.innerText.trim() };
    const [from, to] = el.dataset.l.split("-").map(Number);
    return { blockId: b.id, unit: el.dataset.l, text: b.markdown.replace(/\r\n/g, "\n").split("\n").slice(from, to + 1).join("\n").trim() };
}

function placeGutter(el) {
    // Prose aligns to its text column; a block aligns to its visible frame (a callout is narrower than its wrapper).
    const panel = !!el.dataset.pk;
    const box = el.dataset.l || panel ? el : (el.firstElementChild ?? el);
    const r = box.getBoundingClientRect();
    const col = (panel ? el.closest(".insp-main") : el.dataset.l ? el.closest(".md") : box).getBoundingClientRect();
    const column = { right: Math.max(col.right, el.matches("table") ? r.right : -Infinity) };
    const view = (panel ? $("#peek-body") : $("#main")).getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom) return hideGutter();
    gutter.style.left = `${Math.min(column.right + (el.dataset.l ? 22 : panel ? 8 : 14), view.right - 34)}px`;
    gutter.hidden = false;
    gutterState.placedFor = el;
    updateGutterMode(); // decides which icons show, so measure after
    gutter.style.top = `${alignTo(r, gutter.offsetHeight, view, el.dataset.l ? 2 : 4)}px`;
}
/** Margin icons line up with what they act on: at its top when it's taller than they are, centred on it when not. */
function alignTo(r, height, view, inset = 0) {
    const top = height > r.height ? r.top + (r.height - height) / 2 : r.top + inset;
    return Math.max(view.top + 4, Math.min(top, view.bottom - height - 4));
}

function setGutterTitles(el) {
    if (picks.size) {
        gComment.title = `Comment on ${picks.size} selected`;
        gCopy.title = `Copy ${picks.size} selected`;
        gEdit.title = "Edit the selected text";
        return;
    }
    const prose = !!el?.dataset.l;
    const code = !!el?.matches(".b-code, .b-code_peek");
    gComment.title = prose ? "Comment on this paragraph" : "Comment on this";
    gCopy.title = prose ? "Copy Markdown" : code ? "Copy code" : "Copy as text";
    gEdit.title = "Edit this text";
}

function setUnit(el) {
    if (gutterState.unit === el) return;
    gutterState.unit?.classList.remove("unit-hover");
    gutterState.unit = el;
    hintOn = !!el && !picks.size;
    updateCenter();
    if (!el) return hideGutter();
    el.classList.add("unit-hover");
    setGutterTitles(el);
    placeGutter(el);
}

/** With a multi-selection, the icons follow the pointer to the nearest picked unit when it is between units. */
function gutterToNearestPick(y) {
    let best = null;
    let bestD = Infinity;
    for (const key of picks.keys()) {
        const el = elOf(key);
        if (!el) continue;
        const r = (el.dataset.l ? el : (el.firstElementChild ?? el)).getBoundingClientRect();
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (d < bestD) [best, bestD] = [el, d];
    }
    if (!best) return;
    setGutterTitles(best);
    placeGutter(best);
}

function hideGutter() {
    tables?.closeMenu();
    gutter.hidden = true;
    gEdit.hidden = true;
    gutterState.unit?.classList.remove("unit-hover");
    gutterState.unit = null;
    gutterState.selection = null;
    hintOn = false;
    updateCenter();
}

// Prose units (paragraph, list item, heading…) win; otherwise the nearest non-prose block is the unit.
const unitAt = (target) => {
    if (!(target instanceof Element)) return null;
    if (target.closest("#peek")) return target.closest("#peek-body [data-pk]"); // Inspect panel prose and step headings
    return !target.closest("#chat, #gutter, #bar, #toc, #jump") ? target.closest("#main .md [data-l]") ?? target.closest("#main .block[data-id]:not(.b-markdown):not(.b-section):not(.b-divider)") : null;
};
const nodeElement = (n) => (n?.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement ?? null);

function inCorridor(x, y) {
    // Keep the current unit while the pointer travels from the text to the buttons.
    const u = gutterState.unit?.getBoundingClientRect();
    const g = gutter.getBoundingClientRect();
    return !!u && !gutter.hidden && x >= u.left && x <= g.right + 4 && y >= Math.min(u.top, g.top) - 4 && y <= Math.max(u.bottom, g.bottom) + 4;
}

// The hover zone of a unit extends right through the margin to the far edge of the icons.
const GUTTER_REACH = 22 + 26 + 6; // gap + button + slack
function unitNearMargin(x, y) {
    const columns = document.querySelectorAll("#main .md, #main .md table.tw-out, #main .block[data-id]:not(.b-markdown):not(.b-section):not(.b-divider) > :first-child, #peek .insp-main");
    for (const col of columns) {
        const r = col.getBoundingClientRect();
        if (y < r.top || y > r.bottom || x <= r.right || x > r.right + GUTTER_REACH) continue;
        // Units are full-width block elements, so probing just inside the right edge finds the one on this row.
        const hit = unitAt(document.elementFromPoint(r.right - 2, y));
        if (hit) return hit;
    }
    return null;
}

document.addEventListener(
    "pointermove",
    (e) => {
        lastPointer = { x: e.clientX, y: e.clientY };
        if (gutterState.selection || e.buttons) return; // hold still while selecting or dragging
        if (prose?.active()) return; // the edit toolbar owns the margin
        if (tables?.isGrip(e.target) || tables?.menuOpen()) return; // a column border or the width menu keeps its table
        const el = unitAt(e.target) ?? (e.target.closest?.("#gutter") ? null : unitNearMargin(e.clientX, e.clientY));
        if (el) setUnit(el);
        else if (!e.target.closest?.("#gutter") && !inCorridor(e.clientX, e.clientY)) {
            setUnit(null);
            if (picks.size) gutterToNearestPick(e.clientY);
        }
    },
    { passive: true },
);
$("#main").addEventListener(
    "scroll",
    () => {
        if (gutterState.selection && gutterState.unit) return placeGutter(gutterState.unit);
        if (!lastPointer) return hideGutter();
        const el = unitAt(document.elementFromPoint(lastPointer.x, lastPointer.y)) ?? unitNearMargin(lastPointer.x, lastPointer.y);
        if (el) {
            setUnit(el);
            placeGutter(el);
        } else hideGutter();
    },
    { passive: true },
);

function currentTarget() {
    const src = unitSource(gutterState.unit);
    return gutterState.selection ? { ...src, text: gutterState.selection, unit: src.unit } : src;
}

/** A modified click on the icons picks their unit, exactly like a modified click on the unit itself. */
function pickFromGutter(e) {
    const el = gutterState.unit ?? gutterState.placedFor;
    if (!el?.isConnected) return;
    if (e.shiftKey) rangePick(el);
    else togglePick(el);
    updateGutterMode();
}

// Holding Ctrl/Cmd/Shift swaps Comment/Copy for a single select toggle: "+" adds the unit, "−" removes it.
const gPick = $("#g-pick");
let modHeld = false;
let shiftHeld = false;
function setModifiers(e) {
    const held = !!(e.ctrlKey || e.metaKey || e.shiftKey);
    if (held === modHeld && !!e.shiftKey === shiftHeld) return;
    modHeld = held;
    shiftHeld = !!e.shiftKey;
    updateGutterMode();
}
function updateGutterMode() {
    const target = gutterState.unit ?? gutterState.placedFor;
    const pickMode = modHeld && !!target?.isConnected && !gutterState.selection;
    gComment.hidden = gCopy.hidden = pickMode;
    gEdit.hidden = pickMode || !editTargets().length;
    gWidth.hidden = pickMode || !!gutterState.selection || !target?.matches?.("table");
    if (gWidth.hidden) tables?.closeMenu();
    gPick.hidden = !pickMode;
    if (!pickMode) return;
    const picked = picks.has(keyOf(target));
    const minus = picked && !shiftHeld;
    gPick.classList.toggle("minus", minus);
    gPick.title = minus ? "Remove from selection" : shiftHeld && picks.anchor() ? "Select range to here" : "Add to selection";
    gPick.setAttribute("aria-label", gPick.title);
}
addEventListener("keydown", setModifiers);
addEventListener("keyup", setModifiers);
addEventListener("blur", () => setModifiers({}));
document.addEventListener("pointermove", setModifiers, { passive: true });
gPick.onclick = (e) => pickFromGutter(e.ctrlKey || e.metaKey || e.shiftKey ? e : { shiftKey: shiftHeld });

gComment.onclick = (e) => {
    if (withModifier(e)) return pickFromGutter(e);
    if (picks.size) return multiComment();
    const t = currentTarget();
    const sel = getSelection();
    const range = gutterState.selection && sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const inPanel = !!gutterState.unit?.dataset.pk && !range;
    openChat({ blockId: t.blockId, unit: t.unit, quote: t.text, ref: refOf(t, gutterState.selection, gutterState.unit), range, picks: inPanel ? [keyOf(gutterState.unit)] : undefined });
    sel?.removeAllRanges();
    hideGutter();
};

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Clipboard API can be blocked in embedded frames; fall back to a hidden textarea.
        const ta = h("textarea", { style: "position:fixed;opacity:0;pointer-events:none" });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    }
}

gCopy.onclick = async (e) => {
    if (withModifier(e)) return pickFromGutter(e);
    const ok = await copyText(picks.size ? pickedText() : currentTarget().text);
    gCopy.classList.toggle("done", ok);
    gCopy.title = ok ? "Copied" : "Copy failed";
    setTimeout(() => {
        gCopy.classList.remove("done");
        setGutterTitles(gutterState.unit);
        if (gutterState.selection) gCopy.title = "Copy selection";
    }, 1200);
};

// ---------------- multi-select (Ctrl/Cmd+click toggles, Shift+click selects a range) ----------------
const keyOf = (el) => el.dataset.pk ?? `${el.closest(".block[data-id]").dataset.id}|${el.dataset.l ?? "*"}`;
function elOf(key) {
    if (key.startsWith("P:")) return document.querySelector(`#peek [data-pk="${CSS.escape(key)}"]`); // Inspect panel prose
    const [bid, l] = key.split("|");
    const block = document.querySelector(`#main .block[data-id="${CSS.escape(bid)}"]`);
    return l === "*" ? block : block?.querySelector(`.md [data-l="${l}"]`);
}
/** Every selectable unit in document order; a block that holds prose is selected through its paragraphs. */
function allUnits() {
    const doc = [...document.querySelectorAll("#main .md [data-l], #main .block[data-id]:not(.b-markdown):not(.b-section):not(.b-divider)")].filter((el) => !(el.matches(".block") && el.querySelector(".md [data-l]")));
    return [...doc, ...document.querySelectorAll("#peek [data-pk]")];
}
/** Square the meeting corners of touching units that share a highlight, so a run reads as one band. */
function joinRuns() {
    for (const scope of ["#main .md [data-l]", "#peek .md [data-pk]"]) joinRunsIn([...document.querySelectorAll(scope)]);
}
function joinRunsIn(units) {
    units.forEach((el) => el.classList.remove("join-top", "join-bottom"));
    const tone = (el) => (el.classList.contains("asking") ? "asking" : el.classList.contains("picked") ? "picked" : null);
    for (let i = 1; i < units.length; i++) {
        const [a, b] = [units[i - 1], units[i]];
        const t = tone(a);
        if (!t || t !== tone(b)) continue;
        if (b.getBoundingClientRect().top - a.getBoundingClientRect().bottom > 1) continue; // separated by a margin (e.g. a heading)
        a.classList.add("join-bottom");
        b.classList.add("join-top");
    }
}

// The doc's selection over paragraphs and blocks (shared mechanics in selection.js).
const picks = createSelection({
    keyOf,
    elOf,
    units: allUnits,
    actions: {
        comment: () => multiComment(),
        copy: async () => flashBar((await copyText(pickedText())) ? "Copied" : "Copy failed"),
        edit: () => startEditing(editTargets()),
    },
    enabled: (name) => name !== "edit" || editTargets().length > 0,
    onChange: () => afterPicks(),
});
function afterPicks() {
    if (!gutter.hidden) setGutterTitles(gutterState.unit);
    hintOn = !!gutterState.unit && !picks.size;
    updateCenter();
    updateGutterMode();
    joinRuns();
}
function paintPicks() {
    picks.paint();
    afterPicks();
}
const clearPicks = () => picks.clear();
const togglePick = (el) => (seedFromChat(), picks.toggle(el));
const rangePick = (el) => (seedFromChat(), picks.range(el));
/** The open chat's focus becomes the start of a new selection, so a modified click adds to it (then Comment). */
function seedFromChat() {
    if (picks.size || $("#chat").hidden || chat.mode !== "board" || chat.docked) return;
    const keys = chat.picks?.length ? chat.picks : chat.blockId && !chat.askRows?.length && !chat.askRange ? [`${chat.blockId}|${chat.unit ?? "*"}`] : [];
    const live = keys.filter((k) => elOf(k));
    if (live.length) picks.seed(live);
}
/** Picked units in document order, with what each says. Paragraphs inside a picked block are covered by it. */
function pickedParts() {
    const els = picks.keys().map(elOf).filter(Boolean);
    return els
        .filter((el) => !els.some((other) => other !== el && other.contains(el)))
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .map((el) => {
            const s = unitSource(el);
            // 1-based lines and ASCII only: labels travel through the chat, which may not render typographic dashes.
            const [from, to] = (s.unit ?? "").split("-").map((n) => Number(n) + 1);
            const lines = s.unit ? (from === to ? `line ${from}` : `lines ${from}-${to}`) : null;
            return { key: keyOf(el), id: s.blockId, label: lines ? `${s.blockId}, ${lines}` : s.blockId, text: s.text };
        });
}

// Capture phase: a modified click on a unit selects it instead of following links, opening peeks or extending text selection.
for (const host of [$("#main"), $("#peek")]) {
    host.addEventListener(
        "mousedown",
        (e) => {
            if (!prose?.active() && withModifier(e) && unitAt(e.target)) e.preventDefault();
        },
        true,
    );
    host.addEventListener(
        "click",
        (e) => {
            if (prose?.active()) return; // clicks place the caret while editing
            const el = unitAt(e.target);
            if (withModifier(e) && el) {
                e.preventDefault();
                e.stopPropagation();
                getSelection()?.removeAllRanges();
                if (e.shiftKey) rangePick(el);
                else togglePick(el);
            } else if (!el && picks.size && !e.target.closest("button, a, .cv")) clearPicks();
        },
        true,
    );
}

const pickedText = () =>
    pickedParts()
        .map((p) => p.text)
        .join("\n\n");
function multiComment() {
    const parts = pickedParts();
    if (!parts.length) return;
    const quote = parts.map((p) => `[${p.label}]\n${p.text}`).join("\n\n");
    const one = parts.length === 1 ? elOf(parts[0].key) : null;
    // One step (in the Inspect panel) or one doc block: tell Copilot which element; several: the quote labels each part.
    const ids = [...new Set(parts.map((p) => p.id))];
    openChat({ blockId: ids.length === 1 ? ids[0] : null, picks: parts.map((p) => p.key), quote, ref: one ? refOf(unitSource(one), null, one) : `${parts.length} selections` });
    clearPicks();
    hideGutter();
}



document.addEventListener("mouseup", (e) => {
    if (prose?.active() || e.target.closest("#chat, #ask-float, #peek-head, #gutter, .cv, #toc, #jump, #editbar, #editlink, #bar")) return;
    setTimeout(() => {
        const sel = getSelection();
        const text = sel?.toString().trim();
        const btn = $("#ask-float");
        btn.hidden = true;
        if (!text || !sel.rangeCount) {
            if (gutterState.selection) hideGutter();
            return;
        }
        const range = sel.getRangeAt(0);
        const startUnit = unitAt(nodeElement(range.startContainer));
        const endUnit = unitAt(nodeElement(range.endContainer));
        if (startUnit && startUnit === endUnit) {
            // A selection within one paragraph uses the margin controls.
            setUnit(startUnit);
            gutterState.selection = text;
            gComment.title = "Comment on selection";
            gCopy.title = "Copy selection";
            placeGutter(startUnit);
            return;
        }
        // Selections across diagrams or several blocks keep the floating button.
        const r = range.getBoundingClientRect();
        const blockEl = (sel.anchorNode?.parentElement ?? null)?.closest("[data-id]");
        btn.style.left = `${Math.max(8, Math.min(innerWidth - 190, r.left + r.width / 2 - 90))}px`;
        btn.style.top = `${Math.max(8, r.top - 36)}px`;
        btn.hidden = false;
        const kept = range.cloneRange();
        btn.onclick = () => {
            const start = nodeElement(kept.startContainer);
            openChat({ blockId: blockEl?.dataset.id, quote: text, ref: `${sectionOf(start) ?? "Doc"} · selection`, range: kept });
            getSelection()?.removeAllRanges();
        };
    }, 0);
});

// ---------------- Inspect: a diagram's steps in the side panel ----------------
// Sequence diagrams, flow diagrams and call-stack diffs open their steps in the side panel: every step in one scroll,
// each with its explanation, code and notes. The diagram stays in view (the doc moves over when there's room) and the
// two stay in sync: clicking a part of the diagram scrolls to its step, and scrolling the steps highlights the part.
const insp = { blockId: null, block: null, stops: [], i: 0, auto: false, autoTimer: 0, pin: null };
const ACTOR_HUES = ["--blue", "--purple", "--green", "--yellow", "--red"];
const INSPECT_KIND = { sequence: "Sequence", flow_diagram: "Flow", call_stack_diff: "Call stack" };

function stopsOf(b) {
    if (b.type === "sequence") return b.steps.map((st) => ({ id: st.id, title: st.label, from: st.from, to: st.to, style: st.style, text: st.explanation, code: st.code, sources: st.source ? [{ src: st.source }] : [], notes: st.notes ?? [] }));
    if (b.type === "flow_diagram") {
        const byKey = new Map(b.nodes.map((n) => [n.key, n]));
        return layoutFlow(b)
            .layers.flat()
            .map((k) => byKey.get(k))
            .filter((n) => n.attachments?.length || n.description || n.notes?.length)
            .map((n) => ({
                id: n.id,
                title: n.label,
                kind: n.kind,
                text: n.description,
                sources: (n.attachments ?? []).flatMap((a) => a.sources.map((src) => ({ src, label: a.label }))),
                next: b.edges.filter((e) => e.from === n.key && e.to !== n.key).map((e) => ({ label: e.label, node: byKey.get(e.to) })),
                notes: n.notes ?? [],
            }));
    }
    if (b.type === "call_stack_diff") return stackStops(b);
    return [];
}

/** Merge base and head frames into one call tree: head order, with removed frames placed under their old parent. */
function stackStops(b) {
    const k = (f) => f.key ?? `${f.source.file}:${f.source.startLine}`;
    const depths = (frames) => {
        const d = new Map();
        return frames.map((f) => {
            const x = f.parentKey ? (d.get(f.parentKey) ?? 0) + 1 : 0;
            if (f.key) d.set(f.key, x);
            return x;
        });
    };
    const baseBy = new Map(b.base.map((f) => [k(f), f]));
    const headKeys = new Set(b.head.map(k));
    const hd = depths(b.head);
    const bd = depths(b.base);
    const rows = b.head.map((f, i) => ({ f, old: baseBy.get(k(f)), depth: hd[i], status: baseBy.has(k(f)) ? "both" : "new" }));
    b.base.forEach((f, i) => {
        if (headKeys.has(k(f))) return;
        let at = rows.length;
        const pi = f.parentKey ? rows.findIndex((r) => r.f.key === f.parentKey) : -1;
        if (pi >= 0) {
            at = pi + 1;
            while (at < rows.length && rows[at].depth > rows[pi].depth) at++;
        }
        rows.splice(at, 0, { f, depth: bd[i], status: "removed" });
    });
    return rows.map(({ f, old, depth, status }) => {
        const name = f.label ?? `${f.source.file.split("/").pop()}:${f.source.startLine}`;
        const sources = [{ src: f.source, label: status === "removed" ? "Before" : status === "new" ? "Added" : "Now" }];
        if (f.callSite) sources.push({ src: f.callSite, label: "Called from" });
        for (const c of f.contextSources ?? []) sources.push({ src: c, label: "Context" });
        // A frame on both sides is one step; either side's row selects it.
        return { id: f.id, ids: [f.id, old?.id].filter(Boolean), title: name, status, depth, via: f.via, text: f.via ? `Reached **via ${f.via.kind}**: ${f.via.reason}` : undefined, sources, notes: f.notes ?? [] };
    });
}

const STACK_STATUS = { new: ["added", "new"], removed: ["deleted", "removed"], both: [null, "unchanged path"] };
const MAGNIFIER = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.4 3.4"/></svg>';

function inspectButton(b) {
    if (!stopsOf(b).length) return null;
    return h(
        "button",
        { class: "insp-btn", title: "Inspect: every step with its code, beside the diagram", "aria-label": `Inspect ${b.title}`, onclick: (e) => (e.stopPropagation(), openInspect(b.id)) },
        h("span", { class: "insp-btn-ic", html: MAGNIFIER }),
        "Inspect",
    );
}

function actorChip(b, key) {
    const hue = ACTOR_HUES[Object.keys(b.actors).indexOf(key) % ACTOR_HUES.length];
    return h("span", { class: "actor-chip", style: `--c: var(${hue})` }, b.actors[key] ?? key);
}

function arrowGlyph(style) {
    const dash = style === "return" ? ' stroke-dasharray="3 2.5"' : "";
    return h("span", { class: `step-arrow ${style}`, "aria-label": style, html: `<svg viewBox="0 0 22 10" width="22" height="10" aria-hidden="true"><path d="M1 5h18"${dash} stroke="currentColor" stroke-width="1.4"/><path d="M15.5 1.5L20 5l-4.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` });
}

function stepMeta(b, st) {
    if (b.type === "sequence") return h("div", { class: "step-meta" }, actorChip(b, st.from), arrowGlyph(st.style), st.to !== st.from ? actorChip(b, st.to) : null, st.style !== "call" ? h("span", { class: "badge" }, st.style) : null);
    if (b.type === "call_stack_diff") {
        const [cls, label] = STACK_STATUS[st.status];
        return h("div", { class: "step-meta" }, cls ? h("span", { class: `st ${cls}` }, label) : h("span", { class: "badge" }, label), st.via ? h("span", { class: "badge" }, `via ${st.via.kind}`) : null);
    }
    return st.kind && st.kind !== "process" ? h("div", { class: "step-meta" }, h("span", { class: "badge" }, st.kind)) : null;
}

/** Notes added to a step (usually on request): prose, a real example (source) or an illustrative sketch (code). */
function renderNotes(notes, prose = (text) => h("div", { class: "md step-text", html: markdown(text) })) {
    if (!notes?.length) return null;
    return h(
        "section",
        { class: "step-notes", "aria-label": "Notes and examples" },
        h("div", { class: "step-notes-h" }, "Notes & examples"),
        notes.map((n, k) =>
            h(
                "div",
                { class: "step-note" },
                n.title ? h("h3", {}, n.title) : null,
                n.text ? prose(n.text, k) : null,
                n.code ? illustrativeCode(n.code, n.title ? "Example" : undefined) : null,
                n.source ? lazyCode(n.source, { diff: hasBase(n.source), context: 4, label: n.title ? undefined : "Example" }) : null,
            ),
        ),
    );
}

/** Code for steps further down loads as it scrolls near, so a long diagram doesn't fetch every file at once. */
const lazyIO = new IntersectionObserver(
    (entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            lazyIO.unobserve(e.target);
            e.target.replaceWith(codeView(e.target._src, e.target._opts));
        }
    },
    { root: $("#peek-body"), rootMargin: "800px 0px" },
);
/** Stop watching placeholders that are about to be discarded (the panel is rebuilt or closed). */
function releaseLazy() {
    document.querySelectorAll("#peek-body .cv-lazy").forEach((el) => lazyIO.unobserve(el));
}
function lazyCode(src, opts) {
    const ph = h("div", { class: "cv-lazy", "aria-hidden": "true" });
    ph._src = src;
    ph._opts = opts;
    lazyIO.observe(ph);
    return ph;
}

// Panel prose is commentable like the doc's: every paragraph, list item and step heading is a unit with a key
// ("P:<step id>:<part>:<lines>"), its source text and a label, so the margin controls and Ctrl/Shift-click work on it.
const panelMd = new WeakMap(); // .md element -> its Markdown source
function panelProse(text, st, part, where) {
    const el = h("div", { class: "md step-text", html: markdown(text, true) });
    panelMd.set(el, text);
    for (const u of el.querySelectorAll("[data-l]")) {
        u.dataset.pk = `P:${st.id}:${part}:${u.dataset.l}`;
        u.dataset.uid = st.id;
        u.dataset.ref = `${where} · ${UNIT_KIND[u.tagName] ?? "text"}`;
    }
    return el;
}

function renderStep(b, st, i, n) {
    const where = `Step ${i + 1} · ${excerpt(st.title, 28)}`;
    const headText = `${INSPECT_KIND[b.type]} "${b.title}", step ${i + 1} of ${n}: ${b.type === "sequence" ? `${b.actors[st.from] ?? st.from} -> ${b.actors[st.to] ?? st.to}: ` : ""}${st.title}${st.sources.length ? `\nCode: ${st.sources.map((s) => srcLabel(s.src)).join(", ")}` : ""}`;
    const empty = !st.text && !st.code && !st.sources.length && !st.notes?.length;
    return h(
        "section",
        { class: "insp-step", "data-i": i, "data-step": st.id },
        h("button", { class: "insp-num", title: `Step ${i + 1}`, tabindex: -1, onclick: () => setStep(i, { scrollPanel: true }) }, i + 1),
        h(
            "div",
            { class: "insp-main" },
            h("div", { class: "insp-head", "data-pk": `P:${st.id}:head:0`, "data-uid": st.id, "data-ref": where, "data-src": headText, onclick: (e) => !withModifier(e) && !getSelection()?.toString() && setStep(i) }, h("div", { class: "insp-kicker" }, `Step ${i + 1} of ${n}`), h("h3", { class: "insp-t" }, st.title), stepMeta(b, st)),
            st.text ? panelProse(st.text, st, "text", where) : null,
            st.code ? illustrativeCode(st.code) : null,
            ...st.sources.map((s) => lazyCode(s.src, { diff: true, label: s.label, context: 10 })),
            renderNotes(st.notes, (text, k) => panelProse(text, st, `note${k}`, `${where} · note`)),
            empty ? h("p", { class: "insp-empty" }, "Nothing is attached to this step yet. Comment on it to ask for an explanation or an example.") : null,
            st.next?.length
                ? h(
                      "div",
                      { class: "step-leads" },
                      h("span", { class: "step-leads-h" }, "Leads to"),
                      st.next.map((x) => {
                          const j = insp.stops.findIndex((s) => s.id === x.node?.id);
                          return h("button", { class: "step-lead", disabled: j < 0, onclick: () => setStep(j, { scrollPanel: true }) }, x.label ? h("span", { class: "muted" }, `${x.label} → `) : null, x.node?.label ?? "");
                      }),
                  )
                : null,
        ),
    );
}

const inspecting = () => !!insp.blockId && !peekEl.hidden;
const inspBlockEl = () => insp.blockId && document.querySelector(`#main .block[data-id="${CSS.escape(insp.blockId)}"]`);

function openInspect(blockId, unitId) {
    const b = findBlock(state.doc?.content, blockId);
    if (!b) return;
    const same = inspecting() && insp.blockId === blockId;
    if (!same) {
        endInspect();
        hideGutter();
        insp.blockId = b.id;
        insp.block = b;
        insp.stops = stopsOf(b);
        renderInspect();
        showPeek();
        sizeSpacer(); // needs the panel on screen to measure
    }
    const i = unitId ? insp.stops.findIndex((s) => s.id === unitId || s.ids?.includes(unitId)) : insp.i && same ? insp.i : 0;
    setStep(Math.max(0, i), { scrollPanel: true, instant: !same });
}

function renderInspect() {
    const b = insp.block;
    const n = insp.stops.length;
    peekEl.classList.add("insp");
    const nav = h(
        "div",
        { class: "insp-nav", role: "group", "aria-label": "Steps" },
        h("button", { class: "chat-icon insp-prev", title: "Previous step (↑)", "aria-label": "Previous step", onclick: () => setStep(insp.i - 1, { scrollPanel: true }), html: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
        h("span", { class: "insp-count", "aria-live": "polite" }),
        h("button", { class: "chat-icon insp-next", title: "Next step (↓)", "aria-label": "Next step", onclick: () => setStep(insp.i + 1, { scrollPanel: true }), html: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
    );
    put($("#peek-title"), h("span", { class: "insp-kind" }, INSPECT_KIND[b.type] ?? "Diagram"), h("span", { class: "insp-title", title: b.title }, b.title));
    $("#peek-head .insp-nav")?.remove();
    $("#peek-close").before(nav);
    const body = $("#peek-body");
    releaseLazy();
    body.replaceChildren(...insp.stops.map((st, i) => renderStep(b, st, i, n)), h("div", { class: "insp-spacer", "aria-hidden": "true" }));
    stepSizes.disconnect();
    body.querySelectorAll(".insp-step").forEach((el) => stepSizes.observe(el));
    body.scrollTop = 0;
    sizeSpacer();
    paintPicks();
    markAsking();
}

// Code loads into steps after they render, so steps above the current one grow. Until the reader scrolls, keep the
// current step where we put it.
const stepSizes = new ResizeObserver(() => {
    const body = $("#peek-body");
    sizeSpacer();
    if (insp.pin === null || !inspecting()) return;
    const card = body.querySelector(".insp-step.on");
    if (!card) return;
    const drift = card.getBoundingClientRect().top - body.getBoundingClientRect().top - insp.pin;
    if (Math.abs(drift) > 1) {
        insp.auto = true;
        body.scrollTop += drift;
        clearTimeout(insp.autoTimer);
        insp.autoTimer = setTimeout(() => (insp.auto = false), 80);
    }
});
/** Room after the last step so it can scroll up to the reading line (so the last step can be the current one). */
function sizeSpacer() {
    const body = $("#peek-body");
    const sp = body.querySelector(".insp-spacer");
    const last = body.querySelectorAll(".insp-step");
    if (!sp || !last.length) return;
    sp.style.height = `${Math.max(0, body.clientHeight - last[last.length - 1].offsetHeight - 40)}px`;
}
new ResizeObserver(() => inspecting() && sizeSpacer()).observe($("#peek-body"));

/** Make step i current: highlight it here and in the diagram, and bring both into view. */
function setStep(i, { scrollPanel = false, instant = false } = {}) {
    if (!insp.stops.length) return;
    i = Math.max(0, Math.min(insp.stops.length - 1, i));
    insp.i = i;
    const body = $("#peek-body");
    body.querySelectorAll(".insp-step.on").forEach((el) => el.classList.remove("on"));
    const card = body.querySelector(`.insp-step[data-i="${i}"]`);
    card?.classList.add("on");
    $("#peek-head .insp-count").textContent = `${i + 1} / ${insp.stops.length}`;
    $("#peek-head .insp-prev").disabled = i === 0;
    $("#peek-head .insp-next").disabled = i === insp.stops.length - 1;
    const parts = decorateDiagram();
    if (scrollPanel && card) {
        // Our own scroll must not be read back as the reader's (the scroll spy ignores it until it settles).
        insp.auto = true;
        clearTimeout(insp.autoTimer);
        insp.autoTimer = setTimeout(() => (insp.auto = false), instant ? 60 : 900);
        insp.pin = 12;
        const top = card.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - insp.pin;
        body.scrollTo({ top, behavior: instant || reduceMotion() ? "auto" : "smooth" });
    }
    if (parts[0]) revealPart(parts[0], instant);
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Mark the inspected diagram and its current part (re-applied after every render of the doc). */
function decorateDiagram() {
    document.querySelectorAll("#main .inspecting").forEach((el) => el.classList.remove("inspecting"));
    document.querySelectorAll("#main .insp-on").forEach((el) => el.classList.remove("insp-on"));
    const el = inspBlockEl();
    if (!el || !inspecting()) return [];
    el.classList.add("inspecting");
    const st = insp.stops[insp.i];
    const parts = (st?.ids ?? [st?.id]).flatMap((id) => (id ? [...el.querySelectorAll(`[data-unit="${CSS.escape(id)}"]`)] : []));
    parts.forEach((p) => p.classList.add("insp-on"));
    coverInspected();
    return parts;
}

/** Keep the current part visible: scroll the diagram sideways inside its frame, and the doc only when it's off screen. */
function revealPart(part, instant) {
    const behavior = instant || reduceMotion() ? "auto" : "smooth";
    const r = part.getBoundingClientRect();
    const sc = part.closest(".diagram, .stack");
    if (sc && sc.scrollWidth > sc.clientWidth + 1) {
        const s = sc.getBoundingClientRect();
        if (r.left < s.left + 24 || r.right > s.right - 24) sc.scrollBy({ left: r.left + r.width / 2 - (s.left + s.width / 2), behavior });
    }
    const main = $("#main");
    const m = main.getBoundingClientRect();
    if (r.top < m.top + 40 || r.bottom > m.bottom - 40) main.scrollBy({ top: r.top - (m.top + m.height * 0.3), behavior });
}

// Scroll spy: the step whose top has passed the reading line is current. Only the reader's own scrolling counts:
// scrolls from code loading in (or from us) don't move the current step.
let scrollIntent = 0;
const intent = () => {
    scrollIntent = Date.now();
    insp.pin = null; // the reader is scrolling: stop holding the current step in place
};
for (const ev of ["wheel", "touchmove"]) $("#peek-body").addEventListener(ev, intent, { passive: true });
$("#peek-body").addEventListener("keydown", (e) => ["PageUp", "PageDown", "Home", "End", " "].includes(e.key) && intent());
document.addEventListener("pointerdown", (e) => e.target.closest?.(".os-track") && intent(), true);
$("#peek-body").addEventListener(
    "scroll",
    () => {
        if (gutterState.unit?.closest?.("#peek")) hideGutter();
        if (!inspecting() || insp.auto || Date.now() - scrollIntent > 1500) return;
        const body = $("#peek-body");
        const line = body.getBoundingClientRect().top + 90;
        let at = 0;
        body.querySelectorAll(".insp-step").forEach((el, i) => {
            if (el.getBoundingClientRect().top <= line) at = i;
        });
        if (at !== insp.i) setStep(at);
    },
    { passive: true },
);
$("#peek-body").addEventListener("scrollend", () => (insp.auto = false));

// ↑/↓ (or k/j) move between steps while inspecting, unless you're typing.
document.addEventListener("keydown", (e) => {
    if (!inspecting() || !shortcut("stepKeys") || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("textarea, input, select, [contenteditable], #jump, #settings")) return;
    const d = ["ArrowDown", "j"].includes(e.key) ? 1 : ["ArrowUp", "k"].includes(e.key) ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    setStep(insp.i + d, { scrollPanel: true });
});

/** Sent with doc-chat messages while inspecting: which diagram and step (with ids Copilot can edit). */
function inspContext() {
    const b = insp.block;
    const st = insp.stops[insp.i];
    if (!b || !st || !inspecting()) return undefined;
    const where = b.type === "sequence" ? `${b.actors[st.from] ?? st.from} -> ${b.actors[st.to] ?? st.to}: ` : "";
    const unit = b.type === "sequence" ? "step" : b.type === "flow_diagram" ? "flow node" : "call-stack frame";
    const refs = st.sources.map((s) => srcLabel(s.src)).join(", ");
    return `Inspecting "${b.title}" (block ${b.id}) in the side panel, at step ${insp.i + 1} of ${insp.stops.length}: ${where}${st.title} (${unit} id ${st.id})${refs ? `. Code: ${refs}` : ""}${st.notes?.length ? `. It has ${st.notes.length} note(s).` : ""}`;
}

/** The doc changed (often: Copilot answered by adding notes): rebuild the steps in place, keeping your place. */
function refreshInspect() {
    if (!insp.blockId) return;
    if (!inspecting()) return endInspect();
    const b = findBlock(state.doc?.content, insp.blockId);
    if (!b || !stopsOf(b).length) return hidePeek();
    const next = stopsOf(b);
    insp.block = b;
    if (JSON.stringify(next) === JSON.stringify(insp.stops)) {
        decorateDiagram();
        return;
    }
    const body = $("#peek-body");
    const top = body.scrollTop;
    const curId = insp.stops[insp.i]?.id;
    const before = new Map(insp.stops.map((s) => [s.id, s.notes?.length ?? 0]));
    insp.stops = next;
    renderInspect();
    body.scrollTop = top;
    const i = Math.max(0, next.findIndex((s) => s.id === curId));
    setStep(i, { instant: true });
    // New notes (usually the answer to your question) flash; on the current step they scroll into view.
    for (const [k, st] of next.entries()) {
        const had = before.get(st.id) ?? 0;
        if ((st.notes?.length ?? 0) <= had) continue;
        const fresh = [...body.querySelectorAll(`.insp-step[data-i="${k}"] .step-note`)].slice(had);
        fresh.forEach((el) => el.classList.add("fresh"));
        if (k === i && fresh[0]) {
            insp.pin = null; // the new note, not the step's top, is what to look at
            insp.auto = true;
            clearTimeout(insp.autoTimer);
            insp.autoTimer = setTimeout(() => (insp.auto = false), 900);
            fresh[0].scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
        }
    }
}

function endInspect() {
    if (!insp.blockId) return;
    releaseLazy();
    stepSizes.disconnect();
    insp.blockId = insp.block = null;
    insp.stops = [];
    insp.i = 0;
    peekEl.classList.remove("insp");
    $("#peek-head .insp-nav")?.remove();
    document.querySelectorAll("#main .inspecting").forEach((el) => {
        el.classList.remove("inspecting");
        el.style.marginRight = "";
    });
    document.querySelectorAll("#main .insp-on").forEach((el) => el.classList.remove("insp-on"));
}

// ---------------- open in the default browser ----------------
if (INSTANCE.startsWith("browser-")) document.documentElement.dataset.standalone = "";
// The canvas iframe can't reliably open system windows, so the extension process launches the browser.
$("#open-external").onclick = async () => {
    const btn = $("#open-external");
    btn.disabled = true;
    try {
        await api("/open-external", { method: "POST", body: { documentId: state.documentId ?? null, tab: state.tab } });
        toast("Opened in your browser");
    } catch (e) {
        toast(`Couldn't open the browser: ${e.message}`);
    } finally {
        setTimeout(() => (btn.disabled = false), 1200);
    }
};

// ---------------- contents + jump (Ctrl/⌘-J) ----------------
toc = createToc({
    main: $("#main"),
    getDoc: () => (state.documentId ? (state.preview?.doc ?? state.doc) : null),
    active: () => state.tab === "board" && !!state.documentId && !!state.doc,
    expand: (id) => state.collapsed.set(id, false),
    showBoard: async () => {
        state.tab = "board";
        await render();
    },
    blocked: () => !!document.querySelector(".stepper"),
});

prose = createProseEditor({
    main: $("#main"),
    sourceOf: (id) => findBlock(state.doc?.content, id)?.markdown ?? null,
    save: async (edits) => {
        await api(`/docs/${encodeURIComponent(state.documentId)}/prose`, { method: "POST", body: { edits } });
        pendingRefresh = true; // show the saved version (with its flash) as soon as editing ends
    },
    toast,
    onChange: (on) => {
        if (on) return;
        if (pendingShow) {
            const ev = pendingShow;
            pendingShow = null;
            pendingRefresh = false;
            state.documentId = ev.documentId;
            state.viewVersion = null;
            state.tab = "board";
            state.lastSeenVersion = null;
            clearPicks();
            return loadDoc();
        }
        if (pendingRefresh) {
            pendingRefresh = false;
            loadDoc(true);
        }
    },
});

tables = createTables({
    main: $("#main"),
    docId: () => state.documentId,
    onLayout: (t) => {
        if (gutterState.unit === t || gutterState.placedFor === t) placeGutter(t);
    },
});

// ---------------- services for feature modules (Command tab) ----------------
Object.assign(svc, {
    /** Unified hunks → the doc's diff listing (same look as the Diff tab). */
    renderDiff: (hunks, file) => hunks.flatMap((hk) => [h("div", { class: "code" }, h("div", { class: "gap" }, hk.header)), diffListing(hk.lines, langOf(file))]),
    codeView,
    openChat: (ctx) => openChat(ctx),
    copyText,
    toast,
    syncChatFab: () => syncChatFab(),
    /** A message the Command tab sent itself (e.g. "Initialize command center"): open the chat to show it and its reply. */
    attachCommandThread: (threadId) => {
        openChat({ mode: "command" });
        chat.threadId ??= threadId;
    },
    /** Command tab → chat: send a message for the user (a button that asks the orchestrator for something), with
     *  context for the orchestrator that the chat doesn't show. The chat opens, so any follow-up questions land there. */
    sendCommandChat: (message, { context } = {}) => {
        openChat({ mode: "command" });
        if (chat.blocked || chat.awaiting) return false;
        chatText.value = message;
        autosize();
        chat.nextContext = context ?? null;
        sendChat();
        return true;
    },
    /** Command tab → chat: add focus items and/or a quote, opening the persistent Command chat. */
    addToCommandChat: (focus, extra = {}) => openChat({ mode: "command", focus, ...extra }),
    commandChatOpen: () => !$("#chat").hidden && chat.mode === "command",
    commandFocus: () => (chat.mode === "command" ? chat.focus : []),
    /** Leaving the Command tab hides its chat (kept for the next visit). */
    dockChat: (slot, ctx) => dockChat(slot, ctx),
    undockChat: () => undockChat(),
    isChatDocked: () => !!chat.docked,
    refreshChatRef: () => renderRef(),
    /** Leaving the Command tab: a docked chat goes back to floating; an open one stays open for the next tab. */
    hideCommandChat: () => undockChat(),
    refreshCommandChatBlocked: () => {
        if (chat.mode !== "command") return;
        chat.blocked = svc.commandChatBlocked?.() ?? null;
        syncBlocked();
    },
});

// ---------------- boot ----------------
(async () => {
    await loadSettings(); // before the first render, so the theme doesn't flash
    const ui = await api(`/ui?instance=${encodeURIComponent(INSTANCE)}`).catch(() => null);
    chat.box = ui?.box ?? null;
    chat.reopen = !!ui?.open;
    try {
        state.catalog = await api("/catalog");
    } catch (e) {
        $("#main").replaceChildren(h("div", { class: "doc error" }, `Can't reach the Marginal extension: ${e.message}`));
        return;
    }
    connect();
})();
