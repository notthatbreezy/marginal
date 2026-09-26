// Whiteboard block model: validation, normalization, ID assignment and source discovery.
// Portions adapted from devdotfast/whiteboard (MIT, (c) 2026 dev.fast); see THIRD-PARTY-NOTICES.txt.
// Block vocabulary follows devdotfast/whiteboard (MIT) so agent prompts transfer.
import { InputError } from "./errors.mjs";

// ---------- tiny validator DSL ----------

const fail = (path, msg) => {
    throw new InputError(`${path || "content"}: ${msg}`);
};

const text = (v, p) => (typeof v === "string" ? v : fail(p, "expected a string"));
const label = (v, p) => {
    if (typeof v !== "string" || !v.trim()) fail(p, "expected a non-empty string");
    return v.trim();
};
const bool = (v, p) => (typeof v === "boolean" ? v : fail(p, "expected a boolean"));
const posInt = (v, p) => (Number.isInteger(v) && v > 0 ? v : fail(p, "expected a positive integer"));
const oneOf = (values) => (v, p) => (values.includes(v) ? v : fail(p, `expected one of ${values.join(", ")}`));
const literal = (value) => (v, p) => (v === value ? v : fail(p, `expected ${JSON.stringify(value)}`));
const opt = (validator) => Object.assign((v, p) => validator(v, p), { optional: true });
const dflt = (validator, value) => Object.assign((v, p) => validator(v === undefined ? structuredClone(value) : v, p), { hasDefault: true });
const nullable = (validator) => Object.assign((v, p) => (v === null ? null : validator(v, p)), { optional: true });
const array =
    (validator, { min = 0, max = 2000 } = {}) =>
    (v, p) => {
        if (!Array.isArray(v)) fail(p, "expected an array");
        if (v.length < min) fail(p, `needs at least ${min} item(s)`);
        if (v.length > max) fail(p, `allows at most ${max} items`);
        return v.map((item, i) => validator(item, `${p}[${i}]`));
    };
const record =
    (validator, { min = 0 } = {}) =>
    (v, p) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) fail(p, "expected an object map");
        const entries = Object.entries(v);
        if (entries.length < min) fail(p, `needs at least ${min} entr${min === 1 ? "y" : "ies"}`);
        return Object.fromEntries(entries.map(([k, item]) => [label(k, `${p} key`), validator(item, `${p}.${k}`)]));
    };
const object = (shape) => {
    const fn = (v, p) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) fail(p, "expected an object");
        for (const key of Object.keys(v)) if (!(key in shape)) fail(p, `unknown field "${key}" (allowed: ${Object.keys(shape).join(", ")})`);
        const out = {};
        for (const [key, validator] of Object.entries(shape)) {
            const value = v[key];
            if (value === undefined && !validator.hasDefault) {
                if (validator.optional) continue;
                fail(`${p}.${key}`, "is required");
            }
            const parsed = validator(value, `${p}.${key}`);
            if (parsed !== undefined) out[key] = parsed;
        }
        return out;
    };
    fn.shape = shape;
    return fn;
};
const refine = (validator, check) => (v, p) => {
    const out = validator(v, p);
    const msg = check(out);
    if (msg) fail(p, msg);
    return out;
};
const lazy = (get) => (v, p) => get()(v, p);

// ---------- shared shapes ----------

const id = opt(text);

export const pinsSchema = object({ repositoryId: label, head: label, base: opt(label) });

export const sourceSchema = refine(
    object({
        file: label,
        side: opt(oneOf(["head", "base"])),
        startLine: posInt,
        endLine: opt(posInt),
        pins: opt(pinsSchema),
    }),
    (s) => (s.endLine !== undefined && s.endLine < s.startLine ? "endLine is before startLine" : s.side === "base" && s.pins && !s.pins.base ? "a base-side source needs base pins" : null),
);

const codeFields = { language: dflt(text, "text"), text };

// ---------- block schemas ----------

const block = lazy(() => blockValidator);

export const stepSchema = refine(
    object({
        id,
        type: dflt(literal("step"), "step"),
        from: label,
        to: label,
        label,
        style: dflt(oneOf(["call", "return", "async"]), "call"),
        source: opt(sourceSchema),
        explanation: opt(label),
        code: opt(object(codeFields)),
    }),
    (s) => (s.source && s.code ? "a step takes source or code, not both (explanation can accompany either)" : null),
);

