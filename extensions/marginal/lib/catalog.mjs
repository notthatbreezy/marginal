import { referenceText } from "../web/references.js";

/**
 * @typedef {{path: string, code: string, message: string, documentId?: string}} Issue
 * @typedef {{kind: "active"} | {kind: "archived", archivedAt: string, epoch: number}} ArchiveState
 * @typedef {{kind: "relevance"} | {kind: "date", field: "updated" | "created", direction: "asc" | "desc"}} CatalogSort
 * @typedef {{kind: "none"} | {kind: "bounded", field: "updated" | "created", from?: number, until?: number}} CatalogRange
 * @typedef {{query: string, tokens: string[], status: "active" | "archived" | "all", sort: CatalogSort, range: CatalogRange}} CatalogQuery
 */

const canonicalInstant = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? epoch : null;
};
const normalize = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();
const issue = (path, code, message) => ({ path, code, message });

/** @returns {{ok: true, value: ArchiveState} | {ok: false, issues: Issue[]}} */
export function parseArchiveState(doc) {
    if (!Object.hasOwn(doc, "archivedAt") || doc.archivedAt === null) return { ok: true, value: { kind: "active" } };
    const epoch = canonicalInstant(doc.archivedAt);
    if (epoch !== null) return { ok: true, value: { kind: "archived", archivedAt: doc.archivedAt, epoch } };
    return { ok: false, issues: [{ documentId: doc.id, ...issue("archivedAt", "invalid_archive_state", `${doc.id}.archivedAt must be null, absent, or a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).`) }] };
}

/** Parse untrusted transport/action input once, before catalog work or effects.
 * @returns {{ok: true, value: CatalogQuery} | {ok: false, issues: Issue[]}}
 */
export function parseCatalogQuery(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: [issue("query", "invalid_query", "Catalog options must be an object.")] };
    const issues = [];
    const keys = ["query", "status", "sort", "direction", "dateField", "from", "until"];
    for (const key of Object.keys(raw)) if (!keys.includes(key)) issues.push(issue(key, "unknown_option", `Unknown catalog option: ${key}.`));
    if (raw.query !== undefined && typeof raw.query !== "string") issues.push(issue("query", "invalid_query", "query must be a string."));
    const query = typeof raw.query === "string" ? normalize(raw.query) : "";
    const tokens = [...new Set(query.split(" ").filter(Boolean))];
    const status = raw.status === undefined ? "active" : raw.status;
    if (!["active", "archived", "all"].includes(status)) issues.push(issue("status", "invalid_status", "status must be active, archived or all."));
    const sort = raw.sort === undefined ? (query ? "relevance" : "updated") : raw.sort;
    if (!["relevance", "updated", "created"].includes(sort)) issues.push(issue("sort", "invalid_sort", "sort must be relevance, updated or created."));
    if (raw.direction !== undefined && !["asc", "desc"].includes(raw.direction)) issues.push(issue("direction", "invalid_direction", "direction must be asc or desc."));
    if (sort === "relevance") {
        if (!query) issues.push(issue("sort", "empty_relevance", "Relevance requires a nonempty query."));
        if (raw.direction !== undefined) issues.push(issue("direction", "relevance_direction", "Relevance has no direction."));
    }
    if (raw.dateField !== undefined && !["updated", "created"].includes(raw.dateField)) issues.push(issue("dateField", "invalid_date_field", "dateField must be updated or created."));
    const bounds = {};
    for (const key of ["from", "until"]) {
        if (raw[key] === undefined) continue;
        const epoch = canonicalInstant(raw[key]);
        if (epoch === null) issues.push(issue(key, "invalid_instant", `${key} must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).`));
        else bounds[key] = epoch;
    }
    const bounded = raw.from !== undefined || raw.until !== undefined;
    if (bounded && raw.dateField === undefined) issues.push(issue("dateField", "missing_date_field", "Date bounds require dateField."));
    if (bounds.from !== undefined && bounds.until !== undefined && bounds.from >= bounds.until) issues.push(issue("until", "invalid_range", "until must be after from (exclusive upper bound)."));
    if (issues.length) return { ok: false, issues };
    return { ok: true, value: {
        query, tokens, status,
        sort: sort === "relevance" ? { kind: "relevance" } : { kind: "date", field: sort, direction: raw.direction ?? "desc" },
        range: bounded ? { kind: "bounded", field: raw.dateField, ...bounds } : { kind: "none" },
    } };
}

