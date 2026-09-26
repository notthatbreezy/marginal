// Whiteboard canvas renderer. Vanilla JS, no dependencies.
import { TOKEN, INSTANCE, $, h, s, esc, put, api, toast, slugify, inline, markdown, highlight, langOf, svc, bus } from "./core.js";
import { createStepper } from "./stepper.js";
import { activeSelection, createSelection, flashBar, withModifier, multibar } from "./selection.js";

const INITIAL_TAB = new URLSearchParams(location.search).get("tab");

// ---------------- state ----------------
const state = {
    documentId: null,
    doc: null,
    repository: null,
    tab: "board",
    viewVersion: null, // historical snapshot being viewed
    collapsed: new Map(), // blockId -> bool (user overrides)
    lastSeenVersion: null,
    catalog: [],
};
const sourceCache = new Map();


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

// ---------------- peek drawer ----------------
function openPeek(title, sections) {
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
    $("#peek").hidden = false;
}

// ---------------- code view (shared by peeks and tours) ----------------
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
                            openChat({ quote: `${where}\n${d.text}` });
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
        h("div", { class: "cv-body" }, h("div", { class: "cv-code", style: "padding-left:16px", html: highlight(detab(code.text), code.language) })),
    );
}
$("#peek-close").onclick = () => ($("#peek").hidden = true);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (activeLineSel) activeLineSel.clear();
        else if (picks.size) clearPicks();
        else if (!$("#chat").hidden) closeChat();
        else if (tour.root) closeTour();
        else $("#peek").hidden = true;
    }
});
const hasBase = (src) => !!((src.pins ?? state.doc?.target)?.base && (src.pins ?? state.doc?.target)?.base !== (src.pins ?? state.doc?.target)?.head);

document.addEventListener("click", (e) => {
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
        if (linked)
            g.addEventListener("click", () => {
                const title = `${idx + 1}. ${b.actors[st.from]} → ${b.actors[st.to]}: ${st.label}`;
                const sections = [];
                if (st.explanation) sections.push({ text: st.explanation });
                if (st.source) sections.push({ source: st.source, diff: hasBase(st.source) });
                else if (st.code) sections.push({ code: st.code, heading: st.code.language });
                openPeek(title, sections);
            });
        g.append(s("title", {}, linked ? "Click to see details" : st.label));
        svg.append(g);
        y += rh + stepGap;
    });
    return frame("sequence", b.title, h("div", { class: "diagram" }, svg), { right: tourButton(b) });
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
        if (linked)
            g.addEventListener("click", () => {
                const sections = [];
                if (n.description) sections.push({ text: n.description });
                for (const att of n.attachments ?? []) for (const src of att.sources) sections.push({ source: src, heading: `${att.label} · ${srcLabel(src)}` });
                openPeek(n.label, sections);
            });
        if (linked) g.style.cursor = "pointer";
        svg.append(g);
    }
    return frame("flow", b.title, h("div", { class: "diagram" }, b.description ? h("p", { class: "desc" }, b.description) : null, svg), { right: b.tourStage ? null : tourButton(b) });
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
                    onclick: () => {
                        const sections = [];
                        if (f.via) sections.push({ text: `**via ${f.via.kind}** — ${f.via.reason}` });
                        sections.push({ source: f.source, diff: hasBase(f.source), heading: `${side} · ${srcLabel(f.source)}` });
                        if (f.callSite) sections.push({ source: f.callSite, heading: `called from · ${srcLabel(f.callSite)}` });
                        openPeek(name, sections);
                    },
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
    return frame("call stack", b.title, h("div", { class: "stack" }, col("base", b.base), col("head", b.head)), { right: tourButton(b) });
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
    $("#title").textContent = doc ? doc.title : "Whiteboard";
    const sub = [];
    if (doc?.kind === "scratchpad") sub.push("Scratchpad — newest first");
    if (doc?.target) {
        const t = doc.target;
        sub.push(`${state.repository ?? t.repositoryId} · ${t.baseRef ?? t.base.slice(0, 8)} … ${t.headRef ?? t.head.slice(0, 8)} (${t.head.slice(0, 8)})`);
    }
    if (doc?.pullRequest) sub.push(`PR ${doc.pullRequest.url.split("/").slice(-1)[0]}`);
    if (doc) sub.push(`v${doc.version}`);
    $("#subtitle").textContent = sub.join("  ·  ");
    $("#tabs").hidden = !doc;
    for (const btn of document.querySelectorAll("#tabs button")) {
        const tab = btn.dataset.tab;
        btn.hidden = !doc || (!doc.target && (tab === "diff" || tab === "commits" || tab === "command"));
        btn.classList.toggle("on", tab === state.tab);
    }
    const banner = $("#banner");
    if (state.viewVersion !== null) {
        banner.hidden = false;
        banner.replaceChildren(`Viewing version ${state.viewVersion} (read-only). `, h("a", { href: "#", onclick: (e) => (e.preventDefault(), (state.viewVersion = null), loadDoc()) }, "Back to latest"));
    } else banner.hidden = true;
    syncChatFab();
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
// Any selection (whiteboard units or Command map tiles) owns the bar while it has picks.
multibar.onSync.push(() => updateCenter());
function updateCenter() {
    const multi = (activeSelection()?.size ?? 0) > 0;
    $("#multibar").hidden = !multi;
    $("#hint").hidden = multi || !hintOn;
    $("#activity").hidden = multi || hintOn || !activityOn;
}

