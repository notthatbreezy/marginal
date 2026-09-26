// Command domain parsers: agent input → domain values, collecting every issue in one pass.
// Parse once here; everything downstream trusts the returned shapes.
import { classifyPattern, normalizeRepoPath } from "./patterns.mjs";
import { ID_RE, listHint } from "./issues.mjs";

export const LIMITS = { phases: 20, steps: 200, patterns: 2000, fronts: 16, stops: 40, rangesPerStop: 8, linesPerRange: 400, views: 50, monitors: 4, pins: 12 };
export const FRONT_STATUS = ["active", "blocked", "done"];
export const PHASE_STATUS = ["pending", "active", "done"];
export const MISSION_STATUS = ["working", "awaiting_operator", "complete"];
export const FRONT_COLORS = 6; // palette size; colors resolved in CSS from tokens

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Tiny field reader that records issues instead of throwing. */
export class Reader {
    constructor(issues) {
        this.issues = issues;
    }
    obj(v, path, allowed) {
        if (!isObj(v)) {
            this.issues.add(path, v === undefined ? "required" : "type", v === undefined ? "is required" : "expected an object");
            return null;
        }
        if (allowed)
            for (const k of Object.keys(v)) if (!allowed.includes(k)) this.issues.add(`${path}.${k}`, "type", `unknown field "${k}"`, `allowed: ${allowed.join(", ")}`);
        return v;
    }
    str(v, path, { required = true, max = 400 } = {}) {
        if (v === undefined || v === null) {
            if (required) this.issues.add(path, "required", "is required");
            return undefined;
        }
        if (typeof v !== "string") return void this.issues.add(path, "type", "expected a string");
        const t = v.trim();
        if (required && !t) return void this.issues.add(path, "required", "must not be empty");
        if (t.length > max) return void this.issues.add(path, "too_many", `longer than ${max} characters`);
        return t;
    }
    id(v, path) {
        const s = this.str(v, path, { max: 64 });
        if (s === undefined) return undefined;
        if (!ID_RE.test(s)) return void this.issues.add(path, "format", "ids are 1-64 of [A-Za-z0-9._-], starting alphanumeric", `e.g. "${s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "p1"}"`);
        return s;
    }
    enumOf(v, path, values, { required = true } = {}) {
        if (v === undefined) {
            if (required) this.issues.add(path, "required", "is required", `one of: ${values.join(", ")}`);
            return undefined;
        }
        if (!values.includes(v)) return void this.issues.add(path, "enum", `unexpected value ${JSON.stringify(v)}`, `one of: ${values.join(", ")}`);
        return v;
    }
    arr(v, path, { min = 0, max = Infinity, required = true } = {}) {
        if (v === undefined) {
            if (required) this.issues.add(path, "required", "is required");
            return required ? null : [];
        }
        if (!Array.isArray(v)) return void this.issues.add(path, "type", "expected an array");
        if (v.length < min) this.issues.add(path, "too_few", `needs at least ${min}`);
        if (v.length > max) this.issues.add(path, "too_many", `allows at most ${max}`, `you sent ${v.length}`);
        return v.slice(0, Number.isFinite(max) ? max : undefined);
    }
    bool(v, path) {
        if (v === undefined) return undefined;
        if (typeof v !== "boolean") return void this.issues.add(path, "type", "expected true or false");
        return v;
    }
    int(v, path, { min = -Infinity, max = Infinity, required = true } = {}) {
        if (v === undefined) {
            if (required) this.issues.add(path, "required", "is required");
            return undefined;
        }
        if (!Number.isInteger(v)) return void this.issues.add(path, "type", "expected an integer");
        if (v < min || v > max) return void this.issues.add(path, "range_out_of_bounds", `must be between ${min} and ${max}`);
        return v;
    }
}

