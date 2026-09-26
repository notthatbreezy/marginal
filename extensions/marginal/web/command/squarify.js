// Squarified treemap (Bruls, Huizing, van Wijk) and the repo tree it lays out. Pure; unit-tested in Node.

/** Build a directory tree from [[path, lines]] plus changed paths not yet tracked (new files). */
export function buildTree(files, extra = new Map()) {
    const root = { name: "", path: "", dir: true, children: [], depth: 0, map: new Map() };
    const dirs = new Map([["", root]]);
    const add = (path, lines) => {
        const parts = path.split("/");
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const dp = parts.slice(0, i + 1).join("/");
            let d = dirs.get(dp);
            if (!d) {
                d = { name: parts[i], path: dp, dir: true, children: [], depth: i + 1 };
                dirs.set(dp, d);
                cur.children.push(d);
            }
            cur = d;
        }
        const leaf = { name: parts[parts.length - 1], path, dir: false, lines, depth: parts.length };
        cur.children.push(leaf);
        root.map.set(path, leaf);
    };
    for (const [p, n] of files) add(p, n);
    for (const [p, n] of extra) if (!root.map.has(p)) add(p, n);
    root.dirs = dirs;
    return root;
}

/** Assign weights bottom-up. Files weigh max(lines, 20) so tiny files stay visible; pins multiply their subtree. */
export function weigh(node, { pins = new Map(), minWeight = 20 } = {}) {
    const mult = (p) => {
        let m = 1;
        for (const [pin, w] of pins) if (p === pin || p.startsWith(`${pin}/`)) m = Math.max(m, w);
        return m;
    };
    const walk = (n) => {
        if (!n.dir) return (n.w = Math.max(n.lines || 0, minWeight) * mult(n.path));
        n.w = n.children.reduce((s, c) => s + walk(c), 0);
        return n.w;
    };
    return walk(node);
}

const worst = (row, side) => {
    let s = 0;
    let mx = 0;
    let mn = Infinity;
    for (const r of row) {
        s += r.area;
        if (r.area > mx) mx = r.area;
        if (r.area < mn) mn = r.area;
    }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
};

/** Lay out items ({value, …}) in the rectangle; returns items with x, y, w, h. Areas are proportional to value. */
export function squarify(items, x, y, w, h) {
    const total = items.reduce((t, i) => t + i.value, 0);
    if (!total || w <= 0 || h <= 0) return [];
    const scale = (w * h) / total;
    const rest = items.filter((i) => i.value > 0).map((i) => ({ ...i, area: i.value * scale })).sort((a, b) => b.area - a.area);
    const out = [];
    let row = [];
    const flush = () => {
        const s = row.reduce((t, r) => t + r.area, 0);
        if (w >= h) {
            const rw = s / h;
            let yy = y;
            for (const r of row) {
                const rh = r.area / rw;
                out.push({ ...r, x, y: yy, w: rw, h: rh });
                yy += rh;
            }
            x += rw;
            w -= rw;
        } else {
            const rh = s / w;
            let xx = x;
            for (const r of row) {
                const rw = r.area / rh;
                out.push({ ...r, x: xx, y, w: rw, h: rh });
                xx += rw;
            }
            y += rh;
            h -= rh;
        }
        row = [];
    };
    while (rest.length) {
        const side = Math.min(w, h);
        const c = rest[0];
        if (!row.length || worst(row.concat(c), side) <= worst(row, side)) {
            row.push(c);
            rest.shift();
        } else flush();
    }
    if (row.length) flush();
    return out;
}

export function findNode(root, path) {
    if (!path) return root;
    return root.dirs?.get(path) ?? root.map?.get(path) ?? null;
}
