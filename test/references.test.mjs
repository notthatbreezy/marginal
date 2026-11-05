import assert from "node:assert/strict";
import { test } from "node:test";
import { fenceOpening, isFenceClose, referenceText, scanReferences } from "../extensions/marginal/web/references.js";
import { REFERENCE as R } from "./fixtures/pages.mjs";
import { parseArchiveState, parseCatalogQuery, queryPages } from "../extensions/marginal/lib/catalog.mjs";

const sessions = (text) => scanReferences(text).filter((part) => part.type === "session");
const roundTrip = (text) => {
    const parts = scanReferences(text);
    assert.equal(parts.map((part) => part.type === "session" ? part.source : part.text).join(""), text);
    let offset = 0;
    for (const part of parts) {
        assert.equal(part.start, offset);
        assert.equal(text.slice(part.start, part.end), part.type === "session" ? part.source : part.text);
        offset = part.end;
    }
    assert.equal(offset, text.length);
    return parts;
};

test("TC-10: closed session shape, single quotes/permutation, and exact source offsets", () => {
    for (const raw of [R, "<copilot-ref label='Build helper' target-id='synthetic-session-1' kind='session'/>", '<copilot-ref\n target-id = "synthetic-session-1"\n label = \'Build helper\' kind = "session" />']) {
        const parts = roundTrip(`Before ${raw} after`);
        assert.deepEqual(parts.map((part) => part.type), ["text", "session", "text"]);
        assert.equal(parts[1].label, "Build helper");
        assert.equal(parts[1].source, raw);
        assert.equal(Object.hasOwn(parts[1], "targetId"), false);
        assert.equal(referenceText(`Before ${raw} after`), "Before Build helper after");
    }
    assert.deepEqual(scanReferences(""), []);
    assert.deepEqual(roundTrip("no references").map((part) => part.type), ["text"]);
    assert.equal(sessions(R + R).length, 2);
});

test("TC-10: malformed, incomplete, duplicate, nested and unknown attributes stay literal", () => {
    const bad = [
        R.replace('kind="session"', 'kind="project"'), R.replace("copilot-ref", "Copilot-ref"),
        R.replace(' label="Build helper"', ""), R.replace(' target-id="synthetic-session-1"', ""),
        R.replace('kind="session"', 'kind="session" kind="session"'),
        R.replace('label="Build helper"', 'label="First" label="Last"'),
        ...["href", "onclick", "style", "unknown"].map((attribute) => R.replace(" />", ` ${attribute}="unsafe" />`)),
        R.replace('label="Build helper"', 'label=""'), R.replace('label="Build helper"', 'label=" \n "'),
        R.replace('target-id="synthetic-session-1"', 'target-id=""'), R.replace('target-id="synthetic-session-1"', 'target-id="  "'),
        R.replace('label="Build helper"', 'label="Build helper\''), R.replace('label="Build helper"', "label=Build"),
        R.replace(" />", ">"), R.replace(" />", `>${R}</copilot-ref>`), R.replace(" />", `>${R}`),
        R.replace(" />", " / >"), R.slice(0, -1), "<copilot-ref",
        '<copilot-ref kind="session"target-id="synthetic" label="Wrong spacing" />',
        '<copilot-ref kind="session" target-id="synthetic" label="unterminated ' + R,
    ];
    for (const text of bad) {
        assert.equal(sessions(text).length, 0, text);
        assert.equal(referenceText(text), text);
        roundTrip(text);
    }
});

test("TC-10: only the fixed entity set decodes once; hostile labels remain plain data", () => {
    const raw = R.replace("Build helper", 'A &amp; B &lt; &gt; &quot; &apos; &amp;lt; &#60; &unknown;');
    assert.equal(sessions(raw)[0].label, 'A & B < > " \' &lt; &#60; &unknown;');
    const unsafe = R.replace("Build helper", "<img src=x onerror=alert(1)>");
    assert.equal(sessions(unsafe)[0].label, "<img src=x onerror=alert(1)>");
    assert.equal(referenceText(unsafe), "<img src=x onerror=alert(1)>");
    assert.equal(sessions(R.replace("Build helper", " `**literal**`  label "))[0].label, " `**literal**`  label ");
    roundTrip(unsafe);
});

