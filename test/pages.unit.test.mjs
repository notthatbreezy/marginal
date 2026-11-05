import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BLOCK_TYPES, parseBlock } from "../extensions/marginal/lib/blocks.mjs";
import { parseArchiveState, parseCatalogQuery, queryPages, SEARCH_BLOCK_TYPES, searchFields } from "../extensions/marginal/lib/catalog.mjs";
import { canonicalPages, directoryBytes, excludedCases, fixture, includedCases, page, PHRASE, storeProbe, time } from "./fixtures/pages.mjs";

function model(documents, raw = {}) {
    const parsed = parseCatalogQuery(raw);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    const entries = documents.map((doc) => {
        const state = parseArchiveState(doc);
        assert.equal(state.ok, true, JSON.stringify(state));
        return { doc, archive: state.value };
    });
    return queryPages(entries, parsed.value).map((doc) => doc.id);
}

function checkModelAndStore(documents, cases, options) {
    const data = fixture(documents, options);
    try {
        storeProbe(data.root, `
            const before = directoryBytes(root);
            const ids = ${JSON.stringify(documents.map((doc) => doc.id))};
            const current = ids.map(id => structuredClone(store.getDoc(id)));
            const events = [];
            store.subscribe("*", event => events.push(event));
            for (const [raw, expected] of ${JSON.stringify(cases)}) assert.deepEqual(ordinary(raw), expected, JSON.stringify(raw));
            assert.deepEqual(ids.map(id => store.getDoc(id)), current);
            assert.deepEqual(events, []);
            assert.deepEqual(directoryBytes(root), before);
        `);
    } finally { data.close(); }
    for (const [raw, expected] of cases) assert.deepEqual(model(documents, raw), expected, JSON.stringify(raw));
}

test("P3-001: prose persistence keeps reference whitespace in edited and untouched units", () => {
    for (const newline of ["\n", "\r\n"]) for (const gap of [1, 3]) for (const adjacent of [false, true]) {
        const raw = `<copilot-ref${newline}  kind='session' target-id='synthetic-session-newline' label='Build${newline.repeat(gap)}  helper' />`;
        const body = `Before ${raw} after`;
        const original = `${body}\n\nOther words`;
        const data = fixture([page("edit-multiline", { content: [{ id: "md-1", type: "markdown", markdown: original }] })]);
        try {
            const from = adjacent ? 0 : original.split("\n").length - 1;
            const to = adjacent ? body.split("\n").length - 1 : from;
            const before = adjacent ? body.replace(/\r\n/g, "\n") : "Other words";
            const after = adjacent ? body.replace("Before", "Around") : "Changed words";
            const expected = adjacent ? original.replace("Before", "Around") : original.replace("Other words", "Changed words");
            storeProbe(data.root, `
                await store.editProse("edit-multiline", [{ blockId: "md-1", from: ${from}, to: ${to}, before: ${JSON.stringify(before)}, after: ${JSON.stringify(after)} }]);
                assert.equal(store.getDoc("edit-multiline").content[0].markdown, ${JSON.stringify(expected)});
            `);
        } finally { data.close(); }
    }
});

test("P3-001: deliberate source malformation preserves bytes without post-edit grammar inference", () => {
    for (const newline of ["\n", "\r\n"]) for (const gap of [1, 3]) for (const [fromText, toText] of [
        ["/>", ""], ["copilot-ref", "changed-ref"], ["kind='session'", "kind='other'"],
    ]) {
        const raw = `<copilot-ref${newline}  kind='session' target-id='synthetic-malformed' label='Build${newline.repeat(gap)}  &amp; helper' />`;
        const body = `Before ${raw} after`;
        const original = `${body}\n\nOther words`;
        const after = body.replace(fromText, toText);
        const expected = `${after}\n\nOther words`;
        const data = fixture([page("edit-malformed", { content: [{ id: "md-1", type: "markdown", markdown: original }] })]);
        try {
            storeProbe(data.root, `
                await store.editProse("edit-malformed", [{ blockId: "md-1", from: 0, to: ${body.split("\n").length - 1}, before: ${JSON.stringify(body.replace(/\r\n/g, "\n"))}, after: ${JSON.stringify(after)} }]);
                assert.equal(store.getDoc("edit-malformed").content[0].markdown, ${JSON.stringify(expected)});
                const at = ${expected.split("\n").length - 1};
                await store.editProse("edit-malformed", [{ blockId: "md-1", from: at, to: at, before: "Other words", after: "Changed words" }]);
                assert.equal(store.getDoc("edit-malformed").content[0].markdown, ${JSON.stringify(expected.replace("Other words", "Changed words"))});
            `);
        } finally { data.close(); }
    }
});

test("P3-001: prose deletion cleans only its seam, leaving replacement and untouched source intact", () => {
    const original = "First\r\n\r\nRemove\r\n\r\nLast\r\n";
    const replacement = "Changed\r\n\r\n\r\nlast  ";
    const data = fixture([page("edit-seams", { content: [{ id: "md-1", type: "markdown", markdown: original }] })]);
    try {
        storeProbe(data.root, `
            await store.editProse("edit-seams", [
                { blockId: "md-1", from: 2, to: 2, before: "Remove", after: "" },
                { blockId: "md-1", from: 4, to: 4, before: "Last", after: ${JSON.stringify(replacement)} }
            ]);
            assert.equal(store.getDoc("edit-seams").content[0].markdown, ${JSON.stringify(`First\r\n\r\n${replacement}\n`)});
        `);
    } finally { data.close(); }
});

const relevance = ["a-title-phrase", "b-body-phrase", "c-body-phrase", "k-equal-phrase", "d-title-separated", "e-title-one", "f-cross-fields", "g-body-reversed"];

