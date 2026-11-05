// Shared renderer helpers: DOM builders, API client, Markdown and syntax highlighting.
// Imported by app.js and by the Command tab modules; no app state lives here.
import { scanReferences, fenceOpening, isFenceClose, frameReferences, isMarkdownBlockStart, isMarkdownTableStart, isMarkdownTableRow } from "./references.js";
const params = new URLSearchParams(location.search);
export const TOKEN = params.get("t") ?? "";
export const INSTANCE = params.get("instance") ?? "";

export const $ = (sel, root = document) => root.querySelector(sel);
export const SVGNS = "http://www.w3.org/2000/svg";

export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k === "html") el.innerHTML = v;
        else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
}
export function s(tag, attrs = {}, ...children) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
}
export const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** replaceChildren that skips null/false like h() does (the native one renders them as text). */
export const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

export async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(`/api${path}`, { method, headers: { "x-wb-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

export function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2400);
}

// ---------------- markdown ----------------
export function slugify(t) {
    return t
        .toLowerCase()
        .replace(/<[^>]+>/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
}

const referenceHtml = (part, mode) => mode === "source"
    ? `<span data-ref-source="">${esc(part.source).replace(/\r/g, "&#13;")}</span>`
    : `<span class="session-ref" role="note" aria-label="Separate Copilot session: ${esc(part.label)}"><span class="session-ref-icon" aria-hidden="true">◉</span> ${esc(part.label)}</span>`;

/** Plain user messages remain plain text, with only the closed inert reference shape rendered. */
export function referencePlain(text) {
    return scanReferences(text, "plain").map((part) => part.type === "session" ? referenceHtml(part) : esc(part.text)).join("");
}

/** @param {import("./references.js").ReferenceContainer} container
 * @param {(text: string, container: import("./references.js").ReferenceContainer) => import("./references.js").ReferenceContent[]} readParts
 */
export function inline(text, referenceMode = "pill", allowReferences = true, container = "inline", readParts = scanReferences) {
    const protectedHtml = [];
    const protect = (html, source) => `\u0000${protectedHtml.push({ html, source }) - 1}\u0000`;
    let t = readParts(text, container).map((part) => {
        if (part.type === "session") return protect(allowReferences ? referenceHtml(part, referenceMode) : esc(part.source), part.source);
        if (part.type !== "literal") return part.text;
        if (part.kind === "fence") return protect(esc(part.text), part.text);
        const source = referenceMode === "source" && part.text.includes("\n") ? ' data-inline-source=""' : "";
        return protect(`<code${source}>${esc(part.text.slice(part.ticks, -part.ticks)).replace(/\r/g, "&#13;")}</code>`, part.text);
    }).join("");
    // Links own their labels before any pill is generated. A reference label under an anchor is literal source.
    t = t.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_, label, href) => {
        const raw = href;
        label = inline(label.replace(/\u0000(\d+)\u0000/g, (source, i) => protectedHtml[Number(i)]?.source ?? source), referenceMode, false);
        const m = /^review-source:(head|base)\/([^#]+)(?:#L(\d+)(?:-L(\d+))?)?$/.exec(raw);
        if (m) return protect(`<a href="#" class="src" data-side="${m[1]}" data-file="${esc(decodeURIComponent(m[2]))}" data-start="${m[3] ?? ""}" data-end="${m[4] ?? m[3] ?? ""}">${label}</a>`);
        if (/^https?:|^mailto:/i.test(raw)) return protect(`<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
        if (raw.startsWith("#")) return protect(`<a href="${esc(raw)}" class="anchor">${label}</a>`);
        return protect(label);
    });
    t = esc(t);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return t.replace(/\u0000(\d+)\u0000/g, (source, i) => protectedHtml[Number(i)]?.html ?? source);
}

export function markdown(src, annotate = false, referenceMode = "pill") {
    const frame = frameReferences(src, referenceMode === "source");
    return markdownBlocks(frame.lines, annotate, referenceMode, frame);
}

function markdownBlocks(lines, annotate, referenceMode, frame) {
    const renderInline = (text) => inline(text, referenceMode, true, "inline", frame.inlineParts);
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }
        const s = i;
        let m;
        let isList = false;
        if ((m = fenceOpening(line))) {
            const body = [];
            i++;
            while (i < lines.length && !isFenceClose(lines[i], m.length)) body.push(lines[i++]);
            if (i < lines.length) i++;
            out.push(`<pre><code>${highlight(body.join("\n"), m.language)}</code></pre>`);
        } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
            const lvl = m[1].length;
            out.push(`<h${lvl} id="${slugify(frame.restore(m[2]))}">${renderInline(m[2])}</h${lvl}>`);
            i++;
        } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
            out.push("<hr>");
            i++;
        } else if (line.startsWith(">")) {
            const body = [];
            while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
            out.push(`<blockquote>${markdownBlocks(body, false, referenceMode, frame)}</blockquote>`);
        } else if (isMarkdownTableStart(line, lines[i + 1])) {
            const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
            const head = cells(line);
            i += 2;
            const rows = [];
            while (i < lines.length && isMarkdownTableRow(lines[i])) rows.push(cells(lines[i++]));
            out.push(`<table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
            out.push(list(lines, i, (n) => (i = n), annotate, referenceMode, 0, frame));
            isList = true;
        } else {
            const body = [line];
            i++;
            while (i < lines.length && lines[i].trim() && !isMarkdownBlockStart(lines[i])) body.push(lines[i++]);
            out.push(`<p>${renderInline(body.join(referenceMode === "source" ? "\n" : " "))}</p>`);
        }
        // Tag each commentable unit with its source line range; list items carry their own.
        if (annotate && !isList && !out[out.length - 1].startsWith("<hr")) out[out.length - 1] = out[out.length - 1].replace(/^<(\w+)/, `<$1 data-l="${frame.lineAt(s)}-${frame.lineAt(i) - 1}"`);
    }
    return out.join("\n");
}

export function list(lines, start, setIndex, annotate = false, referenceMode = "pill", offset = 0, frame = null) {
    const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = start;
    while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+([^\n]*)$/.exec(lines[i]);
        if (m && m[1].length === indent) {
            items.push({ text: m[3], sub: [], from: i });
            i++;
        } else if (m && m[1].length > indent && items.length) {
            const nested = [];
            const from = i;
            while (i < lines.length) {
                const mm = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[i]);
                if (mm && mm[1].length <= indent) break;
                if (!lines[i].trim()) break;
                nested.push(lines[i++]);
            }
            items[items.length - 1].sub.push({ text: nested.join("\n"), offset: from + offset });
        } else if (lines[i].trim() && !m && items.length && /^\s{2,}/.test(lines[i])) {
            items[items.length - 1].text += referenceMode === "source" ? "\n" + lines[i] : " " + lines[i].trim();
            i++;
        } else break;
    }
    setIndex(i);
    items.forEach((it, k) => (it.to = (items[k + 1]?.from ?? i) - 1));
    const tag = ordered ? "ol" : "ul";
    const lineAt = (line) => frame ? frame.lineAt(line) : line;
    return `<${tag}>${items.map((it) => `<li${annotate ? ` data-l="${lineAt(it.from + offset)}-${lineAt(it.to + offset + 1) - 1}"` : ""}>${inline(it.text, referenceMode, true, "inline", frame?.inlineParts)}${it.sub.map((sub) => list(sub.text.split("\n"), 0, () => {}, annotate, referenceMode, sub.offset, frame)).join("")}</li>`).join("")}</${tag}>`;
}

// ---------------- tiny highlighter ----------------
export const KEYWORDS = new Set(
    "abstract and as async await break case catch class const continue def default defer del delete do elif else enum export extends false final finally fn for from func function go if impl import in interface is let loop match mod mut new nil None not null or package private protected pub public raise return self static struct super switch this throw trait true True False try type typeof use var void where while with yield".split(" "),
);
export function highlight(code, lang = "") {
    if (lang === "text" || lang === "diff" || lang === "md" || lang === "markdown") return esc(code);
    const re = /(\/\/[^\n]*|#(?![\[!])[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_.]*[a-z]*)\b|([A-Za-z_]\w*)/g;
    let out = "";
    let last = 0;
    const hashComments = /^(py|python|sh|bash|shell|rb|ruby|yaml|yml|toml|ps1|powershell|r)$/i.test(lang);
    const dashComments = /^(sql|lua|haskell|hs)$/i.test(lang);
    for (const m of code.matchAll(re)) {
        out += esc(code.slice(last, m.index));
        last = m.index + m[0].length;
        if (m[1]) {
            const isHash = m[1].startsWith("#");
            const isDash = m[1].startsWith("--");
            if ((isHash && !hashComments) || (isDash && !dashComments)) {
                out += esc(m[1].slice(0, 1));
                last = m.index + 1;
                continue;
            }
            out += `<span class="tok-c">${esc(m[1])}</span>`;
        } else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
        else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
        else if (m[4]) out += KEYWORDS.has(m[4]) ? `<span class="tok-k">${m[4]}</span>` : m[4];
    }
    return out + esc(code.slice(last));
}
export const langOf = (file = "") => (file.split(".").pop() ?? "").toLowerCase();

/** Late-bound services registered by app.js (code view, chat, peek…) so feature modules avoid import cycles. */
export const svc = {};

/** Tiny event bus for cross-module notifications (SSE events, tab changes). */
const listeners = new Map();
export const bus = {
    on(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
        return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
        for (const fn of listeners.get(type) ?? []) {
            try {
                fn(payload);
            } catch (e) {
                console.error(e);
            }
        }
    },
};