test("TC-10: single and exactly matching multiple inline backticks protect full source", () => {
    for (const ticks of ["`", "``", "````"]) {
        const code = ticks + R + ticks;
        const text = `Before ${code} after ${R}`;
        assert.equal(sessions(text).length, 1);
        assert.deepEqual(roundTrip(text).map((part) => part.type), ["text", "literal", "text", "session"]);
        assert.equal(referenceText(text), `Before ${code} after Build helper`);
    }
    const mixed = "``literal ` " + R + " ` literal``";
    assert.equal(sessions(mixed).length, 0);
    roundTrip(mixed);
    roundTrip("`unclosed");
    roundTrip("``unclosed `\nordinary");
});

test("TC-10: triple/four fences and standalone closing runs share a narrow delimiter rule", () => {
    assert.deepEqual(fenceOpening("````js"), { length: 4, language: "js" });
    assert.equal(fenceOpening(" ```js"), null);
    assert.equal(fenceOpening("``js"), null);
    assert.equal(isFenceClose("```", 4), false);
    assert.equal(isFenceClose("```` trailing text", 4), false);
    assert.equal(isFenceClose("````` \t", 4), true);
    for (const ticks of ["```", "````"]) {
        const text = `${ticks}text\n${R}\n${ticks}\nAfter ${R}`;
        assert.equal(sessions(text).length, 1);
        assert.deepEqual(roundTrip(text).map((part) => part.type), ["literal", "text", "session"]);
    }
    const nested = ["````text", "```", R, "```", "````", "After " + R].join("\n");
    const parts = roundTrip(nested);
    assert.equal(parts[0].text, ["````text", "```", R, "```", "````", ""].join("\n"));
    assert.equal(sessions(nested).length, 1);
    for (const partial of ["````text\n```", "````text\n```\n" + R, "````text\n```\n" + R + "\n```"])
        assert.deepEqual(roundTrip(partial).map((part) => part.type), ["literal"]);
    const longerClose = ["````text", R, "`````", R].join("\r\n");
    assert.equal(sessions(longerClose).length, 1);
    roundTrip(longerClose);
});

test("TC-10: streamed complete prose converges; incomplete source never becomes a session", () => {
    for (let i = 0; i < R.length; i++) assert.equal(sessions(R.slice(0, i)).length, 0);
    assert.equal(sessions(R).length, 1);
    const source = `Line one\n${R}\nLine three`;
    assert.equal(referenceText(source), "Line one\nBuild helper\nLine three");
    roundTrip(source);
});

test("P1-002: supported quote depths preserve closed and unclosed code with exact raw offsets", async (t) => {
    for (const prefix of ["> ", ">> ", "> > ", ">\t", "> > > "]) for (const ticks of ["```", "````"]) await t.test(`${JSON.stringify(prefix)}-${ticks.length}`, () => {
        for (const newline of ["\n", "\r\n"]) {
            const lines = [prefix + ticks + "text", prefix + R];
            if (ticks.length === 4) lines.push(prefix + "```", prefix + R);
            lines.push(prefix + ticks + " not a closing fence", prefix + R);
            const unclosed = lines.join(newline);
            assert.equal(sessions(unclosed).length, 0);
            assert.deepEqual(roundTrip(unclosed).map((part) => part.type), ["literal"]);
            assert.equal(referenceText(unclosed), unclosed);

            const literal = [...lines, prefix + ticks + "` \t"].join(newline) + newline;
            const source = "🙂Before " + R + newline + literal + prefix + "After " + R + newline + "After " + R;
            const parts = roundTrip(source);
            assert.equal(sessions(source).length, 3);
            assert.deepEqual(parts.filter((part) => part.type === "literal").map((part) => part.text), [literal]);
            assert.equal(referenceText(source), "🙂Before Build helper" + newline + literal + prefix + "After Build helper" + newline + "After Build helper");

            const leftContainer = unclosed + newline + "After " + R;
            assert.equal(sessions(leftContainer).length, 1);
            assert.equal(referenceText(leftContainer), unclosed + newline + "After Build helper");
            roundTrip(leftContainer);
        }
    });
});

test("P1-002: a nested quote fence ends at its own container, not at an extra quote prefix", () => {
    const literal = [">> ```text", ">> " + R, ">> ```", ""].join("\n");
    const source = literal + "> After " + R + "\nAfter " + R;
    assert.equal(sessions(source).length, 2);
    assert.equal(referenceText(source), literal + "> After Build helper\nAfter Build helper");
    roundTrip(source);

    const deeperFence = ["> ```text", ">> ```", "> " + R, "> ```", ""].join("\n");
    const after = deeperFence + "> After " + R;
    assert.equal(sessions(after).length, 1);
    assert.equal(referenceText(after), deeperFence + "> After Build helper");
    roundTrip(after);

    const unclosedNested = [">> ````text", ">> ```", ">> " + R, ""].join("\n");
    const shallower = unclosedNested + "> After " + R + "\nAfter " + R;
    assert.equal(sessions(shallower).length, 2);
    assert.equal(referenceText(shallower), unclosedNested + "> After Build helper\nAfter Build helper");
    roundTrip(shallower);
});