function parseExpects(r, v, path, ctx, counter) {
    const list = r.arr(v, path, { required: false, max: LIMITS.patterns });
    const out = [];
    (list ?? []).forEach((raw, i) => {
        const c = classifyPattern(raw, ctx.isTree);
        if (c.error) r.issues.add(`${path}[${i}]`, c.error, c.message, c.hint);
        else out.push(c.pattern);
    });
    counter.n += out.length;
    return out;
}

/** Views address concrete subtrees (a directory or file), never globs: the map zooms, pins and monitors by prefix. */
function viewPath(raw) {
    if (typeof raw === "string" && /[*?[{]/.test(raw)) return { error: "format", message: "views take a directory or file path, not a glob", hint: raw.split(/[*?[{]/)[0].replace(/\/[^/]*$/, "") || undefined };
    return normalizeRepoPath(raw);
}

/** A carried-forward phase state must still be legal: "done" needs an attributable checkpoint (pre-fix states may not). */
function carryPhaseState(s) {
    if (!s) return { status: "pending" };
    if (s.status === "done" && !(s.checkpoint?.sha && s.checkpoint.frontId)) return s.frontIds?.length ? { status: "active", since: s.since, frontIds: s.frontIds } : { status: "pending" };
    return s;
}

/** ViewSpec (agent- or user-supplied layout). */
export function parseViewSpec(r, v, path) {
    const o = r.obj(v, path, ["id", "title", "root", "pins", "monitors", "filters"]);
    if (!o) return null;
    const view = { id: r.id(o.id, `${path}.id`), title: r.str(o.title, `${path}.title`, { max: 120 }) };
    if (o.root !== undefined && o.root !== "") {
        const n = normalizeRepoPath(o.root);
        if (n.error) r.issues.add(`${path}.root`, n.error, n.message, n.hint);
        else view.root = n.path;
    }
    const pins = r.arr(o.pins, `${path}.pins`, { required: false, max: LIMITS.pins });
    if (pins?.length)
        view.pins = pins
            .map((p, i) => {
                const po = r.obj(typeof p === "string" ? { path: p } : p, `${path}.pins[${i}]`, ["path", "weight"]);
                if (!po) return null;
                const n = viewPath(po.path);
                if (n.error) return void r.issues.add(`${path}.pins[${i}].path`, n.error, n.message, n.hint);
                return { path: n.path };
            })
            .filter(Boolean);
    const mons = r.arr(o.monitors, `${path}.monitors`, { required: false, max: LIMITS.monitors });
    if (mons?.length)
        view.monitors = mons
            .map((m, i) => {
                const mo = r.obj(typeof m === "string" ? { path: m } : m, `${path}.monitors[${i}]`, ["path", "title", "mode"]);
                if (!mo) return null;
                const n = viewPath(mo.path);
                if (n.error) return void r.issues.add(`${path}.monitors[${i}].path`, n.error, n.message, n.hint);
                const mode = r.enumOf(mo.mode ?? "diff-feed", `${path}.monitors[${i}].mode`, ["diff-feed", "files"]);
                return { path: n.path, title: r.str(mo.title, `${path}.monitors[${i}].title`, { required: false, max: 80 }), mode };
            })
            .filter(Boolean);
    if (o.filters !== undefined) {
        const f = r.obj(o.filters, `${path}.filters`, ["hideTests", "offPlanOnly", "frontIds", "minChurn"]);
        if (f)
            view.filters = {
                hideTests: r.bool(f.hideTests, `${path}.filters.hideTests`),
                offPlanOnly: r.bool(f.offPlanOnly, `${path}.filters.offPlanOnly`),
                frontIds: f.frontIds === undefined ? undefined : (r.arr(f.frontIds, `${path}.filters.frontIds`) ?? []).map((x, i) => r.id(x, `${path}.filters.frontIds[${i}]`)).filter(Boolean),
                minChurn: r.int(f.minChurn, `${path}.filters.minChurn`, { required: false, min: 0 }),
            };
    }
    return view;
}

/**
 * Plan input → Plan. ctx: { isTree(path), resolveBase(ref) → sha|null (async resolved beforehand), previous?: Plan }
 * States of phases/steps whose ids survive a re-`set` are preserved; new ones start pending.
 */
export function parsePlan(issues, input, ctx) {
    const r = new Reader(issues);
    const o = r.obj(input, "plan", ["id", "title", "base", "phases"]);
    if (!o) return null;
    const plan = { id: r.id(o.id, "plan.id"), title: r.str(o.title, "plan.title", { max: 160 }), base: ctx.base, phases: [] };
    if (o.base !== undefined && !ctx.base) issues.add("plan.base", "ref_unresolvable", `cannot resolve ${JSON.stringify(o.base)} in the repository`, "use a branch, tag, or commit sha that exists locally");
    const counter = { n: 0 };
    const phaseIds = new Set();
    const stepIds = new Set();
    let stepCount = 0;
    const prevPhase = new Map((ctx.previous?.phases ?? []).map((p) => [p.id, p]));
    const prevStep = new Map((ctx.previous?.phases ?? []).flatMap((p) => p.steps).map((s) => [s.id, s]));
    const phases = r.arr(o.phases, "plan.phases", { min: 1, max: LIMITS.phases }) ?? [];
    phases.forEach((pv, pi) => {
        const pp = `plan.phases[${pi}]`;
        const po = r.obj(pv, pp, ["id", "title", "expects", "steps", "suggestedView"]);
        if (!po) return;
        const id = r.id(po.id, `${pp}.id`);
        if (id && phaseIds.has(id)) issues.add(`${pp}.id`, "duplicate_id", `phase id "${id}" is used twice`);
        if (id) phaseIds.add(id);
        const phase = { id, title: r.str(po.title, `${pp}.title`, { max: 160 }), expects: parseExpects(r, po.expects, `${pp}.expects`, ctx, counter), steps: [], state: carryPhaseState(prevPhase.get(id)?.state) };
        const steps = r.arr(po.steps, `${pp}.steps`, { required: false, max: LIMITS.steps }) ?? [];
        steps.forEach((sv, si) => {
            const sp = `${pp}.steps[${si}]`;
            stepCount++;
            const so = r.obj(sv, sp, ["id", "title", "expects"]);
            if (!so) return;
            const sid = r.id(so.id, `${sp}.id`);
            if (sid && stepIds.has(sid)) issues.add(`${sp}.id`, "duplicate_id", `step id "${sid}" is used twice`);
            if (sid) stepIds.add(sid);
            phase.steps.push({ id: sid, title: r.str(so.title, `${sp}.title`, { max: 200 }), expects: parseExpects(r, so.expects, `${sp}.expects`, ctx, counter), state: prevStep.get(sid)?.state ?? { status: "pending" } });
        });
        if (po.suggestedView !== undefined) phase.suggestedView = parseViewSpec(r, po.suggestedView, `${pp}.suggestedView`);
        plan.phases.push(phase);
    });
    if (stepCount > LIMITS.steps) issues.add("plan.phases", "too_many", `at most ${LIMITS.steps} steps in total`, `you sent ${stepCount}`);
    if (counter.n > LIMITS.patterns) issues.add("plan.phases", "too_many", `at most ${LIMITS.patterns} expects patterns in total`, `you sent ${counter.n}; prefer directories or globs`);
    return plan;
}

export function findPhase(plan, id) {
    return plan?.phases.find((p) => p.id === id) ?? null;
}
export function findStep(plan, id) {
    for (const p of plan?.phases ?? []) {
        const s = p.steps.find((x) => x.id === id);
        if (s) return { phase: p, step: s };
    }
    return null;
}
export const phaseIdsHint = (plan) => listHint("phase ids", plan?.phases.map((p) => p.id) ?? []);
export const stepIdsHint = (plan) => listHint("step ids", plan?.phases.flatMap((p) => p.steps.map((s) => s.id)) ?? []);
export const frontIdsHint = (fronts) => listHint("front ids", fronts.map((f) => f.id));
