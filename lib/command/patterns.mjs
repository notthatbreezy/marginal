// Path patterns ("expects") shared by the server and the browser (served to the page as /command/patterns.js).
// Pure: no Node or DOM imports.

/** Normalize a repo-relative POSIX path, or return null with a reason. */
export function normalizeRepoPath(raw) {
    if (typeof raw !== "string") return { error: "type", message: "expected a string path" };
    let p = raw.trim();
    if (!p) return { error: "required", message: "path is empty" };
    if (p.includes("\\")) return { error: "format", message: "use forward slashes", hint: p.replace(/\\/g, "/") };
    if (/^[a-z]:/i.test(p) || p.startsWith("/")) return { error: "path_outside_repo", message: "paths are repository-relative" };
    const trailing = p.endsWith("/");
    p = p.replace(/\/+/g, "/").replace(/\/$/, "");
    if (p.startsWith("./")) p = p.slice(2);
    const parts = p.split("/");
    if (parts.some((s) => s === "..")) return { error: "path_outside_repo", message: "'..' is not allowed" };
    if (parts.some((s) => s === "." || s === "")) return { error: "format", message: "path has an empty or '.' segment" };
    if (/[\u0000-\u001f]/.test(p)) return { error: "format", message: "control characters are not allowed" };
    return { path: p, trailing };
}

const GLOB_CHARS = /[*?[{]/;

/**
 * Whether a change event still describes a live difference from base. Zero-line added/renamed/untracked/deleted
 * files are real changes; a zero-total "modified" event is a revert-to-base marker that clears the file.
 */
export const isPresentChange = (e) => !!(e.totals.add || e.totals.del || e.binary || e.kind !== "modified");

/**
 * Classify one agent-supplied `expects` string.
 * isTree(path) tells whether a path is a directory in the repository (optional).
 */
export function classifyPattern(raw, isTree = () => false) {
    if (typeof raw === "string" && GLOB_CHARS.test(raw)) {
        // Same lexical contract as plain paths (drive/leading slash/backslash/../control chars rejected, // collapsed).
        const n = normalizeRepoPath(raw);
        if (n.error) return n;
        const g = n.path;
        try {
            globToRegExp(g);
        } catch (e) {
            return { error: "format", message: `invalid glob: ${e.message}` };
        }
        return { pattern: { kind: "glob", glob: g } };
    }
    const n = normalizeRepoPath(raw);
    if (n.error) return n;
    if (n.trailing || isTree(n.path)) return { pattern: { kind: "dir", path: n.path } };
    return { pattern: { kind: "file", path: n.path } };
}

/** Minimatch-style glob → RegExp: ** crosses directories, * and ? stay within one, {a,b} and [..] as usual. */
export function globToRegExp(glob) {
    let re = "";
    let depth = 0;
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                const slash = glob[i + 2] === "/";
                re += slash ? "(?:.*/)?" : ".*";
                i += slash ? 2 : 1;
            } else re += "[^/]*";
        } else if (c === "?") re += "[^/]";
        else if (c === "{") {
            depth++;
            re += "(?:";
        } else if (c === "}" && depth) {
            depth--;
            re += ")";
        } else if (c === "," && depth) re += "|";
        else if (c === "[") {
            const end = glob.indexOf("]", i + 1);
            if (end < 0) throw new Error("unclosed [");
            let body = glob.slice(i + 1, end);
            if (body.startsWith("!")) body = "^" + body.slice(1);
            re += `[${body.replace(/\\/g, "\\\\")}]`;
            i = end;
        } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
    }
    if (depth) throw new Error("unclosed {");
    return new RegExp(`^${re}$`);
}

/** Compile patterns into a predicate over repo paths. */
export function compilePatterns(patterns) {
    const files = new Set();
    const dirs = [];
    const globs = [];
    for (const p of patterns ?? []) {
        if (p.kind === "file") files.add(p.path);
        else if (p.kind === "dir") dirs.push(p.path);
        else if (p.kind === "glob") globs.push(globToRegExp(p.glob));
    }
    return (path) => files.has(path) || dirs.some((d) => path === d || path.startsWith(`${d}/`)) || globs.some((g) => g.test(path));
}