test("P1-002: existing recursive core blockquotes already render these triple fences as code", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
    try {
        const { markdown } = await import("../extensions/marginal/web/core.js");
        for (const prefix of ["> ", ">> ", "> > "]) {
            const source = [prefix + "```text", prefix + R, prefix + "```"].join("\n");
            const html = markdown(source);
            assert.match(html, /<blockquote>[\s\S]*<pre><code>&lt;copilot-ref/);
            assert.match(html, /label=&quot;Build helper&quot; \/&gt;<\/code><\/pre>/);
            assert.equal(sessions(source).length, 0);
            assert.equal(referenceText(source), source);
            roundTrip(source);
        }
    } finally {
        if (previous) Object.defineProperty(globalThis, "location", previous);
        else delete globalThis.location;
    }
});

test("TC-11: actual core protects code/four fences and interactive link labels before inert pills", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
    try {
        const { inline, markdown, referencePlain, highlight } = await import("../extensions/marginal/web/core.js");
        const pills = (html) => (html.match(/class="session-ref"/g) ?? []).length;
        assert.equal(pills(inline(`Before ${R} after`)), 1);
        assert.match(inline(R), /role="note" aria-label="Separate Copilot session: Build helper"/);
        for (const delimiter of ["`", "``", "````"]) assert.equal(pills(inline(`${delimiter}${R}${delimiter}`)), 0);
        const literal = ["````text", "```", R, "```", "````"].join("\n");
        assert.equal(pills(markdown(literal)), 0);
        assert.equal(pills(markdown(`${literal}\nAfter ${R}`)), 1);
        assert.equal(pills(markdown(["````text", "```", R].join("\n"))), 0);
        const linked = inline(`[${R}](https://example.invalid/) then ${R} and [ordinary](https://example.invalid/)`);
        assert.equal(pills(linked), 1);
        assert.match(linked, /<a href="https:\/\/example.invalid\/"[^>]*>&lt;copilot-ref/);
        assert.doesNotMatch(linked, /<a[^>]*>[^<]*<span class="session-ref"/);
        const sourceLinked = inline(`[${R}](https://example.invalid/) then ${R}`, "source");
        assert.equal((sourceLinked.match(/data-ref-source/g) ?? []).length, 1);
        assert.doesNotMatch(sourceLinked, /<a[^>]*><span/);
        assert.match(inline("[`code`](https://example.invalid/)"), /<a[^>]*><code>code<\/code><\/a>/);
        assert.match(inline("[ordinary](https://example.invalid/?a=1&b=2)"), /href="https:\/\/example.invalid\/\?a=1&amp;b=2"/);
        assert.match(inline("[ordinary](https://example.invalid/?a=1&amp;b=2)"), /href="https:\/\/example.invalid\/\?a=1&amp;amp;b=2"/);
        assert.equal(pills(referencePlain(`First line\n${R}\n**not Markdown**`)), 1);
        assert.match(referencePlain(`First line\n${R}\n**not Markdown**`), /\n\*\*not Markdown\*\*$/);
        assert.equal(pills(highlight(R, "javascript")), 0);
        assert.doesNotMatch(inline(`<script>bad</script> ${R}`), /<script>/);
        assert.match(markdown(`- Parent ${R}\n  - Child ${R}`, true), /<li data-l="1-1">/);
    } finally {
        if (previous) Object.defineProperty(globalThis, "location", previous);
        else delete globalThis.location;
    }
});

test("P3-001: source frames preserve accepted multiline references before paragraph/list normalization", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
    try {
        const { markdown, esc } = await import("../extensions/marginal/web/core.js");
        for (const newline of ["\n", "\r\n"]) {
            const raw = `<copilot-ref${newline}  kind='session' target-id='synthetic-session-newline' label='Build${newline}  helper' />`;
            for (const prefix of ["", "- ", "  - "]) {
                const source = `${prefix}Before ${raw} after`;
                assert.equal(sessions(source).length, 1);
                const html = markdown(source, true, "source");
                assert.ok(html.includes(`<span data-ref-source="">${esc(raw).replace(/\r/g, "&#13;")}</span>`), JSON.stringify({ newline, prefix, html }));
                assert.match(html, /data-l="0-2"/);
            }
        }
        assert.equal(markdown("First line\nsecond line"), "<p>First line second line</p>");
        assert.equal(markdown("- First line\n  continuation"), "<ul><li>First line continuation</li></ul>");
        const fenced = ["```text", R, "```", "", `After ${R}`].join("\r\n");
        const html = markdown(fenced, true, "source");
        assert.equal((html.match(/data-ref-source/g) ?? []).length, 1);
        assert.match(html, /data-l="4-4"/);
    } finally {
        if (previous) Object.defineProperty(globalThis, "location", previous);
        else delete globalThis.location;
    }
});

