import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PHRASE = "updating VSCode";
export const REFERENCE = '<copilot-ref kind="session" target-id="synthetic-session-1" label="Build helper" />';
export const STORE_URL = new URL("../../extensions/marginal/lib/store.mjs", import.meta.url).href;
const fixtureParent = fileURLToPath(new URL("../", import.meta.url));

export const time = (day) => `${day}T10:00:00.000Z`;
export function page(id, overrides = {}) {
    return {
        id, kind: "doc", title: "Other", version: 0, nextId: 100,
        createdAt: time("2026-10-01"), updatedAt: time("2026-10-05"),
        target: null, pullRequest: null, lenses: [], lastEdit: null,
        content: [{ id: "md-1", type: "markdown", markdown: PHRASE }],
        ...overrides,
    };
}

export function canonicalPages() {
    const row = (id, title, markdown, created, updated, extra = {}) => page(id, {
        title, content: [{ id: "md-1", type: "markdown", markdown }],
        createdAt: time(`2026-10-${created}`), updatedAt: time(`2026-10-${updated}`), ...extra,
    });
    return [
        row("a-title-phrase", "Updating VSCode", "Guide.", "01", "05"),
        row("b-body-phrase", "Editor guide", "Updating VSCode. Updating VSCode.", "06", "06"),
        row("c-body-phrase", "Notes", PHRASE, "04", "07"),
        row("d-title-separated", "VSCode notes on updating", "Intro.", "03", "08"),
        row("e-title-one", "Updating notes", "VSCode setup", "05", "09"),
        row("f-cross-fields", "Workflow", "", "02", "10", { content: [{ id: "sec-1", type: "section", title: "updating", children: [{ id: "md-2", type: "markdown", markdown: "VSCode" }] }] }),
        row("g-body-reversed", "Workflow", "VSCode before updating", "02", "10"),
        row("h-one-token", "Editor", "VSCode setup", "07", "11"),
        row("i-history-only", "Other", "Nothing", "08", "12"),
        row("j-archived", "Updating VSCode Archive", PHRASE, "09", "13", { archivedAt: time("2026-10-14") }),
        row("k-equal-phrase", "Notes", PHRASE, "04", "07"),
    ];
}

export function directoryBytes(root) {
    const files = {};
    const visit = (dir, prefix = "") => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const relative = prefix ? join(prefix, entry.name) : entry.name;
            if (entry.isDirectory()) visit(join(dir, entry.name), relative);
            else files[relative] = createHash("sha256").update(readFileSync(join(dir, entry.name))).digest("hex");
        }
    };
    visit(root);
    return files;
}

export function fixture(documents, { snapshots = {}, attachments = {} } = {}) {
    // Owned synthetic data stays in the checkout, never in the user's Marginal data or an OS temp directory.
    const root = join(fixtureParent, `.pages-run-${randomUUID()}`);
    mkdirSync(root);
    const json = (file, value) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(value, null, 1));
    };
    const pad = page("scratchpad", { kind: "scratchpad", title: "Scratchpad", content: [], nextId: 1 });
    for (const doc of [pad, ...documents]) {
        const dir = join(root, "docs", doc.id);
        json(join(dir, "current.json"), doc);
        for (const snapshot of snapshots[doc.id] ?? [{ ...doc, reason: "create" }])
            json(join(dir, "versions", `${String(snapshot.version).padStart(6, "0")}.json`), snapshot);
    }
    for (const [file, text] of Object.entries(attachments)) {
        const path = resolve(root, file);
        assert.ok(path.startsWith(root + sep), "fixture attachment must be inside owned root");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
    }
    return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Execute real storage in a fresh process, with no inherited process-local document cache. */
