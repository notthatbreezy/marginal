// Structured validation issues for Command actions: collect everything in one pass, apply nothing on failure.

export const ISSUE_CODES = [
    "required",
    "type",
    "enum",
    "format",
    "too_many",
    "too_few",
    "duplicate_id",
    "unknown_id",
    "stale_revision",
    "path_outside_repo",
    "path_not_in_diff",
    "range_out_of_bounds",
    "worktree_not_repo",
    "worktree_other_repo",
    "duplicate_worktree",
    "ref_unresolvable",
    "empty_diff",
    "not_owner",
];

const CAP = 50;

export class Issues {
    constructor() {
        this.list = [];
        this.truncated = false;
    }
    add(path, code, message, hint) {
        if (!ISSUE_CODES.includes(code)) throw new Error(`unknown issue code ${code}`);
        if (this.list.length >= CAP) {
            this.truncated = true;
            return;
        }
        this.list.push(hint ? { path, code, message, hint } : { path, code, message });
    }
    get ok() {
        return this.list.length === 0;
    }
    get full() {
        return this.list.length >= CAP;
    }
    /** The action result for a rejected payload. */
    result() {
        return { ok: false, issues: this.list, ...(this.truncated ? { note: `showing the first ${CAP} issues` } : {}) };
    }
}

export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Levenshtein distance (small inputs only). */
export function distance(a, b) {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

/** Nearest repo path: basename distance first, then whole-path distance. */
export function nearestPath(target, candidates) {
    const base = (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    const tb = base(target);
    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
        const score = distance(tb, base(c)) * 1000 + distance(target.toLowerCase(), c.toLowerCase());
        if (score < bestScore) [best, bestScore] = [c, score];
    }
    // Only suggest plausible matches.
    return best && distance(tb, base(best)) <= Math.max(2, Math.floor(tb.length / 3)) ? best : null;
}

export const listHint = (label, ids) => (ids.length ? `valid ${label}: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ", …" : ""}` : `no ${label} exist yet`);