async function withCore(run) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
    try { await run(await import("../extensions/marginal/web/core.js")); }
    finally {
        if (previous) Object.defineProperty(globalThis, "location", previous);
        else delete globalThis.location;
    }
}
const pills = (html) => (html.match(/class="session-ref"/g) ?? []).length;
const markers = (html) => (html.match(/data-ref-source=""/g) ?? []).length;
function searchHit(markdown, query = "needleliteral") {
    const doc = { id: "synthetic-reference", title: "Other", content: [{ type: "markdown", markdown }] };
    const parsed = parseCatalogQuery({ query });
    assert.equal(parsed.ok, true);
    const archive = parseArchiveState(doc);
    assert.equal(archive.ok, true);
    return queryPages([{ doc, archive: archive.value }], parsed.value).map((page) => page.id);
}

test("FINAL-reference accepted atoms survive block framing with exact physical source ranges", async (t) => {
    await withCore(async ({ markdown, inline, esc }) => {
        for (const newline of ["\n", "\r\n"]) for (const [family, raw] of [
            ["blank-label", `<copilot-ref kind="session" target-id="synthetic" label="Build${newline}${newline}helper" />`],
            ["blank-attributes", `<copilot-ref${newline}${newline}kind="session" target-id="synthetic" label="Build helper" />`],
            ["heading-label", `<copilot-ref kind="session" target-id="synthetic" label="Build${newline}# helper" />`],
        ]) for (const prefix of ["", "- ", "  - ", "# "]) await t.test(`${family} ${JSON.stringify(newline)} ${JSON.stringify(prefix)}`, () => {
            const unit = `${prefix}Before ${raw} after`;
            const count = unit.split("\n").length;
            const source = `${unit}${newline}${newline}Following prose`;
            assert.equal(sessions(source).length, 1);
            assert.equal(sessions(source)[0].source, raw);
            roundTrip(source);
            assert.equal(pills(inline(unit)), 1);
            const display = markdown(source, true), frame = markdown(source, true, "source");
            assert.equal(pills(display), 1);
            assert.equal(markers(frame), 1);
            assert.ok(frame.includes(`<span data-ref-source="">${esc(raw).replace(/\r/g, "&#13;")}</span>`), frame);
            for (const html of [display, frame]) {
                assert.match(html, new RegExp(`data-l="0-${count - 1}"`));
                assert.ok(html.includes(`<p data-l="${count + 1}-${count + 1}">Following prose</p>`), html);
                assert.equal((html.match(/<h1/g) ?? []).length, prefix === "# " ? 1 : 0);
            }
        });
    });
});

test("FINAL-reference table delimiters cannot split accepted source or invent cells", async (t) => {
    await withCore(async ({ markdown, esc }) => {
        for (const newline of ["\n", "\r\n"]) for (const raw of [
            '<copilot-ref kind="session" target-id="synthetic" label="Build | Test" />',
            `<copilot-ref${newline}${newline}kind="session" target-id="synthetic" label="Build${newline}# helper | Test" />`,
        ]) await t.test(JSON.stringify({ newline, raw }), () => {
            const source = [`| Name | Other |`, "| --- | --- |", `| ${raw} | Kept |`, "", "Following prose"].join(newline);
            const last = source.split("\n").length - 1;
            assert.equal(sessions(source).length, 1);
            const display = markdown(source, true), frame = markdown(source, true, "source");
            for (const html of [display, frame]) {
                assert.equal((html.match(/<td>/g) ?? []).length, 2, html);
                assert.equal((html.match(/<th>/g) ?? []).length, 2, html);
                assert.match(html, /<td>Kept<\/td>/);
                assert.match(html, new RegExp(`<table data-l="0-${last - 2}"`));
                assert.ok(html.includes(`<p data-l="${last}-${last}">Following prose</p>`), html);
            }
            assert.equal(pills(display), 1);
            assert.equal(markers(frame), 1);
            assert.ok(frame.includes(`<span data-ref-source="">${esc(raw).replace(/\r/g, "&#13;")}</span>`));
        });
    });
});