function renderHome() {
    state.doc = null;
    setHeader();
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
            h("h2", {}, "Whiteboards"),
            others.length ? others.map(card) : h("div", { class: "empty" }, "No whiteboards yet. Ask Copilot to ", h("code", {}, "explain my branch on the whiteboard"), "."),
        ),
    );
}

function renderBoard() {
    const doc = state.doc;
    const main = $("#main");
    const container = h("div", { class: "doc" });
    if (!doc.content.length)
        container.append(
            h(
                "div",
                { class: "empty" },
                doc.kind === "scratchpad" ? "The scratchpad is empty. Ask Copilot to sketch something here — a flow, a call path, a data shape." : "This whiteboard is empty. Copilot's drawing will appear here live.",
            ),
        );
    const prevScroll = main.scrollTop;
    animate = animate ?? null;
    for (const b of doc.content) container.append(renderBlock(b));
    main.replaceChildren(container);
    main.scrollTop = prevScroll;
    if (animate?.scrollTo) {
        const el = animate.scrollTo;
        const r = el.getBoundingClientRect();
        const mr = main.getBoundingClientRect();
        if (r.bottom < mr.top + 40 || r.top > mr.bottom - 40) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    animate = null;
    markAsking(); // keep the discussed paragraph marked across live re-renders
    paintPicks();
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
    } catch (e) {
        state.doc = null;
        $("#main").replaceChildren(h("div", { class: "doc error" }, e.message));
    }
}

function showDoc(documentId) {
    clearPicks();
    state.documentId = documentId;
    state.viewVersion = null;
    state.tab = "board";
    state.lastSeenVersion = null;
    state.collapsed.clear();
    $("#peek").hidden = true;
    api(`/instance/${encodeURIComponent(INSTANCE)}/show`, { method: "POST", body: { documentId } }).catch(() => {});
    loadDoc();
}

$("#home").onclick = async () => {
    state.catalog = await api("/catalog");
    showDoc(null);
};
for (const btn of document.querySelectorAll("#tabs button"))
    btn.onclick = () => {
        state.tab = btn.dataset.tab;
        if (state.tab !== "board") state.viewVersion = state.viewVersion;
        render();
    };

// ---------------- live updates ----------------
let refreshTimer = null;
function scheduleRefresh() {
    // Coalesce bursts of edits; each version still animates its own lastEdit when it is the newest.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        if (state.viewVersion === null) loadDoc(true);
    }, 60);
}

