// The chat window's place on screen, shared by every panel and browser window (one position and size for all tabs
// and docs), plus which panels have the chat open. Kept in <data>/ui.json: a panel's origin changes on every reload,
// so browser storage wouldn't last.
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson, paths } from "./paths.mjs";

const OPEN_MAX = 100;
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null);

/** {box: {x, y, w, h} | null, open: {[instanceId]: true}} — anything malformed is dropped. */
export function parseUi(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const b = r.box && typeof r.box === "object" ? r.box : null;
    const box = b && [b.x, b.y, b.w, b.h].every((v) => typeof v === "number" && Number.isFinite(v)) ? { x: num(b.x, -10000, 10000), y: num(b.y, -10000, 10000), w: num(b.w, 200, 4000), h: num(b.h, 80, 4000) } : null;
    const open = {};
    if (r.open && typeof r.open === "object") for (const [k, v] of Object.entries(r.open).slice(-OPEN_MAX)) if (v === true && typeof k === "string" && k.length <= 120) open[k] = true;
    return { box, open };
}
export function readUi() {
    try {
        return existsSync(paths.ui) ? parseUi(JSON.parse(readFileSync(paths.ui, "utf8"))) : parseUi({});
    } catch {
        return parseUi({});
    }
}
/** patch: {box?, instance?, open?: boolean} */
export function writeUi(patch) {
    const cur = readUi();
    const p = patch && typeof patch === "object" ? patch : {};
    const next = { box: p.box !== undefined ? parseUi({ box: p.box }).box ?? cur.box : cur.box, open: { ...cur.open } };
    if (typeof p.instance === "string" && typeof p.open === "boolean") {
        delete next.open[p.instance];
        if (p.open) next.open[p.instance] = true;
    }
    const clean = parseUi(next);
    atomicWriteJson(paths.ui, clean);
    return clean;
}