function notesOf(notes, prose, literal) {
    for (const note of notes ?? []) {
        prose(note.title);
        prose(note.text);
        literal(note.code?.text);
    }
}

function databaseFields(fields, prose, literal) {
    for (const field of Object.values(fields ?? {})) {
        prose(field.label);
        prose(field.dataType);
        if (Object.hasOwn(field, "example")) literal(JSON.stringify(field.example));
        databaseFields(field.fields, prose, literal);
    }
}

const readers = {
    markdown: (b, prose) => prose(b.markdown),
    code: (b, prose, literal) => { literal(b.text); prose(b.caption, "inline"); },
    divider: () => {},
    section: (b, prose, literal, visit) => { prose(b.title); visit(b.children); },
    callout: (b, prose, literal, visit) => { prose(b.title); visit(b.children); },
    code_peek: (b, prose) => prose(b.caption, "inline"),
    sequence: (b, prose, literal) => {
        prose(b.title);
        Object.values(b.actors ?? {}).forEach(actor => prose(actor));
        for (const step of b.steps ?? []) {
            prose(step.label);
            prose(step.explanation);
            literal(step.code?.text);
            notesOf(step.notes, prose, literal);
        }
    },
    flow_diagram: (b, prose, literal) => {
        prose(b.title);
        prose(b.description);
        for (const node of b.nodes ?? []) {
            prose(node.label);
            prose(node.description);
            for (const attachment of node.attachments ?? []) prose(attachment.label);
            notesOf(node.notes, prose, literal);
        }
        for (const edge of b.edges ?? []) prose(edge.label);
    },
    call_stack_diff: (b, prose, literal) => {
        prose(b.title);
        for (const frame of [...(b.base ?? []), ...(b.head ?? [])]) {
            prose(frame.label);
            prose(frame.via?.reason);
            notesOf(frame.notes, prose, literal);
        }
    },
    database_lens: (b, prose, literal) => {
        prose(b.title);
        for (const actor of Object.values(b.actors ?? {})) prose(typeof actor === "string" ? actor : actor.label);
        for (const store of Object.values(b.stores ?? {})) {
            prose(store.label);
            for (const collection of Object.values(store.collections ?? {})) {
                prose(collection.label);
                databaseFields(collection.fields, prose, literal);
            }
        }
        for (const useCase of b.useCases ?? []) {
            prose(useCase.label);
            prose(useCase.summary, "inline");
            for (const operation of useCase.operations ?? []) {
                prose(operation.label);
                prose(operation.detail);
            }
        }
    },
    trace_quote: (b, prose) => { prose(b.text); prose(b.attribution); },
    image: (b, prose) => { prose(b.alt); prose(b.caption, "inline"); },
};

export const SEARCH_BLOCK_TYPES = Object.keys(readers);

