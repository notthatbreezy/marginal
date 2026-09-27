// Durable doc store: one JSON file per doc plus immutable version snapshots.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { assignIds, BLOCK_TYPES, checkBlock, CONTAINER_TYPES, flowEdgeSchema, frameSchema, locate, parseBlock, parseUnit, sourcesOf, stepSchema, flowNodeSchema, topBlockOf, UNIT_TYPES, walkBlocks } from "./blocks.mjs";
import { InputError } from "./errors.mjs";
import { describeCommit, diffFiles, getRepository, readFileAt } from "./git.mjs";
import { atomicWriteJson, paths } from "./paths.mjs";

export const SCRATCHPAD_ID = "scratchpad";
const SHA = /^[0-9a-f]{40}$/;

const docs = new Map();
const listeners = new Map(); // key (docId | "*") -> Set<fn>
const activity = new Map(); // docId -> Map<scope, {focus, expiresAt, startedAt}>
const locks = new Map();

function dirOf(id) {
    return join(paths.docs, id);
}

function emit(key, event) {
    for (const k of [key, "*"]) for (const fn of listeners.get(k) ?? []) {
        try {
            fn(event);
        } catch {}
    }
}

export function subscribe(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key)?.delete(fn);
}

function withLock(id, fn) {
    const prev = locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
        id,
        next.catch(() => {}),
    );
    return next;
}

function loadAll() {
    if (docs.size) return;
    for (const name of readdirSync(paths.docs, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        const file = join(paths.docs, name.name, "current.json");
        if (!existsSync(file)) continue;
        try {
            const doc = JSON.parse(readFileSync(file, "utf8"));
            if (doc.kind === "whiteboard") doc.kind = "doc"; // pre-rename docs
            docs.set(doc.id, doc);
        } catch {}
    }
    if (!docs.has(SCRATCHPAD_ID)) {
        const now = new Date().toISOString();
        const pad = { id: SCRATCHPAD_ID, kind: "scratchpad", title: "Scratchpad", createdAt: now, updatedAt: now, version: 0, nextId: 1, target: null, pullRequest: null, content: [], lenses: [], lastEdit: null };
        persist(pad, "create");
    }
}

function persist(doc, reason) {
    doc.updatedAt = new Date().toISOString();
    const dir = dirOf(doc.id);
    mkdirSync(join(dir, "versions"), { recursive: true });
    atomicWriteJson(join(dir, "versions", `${String(doc.version).padStart(6, "0")}.json`), { ...doc, reason });
    atomicWriteJson(join(dir, "current.json"), doc);
    docs.set(doc.id, doc);
    emit(doc.id, { type: "version", documentId: doc.id, version: doc.version, lastEdit: doc.lastEdit, reason });
    emit("*", { type: "catalog" });
}

export function getDoc(id) {
    loadAll();
    const doc = docs.get(id);
    if (!doc) throw new InputError(`Unknown doc: ${id}. Use list to see docs.`);
    return doc;
}

export function hasDoc(id) {
    loadAll();
    return docs.has(id);
}

export function summary(doc) {
    let repositoryName;
    if (doc.target) {
        try {
            repositoryName = getRepository(doc.target.repositoryId).name;
        } catch {}
    }
    let blocks = 0;
    walkBlocks(doc.content, () => blocks++);
    return {
        documentId: doc.id,
        kind: doc.kind,
        title: doc.title,
        version: doc.version,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        blocks,
        repository: repositoryName,
        target: doc.target,
        pullRequest: doc.pullRequest,
        activity: activeScopes(doc.id),
    };
}

export function list() {
    loadAll();
    return [...docs.values()].sort((a, b) => (a.kind === "scratchpad" ? -1 : b.kind === "scratchpad" ? 1 : b.updatedAt.localeCompare(a.updatedAt))).map(summary);
}

function slug(title) {
    return (
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40) || "doc"
    );
}

async function normalizeTarget(target) {
    if (!target) return null;
    const repo = getRepository(target.repositoryId);
    for (const side of ["base", "head"])
        if (!SHA.test(target[side] ?? "")) throw new InputError(`target.${side} must be a full commit SHA; call resolve_pins first.`);
    const [baseInfo, headInfo] = await Promise.all([describeCommit(repo.id, target.base), describeCommit(repo.id, target.head)]);
    return { repositoryId: repo.id, base: target.base, head: target.head, baseRef: target.baseRef, headRef: target.headRef, baseSubject: baseInfo.subject, headSubject: headInfo.subject };
}

export async function create({ title, target, pullRequest }) {
    loadAll();
    if (typeof title !== "string" || !title.trim()) throw new InputError("title is required.");
    let id;
    do id = `${slug(title)}-${randomBytes(2).toString("hex")}`;
    while (docs.has(id));
    const now = new Date().toISOString();
    const doc = { id, kind: "doc", title: title.trim(), createdAt: now, updatedAt: now, version: 0, nextId: 1, target: await normalizeTarget(target), pullRequest: pullRequest ?? null, content: [], lenses: [], lastEdit: null };
    persist(doc, "create");
    return summary(doc);
}

