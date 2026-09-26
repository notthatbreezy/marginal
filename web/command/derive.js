// Command tab: pure derivations from the change-event log (no DOM). Live view and replay share these by passing `at`.

/** Mirror of lib/command/patterns.mjs isPresentChange (kept in lockstep by test/command.web.test.mjs). */
export const isPresentChange = (e) => !!(e.totals.add || e.totals.del || e.binary || e.kind !== "modified");

/** Per-file change state as of `at` (ms): Map(path → { fronts: Map(id → {add, del, kind, lastAt}), add, del, lastAt, kind, lead }) */
export function changesAt(events, at = Infinity) {
    const perFront = new Map(); // `${front}\0${file}` → event
    for (const e of events) {
        if (Date.parse(e.at) > at) break; // events are seq-ordered == time-ordered
        perFront.set(`${e.frontId}\0${e.file}`, e);
    }
    const files = new Map();
    for (const e of perFront.values()) {
        if (!isPresentChange(e)) continue;
        let f = files.get(e.file);
        if (!f) files.set(e.file, (f = { fronts: new Map(), add: 0, del: 0, lastAt: 0, kind: e.kind, previousPath: e.previousPath }));
        const t = Date.parse(e.at);
        // A baseline or initial observation is "as found", not a live edit.
        const lastAt = e.initial || e.baseline ? 0 : t;
        f.fronts.set(e.frontId, { add: e.totals.add, del: e.totals.del, kind: e.kind, lastAt, offPlan: e.offPlan });
        f.add += e.totals.add;
        f.del += e.totals.del;
        if (lastAt >= f.lastAt) {
            f.lastAt = lastAt;
            f.kind = e.kind;
        }
    }
    for (const f of files.values()) {
        let best = null;
        for (const [id, v] of f.fronts) if (!best || v.add + v.del > best[1]) best = [id, v.add + v.del];
        f.lead = best?.[0];
    }
    return files;
}

/** Auto velocity window by session age. Returns { bucketMs, spanMs, label }. */
export function autoWindow(ageMs) {
    const m = 60_000;
    if (ageMs < 10 * m) return { bucketMs: m, spanMs: 10 * m, label: "1m" };
    if (ageMs < 60 * m) return { bucketMs: 5 * m, spanMs: 60 * m, label: "5m" };
    if (ageMs < 6 * 60 * m) return { bucketMs: 15 * m, spanMs: 6 * 60 * m, label: "15m" };
    return { bucketMs: 60 * m, spanMs: 24 * 60 * m, label: "1h" };
}
export const WINDOW_CHOICES = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

/**
 * Velocity over the trailing bucket ending at `at`: churn (add+del) per minute, net per minute, distinct files/min,
 * change events/min. Initial and baseline observations never count.
 */
export function velocity(events, { at = Date.now(), windowKey = "auto", startedAt } = {}) {
    const first = startedAt ?? (events.find((e) => !e.initial && !e.baseline) ? Date.parse(events.find((e) => !e.initial && !e.baseline).at) : at);
    const auto = autoWindow(Math.max(0, at - first));
    const bucketMs = windowKey === "auto" ? auto.bucketMs : windowKey === "all" ? Math.max(60_000, at - first) : WINDOW_CHOICES[windowKey];
    const from = at - bucketMs;
    let churn = 0;
    let net = 0;
    let n = 0;
    const files = new Set();
    for (const e of events) {
        if (e.initial || e.baseline) continue;
        const t = Date.parse(e.at);
        if (t <= from || t > at) continue;
        churn += e.delta.add + e.delta.del;
        net += e.netDelta ?? 0;
        files.add(e.file);
        n++;
    }
    const mins = bucketMs / 60_000;
    const r = (x) => (Math.abs(x) >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
    return { churn: r(churn / mins), net: r(net / mins), files: r(files.size / mins), events: r(n / mins), label: windowKey === "auto" ? `auto · ${auto.label}` : windowKey, bucketMs, auto };
}

/** Churn per front per bucket over [from, to] — sparklines and the timeline histogram. */
export function buckets(events, { from, to, count }) {
    const width = Math.max(1, (to - from) / count);
    const out = new Map(); // frontId → number[count]
    for (const e of events) {
        if (e.initial || e.baseline) continue;
        const t = Date.parse(e.at);
        if (t < from || t > to) continue;
        const i = Math.min(count - 1, Math.floor((t - from) / width));
        if (!out.has(e.frontId)) out.set(e.frontId, new Array(count).fill(0));
        out.get(e.frontId)[i] += e.delta.add + e.delta.del;
    }
    return out;
}

/** Log-scaled heat step (fill intensity %) for a churn total. */
export function heatOf(churn) {
    return churn > 150 ? 30 : churn > 60 ? 22 : churn > 20 ? 14 : 8;
}

export function relTime(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
