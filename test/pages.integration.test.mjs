import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { actionProbe } from "./fixtures/pages-actions.mjs";
import { canonicalPages, excludedCases, fixture, page, PHRASE, time } from "./fixtures/pages.mjs";

async function check(documents, scenario, options) {
    const data = fixture(documents, options);
    try { return await actionProbe(data.root, { ids: documents.map((doc) => doc.id), ...scenario }); }
    finally { data.close(); }
}

const relevance = ["a-title-phrase", "b-body-phrase", "c-body-phrase", "k-equal-phrase", "d-title-separated", "e-title-one", "f-cross-fields", "g-body-reversed"];
test("TC-08/09: fixed C through actual HTTP, registered canvas and headless dispatch", async () => {
    await check(canonicalPages(), { kind: "catalog", cases: [
        [{ query: PHRASE }, relevance],
        [{ query: "  UPDATING   VSCode  " }, relevance],
        [{ query: PHRASE, status: "all" }, ["j-archived", ...relevance]],
        [{ query: PHRASE, status: "archived" }, ["j-archived"]],
        [{ query: PHRASE, sort: "updated", direction: "desc" }, ["f-cross-fields", "g-body-reversed", "e-title-one", "d-title-separated", "c-body-phrase", "k-equal-phrase", "b-body-phrase", "a-title-phrase"]],
        [{ query: PHRASE, sort: "updated", direction: "asc" }, relevance],
        [{ query: PHRASE, sort: "created", direction: "asc" }, ["a-title-phrase", "f-cross-fields", "g-body-reversed", "d-title-separated", "c-body-phrase", "k-equal-phrase", "e-title-one", "b-body-phrase"]],
        [{ query: PHRASE, sort: "created", direction: "desc" }, ["b-body-phrase", "e-title-one", "c-body-phrase", "k-equal-phrase", "d-title-separated", "f-cross-fields", "g-body-reversed", "a-title-phrase"]],
        [{}, ["i-history-only", "h-one-token", "f-cross-fields", "g-body-reversed", "e-title-one", "d-title-separated", "c-body-phrase", "k-equal-phrase", "b-body-phrase", "a-title-phrase"]],
        [{ query: " \t " }, ["i-history-only", "h-one-token", "f-cross-fields", "g-body-reversed", "e-title-one", "d-title-separated", "c-body-phrase", "k-equal-phrase", "b-body-phrase", "a-title-phrase"]],
        [{ query: "update" }, []],
        [{ query: "vscode." }, ["b-body-phrase"]],
        [{ query: "updating updating" }, ["e-title-one", "d-title-separated", "a-title-phrase", "f-cross-fields", "g-body-reversed", "c-body-phrase", "k-equal-phrase", "b-body-phrase"]],
        [{ query: PHRASE, dateField: "updated", from: "2026-10-07T00:00:00.000Z", until: "2026-10-10T00:00:00.000Z" }, ["c-body-phrase", "k-equal-phrase", "d-title-separated", "e-title-one"]],
        [{ query: PHRASE, sort: "created", dateField: "updated", from: "2026-10-07T00:00:00.000Z", until: "2026-10-10T00:00:00.000Z" }, ["e-title-one", "c-body-phrase", "k-equal-phrase", "d-title-separated"]],
        [{ query: PHRASE, dateField: "created" }, relevance],
    ] }, { snapshots: { "i-history-only": [page("i-history-only")] } });
});