export function findByPullRequest(url) {
    loadAll();
    return [...docs.values()].filter((d) => d.pullRequest?.url?.toLowerCase() === url.toLowerCase()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

// ---------- source verification ----------

async function verifySources(doc, element) {
    for (const { source, visible, fromMarkdown } of sourcesOf(element)) {
        const pins = source.pins ?? doc.target;
        const where = `${source.file}${source.startLine ? `#L${source.startLine}${source.endLine && source.endLine !== source.startLine ? `-L${source.endLine}` : ""}` : ""}`;
        if (!pins) throw new InputError(`Source ${where} has no pins and this ${doc.kind === "scratchpad" ? "scratchpad" : "doc"} has no target. Add pins {repositoryId, head[, base]} from resolve_pins.`);
        const side = source.side ?? "head";
        const commit = side === "base" ? pins.base : pins.head;
        if (!commit) throw new InputError(`Source ${where} is on the base side but its pins have no base.`);
        if (!SHA.test(commit)) throw new InputError(`Source pins must be full commit SHAs from resolve_pins (got ${commit}).`);
        const file = await readFileAt(pins.repositoryId, commit, source.file);
        if (!file.exists) throw new InputError(`Source ${where}: file does not exist on ${side} (${commit.slice(0, 8)}).`);
        if (file.binary) throw new InputError(`Source ${where}: binary file.`);
        if (source.startLine === undefined) continue;
        const end = source.endLine ?? source.startLine;
        if (end > file.lines.length) throw new InputError(`Source ${where} exceeds the pinned file on ${side} (${file.lines.length} lines).`);
        if (visible && !fromMarkdown && file.lines.slice(source.startLine - 1, end).join("").trim() === "") throw new InputError(`Source ${where} contains only whitespace.`);
    }
}

// ---------- edits ----------

function counter(doc) {
    return () => doc.nextId++;
}

function place(list, item, { afterId, beforeId, prepend }) {
    if (afterId) {
        const i = list.findIndex((x) => x.id === afterId);
        if (i < 0) throw new InputError(`afterId ${afterId} is not a sibling in the target list.`);
        list.splice(i + 1, 0, item);
    } else if (beforeId) {
        const i = list.findIndex((x) => x.id === beforeId);
        if (i < 0) throw new InputError(`beforeId ${beforeId} is not a sibling in the target list.`);
        list.splice(i, 0, item);
    } else if (prepend) list.unshift(item);
    else list.push(item);
}

function containerList(doc, parentId) {
    if (!parentId) return { list: doc.content, parent: null };
    const hit = locate(doc.content, parentId);
    if (!hit) throw new InputError(`Unknown parentId: ${parentId}`);
    if (hit.kind === "block" && CONTAINER_TYPES.includes(hit.node.type)) return { list: hit.node.children, parent: hit.node };
    throw new InputError(`parentId ${parentId} is a ${hit.node.type}; blocks can only be nested in ${CONTAINER_TYPES.join(" or ")}.`);
}

function childrenSummary(el) {
    if (el.children) return el.children.map((c) => ({ id: c.id, type: c.type }));
    if (el.type === "sequence") return el.steps.map((s) => ({ id: s.id, type: "step" }));
    if (el.type === "flow_diagram") return [...el.nodes.map((n) => ({ id: n.id, type: "flow_node", key: n.key })), ...el.edges.map((e) => ({ id: e.id, type: "flow_edge" }))];
    if (el.type === "call_stack_diff") return [...el.base.map((f) => ({ id: f.id, side: "base", key: f.key })), ...el.head.map((f) => ({ id: f.id, side: "head", key: f.key }))];
    return undefined;
}

function unitKind(unit, parent) {
    if (parent.type === "sequence") return "step";
    return parent.nodes.includes(unit) ? "flow_node" : "flow_edge";
}

async function applyEditInner(doc, edit, { dryRun = false } = {}) {
    if (!edit || typeof edit !== "object") throw new InputError("edit must be an object.");
    const draft = structuredClone(doc);
    const next = counter(draft);
    let targetId;
    let kind;
    let blockId;
    let linkId;
    let fields;
    let verifyTarget;

    switch (edit.type) {
        case "insert": {
            const content = edit.content;
            if (!content || typeof content !== "object") throw new InputError("insert needs content.");
            if (UNIT_TYPES[content.type]) {
                const parent = locate(draft.content, edit.parentId ?? "")?.node;
                if (!parent || parent.type !== UNIT_TYPES[content.type]) throw new InputError(`A ${content.type} needs parentId naming its ${UNIT_TYPES[content.type]}.`);
                const unit = parseUnit(content);
                const { link } = unit;
                delete unit.link;
                unit.id = `${{ step: "step", flow_node: "node", flow_edge: "edge" }[content.type]}-${next()}`;
                const list = content.type === "step" ? parent.steps : content.type === "flow_node" ? parent.nodes : parent.edges;
                place(list, unit, edit);
                if (link) {
                    if (!!link.from === !!link.to) throw new InputError("link needs exactly one of from or to.");
                    const edge = flowEdgeSchema({ type: "flow_edge", from: link.from ?? unit.key, to: link.to ?? unit.key, label: link.label, style: link.style }, "link");
                    edge.id = `edge-${next()}`;
                    parent.edges.push(edge);
                    linkId = edge.id;
                }
                checkBlock(parent);
                targetId = unit.id;
                kind = content.type;
                blockId = parent.id;
                verifyTarget = unit;
            } else {
                const blockNode = assignIds(parseBlock(content), next);
                const { list } = containerList(draft, edit.parentId);
                place(list, blockNode, { ...edit, prepend: draft.kind === "scratchpad" && !edit.parentId });
                targetId = blockNode.id;
                kind = blockNode.type;
                blockId = blockNode.id;
                verifyTarget = blockNode;
            }
            break;
        }
        case "update": {
            const hit = locate(draft.content, edit.targetId ?? "");
            if (!hit) throw new InputError(`Unknown targetId: ${edit.targetId}`);
            if (hit.kind === "frame" && edit.type !== "update") throw new InputError("Call-stack frames can only be updated in place (e.g. to add notes); update the call_stack_diff's base/head to restructure it.");
            const changes = edit.changes;
            if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new InputError("update needs a changes object.");
            // Restating the element's own id or type is harmless: drop it rather than refuse the edit.
            for (const key of ["id", "type"]) if (key in changes && changes[key] === hit.node[key]) delete changes[key];
            for (const key of ["id", "type", "children", "steps", "nodes", "edges"])
                if (key in changes) throw new InputError(`update cannot change ${key}; use insert/move/remove on children, or replace.`);
            const merged = { ...hit.node };
            for (const [k, v] of Object.entries(changes)) {
                if (v === null) delete merged[k];
                else merged[k] = v;
            }
            let parsed;
            if (hit.kind === "frame") {
                // Call-stack frames are updated in place (e.g. notes); the block's update/replace restructures the tree.
                parsed = frameSchema(merged, edit.targetId);
                parsed.id = hit.node.id;
                hit.list[hit.index] = parsed;
                checkBlock(hit.parent);
                kind = "frame";
                blockId = hit.parent.id;
            } else if (hit.kind === "unit") {
                const k = unitKind(hit.node, hit.parent);
                parsed = (k === "step" ? stepSchema : k === "flow_node" ? flowNodeSchema : flowEdgeSchema)(merged, edit.targetId);
                parsed.id = hit.node.id;
                if (k === "flow_node" && parsed.key !== hit.node.key)
                    for (const e of hit.parent.edges) {
                        if (e.from === hit.node.key) e.from = parsed.key;
                        if (e.to === hit.node.key) e.to = parsed.key;
                    }
                hit.list[hit.index] = parsed;
                checkBlock(hit.parent);
                kind = k;
                blockId = hit.parent.id;
            } else {
                parsed = parseBlock(merged, edit.targetId);
                assignIds(parsed, next, parsed.type, { onlyMissing: true });
                hit.list[hit.index] = parsed;
                kind = parsed.type;
                blockId = parsed.id;
            }
            targetId = parsed.id;
            fields = Object.keys(changes);
            verifyTarget = hit.kind === "frame" ? { type: "call_stack_diff", base: [], head: [parsed] } : parsed;
            break;
        }
        case "replace": {
            const hit = locate(draft.content, edit.targetId ?? "");
            if (!hit) throw new InputError(`Unknown targetId: ${edit.targetId}`);
            if (hit.kind === "frame" && edit.type !== "update") throw new InputError("Call-stack frames can only be updated in place (e.g. to add notes); update the call_stack_diff's base/head to restructure it.");
            if (hit.kind === "unit") {
                const k = unitKind(hit.node, hit.parent);
                const unit = parseUnit({ ...edit.content, type: edit.content?.type ?? k });
                delete unit.link;
                unit.id = hit.node.id;
                hit.list[hit.index] = unit;
                checkBlock(hit.parent);
                kind = k;
                blockId = hit.parent.id;
                verifyTarget = unit;
            } else {
                const replaced = assignIds(parseBlock(edit.content), next);
                replaced.id = hit.node.id;
                hit.list[hit.index] = replaced;
                kind = replaced.type;
                blockId = replaced.id;
                verifyTarget = replaced;
            }
            targetId = edit.targetId;
            break;
        }
        case "move": {
            const hit = locate(draft.content, edit.targetId ?? "");
            if (!hit) throw new InputError(`Unknown targetId: ${edit.targetId}`);
            if (hit.kind === "frame" && edit.type !== "update") throw new InputError("Call-stack frames can only be updated in place (e.g. to add notes); update the call_stack_diff's base/head to restructure it.");
            if (hit.kind === "unit") {
                if (edit.parentId && edit.parentId !== hit.parent.id) throw new InputError("Diagram units can only move within their own diagram.");
                hit.list.splice(hit.index, 1);
                place(hit.list, hit.node, edit);
                kind = unitKind(hit.node, hit.parent);
                blockId = hit.parent.id;
            } else {
                if (edit.parentId) {
                    const ancestors = topBlockOf(draft.content, edit.parentId);
                    if (ancestors.some((b) => b.id === hit.node.id)) throw new InputError("Cannot move a block inside itself.");
                }
                hit.list.splice(hit.index, 1);
                const { list } = containerList(draft, edit.parentId);
                place(list, hit.node, edit);
                kind = hit.node.type;
                blockId = hit.node.id;
            }
            targetId = edit.targetId;
            break;
        }
        case "remove": {
            const hit = locate(draft.content, edit.targetId ?? "");
            if (!hit) throw new InputError(`Unknown targetId: ${edit.targetId}`);
            if (hit.kind === "frame" && edit.type !== "update") throw new InputError("Call-stack frames can only be updated in place (e.g. to add notes); update the call_stack_diff's base/head to restructure it.");
            hit.list.splice(hit.index, 1);
            if (hit.kind === "unit" && hit.parent.type === "flow_diagram" && hit.node.type === "flow_node") {
                if (hit.parent.nodes.length === 0) throw new InputError("A flow diagram needs at least one node; remove the diagram instead.");
                hit.parent.edges = hit.parent.edges.filter((e) => e.from !== hit.node.key && e.to !== hit.node.key);
            }
            kind = hit.kind === "unit" ? unitKind(hit.node, hit.parent) : hit.node.type;
            blockId = hit.kind === "unit" ? hit.parent.id : hit.node.id;
            targetId = edit.targetId;
            break;
        }
        default:
            throw new InputError(`Unknown edit type ${JSON.stringify(edit.type)}. Use insert, update, replace, move or remove.`);
    }

    if (verifyTarget) await verifySources(draft, verifyTarget);

    const topBlock = topBlockOf(draft.content, blockId)[0];
    draft.version = doc.version + 1;
    draft.lastEdit = { type: edit.type, targetId, blockId, topBlockId: topBlock?.id, kind, ...(kind !== topBlock?.type && UNIT_TYPES[kind] ? { unit: targetId } : {}), ...(linkId ? { linkId } : {}), ...(fields ? { fields } : {}), at: new Date().toISOString() };
    if (dryRun) return { draft };
    persist(draft, "edit");
    touchActivity(doc.id);
    const el = edit.type === "remove" ? null : locate(draft.content, targetId)?.node;
    return { documentId: doc.id, version: draft.version, targetId, type: kind, ...(linkId ? { linkId } : {}), ...(el ? { children: childrenSummary(el) } : {}) };
}

export async function applyEdit(docId, edit) {
    return (await applyEdits(docId, [edit]))[0];
}

/**
 * A batch of edits, all or nothing: every edit is checked in order against the doc as the ones before it leave it,
 * and only if all pass are they applied (each still saves its own version and animates). baseVersion guards compare
 * with the doc as the batch found it, so a batch never conflicts with itself.
 */
export function applyEdits(docId, edits) {
    return withLock(docId, async () => {
        const start = getDoc(docId);
        let draft = start;
        for (const [n, e] of edits.entries()) {
            try {
                ({ draft } = await applyEditInner(draft, convertEdit(draft, e, start).edit, { dryRun: true }));
            } catch (err) {
                if (!(err instanceof InputError)) throw err;
                throw new InputError(`${edits.length > 1 ? `edits[${n}] failed, so nothing was saved: ` : ""}${err.message}`);
            }
        }
        const results = [];
        for (const e of edits) {
            const doc = getDoc(docId);
            const conv = convertEdit(doc, e, start);
            const res = await applyEditInner(doc, conv.edit);
            conv.after?.();
            results.push(conv.note ? { ...res, note: conv.note } : res);
        }
        return results;
    });
}

/**
 * The addressing edits (patch, region, under) become plain edits against the doc as it is now. baseVersion guards
 * the target element (patch/update/…), or just the text under a heading (under); a region guards itself (its text
 * must still be there).
 */
function convertEdit(doc, edit, guardDoc = doc) {
    if (edit?.type === "region") return regionToEdit(doc, edit);
    if (edit?.type === "under") return underToEdit(doc, edit, guardDoc);
    guardBase(guardDoc, edit);
    return { edit: edit?.type === "patch" ? patchToUpdate(doc, edit) : edit };
}

/** JSON with keys in a fixed order: re-saving an element must never make equal content look different. */
export function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
    return JSON.stringify(v);
}
/**
 * Markdown code fences, as CommonMark reads them: a fence opens with 3+ backticks or tildes and closes only on a line
 * of the same character, at least as long, with nothing after it. step(line) says whether the line is code.
 */
function fenceTracker() {
    let open = null; // { ch, len }
    return (line) => {
        const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (!open) {
            if (m && !(m[1][0] === "`" && m[2].includes("`"))) open = { ch: m[1][0], len: m[1].length };
            return !!open;
        }
        if (m && m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim()) open = null;
        return true; // the closing fence is still part of the code
    };
}

const CHILD_KEYS = ["children", "steps", "nodes", "edges"];
const ownFields = (n) => Object.fromEntries(Object.entries(n).filter(([k]) => !CHILD_KEYS.includes(k)));
/**
 * What an edit relies on staying put. update/patch: the element's own fields (a parent's rename or a child's edit
 * isn't a conflict); replace/remove: the element and everything in it; move: that plus where it sits.
 */
function guardView(doc, id, type) {
    const hit = locate(doc.content, id);
    if (!hit) return null;
    if (type === "update" || type === "patch") return stable(ownFields(hit.node));
    if (type === "move") return stable({ node: hit.node, parent: hit.parent?.id ?? null, prev: hit.list?.[hit.index - 1]?.id ?? null });
    // Removing a flow node removes the edges that touch it, so those are part of what it relies on.
    if (type === "remove" && hit.kind === "unit" && hit.parent?.type === "flow_diagram" && hit.node.key !== undefined)
        return stable({ node: hit.node, edges: hit.parent.edges.filter((e) => e.from === hit.node.key || e.to === hit.node.key) });
    return stable(hit.node);
}
/** baseVersion: the doc version the edit was written against. Refused only if what the edit relies on changed. */
function guardBase(doc, edit) {
    if (!edit || typeof edit !== "object" || edit.baseVersion === undefined) return;
    if (!Number.isInteger(edit.baseVersion) || edit.baseVersion < 0 || edit.baseVersion > doc.version) throw new InputError(`baseVersion must be a version of this doc (0–${doc.version}).`);
    const id = edit.targetId;
    if (!id || edit.baseVersion === doc.version) return;
    const then = guardView(getVersion(doc.id, edit.baseVersion), id, edit.type);
    const now = guardView(doc, id, edit.type);
    if (then === now) return;
    // Say which version changed it, who made it and what it was, so the agent can decide without another read.
    let first = null;
    for (let v = edit.baseVersion + 1; v <= doc.version && v <= edit.baseVersion + 500; v++) {
        let snap;
        try {
            snap = v === doc.version ? doc : getVersion(doc.id, v);
        } catch {
            continue;
        }
        if (guardView(snap, id, edit.type) !== then) {
            first = snap;
            break;
        }
    }
    const le = first?.lastEdit;
    const who = le?.by === "user" ? "the user" : "Copilot";
    const how = le ? `${le.by === "user" ? "an in-place edit" : `${le.type ?? "an edit"}`}${le.targetId && le.targetId !== id ? ` of ${le.targetId}` : ""}${le.fields?.length ? `: ${le.fields.join(", ")}` : ""}` : "an edit";
    const a = locate(getVersion(doc.id, edit.baseVersion).content, id)?.node;
    const b = locate(doc.content, id)?.node;
    const fields = a && b ? [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !CHILD_KEYS.includes(k) && stable(a[k]) !== stable(b[k])) : [];
    const what = !b ? "was removed" : fields.length ? `changed (${fields.join(", ")})` : edit.type === "move" ? "moved or its contents changed" : "changed inside";
    throw new InputError(`${id} ${what} since version ${edit.baseVersion}: first in v${first?.version ?? "?"}, by ${who} (${how}); the doc is at v${doc.version}. Nothing was saved: read it again (read {targetId:"${id}"} or changes {sinceVersion:${edit.baseVersion}}) and redo the edit against v${doc.version}.`);
}

/** Where a failed find probably meant: the same text with different spacing, or the most similar stretch of lines. */
function nearestText(text, find) {
    const squash = (s) => s.replace(/\s+/g, " ").trim();
    if (squash(find) && squash(text).includes(squash(find))) return "it matches if spacing and line breaks are ignored: copy the exact text from read {targetId, lines:true}";
    const pairs = (s) => {
        const t = s.toLowerCase().replace(/\s+/g, " ");
        const m = new Map();
        for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
        return m;
    };
    const dice = (a, b) => {
        const A = pairs(a);
        const B = pairs(b);
        let hit = 0;
        let n = 0;
        for (const [k, v] of A) (hit += Math.min(v, B.get(k) ?? 0)), (n += v);
        for (const v of B.values()) n += v;
        return n ? (2 * hit) / n : 0;
    };
    const lines = text.split("\n");
    const span = Math.max(1, find.split("\n").length);
    let best = { score: 0, at: 0 };
    for (let i = 0; i + span <= lines.length; i++) {
        const score = dice(lines.slice(i, i + span).join("\n"), find);
        if (score > best.score) best = { score, at: i };
    }
    if (best.score < 0.45) return null;
    const got = lines.slice(best.at, best.at + span).join("\n");
    return `closest (lines ${best.at + 1}–${best.at + span}): ${JSON.stringify(got.length > 300 ? `${got.slice(0, 300)}…` : got)}`;
}

/**
 * patch: change part of a text field without resending it. ops run against the field's text as it is now:
 *   {find, replace, all?}  exact text; must occur once (or all:true for every occurrence)
 *   {lines:[from, to], text, expect?}  replace lines from..to (1-based, inclusive; text "" deletes them); expect, if
 *   given, must equal those lines now. Line numbers are the text's before any op; line ops run first, then finds.
 */
function patchToUpdate(doc, edit) {
    const allowed = new Set(["type", "targetId", "field", "ops", "baseVersion"]);
    for (const k of Object.keys(edit)) if (!allowed.has(k)) throw new InputError(`patch: unknown field "${k}" (allowed: ${[...allowed].join(", ")})`);
    const hit = locate(doc.content, edit.targetId ?? "");
    if (!hit) throw new InputError(`Unknown targetId: ${edit.targetId}`);
    // The element's text: its markdown, or a code block's text, unless a field is named.
    const field = edit.field ?? (typeof hit.node.markdown === "string" ? "markdown" : typeof hit.node.text === "string" ? "text" : "markdown");
    const cur = hit.node[field];
    if (typeof cur !== "string") throw new InputError(`patch: ${edit.targetId} has no text field "${field}"${typeof hit.node.markdown === "string" ? ' (it has "markdown")' : ""}; text fields here: ${Object.entries(hit.node).filter(([, v]) => typeof v === "string" && !["id", "type"].includes(v)).map(([k]) => k).join(", ") || "none"}.`);
    const ops = edit.ops;
    if (!Array.isArray(ops) || !ops.length || ops.length > 100) throw new InputError("patch needs ops: a list of {find, replace} or {lines:[from, to], text}.");
    let lines = cur.split("\n");
    const lineOps = [];
    const finds = [];
    ops.forEach((op, i) => {
        const at = `ops[${i}]`;
        if (!op || typeof op !== "object") throw new InputError(`${at} must be an object.`);
        if (op.lines !== undefined) {
            const [from, to = from] = Array.isArray(op.lines) ? op.lines : [];
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from - 1 || to > lines.length) throw new InputError(`${at}.lines must be [from, to] within 1–${lines.length} (to = from − 1 inserts before from).`);
            if (typeof op.text !== "string") throw new InputError(`${at}.text must be a string ("" deletes the lines).`);
            // expect is the range's text as you read it (all of it, or just its first line).
            const now = lines.slice(from - 1, to).join("\n");
            if (op.expect !== undefined && now !== op.expect && !(typeof op.expect === "string" && !op.expect.includes("\n") && lines[from - 1] === op.expect))
                throw new InputError(`${at}: expect must match lines ${from}–${to} (all of them, or just line ${from}); they now read:\n${now.slice(0, 600)}`);
            lineOps.push({ from, to, text: op.text, at });
        } else if (typeof op.find === "string") {
            if (!op.find) throw new InputError(`${at}.find is empty.`);
            if (typeof op.replace !== "string") throw new InputError(`${at}.replace must be a string.`);
            finds.push({ ...op, at });
        } else throw new InputError(`${at} needs find/replace or lines/text.`);
    });
    // Replacements cover lines from..to; an insertion (to = from − 1) is the gap before line from. Two ops conflict
    // when replacements share a line, an insertion falls inside a replacement, or two insertions share a gap.
    const isIns = (op) => op.to < op.from;
    const clash = (a, b) =>
        isIns(a) && isIns(b) ? a.from === b.from : isIns(a) ? b.from < a.from && a.from <= b.to : isIns(b) ? a.from < b.from && b.from <= a.to : a.from <= b.to && b.from <= a.to;
    lineOps.forEach((a, k) => lineOps.slice(k + 1).forEach((b) => clash(a, b) && (() => { throw new InputError(`${a.at} and ${b.at} overlap.`); })()));
    // Bottom-up, so earlier line numbers stay valid; at the same line the replacement goes first, the insertion lands before it.
    const sorted = [...lineOps].sort((a, b) => b.from - a.from || Number(isIns(a)) - Number(isIns(b)));
    for (const op of sorted) lines.splice(op.from - 1, op.to - op.from + 1, ...(op.text === "" ? [] : op.text.split("\n")));
    let text = lines.join("\n");
    for (const op of finds) {
        const count = text.split(op.find).length - 1;
        if (!count) {
            const near = nearestText(text, op.find);
            throw new InputError(`${op.at}: "${op.find.slice(0, 80)}" isn't in ${edit.targetId}.${field}${near ? `; ${near}` : " (it may have changed; read it again)"}.`);
        }
        if (count > 1 && !op.all) throw new InputError(`${op.at}: "${op.find.slice(0, 80)}" occurs ${count} times; add surrounding text to make it unique, or pass all:true.`);
        text = op.all ? text.split(op.find).join(op.replace) : text.replace(op.find, () => op.replace);
    }
    if (text === cur) throw new InputError("patch changes nothing.");
    return { type: "update", targetId: edit.targetId, changes: { [field]: text } };
}