test("PERF-001: blank metadata queries never extract authored bodies", () => {
    let reads = 0;
    const active = page("perf-active");
    const archived = page("perf-archived", { archivedAt: time("2026-10-10") });
    for (const doc of [active, archived]) Object.defineProperty(doc, "content", { get() {
        reads++;
        return [{ type: "markdown", markdown: "Needle " + "authored body ".repeat(10000) }];
    } });
    for (const options of [{}, { query: " \t\n " }, { sort: "created", direction: "asc" },
        { sort: "updated", direction: "desc", dateField: "updated", from: time("2026-01-01") }]) {
        assert.deepEqual(model([active, archived], options), ["perf-active"]);
        assert.deepEqual(model([active, archived], { ...options, status: "archived" }), ["perf-archived"]);
        assert.deepEqual(model([active, archived], { ...options, status: "all" }), ["perf-active", "perf-archived"]);
    }
    assert.equal(reads, 0);
    assert.deepEqual(model([active, archived], { query: "needle" }), ["perf-active"]);
    assert.equal(reads, 1);
});

const principalCases = [
    [{ query: PHRASE }, relevance],
    [{ query: "  UPDATING   VSCode  " }, relevance],
    [{ query: PHRASE, status: "all" }, ["j-archived", ...relevance]],
    [{ query: PHRASE, status: "archived" }, ["j-archived"]],
    [{ query: PHRASE, sort: "updated", direction: "desc" }, ["f-cross-fields", "g-body-reversed", "e-title-one", "d-title-separated", "c-body-phrase", "k-equal-phrase", "b-body-phrase", "a-title-phrase"]],
    [{ query: PHRASE, sort: "updated", direction: "asc" }, ["a-title-phrase", "b-body-phrase", "c-body-phrase", "k-equal-phrase", "d-title-separated", "e-title-one", "f-cross-fields", "g-body-reversed"]],
    [{ query: PHRASE, sort: "created", direction: "asc" }, ["a-title-phrase", "f-cross-fields", "g-body-reversed", "d-title-separated", "c-body-phrase", "k-equal-phrase", "e-title-one", "b-body-phrase"]],
    [{ query: PHRASE, sort: "created", direction: "desc" }, ["b-body-phrase", "e-title-one", "c-body-phrase", "k-equal-phrase", "d-title-separated", "f-cross-fields", "g-body-reversed", "a-title-phrase"]],
    [{}, ["i-history-only", "h-one-token", "f-cross-fields", "g-body-reversed", "e-title-one", "d-title-separated", "c-body-phrase", "k-equal-phrase", "b-body-phrase", "a-title-phrase"]],
    [{ query: " \t\n " }, ["i-history-only", "h-one-token", "f-cross-fields", "g-body-reversed", "e-title-one", "d-title-separated", "c-body-phrase", "k-equal-phrase", "b-body-phrase", "a-title-phrase"]],
    [{ query: "update" }, []],
    [{ query: "vscode." }, ["b-body-phrase"]],
    [{ query: "missing" }, []],
    [{ query: "updating updating" }, ["e-title-one", "d-title-separated", "a-title-phrase", "f-cross-fields", "g-body-reversed", "c-body-phrase", "k-equal-phrase", "b-body-phrase"]],
];

test("TC-01/02: exact C membership/order through pure model and actual store, without writes", () => {
    const old = page("i-history-only", { version: 1 });
    checkModelAndStore(canonicalPages(), principalCases, { snapshots: { "i-history-only": [old] } });
});

test("TC-01: no cross-field phrase fabrication, literal formatting, non-overlap, and title precedence", () => {
    checkModelAndStore([
        page("phrase-space", { content: [{ type: "markdown", markdown: "UPDATING\nVSCode" }], updatedAt: time("2026-10-01") }),
        page("phrase-format", { content: [{ type: "markdown", markdown: "updating **VSCode**" }], updatedAt: time("2026-10-20") }),
    ], [[{ query: PHRASE }, ["phrase-space", "phrase-format"]]]);
    checkModelAndStore([
        page("phrase-overlap", { content: [{ type: "markdown", markdown: "aaaaa" }] }),
        page("phrase-once", { content: [{ type: "markdown", markdown: "aa" }], updatedAt: time("2026-10-20") }),
    ], [[{ query: "aa" }, ["phrase-overlap", "phrase-once"]]]);
    assert.deepEqual(model(canonicalPages(), { query: "updating updating" }).sort(), ["a-title-phrase", "b-body-phrase", "c-body-phrase", "d-title-separated", "e-title-one", "f-cross-fields", "g-body-reversed", "k-equal-phrase"]);
});

