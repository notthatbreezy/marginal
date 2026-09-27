// The doc outline behind Contents and Ctrl/⌘-J, plus the palette's fuzzy ranking. Pure (no DOM), so it's unit tested.
// It is a tree that follows the doc: sections hold what's inside them (nested sections, diagrams, code peeks, titled
// callouts, Markdown headings), and Markdown headings nest under each other by rank.

const NOTABLE = new Set(["sequence", "flow_diagram", "call_stack_diff", "database_lens", "code_peek"]);
export const KIND_LABEL = { section: "Section", heading: "Heading", sequence: "Sequence", flow_diagram: "Flow", call_stack_diff: "Call stack", database_lens: "Data lens", code_peek: "Code", callout: "Callout", code: "Code", image: "Image" };

/** Plain text of one line of inline Markdown (for labels). */
const plain = (t) =>
    String(t ?? "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
const clip = (t, n = 80) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * The outline of a doc, in reading order. Each entry has a level (1 = top) and the key of its parent, so the
 * Contents card can fold it; entries resolve to their rendered element lazily (the doc re-renders).
 */
export function outlineOf(doc) {
    const out = [];
    const walk = (blocks, parent, trail) => {
        const level = parent ? parent.level + 1 : 1;
        for (const b of blocks ?? []) {
            const add = (kind, label, extra = {}) => {
                const e = { key: extra.key ?? b.id, blockId: b.id, kind, level, parent: parent?.key ?? null, label: clip(plain(label) || KIND_LABEL[kind]), trail, ...extra };
                out.push(e);
                return e;
            };
            if (b.type === "section") {
                const sec = add("section", b.title);
                walk(b.children, sec, [...trail, clip(plain(b.title), 40)]);
            } else if (b.type === "callout") {
                const own = b.title ? add("callout", b.title) : null;
                walk(b.children, own ?? parent, own ? [...trail, clip(plain(b.title), 40)] : trail);
            } else if (b.type === "markdown") {
                // Headings the agent wrote inside prose (outside code fences), matched to the rendered h1–h4 by order.
                // A heading nests under the nearest earlier heading of a higher rank in the same text.
                let fence = false;
                let n = 0;
                const stack = []; // [{rank, entry}]
                for (const line of String(b.markdown ?? "").split("\n")) {
                    if (/^```/.test(line)) fence = !fence; // exactly what core.js markdown() treats as a fence
                    const m = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
                    if (!m) continue;
                    const rank = m[1].length;
                    while (stack.length && stack.at(-1).rank >= rank) stack.pop();
                    const up = stack.at(-1)?.entry ?? parent;
                    const entry = { key: `${b.id}#${n}`, blockId: b.id, kind: "heading", heading: n++, level: up ? up.level + 1 : 1, parent: up?.key ?? null, label: clip(plain(m[2]) || "Heading"), trail: up && up !== parent ? [...trail, up.label] : trail };
                    out.push(entry);
                    stack.push({ rank, entry });
                }
            } else if (NOTABLE.has(b.type)) {
                const label = b.title ?? b.caption ?? b.source?.file?.split("/").pop();
                add(b.type, label);
            } else if ((b.type === "code" || b.type === "image") && b.caption) add(b.type, b.caption);
        }
    };
    walk(doc?.content, null, []);
    // Mark which entries have children (they get a fold toggle).
    const parents = new Set(out.map((e) => e.parent).filter(Boolean));
    for (const e of out) e.hasChildren = parents.has(e.key);
    return out;
}

/** Subsequence/substring match of one query token against text; higher is better, word starts and contiguity win. */
export function matchToken(q, text) {
    const t = text.toLowerCase();
    const boundary = (k) => k === 0 || /[\s\-_/.:(·›]/.test(t[k - 1]);
    const i = t.indexOf(q);
    if (i >= 0) return { score: 100 + (boundary(i) ? 40 : 0) + (i === 0 ? 20 : 0) - i * 0.3, pos: Array.from({ length: q.length }, (_, k) => i + k) };
    const pos = [];
    let score = 0;
    let last = -2;
    for (let k = 0, j = 0; k < t.length && j < q.length; k++)
        if (t[k] === q[j]) {
            score += boundary(k) ? 8 : k === last + 1 ? 5 : 1;
            pos.push(k);
            last = k;
            j++;
        }
    return pos.length === q.length ? { score, pos } : null;
}
/** Rank outline entries for a query: every token must hit the label (fuzzy) or its section trail (substring). */
export function rank(entries, query) {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return entries.map((e) => ({ e, pos: [] }));
    const hits = [];
    entries.forEach((e, order) => {
        let score = e.level === 1 ? 4 : 0;
        const pos = new Set();
        for (const tk of tokens) {
            const m = matchToken(tk, e.label);
            if (m) {
                score += m.score;
                m.pos.forEach((p) => pos.add(p));
                continue;
            }
            // "flow", "sequence", "callout"… find things by what they are; the section trail narrows by where.
            const kind = (KIND_LABEL[e.kind] ?? "").toLowerCase();
            const trail = e.trail.join(" › ").toLowerCase();
            if (e.kind !== "section" && kind.startsWith(tk)) score += 35;
            else if (trail.includes(tk)) score += 30;
            else return;
        }
        hits.push({ e, pos: [...pos], score, order });
    });
    return hits.sort((a, b) => b.score - a.score || a.order - b.order);
}