// ---------- addressing by heading ----------
/**
 * A heading as it reads: Markdown formatting removed, the words kept. Any character may appear in a title; only
 * formatting pairs are stripped (so parse_input_file and a*b keep their underscores and asterisks).
 */
const plainHeading = (s) =>
    String(s ?? "")
        .replace(/\s+#+\s*$/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
        .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1$2")
        .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
        .replace(/\s+/g, " ")
        .trim();
const headKey = (s) => plainHeading(s).toLowerCase();
/**
 * The ways to read a path. An array is exact: one title per level, no parsing. A string is split on " > " (or "›"),
 * but a title may itself contain those, so every way of splitting it is tried: "Plan > Inputs > Outputs" can mean
 * Plan / Inputs / Outputs or Plan / "Inputs > Outputs". \> keeps a ">" in a title for certain.
 */
function headReadings(q) {
    if (Array.isArray(q)) {
        const segs = q.map(headKey).filter(Boolean);
        return segs.length ? [segs] : [];
    }
    const s = String(q ?? "").trim();
    if (!s) return [];
    const LIT = "\u0000";
    const parts = s.replace(/\\>/g, LIT).split(/(\s+>\s+|\s*›\s*)/);
    const words = parts.filter((_, i) => i % 2 === 0);
    const seps = parts.filter((_, i) => i % 2 === 1);
    const n = Math.min(seps.length, 9); // 2^9 readings at most; deeper paths split on every separator after that
    const out = [];
    for (let mask = 0; mask < 2 ** n; mask++) {
        const segs = [words[0]];
        for (let k = 0; k < seps.length; k++) {
            if (k < n && !(mask & (1 << k))) segs[segs.length - 1] += seps[k] + words[k + 1];
            else segs.push(words[k + 1]);
        }
        const keys = segs.map((x) => headKey(x.split(LIT).join(">"))).filter(Boolean);
        if (keys.length) out.push(keys);
    }
    return out;
}
/** A path shown back to the agent: " > " between titles, or a JSON array when a title contains a separator itself. */
const showPath = (e) => (e.path.some((t) => /\s>\s|›/.test(t)) ? JSON.stringify(e.path) : JSON.stringify(e.path.join(" > ")));

/**
 * Every heading an agent can address, in doc order: sections and titled callouts (their whole content), and the
 * Markdown headings inside text blocks (from the heading to the next one of the same or higher rank in that block).
 * path: the titles from the top down, e.g. ["Plan", "Review findings"].
 */
export function headingIndex(doc) {
    const out = [];
    const walk = (list, trail) => {
        for (const b of list ?? []) {
            if (b.type === "section" || (b.type === "callout" && b.title)) {
                const e = { kind: b.type, blockId: b.id, text: plainHeading(b.title), path: [...trail, plainHeading(b.title)] };
                out.push(e);
                walk(b.children, e.path);
            } else if (b.type === "markdown") {
                const lines = b.markdown.replace(/\r\n/g, "\n").split("\n");
                const mine = [];
                const stack = [];
                const inCode = fenceTracker();
                lines.forEach((l, i) => {
                    if (inCode(l)) return;
                    const m = l.match(/^(#{1,6})\s+(.+?)\s*$/);
                    if (!m) return;
                    const rank = m[1].length;
                    while (stack.length && stack.at(-1).rank >= rank) stack.pop();
                    const text = plainHeading(m[2]);
                    const e = { kind: "heading", blockId: b.id, line: i, rank, text, path: [...trail, ...stack.map((s) => s.text), text] };
                    mine.push(e);
                    stack.push(e);
                });
                mine.forEach((e, k) => {
                    const next = mine.slice(k + 1).find((x) => x.rank <= e.rank);
                    e.end = next ? next.line - 1 : lines.length - 1;
                });
                out.push(...mine);
            }
        }
    };
    walk(doc.content, []);
    return out;
}
const pathText = (e) => e.path.join(" > ");

/** Resolve a heading path: its last part names the heading; earlier parts, if given, must be among its ancestors. */
export function resolveHeading(doc, query) {
    const readings = headReadings(query);
    if (!readings.length) throw new InputError('heading must name a heading, e.g. "Plan > Review findings" or ["Plan", "Review findings"].');
    const all = headingIndex(doc);
    // The last title names the heading; earlier ones, in order, must be among its ancestors (levels may be skipped).
    const matches = (e, segs) => {
        if (headKey(e.text) !== segs.at(-1)) return false;
        const keys = e.path.slice(0, -1).map(headKey);
        let k = 0;
        for (const s of segs.slice(0, -1)) {
            k = keys.indexOf(s, k);
            if (k < 0) return false;
            k++;
        }
        return true;
    };
    const hits = all.filter((e) => readings.some((segs) => matches(e, segs)));
    if (hits.length === 1) return hits[0];
    const q = JSON.stringify(query);
    if (hits.length > 1) throw new InputError(`heading ${q} matches ${hits.length} headings: ${hits.map((e) => JSON.stringify(e.path)).join(", ")}. Pass one of those (an array of titles is exact).`);
    const words = readings[0].at(-1).split(" ").filter((w) => w.length > 2);
    const near = all.filter((e) => words.some((w) => headKey(e.text).includes(w))).slice(0, 8);
    throw new InputError(`no heading ${q}. ${near.length ? `Close: ${near.map(showPath).join(", ")}.` : `Headings: ${all.slice(0, 12).map(showPath).join(", ")}${all.length > 12 ? ", …" : ""}.`}`);
}

/** The content under a heading: a Markdown span (text + its lines), or a section's children (text, and ids of the rest). */
export function readHeading(docId, query, { version } = {}) {
    return headingContent(version === undefined ? getDoc(docId) : getVersion(docId, version), query);
}
function headingContent(doc, query) {
    const e = resolveHeading(doc, query);
    if (e.kind === "heading") {
        const lines = locate(doc.content, e.blockId).node.markdown.replace(/\r\n/g, "\n").split("\n");
        return { heading: pathText(e), path: e.path, kind: "heading", blockId: e.blockId, version: doc.version, headingLine: e.line + 1, lines: [e.line + 2, e.end + 1], markdown: lines.slice(e.line + 1, e.end + 1).join("\n").replace(/^\n+|\n+$/g, "") };
    }
    const node = locate(doc.content, e.blockId).node;
    return {
        heading: pathText(e),
        path: e.path,
        kind: e.kind,
        blockId: e.blockId,
        version: doc.version,
        children: node.children.map((c) => ({ id: c.id, type: c.type, ...(c.title ? { title: c.title } : {}) })),
        markdown: node.children.filter((c) => c.type === "markdown").map((c) => c.markdown).join("\n\n"),
    };
}

/** Drop blank lines at both ends of a span (its inside is left alone). */
const trimBlank = (lines) => {
    let a = 0;
    let b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b);
};
function guardUnder(doc, edit) {
    if (edit.baseVersion === undefined) return;
    if (!Number.isInteger(edit.baseVersion) || edit.baseVersion < 0 || edit.baseVersion > doc.version) throw new InputError(`baseVersion must be a version of this doc (0–${doc.version}).`);
    let then;
    try {
        then = headingContent(getVersion(doc.id, edit.baseVersion), edit.heading);
    } catch {
        throw new InputError(`heading ${JSON.stringify(edit.heading)} didn't exist at version ${edit.baseVersion}; read it again.`);
    }
    const now = headingContent(doc, edit.heading);
    if (then.markdown !== now.markdown || stable(then.children) !== stable(now.children)) throw new InputError(`The text under ${JSON.stringify(now.heading)} changed since version ${edit.baseVersion} (the doc is at v${doc.version}). Nothing was saved: read {heading:${JSON.stringify(edit.heading)}} again and redo the edit.`);
}
/** under {heading, markdown, append?}: replace (or append to) what's under a heading; the heading itself stays. */
function underToEdit(doc, edit, guardDoc = doc) {
    for (const k of Object.keys(edit)) if (!["type", "heading", "markdown", "append", "baseVersion"].includes(k)) throw new InputError(`under: unknown field "${k}" (allowed: heading, markdown, append, baseVersion)`);
    if (typeof edit.markdown !== "string") throw new InputError('under needs markdown (the new text under the heading; "" empties it).');
    guardUnder(guardDoc, edit);
    const e = resolveHeading(doc, edit.heading);
    const md = edit.markdown.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
    if (e.kind === "heading") {
        const node = locate(doc.content, e.blockId).node;
        const lines = node.markdown.replace(/\r\n/g, "\n").split("\n");
        // Only the span under the heading changes; everything before and after it is kept exactly as it is.
        const body = lines.slice(e.line + 1, e.end + 1);
        const kept = edit.append ? trimBlank(body) : [];
        const add = md ? md.split("\n") : [];
        const after = lines.slice(e.end + 1);
        const inner = [...kept, ...(kept.length && add.length ? [""] : []), ...add];
        const span = inner.length ? ["", ...inner, ...(after.length ? [""] : [])] : after.length ? [""] : [];
        return { edit: { type: "update", targetId: e.blockId, changes: { markdown: [...lines.slice(0, e.line + 1), ...span, ...after].join("\n") } } };
    }
    const node = locate(doc.content, e.blockId).node;
    if (edit.append) {
        if (!md) throw new InputError("under with append needs some markdown to add.");
        return { edit: { type: "insert", parentId: e.blockId, content: { type: "markdown", markdown: md } } };
    }
    const other = node.children.filter((c) => c.type !== "markdown");
    if (other.length) throw new InputError(`${JSON.stringify(pathText(e))} also holds ${other.map((c) => `${c.type} ${c.id}`).join(", ")}, which replacing its text would drop. Edit its text blocks by id (${node.children.filter((c) => c.type === "markdown").map((c) => c.id).join(", ") || "none"}), or pass append:true to add text.`);
    const { id, children, ...rest } = node;
    return { edit: { type: "replace", targetId: e.blockId, content: { ...rest, children: md ? [{ type: "markdown", markdown: md }] : [] } } };
}

// ---------- regions: the parts of the doc a chat message pointed at ----------
const regionsFile = (docId) => join(dirOf(docId), "regions.json");
function readRegions(docId) {
    try {
        return existsSync(regionsFile(docId)) ? JSON.parse(readFileSync(regionsFile(docId), "utf8")) : { next: 1, messages: {} };
    } catch {
        return { next: 1, messages: {} };
    }
}
const saveRegions = (docId, r) => atomicWriteJson(regionsFile(docId), r);

/**
 * Record what a chat message is about. regions: [{blockId, unit?:"from-to"}] (unit = the paragraph's Markdown lines,
 * 0-based, as the page marks them). Each becomes a ref ("m4.r1") the agent can read or rewrite; text is held so a
 * later rewrite can find it again, and refuse if it changed.
 */
export function registerRegions(docId, regions) {
    const doc = getDoc(docId);
    const list = (Array.isArray(regions) ? regions : []).slice(0, 20);
    const store = readRegions(docId);
    const msg = `m${store.next}`;
    const refs = [];
    const seen = new Set();
    for (const r of list) {
        if (!r || typeof r.blockId !== "string") continue;
        const hit = locate(doc.content, r.blockId);
        if (!hit) continue;
        const md = hit.kind === "block" && hit.node.type === "markdown" ? hit.node.markdown.replace(/\r\n/g, "\n").split("\n") : null;
        let from = null;
        let to = null;
        if (md) {
            const m = typeof r.unit === "string" && r.unit.match(/^(\d+)-(\d+)$/);
            [from, to] = m ? [Number(m[1]), Math.min(Number(m[2]), md.length - 1)] : [0, md.length - 1];
            if (from > to) continue;
        }
        const key = `${r.blockId}:${from}:${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rec = { r: `r${refs.length + 1}`, blockId: r.blockId, type: hit.kind === "unit" ? "unit" : hit.node.type, version: doc.version, ...(md ? { from, text: md.slice(from, to + 1).join("\n") } : {}) };
        refs.push(rec);
    }
    if (!refs.length) return null;
    store.messages[msg] = { at: new Date().toISOString(), regions: refs };
    store.next++;
    const keys = Object.keys(store.messages);
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete store.messages[k];
    saveRegions(docId, store);
    return {
        message: msg,
        refs: refs.map((x) => ({ ref: `${msg}.${x.r}`, blockId: x.blockId, type: x.type, ...(x.text !== undefined ? { lines: `${x.from + 1}–${x.from + x.text.split("\n").length}`, preview: clip(x.text, 50) } : {}) })),
    };
}
function findRegion(docId, ref) {
    const m = String(ref ?? "").match(/^(m\d+)\.(r\d+)$/);
    if (!m) throw new InputError(`ref must look like "m4.r1" (from the chat message), not ${JSON.stringify(ref)}.`);
    const store = readRegions(docId);
    const rec = store.messages[m[1]]?.regions.find((x) => x.r === m[2]);
    if (!rec) throw new InputError(`no region ${ref} (only the last 100 messages' regions are kept).`);
    return { store, rec, msg: m[1] };
}
/** Where a region's text is now: the occurrence nearest its old place, or null if the text itself changed. */
function locateRegion(doc, rec) {
    const hit = locate(doc.content, rec.blockId);
    if (!hit) return { gone: true };
    if (rec.text === undefined) return { hit };
    if (hit.node.type !== "markdown") return { hit, changed: true };
    const lines = hit.node.markdown.replace(/\r\n/g, "\n").split("\n");
    const want = rec.text.split("\n");
    const at = [];
    for (let k = 0; k + want.length <= lines.length; k++) if (want.every((w, j) => lines[k + j] === w)) at.push(k);
    if (!at.length) return { hit, lines, changed: true };
    const from = at.sort((a, b) => Math.abs(a - rec.from) - Math.abs(b - rec.from))[0];
    return { hit, lines, from, to: from + want.length - 1 };
}
export function readRegion(docId, ref) {
    const doc = getDoc(docId);
    const { rec } = findRegion(docId, ref);
    const loc = locateRegion(doc, rec);
    if (loc.gone) return { ref, blockId: rec.blockId, status: "removed", note: `${rec.blockId} is no longer in the doc` };
    if (rec.text === undefined) return { ref, blockId: rec.blockId, type: rec.type, status: "element", note: "not text: read or edit it by blockId" };
    if (loc.changed) return { ref, blockId: rec.blockId, status: "changed", was: rec.text, note: `that text was changed since (read ${rec.blockId})` };
    return { ref, blockId: rec.blockId, status: loc.from === rec.from ? "unchanged" : "moved", lines: [loc.from + 1, loc.to + 1], markdown: rec.text, version: doc.version };
}
/** region {ref, markdown}: rewrite exactly what the message pointed at ("" removes it). */
function regionToEdit(doc, edit) {
    for (const k of Object.keys(edit)) if (!["type", "ref", "markdown"].includes(k)) throw new InputError(`region: unknown field "${k}" (allowed: ref, markdown)`);
    if (typeof edit.markdown !== "string") throw new InputError('region needs markdown (the new text; "" removes it).');
    const { store, rec, msg } = findRegion(doc.id, edit.ref);
    const loc = locateRegion(doc, rec);
    if (loc.gone) throw new InputError(`${edit.ref}: ${rec.blockId} is no longer in the doc.`);
    if (rec.text === undefined) throw new InputError(`${edit.ref} is a whole ${rec.type} (${rec.blockId}), not text: edit it by id (update/replace).`);
    if (loc.changed) throw new InputError(`${edit.ref} was changed since the message (it read: ${JSON.stringify(clip(rec.text, 160))}). Nothing was saved: read ${rec.blockId} and edit what's there now.`);
    const md = edit.markdown.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
    let before = loc.lines.slice(0, loc.from);
    let after = loc.lines.slice(loc.to + 1);
    // Removing a paragraph leaves one blank line between its neighbours (none at the block's ends); nothing else changes.
    if (!md) {
        if (!after.length) before = before.slice(0, before.findLastIndex((l) => l.trim()) + 1);
        else if (!before.length) after = after.slice(Math.max(0, after.findIndex((l) => l.trim())));
        else if (!before.at(-1).trim() && !after[0].trim()) after = after.slice(1);
    }
    const text = [...before, ...(md ? md.split("\n") : []), ...after].join("\n");
    if (!text.trim()) throw new InputError(`removing ${edit.ref} would leave ${rec.blockId} empty: remove the block instead.`);
    return {
        edit: { type: "update", targetId: rec.blockId, changes: { markdown: text } },
        // Afterwards the ref points at its new text, so the agent can revise it again.
        after: () => {
            if (md) Object.assign(rec, { from: loc.from, text: md });
            else Object.assign(rec, { removed: true });
            saveRegions(doc.id, store);
        },
        note: md ? undefined : `${edit.ref} removed`,
        msg,
    };
}

/** What changed since a version: every element added, removed or modified (Markdown with a line diff), and by whom. */
export function changesSince(docId, sinceVersion, { maxBytes = 30000 } = {}) {
    const doc = getDoc(docId);
    if (!Number.isInteger(sinceVersion) || sinceVersion < 0 || sinceVersion > doc.version) throw new InputError(`sinceVersion must be a version of this doc (0–${doc.version}).`);
    const then = getVersion(docId, sinceVersion);
    const index = (content) => {
        const m = new Map();
        const walk = (list, parentId) => {
            list?.forEach((b, i) => {
                m.set(b.id, { node: b, parentId, kind: b.type, siblings: list, i });
                for (const us of [b.steps, b.nodes, b.edges]) us?.forEach((u, k) => m.set(u.id, { node: u, parentId: b.id, kind: "unit", siblings: us, i: k }));
                if (b.children) walk(b.children, b.id);
            });
        };
        walk(content, null);
        return m;
    };
    const A = index(then.content);
    const B = index(doc.content);
    // Reordered within its parent: the nearest earlier sibling present in both versions differs.
    const prevKept = (x, other) => {
        for (let k = x.i - 1; k >= 0; k--) if (other.has(x.siblings[k].id)) return x.siblings[k].id;
        return null;
    };
    const strip = (n) => stable(ownFields(n));
    const changed = [];
    for (const [id, b] of B) {
        const a = A.get(id);
        if (!a) changed.push({ id, change: "added", type: b.node.type ?? b.kind, parentId: b.parentId });
        else if (strip(a.node) !== strip(b.node) || a.parentId !== b.parentId || prevKept(a, B) !== prevKept(b, A)) {
            const fields = [...new Set([...Object.keys(a.node), ...Object.keys(b.node)])].filter((k) => !["children", "steps", "nodes", "edges"].includes(k) && stable(a.node[k]) !== stable(b.node[k]));
            const moved = a.parentId !== b.parentId || prevKept(a, B) !== prevKept(b, A);
            const c = { id, change: moved ? (fields.length ? "moved+modified" : "moved") : "modified", type: b.node.type ?? b.kind, fields };
            if (typeof a.node.markdown === "string" && typeof b.node.markdown === "string" && a.node.markdown !== b.node.markdown) c.diff = lineDiff(a.node.markdown, b.node.markdown);
            changed.push(c);
        }
    }
    for (const [id, a] of A) if (!B.has(id)) changed.push({ id, change: "removed", type: a.node.type ?? a.kind });
    const versions = history(docId).filter((v) => v.version > sinceVersion).map((v) => ({ version: v.version, by: v.lastEdit?.by === "user" ? "user" : "copilot", reason: v.reason, targetId: v.lastEdit?.targetId ?? null }));
    let out = { documentId: docId, fromVersion: sinceVersion, toVersion: doc.version, versions, changed, ...(then.title !== doc.title ? { title: { from: then.title, to: doc.title } } : {}) };
    if (JSON.stringify(out).length > maxBytes) out = { ...out, changed: changed.map(({ diff, ...c }) => c), note: "diffs left out (too large); read the changed elements by id" };
    return out;
}

/** A compact line diff: "@@ line N" headers, "- old" / "+ new" lines, and one line of context either side. */
export function lineDiff(a, b) {
    const A = a.split("\n");
    const B = b.split("\n");
    const n = A.length;
    const m = B.length;
    if (n * m > 1_000_000) return `(${n} → ${m} lines; too large to diff)`;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) ops.push({ t: " ", s: A[i++], line: ++j });
        else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ t: "-", s: A[i++], line: j + 1 }); // removals first
        else ops.push({ t: "+", s: B[j++], line: j });
    }
    const keep = ops.map((o, k) => o.t !== " " || ops[k - 1]?.t !== " " || ops[k + 1]?.t !== " ");
    const out = [];
    let gap = true;
    ops.forEach((o, k) => {
        if (!keep[k]) return void (gap = true);
        if (gap) out.push(`@@ line ${o.line}`);
        gap = false;
        out.push(`${o.t} ${o.s}`);
    });
    return out.join("\n");
}