export function storeProbe(root, source) {
    const script = `
        import assert from "node:assert/strict";
        import { readFileSync, readdirSync } from "node:fs";
        import { join } from "node:path";
        import { directoryBytes, storeProbe } from ${JSON.stringify(import.meta.url)};
        import * as store from ${JSON.stringify(STORE_URL)};
        const root = process.env.MARGINAL_DATA_DIR;
        const ordinary = (raw) => {
            const rows = store.list(raw);
            assert.equal(rows[0].documentId, "scratchpad");
            return rows.slice(1).map(row => row.documentId);
        };
        ${source}
    `;
    const result = spawnSync(process.execPath, ["--input-type=module"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, MARGINAL_DATA_DIR: root },
        input: script, encoding: "utf8", timeout: 30_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

const source = { file: "synthetic-unread.txt", startLine: 1, pins: { repositoryId: "synthetic-unregistered", head: "a".repeat(40) } };
const frame = () => ({ source, label: "Other", via: { kind: "call", reason: "Other" }, notes: [{ title: "Other", text: "Other", code: { text: "Other" } }] });
const step = () => ({ from: "actor", to: "actor", label: "Other", explanation: "Other", code: { text: "Other" }, notes: [{ title: "Other", text: "Other", code: { text: "Other" } }] });
const database = () => ({
    type: "database_lens", title: "Other",
    actors: { actor: "Other", objectActor: { label: "Other", softwareMapPath: "excluded" } },
    stores: { store: { label: "Other", storage: "document", collections: {
        collection: { label: "Other", fields: { field: { label: "Other", dataType: "Other", fields: { nested: { label: "Other", dataType: "Other" } } } } },
    } } },
    useCases: [{ label: "Other", summary: "Other", operations: [{ kind: "read", store: "store", collection: "collection", actor: "actor", label: "Other", detail: "Other", source }] }],
});

export function includedCases() {
    const cases = [];
    const add = (name, block, path, value = PHRASE) => {
        const copy = structuredClone(block);
        if (path) {
            const parts = path.split(".");
            let target = copy;
            for (const part of parts.slice(0, -1)) target = target[part];
            target[parts.at(-1)] = value;
        }
        cases.push({ name, doc: page(`inc-${name}`, { title: "Unrelated", content: [copy] }) });
    };
    add("markdown-long", { type: "markdown", markdown: "x".repeat(200) + PHRASE });
    add("markdown-nested", { type: "section", title: "Other", children: [{ type: "callout", title: "Other", children: [{ type: "markdown", markdown: PHRASE }] }] });
    for (const type of ["section", "callout"]) add(`${type}-title`, { type, title: "Other", children: [] }, "title");
    for (const path of ["text", "caption"]) add(`code-${path}`, { type: "code", text: "Other", caption: "Other" }, path);
    add("peek-caption", { type: "code_peek", source, caption: "Other" }, "caption");
    const sequence = { type: "sequence", title: "Other", actors: { actor: "Other" }, steps: [step()] };
    for (const path of ["title", "actors.actor", "steps.0.label", "steps.0.explanation", "steps.0.code.text"])
        add(`sequence-${path}`, sequence, path);
    const flow = { type: "flow_diagram", title: "Other", description: "Other", nodes: [{ key: "node", label: "Other", description: "Other", attachments: [{ label: "Other", sources: [source] }], notes: [{ title: "Other", text: "Other", code: { text: "Other" } }] }], edges: [{ from: "node", to: "node", label: "Other" }] };
    for (const path of ["title", "description", "nodes.0.label", "nodes.0.description", "nodes.0.attachments.0.label", "edges.0.label"])
        add(`flow-${path}`, flow, path);
    const stack = { type: "call_stack_diff", title: "Other", base: [frame()], head: [frame()] };
    add("stack-title", stack, "title");
    for (const side of ["base", "head"]) {
        for (const path of ["label", "via.reason"]) add(`stack-${side}-${path}`, stack, `${side}.0.${path}`);
    }
    for (const [owner, block, prefix] of [["sequence", sequence, "steps.0"], ["flow", flow, "nodes.0"], ["base", stack, "base.0"], ["head", stack, "head.0"]]) {
        for (const path of ["title", "text", "code.text"]) add(`note-${owner}-${path}`, block, `${prefix}.notes.0.${path}`);
    }
    for (const path of ["title", "actors.actor", "actors.objectActor.label", "stores.store.label", "stores.store.collections.collection.label", "stores.store.collections.collection.fields.field.label", "stores.store.collections.collection.fields.field.dataType", "stores.store.collections.collection.fields.field.fields.nested.label", "stores.store.collections.collection.fields.field.fields.nested.dataType", "useCases.0.label", "useCases.0.summary", "useCases.0.operations.0.label", "useCases.0.operations.0.detail"])
        add(`database-${path}`, database(), path);
    for (const example of [PHRASE, { explanation: PHRASE }]) {
        add(`database-example-${typeof example}-${String(example)}`, database(), "stores.store.collections.collection.fields.field.example", example);
    }
    for (const path of ["text", "attribution"]) add(`quote-${path}`, { type: "trace_quote", text: "Other", attribution: "Other" }, path);
    for (const path of ["alt", "caption"]) add(`image-${path}`, { type: "image", url: "https://example.invalid/unread.png", alt: "Other", caption: "Other" }, path);
    add("reference-label", { type: "markdown", markdown: '<copilot-ref kind="session" target-id="synthetic-other" label="updating VSCode" />' });
    return cases;
}

export function excludedCases() {
    // Enum/flag/source-pin/future-type adversaries below are raw-loader boundary records,
    // not schema-valid author writes. Included-field cases are separately schema-checked.
    const unrelated = { type: "markdown", markdown: "Other" };
    const db = database();
    db.actors.objectActor.softwareMapPath = PHRASE;
    db.stores.store.softwareMapPath = PHRASE;
    db.stores.store.collections.collection.key = PHRASE;
    db.stores.store.collections.collection.fields.field.references = { store: "store", collection: "collection", field: "field" };
    const keyed = database();
    keyed.actors[PHRASE] = keyed.actors.actor;
    delete keyed.actors.actor;
    keyed.stores[PHRASE] = keyed.stores.store;
    delete keyed.stores.store;
    keyed.stores[PHRASE].collections[PHRASE] = keyed.stores[PHRASE].collections.collection;
    delete keyed.stores[PHRASE].collections.collection;
    keyed.stores[PHRASE].collections[PHRASE].fields[PHRASE] = keyed.stores[PHRASE].collections[PHRASE].fields.field;
    delete keyed.stores[PHRASE].collections[PHRASE].fields.field;
    const field = keyed.stores[PHRASE].collections[PHRASE].fields[PHRASE];
    field.references = { store: PHRASE, collection: PHRASE, field: PHRASE };
    Object.assign(keyed.useCases[0].operations[0], { store: PHRASE, collection: PHRASE, field: PHRASE, actor: PHRASE, source: { ...source, file: PHRASE } });
    return [
        page("exc-source", { target: { repositoryId: PHRASE, head: PHRASE }, content: [{ type: "code_peek", source: { ...source, file: PHRASE, pins: { repositoryId: PHRASE, head: PHRASE } }, caption: "Other" }] }),
        page("exc-image-url", { content: [{ type: "image", url: `https://example.invalid/${encodeURIComponent(PHRASE)}`, alt: "Other" }] }),
        page("exc-image-data", { content: [{ type: "image", url: "data:image/png;base64,updatingVSCode", alt: "Other" }] }),
        page("exc-history", { content: [unrelated] }),
        page("exc-ids", { content: [{ ...unrelated, id: PHRASE }], internalId: PHRASE }),
        page("exc-enums", { content: [{ type: "code", text: "Other", language: PHRASE }, { type: "callout", tone: PHRASE, children: [] }, { type: "flow_diagram", title: "Other", direction: PHRASE, nodes: [{ key: PHRASE, label: "Other", kind: PHRASE }], edges: [] }] }),
        page("exc-lenses", { content: [unrelated], lenses: [{ title: PHRASE, paths: [PHRASE] }] }),
        page("exc-reference-target", { content: [{ type: "markdown", markdown: '<copilot-ref kind="session" target-id="updating VSCode" label="Other" />' }] }),
        page("exc-adjacent", { content: [unrelated] }),
        page("exc-db-metadata", { content: [db] }),
        page("exc-db-keys-references", { content: [keyed] }),
        page("exc-note-source", { content: [{ type: "sequence", title: "Other", actors: { a: "Other" }, steps: [{ from: "a", to: "a", label: "Other", notes: [{ source: { ...source, file: PHRASE } }] }] }] }),
        page("exc-db-flags", { content: [{
            ...database(),
            stores: { store: { label: "Other", storage: "document", collections: {
                collection: { label: "Other", fields: { field: { label: "Other", dataType: "Other", nullable: PHRASE, primaryKey: PHRASE } } },
            } } },
        }] }),
        page("exc-future-block", { content: [{ type: "future", text: PHRASE, children: [{ type: "markdown", markdown: PHRASE }] }] }),
    ];
}