function connect() {
    const es = new EventSource(`/api/events?instance=${encodeURIComponent(INSTANCE)}&t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = async (msg) => {
        const ev = JSON.parse(msg.data);
        if (ev.type === "show") {
            if (ev.documentId !== state.documentId || !state.booted) {
                const first = !state.booted;
                state.booted = true;
                clearPicks();
                state.catalog = await api("/catalog").catch(() => state.catalog);
                state.documentId = ev.documentId;
                state.viewVersion = null;
                // ?tab= deep-links the first render (e.g. headless screenshots of the Command tab).
                state.tab = first && ["command", "diff", "commits", "history"].includes(INITIAL_TAB) ? INITIAL_TAB : "board";
                state.lastSeenVersion = null;
                loadDoc();
            }
        } else if (ev.type === "version" && ev.documentId === state.documentId) {
            if (state.tab === "board") scheduleRefresh();
            else if (state.viewVersion === null) {
                const data = await api(`/docs/${encodeURIComponent(state.documentId)}`);
                state.doc = data.doc;
                state.lastSeenVersion = data.doc.version;
                setHeader();
                if (state.tab === "history") renderHistory();
            }
        } else if (ev.type === "chat") onChatEvent(ev);
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

// ---------------- side-chat with Copilot ----------------
// The reply comes from the main session; this popup shows only the turns it started.
// Two modes share the popup: "board" (side-chat about the whiteboard, ends on close) and "command" (the Command tab's
// persistent chat with the orchestrator: survives close/reopen, carries focus chips, shows the activity lane).
const chat = { threadId: null, blockId: null, unit: null, quote: null, quoteLabel: null, awaiting: false, bubbles: new Map(), statusEl: null, mode: "board", focus: [], blocked: null };
const chatBoxes = {}; // mode → saved position/size, so each tab remembers where its chat sat
const chatLog = $("#chat-log");
const chatText = $("#chat-text");

/** Mark what the open chat is about: one paragraph (unit = its data-l range), a whole block, or several picks. */
function markAsking() {
    document.querySelectorAll(".asking").forEach((el) => el.classList.remove("asking"));
    markAskingInner();
    joinRuns();
}
function markAskingInner() {
    if ($("#chat").hidden) return;
    if (chat.picks?.length) {
        for (const key of chat.picks) elOf(key)?.classList.add("asking");
        return;
    }
    if (!chat.blockId) return;
    const block = document.querySelector(`.block[data-id="${CSS.escape(chat.blockId)}"]`);
    const target = chat.unit ? block?.querySelector(`.md [data-l="${chat.unit}"]`) : block;
    target?.classList.add("asking");
}

function endThread() {
    if (chat.threadId) api("/ask/end", { method: "POST", body: { threadId: chat.threadId } }).catch(() => {});
    Object.assign(chat, { threadId: null, awaiting: false, statusEl: null });
    chat.bubbles.clear();
    chatLog.replaceChildren();
    fitHeight();
}

function switchChatMode(mode) {
    if (chat.mode === mode) return;
    chatBoxes[chat.mode] = { right: chatBox.style.right, bottom: chatBox.style.bottom, width: chatBox.style.width, userHeight: chatBox.dataset.userHeight };
    endThread();
    chat.blockId = chat.unit = chat.picks = chat.quote = chat.quoteLabel = null;
    chat.focus = [];
    chat.blocked = null;
    syncBlocked();
    chat.mode = mode;
    const b = chatBoxes[mode];
    chatBox.style.right = b?.right ?? "";
    chatBox.style.bottom = b?.bottom ?? "";
    chatBox.style.width = b?.width ?? "";
    if (b?.userHeight) chatBox.dataset.userHeight = b.userHeight;
    else delete chatBox.dataset.userHeight;
    chatBox.classList.toggle("cmd-chat", mode === "command");
    chatText.placeholder = mode === "command" ? "Ask the orchestrator…" : "Ask about this…";
    $("#chat").setAttribute("aria-label", mode === "command" ? "Chat with the orchestrator" : "Chat with Copilot");
    $("#chat-feed").hidden = mode !== "command";
    renderChips();
}

/** Focus chips (Command chat): items are {key, kind, label, cls?, item} where item is the spec §7.10 payload entry. */
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
    const mode = ctx.mode ?? (state.tab === "command" ? "command" : "board");
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
        $("#chat").hidden = false;
        $("#chat-fab").hidden = true;
        svc.onCommandChatOpen?.();
        fitHeight();
        if (!chat.blocked) chatText.focus();
        svc.onFocusChange?.(chat.focus);
        return;
    }
    const sameTarget = !$("#chat").hidden && ctx.blockId === chat.blockId && ctx.quote === chat.quote;
    if (!sameTarget) {
        endThread();
        chat.blockId = ctx.blockId ?? null;
        chat.unit = ctx.unit ?? null;
        chat.picks = ctx.picks ?? null;
        chat.quote = ctx.quote ?? null;
    }
    $("#chat").hidden = false;
    $("#chat-fab").hidden = true;
    markAsking();
    fitHeight();
    chatText.focus();
}

/** Command chat is only live in the orchestrator's session (the lease owner); elsewhere say where to go. */
function syncBlocked() {
    const note = $("#chat-blocked") ?? h("div", { id: "chat-blocked", class: "chat-blocked", role: "note" });
    if (!note.isConnected) chatLog.before(note);
    note.textContent = chat.blocked ?? "";
    note.hidden = !chat.blocked;
    chatText.disabled = !!chat.blocked;
    $("#chat-send").disabled = !!chat.blocked || !chatText.value.trim() || chat.awaiting;
}

function closeChat() {
    $("#chat").hidden = true;
    if (chat.mode === "command") {
        // Persistent: the thread, log and focus stay for the next open.
        syncChatFab();
        return;
    }
    endThread();
    chat.blockId = chat.unit = chat.picks = chat.quote = null;
    markAsking();
    syncChatFab();
}

/** The chat button is the way in when nothing is selected: shown on a whiteboard whenever the chat is closed. */
function syncChatFab() {
    const tabOk = state.tab === "board" || (state.tab === "command" && !!state.doc?.target);
    $("#chat-fab").hidden = !$("#chat").hidden || !state.documentId || !tabOk || !!tour.root;
    $("#chat-fab").title = state.tab === "command" ? "Chat with the orchestrator" : "Chat about this whiteboard";
}
$("#chat-fab").onclick = () => openChat({});

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

// Move and resize. The window stays anchored by right/bottom so new messages grow it upward.
const chatBox = $("#chat");
const MIN_W = 280;
/** Never shorter than the drag bar + input box (which grows with its text), plus a sliver of messages once there are any. */
const chatEmpty = () => !chatLog.childElementCount;
const extraH = () => ["#chat-feed", "#chat-chips", "#chat-blocked"].reduce((n, s) => n + ($(s)?.hidden === false ? $(s).offsetHeight + 4 : 0), 0);
const minChatHeight = () => Math.max(chatEmpty() ? 0 : 150, ($("#chat-bar").offsetHeight || 22) + ($(".chat-input").offsetHeight || 40) + 16 + extraH() + (chatEmpty() ? 0 : 48));
function anchor() {
    const r = chatBox.getBoundingClientRect();
    return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, width: r.width, height: r.height };
}
const MAX_H = 480;
const TOP_GAP = 8; // keep the drag bar this far inside the top of the viewport
function applyBox({ right, bottom, width, height }) {
    width = Math.max(MIN_W, Math.min(width, innerWidth - 16));
    right = Math.max(0, Math.min(right, innerWidth - width));
    chatBox.style.width = `${width}px`;
    chatBox.style.right = `${right}px`;
    if (height !== undefined) chatBox.dataset.userHeight = Math.max(minChatHeight(), height);
    // Dragging up is allowed until only the minimum height fits; fitHeight then shrinks the window rather than letting its top escape.
    chatBox.style.bottom = `${Math.max(0, Math.min(bottom, innerHeight - TOP_GAP - minChatHeight()))}px`;
    fitHeight();
}
/** Grow upward only as far as the viewport allows: the top edge (and its drag bar) must stay reachable. */
function fitHeight() {
    const bottom = parseFloat(chatBox.style.bottom || getComputedStyle(chatBox).bottom) || 0;
    const minH = minChatHeight();
    const room = Math.max(minH, innerHeight - bottom - TOP_GAP);
    const userH = Number(chatBox.dataset.userHeight);
    chatBox.style.minHeight = `${minH}px`;
    // An empty chat is just the input: compact until the first message, then the user's chosen height returns.
    if (userH && !chatEmpty()) {
        chatBox.style.height = `${Math.max(minH, Math.min(userH, room))}px`;
        chatBox.style.maxHeight = "none";
    } else {
        chatBox.style.height = "";
        chatBox.style.maxHeight = `${Math.min(userH || MAX_H, room)}px`;
    }
}
function track(handle, onMove) {
    handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("#chat-close")) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const start = { x: e.clientX, y: e.clientY, ...anchor() };
        chatBox.classList.add("dragging");
        const move = (ev) => onMove(start, ev.clientX - start.x, ev.clientY - start.y);
        const up = () => {
            chatBox.classList.remove("dragging");
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    });
}
track($("#chat-bar"), (s, dx, dy) => applyBox({ right: s.right - dx, bottom: s.bottom - dy, width: s.width }));
track($("#chat-resize"), (s, dx, dy) => {
    // Clamp the size first, then derive position, so hitting a minimum stops the edge instead of moving the window.
    const w = Math.max(MIN_W, s.width + dx);
    const hgt = Math.max(minChatHeight(), s.height + dy);
    applyBox({ right: s.right - (w - s.width), bottom: s.bottom - (hgt - s.height), width: w, height: hgt });
});
addEventListener("resize", () => {
    if (!chatBox.hidden && chatBox.style.right) applyBox(anchor());
    else fitHeight();
});

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
    if (!chat.threadId && chat.awaiting) chat.threadId = ev.threadId; // events can beat the HTTP response
    if (ev.threadId !== chat.threadId) return;
    if (ev.kind === "status") setStatus(ev.text);
    else if (ev.kind === "delta") {
        const el = bubble(ev.messageId);
        el.dataset.raw += ev.text;
        el.innerHTML = markdown(el.dataset.raw);
        scrollChat();
    } else if (ev.kind === "message") {
        const el = bubble(ev.messageId);
        el.dataset.raw = ev.text;
        el.innerHTML = markdown(ev.text);
        scrollChat();
    } else if (ev.kind === "retract") {
        chat.bubbles.get(ev.messageId)?.remove();
        chat.bubbles.delete(ev.messageId);
    } else if (ev.kind === "done") setStatus(null);
}

async function sendChat() {
    const message = chatText.value.trim();
    if (!message || chat.awaiting) return;
    chatLog.insertBefore(h("div", { class: "chat-msg me" }, message), chat.statusEl);
    chatText.value = "";
    autosize();
    scrollChat();
    chat.awaiting = true;
    $("#chat-send").disabled = true;
    try {
        const first = !chat.threadId;
        const cmd = chat.mode === "command";
        const res = await api(`/ask?instance=${encodeURIComponent(INSTANCE)}`, {
            method: "POST",
            body: cmd
                ? { documentId: state.documentId, tab: "command", quote: chat.quote ?? undefined, message, threadId: chat.threadId ?? undefined, focus: svc.commandFocusPayload?.(chat.focus) ?? { items: chat.focus.map((f) => f.item) } }
                : { documentId: state.documentId, blockId: chat.blockId, quote: first ? chat.quote : undefined, message, threadId: chat.threadId ?? undefined },
        });
        chat.threadId = res.threadId;
        if (cmd && chat.quote) {
            chat.quote = chat.quoteLabel = null; // a quote rides along with one message; focus chips stay
            renderChips();
        }
    } catch (e) {
        setStatus(null);
        chatLog.append(h("div", { class: "chat-error" }, `Not sent: ${e.message}`));
        scrollChat();
    } finally {
        chat.awaiting = false;
        $("#chat-send").disabled = !chatText.value.trim();
    }
}

function autosize() {
    chatText.style.height = "auto";
    chatText.style.height = `${Math.min(chatText.scrollHeight, 140)}px`;
    $("#chat-send").disabled = !chatText.value.trim() || chat.awaiting;
    fitHeight(); // a taller input raises the window's minimum height
}

$("#chat-send").onclick = sendChat;
$("#chat-close").onclick = closeChat;
chatText.addEventListener("input", autosize);
chatText.addEventListener("keydown", (e) => {
    // Shift+Enter sends; plain Enter inserts a newline.
    if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        sendChat();
    }
});
// ---------------- paragraph controls in the margin ----------------
// Hovering a prose unit (paragraph, list item, heading, quote, table, code) shows Comment and Copy
// beside the text column. A text selection inside one unit retargets both to the selection.
const gutter = $("#gutter");
const gComment = $("#g-comment");
const gCopy = $("#g-copy");
const gutterState = { unit: null, selection: null }; // unit: element with data-l; selection: selected text
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
    const box = el.dataset.l ? el : (el.firstElementChild ?? el);
    const column = (el.dataset.l ? el.closest(".md") : box).getBoundingClientRect();
    const r = box.getBoundingClientRect();
    const view = $("#main").getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom) return hideGutter();
    // Align with the unit's first line (or a frame's header), in a column just outside it.
    const top = Math.max(view.top + 4, Math.min(r.top + (el.dataset.l ? 2 : 4), view.bottom - 60));
    gutter.style.left = `${Math.min(column.right + (el.dataset.l ? 22 : 14), view.right - 34)}px`;
    gutter.style.top = `${top}px`;
    gutter.hidden = false;
    gutterState.placedFor = el;
    updateGutterMode();
}

function setGutterTitles(el) {
    if (picks.size) {
        gComment.title = `Comment on ${picks.size} selected`;
        gCopy.title = `Copy ${picks.size} selected`;
        return;
    }
    const prose = !!el?.dataset.l;
    const code = !!el?.matches(".b-code, .b-code_peek");
    gComment.title = prose ? "Comment on this paragraph" : "Comment on this";
    gCopy.title = prose ? "Copy Markdown" : code ? "Copy code" : "Copy as text";
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
    gutter.hidden = true;
    gutterState.unit?.classList.remove("unit-hover");
    gutterState.unit = null;
    gutterState.selection = null;
    hintOn = false;
    updateCenter();
}

// Prose units (paragraph, list item, heading…) win; otherwise the nearest non-prose block is the unit.
const unitAt = (target) =>
    target instanceof Element && !target.closest("#chat, #peek, #gutter, #bar") ? target.closest("#main .md [data-l]") ?? target.closest("#main .block[data-id]:not(.b-markdown):not(.b-section):not(.b-divider)") : null;
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
    const columns = document.querySelectorAll("#main .md, #main .block[data-id]:not(.b-markdown):not(.b-section):not(.b-divider) > :first-child");
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
    openChat({ blockId: t.blockId, unit: t.unit, quote: t.text });
    getSelection()?.removeAllRanges();
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
const keyOf = (el) => `${el.closest(".block[data-id]").dataset.id}|${el.dataset.l ?? "*"}`;
function elOf(key) {
    const [bid, l] = key.split("|");
    const block = document.querySelector(`#main .block[data-id="${CSS.escape(bid)}"]`);
    return l === "*" ? block : block?.querySelector(`.md [data-l="${l}"]`);
}
/** Every selectable unit in document order; a block that holds prose is selected through its paragraphs. */
function allUnits() {
    return [...document.querySelectorAll("#main .md [data-l], #main .block[data-id]:not(.b-markdown):not(.b-section):not(.b-divider)")].filter((el) => !(el.matches(".block") && el.querySelector(".md [data-l]")));
}
/** Square the meeting corners of touching units that share a highlight, so a run reads as one band. */
function joinRuns() {
    const units = [...document.querySelectorAll("#main .md [data-l]")];
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

// The whiteboard's selection over paragraphs and blocks (shared mechanics in selection.js).
const picks = createSelection({
    keyOf,
    elOf,
    units: allUnits,
    actions: {
        comment: () => multiComment(),
        copy: async () => flashBar((await copyText(pickedText())) ? "Copied" : "Copy failed"),
    },
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
const togglePick = (el) => picks.toggle(el);
const rangePick = (el) => picks.range(el);
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
            return { key: keyOf(el), label: lines ? `${s.blockId}, ${lines}` : s.blockId, text: s.text };
        });
}

// Capture phase: a modified click on a unit selects it instead of following links, opening peeks or extending text selection.
$("#main").addEventListener(
    "mousedown",
    (e) => {
        if (withModifier(e) && unitAt(e.target)) e.preventDefault();
    },
    true,
);
$("#main").addEventListener(
    "click",
    (e) => {
        const el = unitAt(e.target);
        if (withModifier(e) && el) {
            e.preventDefault();
            e.stopPropagation();
            getSelection()?.removeAllRanges();
            if (e.shiftKey) rangePick(el);
            else togglePick(el);
        } else if (!el && picks.size && !e.target.closest("button, a")) clearPicks();
    },
    true,
);

const pickedText = () =>
    pickedParts()
        .map((p) => p.text)
        .join("\n\n");
function multiComment() {
    const parts = pickedParts();
    if (!parts.length) return;
    const quote = parts.map((p) => `[${p.label}]\n${p.text}`).join("\n\n");
    openChat({ blockId: parts.length === 1 ? parts[0].key.split("|")[0] : null, picks: parts.map((p) => p.key), quote });
    clearPicks();
    hideGutter();
}



document.addEventListener("mouseup", (e) => {
    if (e.target.closest("#chat, #ask-float, #peek-head, #gutter, .cv")) return;
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
        btn.onclick = () => openChat({ blockId: blockEl?.dataset.id, quote: text });
    }, 0);
});