/** The doc as it would be after a batch of edits (nothing saved), and what each edit touched. */
export async function previewEdits(docId, edits) {
    const start = getDoc(docId);
    let doc = start;
    const changes = [];
    for (const e of edits) {
        ({ draft: doc } = await applyEditInner(doc, convertEdit(doc, e, start).edit, { dryRun: true }));
        changes.push(doc.lastEdit);
    }
    return { doc, changes, baseVersion: getDoc(docId).version };
}

/** Check a batch of edits against the doc without saving anything (each sees the ones before it). */
export async function checkEdits(docId, edits) {
    const start = getDoc(docId);
    let doc = start;
    for (const [n, e] of edits.entries()) {
        try {
            // Exactly what applyEdits checks, so a batch that passes here applies whole.
            ({ draft: doc } = await applyEditInner(doc, convertEdit(doc, e, start).edit, { dryRun: true }));
        } catch (err) {
            if (!(err instanceof InputError)) throw err;
            throw new InputError(`${edits.length > 1 ? `edits[${n}]: ` : ""}${err.message}`);
        }
    }
    return edits.length;
}

/**
 * The reader edited prose in the panel. Each edit replaces lines [from, to] of a Markdown block with new Markdown
 * ("" deletes them), but only if those lines still read exactly `before`: an edit made against text Copilot has
 * since changed is refused, never merged. All edits land as one version, attributed to the reader.
 */
