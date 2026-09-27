// Unit tests for the doc outline (Contents card, Ctrl/⌘-J) and its fuzzy ranking. Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";

const { outlineOf, rank, matchToken } = await import("../extensions/marginal/web/outline.js");

const doc = {
    content: [
        { id: "sec-1", type: "section", title: "What **and** why", children: [{ id: "md-2", type: "markdown", markdown: "Intro.\n\n## Goals\n\n```md\n## not a heading\n```\n\n### Non-goals\n\n## Risks" }] },
        {
            id: "sec-3",
            type: "section",
            title: "Design",
            children: [
                { id: "seq-4", type: "sequence", title: "Request path", actors: {}, steps: [] },
                { id: "sec-5", type: "section", title: "Deep", children: [{ id: "flow-6", type: "flow_diagram", title: "Retry flow", nodes: [], edges: [] }] },
                { id: "note-7", type: "callout", title: "Tradeoff", children: [{ id: "md-8", type: "markdown", markdown: "Plain." }] },
                { id: "note-9", type: "callout", children: [] },
                { id: "peek-10", type: "code_peek", source: { file: "src/a/server.ts" } },
                { id: "code-11", type: "code", language: "ts", text: "x" },
            ],
        },
        { id: "flow-12", type: "flow_diagram", title: "Top-level flow", nodes: [], edges: [] },
    ],
};

test("outline: a tree that follows the doc; headings nest by rank", () => {
    const o = outlineOf(doc);
    assert.deepEqual(
        o.map((e) => `${e.level}:${e.kind}:${e.label}<${e.parent ?? "-"}`),
        ["1:section:What and why<-", "2:heading:Goals<sec-1", "3:heading:Non-goals<md-2#0", "2:heading:Risks<sec-1", "1:section:Design<-", "2:sequence:Request path<sec-3", "2:section:Deep<sec-3", "3:flow_diagram:Retry flow<sec-5", "2:callout:Tradeoff<sec-3", "2:code_peek:server.ts<sec-3", "1:flow_diagram:Top-level flow<-"],
    );
    assert.deepEqual(o.filter((e) => e.hasChildren).map((e) => e.key), ["sec-1", "md-2#0", "sec-3", "sec-5"]);
    // Headings inside code fences are skipped; real ones are matched to rendered headings by order.
    assert.deepEqual(o.filter((e) => e.kind === "heading").map((e) => [e.key, e.heading]), [["md-2#0", 0], ["md-2#1", 1], ["md-2#2", 2]]);
    assert.deepEqual(o.find((e) => e.blockId === "flow-6").trail, ["Design", "Deep"]);
    assert.deepEqual(outlineOf(null), []);
});

test("rank: fuzzy on labels, prefix and word starts first, type and section words narrow", () => {
    const o = outlineOf(doc);
    assert.equal(rank(o, "").length, o.length);
    assert.equal(rank(o, "trade")[0].e.label, "Tradeoff");
    assert.equal(rank(o, "rtf")[0].e.label, "Retry flow"); // subsequence with word starts
    assert.deepEqual(rank(o, "flow").map((h) => h.e.label).slice(0, 2).sort(), ["Retry flow", "Top-level flow"]);
    assert.equal(rank(o, "seq")[0].e.label, "Request path"); // by kind
    assert.equal(rank(o, "deep retry")[0].e.label, "Retry flow"); // section word + label
    assert.deepEqual(rank(o, "zzz"), []);
    assert.deepEqual(rank(o, "trade")[0].pos, [0, 1, 2, 3, 4]);
});

test("matchToken prefers boundaries and contiguity", () => {
    assert.ok(matchToken("flow", "Retry flow").score > matchToken("flow", "overflowing").score);
    assert.ok(matchToken("rf", "Retry flow").score > matchToken("rf", "error form").score);
    assert.equal(matchToken("xyz", "Retry flow"), null);
});
