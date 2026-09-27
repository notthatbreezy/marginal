// Previewing a suggestion Copilot made while you were discussing: the doc as it would be, with the changes marked in
// place like tracked changes. Words added are underlined green, words removed struck through in red, whole paragraphs
// and blocks marked as new or faded out as removed; diagrams and other structured parts get a "suggested" rail.
import { h } from "./core.js";

const norm = (s) => s.replace(/\s+/g, " ").trim();

/** Longest-common-subsequence diff of two lists: [{op:"eq", a, b} | {op:"del", a} | {op:"ins", b}]. */
export function diffSeq(A, B, same, limit = 4_000_000) {
    const n = A.length;
    const m = B.length;
    if (n * m > limit) return null;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = same(A[i], B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (same(A[i], B[j])) out.push({ op: "eq", a: A[i++], b: B[j++] });
        else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "del", a: A[i++] });
        else out.push({ op: "ins", b: B[j++] });
    }
    while (i < n) out.push({ op: "del", a: A[i++] });
    while (j < m) out.push({ op: "ins", b: B[j++] });
    return out;
}

/** Word-level diff of two strings; tokens keep their trailing whitespace so the new text's offsets stay exact. */
export function wordDiff(a, b) {
    const tok = (s) => s.match(/^\s+|\S+\s*/g) ?? [];
    const ops = diffSeq(tok(a), tok(b), (x, y) => x.trim() === y.trim(), 1_000_000);
    if (!ops) return null;
    const out = [];
    for (const o of ops) {
        const op = o.op;
        const text = op === "del" ? o.a : o.b;
        const last = out.at(-1);
        if (last?.op === op) last.text += text;
        else out.push({ op, text });
    }
    return out;
}

// ---------- marking words inside a rendered element ----------
function segments(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest(".sg-del") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const out = [];
    let off = 0;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
        out.push({ node: n, start: off, end: off + n.data.length });
        off += n.data.length;
    }
    return out;
}
function wrap(root, start, end) {
    for (const s of segments(root).reverse()) {
        const from = Math.max(start, s.start) - s.start;
        const to = Math.min(end, s.end) - s.start;
        if (from >= to) continue;
        let node = s.node;
        if (to < node.data.length) node.splitText(to);
        if (from > 0) node = node.splitText(from);
        const ins = h("ins", { class: "sg-ins" });
        node.replaceWith(ins);
        ins.append(node);
    }
}
function insertAt(root, at, text) {
    const del = h("del", { class: "sg-del" }, text);
    const segs = segments(root);
    const s = segs.find((x) => at >= x.start && at < x.end) ?? segs.findLast((x) => at >= x.start);
    if (!s) return void root.append(del);
    const local = at - s.start;
    if (local >= s.node.data.length) s.node.after(del);
    else if (local === 0) s.node.before(del);
    else s.node.splitText(local).before(del);
}
/** How much of two texts is the same words (0..1): below ~⅓, a paragraph was replaced rather than edited. */
export function similarity(ops) {
    let eq = 0;
    let all = 0; // old + new characters
    for (const o of ops) {
        const n = o.text.trim().length;
        all += o.op === "eq" ? 2 * n : n;
        if (o.op === "eq") eq += 2 * n;
    }
    return all ? eq / all : 1;
}
/** Mark the words that differ from `oldText` inside `el` (rendered from the new text). Returns whether anything did. */
export function markWords(el, oldText, ops = wordDiff(oldText, el.textContent)) {
    if (!ops) return false;
    const marks = [];
    let off = 0;
    for (const o of ops) {
        if (o.op === "del") {
            if (o.text.trim()) marks.push({ del: true, at: off, text: o.text });
        } else {
            if (o.op === "ins" && o.text.trim()) marks.push({ start: off, end: off + o.text.trimEnd().length });
            off += o.text.length;
        }
    }
    // Removed words first, then added ones, each from the end backwards: offsets count only the new text, so earlier
    // ones stay valid, and a removal never lands inside an addition's mark.
    for (const m of marks.filter((x) => x.del).reverse()) insertAt(el, m.at, m.text);
    for (const m of marks.filter((x) => !x.del).reverse()) wrap(el, m.start, m.end);
    return marks.length > 0;
}

// ---------- the preview ----------
const units = (block) => [...block.querySelectorAll(".md [data-l]")].filter((u) => !u.parentElement.closest("[data-l]"));
const shape = (u) => `${u.tagName}|${u.innerHTML.replace(/\s(data-[\w-]+|id)="[^"]*"/g, "")}`;
const hit = (el, cls, label) => {
    el.classList.add(cls, "sg-hit");
    if (label) {
        el.dataset.sg = label;
        if (el.matches("[data-unit]")) el.setAttribute("title", `${label}${label === "Suggested notes" ? " (shown in Inspect once applied)" : ""}`);
    }
};