export const flowNodeSchema = object({
    id,
    type: dflt(literal("flow_node"), "flow_node"),
    key: label,
    label,
    description: opt(text),
    kind: opt(oneOf(["process", "decision", "terminal"])),
    attachments: dflt(array(object({ label, sources: array(sourceSchema, { min: 1 }) })), []),
});

export const flowEdgeSchema = object({
    id,
    type: dflt(literal("flow_edge"), "flow_edge"),
    from: label,
    to: label,
    label: opt(text),
    style: opt(oneOf(["solid", "dashed"])),
});

const flowLinkSchema = object({ from: opt(label), to: opt(label), label: opt(text), style: opt(oneOf(["solid", "dashed"])) });
export const flowNodeInsertSchema = object({ ...flowNodeSchema.shape, link: opt(flowLinkSchema) });

const frameSchema = object({
    id,
    key: opt(label),
    parentKey: nullable(label),
    callSite: opt(sourceSchema),
    source: sourceSchema,
    label: opt(label),
    via: opt(object({ kind: oneOf(["call", "queue", "callback", "rpc"]), reason: label })),
});

const fieldSchema = lazy(() => dbField);
const dbField = object({
    label,
    dataType: label,
    nullable: opt(bool),
    primaryKey: opt(bool),
    references: opt(object({ store: label, collection: label, field: label })),
    example: opt((v) => v),
    fields: opt(record(fieldSchema)),
});

const operationSchema = object({
    id,
    kind: oneOf(["read", "write"]),
    store: label,
    collection: label,
    field: opt(label),
    actor: label,
    label,
    detail: opt(label),
    source: sourceSchema,
});

