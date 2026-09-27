// Prose editing in docs: paragraphs, headings, list items and quotes are edited in place, as they look (not as
// Markdown), and saved back as Markdown for exactly the lines they came from. Diagrams, code and tables aren't prose.
//   Shift+Enter saves · Esc cancels · Ctrl/⌘+B bold · Ctrl/⌘+I italic · Ctrl/⌘+K link
import { $, h } from "./core.js";

const icon = (d, w = 15) => `<svg viewBox="0 0 16 16" width="${w}" height="${w}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
    save: icon('<path d="M3.5 8.5l3 3 6-7" stroke-width="1.9"/>'),
    bold: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4.5 2.8h4.3a2.7 2.7 0 0 1 0 5.4H4.5zM4.5 8.2h5a2.9 2.9 0 0 1 0 5.8h-5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
    italic: icon('<path d="M9.5 2.8h3.5M3 13.2h3.5M10.8 2.8 5.2 13.2"/>'),
    link: icon('<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),
    discard: icon('<path d="M4 4l8 8M12 4l-8 8" stroke-width="1.8"/>'),
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";
const LIST_MARK = /^(\s*)([-*+]|\d+[.)])\s+/;

/** What kind of prose a unit is, or null if it can't be edited as prose (code, tables, rules). */
export function editableKind(el) {
    if (!el?.dataset?.l || el.dataset.pk || !el.closest?.("#main .block.b-markdown > .md")) return null;
    const t = el.tagName;
    if (t === "P") return "p";
    if (/^H[1-6]$/.test(t)) return "h";
    if (t === "LI") return "li";
    if (t === "BLOCKQUOTE" && [...el.children].every((c) => c.tagName === "P")) return "quote";
    return null;
}

// ---------------- DOM → Markdown ----------------
// The edited HTML is flattened into runs of text, each with its formatting (bold, italic, strike, code, link), then
// written back as Markdown that core.js renders the same way: formats nest cleanly even when the reader's selections
// overlapped, markers hug the words (spaces stay outside), and Enter becomes a new paragraph or item.
const BR = "\u0001"; // a line break the reader typed (Enter)
function codeRef(a) {
    const file = a.dataset.file.split("/").map(encodeURIComponent).join("/");
    const s = a.dataset.start;
    const e = a.dataset.end;
    return `review-source:${a.dataset.side || "head"}/${file}${s ? `#L${s}${e && e !== s ? `-L${e}` : ""}` : ""}`;
}
export function hrefOf(a) {
    if (a.classList.contains("src") && a.dataset.file) return codeRef(a);
    return a.getAttribute("href") ?? "";
}
function collect(node, marks, out) {
    for (const n of node.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
            const t = n.data.replace(/\u200b/g, "").replace(/\u00a0/g, " ").replace(/[\t\n\r ]+/g, " ");
            if (t) out.push({ t, ...marks });
            continue;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = n.tagName;
        if (tag === "UL" || tag === "OL" || n.getAttribute("contenteditable") === "false") continue; // nested lists keep their own lines
        if (tag === "BR") out.push({ br: true });
        else if (tag === "STRONG" || tag === "B") collect(n, { ...marks, b: true }, out);
        else if (tag === "EM" || tag === "I") collect(n, { ...marks, i: true }, out);
        else if (tag === "DEL" || tag === "S" || tag === "STRIKE") collect(n, { ...marks, s: true }, out);
        else if (tag === "CODE") {
            const t = n.textContent.replace(/\u200b/g, "");
            if (t) out.push({ t, ...marks, code: true });
        } else if (tag === "SPAN" && n.classList.contains("ed-li")) {
            // A list line typed into a paragraph ("- " or "1. " at the start of a line).
            if (out.length && !out.at(-1).br) out.push({ br: true });
            out.push({ li: n.classList.contains("ol") ? "ol" : "ul" });
            collect(n, marks, out);
            out.push({ br: true });
        }
        else if (tag === "A") collect(n, { ...marks, href: hrefOf(n) || undefined }, out);
        else if (tag === "DIV" || tag === "P") {
            if (out.length && !out.at(-1).br) out.push({ br: true });
            collect(n, marks, out);
        } else collect(n, marks, out); // span, font, u… keep the text, drop what Markdown can't say
    }
    return out;
}
const MARKS = ["i", "b", "s"]; // opening order: italic outside bold (bold's content can't hold a *), strike innermost
const same = (a, b) => MARKS.every((m) => !!a[m] === !!b[m]) && !!a.code === !!b.code && a.href === b.href;
/** Formatted runs (no links) → Markdown. */
function fmt(runs) {
    let out = "";
    const open = []; // [{m, d}] marks open, in order, with the delimiter used
    const delim = (m) => {
        const last = out.at(-1);
        if (m === "s") return "~~";
        if (m === "b") return last === "*" ? "__" : "**";
        return last === "*" || open.some((o) => o.m === "b") ? "_" : "*"; // bold's content can't hold a *
    };
    const closeTo = (k) => {
        const ws = out.match(/\s*$/)[0];
        out = out.slice(0, out.length - ws.length);
        while (open.length > k) out += open.pop().d;
        out += ws;
    };
    for (const r of runs) {
        if (!r.code && !r.t.trim()) {
            out += r.t; // spaces never change formatting
            continue;
        }
        const want = MARKS.filter((m) => r[m]);
        // Keep an open mark only while the open prefix matches the wanted order exactly (italic outside bold), so the
        // result is always something core.js parses: never "**x_y_**".
        let keep = 0;
        while (keep < open.length && open[keep].m === want[keep]) keep++;
        if (keep < open.length) closeTo(keep);
        const lead = r.code ? "" : r.t.match(/^\s*/)[0];
        out += lead;
        for (const m of want)
            if (!open.some((o) => o.m === m)) {
                const d = delim(m);
                open.push({ m, d });
                out += d;
            }
        if (r.code && r.t.includes("`")) throw new Error("Inline code can't contain a backtick here; remove it or ask Copilot to make it a code block.");
        out += r.code ? `\`${r.t}\`` : r.t.slice(lead.length);
    }
    closeTo(0);
    return out;
}
/** One paragraph's runs → Markdown: consecutive runs with the same link become one [label](href). */
function para(runs) {
    let out = "";
    for (let i = 0; i < runs.length; ) {
        let j = i;
        while (j < runs.length && runs[j].href === runs[i].href) j++;
        const group = runs.slice(i, j).map((r) => ({ ...r, href: undefined }));
        const text = fmt(group);
        if (runs[i].href && text.trim()) {
            const lead = text.match(/^\s*/)[0];
            const trail = text.match(/\s*$/)[0];
            if (text.includes("]")) throw new Error("Link text can't contain \"]\"; remove it or link different words.");
            out += `${lead}[${text.trim()}](${runs[i].href})${trail}`;
        } else out += text;
        i = j;
    }
    return out;
}
export function inlineMd(node) {
    const runs = collect(node, {}, []);
    const paras = [[]];
    for (const r of runs) {
        if (r.br) paras.push([]);
        else if (r.li) {
            if (paras.at(-1).length) paras.push([]);
            paras.at(-1).li = r.li;
        } else {
            const cur = paras.at(-1);
            if (cur.length && same(cur.at(-1), r) && !r.code) cur.at(-1).t += r.t;
            else cur.push({ ...r });
        }
    }
    return paras.map((p) => (p.li && para(p).trim() ? (p.li === "ol" ? "1. " : "- ") : "") + para(p)).join(BR);
}
const LIST_LINE = /^([-*+]|\d+[.)]) /;
/** Paragraph parts → Markdown: list lines next to each other form one list (numbered ones count up). */
function joinParts(ps) {
    let out = "";
    let n = 0;
    ps.forEach((p, i) => {
        const kind = (x) => (LIST_LINE.test(x) ? (/^\d/.test(x) ? "ol" : "ul") : null);
        const list = !!kind(p);
        const prevList = i > 0 && kind(ps[i - 1]) === kind(p); // a bullet list and a numbered one stay separate lists
        if (/^\d+[.)] /.test(p)) {
            n = prevList && /^\d+[.)] /.test(ps[i - 1]) ? n + 1 : Number(/^\d+/.exec(p)[0]);
            p = p.replace(/^\d+/, String(n));
        }
        out += (i ? (list && prevList ? "\n" : "\n\n") : "") + p;
    });
    return out;
}
const parts = (s) =>
    s
        .split(BR)
        .map((x) => x.replace(/ {2,}/g, " ").trim())
        .filter(Boolean);