test("FINAL-reference wrapped literal context agrees across raw, display, source and real catalog (18 cases)", async (t) => {
    await withCore(async ({ markdown, esc }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral");
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const kind of ["paragraph", "list", "quote"])
            await t.test(`${kind} ${ticks.length} ${JSON.stringify(newline)}`, () => {
                const lines = [`Before ${ticks}literal`, raw, `code${ticks} after`];
                const source = lines.map((line, i) => kind === "quote" ? `> ${line}` : kind === "list" ? `${i ? "  " : "- "}${line}` : line).join(newline);
                const display = markdown(source, true), frame = markdown(source, true, "source");
                assert.match(display, new RegExp(`<code>literal ${esc(raw)} code</code>`));
                assert.equal(pills(display), 0);
                assert.equal(markers(frame), 0);
                assert.match(frame, /<code(?:\s[^>]*)?>/);
                assert.equal(sessions(source).length, 0);
                assert.equal(referenceText(source), source);
                roundTrip(source);
                assert.deepEqual(searchHit(source), ["synthetic-reference"]);
                assert.match(display, /data-l="0-2"/);
                assert.match(frame, /data-l="0-2"/);
            });
    });
});

test("FOCUSED-reference pipe-shaped initial paragraphs retain wrapped literal ownership", async (t) => {
    await withCore(async ({ markdown, esc }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral");
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const prefix of ["", "> ", "> > "])
            await t.test(`${JSON.stringify(prefix)} ${ticks.length} ${JSON.stringify(newline)}`, () => {
                const source = [`| Before ${ticks}literal |`, raw, `code${ticks} after`].map((line) => prefix + line).join(newline);
                const display = markdown(source, true), frame = markdown(source, true, "source");
                assert.match(display, new RegExp(`<code>literal \\| ${esc(raw)} code</code>`));
                assert.doesNotMatch(display, /<table/);
                assert.equal(pills(display), 0);
                assert.equal(markers(frame), 0);
                assert.equal((frame.match(/<code(?:\s[^>]*)?>/g) ?? []).length, 1);
                assert.equal(sessions(source).length, 0);
                assert.equal(referenceText(source), source);
                roundTrip(source);
                assert.deepEqual(searchHit(source), ["synthetic-reference"]);
                assert.match(display, /data-l="0-2"/);
                assert.match(frame, /data-l="0-2"/);
            });
    });
});

test("FOCUSED-reference pipe boundaries and actual table headers/body remain separate contexts", async () => {
    await withCore(({ markdown }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral");
        for (const newline of ["\n", "\r\n"]) for (const lines of [
            ["Before `literal", "| Boundary |", raw, "code` after"],
            ["| Before `literal |", "| --- |", `| ${raw} |`, "code` after"],
            ["| Name |", "| --- |", "| Before `literal |", raw, "code` after"],
            ["| Before `literal |", ":---", `| ${raw} |`, "code` after"],
        ]) {
            const source = lines.join(newline), display = markdown(source, true), frame = markdown(source, true, "source");
            assert.equal(sessions(source).length, 1, source);
            assert.equal(pills(display), 1, source);
            assert.equal(markers(frame), 1, source);
            assert.deepEqual(searchHit(source), [], source);
            assert.equal(referenceText(source).includes("needleliteral"), false);
            roundTrip(source);
            if (lines[1] !== "| Boundary |") assert.match(display, /<table/);
        }
    });
});

test("CELL-reference actual header/body cells own their literal delimiters", async (t) => {
    await withCore(async ({ markdown }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral");
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const place of ["header", "body"])
            for (const prefix of ["", "> ", "> > "]) for (const literal of [false, true])
                await t.test(`${place} ${literal ? "same-cell" : "cross-cell"} ${ticks.length} ${JSON.stringify(prefix)} ${JSON.stringify(newline)}`, () => {
                    const row = literal ? `| Before ${ticks}${raw}${ticks} after | Other | Last |` : `| Before ${ticks} | ${raw} | ${ticks} after |`;
                    const source = (place === "header" ? [row, "| --- | --- | --- |", "| One | Two | Three |"] : ["| A | B | C |", "| --- | --- | --- |", row])
                        .map((line) => prefix + line).join(newline);
                    const display = markdown(source, true), frame = markdown(source, true, "source");
                    assert.equal((display.match(/<th>/g) ?? []).length, 3);
                    assert.equal((display.match(/<td>/g) ?? []).length, 3);
                    assert.equal((display.match(/<code(?:\s[^>]*)?>/g) ?? []).length, Number(literal));
                    assert.equal((frame.match(/<code(?:\s[^>]*)?>/g) ?? []).length, Number(literal));
                    assert.equal(pills(display), literal ? 0 : 1);
                    assert.equal(markers(frame), literal ? 0 : 1);
                    assert.equal(sessions(source).length, literal ? 0 : 1);
                    assert.equal(referenceText(source), literal ? source : source.replace(raw, "Build helper"));
                    assert.deepEqual(searchHit(source), literal ? ["synthetic-reference"] : []);
                    assert.deepEqual(searchHit(source, "Build helper"), ["synthetic-reference"]);
                    assert.match(display, /data-l="0-2"/);
                    roundTrip(source);
                });
    });
});

