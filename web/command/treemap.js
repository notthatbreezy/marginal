// Territory treemap: nested squarified tiles with semantic tiers and composable layers
// (plan footprint · active checkpoint · changed/heat · live ping · new/deleted). DOM tiles, not SVG, for text + hit-testing.
import { h } from "../core.js";
import { findNode, squarify, weigh } from "./squarify.js";
import { heatOf, relTime } from "./derive.js";

const HEAD = 18; // directory label strip
const PAD = 3;
const MAX_TILES = 2500; // beyond this, small directories render as solid blocks (performance budget)
const LIVE_MS = 20_000;

export const fmtCounts = (a, d) => (a || d ? [h("span", { class: "add" }, `+${a}`), " ", h("span", { class: "del" }, `−${d}`)] : []);

/**
 * m: { tree, root, changes, fronts: Map(id → front), match: { footprint(path), active(path), touchesFootprint(dir), phaseOf(path) }, pins: Map, now,
 *      filter?(path, change) → boolean (dim others), picked?: Set, badges?: Map(path→n), stopOn?: path }
 */
export function createTreemap(host, { onZoom, onHover, tooltip } = {}) {
    host.classList.add("tm");
    host.setAttribute("role", "tree");
    let m = null;
    let hoverPath = null;
    let dirTotals = new Map();
    const pinged = new Map(); // path → lastAt already announced with a ping

    function totalsByDir(changes) {
        const t = new Map();
        for (const [path, c] of changes) {
            let i = path.lastIndexOf("/");
            while (true) {
                const d = i < 0 ? "" : path.slice(0, i);
                const v = t.get(d) ?? { add: 0, del: 0, live: 0 };
                v.add += c.add;
                v.del += c.del;
                t.set(d, v);
                if (i < 0) break;
                i = path.lastIndexOf("/", i - 1);
            }
        }
        return t;
    }

    function render(model) {
        m = model;
        const W = host.clientWidth;
        const H = host.clientHeight;
        host.replaceChildren();
        if (!W || !H || !m?.tree) return;
        dirTotals = totalsByDir(m.changes);
        const start = findNode(m.tree, m.root) ?? m.tree;
        weigh(start, { pins: m.pins });
        let count = 0;

        const place = (n, x, y, w, hgt) => {
            count++;
            const el = document.createElement("div");
            el.className = "tn";
            el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${hgt}px`;
            el.dataset.path = n.path;
            el.setAttribute("role", "treeitem");
            el.setAttribute("aria-level", String(n.depth + 1));
            if (n.dir) placeDir(el, n, w, hgt);
            else placeFile(el, n, w, hgt);
            return el;
        };

        const placeDir = (el, n, w, hgt) => {
            const tot = dirTotals.get(n.path);
            el.classList.add("dir", `depth-${Math.min(n.depth, 3)}`);
            if (m.match.active(n.path) && n.path) el.classList.add("active");
            else if (m.match.footprint(n.path) && n.path) el.classList.add("fp");
            if (!tot && !m.match.touchesFootprint(n.path)) el.classList.add("untouched");
            const showHead = hgt > 28 && w > 36;
            if (showHead) {
                const pinned = m.pins.has(n.path);
                el.append(h("div", { class: "th" }, pinned ? h("span", { class: "pin", title: "Pinned" }, "◆") : null, h("span", { class: "nm" }, `${n.name || m.repoName || ""}/`), w > 110 && tot ? h("span", { class: "ct" }, fmtCounts(tot.add, tot.del)) : null));
            }
            el.setAttribute("aria-label", `${n.path || m.repoName}/, ${tot ? `${tot.add} added ${tot.del} removed` : "no changes"}`);
            const top = showHead ? HEAD : 2;
            const iw = w - PAD * 2;
            const ih = hgt - top - PAD;
            const tiny = iw < 8 || ih < 8;
            // Budget: when over, collapse unchanged subtrees; changed ones always open so edits stay visible.
            if (tiny || (count > MAX_TILES && !tot)) {
                el.classList.add("solid");
                return;
            }
            const rects = squarify(
                n.children.map((c) => ({ node: c, value: c.w })),
                0,
                0,
                iw,
                ih,
            );
            const frag = document.createDocumentFragment();
            for (const r of rects) if (r.w >= 2 && r.h >= 2) frag.append(place(r.node, r.x + PAD, r.y + top, Math.max(r.w - 2, 1), Math.max(r.h - 2, 1)));
            el.append(frag);
        };

        const placeFile = (el, n, w, hgt) => {
            const c = m.changes.get(n.path);
            el.classList.add("file");
            const inFp = m.match.footprint(n.path);
            if (m.match.active(n.path)) el.classList.add("active");
            else if (inFp) el.classList.add("fp");
            if (c) {
                const front = m.fronts.get(c.lead);
                el.classList.add("changed", `f${(front?.color ?? 5) + 1}`);
                el.style.setProperty("--heat", `${heatOf(c.add + c.del)}%`);
                if (c.lastAt && m.now - c.lastAt < LIVE_MS) el.classList.add("live");
                // One ping per observed change, not per render.
                if (c.lastAt && pinged.get(n.path) !== c.lastAt && m.now - c.lastAt < LIVE_MS) {
                    pinged.set(n.path, c.lastAt);
                    el.append(h("i", { class: "ping", "aria-hidden": "true" }));
                }
                if (c.kind === "added" || c.kind === "untracked") el.classList.add("newfile");
                if (c.kind === "deleted") el.classList.add("deleted");
                if (m.offPlan?.(n.path, c)) el.classList.add("offplan");
                if (c.fronts.size > 1) {
                    const [a, b] = [...c.fronts.keys()].map((id) => m.fronts.get(id)?.color ?? 5);
                    el.classList.add("collide");
                    el.style.setProperty("--c1", `var(--front-${a})`);
                    el.style.setProperty("--c2", `var(--front-${b})`);
                }
            } else if (!inFp) el.classList.add("untouched");
            if (w >= 40 && hgt >= 18) el.append(h("div", { class: "fl" }, n.name));
            if (c && w >= 80 && hgt >= 36) el.append(h("div", { class: "fc" }, fmtCounts(c.add, c.del)));
            if (c && w >= 24 && hgt >= 12) {
                const t = c.add + c.del || 1;
                el.append(h("div", { class: "bar" }, h("i", { class: "a", style: `width:${(c.add / t) * 100}%` }), h("i", { class: "d", style: `width:${(c.del / t) * 100}%` })));
            }
            m.decorateFile?.(el, n, c, w, hgt);
            if (m.filter && !m.filter(n.path, c)) el.classList.add("dim");
            if (m.picked?.has(n.path)) el.classList.add("picked");
            el.setAttribute("aria-label", `${n.path}${c ? `, ${[...c.fronts.keys()].map((id) => m.fronts.get(id)?.label ?? id).join(" and ")}, ${c.add} added ${c.del} removed` : ""}${m.offPlan?.(n.path, c) ? ", off-plan" : ""}`);
        };

        host.append(place(start, 0, 0, W, H));
        if (hoverPath) showTip(hoverPath);
    }

    // ---------- hover tooltip ----------
    function clearTip() {
        host.querySelectorAll(".tip").forEach((e) => e.remove());
        host.querySelectorAll(".tn.hover").forEach((e) => e.classList.remove("hover"));
    }
    function showTip(path) {
        clearTip();
        const el = host.querySelector(`.tn[data-path="${CSS.escape(path)}"]`);
        if (!el || !m) return;
        el.classList.add("hover");
        const node = findNode(m.tree, path);
        if (!node) return;
        const r = el.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        const tip = h("div", { class: "tip", role: "tooltip" }, tooltip ? tooltip(node, m) : defaultTip(node));
        let left = r.right - hr.left + 8;
        if (left + 270 > hr.width) left = r.left - hr.left - 272;
        tip.style.left = `${Math.max(4, left)}px`;
        host.append(tip);
        tip.style.top = `${Math.min(Math.max(4, r.top - hr.top), hr.height - tip.offsetHeight - 4)}px`;
    }
    function defaultTip(node) {
        const c = node.dir ? null : m.changes.get(node.path);
        const tot = node.dir ? dirTotals.get(node.path) : c;
        const phase = m.match.phaseOf(node.path);
        const rows = [];
        if (c) rows.push(["Front", [...c.fronts.keys()].map((id) => h("span", { class: "tipfront" }, h("span", { class: `fdot f${(m.fronts.get(id)?.color ?? 5) + 1}` }), ` ${m.fronts.get(id)?.label ?? id}`))]);
        rows.push(["Change", tot && (tot.add || tot.del) ? fmtCounts(tot.add, tot.del) : c?.kind === "deleted" ? "Deleted" : "No changes"]);
        if (c?.lastAt) rows.push(["Last edit", relTime(c.lastAt, m.now)]);
        rows.push(["Plan", phase ? `${phase.title} (active)` : m.match.footprint(node.path) || (node.dir && m.match.touchesFootprint(node.path)) ? "In the plan" : "Outside the plan"]);
        rows.push(["Size", node.dir ? `${node.children.length} items` : `${node.lines} lines`]);
        return [h("div", { class: "p" }, node.dir ? `${node.path || m.repoName}/` : node.path), h("dl", {}, rows.map(([k, v]) => [h("dt", {}, k), h("dd", { class: "num" }, v)])), m.tipExtra?.(node, c) ?? null, h("div", { class: "hintk" }, node.dir ? "Double-click to zoom in" : "")];
    }

    host.addEventListener("mousemove", (e) => {
        if (e.target.closest(".tip, .addchat")) return;
        const el = e.target.closest(".tn.file") ?? e.target.closest(".tn");
        const p = el?.dataset.path ?? null;
        if (p === hoverPath) return;
        hoverPath = p;
        if (p === null) clearTip();
        else showTip(p);
        onHover?.(p, el);
    });
    host.addEventListener("mouseleave", () => {
        hoverPath = null;
        clearTip();
        onHover?.(null, null);
    });
    host.addEventListener("dblclick", (e) => {
        const el = e.target.closest(".tn.dir");
        if (el) onZoom?.(el.dataset.path);
    });

    new ResizeObserver(() => m && render(m)).observe(host);
    return { render, get hoverPath() { return hoverPath; }, elFor: (p) => host.querySelector(`.tn[data-path="${CSS.escape(p)}"]`) };
}