test("TC-02: unknown selected dates always trail known dates, without repairs", () => {
    const missing = page("u-missing");
    delete missing.createdAt;
    delete missing.updatedAt;
    const documents = [
        missing, page("u-invalid", { createdAt: "not-a-date", updatedAt: "not-a-date" }),
        page("u-known", { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const cases = [];
    for (const field of ["created", "updated"]) for (const direction of ["asc", "desc"]) {
        cases.push([{ query: PHRASE, sort: field, direction }, ["u-known", "u-invalid", "u-missing"]]);
        cases.push([{ query: PHRASE, sort: field, direction, dateField: field, from: "2026-10-01T00:00:00.000Z" }, ["u-known"]]);
    }
    checkModelAndStore(documents, cases);
});

test("TC-02: independent secondary dates stay newest even with ascending primary", () => {
    checkModelAndStore([
        page("secondary-a", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-10") }),
        page("secondary-z", { createdAt: time("2026-10-02"), updatedAt: time("2026-10-10") }),
    ], [
        [{ query: PHRASE }, ["secondary-z", "secondary-a"]],
        [{ sort: "updated", direction: "asc" }, ["secondary-z", "secondary-a"]],
        [{ sort: "updated", direction: "desc" }, ["secondary-z", "secondary-a"]],
    ]);
    checkModelAndStore([
        page("created-a", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-10") }),
        page("created-z", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-11") }),
    ], [
        [{ sort: "created", direction: "asc" }, ["created-z", "created-a"]],
        [{ sort: "created", direction: "desc" }, ["created-z", "created-a"]],
        [{ query: PHRASE }, ["created-z", "created-a"]],
        [{ sort: "updated", direction: "asc" }, ["created-a", "created-z"]],
        [{ sort: "updated", direction: "desc" }, ["created-z", "created-a"]],
    ]);
});

test("TC-02: mixed validity does not discard the valid other timestamp/range", () => {
    checkModelAndStore([
        page("mix-created-only", { createdAt: time("2026-10-02"), updatedAt: "not-a-date" }),
        page("mix-updated-only", { createdAt: "not-a-date", updatedAt: time("2026-10-02") }),
        page("mix-both", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-01") }),
    ], [
        [{ query: PHRASE }, ["mix-updated-only", "mix-both", "mix-created-only"]],
        [{ sort: "updated", direction: "desc" }, ["mix-updated-only", "mix-both", "mix-created-only"]],
        [{ sort: "updated", direction: "asc" }, ["mix-both", "mix-updated-only", "mix-created-only"]],
        [{ sort: "created", direction: "desc" }, ["mix-created-only", "mix-both", "mix-updated-only"]],
        [{ sort: "created", direction: "asc" }, ["mix-both", "mix-created-only", "mix-updated-only"]],
        [{ dateField: "created", from: "2026-10-02T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" }, ["mix-created-only"]],
        [{ dateField: "updated", from: "2026-10-02T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" }, ["mix-updated-only"]],
    ]);
});

test("P1-001: impossible stored calendars are unknown in either field, not rolled-over range members", async (t) => {
    const invalid = [
        ["utc", "2026-02-30T10:00:00.000Z", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["no-ms", "2025-02-29T10:00:00Z", "2025-03-01T00:00:00.000Z", "2025-03-02T00:00:00.000Z"],
        ["offset", "2026-02-30T23:30:00-05:00", "2026-03-03T00:00:00.000Z", "2026-03-04T00:00:00.000Z"],
        ["date-only", "2026-04-31", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z"],
        ["rfc", "Fri, 30 Feb 2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["month-name", "February 30, 2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["year-first-slashes", "2026/02/30 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["month-first-slashes", "02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["legacy-hyphens", "2026-2-30 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["nonleap-century", "29-Feb-1900 10:00:00 GMT", "1900-03-01T00:00:00.000Z", "1900-03-02T00:00:00.000Z"],
        ["weekday-month-first-slashes", "Mon, 02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-year-first-slashes", "Mon, 2026/02/30 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-legacy-hyphens", "Mon 2026-2-30 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-full", "MONDAY, 02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-period", "Mon.02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-slash", "Mon/02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-colon", "Mon: 02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-semicolon", "Mon; 02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-mixed-punctuation", "  Mon , . - 02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-comments", "(note) Mon(weekday), 02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-tabs", "Mon\t,\t02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["weekday-offset", "Mon, 02/30/2026 23:30:00 GMT-0500", "2026-03-03T00:00:00.000Z", "2026-03-04T00:00:00.000Z"],
        ["punctuation-only-comma", ", 02/30/2026 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
        ["punctuation-only-year-first", "! 2026/02/30 10:00:00 GMT", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"],
    ];
    for (const [name, value, from, until] of invalid) for (const field of ["created", "updated"]) await t.test(`${name}-${field}`, () => {
        const other = field === "created" ? "updated" : "created";
        const documents = [
            page("known", { [`${field}At`]: time("2024-01-01"), [`${other}At`]: time("2026-11-02") }),
            page("bad-calendar", { [`${field}At`]: value, [`${other}At`]: time("2026-11-03") }),
        ];
        checkModelAndStore(documents, [
            [{ sort: field, direction: "asc" }, ["known", "bad-calendar"]],
            [{ sort: field, direction: "desc" }, ["known", "bad-calendar"]],
            [{ dateField: field, from, until }, []],
            [{ sort: other, direction: "asc" }, ["known", "bad-calendar"]],
            [{ sort: other, direction: "desc" }, ["bad-calendar", "known"]],
            [{ dateField: other, from: "2026-11-03T00:00:00.000Z", until: "2026-11-04T00:00:00.000Z" }, ["bad-calendar"]],
            [{ query: PHRASE }, field === "created" ? ["bad-calendar", "known"] : ["known", "bad-calendar"]],
        ]);
    });
});

test("P1-001: valid stored timestamp formats retain their original epoch and bytes", async (t) => {
    const equivalent = [
        ["utc", "2026-02-28T10:00:00.000Z"],
        ["no-ms", "2026-02-28T10:00:00Z"],
        ["precision", "2026-02-28T10:00:00.000000Z"],
        ["offset", "2026-02-28T05:00:00-05:00"],
        ["offset-next-calendar-day", "2026-03-01T00:00:00+14:00"],
        ["rfc", "Sat, 28 Feb 2026 10:00:00 GMT"],
        ["date-to-string", "Sat Feb 28 2026 05:00:00 GMT-0500 (Eastern Standard Time)"],
        ["month-name", "February 28, 2026 10:00:00 GMT"],
        ["year-first-slashes", "2026/02/28 10:00:00 GMT"],
        ["month-first-slashes", "02/28/2026 10:00:00 GMT"],
        ["legacy-hyphens", "2026-2-28 10:00:00 GMT"],
        ["day-first-name", "28-Feb-2026 10:00:00 GMT"],
        ["weekday-month-first-slashes", "Sat, 02/28/2026 10:00:00 GMT"],
        ["weekday-year-first-slashes", "Sat, 2026/02/28 10:00:00 GMT"],
        ["weekday-legacy-hyphens", "Sat 2026-2-28 10:00:00 GMT"],
        ["weekday-full", "SATURDAY, 02/28/2026 10:00:00 GMT"],
        ["weekday-period", "Sat.02/28/2026 10:00:00 GMT"],
        ["weekday-slash", "Sat/02/28/2026 10:00:00 GMT"],
        ["weekday-colon", "Sat: 02/28/2026 10:00:00 GMT"],
        ["weekday-semicolon", "Sat; 02/28/2026 10:00:00 GMT"],
        ["weekday-mixed-punctuation", "  Sat , . - 02/28/2026 10:00:00 GMT"],
        ["weekday-comments", "(note) Sat(weekday), 02/28/2026 10:00:00 GMT"],
        ["weekday-tabs", "Sat\t,\t02/28/2026 10:00:00 GMT"],
        ["weekday-offset", "Sat, 02/28/2026 05:00:00 GMT-0500"],
        ["punctuation-only-comma", ", 02/28/2026 10:00:00 GMT"],
        ["punctuation-only-year-first", "! 2026/02/28 10:00:00 GMT"],
    ];
    const controls = [
        ...equivalent.map(([name, value]) => [name, value, "2026-02-28T10:00:00.000Z", "2026-02-28T10:00:00.001Z"]),
        ["date-only", "2026-02-28", "2026-02-28T00:00:00.000Z", "2026-02-28T00:00:00.001Z"],
        ["leap-day", "2024-02-29T10:00:00Z", "2024-02-29T10:00:00.000Z", "2024-02-29T10:00:00.001Z"],
        ["leap-century", "29-Feb-2000 10:00:00 GMT", "2000-02-29T10:00:00.000Z", "2000-02-29T10:00:00.001Z"],
        ["two-digit-year", "Feb 29 00 10:00:00 GMT", "2000-02-29T10:00:00.000Z", "2000-02-29T10:00:00.001Z"],
        ["year-day-name-leap", "2000 29 Feb 10:00:00 GMT", "2000-02-29T10:00:00.000Z", "2000-02-29T10:00:00.001Z"],
        ["end-of-day", "2026-02-28T24:00:00Z", "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.001Z"],
    ];
    for (const [name, value, canonical, until] of controls) for (const field of ["created", "updated"]) await t.test(`${name}-${field}`, () => {
        checkModelAndStore([
            page("a-legacy", { [`${field}At`]: value }),
            page("z-canonical", { [`${field}At`]: canonical }),
        ], [
            [{ sort: field, direction: "asc" }, ["a-legacy", "z-canonical"]],
            [{ sort: field, direction: "desc" }, ["a-legacy", "z-canonical"]],
            [{ dateField: field, from: canonical, until }, ["a-legacy", "z-canonical"]],
        ]);
    });
});

test("TC-02: deterministic code-point ids, not locale or UTF-16 order", () => {
    const cases = [[{ query: PHRASE }, ["tie-Z", "tie-a"]]];
    for (const sort of ["created", "updated"]) for (const direction of ["asc", "desc"]) cases.push([{ sort, direction }, ["tie-Z", "tie-a"]]);
    checkModelAndStore([page("tie-a"), page("tie-Z")], cases);
    assert.deepEqual(model([page("tie-\u{10000}"), page("tie-\uE000")]), ["tie-\uE000", "tie-\u{10000}"]);
});

test("TC-03: complete schema-valid included field-only cases, including all note owners", async (t) => {
    const covered = new Set(["divider"]);
    for (const { name, doc } of includedCases()) await t.test(name, () => {
        const block = parseBlock(doc.content[0]);
        covered.add(block.type);
        const documents = [{ ...doc, content: [block] }];
        checkModelAndStore(documents, [[{ query: PHRASE }, [doc.id]]]);
    });
    assert.deepEqual([...covered].sort(), [...BLOCK_TYPES].sort());
    assert.deepEqual([...SEARCH_BLOCK_TYPES].sort(), [...BLOCK_TYPES].sort());
    assert.deepEqual(searchFields(page("divider", { title: "Other", content: [parseBlock({ type: "divider" })] })), ["other"]);
});

test("TC-03: JSON scalar/object/array examples are authored literals, not structural record keys", () => {
    for (const [example, query] of [[123, "123"], [false, "false"], [null, "null"], [["updating", "VSCode"], "updating VSCode"]]) {
        const doc = includedCases().find((item) => item.name.startsWith("database-example-string")).doc;
        doc.content[0].stores.store.collections.collection.fields.field.example = example;
        assert.deepEqual(model([doc], { query }), [doc.id]);
    }
});

test("TC-04: excluded metadata, history and adjacent files cannot enter search", async (t) => {
    for (const doc of excludedCases()) await t.test(doc.id, () => {
        const data = fixture([doc], {
            snapshots: { [doc.id]: [page(doc.id, { version: 1 })] },
            attachments: {
                [join("docs", doc.id, "command", "state.json")]: JSON.stringify({ text: PHRASE }),
                [join("docs", doc.id, "prs", "index.json")]: JSON.stringify({ text: PHRASE }),
                [join("docs", doc.id, "transcript.json")]: PHRASE,
                "synthetic-unread.txt": PHRASE,
            },
        });
        try {
            assert.deepEqual(model([doc], { query: PHRASE }), []);
            storeProbe(data.root, `
                store.getDoc(${JSON.stringify(doc.id)});
                const before = directoryBytes(root);
                const fs = await import("node:fs");
                const childProcess = await import("node:child_process");
                const { syncBuiltinESMExports } = await import("node:module");
                const originalRead = fs.default.readFileSync;
                const originalFetch = globalThis.fetch;
                const originalCommands = new Map();
                const forbidden = [];
                fs.default.readFileSync = (file, ...args) => {
                    if (String(file).endsWith("synthetic-unread.txt")) {
                        forbidden.push("source read");
                        throw new Error("forbidden synthetic source read");
                    }
                    return originalRead(file, ...args);
                };
                globalThis.fetch = () => {
                    forbidden.push("network fetch");
                    throw new Error("forbidden query fetch");
                };
                for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
                    originalCommands.set(name, childProcess.default[name]);
                    childProcess.default[name] = () => {
                        forbidden.push(name);
                        throw new Error("forbidden query process: " + name);
                    };
                }
                syncBuiltinESMExports();
                assert.deepEqual(ordinary({query: ${JSON.stringify(PHRASE)}}), []);
                assert.deepEqual(forbidden, []);
                // Arm verification is explicit: these guards would observe the forbidden operations.
                assert.throws(() => fs.default.readFileSync(join(root, "synthetic-unread.txt")), /forbidden synthetic source/);
                assert.throws(() => globalThis.fetch("https://example.invalid/unread"), /forbidden query fetch/);
                assert.throws(() => childProcess.default.spawn("synthetic"), /forbidden query process/);
                assert.deepEqual(forbidden, ["source read", "network fetch", "spawn"]);
                fs.default.readFileSync = originalRead;
                globalThis.fetch = originalFetch;
                for (const [name, original] of originalCommands) childProcess.default[name] = original;
                syncBuiltinESMExports();
                assert.deepEqual(directoryBytes(root), before);
            `);
        } finally { data.close(); }
    });
});

test("TC-04/10: prose reference label only; illustrative code/JSON keep target text as authored", () => {
    const raw = '<copilot-ref kind="session" target-id="updating VSCode" label="Other" />';
    const blocks = [
        { type: "markdown", markdown: "`" + raw + "`" },
        { type: "markdown", markdown: "``" + raw + "``" },
        { type: "markdown", markdown: "````text\n```\n" + raw + "\n```\n````" },
        { type: "code", text: raw },
        { type: "sequence", title: "Other", actors: { a: "Other" }, steps: [{ from: "a", to: "a", label: "Other", code: { text: raw } }] },
        { type: "sequence", title: "Other", actors: { a: "Other" }, steps: [{ from: "a", to: "a", label: "Other", notes: [{ code: { text: raw } }] }] },
    ];
    const example = includedCases().find((item) => item.name.startsWith("database-example-string")).doc.content[0];
    example.stores.store.collections.collection.fields.field.example = raw;
    blocks.push(example);
    for (const [i, block] of blocks.entries()) {
        const doc = page(`inc-code-tag-${i}`, { content: [parseBlock(block)] });
        checkModelAndStore([doc], [[{ query: PHRASE }, [doc.id]]]);
    }
    checkModelAndStore([page("inc-literal-url", { content: [{ type: "markdown", markdown: PHRASE + " https://example.invalid/x" }] })], [[{ query: PHRASE }, ["inc-literal-url"]]]);
    const labelTitle = page("ref-title", { title: raw, content: [] });
    assert.deepEqual(model([labelTitle], { query: PHRASE }), []);
});

test("P1-002: real store searches quoted fenced reference source but not subsequent prose targets", async (t) => {
    const raw = '<copilot-ref kind="session" target-id="updating VSCode" label="Other" />';
    const prefixes = [["single", "> "], ["compact-nested", ">> "], ["spaced-nested", "> > "]];
    for (const [name, prefix] of prefixes) for (const ticks of ["```", "````"]) for (const ending of ["closed", "unclosed-eof", "unclosed-container"]) await t.test(`${name}-${ticks.length}-${ending}`, () => {
        const lines = [prefix + ticks + "text", prefix + raw];
        if (ticks.length === 4) lines.push(prefix + "```", prefix + raw);
        if (ending === "closed") lines.push(prefix + ticks, prefix + "After " + raw, "After " + raw);
        if (ending === "unclosed-container") lines.push("After " + raw);
        const code = page("quoted-code", { content: [{ type: "markdown", markdown: lines.join("\n") }] });
        const prose = page("quoted-prose", { content: [{ type: "markdown", markdown: prefix + raw + "\nAfter " + raw }] });
        checkModelAndStore([code, prose], [[{ query: PHRASE }, ["quoted-code"]]]);
    });
});

test("TC-07: query parsing is structured, narrow, non-coercing, and validates before loading", () => {
    const invalid = [
        null, [], "query", 42, true, { unknown: true }, { query: 1 }, { query: null }, { query: [] },
        { status: "" }, { status: null }, { status: true }, { status: "deleted" },
        { sort: null }, { sort: false }, { sort: "newest" }, { direction: null }, { direction: "up" },
        { dateField: null }, { dateField: "edited" }, { dateField: 0 },
        { sort: "relevance" }, { query: " \t ", sort: "relevance" },
        { query: PHRASE, sort: "relevance", direction: "asc" }, { query: PHRASE, direction: "desc" },
        { from: time("2026-10-01") }, { until: time("2026-10-01") },
        ...["not-a-date", "2026-10-01", "2026-10-01T10:00:00Z", "2026-10-01T10:00:00.000+00:00", "2026-02-30T10:00:00.000Z", false, 0, null].map((from) => ({ dateField: "updated", from })),
        { dateField: "created", from: time("2026-10-02"), until: time("2026-10-01") },
        { dateField: "updated", from: time("2026-10-01"), until: time("2026-10-01") },
    ];
    for (const raw of invalid) {
        const parsed = parseCatalogQuery(raw);
        assert.equal(parsed.ok, false, JSON.stringify(raw));
        assert.ok(parsed.issues.length);
        for (const issue of parsed.issues) for (const key of ["path", "code", "message"]) assert.equal(typeof issue[key], "string");
    }
    assert.deepEqual(parseCatalogQuery().value, { query: "", tokens: [], status: "active", sort: { kind: "date", field: "updated", direction: "desc" }, range: { kind: "none" } });
    assert.deepEqual(parseCatalogQuery({ query: " X  X " }).value, { query: "x x", tokens: ["x"], status: "active", sort: { kind: "relevance" }, range: { kind: "none" } });
    assert.deepEqual(parseCatalogQuery({ sort: "created", dateField: "updated" }).value.sort, { kind: "date", field: "created", direction: "desc" });
    assert.deepEqual(parseCatalogQuery({ dateField: "updated" }).value.range, { kind: "none" });
    const data = fixture([page("safe")]);
    try {
        storeProbe(data.root, `
            const before = directoryBytes(root);
            const events = [];
            store.subscribe("*", event => events.push(event));
            for (const raw of ${JSON.stringify(invalid)}) assert.throws(() => store.list(raw), error => error.name === "InputError" && error.issues.length > 0);
            for (const id of ["unknown", "", null, 0, {}]) {
                assert.throws(() => store.getDoc(id), /Unknown doc/);
                await assert.rejects(store.archive(id), /Unknown doc/);
                await assert.rejects(store.unarchive(id), /Unknown doc/);
            }
            assert.deepEqual(directoryBytes(root), before);
            assert.deepEqual(events, []);
        `);
    } finally { data.close(); }
});

test("TC-07: inclusive from/exclusive until and open-ended range intersect membership/status", () => {
    checkModelAndStore([
        page("before", { updatedAt: "2026-10-01T09:59:59.999Z" }),
        page("start", { updatedAt: time("2026-10-01") }),
        page("end", { updatedAt: "2026-10-02T09:59:59.999Z" }),
        page("after", { updatedAt: time("2026-10-02") }),
        page("archived", { updatedAt: time("2026-10-01"), archivedAt: time("2026-10-14") }),
        page("no-match", { title: "Other", content: [], updatedAt: time("2026-10-01") }),
    ], [
        [{ query: PHRASE, dateField: "updated", from: time("2026-10-01"), until: time("2026-10-02"), sort: "updated" }, ["end", "start"]],
        [{ query: PHRASE, dateField: "updated", from: time("2026-10-01"), sort: "updated" }, ["after", "end", "start"]],
        [{ query: PHRASE, dateField: "updated", until: time("2026-10-02"), sort: "updated" }, ["end", "start", "before"]],
        [{ query: PHRASE, status: "archived", dateField: "updated", from: time("2026-10-01"), until: time("2026-10-02") }, ["archived"]],
    ]);
    assert.deepEqual(parseCatalogQuery({ dateField: "created", from: "1970-01-01T00:00:00.000Z" }).value.range, { kind: "bounded", field: "created", from: 0 });
});

const clockSource = `
    const NativeDate = Date;
    function at(iso) {
        globalThis.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [iso])); }
            static now() { return NativeDate.parse(iso); }
        };
    }
`;

function archiveFixture() {
    return page("arc-one", {
        title: "Archive fixture", version: 2, nextId: 100,
        content: [{ id: "md-1", type: "markdown", markdown: "Keep this" }],
        createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z",
        target: { repositoryId: "synthetic", base: "a".repeat(40), head: "b".repeat(40) },
        pullRequest: { url: "https://example.invalid/synthetic/pull/1" },
        lastEdit: { type: "update", targetId: "md-1" },
    });
}

test("TC-05/06: real locked archive/no-op, saved history time, fresh-process persistence and archived editing", () => {
    const doc = archiveFixture();
    const data = fixture([doc], {
        snapshots: { "arc-one": [{ ...doc, version: 0 }, { ...doc, version: 1, createdAt: "2026-08-01T00:00:00.000Z", content: [{ id: "md-1", type: "markdown", markdown: "Old text" }] }, { ...doc, version: 2 }] },
        attachments: { [join("docs", "arc-one", "command", "state.json")]: '{"mission":"synthetic"}', [join("docs", "arc-one", "prs", "index.json")]: '{"pr":"synthetic"}' },
    });
    try {
        storeProbe(data.root, `
            ${clockSource}
            const before = directoryBytes(root);
            const original = structuredClone(store.getDoc("arc-one"));
            const events = [];
            const unsubscribe = store.subscribe("*", event => events.push(event));
            let removed = 0;
            store.beforeRemove.push(() => removed++);
            at("2026-11-03T20:00:00.000Z");
            const [archived, duplicate] = await Promise.all([store.archive("arc-one"), store.archive("arc-one")]);
            assert.equal(archived.version, 3);
            assert.deepEqual(duplicate, archived);
            assert.equal(archived.archivedAt, "2026-11-03T20:00:00.000Z");
            const current = store.getDoc("arc-one");
            for (const field of ["id", "kind", "createdAt", "updatedAt", "content", "target", "pullRequest", "nextId"])
                assert.deepEqual(current[field], original[field], field);
            assert.equal(current.lastEdit, null);
            assert.equal(Object.hasOwn(current, "savedAt"), false);
            assert.equal(Object.hasOwn(current, "reason"), false);
            assert.equal(removed, 0);
            assert.equal(events.filter(event => event.type === "version").length, 1);
            assert.equal(events.filter(event => event.type === "catalog").length, 1);
            const bytes = directoryBytes(root);
            for (const [file, hash] of Object.entries(before)) if (file !== join("docs", "arc-one", "current.json")) assert.equal(bytes[file], hash, file);
            assert.deepEqual(ordinary(), []);
            assert.deepEqual(ordinary({status:"archived"}), ["arc-one"]);
            assert.deepEqual(ordinary({status:"all"}), ["arc-one"]);
            assert.equal(store.findByPullRequest(original.pullRequest.url.toUpperCase()).id, "arc-one");
            assert.equal(store.getDoc("arc-one").id, "arc-one");
            assert.equal(store.history("arc-one").at(-1).at, "2026-11-03T20:00:00.000Z");
            assert.equal(store.getVersion("arc-one", 3).updatedAt, original.updatedAt);
            assert.equal(store.getVersion("arc-one", 3).savedAt, "2026-11-03T20:00:00.000Z");
            assert.equal(store.history("arc-one")[1].at, original.updatedAt);
            at("2026-11-04T20:00:00.000Z");
            await store.archive("arc-one");
            assert.deepEqual(directoryBytes(root), bytes);
            assert.equal(events.length, 2);
            storeProbe(root, ${JSON.stringify(`
                assert.deepEqual(ordinary({status:"archived"}), ["arc-one"]);
                const current = store.getDoc("arc-one");
                assert.equal(current.version, 3);
                assert.equal(current.archivedAt, "2026-11-03T20:00:00.000Z");
                assert.equal(current.createdAt, "2026-09-01T08:00:00.000Z");
                assert.equal(current.updatedAt, "2026-10-01T09:00:00.000Z");
                assert.equal(store.history("arc-one").at(-1).at, "2026-11-03T20:00:00.000Z");
            `)});
            at("2026-11-05T20:00:00.000Z");
            await store.applyEdit("arc-one", {type:"update", targetId:"md-1", changes:{markdown:"Edited while archived"}});
            assert.equal(store.getDoc("arc-one").content[0].markdown, "Edited while archived");
            assert.equal(store.getDoc("arc-one").updatedAt, "2026-11-05T20:00:00.000Z");
            assert.equal(store.getDoc("arc-one").archivedAt, archived.archivedAt);
            const beforeUnarchive = structuredClone(store.getDoc("arc-one"));
            at("2026-11-06T20:00:00.000Z");
            const [active, again] = await Promise.all([store.unarchive("arc-one"), store.unarchive("arc-one")]);
            assert.equal(active.version, 5);
            assert.equal(active.archivedAt, null);
            assert.deepEqual(active, again);
            for (const field of ["createdAt", "updatedAt", "content", "target", "pullRequest"])
                assert.deepEqual(store.getDoc("arc-one")[field], beforeUnarchive[field]);
            const unarchivedBytes = directoryBytes(root);
            for (const [file, hash] of Object.entries(before)) if (file !== join("docs", "arc-one", "current.json")) assert.equal(unarchivedBytes[file], hash, file);
            assert.equal(store.getDoc("arc-one").lastEdit, null);
            await store.unarchive("arc-one");
            assert.deepEqual(directoryBytes(root), unarchivedBytes);
            assert.equal(events.filter(event => event.type === "version").length, 3);
            assert.equal(events.filter(event => event.type === "catalog").length, 3);
            assert.equal(removed, 0);
            unsubscribe();
            console.log("archive v3 -> archived edit v4 -> unarchive v5; one event pair per transition; fresh reload verified");
        `);
    } finally { data.close(); }
});

test("TC-06: restore overlays current identity/kind/creation/archive/nextId and strips snapshot-only data", () => {
    const doc = archiveFixture();
    const old = { ...doc, id: "wrong-snapshot-id", kind: "whiteboard", version: 1, nextId: 2, createdAt: "2026-08-01T00:00:00.000Z", archivedAt: false, savedAt: "old-snapshot-only", reason: "old-reason", content: [{ id: "md-1", type: "markdown", markdown: "Old text" }] };
    const data = fixture([doc], { snapshots: { "arc-one": [old, { ...doc, version: 2 }] } });
    try {
        storeProbe(data.root, `
            ${clockSource}
            const oldBytes = directoryBytes(join(root, "docs", "arc-one", "versions"));
            at("2026-11-03T20:00:00.000Z");
            await store.archive("arc-one");
            at("2026-11-04T20:00:00.000Z");
            const restored = await store.restore("arc-one", 1);
            let current = store.getDoc("arc-one");
            assert.equal(restored.version, 4);
            assert.equal(current.content[0].markdown, "Old text");
            assert.equal(current.id, "arc-one");
            assert.equal(current.kind, "doc");
            assert.equal(current.createdAt, "2026-09-01T08:00:00.000Z");
            assert.equal(current.updatedAt, "2026-11-04T20:00:00.000Z");
            assert.equal(current.archivedAt, "2026-11-03T20:00:00.000Z");
            assert.equal(current.nextId, 100);
            assert.equal(Object.hasOwn(current, "reason"), false);
            assert.equal(Object.hasOwn(current, "savedAt"), false);
            assert.equal(current.lastEdit, null);
            await store.unarchive("arc-one");
            at("2026-11-05T20:00:00.000Z");
            await store.restore("arc-one", 3);
            current = store.getDoc("arc-one");
            assert.equal(current.archivedAt, null);
            assert.equal(current.version, 6);
            assert.equal(current.content[0].markdown, "Keep this");
            assert.equal(current.createdAt, "2026-09-01T08:00:00.000Z");
            assert.equal(current.nextId, 100);
            assert.equal(Object.hasOwn(current, "reason"), false);
            assert.equal(Object.hasOwn(current, "savedAt"), false);
            const nowBytes = directoryBytes(join(root, "docs", "arc-one", "versions"));
            for (const [file, bytes] of Object.entries(oldBytes)) assert.equal(nowBytes[file], bytes);
            const beforeFailure = directoryBytes(root);
            await assert.rejects(store.restore("arc-one", 999), /No version/);
            assert.deepEqual(directoryBytes(root), beforeFailure);
            storeProbe(root, ${JSON.stringify(`
                const current = store.getDoc("arc-one");
                assert.equal(current.version, 6);
                assert.equal(current.archivedAt, null);
                assert.equal(current.createdAt, "2026-09-01T08:00:00.000Z");
                assert.equal(current.updatedAt, "2026-11-05T20:00:00.000Z");
                assert.equal(current.nextId, 100);
            `)});
        `);
    } finally { data.close(); }
});

test("TC-06: legacy absent and null current archive states survive archived/malformed old snapshots", () => {
    const absent = page("restore-absent", { version: 2 });
    const nullable = page("restore-null", { version: 2, archivedAt: null });
    const data = fixture([absent, nullable], { snapshots: {
        "restore-absent": [{ ...absent, version: 1, archivedAt: time("2026-10-14") }],
        "restore-null": [{ ...nullable, version: 1, archivedAt: 0 }],
    } });
    try {
        storeProbe(data.root, `
            ${clockSource}
            at("2026-11-04T20:00:00.000Z");
            await store.restore("restore-absent", 1);
            await store.restore("restore-null", 1);
            assert.equal(Object.hasOwn(store.getDoc("restore-absent"), "archivedAt"), false);
            assert.equal(store.getDoc("restore-null").archivedAt, null);
            assert.deepEqual(ordinary({sort:"created"}), ["restore-absent","restore-null"]);
            const keys = Object.keys(store.summary(store.getDoc("restore-null"))).sort();
            assert.deepEqual(keys, ["activity","archivedAt","blocks","createdAt","documentId","kind","pullRequest","repository","target","title","updatedAt","version"]);
        `);
    } finally { data.close(); }
});

test("TC-07: legacy absent/null stay active without rewrite; scratchpad always prefixes and cannot archive", () => {
    const data = fixture([page("legacy-one"), page("legacy-null", { archivedAt: null }), page("archived-good", { archivedAt: time("2026-10-14") })]);
    try {
        const before = directoryBytes(data.root);
        storeProbe(data.root, `
            const before = directoryBytes(root);
            const events = [];
            store.subscribe("*", event => events.push(event));
            assert.deepEqual(ordinary(), ["legacy-null", "legacy-one"]);
            assert.deepEqual(ordinary({status:"archived"}), ["archived-good"]);
            assert.deepEqual(ordinary({query:"missing", status:"archived"}), []);
            assert.equal(store.list()[1].archivedAt, null);
            for (const action of [store.archive, store.unarchive]) await assert.rejects(action("scratchpad"), /scratchpad cannot be archived or unarchived/);
            await store.unarchive("legacy-one");
            await store.unarchive("legacy-null");
            assert.deepEqual(events, []);
            assert.deepEqual(directoryBytes(root), before);
        `);
        assert.deepEqual(directoryBytes(data.root), before);
        assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(data.root, "docs", "legacy-one", "current.json"), "utf8")), "archivedAt"), false);
    } finally { data.close(); }
    const absent = page("absent");
    assert.deepEqual(parseArchiveState(absent), { ok: true, value: { kind: "active" } });
    assert.deepEqual(parseArchiveState({ ...absent, archivedAt: null }), { ok: true, value: { kind: "active" } });
    assert.deepEqual(parseArchiveState({ ...absent, archivedAt: "1970-01-01T00:00:00.000Z" }), { ok: true, value: { kind: "archived", archivedAt: "1970-01-01T00:00:00.000Z", epoch: 0 } });
    assert.equal(parseArchiveState({ ...absent, archivedAt: undefined }).ok, false);
});

test("TC-07: malformed archived ingress rejects before filtering/writes without losing the raw record", async (t) => {
    const bad = [["false", false], ["zero", 0], ["empty", ""], ["invalid", "not-a-date"], ["object", {}], ["array", []], ["noncanonical", "2026-10-14T10:00:00Z"], ["rollover", "2026-02-30T10:00:00.000Z"]];
    for (const [name, archivedAt] of bad) await t.test(name, () => {
        const doc = page(`bad-${name}`, { archivedAt, version: 2, title: "Archive metadata fixture", content: [{ id: "md-1", type: "markdown", markdown: "Keep bytes" }] });
        const data = fixture([doc], {
            snapshots: { [doc.id]: [{ ...doc, version: 1 }] },
            attachments: { [join("docs", doc.id, "command", "state.json")]: "unchanged synthetic attachment" },
        });
        try {
            const parsed = parseArchiveState(doc);
            assert.equal(parsed.ok, false);
            assert.equal(parsed.issues[0].documentId, doc.id);
            assert.equal(parsed.issues[0].path, "archivedAt");
            assert.equal(parsed.issues[0].code, "invalid_archive_state");
            storeProbe(data.root, `
                const id = ${JSON.stringify(doc.id)};
                const rawArchive = ${JSON.stringify(archivedAt)};
                const before = directoryBytes(root);
                const events = [];
                store.subscribe("*", event => events.push(event));
                const raw = structuredClone(store.getDoc(id));
                const isInput = error => {
                    assert.equal(error.name, "InputError");
                    assert.equal(error.issues[0].documentId, id);
                    assert.equal(error.issues[0].path, "archivedAt");
                    assert.equal(error.issues[0].code, "invalid_archive_state");
                    assert.ok(error.message.includes(id) && error.message.includes("archivedAt"));
                    return true;
                };
                for (const status of ["active", "archived", "all"]) {
                    assert.throws(() => store.list({status}), isInput);
                    assert.throws(() => store.list({status,query:"unrelated"}), isInput);
                }
                assert.throws(() => store.summary(store.getDoc(id)), isInput);
                for (const mutation of [() => store.archive(id), () => store.unarchive(id), () => store.restore(id,1), () => store.rename(id,"Must not save"), () => store.applyEdit(id,{type:"update",targetId:"md-1",changes:{markdown:"Must not save"}})])
                    await assert.rejects(mutation(), isInput);
                assert.deepEqual(store.getDoc(id), raw);
                assert.deepEqual(store.getDoc(id).archivedAt, rawArchive);
                assert.equal(store.hasDoc(id), true);
                assert.deepEqual(directoryBytes(root), before);
                assert.deepEqual(events, []);
            `);
        } finally { data.close(); }
    });
});