test("CELL-reference admitted prose atoms remain prose through table framing", async () => {
    await withCore(({ markdown }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral").replace("Build helper", "Build | Test");
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const place of ["header", "body"]) {
            const row = `| Before ${ticks}${raw}${ticks} after | Other | Last |`;
            const source = (place === "header" ? [row, "| --- | --- | --- |", "| One | Two | Three |"] : ["| A | B | C |", "| --- | --- | --- |", row]).join(newline);
            const display = markdown(source, true), frame = markdown(source, true, "source");
            assert.equal(sessions(source).length, 1, source);
            assert.equal(pills(display), 1, source);
            assert.equal(markers(frame), 1, source);
            assert.equal((display.match(/<code(?:\s[^>]*)?>/g) ?? []).length, 0, source);
            assert.equal((display.match(/<th>/g) ?? []).length, 3, source);
            assert.equal((display.match(/<td>/g) ?? []).length, 3, source);
            assert.deepEqual(searchHit(source), [], source);
            assert.equal(referenceText(source), source.replace(raw, "Build | Test"));
            roundTrip(source);
        }
    });
});

test("CONTEXT-reference inline code after prose atoms keeps its enclosing lexical context", async () => {
    await withCore(({ markdown, esc }) => {
        const literal = R.replace("synthetic-session-1", "needleliteral");
        for (const ticks of ["```", "````"]) for (const source of [
            `Before ${R}${ticks}${literal}${ticks} after`,
            `- Before ${R}${ticks}${literal}${ticks} after`,
            `> Before ${R}${ticks}${literal}${ticks} after`,
            `| Name |\n| --- |\n| Before ${R}${ticks}${literal}${ticks} after |`,
        ]) {
            for (const mode of ["pill", "source"]) {
                const html = markdown(source, true, mode);
                assert.equal((html.match(/<code(?:\s[^>]*)?>/g) ?? []).length, 1, source);
                assert.match(html, new RegExp(esc(literal)));
                assert.equal(mode === "pill" ? pills(html) : markers(html), 1, source);
            }
            assert.equal(sessions(source).length, 1, source);
            assert.deepEqual(searchHit(source), ["synthetic-reference"]);
            roundTrip(source);
        }
    });
});

test("CONTEXT-reference table-local fence shapes cannot absorb admitted atoms or later code", async () => {
    await withCore(({ markdown }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral").replace("Build helper", "Build | Test");
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["```", "````"]) for (const place of ["header", "body"]) {
            const row = `| ${ticks}${raw}${ticks} after \`literal\` | Other | Last |`;
            const source = (place === "header" ? [row, "| --- | --- | --- |", "| One | Two | Three |"] : ["| A | B | C |", "| --- | --- | --- |", row]).join(newline);
            for (const mode of ["pill", "source"]) {
                const html = markdown(source, true, mode);
                assert.equal((html.match(/<code(?:\s[^>]*)?>/g) ?? []).length, 1, source);
                assert.equal(mode === "pill" ? pills(html) : markers(html), 1, source);
                assert.equal((html.match(/<th>/g) ?? []).length, 3, source);
                assert.equal((html.match(/<td>/g) ?? []).length, 3, source);
            }
            assert.equal(sessions(source).length, 1, source);
            assert.deepEqual(searchHit(source), [], source);
            roundTrip(source);
        }
    });
});

test("CONTEXT-reference inline-only captions and summaries do not acquire table cell boundaries", async () => {
    await withCore(({ inline }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral");
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) {
            const caption = [`| Before ${ticks} | ${raw} | ${ticks} after |`, "| --- | --- | --- |"].join(newline);
            assert.equal(pills(inline(caption)), 0, caption);
            assert.equal((inline(caption).match(/<code>/g) ?? []).length, 1, caption);
            for (const block of [
                { type: "code", text: "", caption }, { type: "code_peek", caption }, { type: "image", caption },
                { type: "database_lens", useCases: [{ summary: caption }] },
            ]) {
                const doc = { id: "synthetic-caption", title: "Other", content: [block] }, archive = parseArchiveState(doc);
                const parsed = parseCatalogQuery({ query: "needleliteral" });
                assert.equal(archive.ok, true); assert.equal(parsed.ok, true);
                assert.deepEqual(queryPages([{ doc, archive: archive.value }], parsed.value).map(page => page.id), ["synthetic-caption"]);
            }
        }
    });
});