test("TC-02/08/09: independent secondary dates and mixed validity at all public boundaries", async () => {
    await check([
        page("secondary-a", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-10") }),
        page("secondary-z", { createdAt: time("2026-10-02"), updatedAt: time("2026-10-10") }),
    ], { kind: "catalog", cases: [
        [{ query: PHRASE }, ["secondary-z", "secondary-a"]],
        [{ sort: "updated", direction: "asc" }, ["secondary-z", "secondary-a"]],
        [{ sort: "updated", direction: "desc" }, ["secondary-z", "secondary-a"]],
    ] });
    await check([
        page("created-a", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-10") }),
        page("created-z", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-11") }),
    ], { kind: "catalog", cases: [
        [{ sort: "created", direction: "asc" }, ["created-z", "created-a"]],
        [{ sort: "created", direction: "desc" }, ["created-z", "created-a"]],
        [{ query: PHRASE }, ["created-z", "created-a"]],
        [{ sort: "updated", direction: "asc" }, ["created-a", "created-z"]],
        [{ sort: "updated", direction: "desc" }, ["created-z", "created-a"]],
    ] });
    await check([
        page("mix-created-only", { createdAt: time("2026-10-02"), updatedAt: "not-a-date" }),
        page("mix-updated-only", { createdAt: "not-a-date", updatedAt: time("2026-10-02") }),
        page("mix-both", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-01") }),
    ], { kind: "catalog", cases: [
        [{ query: PHRASE }, ["mix-updated-only", "mix-both", "mix-created-only"]],
        [{ sort: "updated", direction: "desc" }, ["mix-updated-only", "mix-both", "mix-created-only"]],
        [{ sort: "updated", direction: "asc" }, ["mix-both", "mix-updated-only", "mix-created-only"]],
        [{ sort: "created", direction: "desc" }, ["mix-created-only", "mix-both", "mix-updated-only"]],
        [{ sort: "created", direction: "asc" }, ["mix-both", "mix-created-only", "mix-updated-only"]],
        [{ dateField: "created", from: "2026-10-02T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" }, ["mix-created-only"]],
        [{ dateField: "updated", from: "2026-10-02T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" }, ["mix-updated-only"]],
    ] });
});

test("TC-04/07/08/09: public queries retain corpus exclusions, legacy defaults and unknown dates", async () => {
    await check(excludedCases(), { kind: "catalog", cases: [[{ query: PHRASE }, []]] });
    await check([
        page("legacy-one"), page("legacy-null", { archivedAt: null }),
        page("archived-good", { archivedAt: time("2026-10-14") }),
    ], { kind: "catalog", cases: [
        [{}, ["legacy-null", "legacy-one"]],
        [{ status: "archived" }, ["archived-good"]],
        [{ status: "all", query: PHRASE }, ["archived-good", "legacy-null", "legacy-one"]],
    ] });
    const missing = page("u-missing"); delete missing.createdAt; delete missing.updatedAt;
    await check([missing, page("u-invalid", { createdAt: "Mon, 02/30/2026 10:00:00 GMT", updatedAt: "not-a-date" }), page("u-known", { createdAt: time("2026-10-01"), updatedAt: time("2026-10-02") })], { kind: "catalog", cases: [
        ...["created", "updated"].flatMap((sort) => ["asc", "desc"].map((direction) => [{ sort, direction }, ["u-known", "u-invalid", "u-missing"]])),
        [{ dateField: "created", from: "2026-03-02T00:00:00.000Z", until: "2026-03-03T00:00:00.000Z" }, []],
    ] });
});

test("TC-07/08/09: malformed queries, scratchpad, missing docs/versions and dispatcher failures are nonmutating", async () => {
    await check([page("input-one")], { kind: "invalid", id: "input-one", cases: [
        [{ status: "unknown" }, "status must"],
        [{ sort: "unknown" }, "sort must"],
        [{ direction: "sideways" }, "direction must"],
        [{ dateField: "unknown" }, "dateField must"],
        [{ from: time("2026-10-01") }, "Date bounds require"],
        [{ dateField: "updated", from: "2026-10-01" }, "canonical UTC"],
        [{ dateField: "updated", from: "2026-02-30T10:00:00.000Z" }, "canonical UTC"],
        [{ dateField: "created", from: time("2026-10-02"), until: time("2026-10-01") }, "until must be after"],
        [{ dateField: "created", from: time("2026-10-01"), until: time("2026-10-01") }, "until must be after"],
        [{ sort: "relevance" }, "Relevance requires"],
        [{ query: PHRASE, sort: "relevance", direction: "asc" }, "Relevance has no direction"],
        [{ unrelated: "value" }, "Unknown catalog option"],
    ] });
});

test("TC-07/08/09: malformed stored archive ingress is retained before every public mutation/filter", async (t) => {
    for (const [name, value] of [["false", false], ["zero", 0], ["empty", ""], ["invalid", "not-a-date"], ["object", {}], ["array", []], ["noncanonical", "2026-10-14T10:00:00Z"], ["rollover", "2026-02-30T10:00:00.000Z"]]) await t.test(name, async () => {
        const id = `bad-${name}`;
        await check([page(id, { version: 2, archivedAt: value })], { kind: "bad-archive", id }, { snapshots: { [id]: [page(id, { version: 1 })] } });
    });
});

const arc = () => page("arc-one", {
    title: "Archive fixture", version: 2, createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z",
    pullRequest: { url: "https://github.com/acme/app/pull/7" },
    content: [{ id: "md-1", type: "markdown", markdown: "Keep this" }],
});

test("TC-08: actual token/Host, static asset and source validation remain intact", async () => {
    await check([arc()], { kind: "auth", id: "arc-one" });
});

test("TC-05/06/08/09: actual transitions, SSE, archived edit/open/reuse, content restore and fresh restart", async () => {
    const old = page("arc-one", { version: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z", content: [{ id: "md-1", type: "markdown", markdown: "Old text" }] });
    const data = fixture([arc(), page("delete-me")], {
        snapshots: { "arc-one": [old, arc()] },
        attachments: {
            [join("docs", "arc-one", "attached", "sentinel.txt")]: "Owned attachment",
            [join("docs", "arc-one", "command", "state.json")]: JSON.stringify({ fixture: "unchanged" }),
            [join("docs", "arc-one", "prs", "index.json")]: JSON.stringify({ v: 1, prs: [] }),
        },
    });
    try {
        const paths = [join("docs", "arc-one", "command", "state.json"), join("docs", "arc-one", "prs", "index.json")];
        const before = paths.map((path) => readFileSync(join(data.root, path), "utf8"));
        await actionProbe(data.root, { kind: "mutations", id: "arc-one" });
        assert.deepEqual(paths.map((path) => readFileSync(join(data.root, path), "utf8")), before);
        await actionProbe(data.root, { kind: "restart", id: "arc-one", expected: {
            archivedAt: null, version: 7, createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-11-03T20:03:00.000Z",
            content: [{ id: "md-1", type: "markdown", markdown: "Keep this" }],
        } });
    } finally { data.close(); }
});

test("TC-09: actual canvas.open -> HTTP ask -> SDK send id -> correlated event enforces Discuss", async () => {
    await check([arc()], { kind: "discuss", id: "arc-one" });
});

test("TC-05-L: real owned PR watcher survives actual HTTP/canvas/headless archive and unarchive", async (t) => {
    for (const boundary of ["http", "canvas", "headless"]) await t.test(boundary, async () => {
        await check([page("arc-live")], { kind: "lifecycle", id: "arc-live", boundary }, {
            attachments: { [join("docs", "arc-live", "command", "state.json")]: JSON.stringify({ plan: null, fronts: [], fixture: "inactive-command" }) },
        });
    });
});

test("TC-19: actual settings reads retain missing/malformed and field-wise fallback without repair", async () => {
    const defaults = {
        shortcuts: { jump: true, stepKeys: true, tourKey: true, markdown: true, chat: true }, theme: "auto", effects: true,
        interrupt: { doc: false, command: true }, command: { worktrees: false },
    };
    for (const [raw, settings] of [
        [undefined, defaults],
        ["{ malformed", defaults],
        [JSON.stringify({ theme: ["solarized-dark"] }), defaults],
        [JSON.stringify({ theme: "unknown", shortcuts: { jump: false, stepKeys: "no" }, interrupt: { doc: "yes", command: false }, effects: "no", command: { worktrees: "yes" } }), {
            ...defaults, shortcuts: { ...defaults.shortcuts, jump: false }, interrupt: { doc: false, command: false },
        }],
    ]) await check([page("settings-one")], { kind: "restart", id: "settings-one", expected: { version: 0 }, settings }, { attachments: raw === undefined ? {} : { "settings.json": raw } });
});

test("TC-19: Solarized settings HTTP/SSE/partial merge and fresh extension/server restart", async () => {
    for (const theme of ["solarized-light", "solarized-dark"]) {
        const data = fixture([page("settings-one")]);
        try {
            const result = await actionProbe(data.root, { kind: "settings", id: "settings-one", themes: [theme] });
            assert.equal(result.settings.theme, theme);
            await actionProbe(data.root, { kind: "restart", id: "settings-one", expected: { version: 0 }, settings: {
                shortcuts: { jump: false, stepKeys: false, tourKey: true, markdown: true, chat: true }, theme, effects: false,
                interrupt: { doc: true, command: false }, command: { worktrees: true },
            } });
        } finally { data.close(); }
    }
});