export function editProse(docId, edits) {
    return withLock(docId, async () => {
        const doc = getDoc(docId);
        if (!Array.isArray(edits) || !edits.length || edits.length > 200) throw new InputError("edits must be a non-empty list.");
        const draft = structuredClone(doc);
        const byBlock = new Map();
        for (const e of edits) {
            if (!e || typeof e.blockId !== "string" || !Number.isInteger(e.from) || !Number.isInteger(e.to) || e.from < 0 || e.to < e.from || typeof e.before !== "string" || typeof e.after !== "string") throw new InputError("Each edit needs blockId, from, to, before and after.");
            if (e.after.length > 20000) throw new InputError("That edit is too long.");
            const hit = locate(draft.content, e.blockId);
            if (!hit || hit.kind === "unit" || hit.kind === "frame" || hit.node.type !== "markdown") throw new InputError(`${e.blockId} is not a Markdown block, so it can't be edited as prose.`);
            if (!byBlock.has(e.blockId)) byBlock.set(e.blockId, { hit, list: [] });
            byBlock.get(e.blockId).list.push(e);
        }
        const changed = [];
        for (const [blockId, { hit, list }] of byBlock) {
            const lines = hit.node.markdown.replace(/\r\n/g, "\n").split("\n");
            // Copilot may have changed other lines meanwhile (a patch above shifts line numbers): follow the text if it
            // only moved, i.e. it occurs exactly once elsewhere. Text that itself changed is still refused below.
            for (const e of list) {
                const want = e.before.replace(/\r\n/g, "\n");
                if (e.to < lines.length && lines.slice(e.from, e.to + 1).join("\n") === want) continue;
                const len = e.to - e.from + 1;
                const at = [];
                for (let k = 0; k + len <= lines.length && at.length < 2; k++) if (lines.slice(k, k + len).join("\n") === want) at.push(k);
                if (at.length === 1) Object.assign(e, { from: at[0], to: at[0] + len - 1 });
            }
            list.sort((x, y) => y.from - x.from);
            for (let k = 1; k < list.length; k++) if (list[k].to >= list[k - 1].from) throw new InputError("Two edits overlap in the same block.");
            for (const e of list) {
                if (e.to >= lines.length || lines.slice(e.from, e.to + 1).join("\n") !== e.before.replace(/\r\n/g, "\n"))
                    throw new InputError(`Copilot changed this text (${blockId}) while you were editing, so your edit wasn't saved. Copy your text, cancel, and edit the new version.`);
                const repl = e.after.replace(/\r\n/g, "\n");
                lines.splice(e.from, e.to - e.from + 1, ...(repl.trim() ? repl.split("\n") : []));
            }
            const markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
            if (!markdown) throw new InputError("A text block can't be left empty; delete the words but keep something, or ask Copilot to remove it.");
            const parsed = parseBlock({ ...hit.node, markdown }, blockId);
            parsed.id = hit.node.id;
            hit.list[hit.index] = parsed;
            await verifySources(draft, parsed);
            changed.push(blockId);
        }
        const topBlock = topBlockOf(draft.content, changed[0])[0];
        draft.version = doc.version + 1;
        draft.lastEdit = { type: "update", targetId: changed[0], blockId: changed[0], topBlockId: topBlock?.id, kind: "markdown", fields: ["markdown"], by: "user", ...(changed.length > 1 ? { blocks: changed } : {}), at: new Date().toISOString() };
        persist(draft, "edit");
        touchActivity(doc.id);
        return { documentId: doc.id, version: draft.version, blocks: changed };
    });
}