test("PLAIN-reference apparent table cells cannot split user-message literals", async (t) => {
    await withCore(async ({ referencePlain, esc }) => {
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const place of ["header", "body"]) {
            const row = `| Before ${ticks} | ${R} | ${ticks} after |`;
            const source = (place === "header" ? [row, "| --- | --- | --- |", "| One | Two | Three |"] : ["| A | B | C |", "| --- | --- | --- |", row]).join(newline);
            await t.test(`${place} ${ticks.length} ticks ${newline.length === 1 ? "LF" : "CRLF"}`, () => {
                assert.equal(referencePlain(source), esc(source));
                const parts = scanReferences(source, "plain");
                assert.equal(parts.filter(part => part.type === "session").length, 0);
                for (const part of parts) assert.equal(source.slice(part.start, part.end), part.text);
                assert.equal(parts.map(part => part.text).join(""), source);
            });
        }
    });
});

test("PLAIN-reference retains prose pills, literal formatting and fence ownership", async () => {
    await withCore(({ referencePlain, markdown, esc }) => {
        for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const place of ["header", "body"]) {
            const row = `| Before ${ticks} | ${R} | ${ticks} after |`;
            const rows = place === "header" ? [row, "| --- | --- | --- |", "| One | Two | Three |"] : ["| A | B | C |", "| --- | --- | --- |", row];
            assert.equal(pills(markdown(rows.join(newline))), 1);
            const noSeparator = rows.filter(line => line !== "| --- | --- | --- |").join(newline);
            assert.equal(referencePlain(noSeparator), esc(noSeparator));
            const sameCell = rows.map(line => line === row ? `| Before ${ticks}${R}${ticks} after | Other | Last |` : line).join(newline);
            assert.equal(referencePlain(sameCell), esc(sameCell));
            assert.equal(pills(markdown(sameCell)), 0);
        }
        assert.equal(pills(referencePlain(`First\n${R}\n**not Markdown**`)), 1);
        for (const newline of ["\n", "\r\n"]) for (const prefix of ["", "> ", "> > "]) {
            const closed = ["````text", "```", R, "```", "````"].map(line => prefix + line).join(newline);
            const unclosed = ["````text", R, "```", R].map(line => prefix + line).join(newline);
            assert.equal(referencePlain(closed), esc(closed));
            assert.equal(referencePlain(unclosed), esc(unclosed));
            assert.equal(pills(referencePlain(`Before \`outside${newline}${closed}${newline}after\` ${R}`)), 1);
            if (prefix) {
                const quoteEnded = `${prefix}\`\`\`text${newline}${prefix}${R}${newline}After ${R}`;
                assert.equal(pills(referencePlain(quoteEnded)), 1);
                assert.ok(referencePlain(quoteEnded).startsWith(esc(`${prefix}\`\`\`text${newline}${prefix}${R}${newline}`)));
            }
        }
        const formatting = `# Heading\n**bold**\n\n> quoted\n- item\nBefore \`literal\n\n# Heading ${R}\n- list\ncode\` after`;
        assert.equal(referencePlain(formatting), esc(formatting));
    });
});

test("PERF-002: frame barrier lookup is bounded by atoms rather than inline code runs", async () => {
    const { frameReferences } = await import("../extensions/marginal/web/references.js");
    for (const runs of [120, 1200]) for (const atom of ["", R]) {
        const source = `Before ${"`x` ".repeat(runs)}${atom} after`, frame = frameReferences(source);
        const original = String.prototype.indexOf;
        let calls = 0, searchedCharacters = 0, parts;
        try {
            String.prototype.indexOf = function (needle, start = 0) {
                if (needle === "\u0003") {
                    calls++;
                    searchedCharacters += this.length - start;
                }
                return original.call(this, needle, start);
            };
            parts = frame.inlineParts(frame.lines.join("\n"));
        } finally {
            String.prototype.indexOf = original;
        }
        assert.equal(parts.filter(part => part.type === "literal").length, runs);
        assert.equal(parts.filter(part => part.type === "session").length, atom ? 1 : 0);
        assert.equal(parts.map(part => part.type === "session" ? part.source : part.text).join(""), source);
        assert.ok(calls <= (atom ? 3 : 1), `${runs} runs: ${calls} marker searches`);
        assert.ok(searchedCharacters <= source.length * (atom ? 3 : 1), `${runs} runs: ${searchedCharacters} searched characters`);
        await withCore(({ markdown }) => {
            for (const mode of ["pill", "source"]) {
                const html = markdown(source, false, mode);
                assert.equal((html.match(/<code(?:\s[^>]*)?>/g) ?? []).length, runs);
                assert.equal(mode === "pill" ? pills(html) : markers(html), atom ? 1 : 0);
            }
        });
    }
});