/** The unit's new Markdown for its source lines ("" deletes them). `lines` are its original source lines. */
export function unitMarkdown(el, kind, lines) {
    if (kind === "p") return joinParts(parts(inlineMd(el)));
    if (kind === "h") {
        const text = parts(inlineMd(el)).join(" ");
        return text ? `${"#".repeat(Number(el.tagName[1]))} ${text}` : "";
    }
    if (kind === "quote") {
        const paras = [...el.children].flatMap((p) => parts(inlineMd(p)));
        return paras.map((p) => `> ${p}`).join("\n>\n");
    }
    // List item: its own text (first line plus continuation lines) is rewritten; nested items below keep their lines.
    const m = LIST_MARK.exec(lines[0]) ?? ["", "", "-"];
    const indent = m[1];
    let tail = 1;
    while (tail < lines.length && lines[tail].trim() && !LIST_MARK.test(lines[tail])) tail++;
    const rest = lines.slice(tail);
    const items = parts(inlineMd(el));
    if (items.length > 1 && rest.some((l) => LIST_MARK.test(l))) throw new Error("An item with nested items can't be split in two; add the new item after its nested ones instead.");
    if (!items.length) {
        if (rest.some((l) => LIST_MARK.test(l))) throw new Error("An item with nested items can't be emptied; delete the nested items first.");
        return rest.join("\n").trim() ? rest.join("\n") : "";
    }
    const num = /^(\d+)([.)])$/.exec(m[2]);
    const marker = (k) => (num ? `${Number(num[1]) + k}${num[2]}` : m[2]);
    return [...items.map((t, k) => `${indent}${marker(k)} ${t}`), ...rest].join("\n");
}