/** A Markdown block, old against new: unchanged paragraphs stay plain, edited ones get word marks. */
function diffMarkdown(oldBlock, newBlock) {
    const A = units(oldBlock);
    const B = units(newBlock);
    const ops = diffSeq(A, B, (a, b) => shape(a) === shape(b));
    if (!ops) return hit(newBlock, "sg-mod", "Suggested change");
    for (let k = 0; k < ops.length; ) {
        if (ops[k].op === "eq") {
            k++;
            continue;
        }
        const dels = [];
        const inss = [];
        for (; k < ops.length && ops[k].op !== "eq"; k++) (ops[k].op === "del" ? dels : inss).push(ops[k]);
        const next = ops[k]?.b ?? null; // the new paragraph after this run, if any
        const pairs = Math.min(dels.length, inss.length);
        const gone = (a, before) => {
            const g = a.cloneNode(true);
            g.removeAttribute("data-l");
            g.setAttribute("aria-label", "Would be removed");
            hit(g, "sg-gone");
            before.before(g);
        };
        for (let p = 0; p < pairs; p++) {
            const u = inss[p].b;
            const ops = wordDiff(dels[p].a.textContent, u.textContent);
            // Mostly different words: show the old paragraph removed and the new one added, not a thicket of marks.
            if (ops && similarity(ops) < 0.35) {
                gone(dels[p].a, u);
                hit(u, "sg-new");
            } else if (!markWords(u, dels[p].a.textContent, ops)) hit(u, "sg-mod", "Formatting"); // same words, new formatting
            else u.classList.add("sg-hit", "sg-edited");
        }
        for (const o of inss.slice(pairs)) hit(o.b, "sg-new");
        const place = next ?? inss.at(-1)?.b ?? null;
        for (const o of dels.slice(pairs)) {
            const gone = o.a.cloneNode(true);
            gone.removeAttribute("data-l");
            gone.setAttribute("aria-label", "Would be removed");
            hit(gone, "sg-gone");
            if (next) place.before(gone);
            else if (place) place.after(gone);
            else newBlock.querySelector(".md")?.append(gone);
        }
    }
}

/**
 * Mark a rendered preview. base: the current doc's blocks rendered off-screen (Map id -> element), for what text used
 * to say; gone: elements captured from the page before the preview, for parts that would be removed.
 */
export function decorate(main, changes, { oldBlock, gone }) {
    const find = (id) => id && (main.querySelector(`[data-unit="${CSS.escape(id)}"]`) ?? main.querySelector(`.block[data-id="${CSS.escape(id)}"]`));
    const seen = new Set();
    for (const le of changes) {
        const key = `${le.type}:${le.targetId}`;
        if (!le?.targetId || seen.has(key)) continue;
        seen.add(key);
        if (le.type === "remove") {
            const g = gone.get(le.targetId);
            if (!g) continue;
            const el = g.el.cloneNode(true);
            el.removeAttribute("data-id");
            el.removeAttribute("data-unit");
            el.inert = true;
            hit(el, "sg-gone-block", "Would be removed");
            const prev = g.prevId && find(g.prevId);
            const parent = g.parentId && find(g.parentId);
            if (prev) prev.after(el);
            else if (parent) (parent.querySelector(".children") ?? parent).prepend(el);
            else main.querySelector(".doc")?.prepend(el);
            continue;
        }
        const el = find(le.targetId);
        if (!el) continue;
        if (le.type === "insert") hit(el, "sg-new", "New");
        else if (le.type === "move") hit(el, "sg-mod", "Moved");
        else if (el.matches(".b-markdown") && oldBlock(le.targetId)) diffMarkdown(oldBlock(le.targetId), el);
        else hit(el, "sg-mod", le.fields?.includes("notes") ? "Suggested notes" : "Suggested change");
    }
    return [...main.querySelectorAll(".sg-hit")];
}

/** What the page shows for each part a suggestion would remove (captured before the preview replaces it). */
export function captureGone(main, changes) {
    const gone = new Map();
    for (const le of changes) {
        if (le?.type !== "remove" || !le.targetId) continue;
        const el = main.querySelector(`[data-unit="${CSS.escape(le.targetId)}"]`) ?? main.querySelector(`.block[data-id="${CSS.escape(le.targetId)}"]`);
        if (!el) continue;
        const prev = el.previousElementSibling;
        const parent = el.parentElement?.closest("[data-unit], .block[data-id]");
        gone.set(le.targetId, { el: el.cloneNode(true), prevId: prev?.dataset.unit ?? prev?.dataset.id ?? null, parentId: parent?.dataset.unit ?? parent?.dataset.id ?? null });
    }
    return gone;
}

export { norm };