/** Does a pattern set touch anything under `dir` (for footprint outlines on directory tiles)? */
export function patternsTouchDir(patterns, dir) {
    const pre = dir ? `${dir}/` : "";
    for (const p of patterns ?? []) {
        if (p.kind === "file" && (!dir || p.path.startsWith(pre))) return true;
        if (p.kind === "dir" && (!dir || p.path === dir || p.path.startsWith(pre) || dir.startsWith(`${p.path}/`))) return true;
        if (p.kind === "glob") {
            const lit = p.glob.split(/[*?[{]/)[0];
            if (!dir || lit.startsWith(pre) || pre.startsWith(lit) || lit === "") return true;
        }
    }
    return false;
}

/** Every pattern in a plan (phases + steps). */
export function planPatterns(plan) {
    if (!plan) return [];
    return plan.phases.flatMap((ph) => [...ph.expects, ...ph.steps.flatMap((s) => s.expects)]);
}

/** Patterns of one phase including its steps. */
export const phasePatterns = (ph) => [...ph.expects, ...ph.steps.flatMap((s) => s.expects)];

/**
 * Off-plan test for one front: a file is off-plan if it matches none of the patterns associated with the front
 * (active phases listing it, plus steps it is working on); with no association, the whole plan footprint is used.
 */
export function offPlanMatcher(plan, frontId) {
    if (!plan) return () => false;
    const assoc = [];
    for (const ph of plan.phases) {
        if (ph.state.status === "active" && ph.state.frontIds.includes(frontId)) assoc.push(...phasePatterns(ph));
        for (const st of ph.steps) if (st.state.status === "active" && st.state.frontId === frontId) assoc.push(...st.expects);
    }
    const match = compilePatterns(assoc.length ? assoc : planPatterns(plan));
    return (path) => !match(path);
}

/** Active phases whose scope matches the path. */
export function matchingActivePhases(plan, path) {
    if (!plan) return [];
    return plan.phases.filter((ph) => ph.state.status === "active" && compilePatterns(phasePatterns(ph))(path)).map((ph) => ph.id);
}

// ---------- persisted UI prefs (prefs.json is written by any panel: parse it at the boundary) ----------
const MODES = ["diff-feed", "files"];
const cleanPath = (p) => (typeof p === "string" && !/[*?[{]/.test(p) ? (p === "" ? "" : normalizeRepoPath(p).path ?? null) : null);
const isId = (x) => typeof x === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(x);

/** Layout → { root: string|null, pins: string[], monitors: {path, mode}[], filters } with invalid parts dropped. */
export function parseLayout(v) {
    const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    const root = o.root === null || o.root === undefined ? null : cleanPath(o.root);
    const pins = (Array.isArray(o.pins) ? o.pins : []).map((p) => cleanPath(typeof p === "string" ? p : p?.path)).filter((p) => p !== null && p !== "");
    const monitors = (Array.isArray(o.monitors) ? o.monitors : [])
        .map((m) => ({ path: cleanPath(m?.path), mode: MODES.includes(m?.mode) ? m.mode : "diff-feed" }))
        .filter((m) => m.path !== null)
        .slice(0, 4);
    const f = o.filters && typeof o.filters === "object" ? o.filters : {};
    const filters = {};
    if (f.hideTests === true) filters.hideTests = true;
    if (f.offPlanOnly === true) filters.offPlanOnly = true;
    if (Array.isArray(f.frontIds)) filters.frontIds = f.frontIds.filter(isId);
    if (Number.isInteger(f.minChurn) && f.minChurn > 0) filters.minChurn = f.minChurn;
    return { root, pins: [...new Set(pins)].slice(0, 12), monitors, filters };
}

/** Prefs → a valid shape; unknown keys are dropped, bad values fall back to defaults. */
export function parsePrefs(v) {
    const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    const str = (x) => (typeof x === "string" && x.length <= 200 ? x : null);
    const out = { follow: o.follow !== false };
    if (o.layout != null) out.layout = parseLayout(o.layout);
    out.viewId = str(o.viewId);
    out.appliedPhase = str(o.appliedPhase);
    out.adjustedSince = str(o.adjustedSince);
    out.adjustedPhase = str(o.adjustedPhase);
    if (Number.isInteger(o.appliedApplySeq) && o.appliedApplySeq >= 0) out.appliedApplySeq = o.appliedApplySeq;
    out.savedViews = (Array.isArray(o.savedViews) ? o.savedViews : [])
        .filter((sv) => sv && isId(sv.id))
        .slice(0, 20)
        .map((sv) => {
            const L = parseLayout(sv);
            return { id: sv.id, title: str(sv.title) ?? sv.id, root: L.root, pins: L.pins.map((path) => ({ path })), monitors: L.monitors, filters: L.filters };
        });
    if (o.focus && typeof o.focus === "object" && Array.isArray(o.focus.items)) out.focus = { items: o.focus.items.slice(0, 40), ...(str(o.focus.replayAt) ? { replayAt: o.focus.replayAt } : {}) };
    if (o.walkthroughStop && isId(o.walkthroughStop.id) && isId(o.walkthroughStop.stopId)) out.walkthroughStop = { id: o.walkthroughStop.id, stopId: o.walkthroughStop.stopId, revision: Number(o.walkthroughStop.revision) || 0 };
    return out;
}