// Checkpoint refs → commit pairs, command_diff (authoring aid), command_walkthrough (show / edit / close).
// Walkthroughs are pinned to one {base, head} commit pair; every range is validated against that diff so the panel
// never renders a stop it can't show. Rejections emit a "revising" SSE event so the pop-up can say so.
import { diffFiles, diffPatch, numberPatch, readFileAt } from "../git.mjs";
import { gitOut } from "./gitx.mjs";
import { Issues, listHint, nearestPath } from "./issues.mjs";
import { LIMITS, Reader, findPhase, frontIdsHint, phaseIdsHint } from "./model.mjs";
import { isOwner, readLease } from "./owner.mjs";
import { normalizeRepoPath } from "./patterns.mjs";
import { refFor, snapshotWorktree } from "./snapshot.mjs";
import { emitCommand, readPrefs, readState, writeState } from "./state.mjs";

export const CATEGORIES = ["feature", "refactor", "test", "fix", "risk", "chore"];
const now = () => new Date().toISOString();
const short = (sha) => sha.slice(0, 7);

function notOwner(docId) {
    const lease = readLease(docId);
    const issues = new Issues();
    if (lease?.live) issues.add("", "not_owner", `Command state is owned by session ${lease.sessionId}`, `call it from session ${lease.sessionId}`);
    else issues.add("", "not_owner", "no session owns this doc's Command state yet", `call command_plan {op:"set"} first; it claims the lease`);
    return issues.result();
}

async function verify(repoPath, ref) {
    if (typeof ref !== "string" || !ref.trim() || ref.startsWith("-")) return null;
    const out = await gitOut(repoPath, ["rev-parse", "--verify", "--quiet", `${ref.trim()}^{commit}`], { kind: "rev-parse" });
    return out ? out.trim() : null;
}

/**
 * CheckpointRef → { sha, label, live? }. Shapes: {phaseId} · {sha} · {ref:"base"} · {ref:"live", frontId} ·
 * {walkthrough:id} (where that walkthrough ended) · {ref:"reviewed"} (where the last one the user reviewed ended).
 * Live refs snapshot the front's worktree now (hidden commit; persisted under a ref only when `persistAs` is given).
 */
export async function resolveRef(r, v, path, { state, repo, docId } = {}) {
    const o = r.obj(v, path, ["phaseId", "sha", "ref", "frontId", "walkthrough"]);
    if (!o) return null;
    const issues = r.issues;
    const kinds = ["phaseId", "sha", "ref", "walkthrough"].filter((k) => o[k] !== undefined);
    if (kinds.length !== 1) {
        issues.add(path, "type", "give exactly one of phaseId, sha, walkthrough or ref", `e.g. {"phaseId":"p1"}, {"walkthrough":"p1-p2"}, {"ref":"reviewed"}, {"ref":"base"}, {"ref":"live","frontId":"runner"}`);
        return null;
    }
    if (o.walkthrough !== undefined) {
        const id = r.id(o.walkthrough, `${path}.walkthrough`);
        const w = id && state.walkthroughs.find((x) => x.id === id);
        if (id && !w) return void issues.add(`${path}.walkthrough`, "unknown_id", `no walkthrough "${id}"`, listHint("walkthrough ids", state.walkthroughs.map((x) => x.id)));
        return w ? { sha: w.pins.head, label: `after ${w.id}` } : null;
    }
    if (o.phaseId !== undefined) {
        const id = r.id(o.phaseId, `${path}.phaseId`);
        const ph = id && findPhase(state.plan, id);
        if (id && !ph) return void issues.add(`${path}.phaseId`, "unknown_id", `no phase "${id}"`, phaseIdsHint(state.plan));
        if (!ph) return null;
        if (ph.state.status !== "done" || !ph.state.checkpoint?.sha) return void issues.add(`${path}.phaseId`, "ref_unresolvable", `phase "${id}" has no checkpoint yet (it is ${ph.state.status})`, `mark it done first, or use {"ref":"live","frontId":…} for work in progress`);
        return { sha: ph.state.checkpoint.sha, label: id.toUpperCase() };
    }
    if (o.sha !== undefined) {
        const s = r.str(o.sha, `${path}.sha`, { max: 80 });
        const sha = s && (await verify(repo.path, s));
        if (s && !sha) issues.add(`${path}.sha`, "ref_unresolvable", `cannot resolve ${JSON.stringify(s)}`, "pass a commit sha or ref that exists in the repository");
        return sha ? { sha, label: short(sha) } : null;
    }
    const kind = r.enumOf(o.ref, `${path}.ref`, ["base", "live", "reviewed"]);
    if (kind === "reviewed") {
        const rv = Object.entries(docId ? (readPrefs(docId).reviewed ?? {}) : {}).sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
        if (!rv) return void issues.add(`${path}.ref`, "ref_unresolvable", "the user hasn't reviewed a walkthrough yet", 'use {"walkthrough":<id>} or {"phaseId":…} instead');
        return { sha: rv[1].head, label: `reviewed (${rv[0]})` };
    }
    if (kind === "base") {
        if (!state.plan?.base) return void issues.add(`${path}.ref`, "ref_unresolvable", "there is no plan base yet", `call command_plan {op:"set"} first`);
        return { sha: state.plan.base, label: "base" };
    }
    if (kind === "live") {
        const frontId = r.id(o.frontId, `${path}.frontId`);
        const front = frontId && state.fronts.find((f) => f.id === frontId);
        if (frontId && !front) return void issues.add(`${path}.frontId`, "unknown_id", `no front "${frontId}"`, frontIdsHint(state.fronts));
        if (!front) return null;
        try {
            // No ref yet: callers pin the commit (keepRef) only once their whole request has validated.
            if (!front.worktree) return void issues.add(`${path}.frontId`, "ref_unresolvable", `front "${frontId}" is still planned (no worktree)`);
            const snap = await snapshotWorktree(front.worktree, { message: `marginal live snapshot ${frontId}` });
            return { sha: snap.sha, label: `live · ${front.label}`, live: true };
        } catch (e) {
            return void issues.add(`${path}.frontId`, "ref_unresolvable", `could not snapshot ${front.worktree}: ${e.message}`);
        }
    }
    return null;
}