export function rename(docId, title) {
    return withLock(docId, async () => {
        const doc = structuredClone(getDoc(docId));
        if (doc.kind === "scratchpad") throw new InputError("The scratchpad cannot be renamed.");
        if (typeof title !== "string" || !title.trim()) throw new InputError("title is required.");
        doc.title = title.trim();
        doc.version++;
        doc.lastEdit = null;
        persist(doc, "rename");
        return summary(doc);
    });
}

export function setTarget(docId, target, pullRequest) {
    return withLock(docId, async () => {
        const doc = structuredClone(getDoc(docId));
        if (doc.kind === "scratchpad") throw new InputError("The scratchpad has no target; put pins on each source instead.");
        doc.target = await normalizeTarget(target);
        if (pullRequest !== undefined) doc.pullRequest = pullRequest;
        doc.version++;
        doc.lastEdit = null;
        // Report references that no longer resolve at the new pins so the agent can repair them.
        const broken = [];
        for (const top of doc.content) {
            try {
                await verifySources(doc, top);
            } catch (e) {
                broken.push({ blockId: top.id, error: e.message });
            }
        }
        persist(doc, "repin");
        return { ...summary(doc), brokenSources: broken };
    });
}

export function restore(docId, version) {
    return withLock(docId, async () => {
        const doc = getDoc(docId);
        const old = getVersion(docId, version);
        const next = { ...structuredClone(old), version: doc.version + 1, nextId: doc.nextId, lastEdit: null };
        delete next.reason;
        persist(next, `restore:${version}`);
        return summary(next);
    });
}

/** Async hooks run before a document's directory is deleted (e.g. Command stops pollers and watchers). */
export const beforeRemove = [];

export function remove(docId) {
    return withLock(docId, async () => {
        const doc = getDoc(docId);
        if (doc.kind === "scratchpad") throw new InputError("The scratchpad cannot be deleted; clear its blocks instead.");
        for (const fn of beforeRemove) {
            try {
                await fn(docId, doc);
            } catch {}
        }
        docs.delete(docId);
        rmSync(dirOf(docId), { recursive: true, force: true });
        emit(docId, { type: "deleted", documentId: docId });
        emit("*", { type: "catalog" });
        return { documentId: docId, deleted: true };
    });
}