// ---------------- code tour ----------------
// A diagram becomes a guided walk: the diagram, re-shaped vertically, on the left; one stop at a time on the
// right with its explanation and code. Sequence steps become a numbered rail (a wide ladder does not fit a
// column); flow diagrams re-lay top-to-bottom with the current node emphasized.
const tour = { root: null, block: null, stops: [], stepper: null };
const ACTOR_HUES = ["--blue", "--purple", "--green", "--yellow", "--red"];

function tourStops(b) {
    if (b.type === "sequence") return b.steps.map((st) => ({ id: st.id, title: st.label, from: st.from, to: st.to, style: st.style, text: st.explanation, code: st.code, sources: st.source ? [{ src: st.source }] : [] }));
    if (b.type === "flow_diagram") {
        const byKey = new Map(b.nodes.map((n) => [n.key, n]));
        return layoutFlow(b)
            .layers.flat()
            .map((k) => byKey.get(k))
            .filter((n) => n.attachments?.length || n.description)
            .map((n) => ({
                id: n.id,
                title: n.label,
                kind: n.kind,
                text: n.description,
                sources: n.attachments.flatMap((a) => a.sources.map((src) => ({ src, label: a.label }))),
                next: b.edges.filter((e) => e.from === n.key && e.to !== n.key).map((e) => ({ label: e.label, node: byKey.get(e.to) })),
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
    return rows.map(({ f, depth, status }) => {
            const name = f.label ?? `${f.source.file.split("/").pop()}:${f.source.startLine}`;
            const sources = [{ src: f.source, label: status === "removed" ? "Before" : status === "new" ? "Added" : "Now" }];
            if (f.callSite) sources.push({ src: f.callSite, label: "Called from" });
            for (const c of f.contextSources ?? []) sources.push({ src: c, label: "Context" });
            return { id: f.id, title: name, status, depth, via: f.via, text: f.via ? `Reached **via ${f.via.kind}**: ${f.via.reason}` : undefined, sources };
    });
}

const STACK_STATUS = { new: ["added", "new"], removed: ["deleted", "removed"], both: [null, "unchanged path"] };

function tourButton(b) {
    if (tourStops(b).length < 2) return null;
    const focus = b.type === "call_stack_diff";
    return h(
            "button",
            { class: "tour-btn", title: focus ? "Walk this call path frame by frame with its code" : "Step through this diagram with its code", onclick: (e) => (e.stopPropagation(), openTour(b.id)) },
            h("span", { html: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>' }),
            focus ? "Focus" : "Tour",
    );
}

function actorChip(b, key) {
    const hue = ACTOR_HUES[Object.keys(b.actors).indexOf(key) % ACTOR_HUES.length];
    return h("span", { class: "actor-chip", style: `--c: var(${hue})` }, b.actors[key] ?? key);
}

function arrowGlyph(style) {
    const dash = style === "return" ? ' stroke-dasharray="3 2.5"' : "";
    return h("span", { class: `tour-arrow ${style}`, "aria-label": style, html: `<svg viewBox="0 0 22 10" width="22" height="10" aria-hidden="true"><path d="M1 5h18"${dash} stroke="currentColor" stroke-width="1.4"/><path d="M15.5 1.5L20 5l-4.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` });
}

function tourStage(b) {
    if (b.type === "call_stack_diff") {
        const count = (s) => tour.stops.filter((x) => x.status === s).length;
        return h(
            "div",
            {},
            h("div", { class: "stack-legend" }, h("span", { class: "st added" }, `${count("new")} new`), h("span", { class: "st deleted" }, `${count("removed")} removed`), h("span", { class: "muted" }, `${count("both")} unchanged`)),
            h(
                "ol",
                { class: "stack-tree" },
                tour.stops.map((st, i) =>
                    h(
                        "li",
                        { "data-i": i, class: `s-${st.status}`, style: `--d:${st.depth}` },
                        st.depth ? h("span", { class: "tree" }, "└") : null,
                        h("span", { class: "fn" }, st.title),
                        st.via ? h("span", { class: "via", title: st.via.reason }, st.via.kind) : null,
                        h("span", { class: "loc" }, `${st.sources[0].src.file.split("/").pop()}:${st.sources[0].src.startLine}`),
                    ),
                ),
            ),
        );
    }
    if (b.type === "sequence") {
        return h(
            "ol",
            { class: "rail" },
            tour.stops.map((st, i) => h("li", { "data-i": i }, h("span", { class: "dot" }, i + 1), h("div", { class: "rail-body" }, h("div", { class: "who" }, actorChip(b, st.from), arrowGlyph(st.style), st.to !== st.from ? actorChip(b, st.to) : null), h("div", { class: "lbl" }, st.title)))),
        );
    }
    const svg = renderFlow({ ...b, direction: "down", tourStage: true }).querySelector("svg");
    return h("div", { class: "tour-flow" }, svg);
}

function tourMeta(b, st) {
    if (b.type === "sequence") return h("div", { class: "tour-meta" }, actorChip(b, st.from), arrowGlyph(st.style), st.to !== st.from ? actorChip(b, st.to) : null, st.style !== "call" ? h("span", { class: "badge" }, st.style) : null);
    if (b.type === "call_stack_diff") {
        const [cls, label] = STACK_STATUS[st.status];
        return h("div", { class: "tour-meta" }, cls ? h("span", { class: `st ${cls}` }, label) : h("span", { class: "badge" }, label), st.via ? h("span", { class: "badge" }, `via ${st.via.kind}`) : null);
    }
    return st.kind && st.kind !== "process" ? h("div", { class: "tour-meta" }, h("span", { class: "badge" }, st.kind)) : null;
}

/** Stop body shared by tours (and reused by walkthroughs): title, meta, narration, code. */
function renderTourStop(b, st, stepper) {
    return [
        h("h2", { class: "tour-h" }, st.title),
        tourMeta(b, st),
        st.text ? h("div", { class: "md tour-text", html: markdown(st.text) }) : null,
        st.code ? illustrativeCode(st.code) : null,
        ...st.sources.map((s) => codeView(s.src, { diff: true, label: s.label, context: 10 })),
        !st.text && !st.code && !st.sources.length ? h("p", { class: "tour-empty" }, "Nothing is attached to this step yet.") : null,
        st.next?.length
            ? h(
                  "div",
                  { class: "tour-leads" },
                  h("span", { class: "tour-leads-h" }, "Leads to"),
                  st.next.map((x) => {
                      const j = stepper.stops.findIndex((s) => s.id === x.node?.id);
                      return h("button", { class: "tour-lead", disabled: j < 0, onclick: () => stepper.go(j) }, x.label ? h("span", { class: "muted" }, `${x.label} → `) : null, x.node?.label ?? "");
                  }),
              )
            : null,
    ];
}

function openTour(blockId) {
    const b = findBlock(state.doc?.content, blockId);
    if (!b) return;
    closeTour();
    hideGutter();
    $("#peek").hidden = true;
    tour.block = b;
    tour.stops = tourStops(b);
    tour.stepper = createStepper({
        mount: document.body,
        id: "tour",
        label: `${b.title} tour`,
        stops: tour.stops,
        renderStage: () => h("div", {}, h("div", { class: "tour-stage-title" }, b.title), tourStage(b)),
        renderStop: (st, i, stepper) => renderTourStop(b, st, stepper),
        askLabel: "Ask about this step",
        onAsk: (i, st) => askAboutStop(b, i, st),
        onClose: () => {
            Object.assign(tour, { root: null, block: null, stops: [], stepper: null });
            syncChatFab();
        },
    });
    tour.root = tour.stepper.root;
    syncChatFab();
}

function closeTour() {
    tour.stepper?.close();
    tour.root = null;
}

function askAboutStop(b, i, st) {
    const where = b.type === "sequence" ? `${b.actors[st.from] ?? st.from} -> ${b.actors[st.to] ?? st.to}: ` : "";
    const refs = st.sources.map((s) => srcLabel(s.src)).join(", ");
    openChat({ blockId: b.id, quote: `Tour of "${b.title}", step ${i + 1} of ${tour.stops.length}: ${where}${st.title}${refs ? `\nCode: ${refs}` : ""}` });
}
// ---------------- services for feature modules (Command tab) ----------------
Object.assign(svc, {
    /** Unified hunks → the whiteboard's diff listing (same look as the Diff tab). */
    renderDiff: (hunks, file) => hunks.flatMap((hk) => [h("div", { class: "code" }, h("div", { class: "gap" }, hk.header)), diffListing(hk.lines, langOf(file))]),
    codeView,
    openChat: (ctx) => openChat(ctx),
    copyText,
    toast,
    syncChatFab: () => syncChatFab(),
    /** Command tab → chat: add focus items and/or a quote, opening the persistent Command chat. */
    addToCommandChat: (focus, extra = {}) => openChat({ mode: "command", focus, ...extra }),
    commandChatOpen: () => !$("#chat").hidden && chat.mode === "command",
    commandFocus: () => (chat.mode === "command" ? chat.focus : []),
    /** Leaving the Command tab hides its chat (kept for the next visit). */
    hideCommandChat: () => {
        if (chat.mode === "command" && !$("#chat").hidden) {
            $("#chat").hidden = true;
            syncChatFab();
        }
    },
    refreshCommandChatBlocked: () => {
        if (chat.mode !== "command") return;
        chat.blocked = svc.commandChatBlocked?.() ?? null;
        syncBlocked();
    },
});

// ---------------- boot ----------------
(async () => {
    try {
        state.catalog = await api("/catalog");
    } catch (e) {
        $("#main").replaceChildren(h("div", { class: "doc error" }, `Can't reach the whiteboard extension: ${e.message}`));
        return;
    }
    connect();
})();