/** Explicit authored fields only; field boundaries must not manufacture phrases. */
export function searchFields(doc) {
    const fields = [];
    const literal = (text) => { if (typeof text === "string") fields.push(normalize(text)); };
    /** @param {import("../web/references.js").ReferenceContainer} container */
    const prose = (text, container = "markdown") => { if (typeof text === "string") literal(referenceText(text, container)); };
    const visit = (blocks) => {
        for (const block of blocks ?? []) {
            // Future unknown block variants contribute no text until explicitly supported.
            if (Object.hasOwn(readers, block.type)) readers[block.type](block, prose, literal, visit);
        }
    };
    prose(doc.title);
    visit(doc.content);
    return fields;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const legacyYear = (year) => year < 100 ? year + (year < 50 ? 2000 : 1900) : year;

function storedCalendar(value) {
    const iso = /^\s*([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?=$|T|\s)/.exec(value);
    if (iso) return iso.slice(1).map(Number);
    // Native legacy parsing ignores leading punctuation and optional weekday words.
    const text = value.replace(/\([^)]*\)/g, "")
        .replace(/^[^a-z\d]*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[^a-z\d]*)?(?=\d)/i, "");
    const numeric = /^\s*(\d{1,6})[-/.,\s]+(\d{1,2})[-/.,\s]+(\d{1,6})(?=\D|$)/.exec(text);
    if (numeric) {
        const [a, b, c] = numeric.slice(1).map(Number);
        return a > 31 || a === 0 || numeric[1].length >= 4 ? [legacyYear(a), b, c] : [legacyYear(c), a, b];
    }
    const middle = /\b(\d{1,6})[-\s,]+([a-z]+)[-\s,]+(\d{1,6})\b/i.exec(text);
    const first = /\b([a-z]+)[-\s,]+(\d{1,6})[-\s,]+(\d{1,6})\b/i.exec(text);
    const last = /\b(\d{1,6})[-\s,]+(\d{1,6})[-\s,]+([a-z]+)\b/i.exec(text);
    const candidates = [
        middle && { index: middle.index, parts: [middle[1], middle[2], middle[3]] },
        first && { index: first.index, parts: [first[2], first[1], first[3]] },
        last && { index: last.index, parts: [last[1], last[3], last[2]] },
    ].filter(Boolean).sort((a, b) => a.index - b.index);
    for (const { parts } of candidates) {
        const month = MONTHS.indexOf(parts[1].slice(0, 3).toLowerCase()) + 1;
        if (!month) continue;
        const a = Number(parts[0]), b = Number(parts[2]);
        return a > 31 || a === 0 || parts[0].length >= 3 ? [legacyYear(a), month, b] : [legacyYear(b), month, a];
    }
    return null;
}

function storedDate(value) {
    const epoch = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(epoch)) return null;
    // Validate the authored calendar, not UTC components shifted by a valid offset.
    // Date.parse alone silently rolls impossible ISO and legacy dates into another month.
    const calendar = storedCalendar(value);
    if (calendar) {
        const [year, month, day] = calendar;
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
        if (!(day >= 1 && day <= days)) return null;
    }
    return epoch;
}

function compareDate(a, b, direction = "desc") {
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return direction === "asc" ? a - b : b - a;
}

function compareId(a, b) {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const delta = left[i].codePointAt(0) - right[i].codePointAt(0);
        if (delta) return delta;
    }
    return left.length - right.length;
}

function phraseCount(fields, phrase) {
    if (!phrase) return 0;
    let count = 0;
    for (const field of fields) {
        let at = 0;
        while ((at = field.indexOf(phrase, at)) !== -1) {
            count++;
            at += phrase.length;
        }
    }
    return count;
}

/** @param {{doc: object, archive: ArchiveState}[]} entries
 * @param {CatalogQuery} query Parsed input only; returns the original documents, not search payloads.
 */
export function queryPages(entries, query) {
    const rows = [];
    for (const { doc, archive } of entries) {
        if (query.status !== "all" && query.status !== archive.kind) continue;
        const dates = { updated: storedDate(doc.updatedAt), created: storedDate(doc.createdAt) };
        if (query.range.kind === "bounded") {
            const date = dates[query.range.field];
            if (date === null || (query.range.from !== undefined && date < query.range.from) || (query.range.until !== undefined && date >= query.range.until)) continue;
        }
        const fields = query.tokens.length ? searchFields(doc) : [];
        if (!query.tokens.every((token) => fields.some((field) => field.includes(token)))) continue;
        const count = phraseCount(fields, query.query);
        rows.push({ doc, dates, score: [count > 0 ? 1 : 0, query.tokens.filter((token) => fields[0]?.includes(token)).length, count] });
    }
    rows.sort((a, b) => {
        if (query.sort.kind === "relevance") {
            for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
            return compareDate(a.dates.updated, b.dates.updated) || compareDate(a.dates.created, b.dates.created) || compareId(a.doc.id, b.doc.id);
        }
        const { field, direction } = query.sort;
        const other = field === "updated" ? "created" : "updated";
        return compareDate(a.dates[field], b.dates[field], direction) || compareDate(a.dates[other], b.dates[other]) || compareId(a.doc.id, b.doc.id);
    });
    return rows.map(({ doc }) => doc);
}