// ---------- command_diff ----------
export async function commandDiff(input, ctx) {
    const r = new Reader(new Issues());
    const state = readState(ctx.docId);
    const env = { state, repo: ctx.repo, docId: ctx.docId };
    const from = await resolveRef(r, input.from, "from", env);
    const to = await resolveRef(r, input.to, "to", env);
    const format = r.enumOf(input.format ?? "files", "format", ["files", "patch"]);
    const paths = (r.arr(input.paths, "paths", { required: false, max: 200 }) ?? []).map((p, i) => {
        const n = normalizeRepoPath(p);
        if (n.error) r.issues.add(`paths[${i}]`, n.error, n.message, n.hint);
        return n.path;
    });
    const context = r.int(input.context, "context", { required: false, min: 0, max: 50 }) ?? 3;
    const maxBytes = r.int(input.maxBytes, "maxBytes", { required: false, min: 1000, max: 400_000 }) ?? 60_000;
    if (!r.issues.ok) return r.issues.result();
    const repoId = ctx.doc.target.repositoryId;
    const pins = { base: from.sha, head: to.sha };
    const files = await diffFiles(repoId, pins.base, pins.head, paths.length ? paths : undefined);
    const out = { ok: true, from: { ...from }, to: { ...to }, pins, files: files.map((f) => ({ path: f.path, status: f.status, ...(f.previousPath ? { previousPath: f.previousPath } : {}), additions: f.additions, deletions: f.deletions, ...(f.binary ? { binary: true } : {}) })) };
    if (format === "patch") out.patch = numberPatch(await diffPatch(repoId, pins.base, pins.head, paths.length ? paths : undefined, { context }), maxBytes);
    out.summary = `${from.label} → ${to.label}: ${files.length} file${files.length === 1 ? "" : "s"}${files.length ? ` (+${files.reduce((n, f) => n + f.additions, 0)} −${files.reduce((n, f) => n + f.deletions, 0)})` : ", no changes"}`;
    return out;
}

