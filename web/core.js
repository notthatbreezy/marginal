// Shared renderer helpers: DOM builders, API client, Markdown and syntax highlighting.
// Imported by app.js and by the Command tab modules; no app state lives here.
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
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
}
export function s(tag, attrs = {}, ...children) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
}
export const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** replaceChildren that skips null/false like h() does (the native one renders them as text). */
export const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

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

export function inline(text) {
    const codes = [];
    let t = text.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    t = esc(t);
    t = t.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (_, label, href) => {
        const raw = href.replace(/&amp;/g, "&");
        const m = /^review-source:(head|base)\/([^#]+)(?:#L(\d+)(?:-L(\d+))?)?$/.exec(raw);
        if (m) return `<a href="#" class="src" data-side="${m[1]}" data-file="${esc(decodeURIComponent(m[2]))}" data-start="${m[3] ?? ""}" data-end="${m[4] ?? m[3] ?? ""}">${label}</a>`;
        if (/^https?:|^mailto:/i.test(raw)) return `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        if (raw.startsWith("#")) return `<a href="${esc(raw)}" class="anchor">${label}</a>`;
        return label;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

export function markdown(src, annotate = false) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const isBlockStart = (l) => /^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\s*\|.*\|\s*$|(-{3,}|\*{3,})\s*$)/.test(l);
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }
        const s = i;
        let m;
        let isList = false;
        if ((m = /^```\s*([\w+-]*)/.exec(line))) {
            const body = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
            i++;
            out.push(`<pre><code>${highlight(body.join("\n"), m[1])}</code></pre>`);
        } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
            const lvl = m[1].length;
            out.push(`<h${lvl} id="${slugify(m[2])}">${inline(m[2])}</h${lvl}>`);
            i++;
        } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
            out.push("<hr>");
            i++;
        } else if (line.startsWith(">")) {
            const body = [];
            while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
            out.push(`<blockquote>${markdown(body.join("\n"))}</blockquote>`);
        } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
            const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
            const head = cells(line);
            i += 2;
            const rows = [];
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
            out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
            out.push(list(lines, i, (n) => (i = n), annotate));
            isList = true;
        } else {
            const body = [line];
            i++;
            while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) body.push(lines[i++]);
            out.push(`<p>${inline(body.join(" "))}</p>`);
        }
        // Tag each commentable unit with its source line range; list items carry their own.
        if (annotate && !isList && !out[out.length - 1].startsWith("<hr")) out[out.length - 1] = out[out.length - 1].replace(/^<(\w+)/, `<$1 data-l="${s}-${i - 1}"`);
    }
    return out.join("\n");
}

export function list(lines, start, setIndex, annotate = false) {
    const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = start;
    while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length === indent) {
            items.push({ text: m[3], sub: [], from: i });
            i++;
        } else if (m && m[1].length > indent && items.length) {
            const nested = [];
            while (i < lines.length) {
                const mm = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[i]);
                if (mm && mm[1].length <= indent) break;
                if (!lines[i].trim()) break;
                nested.push(lines[i++]);
            }
            items[items.length - 1].sub.push(nested.join("\n"));
        } else if (lines[i].trim() && !m && items.length && /^\s{2,}/.test(lines[i])) {
            items[items.length - 1].text += " " + lines[i].trim();
            i++;
        } else break;
    }
    setIndex(i);
    items.forEach((it, k) => (it.to = (items[k + 1]?.from ?? i) - 1));
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items.map((it) => `<li${annotate ? ` data-l="${it.from}-${it.to}"` : ""}>${inline(it.text)}${it.sub.map((sub) => list(sub.split("\n"), 0, () => {})).join("")}</li>`).join("")}</${tag}>`;
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
