// Durable whiteboard store: one JSON file per whiteboard plus immutable version snapshots.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assignIds, BLOCK_TYPES, checkBlock, CONTAINER_TYPES, flowEdgeSchema, locate, parseBlock, parseUnit, sourcesOf, stepSchema, flowNodeSchema, topBlockOf, UNIT_TYPES, walkBlocks } from "./blocks.mjs";
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
    return join(paths.whiteboards, id);
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
    for (const name of readdirSync(paths.whiteboards, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        const file = join(paths.whiteboards, name.name, "current.json");
        if (!existsSync(file)) continue;
        try {
            const doc = JSON.parse(readFileSync(file, "utf8"));
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
    if (!doc) throw new InputError(`Unknown whiteboard: ${id}. Use list to see whiteboards.`);
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
            .slice(0, 40) || "whiteboard"
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
    const doc = { id, kind: "whiteboard", title: title.trim(), createdAt: now, updatedAt: now, version: 0, nextId: 1, target: await normalizeTarget(target), pullRequest: pullRequest ?? null, content: [], lenses: [], lastEdit: null };
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
        if (!pins) throw new InputError(`Source ${where} has no pins and this ${doc.kind === "scratchpad" ? "scratchpad" : "whiteboard"} has no target. Add pins {repositoryId, head[, base]} from resolve_pins.`);
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

async function applyEditInner(doc, edit) {
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
            const changes = edit.changes;
            if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new InputError("update needs a changes object.");
            for (const key of ["id", "type", "children", "steps", "nodes", "edges"])
                if (key in changes) throw new InputError(`update cannot change ${key}; use insert/move/remove on children, or replace.`);
            const merged = { ...hit.node };
            for (const [k, v] of Object.entries(changes)) {
                if (v === null) delete merged[k];
                else merged[k] = v;
            }
            let parsed;
            if (hit.kind === "unit") {
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
            verifyTarget = parsed;
            break;
        }
        case "replace": {
            const hit = locate(draft.content, edit.targetId ?? "");
            if (!hit) throw new InputError(`Unknown targetId: ${edit.targetId}`);
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
    persist(draft, "edit");
    touchActivity(doc.id);
    const el = edit.type === "remove" ? null : locate(draft.content, targetId)?.node;
    return { documentId: doc.id, version: draft.version, targetId, type: kind, ...(linkId ? { linkId } : {}), ...(el ? { children: childrenSummary(el) } : {}) };
}

export function applyEdit(docId, edit) {
    return withLock(docId, () => applyEditInner(getDoc(docId), edit));
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

export function remove(docId) {
    return withLock(docId, async () => {
        const doc = getDoc(docId);
        if (doc.kind === "scratchpad") throw new InputError("The scratchpad cannot be deleted; clear its blocks instead.");
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
        if (!doc.target) throw new InputError("File lenses group a whiteboard's changed files; this one has no target.");
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
        case "markdown":
            lines.push(`${head}: ${clip(b.markdown)}`);
            break;
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
    doc.content.forEach((b) => outlineBlock(b, 0, lines));
    return lines.join("\n");
}

export { BLOCK_TYPES };