test("FINAL-reference literal ownership stops at unmatched runs and real Markdown boundaries", async () => {
    await withCore(({ markdown }) => {
        const raw = R.replace("synthetic-session-1", "needleliteral");
        const prose = `Before ${raw} after`;
        for (const source of [
            prose, `Before \`unmatched ${raw}`, `Before \`\`unmatched\n${raw}\ncode\` after`,
            `Before \`literal\n\n${raw}\ncode\` after`, `Before \`literal\n# Heading ${raw}\ncode\` after`,
            `Before \`literal\n---\n${raw}\ncode\` after`, `Before \`literal\n- Item ${raw}\ncode\` after`,
            `- Before \`literal\n${raw}\ncode\` after`, `> Before \`literal\n${raw}\n> code\` after`,
            `Before \`literal\n\`\`\`text\nfenced\n\`\`\`\n${raw}\ncode\` after`,
        ]) {
            assert.equal(sessions(source).length, 1, source);
            assert.equal(pills(markdown(source)), 1, source);
            assert.equal(markers(markdown(source, false, "source")), 1, source);
            assert.deepEqual(searchHit(source), [], source);
            roundTrip(source);
        }
        for (const source of [
            `Before \`\`${raw}\`\` after`,
            ["````text", "```", raw, "```", "````"].join("\n"),
            ["> ```text", `> ${raw}`, "> ```"].join("\r\n"),
        ]) {
            assert.equal(pills(markdown(source)), 0);
            assert.equal(markers(markdown(source, false, "source")), 0);
            assert.deepEqual(searchHit(source), ["synthetic-reference"]);
        }
        const linked = `[${raw}](https://example.invalid/)`;
        assert.equal(pills(markdown(linked)), 0);
        assert.equal(markers(markdown(linked, false, "source")), 0);
        assert.match(markdown(linked), /<a[^>]*>&lt;copilot-ref/);
        assert.deepEqual(searchHit(prose), []);
        assert.deepEqual(searchHit(prose, "Build helper"), ["synthetic-reference"]);
        assert.equal(markdown("First **bold** line\nsecond *line*"), "<p>First <strong>bold</strong> line second <em>line</em></p>");
    });

});

test("FINAL-reference container and source-position controls retain scanner evidence", async () => {
    await withCore(({ markdown, esc }) => {
        const raw = R.replace("Build helper", "Build\n\n# helper | Test");
        const source = `- Parent ${raw}\n  - Child ${raw}\n- Following item\n\nFollowing prose`;
        for (const mode of ["pill", "source"]) {
            const html = markdown(source, true, mode);
            assert.match(html, /<li data-l="0-5">/);
            assert.match(html, /<li data-l="3-5">/);
            assert.match(html, /<li data-l="6-6">Following item/);
            assert.match(html, /<p data-l="8-8">Following prose/);
            assert.equal(mode === "pill" ? pills(html) : markers(html), 2);
            const linked = markdown(`Before [${raw}](https://example.invalid/) after`, false, mode);
            assert.equal(pills(linked), 0);
            assert.equal(markers(linked), 0);
            assert.ok(linked.includes(esc(raw)));
            assert.match(linked, /<a href="https:\/\/example.invalid\/"/);
        }
        for (const newline of ["\n", "\r\n"]) for (const prefix of ["", "> ", "> > "]) {
            const literal = R.replace("synthetic-session-1", "needleliteral");
            const source = ["- Leading item", "  Before ``literal", `  | ${literal} |`, "  code`` after"]
                .map((line) => prefix + line).join(newline);
            assert.equal(sessions(source).length, 0);
            assert.equal(referenceText(source), source);
            assert.equal(pills(markdown(source)), 0);
            assert.equal(markers(markdown(source, true, "source")), 0);
            assert.deepEqual(searchHit(source), ["synthetic-reference"]);
        }
    });
});