const imageUrl = (v, p) => {
    const s = label(v, p);
    if (/^https:\/\//i.test(s) || /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
    return fail(p, "must be an https:// URL or a base64 data:image URL");
};

const schemas = {
    markdown: object({ id, type: literal("markdown"), markdown: text, pins: opt(pinsSchema) }),
    code: object({ id, type: literal("code"), ...codeFields, caption: opt(text) }),
    divider: object({ id, type: literal("divider") }),
    callout: object({ id, type: literal("callout"), title: opt(label), tone: dflt(oneOf(["info", "warning", "danger", "success"]), "info"), children: dflt(array(block), []) }),
    section: object({ id, type: literal("section"), title: label, defaultCollapsed: opt(bool), children: dflt(array(block), []) }),
    code_peek: object({ id, type: literal("code_peek"), source: sourceSchema, caption: opt(text), diff: opt(bool) }),
    sequence: object({ id, type: literal("sequence"), title: label, actors: record(label, { min: 1 }), steps: dflt(array(stepSchema), []) }),
    flow_diagram: object({
        id,
        type: literal("flow_diagram"),
        title: label,
        description: opt(text),
        direction: opt(oneOf(["right", "down"])),
        nodes: array(flowNodeSchema, { min: 1, max: 100 }),
        edges: dflt(array(flowEdgeSchema, { max: 300 }), []),
    }),
    call_stack_diff: object({ id, type: literal("call_stack_diff"), title: label, base: dflt(array(frameSchema), []), head: dflt(array(frameSchema), []) }),
    database_lens: object({
        id,
        type: literal("database_lens"),
        title: label,
        actors: record((v, p) => (typeof v === "string" ? label(v, p) : object({ label, softwareMapPath: opt(label) })(v, p))),
        stores: record(
            object({
                label,
                storage: oneOf(["relational", "document"]),
                dataStoreKind: opt(oneOf(["database", "objectStore", "bucket", "artifactStore", "fileStore"])),
                softwareMapPath: opt(label),
                collections: record(object({ label, key: opt(label), fields: record(fieldSchema) })),
            }),
            { min: 1 },
        ),
        useCases: array(object({ id, label, summary: opt(text), operations: array(operationSchema, { min: 1 }) }), { min: 1 }),
    }),
    trace_quote: object({ id, type: literal("trace_quote"), text: label, role: opt(oneOf(["user", "assistant", "tool"])), attribution: opt(text), traceId: opt(text), eventId: opt(text) }),
    image: object({ id, type: literal("image"), url: imageUrl, alt: label, caption: opt(text) }),
};

export const BLOCK_TYPES = Object.keys(schemas);
export const CONTAINER_TYPES = ["section", "callout"];
export const UNIT_TYPES = { step: "sequence", flow_node: "flow_diagram", flow_edge: "flow_diagram" };

const blockValidator = (v, p) => {
    if (!v || typeof v !== "object") fail(p, "expected a block object");
    const schema = schemas[v.type];
    if (!schema) fail(`${p}.type`, `unknown block type ${JSON.stringify(v.type)} (known: ${BLOCK_TYPES.join(", ")})`);
    return schema(v, p);
};

// ---------- relationship checks ----------

const requireKey = (rec, key, what) => {
    if (!Object.hasOwn(rec, key)) throw new InputError(`Unknown ${what}: ${key} (known: ${Object.keys(rec).join(", ") || "none"})`);
};

export function checkBlock(b) {
    switch (b.type) {
        case "sequence":
            for (const s of b.steps) {
                requireKey(b.actors, s.from, "sequence actor");
                requireKey(b.actors, s.to, "sequence actor");
            }
            break;
        case "flow_diagram": {
            const keys = new Set(b.nodes.map((n) => n.key));
            if (keys.size !== b.nodes.length) throw new InputError("Flow node keys must be unique within the diagram.");
            for (const e of b.edges) if (!keys.has(e.from) || !keys.has(e.to)) throw new InputError(`Unknown flow endpoint: ${e.from} → ${e.to}`);
            break;
        }
        case "call_stack_diff":
            for (const side of ["base", "head"]) {
                const seen = new Set();
                for (const f of b[side]) {
                    if (f.parentKey && !seen.has(f.parentKey)) throw new InputError(`A frame parentKey must name an earlier frame on the same side (${side}: ${f.parentKey}).`);
                    if (f.key) {
                        if (seen.has(f.key)) throw new InputError(`Frame keys must be unique within ${side}: ${f.key}`);
                        seen.add(f.key);
                    }
                }
            }
            break;
        case "database_lens": {
            const field = (store, collection, name) => {
                requireKey(b.stores, store, "store");
                const cols = b.stores[store].collections;
                requireKey(cols, collection, `collection in ${store}`);
                if (name === undefined) return;
                let fields = cols[collection].fields;
                for (const part of name.split(".")) {
                    if (!fields) throw new InputError(`Unknown field: ${name}`);
                    requireKey(fields, part, `field in ${store}.${collection}`);
                    fields = fields[part].fields;
                }
            };
            for (const uc of b.useCases)
                for (const op of uc.operations) {
                    requireKey(b.actors, op.actor, "actor");
                    field(op.store, op.collection, op.field);
                }
            for (const s of Object.values(b.stores))
                for (const c of Object.values(s.collections))
                    for (const f of Object.values(c.fields)) if (f.references) field(f.references.store, f.references.collection, f.references.field);
            break;
        }
    }
    if (b.children) b.children.forEach(checkBlock);
}

export function parseBlock(content, path = "content") {
    const b = blockValidator(content, path);
    if (b.type === "call_stack_diff") for (const f of b.base) for (const s of [f.source, f.callSite]) if (s && !s.side) s.side = "base";
    checkBlock(b);
    return b;
}

export function parseUnit(content, path = "content") {
    if (!content || typeof content !== "object") fail(path, "expected an object");
    if (content.type === "step") return stepSchema(content, path);
    if (content.type === "flow_node") return flowNodeInsertSchema(content, path);
    if (content.type === "flow_edge") return flowEdgeSchema(content, path);
    return fail(`${path}.type`, `expected step, flow_node or flow_edge`);
}

// ---------- IDs ----------

const PREFIX = {
    markdown: "md",
    code: "code",
    divider: "hr",
    callout: "note",
    section: "sec",
    code_peek: "peek",
    sequence: "seq",
    step: "step",
    flow_diagram: "flow",
    flow_node: "node",
    flow_edge: "edge",
    call_stack_diff: "stack",
    database_lens: "db",
    trace_quote: "quote",
    image: "img",
};

/** Assign fresh IDs to a block and every addressable part of it. */
export function assignIds(b, nextId, kind = b.type, { onlyMissing = false } = {}) {
    const give = (o, prefix) => {
        if (!onlyMissing || !o.id) o.id = `${prefix}-${nextId()}`;
    };
    const opts = { onlyMissing };
    give(b, PREFIX[kind] ?? "blk");
    if (b.children) b.children.forEach((c) => assignIds(c, nextId, c.type, opts));
    if (b.type === "sequence") b.steps.forEach((s) => assignIds(s, nextId, "step", opts));
    if (b.type === "flow_diagram") {
        b.nodes.forEach((n) => assignIds(n, nextId, "flow_node", opts));
        b.edges.forEach((e) => assignIds(e, nextId, "flow_edge", opts));
    }
    if (b.type === "call_stack_diff") [...b.base, ...b.head].forEach((f) => give(f, "frame"));
    if (b.type === "database_lens")
        b.useCases.forEach((uc) => {
            give(uc, "uc");
            uc.operations.forEach((op) => give(op, "op"));
        });
    return b;
}

// ---------- source references ----------

const SOURCE_LINK = /review-source:(head|base)\/([^\s)#]+)(?:#L(\d+)(?:-L(\d+))?)?/g;

export function markdownSourceLinks(md) {
    const stripped = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    const out = [];
    for (const m of stripped.matchAll(SOURCE_LINK)) {
        let file;
        try {
            file = decodeURIComponent(m[2]);
        } catch {
            throw new InputError(`Malformed review-source link: ${m[0]}`);
        }
        out.push({ file, side: m[1], startLine: m[3] ? Number(m[3]) : undefined, endLine: m[4] ? Number(m[4]) : m[3] ? Number(m[3]) : undefined, link: m[0] });
    }
    return out;
}

export function checkMarkdownLinks(md) {
    const stripped = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const m of stripped.matchAll(/\]\(\s*([^)\s]+)[^)]*\)/g)) {
        const href = m[1];
        if (/^(https?:|mailto:|#|review-source:)/i.test(href)) continue;
        throw new InputError(`Unsupported link target ${JSON.stringify(href)}. Use review-source:head/path#L10-L20 for code, https:// for external links, or #heading.`);
    }
}

/** Every source reference inside a block (or unit), paired with the pins it inherits. */
export function* sourcesOf(b, inheritedPins) {
    if (!b || typeof b !== "object") return;
    switch (b.type) {
        case "markdown":
            checkMarkdownLinks(b.markdown);
            for (const s of markdownSourceLinks(b.markdown)) yield { source: { ...s, pins: b.pins }, where: b.id, fromMarkdown: true };
            break;
        case "code_peek":
            yield { source: b.source, where: b.id, visible: true };
            break;
        case "sequence":
            for (const s of b.steps) yield* sourcesOf(s);
            break;
        case "step":
            if (b.source) yield { source: b.source, where: b.id };
            break;
        case "flow_diagram":
            for (const n of b.nodes) yield* sourcesOf(n);
            break;
        case "flow_node":
            for (const a of b.attachments ?? []) for (const s of a.sources) yield { source: s, where: b.id };
            break;
        case "call_stack_diff":
            for (const side of ["base", "head"])
                for (const f of b[side]) {
                    yield { source: f.source, where: f.id ?? f.key };
                    if (f.callSite) yield { source: f.callSite, where: f.id ?? f.key };
                    for (const s of f.contextSources ?? []) yield { source: s, where: f.id };
                }
            break;
        case "database_lens":
            for (const uc of b.useCases) for (const op of uc.operations) yield { source: op.source, where: op.id ?? uc.label };
            break;
    }
    if (b.children) for (const c of b.children) yield* sourcesOf(c, inheritedPins);
}

// ---------- tree helpers ----------

/** Locate any addressable element: blocks (with their container list) or diagram units. */
export function locate(content, targetId) {
    const visit = (list, parent) => {
        for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (b.id === targetId) return { kind: "block", node: b, list, index: i, parent };
            if (b.type === "sequence") {
                const j = b.steps.findIndex((s) => s.id === targetId);
                if (j >= 0) return { kind: "unit", node: b.steps[j], list: b.steps, index: j, parent: b, block: b };
            }
            if (b.type === "flow_diagram") {
                for (const key of ["nodes", "edges"]) {
                    const j = b[key].findIndex((s) => s.id === targetId);
                    if (j >= 0) return { kind: "unit", node: b[key][j], list: b[key], index: j, parent: b, block: b };
                }
            }
            if (b.children) {
                const hit = visit(b.children, b);
                if (hit) return hit;
            }
        }
        return null;
    };
    return visit(content, null);
}

export function topBlockOf(content, targetId) {
    const path = [];
    const visit = (list) => {
        for (const b of list) {
            path.push(b);
            if (b.id === targetId) return true;
            if (b.type === "sequence" && b.steps.some((s) => s.id === targetId)) return true;
            if (b.type === "flow_diagram" && [...b.nodes, ...b.edges].some((s) => s.id === targetId)) return true;
            if (b.children && visit(b.children)) return true;
            path.pop();
        }
        return false;
    };
    visit(content);
    return path;
}

export function walkBlocks(content, fn, depth = 0) {
    for (const b of content) {
        fn(b, depth);
        if (b.children) walkBlocks(b.children, fn, depth + 1);
    }
}