// ---------- symbol anchors ----------
const KEYWORDS = "export|default|public|private|protected|internal|static|async|abstract|override|readonly|final|pub|fn|func|def|function|class|interface|type|enum|struct|trait|impl|const|let|var|val|record|module|namespace|resource|param|output|module|sub|method";
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Lines that declare `name`: after declaration keywords, as a method (`name(…) {`), or as a key/assignment. */
function declLines(lines, name, from = 0) {
    const n = escRe(name);
    const strong = new RegExp(`^\\s*(?:@\\w+\\s+)*(?:(?:${KEYWORDS})\\s+)+\\*?${n}\\b`);
    const weak = new RegExp(`^\\s*(?:async\\s+|static\\s+|get\\s+|set\\s+)*${n}\\s*(?:\\(|[:=](?!=))`);
    const hits = { strong: [], weak: [] };
    for (let i = from; i < lines.length; i++) {
        if (strong.test(lines[i])) hits.strong.push(i);
        else if (weak.test(lines[i])) hits.weak.push(i);
    }
    return hits.strong.length ? hits.strong : hits.weak;
}
/** The end of the declaration starting at line i: its matching brace, else its indented body, else the line. */
function declEnd(lines, i) {
    let depth = 0;
    let opened = false;
    for (let k = i; k < Math.min(lines.length, i + 600); k++) {
        const s = lines[k].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$|#.*$/, "");
        for (const ch of s) {
            if (ch === "{" || ch === "(" || ch === "[") (depth++, ch === "{" && (opened = true));
            else if (ch === "}" || ch === ")" || ch === "]") depth--;
        }
        if (opened && depth <= 0) return k;
        if (!opened && k > i + 3 && depth <= 0) break;
    }
    // Indentation (Python, YAML): the lines after it that are blank or indented deeper.
    const ind = (l) => l.match(/^\s*/)[0].length;
    if (/:\s*(#.*)?$/.test(lines[i])) {
        let end = i;
        for (let k = i + 1; k < lines.length; k++) {
            if (!lines[k].trim()) continue;
            if (ind(lines[k]) <= ind(lines[i])) break;
            end = k;
        }
        return end;
    }
    return i;
}
/** Resolve {symbol} to lines: "name", or "Outer.name" / "Outer#name" to look inside Outer. Leading comments come along. */
export function resolveSymbol(lines, symbol) {
    const parts = String(symbol).split(/[.#:]+/).filter(Boolean);
    let from = 0;
    let to = lines.length - 1;
    for (const [k, name] of parts.entries()) {
        const hits = declLines(lines, name, from).filter((i) => i <= to);
        if (!hits.length) return null;
        const start = hits[0];
        const end = declEnd(lines, start);
        if (k < parts.length - 1) {
            from = start + 1;
            to = end;
            continue;
        }
        let top = start;
        while (top > 0 && top > start - 25 && /^\s*(\/\/|\/\*|\*|#(?!!)|""")/.test(lines[top - 1])) top--;
        return { startLine: top + 1, endLine: end + 1 };
    }
    return null;
}
/** Names declared in a file (for "did you mean" hints). */
function declaredNames(lines) {
    const re = new RegExp(`^\\s*(?:@\\w+\\s+)*(?:(?:${KEYWORDS})\\s+)+\\*?([A-Za-z_$][\\w$]*)`);
    return [...new Set(lines.map((l) => l.match(re)?.[1]).filter(Boolean))];
}

// ---------- walkthrough parsing ----------
/** Validates one stop against the walkthrough's diff. `diff` = { byPath: Map, paths: string[], lines(side, file) }. */
async function parseStop(r, v, path, diff, { partial = false } = {}) {
    const o = r.obj(v, path, ["id", "title", "explanation", "category", "ranges", "focus"]);
    if (!o) return null;
    const stop = {};
    if (!partial || o.id !== undefined) stop.id = r.id(o.id, `${path}.id`);
    if (!partial || o.title !== undefined) stop.title = r.str(o.title, `${path}.title`, { max: 200 });
    if (!partial || o.explanation !== undefined) stop.explanation = r.str(o.explanation, `${path}.explanation`, { max: 8000 });
    if (o.category !== undefined) stop.category = r.enumOf(o.category, `${path}.category`, CATEGORIES);
    if (!partial || o.ranges !== undefined) {
        const ranges = r.arr(o.ranges, `${path}.ranges`, { min: 1, max: LIMITS.rangesPerStop }) ?? [];
        stop.ranges = [];
        for (const [i, rv] of ranges.entries()) {
            const rp = `${path}.ranges[${i}]`;
            const ro = r.obj(rv, rp, ["file", "side", "startLine", "endLine", "symbol"]);
            if (!ro) continue;
            const n = normalizeRepoPath(ro.file);
            if (n.error) {
                r.issues.add(`${rp}.file`, n.error, n.message, n.hint);
                continue;
            }
            const side = r.enumOf(ro.side ?? "head", `${rp}.side`, ["head", "base"]);
            const entry = diff.byPath.get(n.path);
            // A symbol stands in for the line numbers: its declaration (and leading comments) on that side.
            let anchored = null;
            if (ro.symbol !== undefined && entry && side) {
                const sym = r.str(ro.symbol, `${rp}.symbol`, { max: 200 });
                const lines = sym ? await diff.text(side, side === "base" ? (entry.previousPath ?? n.path) : n.path) : null;
                anchored = lines && resolveSymbol(lines, sym);
                if (sym && lines && !anchored) {
                    const names = declaredNames(lines);
                    const near = names.filter((x) => x.toLowerCase().includes(sym.split(/[.#:]/).pop().toLowerCase().slice(0, 4)));
                    r.issues.add(`${rp}.symbol`, "ref_unresolvable", `no declaration named ${JSON.stringify(sym)} in ${n.path} (${side})`, listHint("declared there", (near.length ? near : names).slice(0, 15)) ?? "pass startLine/endLine instead");
                    continue;
                }
                if (anchored && anchored.endLine - anchored.startLine + 1 > LIMITS.linesPerRange) anchored.endLine = anchored.startLine + LIMITS.linesPerRange - 1;
            }
            const start = anchored ? anchored.startLine : r.int(ro.startLine, `${rp}.startLine`, { min: 1 });
            const end = anchored ? anchored.endLine : r.int(ro.endLine ?? ro.startLine, `${rp}.endLine`, { min: 1 });
            if (!entry) {
                const near = nearestPath(n.path, diff.paths);
                r.issues.add(`${rp}.file`, "path_not_in_diff", `${n.path} is not changed between the walkthrough's checkpoints`, near ? `did you mean "${near}"?` : listHint("changed files", diff.paths));
                continue;
            }
            if (start === undefined || end === undefined || !side) continue;
            if (end < start) {
                r.issues.add(`${rp}.endLine`, "range_out_of_bounds", `endLine ${end} is before startLine ${start}`);
                continue;
            }
            if (end - start + 1 > LIMITS.linesPerRange) r.issues.add(`${rp}`, "too_many", `at most ${LIMITS.linesPerRange} lines per range`, `split it; this one spans ${end - start + 1}`);
            const file = side === "base" ? (entry.previousPath ?? n.path) : n.path;
            if (side === "head" && entry.status === "deleted") r.issues.add(`${rp}.side`, "range_out_of_bounds", `${n.path} is deleted at the head checkpoint`, `use side:"base"`);
            else if (side === "base" && entry.status === "added") r.issues.add(`${rp}.side`, "range_out_of_bounds", `${n.path} does not exist at the base checkpoint`, `use side:"head"`);
            else {
                const count = await diff.lines(side, file);
                if (end > count) r.issues.add(`${rp}.endLine`, "range_out_of_bounds", `${n.path} has ${count} lines on the ${side} side`, `use a range within 1–${count}`);
            }
            // `file` is the diff's (head) path used by the map; `sourceFile` is what exists on that side (renames).
            stop.ranges.push({ file: n.path, ...(file !== n.path ? { sourceFile: file } : {}), side, startLine: start, endLine: end });
            // Allowed, but worth a word: a range that shows none of the change in its file.
            const hunks = await diff.hunks(n.path, side);
            if (hunks.length && !hunks.some((hk) => hk.start <= end && hk.end >= start)) {
                const near = [...hunks].sort((a, b) => Math.min(Math.abs(a.start - end), Math.abs(a.end - start)) - Math.min(Math.abs(b.start - end), Math.abs(b.end - start)))[0];
                diff.notes.push(`${rp} (${n.path}:${start}–${end}) shows none of that file's changes on the ${side} side; nearest change: lines ${near.start}–${near.end}${hunks.length > 1 ? ` (all: ${hunks.slice(0, 8).map((hk) => (hk.start === hk.end ? hk.start : `${hk.start}–${hk.end}`)).join(", ")})` : ""}`);
            }
            if (anchored) diff.notes.push(`${rp}: ${JSON.stringify(ro.symbol)} → lines ${start}–${end}`);
        }
    }
    if (o.focus !== undefined) {
        const n = normalizeRepoPath(o.focus);
        if (n.error) r.issues.add(`${path}.focus`, n.error, n.message, n.hint);
        else stop.focus = n.path;
    }
    return stop;
}

async function diffIndex(repoId, pins) {
    const files = await diffFiles(repoId, pins.base, pins.head);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const cache = new Map();
    const hunkCache = new Map();
    const text = async (side, file) => {
        const k = `${side}\0${file}`;
        if (!cache.has(k)) cache.set(k, (await readFileAt(repoId, side === "base" ? pins.base : pins.head, file)).lines ?? []);
        return cache.get(k);
    };
    return {
        files,
        byPath,
        paths: files.map((f) => f.path),
        notes: [],
        text,
        async lines(side, file) {
            return (await text(side, file)).length;
        },
        /** Changed line spans of a file on one side ({start, end}, 1-based; a pure deletion marks where it was). */
        async hunks(file, side) {
            const k = `${side}\0${file}`;
            if (!hunkCache.has(k)) {
                const patch = await diffPatch(repoId, pins.base, pins.head, [file], { context: 0 }).catch(() => "");
                const out = [];
                for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
                    const [s, n] = side === "base" ? [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])] : [Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
                    out.push({ start: Math.max(1, s), end: Math.max(1, s + Math.max(n, 1) - 1) });
                }
                hunkCache.set(k, out);
            }
            return hunkCache.get(k);
        },
    };
}

/** Walkthrough view sequence: monotonic per document, even across close (a nullable view can't carry it). */
function nextViewSeq(s) {
    s.walkthroughSeq = Math.max(s.walkthroughSeq ?? 0, s.walkthroughView?.seq ?? 0) + 1;
    return s.walkthroughSeq;
}

async function keepRef(repoPath, ref, sha) {
    await gitOut(repoPath, ["update-ref", ref, sha], { kind: "update-ref" });
}

function checkStopIds(r, stops, path = "walkthrough.stops") {
    const seen = new Set();
    stops.forEach((s, i) => {
        if (!s?.id) return;
        if (seen.has(s.id)) r.issues.add(`${path}[${i}].id`, "duplicate_id", `stop id "${s.id}" is used twice`);
        seen.add(s.id);
    });
}

const lastRevising = new Map(); // docId → { active, at, walkthroughId } (this process), so late panels still see it
/** The current "agent is revising" status (active for 60 s after a rejection, until the next success). */
export function revisingStatus(docId) {
    const r = lastRevising.get(docId);
    return r?.active && Date.now() - Date.parse(r.at) < 60_000 ? r : null;
}
function revising(docId, walkthroughId, active, issues) {
    lastRevising.set(docId, { active, at: now(), walkthroughId: walkthroughId ?? null });
    emitCommand({ documentId: docId, kind: "revising", walkthroughId: walkthroughId ?? null, active, at: now(), ...(issues ? { count: issues.length } : {}) });
}

// ---------- command_walkthrough ----------
export async function commandWalkthrough(input, ctx) {
    const r = new Reader(new Issues());
    const op = r.enumOf(input.op, "op", ["show", "edit", "close", "read"]);
    if (!r.issues.ok) return r.issues.result();
    const docId = ctx.docId;
    const state = readState(docId);
    if (op === "read") {
        const w = state.walkthroughs.find((x) => x.id === (input.id ?? state.walkthroughView?.id));
        return { ok: true, walkthrough: w ?? null, view: state.walkthroughView ?? null };
    }
    if (!isOwner(docId, ctx.sessionId)) return notOwner(docId);
    const repoId = ctx.doc.target.repositoryId;
    const fail = (id) => {
        const res = r.issues.result();
        revising(docId, id, true, res.issues);
        return res;
    };

    if (op === "show") {
        const o = r.obj(input.walkthrough, "walkthrough", ["id", "title", "from", "to", "stops"]);
        if (!o) return fail(null);
        const id = r.id(o.id, "walkthrough.id");
        const title = r.str(o.title, "walkthrough.title", { max: 200 });
        const env = { state, repo: ctx.repo, docId };
        const from = await resolveRef(r, o.from, "walkthrough.from", env);
        const to = await resolveRef(r, o.to, "walkthrough.to", env);
        const rawStops = r.arr(o.stops, "walkthrough.stops", { min: 1, max: LIMITS.stops }) ?? [];
        if (!from || !to) return fail(id);
        const pins = { repositoryId: repoId, base: from.sha, head: to.sha };
        const diff = await diffIndex(repoId, pins);
        if (!diff.files.length) {
            r.issues.add("walkthrough.to", "empty_diff", `nothing changed between ${from.label} (${short(from.sha)}) and ${to.label} (${short(to.sha)})`, "pick checkpoints that differ; command_diff shows what changed");
            return fail(id);
        }
        const stops = [];
        for (const [i, sv] of rawStops.entries()) stops.push(await parseStop(r, sv, `walkthrough.stops[${i}]`, diff));
        checkStopIds(r, stops);
        if (!r.issues.ok) return fail(id);
        // Validated: now (and only now) keep live snapshots reachable, so a rejected request leaves no refs behind.
        for (const [end, ref] of [["from", from], ["to", to]]) if (ref.live) await keepRef(ctx.repo.path, refFor(docId, `walk-${id}-${end}`), ref.sha);
        const prev = readState(docId).walkthroughs.find((w) => w.id === id);
        const w = { id, title, from: o.from, to: o.to, labels: { from: from.label, to: to.label }, pins, stops: stops.filter(Boolean), revision: (prev?.revision ?? 0) + 1, updatedAt: now(), lastEdit: null };
        const next = writeState(docId, (s) => {
            s.walkthroughs = [...s.walkthroughs.filter((x) => x.id !== id), w].slice(-50);
            s.walkthroughView = { id, stopId: w.stops[0].id, seq: nextViewSeq(s) };
        });
        revising(docId, id, false);
        return { ok: true, revision: w.revision, stateRevision: next.revision, summary: `walkthrough '${id}' shown: ${w.stops.length} stops, ${from.label} ${short(from.sha)} → ${to.label} ${short(to.sha)}`, ...(diff.notes.length ? { notes: diff.notes } : {}) };
    }

    const id = r.id(input.id, "id");
    const w = id && state.walkthroughs.find((x) => x.id === id);
    if (id && !w) r.issues.add("id", "unknown_id", `no walkthrough "${id}"`, listHint("walkthrough ids", state.walkthroughs.map((x) => x.id)));
    if (!r.issues.ok) return op === "edit" ? fail(id) : r.issues.result();

    if (op === "close") {
        const next = writeState(docId, (s) => {
            if (s.walkthroughView?.id === id) s.walkthroughView = null;
        });
        revising(docId, id, false);
        return { ok: true, revision: next.revision, summary: `walkthrough '${id}' closed` };
    }

    // edit
    const baseRevision = r.int(input.baseRevision, "baseRevision", { min: 1 });
    if (baseRevision !== undefined && baseRevision !== w.revision) r.issues.add("baseRevision", "stale_revision", `walkthrough '${id}' is at revision ${w.revision}, not ${baseRevision}`, `re-read it (command_walkthrough {op:"read"}) and rebase your edits on revision ${w.revision}`);
    const edits = r.arr(input.edits, "edits", { min: 1, max: 60 }) ?? [];
    if (!r.issues.ok) return fail(id);
    const diff = await diffIndex(repoId, w.pins);
    let stops = w.stops.map((s) => ({ ...s }));
    const changed = new Set();
    const inserted = new Set();
    const removed = new Set();
    let focusId = null;
    const stopHint = () => listHint("stop ids", stops.map((s) => s.id));
    for (const [i, ev] of edits.entries()) {
        const p = `edits[${i}]`;
        const eo = r.obj(ev, p, ["op", "stopId", "afterId", "stop"]);
        if (!eo) continue;
        const eop = r.enumOf(eo.op, `${p}.op`, ["update_stop", "insert_stop", "remove_stop", "focus_stop"]);
        if (!eop) continue;
        if (eop === "insert_stop") {
            const stop = await parseStop(r, eo.stop, `${p}.stop`, diff);
            const after = eo.afterId === undefined || eo.afterId === null ? null : r.id(eo.afterId, `${p}.afterId`);
            const at = after === null ? 0 : stops.findIndex((s) => s.id === after) + 1;
            if (after !== null && at === 0) r.issues.add(`${p}.afterId`, "unknown_id", `no stop "${after}"`, stopHint());
            else if (stop?.id && stops.some((s) => s.id === stop.id)) r.issues.add(`${p}.stop.id`, "duplicate_id", `stop id "${stop.id}" already exists`);
            else if (stop) {
                stops.splice(at, 0, stop);
                inserted.add(stop.id);
            }
            continue;
        }
        const sid = r.id(eo.stopId, `${p}.stopId`);
        const k = stops.findIndex((s) => s.id === sid);
        if (sid && k < 0) {
            r.issues.add(`${p}.stopId`, "unknown_id", `no stop "${sid}"`, stopHint());
            continue;
        }
        if (k < 0) continue;
        if (eop === "update_stop") {
            const patch = await parseStop(r, eo.stop, `${p}.stop`, diff, { partial: true });
            if (patch?.id && patch.id !== sid) r.issues.add(`${p}.stop.id`, "type", "a stop's id can't change", "remove it and insert a new stop instead");
            else if (patch) {
                stops[k] = { ...stops[k], ...patch };
                changed.add(sid);
            }
        } else if (eop === "remove_stop") {
            stops.splice(k, 1);
            removed.add(sid);
        } else focusId = sid;
    }
    if (!stops.length) r.issues.add("edits", "too_few", "a walkthrough needs at least one stop", "close it instead");
    if (stops.length > LIMITS.stops) r.issues.add("edits", "too_many", `at most ${LIMITS.stops} stops`);
    if (!r.issues.ok) return fail(id);
    if (focusId && !stops.some((s) => s.id === focusId)) {
        r.issues.add("edits", "unknown_id", `focus_stop "${focusId}" is removed by the same edit`, "focus a stop that remains");
        return fail(id);
    }
    // Compare-and-swap: the edit was validated against revision w.revision; nothing may have landed during the awaits above.
    const latest = readState(docId).walkthroughs.find((x) => x.id === id);
    if (!latest || latest.revision !== w.revision) {
        r.issues.add("baseRevision", "stale_revision", `walkthrough '${id}' changed while this edit was validated (now revision ${latest?.revision ?? "removed"})`, "re-read it and resend your edits");
        return fail(id);
    }
    const revision = w.revision + 1;
    const next = writeState(docId, (s) => {
        const cur = s.walkthroughs.find((x) => x.id === id);
        Object.assign(cur, { stops, revision, updatedAt: now(), lastEdit: { changed: [...changed], inserted: [...inserted], removed: [...removed], at: now() } });
        // The viewed stop must exist in the final list: explicit focus, else the current stop, else its nearest survivor.
        const v = s.walkthroughView;
        if (focusId) s.walkthroughView = { id, stopId: focusId, seq: nextViewSeq(s) };
        else if (!v || v.id !== id) s.walkthroughView = { id, stopId: stops[0].id, seq: nextViewSeq(s) };
        else if (!stops.some((x) => x.id === v.stopId)) {
            const old = w.stops.findIndex((x) => x.id === v.stopId);
            const survivor = w.stops.slice(old + 1).find((x) => stops.some((y) => y.id === x.id)) ?? [...w.stops.slice(0, Math.max(0, old))].reverse().find((x) => stops.some((y) => y.id === x.id));
            s.walkthroughView = { id, stopId: survivor?.id ?? stops[0].id, seq: nextViewSeq(s) };
        }
    });
    revising(docId, id, false);
    const parts = [changed.size && `${changed.size} updated`, inserted.size && `${inserted.size} inserted`, removed.size && `${removed.size} removed`, focusId && `focused '${focusId}'`].filter(Boolean);
    return { ok: true, revision, stateRevision: next.revision, summary: `walkthrough '${id}' r${revision}: ${parts.join(", ") || "no changes"}`, ...(diff.notes.length ? { notes: diff.notes } : {}) };
}