// ---------------- the editor ----------------
/**
 * @param {{ main: HTMLElement, sourceOf: (blockId: string) => string|null, save: (edits: object[]) => Promise<void>,
 *           toast: (msg: string) => void, onChange?: (active: boolean) => void }} o
 */
export function createProseEditor(o) {
    let units = []; // { el, kind, blockId, from, to, lines, before, html, snapshot }
    let focused = null;

    const btn = (name, title, onclick, cls = "") => h("button", { class: `eb-${name} ${cls}`, title, "aria-label": title, html: ICONS[name], onmousedown: (e) => e.preventDefault(), onclick });
    const bSave = btn("save", "Save (Shift+Enter)", () => accept(), "eb-ok");
    const bBold = btn("bold", `Bold (${MOD}B)`, () => format("bold"));
    const bItalic = btn("italic", `Italic (${MOD}I)`, () => format("italic"));
    const bLink = btn("link", `Link (${MOD}K)`, () => openLink());
    const bDiscard = btn("discard", "Discard edits (Esc)", () => cancel(), "eb-no");
    const bar = h("div", { id: "editbar", role: "toolbar", "aria-label": "Editing", hidden: true }, bSave, h("span", { class: "eb-sep" }), bBold, bItalic, bLink, h("span", { class: "eb-gap" }), bDiscard);
    document.body.append(bar);
    const hint = h("div", { id: "edit-hint", hidden: true });
    $("#center").prepend(hint);

    // Link popover
    const linkIn = h("input", { type: "text", class: "el-in", placeholder: "https://…, #section, or path/to/file.ts#L10-L20", spellcheck: "false", "aria-label": "Link target" });
    const linkNote = h("div", { class: "el-note" });
    const linkApply = h("button", { class: "el-apply", onmousedown: (e) => e.preventDefault(), onclick: () => applyLink() }, "Apply");
    const linkRemove = h("button", { class: "el-remove", onmousedown: (e) => e.preventDefault(), onclick: () => removeLink() }, "Remove link");
    const pop = h("div", { id: "editlink", hidden: true, role: "dialog", "aria-label": "Link" }, linkIn, linkNote, h("div", { class: "el-row" }, linkRemove, linkApply));
    document.body.append(pop);
    let saved = null; // the selection the link applies to
    let linkEl = null;

    const active = () => units.length > 0;

    function start(els, { selection } = {}) {
        if (active()) return;
        const list = els.map((el) => ({ el, kind: editableKind(el) })).filter((u) => u.kind);
        if (!list.length) return;
        for (const u of list) {
            const blockEl = u.el.closest(".block[data-id]");
            u.blockId = blockEl.dataset.id;
            [u.from, u.to] = u.el.dataset.l.split("-").map(Number);
            const src = o.sourceOf(u.blockId);
            if (src === null) return o.toast("That text can't be edited here.");
            u.lines = src.replace(/\r\n/g, "\n").split("\n").slice(u.from, u.to + 1);
            u.before = u.lines.join("\n");
            u.html = u.el.innerHTML;
            u.snapshot = u.el.cloneNode(true);
        }
        // Document order, so the first unit (caret) and the runs below follow the page.
        list.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        units = list;
        for (const u of units) {
            u.el.classList.remove("picked", "unit-hover", "asking");
            u.el.classList.add("editing");
            for (const sub of u.el.querySelectorAll(":scope > ul, :scope > ol")) sub.setAttribute("contenteditable", "false");
            u.el.setAttribute("contenteditable", "true");
            u.el.setAttribute("spellcheck", "true");
            u.el.addEventListener("focus", onFocus);
        }
        joinRuns();
        document.body.classList.add("prose-editing");
        hint.replaceChildren(h("span", { class: "eh-dot" }), `Editing${units.length === 1 ? "" : ` ${units.length} parts`} · `, h("kbd", {}, "Shift"), "+", h("kbd", {}, "Enter"), " save · ", h("kbd", {}, "Esc"), " cancel");
        hint.hidden = false;
        const first = units[0].el;
        first.focus({ preventScroll: true });
        if (selection && first.contains(selection.startContainer)) {
            const s = getSelection();
            s.removeAllRanges();
            s.addRange(selection);
        } else caretToEnd(first);
        focused = units[0];
        units.forEach((u) => u.el.classList.toggle("edit-focus", u.run === focused.run));
        bar.hidden = false;
        place();
        o.onChange?.(true);
    }
    function caretToEnd(el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const nested = el.querySelector(":scope > ul, :scope > ol");
        if (nested) r.setEndBefore(nested);
        r.collapse(false);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
    }
    /**
     * Neighbouring units open together (adjacent in the same text) read as one editing area: one outline around the
     * run, no inner edges or rounded notches where they meet. Each unit still saves as its own lines.
     */
    let runs = [];
    function joinRuns() {
        runs = [];
        for (const u of units) {
            const md = u.el.closest(".md");
            const all = [...md.querySelectorAll("[data-l]")];
            const prev = runs.at(-1)?.at(-1);
            const adjacent = prev && prev.el.closest(".md") === md && all.indexOf(u.el) === all.indexOf(prev.el) + 1;
            if (adjacent) runs.at(-1).push(u);
            else runs.push([u]);
        }
        for (const run of runs)
            run.forEach((u, k) => {
                u.run = run;
                u.el.classList.toggle("edit-join-top", k > 0);
                u.el.classList.toggle("edit-join-bottom", k < run.length - 1);
            });
    }
    function onFocus(e) {
        focused = units.find((u) => u.el === e.currentTarget) ?? focused;
        units.forEach((u) => u.el.classList.toggle("edit-focus", u.run === focused?.run));
        place();
    }
    /** The toolbar sits in the margin at the top of the editing area being typed in, where the comment/copy icons were. */
    function place() {
        if (!active() || !focused) return;
        const run = focused.run ?? [focused];
        const el = run[0].el;
        const col = el.closest(".md").getBoundingClientRect();
        const first = el.getBoundingClientRect();
        const last = run.at(-1).el.getBoundingClientRect();
        const r = { top: first.top, height: last.bottom - first.top };
        const view = o.main.getBoundingClientRect();
        const hgt = bar.offsetHeight || 190;
        // Centred on the area when the tools are taller than it, else level with its top; kept on screen.
        const want = hgt > r.height ? r.top + (r.height - hgt) / 2 : r.top;
        const top = Math.max(view.top + 6, Math.min(want, view.bottom - hgt - 6));
        bar.style.left = `${Math.min(col.right + 18, view.right - 40)}px`;
        bar.style.top = `${top}px`;
        if (!pop.hidden) placePop();
        syncState();
    }
    function syncState() {
        const inEditor = units.some((u) => u.el.contains(getSelection()?.anchorNode ?? null));
        bBold.classList.toggle("on", inEditor && document.queryCommandState("bold"));
        bItalic.classList.toggle("on", inEditor && document.queryCommandState("italic"));
        bLink.classList.toggle("on", inEditor && !!anchorAtSelection());
    }
    function format(cmd) {
        if (!inEditorSelection()) focused?.el.focus();
        document.execCommand(cmd);
        syncState();
    }
    const inEditorSelection = () => {
        const s = getSelection();
        return !!s?.rangeCount && units.some((u) => u.el.contains(s.anchorNode));
    };
    function anchorAtSelection() {
        const s = getSelection();
        if (!s?.rangeCount) return null;
        const n = s.anchorNode;
        const el = n?.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement;
        const a = el?.closest?.("a");
        return a && units.some((u) => u.el.contains(a)) ? a : null;
    }

    // ---- links ----
    function openLink() {
        if (!inEditorSelection()) focused?.el.focus();
        const s = getSelection();
        saved = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
        linkEl = anchorAtSelection();
        linkIn.value = linkEl ? displayHref(hrefOf(linkEl)) : "";
        linkRemove.hidden = !linkEl;
        linkApply.textContent = linkEl ? "Update" : "Apply";
        linkNote.textContent = "";
        pop.hidden = false;
        placePop();
        linkIn.focus();
        linkIn.select();
    }
    const displayHref = (href) => {
        const m = /^review-source:(head|base)\/([^#]+)(.*)$/.exec(href);
        return m ? `${m[1] === "base" ? "base:" : ""}${decodeURIComponent(m[2])}${m[3]}` : href;
    };
    /** Accepts a URL, #anchor, review-source: link, or a repo path ("src/a.ts", "src/a.ts#L10-L20", "src/a.ts:10-20"). */
    function parseTarget(raw) {
        const v = raw.trim();
        if (!v) return null;
        if (/^(https?:|mailto:)/i.test(v)) return { kind: "url", href: v };
        if (v.startsWith("#")) return { kind: "anchor", href: v };
        if (v.startsWith("review-source:")) {
            const m = /^review-source:(head|base)\/([^#]+)(?:#L(\d+)(?:-L(\d+))?)?$/.exec(v);
            return m ? { kind: "code", side: m[1], file: decodeURIComponent(m[2]), start: m[3] ?? "", end: m[4] ?? m[3] ?? "" } : null;
        }
        if (/^www\./i.test(v)) return { kind: "url", href: `https://${v}` };
        const m = /^(base:)?([\w.@/-][^\s#:]*)(?:(?:#L|:)(\d+)(?:-L?(\d+))?)?$/.exec(v);
        if (m && /[./]/.test(m[2])) return { kind: "code", side: m[1] ? "base" : "head", file: m[2].replace(/^\.?\//, ""), start: m[3] ?? "", end: m[4] ?? m[3] ?? "" };
        return null;
    }
    function dress(a, t) {
        a.removeAttribute("target");
        a.removeAttribute("rel");
        a.className = "";
        for (const k of ["side", "file", "start", "end"]) delete a.dataset[k];
        if (t.kind === "code") {
            a.setAttribute("href", "#");
            a.className = "src";
            Object.assign(a.dataset, { side: t.side, file: t.file, start: t.start, end: t.end });
        } else {
            a.setAttribute("href", t.href);
            if (t.kind === "anchor") a.className = "anchor";
            else Object.assign(a, { target: "_blank", rel: "noopener noreferrer" });
        }
    }
    function applyLink() {
        const t = parseTarget(linkIn.value);
        if (!t) {
            linkNote.textContent = "Use https://…, #a-heading, or a file path like src/app.ts#L10-L20.";
            return;
        }
        closePop(false);
        if (linkEl?.isConnected) dress(linkEl, t);
        else if (saved) {
            const s = getSelection();
            s.removeAllRanges();
            s.addRange(saved);
            if (saved.collapsed) {
                const a = h("a", {}, t.kind === "code" ? t.file.split("/").pop() : linkIn.value.trim());
                dress(a, t);
                saved.insertNode(a);
                const r = document.createRange();
                r.setStartAfter(a);
                s.removeAllRanges();
                s.addRange(r);
            } else {
                const mark = `https://marginal.invalid/${Math.random().toString(36).slice(2)}`;
                document.execCommand("createLink", false, mark);
                for (const a of document.querySelectorAll(`a[href="${mark}"]`)) dress(a, t);
            }
        }
        syncState();
    }
    function removeLink() {
        const a = linkEl;
        closePop(false);
        if (!a?.isConnected) return;
        a.replaceWith(...a.childNodes);
        syncState();
    }
    function placePop() {
        const b = bLink.getBoundingClientRect();
        const w = 320;
        pop.style.left = `${Math.max(8, b.left - w - 8)}px`;
        pop.style.top = `${Math.max(8, Math.min(b.top - 6, innerHeight - 140))}px`;
    }
    function closePop(refocus = true) {
        if (pop.hidden) return;
        pop.hidden = true;
        if (refocus) {
            (focused?.el ?? units[0]?.el)?.focus({ preventScroll: true });
            if (saved) {
                const s = getSelection();
                s.removeAllRanges();
                s.addRange(saved);
            }
        } else (focused?.el ?? units[0]?.el)?.focus({ preventScroll: true });
    }
    linkIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            applyLink();
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closePop();
        }
    });

    // ---- keys, paste ----
    document.addEventListener(
        "keydown",
        (e) => {
            if (!active()) return;
            if (!pop.hidden && pop.contains(e.target)) return;
            // Keys typed elsewhere (the chat, the jump palette, another field) belong there.
            const ours = e.target === document.body || bar.contains(e.target) || units.some((u) => u.el.contains(e.target));
            if (!ours) return;
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                return cancel();
            }
            if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                return accept();
            }
            const inUnit = units.find((u) => u.el.contains(e.target));
            if (!inUnit) return;
            const mod = isMac ? e.metaKey : e.ctrlKey;
            if (mod && !e.altKey && ["k", "K"].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                return openLink();
            }
            if (mod && ["u", "U"].includes(e.key)) e.preventDefault(); // no underline in Markdown
            const li = listLineAtCaret();
            if (li && inUnit.el.contains(li) && e.key === "Backspace" && atLineStart(li)) {
                e.preventDefault();
                unlist(li);
                renumber();
                return;
            }
            if (e.key === "Enter" && !mod && li && inUnit.el.contains(li)) {
                e.preventDefault();
                enterInList(li);
                renumber();
                return place();
            }
            if (e.key === "Enter" && !mod) {
                e.preventDefault();
                if (inUnit.kind !== "h") document.execCommand("insertLineBreak"); // a new paragraph / item / quote line on save
            }
        },
        true,
    );
    o.main.addEventListener(
        "paste",
        (e) => {
            if (!active() || !units.some((u) => u.el.contains(e.target))) return;
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain").replace(/\r\n/g, "\n");
            document.execCommand("insertText", false, text.replace(/\n{2,}/g, "\n").split("\n").join(" "));
        },
        true,
    );
    o.main.addEventListener("drop", (e) => active() && units.some((u) => u.el.contains(e.target)) && e.preventDefault(), true);
    document.addEventListener("selectionchange", () => active() && syncState());
    o.main.addEventListener("scroll", () => active() && place(), { passive: true });
    addEventListener("resize", () => active() && place());
    new ResizeObserver(() => active() && place()).observe(o.main);
    o.main.addEventListener("input", (e) => {
        if (!active()) return;
        const u = units.find((x) => x.el.contains(e.target));
        if (u && e.inputType === "insertText") inputRules(u, e.data);
        renumber();
        place();
    });

    // ---- Markdown as you type: `code`, **bold**, *italic*, and "- " / "1. " at the start of a paragraph line ----
    const ZW = "\u200b";
    function caretText() {
        const s = getSelection();
        if (!s?.rangeCount || !s.isCollapsed) return null;
        const node = s.anchorNode;
        return node?.nodeType === Node.TEXT_NODE ? { node, off: s.anchorOffset } : null;
    }
    function caretAt(node, off) {
        const r = document.createRange();
        r.setStart(node, off);
        r.collapse(true);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
    }
    /** Replace the matched text before the caret with a formatting element holding its inner text. */
    function wrapBefore(node, off, start, len, inner, tag) {
        const after = node.data.slice(off);
        node.data = node.data.slice(0, start);
        const el = document.createElement(tag);
        el.textContent = inner;
        const rest = document.createTextNode(after || ZW);
        node.after(el, rest);
        caretAt(rest, after ? 0 : 1); // typing continues outside the new format
    }
    function inputRules(u, data) {
        const at = caretText();
        if (!at || at.node.parentElement?.closest("code")) return;
        const { node, off } = at;
        const before = node.data.slice(0, off).replace(/\u00a0/g, " ");
        let m;
        if (data === "`" && (m = /`([^`\u200b]+)`$/.exec(before))) return wrapBefore(node, off, m.index, m[0].length, m[1], "code");
        if (data === "*" && (m = /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/.exec(before))) return wrapBefore(node, off, m.index, m[0].length, m[1], "strong");
        if (data === "*" && (m = /(^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/.exec(before))) return wrapBefore(node, off, m.index + m[1].length, m[0].length - m[1].length, m[2], "em");
        if (data === " " && u.kind === "p" && node.parentNode === u.el && (m = /^([-*+]|(\d+)[.)]) $/.exec(before.replace(/\u200b/g, "")))) {
            const prev = node.previousSibling;
            if (prev && prev.nodeName !== "BR" && !prev.classList?.contains("ed-li")) return;
            startListLine(u, node, off, m[2] ? "ol" : "ul");
        }
    }
    /** Turn the caret's line into a list line: a block inside the paragraph, bulleted or numbered. */
    function startListLine(u, node, off, kind) {
        const li = document.createElement("span");
        li.className = `ed-li ${kind}`;
        const rest = node.data.slice(off);
        const prev = node.previousSibling;
        node.replaceWith(li);
        if (prev?.nodeName === "BR") prev.remove(); // the block starts its own line
        li.append(document.createTextNode(rest || ZW));
        // The rest of the line moves in; the break that ended it isn't needed after a block.
        while (li.nextSibling && li.nextSibling.nodeName !== "BR" && !li.nextSibling.classList?.contains("ed-li")) li.append(li.nextSibling);
        if (li.nextSibling?.nodeName === "BR") li.nextSibling.remove();
        caretAt(li.firstChild, rest ? 0 : 1);
    }
    const listLineAtCaret = () => {
        const s = getSelection();
        const n = s?.anchorNode;
        return (n?.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement)?.closest?.("span.ed-li") ?? null;
    };
    const textOf = (el) => el.textContent.replace(/\u200b/g, "");
    /** Enter in a list line: a new line of the same list, or (on an empty line) the end of the list. */
    function enterInList(li) {
        if (!textOf(li).trim()) {
            const t = document.createTextNode(ZW);
            li.replaceWith(t);
            caretAt(t, 1);
            return;
        }
        const s = getSelection();
        const r = s.getRangeAt(0).cloneRange();
        r.setEnd(li, li.childNodes.length);
        const tail = r.extractContents();
        const next = document.createElement("span");
        next.className = li.className;
        next.append(tail);
        if (!textOf(next)) next.replaceChildren(document.createTextNode(ZW));
        li.after(next);
        if (!li.childNodes.length || !textOf(li)) li.append(document.createTextNode(ZW));
        let first = next.firstChild;
        while (first && first.nodeType !== Node.TEXT_NODE) first = first.firstChild ?? first.nextSibling;
        if (first) caretAt(first, first.data.startsWith(ZW) ? 1 : 0);
    }
    /** Backspace at the start of a list line turns it back into plain text. */
    function unlist(li) {
        const prev = li.previousSibling;
        const kids = [...li.childNodes];
        if (!kids.length) kids.push(document.createTextNode(ZW));
        const needBreak = prev && prev.nodeName !== "BR" && !prev.classList?.contains("ed-li") && (prev.nodeType !== Node.TEXT_NODE || prev.data.replace(/\u200b/g, "").trim());
        li.replaceWith(...(needBreak ? [document.createElement("br")] : []), ...kids);
        let first = kids[0];
        while (first && first.nodeType !== Node.TEXT_NODE) first = first.firstChild;
        if (first) caretAt(first, 0);
    }
    const atLineStart = (li) => {
        const s = getSelection();
        if (!s?.rangeCount || !s.isCollapsed) return false;
        const r = document.createRange();
        r.setStart(li, 0);
        r.setEnd(s.anchorNode, s.anchorOffset);
        return !r.toString().replace(/\u200b/g, "");
    };
    /** Numbered lines count up within each run of them. */
    function renumber() {
        for (const u of units) {
            let n = 0;
            for (const k of u.el.childNodes) {
                if (k.classList?.contains("ed-li")) n = k.classList.contains("ol") ? n + 1 : 0;
                else if (k.nodeType !== Node.TEXT_NODE || k.data.replace(/\u200b/g, "").trim()) n = 0;
                if (k.classList?.contains("ol")) k.dataset.n = n;
            }
        }
    }

    // ---- finish ----
    let saving = false;
    async function accept() {
        if (!active() || saving) return;
        closePop(false);
        let edits;
        try {
            edits = units
                .map((u) => {
                    const after = unitMarkdown(u.el, u.kind, u.lines);
                    const unchanged = after === unitMarkdown(u.snapshot, u.kind, u.lines);
                    return unchanged ? null : { blockId: u.blockId, from: u.from, to: u.to, before: u.before, after };
                })
                .filter(Boolean);
        } catch (err) {
            return o.toast(err.message);
        }
        if (!edits.length) return end(true);
        saving = true;
        bar.classList.add("saving");
        try {
            await o.save(edits);
            end(false);
        } catch (err) {
            o.toast(`Not saved: ${err.message}`);
        } finally {
            saving = false;
            bar.classList.remove("saving");
        }
    }
    function cancel() {
        if (!active() || saving) return;
        closePop(false);
        end(true);
    }
    function end(restore) {
        for (const u of units) {
            u.el.removeEventListener("focus", onFocus);
            u.el.removeAttribute("contenteditable");
            u.el.removeAttribute("spellcheck");
            u.el.classList.remove("editing", "edit-focus", "edit-join-top", "edit-join-bottom");
            if (restore) u.el.innerHTML = u.html;
            else for (const sub of u.el.querySelectorAll('[contenteditable="false"]')) sub.removeAttribute("contenteditable");
        }
        units = [];
        focused = null;
        bar.hidden = true;
        hint.hidden = true;
        document.body.classList.remove("prose-editing");
        getSelection()?.removeAllRanges();
        document.activeElement?.blur?.();
        o.onChange?.(false);
    }

    return { start, active, cancel, accept, isEditing: (el) => units.some((u) => u.el === el || u.el.contains(el)), place };
}