export function history(docId) {
    getDoc(docId);
    const dir = join(dirOf(docId), "versions");
    return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => {
            const v = JSON.parse(readFileSync(join(dir, f), "utf8"));
            return { version: v.version, at: v.updatedAt, reason: v.reason, title: v.title, lastEdit: v.lastEdit };
        });
}

export function getVersion(docId, version) {
    getDoc(docId);
    const file = join(dirOf(docId), "versions", `${String(version).padStart(6, "0")}.json`);
    if (!existsSync(file)) throw new InputError(`No version ${version} of ${docId}.`);
    return JSON.parse(readFileSync(file, "utf8"));
}

// ---------- file lenses (Diff view grouping) ----------

function lensMatches(lens, path) {
    return lens.paths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

export async function uncategorized(doc) {
    if (!doc.target) return [];
    const files = await diffFiles(doc.target.repositoryId, doc.target.base, doc.target.head);
    return files.filter((f) => !doc.lenses.some((l) => lensMatches(l, f.path))).map((f) => f.path);
}

export function lensEdit(docId, op) {
    return withLock(docId, async () => {
        const doc = structuredClone(getDoc(docId));
        if (!doc.target) throw new InputError("File lenses group a doc's changed files; this one has no target.");
        const cleanPaths = (p) => {
            if (!Array.isArray(p) || !p.length || p.some((x) => typeof x !== "string" || !x.trim())) throw new InputError("paths must be a non-empty array of repository-relative files or directory prefixes ending in '/'.");
            return p.map((x) => x.trim());
        };
        let targetId;
        if (op.op === "insert") {
            if (typeof op.title !== "string" || !op.title.trim()) throw new InputError("title is required.");
            const lens = { id: `lens-${doc.nextId++}`, title: op.title.trim(), paths: cleanPaths(op.paths), collapsed: !!op.collapsed };
            place(doc.lenses, lens, op);
            targetId = lens.id;
        } else if (op.op === "update") {
            const lens = doc.lenses.find((l) => l.id === op.targetId);
            if (!lens) throw new InputError(`Unknown lens: ${op.targetId}`);
            if (op.title !== undefined) lens.title = String(op.title).trim();
            if (op.paths !== undefined) lens.paths = cleanPaths(op.paths);
            if (op.collapsed !== undefined) lens.collapsed = !!op.collapsed;
            targetId = lens.id;
        } else if (op.op === "remove") {
            const i = doc.lenses.findIndex((l) => l.id === op.targetId);
            if (i < 0) throw new InputError(`Unknown lens: ${op.targetId}`);
            doc.lenses.splice(i, 1);
            targetId = op.targetId;
        } else if (op.op !== "list") throw new InputError("op must be insert, update, remove or list.");
        if (op.op !== "list") {
            doc.version++;
            doc.lastEdit = { type: `lens_${op.op}`, targetId, kind: "lens", at: new Date().toISOString() };
            persist(doc, "lens");
        }
        return { targetId, lenses: doc.lenses, uncategorized: (await uncategorized(doc)).slice(0, 50) };
    });
}

// ---------- activity ("the agent is drawing") ----------

const ACTIVITY_TTL = 120_000;

function activeScopes(docId) {
    const scopes = activity.get(docId);
    if (!scopes) return [];
    const now = Date.now();
    return [...scopes.entries()].filter(([, a]) => a.expiresAt > now).map(([scope, a]) => ({ scope, focus: a.focus, startedAt: a.startedAt }));
}

function touchActivity(docId) {
    const scope = activity.get(docId)?.get("document");
    if (scope) scope.expiresAt = Date.now() + ACTIVITY_TTL;
}

export function setActivity(docId, { action, scope = "document", focus }) {
    getDoc(docId);
    if (!["begin", "renew", "end"].includes(action)) throw new InputError("action must be begin, renew or end.");
    if (!["document", "lenses"].includes(scope)) throw new InputError("scope must be document or lenses.");
    if (!activity.has(docId)) activity.set(docId, new Map());
    const scopes = activity.get(docId);
    if (action === "end") scopes.delete(scope);
    else {
        const prev = scopes.get(scope);
        scopes.set(scope, { focus: focus ?? prev?.focus, startedAt: prev?.startedAt ?? new Date().toISOString(), expiresAt: Date.now() + ACTIVITY_TTL });
    }
    const live = activeScopes(docId);
    emit(docId, { type: "activity", documentId: docId, activity: live });
    emit("*", { type: "catalog" });
    return { documentId: docId, activity: live };
}

setInterval(() => {
    const now = Date.now();
    for (const [docId, scopes] of activity)
        for (const [scope, a] of scopes)
            if (a.expiresAt <= now) {
                scopes.delete(scope);
                emit(docId, { type: "activity", documentId: docId, activity: activeScopes(docId) });
            }
}, 10_000).unref();

// ---------- agent reading view ----------

const clip = (s, n = 90) => {
    const one = String(s ?? "").replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const src = (s) => (s ? `${s.side === "base" ? "base:" : ""}${s.file}#L${s.startLine}${s.endLine && s.endLine !== s.startLine ? `-L${s.endLine}` : ""}` : "");

function outlineBlock(b, depth, lines) {
    const pad = "  ".repeat(depth);
    const head = `${pad}- [${b.id}] ${b.type}`;
    switch (b.type) {
        case "markdown": {
            lines.push(`${head}: ${clip(b.markdown)}`);
            // Headings inside the text, addressable as heading:"A > B" (read, and under edits).
            for (const e of headingIndex({ content: [b] }).filter((x) => x.kind === "heading")) lines.push(`${pad}    ${"#".repeat(e.rank)} ${e.text}  (lines ${e.line + 1}–${e.end + 1})`);
            break;
        }
        case "code":
            lines.push(`${head} (${b.language}): ${clip(b.text, 60)}`);
            break;
        case "section":
        case "callout":
            lines.push(`${head}${b.tone ? ` ${b.tone}` : ""} "${b.title ?? ""}"`);
            b.children.forEach((c) => outlineBlock(c, depth + 1, lines));
            break;
        case "code_peek":
            lines.push(`${head} ${src(b.source)}${b.caption ? ` — ${clip(b.caption, 50)}` : ""}`);
            break;
        case "sequence":
            lines.push(`${head} "${b.title}" actors: ${Object.entries(b.actors).map(([k, v]) => `${k}=${v}`).join(", ")}`);
            for (const s of b.steps) lines.push(`${pad}  - [${s.id}] ${s.from} → ${s.to} (${s.style}): ${clip(s.label, 60)}${s.source ? ` @ ${src(s.source)}` : ""}`);
            break;
        case "flow_diagram":
            lines.push(`${head} "${b.title}"${b.direction ? ` direction=${b.direction}` : ""}`);
            for (const n of b.nodes) lines.push(`${pad}  - [${n.id}] node ${n.key}${n.kind ? ` (${n.kind})` : ""}: ${clip(n.label, 60)}`);
            for (const e of b.edges) lines.push(`${pad}  - [${e.id}] edge ${e.from} → ${e.to}${e.label ? `: ${clip(e.label, 40)}` : ""}`);
            break;
        case "call_stack_diff":
            lines.push(`${head} "${b.title}" base: ${b.base.length} frames, head: ${b.head.length} frames`);
            break;
        case "database_lens":
            lines.push(`${head} "${b.title}" stores: ${Object.keys(b.stores).join(", ")}; use cases: ${b.useCases.map((u) => u.label).join("; ")}`);
            break;
        case "trace_quote":
            lines.push(`${head}${b.role ? ` ${b.role}` : ""}: ${clip(b.text)}`);
            break;
        case "image":
            lines.push(`${head}: ${clip(b.alt, 60)}`);
            break;
        default:
            lines.push(head);
    }
}

export function outline(doc) {
    const lines = [`# ${doc.title}  (documentId: ${doc.id}, version ${doc.version}${doc.kind === "scratchpad" ? ", scratchpad" : ""})`];
    if (doc.target) lines.push(`target: ${doc.target.repositoryId} base ${doc.target.base.slice(0, 10)} → head ${doc.target.head.slice(0, 10)}`);
    if (doc.pullRequest) lines.push(`pull request: ${doc.pullRequest.url}`);
    if (doc.lenses.length) lines.push(`file lenses: ${doc.lenses.map((l) => `[${l.id}] ${l.title}`).join(", ")}`);
    if (!doc.content.length) lines.push("(empty)");
    else lines.push('Address a section or a heading inside text by its path: heading:"Section > Heading" (read {heading}; edit {type:"under", heading, markdown}).');
    doc.content.forEach((b) => outlineBlock(b, 0, lines));
    return lines.join("\n");
}

// ---------- Markdown export: the doc as plain Markdown, diagrams as text, with what it was made from ----------
const srcRef = (s) => (s ? `${s.file}#L${s.startLine}${s.endLine && s.endLine !== s.startLine ? `-L${s.endLine}` : ""}${s.side === "base" ? " (base)" : ""}` : "");
/** Code links inside prose point at repo paths (the header says which commits). */
const plainLinks = (md) => md.replace(/\]\(review-source:(head|base)\/([^)\s]+)\)/g, (_, side, path) => `](${path})${side === "base" ? " (base)" : ""}`);
/** Markdown's own headings sit under the section they're in. */
function shiftHeadings(md, by) {
    const inCode = fenceTracker();
    return md
        .split("\n")
        .map((l) => {
            if (inCode(l) || !by) return l;
            const m = l.match(/^(#{1,6})(\s.*)$/);
            return m ? `${"#".repeat(Math.max(1, Math.min(6, m[1].length + by)))}${m[2]}` : l;
        })
        .join("\n");
}
const fence = (text, lang = "") => {
    const ticks = "`".repeat(Math.max(3, ...(String(text).match(/`+/g) ?? [""]).map((t) => t.length + 1)));
    return `${ticks}${lang}\n${text}\n${ticks}`;
};
function notesMd(notes, pad) {
    return (notes ?? []).flatMap((n) => [`${pad}- ${n.title ? `**${n.title}**${n.text ? ": " : ""}` : ""}${(n.text ?? "").replace(/\n+/g, " ")}${n.source ? ` (${srcRef(n.source)})` : ""}`, ...(n.code ? [fence(n.code.text, n.code.language).replace(/^/gm, `${pad}  `)] : [])]);
}
async function blockMd(b, depth, doc) {
    const h = (t) => `${"#".repeat(Math.min(6, depth + 2))} ${t}`;
    const kids = async (list, d) => (await Promise.all((list ?? []).map((c) => blockMd(c, d, doc)))).filter(Boolean).join("\n\n");
    switch (b.type) {
        case "markdown":
            return shiftHeadings(plainLinks(b.markdown), depth + 1);
        case "section":
            return [h(b.title), await kids(b.children, depth + 1)].filter(Boolean).join("\n\n");
        case "callout": {
            const body = [b.title ? `**${b.title}**${b.tone && b.tone !== "info" ? ` (${b.tone})` : ""}` : null, await kids(b.children, depth + 1)].filter(Boolean).join("\n\n");
            return body.replace(/^/gm, "> ");
        }
        case "divider":
            return "---";
        case "code":
            return [b.caption ? `*${b.caption}*` : null, fence(b.text, b.language === "text" ? "" : b.language)].filter(Boolean).join("\n\n");
        case "code_peek": {
            const s = b.source;
            const pins = s.pins ?? doc.target;
            let body = "";
            try {
                const f = pins?.repositoryId ? await readFileAt(pins.repositoryId, s.side === "base" ? pins.base : pins.head, s.file) : null;
                if (f?.exists && !f.binary) body = f.lines.slice(s.startLine - 1, s.endLine ?? s.startLine).join("\n");
            } catch {}
            return [`*${srcRef(s)}${b.caption ? ` — ${b.caption}` : ""}*`, body ? fence(body, (s.file.split(".").pop() ?? "").toLowerCase()) : null].filter(Boolean).join("\n\n");
        }
        case "sequence": {
            const who = (k) => b.actors[k] ?? k;
            const steps = b.steps.flatMap((s, i) => [
                `${i + 1}. **${who(s.from)} → ${who(s.to)}**${s.style && s.style !== "call" ? ` (${s.style})` : ""}: ${s.label}${s.source ? ` — ${srcRef(s.source)}` : ""}`,
                ...(s.explanation ? [`   ${s.explanation}`] : []),
                ...(s.code ? [fence(s.code.text, s.code.language).replace(/^/gm, "   ")] : []),
                ...notesMd(s.notes, "   "),
            ]);
            return [`**Sequence: ${b.title}**`, `Actors: ${Object.entries(b.actors).map(([k, v]) => `${v} (${k})`).join(", ")}`, steps.join("\n")].join("\n\n");
        }
        case "flow_diagram": {
            const nodes = b.nodes.flatMap((n) => [`- \`${n.key}\`${n.kind ? ` (${n.kind})` : ""}: ${n.label}${n.description ? ` — ${n.description}` : ""}`, ...(n.attachments ?? []).map((a) => `  - ${a.label}: ${a.sources.map(srcRef).join(", ")}`), ...notesMd(n.notes, "  ")]);
            const edges = b.edges.map((e) => `- \`${e.from}\` → \`${e.to}\`${e.label ? `: ${e.label}` : ""}${e.style === "dashed" ? " (dashed)" : ""}`);
            return [`**Flow: ${b.title}**${b.direction ? ` (${b.direction})` : ""}`, b.description ?? null, `Nodes:\n${nodes.join("\n")}`, edges.length ? `Edges:\n${edges.join("\n")}` : null].filter(Boolean).join("\n\n");
        }
        case "call_stack_diff": {
            const tree = (frames) => {
                const out = [];
                const walk = (parent, pad) => frames.filter((f) => (f.parentKey ?? null) === parent).forEach((f) => {
                    out.push(`${pad}- ${f.label ?? f.key ?? srcRef(f.source)}${f.via ? ` (via ${f.via.kind}: ${f.via.reason})` : ""} — ${srcRef(f.source)}`, ...notesMd(f.notes, `${pad}  `));
                    if (f.key) walk(f.key, `${pad}  `);
                });
                walk(null, "");
                return out.join("\n") || "(none)";
            };
            return [`**Call stack: ${b.title}**`, `Before:\n${tree(b.base)}`, `After:\n${tree(b.head)}`].join("\n\n");
        }
        case "database_lens": {
            const fieldsMd = (fs, pad) => Object.entries(fs ?? {}).flatMap(([k, f]) => [`${pad}- \`${k}\` ${f.dataType}${f.primaryKey ? " PK" : ""}${f.nullable ? " null" : ""}${f.references ? ` → ${f.references.store}.${f.references.collection}.${f.references.field}` : ""}`, ...fieldsMd(f.fields, `${pad}  `)]);
            const stores = Object.entries(b.stores).flatMap(([k, s]) => [`- **${s.label}** (${s.storage})`, ...Object.entries(s.collections).flatMap(([ck, c]) => [`  - ${c.label} (\`${ck}\`)`, ...fieldsMd(c.fields, "    ")])]);
            const uses = b.useCases.flatMap((u) => [`- **${u.label}**${u.summary ? `: ${u.summary}` : ""}`, ...u.operations.map((o) => `  - ${o.kind} ${o.store}.${o.collection}${o.field ? `.${o.field}` : ""} by ${o.actor}: ${o.label} — ${srcRef(o.source)}`)]);
            return [`**Data: ${b.title}**`, `Stores:\n${stores.join("\n")}`, `Use cases:\n${uses.join("\n")}`].join("\n\n");
        }
        case "trace_quote":
            return `> ${b.role ? `**${b.role}:** ` : ""}${b.text.replace(/\n/g, "\n> ")}${b.attribution ? `\n>\n> — ${b.attribution}` : ""}`;
        case "image":
            return `![${b.alt}](${b.url.startsWith("data:") ? "(embedded image)" : b.url})${b.caption ? `\n\n*${b.caption}*` : ""}`;
        default:
            return `*(${b.type})*`;
    }
}
/**
 * The doc (or one heading's part of it) as Markdown. The header records what it was made from: doc id and version,
 * the repository and its base/head commits, and a sha256 of the body, so a copy can be checked against the doc.
 */
export async function docMarkdown(docId, { heading } = {}) {
    const doc = getDoc(docId);
    let body;
    let scope = null;
    if (heading !== undefined) {
        const e = resolveHeading(doc, heading);
        scope = e.path.join(" > ");
        if (e.kind === "heading") {
            const md = locate(doc.content, e.blockId).node.markdown.split("\n");
            body = shiftHeadings(plainLinks([`${"#".repeat(e.rank)} ${e.text}`, ...md.slice(e.line + 1, e.end + 1)].join("\n")), 1 - e.rank + 1);
        } else body = await blockMd(locate(doc.content, e.blockId).node, 0, doc);
    } else body = [`# ${doc.title}`, ...(await Promise.all(doc.content.map((b) => blockMd(b, 0, doc))))].join("\n\n");
    body = `${body.replace(/\n{3,}/g, "\n\n").trim()}\n`;
    const sha256 = createHash("sha256").update(body).digest("hex");
    const t = doc.target;
    const repo = t ? (() => { try { return getRepository(t.repositoryId).name; } catch { return t.repositoryId; } })() : null;
    const q = (s) => JSON.stringify(String(s));
    const header = [
        "---",
        "marginal:",
        `  documentId: ${q(doc.id)}`,
        `  title: ${q(doc.title)}`,
        `  version: ${doc.version}`,
        ...(scope ? [`  heading: ${q(scope)}`] : []),
        ...(t ? [`  repository: ${q(repo)}`, `  base: ${t.base}${t.baseRef ? `  # ${t.baseRef}` : ""}`, `  head: ${t.head}${t.headRef ? `  # ${t.headRef}` : ""}`] : []),
        ...(doc.pullRequest ? [`  pullRequest: ${q(doc.pullRequest.url)}`] : []),
        `  exportedAt: ${q(new Date().toISOString())}`,
        `  sha256: ${sha256}  # of the Markdown below this header`,
        "---",
        "",
    ].join("\n");
    return { markdown: header + body, body, sha256, version: doc.version, base: t?.base ?? null, head: t?.head ?? null };
}
/** Write the doc's Markdown to a file (an absolute path ending in .md or .markdown). */
export async function exportDoc(docId, { path, heading } = {}) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new InputError("path must be an absolute file path, e.g. C:\\work\\plan.md or /tmp/plan.md.");
    if (!/\.(md|markdown)$/i.test(path)) throw new InputError("path must end in .md or .markdown.");
    const out = await docMarkdown(docId, { heading });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out.markdown);
    return { path, bytes: Buffer.byteLength(out.markdown), sha256: out.sha256, version: out.version, base: out.base, head: out.head, ...(heading !== undefined ? { heading } : {}) };
}

export { BLOCK_TYPES };
