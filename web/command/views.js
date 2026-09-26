// Views & follow (spec §7.6), auto-root (§7.3), fisheye pins (§7.4, D7 fixed 3×), hunk rows (lazy).
import { api, h } from "../core.js";

export const PIN_WEIGHT = 3;
const USER_ZOOM_QUIET_MS = 5000;

/** Layout = what a view controls. */
export const emptyLayout = () => ({ root: null, pins: [], monitors: [], filters: {} });

export function layoutFromView(v) {
    return { root: v.root ?? null, pins: (v.pins ?? []).map((p) => p.path ?? p), monitors: (v.monitors ?? []).map((m) => ({ path: m.path, mode: m.mode ?? "diff-feed" })), filters: { ...(v.filters ?? {}) } };
}

export const sameLayout = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Deepest directory containing every path; "" for the repo root. */
export function commonDir(paths) {
    if (!paths.length) return "";
    let parts = paths[0].split("/").slice(0, -1);
    for (const p of paths.slice(1)) {
        const q = p.split("/");
        let i = 0;
        while (i < parts.length && i < q.length - 1 && parts[i] === q[i]) i++;
        parts = parts.slice(0, i);
    }
    return parts.join("/");
}

/**
 * Auto root: smallest subtree covering the footprint's concrete paths and every changed file.
 * Globs contribute their literal prefix. Never narrower than the tree allows.
 */
export function autoRoot(plan, changedPaths) {
    const concrete = [];
    for (const ph of plan?.phases ?? [])
        for (const p of [...ph.expects, ...ph.steps.flatMap((s) => s.expects)]) {
            if (p.kind === "glob") concrete.push(`${p.glob.split(/[*?[{]/)[0].replace(/\/[^/]*$/, "")}/x`);
            else concrete.push(p.kind === "dir" ? `${p.path}/x` : p.path);
        }
    return commonDir([...concrete, ...changedPaths]);
}

/** Views offered in the picker: agent (✦) and user views, plus phase suggestions and "Auto". */
export function viewChoices(state, prefs) {
    const out = [];
    for (const p of state.plan?.phases ?? []) if (p.suggestedView) out.push({ ...p.suggestedView, origin: "agent", phaseId: p.id });
    for (const v of state.views ?? []) if (!out.some((o) => o.id === v.id)) out.push(v);
    for (const v of prefs.savedViews ?? []) out.push({ ...v, origin: "user" });
    return out;
}

/**
 * Follow logic. Given the active phase with a suggestion, decide whether to (auto-)apply it.
 * prefs.follow (bool), prefs.appliedPhase, prefs.adjustedSince (the user touched the layout after the last apply).
 */
export function followDecision({ state, prefs }) {
    const active = (state.plan?.phases ?? []).filter((p) => p.state.status === "active" && p.suggestedView);
    const target = active.at(-1);
    if (!target || prefs.follow === false) return null;
    // A user adjustment holds the phase it was made in (appliedPhase === target → no re-apply, "Return to suggested"
    // is offered instead). A *new* phase applies its view again; "zoomed just now" is the caller's quiet-window check.
    if (prefs.appliedPhase === target.id) return null;
    return target;
}

export const quietSinceZoom = (t, now = Date.now()) => !t || now - t > USER_ZOOM_QUIET_MS;

// ---------- hunk rows ----------
const hunkCache = new Map(); // `${doc}\0${front}\0${file}\0${totals}` → rows | Promise

export function hunkRows(docId, frontId, file, totalsKey, onReady) {
    const key = `${docId}\0${frontId}\0${file}\0${totalsKey}`;
    const hit = hunkCache.get(key);
    if (Array.isArray(hit)) return hit;
    if (!hit) {
        const p = api(`/command/hunks?doc=${encodeURIComponent(docId)}&front=${encodeURIComponent(frontId)}&file=${encodeURIComponent(file)}`)
            .then((r) => {
                hunkCache.set(key, r.rows);
                onReady?.();
            })
            .catch(() => hunkCache.set(key, []));
        hunkCache.set(key, p);
        if (hunkCache.size > 500) hunkCache.delete(hunkCache.keys().next().value);
    }
    return null;
}

export function hunkList(rows) {
    return h(
        "div",
        { class: "hunks" },
        rows.slice(0, 12).map((r) =>
            h(
                "div",
                { class: "hk", title: `${r.label}  +${r.add} −${r.del}${r.hunks > 1 ? ` (${r.hunks} hunks)` : ""}` },
                h("span", { class: "fn" }, r.label),
                h("span", { class: "ct" }, r.add ? h("span", { class: "add" }, `+${r.add}`) : null, r.add && r.del ? " " : null, r.del ? h("span", { class: "del" }, `−${r.del}`) : null),
            ),
        ),
    );
}
