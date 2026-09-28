// Backend smoke test for extensions/marginal/lib/ (git, store, blocks, instructions) against a throwaway repo and data dir.
// Usage: node test/smoke.mjs [path-to-extension-dir]   (defaults to this checkout; touches nothing real)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extDir = process.argv[2] ?? fileURLToPath(new URL("../extensions/marginal", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "wb-smoke-"));
process.env.MARGINAL_DATA_DIR = join(tmp, "data");

// ---- fixture repo: base commit + head commit on a branch ----
const repo = join(tmp, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.com");
g("config", "user.name", "Test");
writeFileSync(join(repo, "src", "api.ts"), ["export function checkout(cart) {", "  return pay(cart);", "}", "", "function pay(cart) {", "  return cart.total;", "}", ""].join("\n"));
writeFileSync(join(repo, "README.md"), "# demo\n");
g("add", ".");
g("commit", "-q", "-m", "base");
g("checkout", "-q", "-b", "feature");
writeFileSync(join(repo, "src", "api.ts"), ["export async function checkout(cart) {", "  await reserve(cart);", "  return pay(cart);", "}", "", "async function reserve(cart) {", "  return inventory.hold(cart.items);", "}", "", "function pay(cart) {", "  return cart.total;", "}", ""].join("\n"));
writeFileSync(join(repo, "src", "api.test.ts"), "test('checkout', () => {});\n");
g("add", ".");
g("commit", "-q", "-m", "reserve inventory before paying");

const lib = (name) => import(pathToFileURL(join(extDir, "lib", name)).href);
const git = await lib("git.mjs");
const store = await lib("store.mjs");
const { getInstructions } = await lib("instructions.mjs");

let passed = 0;
const results = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        results.push(`  ok   ${name}`);
    } catch (e) {
        results.push(`  FAIL ${name}\n       ${e.stack?.split("\n").slice(0, 3).join("\n       ")}`);
    }
}
const rejects = async (fn, pattern) => assert.rejects(fn, (e) => (pattern.test(e.message) ? true : assert.fail(`wrong error: ${e.message}`)));

let repoId, pins, doc;

await test("register_repository is idempotent", async () => {
    const a = await git.registerRepository(repo);
    const b = await git.registerRepository(join(repo, "src"));
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.repositoryId, b.repositoryId);
    repoId = a.repositoryId;
});

await test("defaultBase and resolvePins (merge-base)", async () => {
    assert.equal(await git.defaultBase(repoId), "main");
    pins = await git.resolvePins(repoId, "main", "feature");
    assert.match(pins.base, /^[0-9a-f]{40}$/);
    assert.equal(pins.head, g("rev-parse", "feature"));
    assert.equal(pins.base, g("rev-parse", "main"));
});

await test("resolveCommit rejects unknown and option-like revs", async () => {
    await rejects(() => git.resolveCommit(repoId, "nope"), /not found/);
    await rejects(() => git.resolveCommit(repoId, "--all"), /Invalid revision/);
});

await test("checkSourcePath blocks traversal / absolute / backslash", async () => {
    for (const bad of ["../x", "/etc/passwd", "C:/x", "src\\a.ts", "a/./b"]) assert.throws(() => git.checkSourcePath(bad));
    git.checkSourcePath("src/api.ts");
});

await test("diffFiles lists status and stats", async () => {
    const files = await git.diffFiles(repoId, pins.base, pins.head);
    const api = files.find((f) => f.path === "src/api.ts");
    assert.equal(api.status, "modified");
    assert.ok(api.additions > 0);
    assert.equal(files.find((f) => f.path === "src/api.test.ts").status, "added");
});

await test("numberPatch carries base/head line numbers", async () => {
    const text = git.numberPatch(await git.diffPatch(repoId, pins.base, pins.head, ["src/api.ts"]));
    assert.match(text, /diff --git a\/src\/api\.ts/);
    assert.match(text, /\s+2 \+   await reserve\(cart\);/);
});

await test("readFileAt reads pinned content per side", async () => {
    const head = await git.readFileAt(repoId, pins.head, "src/api.ts");
    const base = await git.readFileAt(repoId, pins.base, "src/api.ts");
    assert.equal(head.lines.length, 12);
    assert.equal(base.lines.length, 7);
    assert.equal((await git.readFileAt(repoId, pins.base, "src/api.test.ts")).exists, false);
});

await test("listTree and listCommits", async () => {
    const tree = await git.listTree(repoId, pins.head, "");
    assert.deepEqual(tree.map((e) => `${e.type}:${e.name}`), ["dir:src", "file:README.md"]);
    const commits = await git.listCommits(repoId, pins.base, pins.head);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, "reserve inventory before paying");
});

await test("create doc requires SHA pins", async () => {
    await rejects(() => store.create({ title: "x", target: { repositoryId: repoId, base: "main", head: "feature" } }), /full commit SHA/);
    doc = await store.create({ title: "Reserve inventory", target: pins });
    assert.match(doc.documentId, /^reserve-inventory-[0-9a-f]{4}$/);
    assert.equal(doc.version, 0);
});

await test("scratchpad exists and is listed first", async () => {
    const list = store.list();
    assert.equal(list[0].documentId, "scratchpad");
    assert.ok(list.some((d) => d.documentId === doc.documentId));
});

let sectionId, mdId, seqId, flowId;

await test("insert section + markdown with verified review-source link", async () => {
    const sec = await store.applyEdit(doc.documentId, { type: "insert", content: { type: "section", title: "What / why" } });
    sectionId = sec.targetId;
    const md = await store.applyEdit(doc.documentId, { type: "insert", parentId: sectionId, content: { type: "markdown", markdown: "Checkout now [reserves stock](review-source:head/src/api.ts#L2) before paying." } });
    mdId = md.targetId;
    assert.match(mdId, /^md-\d+$/);
    assert.equal(md.version, 2);
});

await test("rejects out-of-range, missing-file, and bad links", async () => {
    const e = (markdown) => store.applyEdit(doc.documentId, { type: "insert", content: { type: "markdown", markdown } });
    await rejects(() => e("[x](review-source:head/src/api.ts#L99)"), /exceeds the pinned file/);
    await rejects(() => e("[x](review-source:base/src/api.test.ts#L1)"), /does not exist/);
    await rejects(() => e("[x](file:///C:/secret)"), /Unsupported link target/);
    await rejects(() => e("[x](javascript:alert(1))"), /Unsupported link target/);
    assert.equal(store.getDoc(doc.documentId).version, 2, "failed edits must not create versions");
});

await test("schema errors are specific", async () => {
    await rejects(() => store.applyEdit(doc.documentId, { type: "insert", content: { type: "bogus" } }), /unknown block type/);
    await rejects(() => store.applyEdit(doc.documentId, { type: "insert", content: { type: "markdown", markdown: "x", extra: 1 } }), /unknown field "extra"/);
    await rejects(() => store.applyEdit(doc.documentId, { type: "insert", content: { type: "sequence", title: "t", actors: { a: "A" }, steps: [{ from: "a", to: "zz", label: "x" }] } }), /Unknown sequence actor: zz/);
});

await test("sequence insert, then add a step unit", async () => {
    const r = await store.applyEdit(doc.documentId, {
        type: "insert",
        content: {
            type: "sequence",
            title: "Checkout",
            actors: { ui: "Browser", api: "API", inv: "Inventory" },
            steps: [{ from: "ui", to: "api", label: "checkout(cart)", source: { file: "src/api.ts", startLine: 1, endLine: 4 } }],
        },
    });
    seqId = r.targetId;
    assert.equal(r.children.length, 1);
    assert.equal(r.children[0].type, "step");
    const s = await store.applyEdit(doc.documentId, { type: "insert", parentId: seqId, content: { type: "step", from: "api", to: "inv", label: "hold(items)", style: "async", explanation: "Reserve first." } });
    assert.match(s.targetId, /^step-\d+$/);
    await rejects(() => store.applyEdit(doc.documentId, { type: "insert", parentId: sectionId, content: { type: "step", from: "api", to: "inv", label: "x" } }), /needs parentId naming its sequence/);
});

await test("flow diagram: node with link creates edge; removing node drops edges", async () => {
    const r = await store.applyEdit(doc.documentId, { type: "insert", content: { type: "flow_diagram", title: "Checkout flow", nodes: [{ key: "start", label: "Start", kind: "terminal" }], edges: [] } });
    flowId = r.targetId;
    const n = await store.applyEdit(doc.documentId, { type: "insert", parentId: flowId, content: { type: "flow_node", key: "reserve", label: "Reserve stock", link: { from: "start", label: "go" } } });
    assert.ok(n.linkId);
    let flow = store.getDoc(doc.documentId).content.find((b) => b.id === flowId);
    assert.equal(flow.edges.length, 1);
    assert.equal(store.getDoc(doc.documentId).lastEdit.linkId, n.linkId);
    await rejects(() => store.applyEdit(doc.documentId, { type: "insert", parentId: flowId, content: { type: "flow_node", key: "reserve", label: "dup" } }), /unique/);
    await store.applyEdit(doc.documentId, { type: "remove", targetId: n.targetId });
    flow = store.getDoc(doc.documentId).content.find((b) => b.id === flowId);
    assert.equal(flow.edges.length, 0);
});

await test("update patches fields, renaming a node key rewrites edges", async () => {
    await store.applyEdit(doc.documentId, { type: "insert", parentId: flowId, content: { type: "flow_node", key: "pay", label: "Pay", link: { from: "start" } } });
    const flow0 = store.getDoc(doc.documentId).content.find((b) => b.id === flowId);
    const payId = flow0.nodes.find((x) => x.key === "pay").id;
    await store.applyEdit(doc.documentId, { type: "update", targetId: payId, changes: { key: "charge", description: "Charge card" } });
    const flow = store.getDoc(doc.documentId).content.find((b) => b.id === flowId);
    assert.equal(flow.edges[0].to, "charge");
    await store.applyEdit(doc.documentId, { type: "update", targetId: payId, changes: { description: null } });
    assert.equal(store.getDoc(doc.documentId).content.find((b) => b.id === flowId).nodes[1].description, undefined);
    await rejects(() => store.applyEdit(doc.documentId, { type: "update", targetId: flowId, changes: { nodes: [] } }), /cannot change nodes/);
});

await test("call_stack_diff: base column defaults to base side; parentKey order enforced", async () => {
    const r = await store.applyEdit(doc.documentId, {
        type: "insert",
        content: {
            type: "call_stack_diff",
            title: "checkout path",
            base: [{ key: "co", source: { file: "src/api.ts", startLine: 1, endLine: 3 } }, { key: "pay", parentKey: "co", source: { file: "src/api.ts", startLine: 5, endLine: 7 } }],
            head: [{ key: "co", source: { file: "src/api.ts", startLine: 1, endLine: 4 } }, { key: "reserve", parentKey: "co", source: { file: "src/api.ts", startLine: 6, endLine: 8 } }],
        },
    });
    const b = store.getDoc(doc.documentId).content.find((x) => x.id === r.targetId);
    assert.equal(b.base[0].source.side, "base");
    assert.equal(b.head[0].source.side, undefined);
    await rejects(() => store.applyEdit(doc.documentId, { type: "insert", content: { type: "call_stack_diff", title: "t", base: [], head: [{ parentKey: "later", source: { file: "src/api.ts", startLine: 1 } }] } }), /earlier frame/);
});

await test("step notes: steps and frames take verified notes; frames update in place only", async () => {
    const seq = store.getDoc(doc.documentId).content.find((b) => b.id === seqId);
    const stepId = seq.steps[0].id;
    await store.applyEdit(doc.documentId, { type: "update", targetId: stepId, changes: { notes: [{ title: "Example", text: "A cart looks like this.", source: { file: "src/api.ts", startLine: 1, endLine: 2 } }, { code: { language: "ts", text: "checkout({ total: 3 })" } }] } });
    assert.equal(store.getDoc(doc.documentId).content.find((b) => b.id === seqId).steps[0].notes.length, 2);
    await rejects(() => store.applyEdit(doc.documentId, { type: "update", targetId: stepId, changes: { notes: [{ title: "empty" }] } }), /needs text, source or code/);
    await rejects(() => store.applyEdit(doc.documentId, { type: "update", targetId: stepId, changes: { notes: [{ source: { file: "src/api.ts", startLine: 1 }, code: { text: "x" } }] } }), /source or code, not both/);
    await rejects(() => store.applyEdit(doc.documentId, { type: "update", targetId: stepId, changes: { notes: [{ source: { file: "src/api.ts", startLine: 900 } }] } }), /line|range|lines/i);
    const stack = store.getDoc(doc.documentId).content.find((b) => b.type === "call_stack_diff");
    const frameId = stack.head[1].id;
    assert.ok(frameId, "frames have ids");
    await store.applyEdit(doc.documentId, { type: "update", targetId: frameId, changes: { notes: [{ text: "Reserving first means a failed payment releases the hold." }] } });
    const f = store.getDoc(doc.documentId).content.find((b) => b.id === stack.id).head[1];
    assert.equal(f.notes[0].text, "Reserving first means a failed payment releases the hold.");
    assert.equal(f.key, "reserve");
    await rejects(() => store.applyEdit(doc.documentId, { type: "update", targetId: frameId, changes: { notes: [{ source: { file: "src/nope.ts", startLine: 1 } }] } }), /nope|not exist|does not/i);
    await rejects(() => store.applyEdit(doc.documentId, { type: "remove", targetId: frameId }), /frames can only be updated/i);
});

await test("prose edits: exact lines, one version by the user, refused when the text moved on", async () => {
    const d = doc.documentId;
    const ins = await store.applyEdit(d, { type: "insert", content: { type: "markdown", markdown: "First para\nstill first.\n\n- one\n- two\n  - nested\n\n## Head" } });
    const id = ins.targetId;
    const v0 = store.getDoc(d).version;
    const r = await store.editProse(d, [
        { blockId: id, from: 0, to: 1, before: "First para\nstill first.", after: "First **bold** para.\n\nA new paragraph." },
        { blockId: id, from: 4, to: 5, before: "- two\n  - nested", after: "- deux [code](review-source:head/src/api.ts#L1-L2)\n  - nested" },
    ]);
    const after = store.getDoc(d);
    const md = after.content.find((b) => b.id === id).markdown;
    assert.equal(md, "First **bold** para.\n\nA new paragraph.\n\n- one\n- deux [code](review-source:head/src/api.ts#L1-L2)\n  - nested\n\n## Head");
    assert.equal(after.version, v0 + 1);
    assert.equal(after.lastEdit.by, "user");
    assert.deepEqual(r.blocks, [id]);
    // Deleting a unit removes its lines (blank runs collapse).
    await store.editProse(d, [{ blockId: id, from: 2, to: 2, before: "A new paragraph.", after: "" }]);
    assert.equal(store.getDoc(d).content.find((b) => b.id === id).markdown, "First **bold** para.\n\n- one\n- deux [code](review-source:head/src/api.ts#L1-L2)\n  - nested\n\n## Head");
    // Stale text, bad links, missing files, non-prose blocks and empty blocks are refused and change nothing.
    const v1 = store.getDoc(d).version;
    await rejects(() => store.editProse(d, [{ blockId: id, from: 0, to: 0, before: "First para", after: "x" }]), /changed this text/);
    await rejects(() => store.editProse(d, [{ blockId: id, from: 0, to: 0, before: "First **bold** para.", after: "[x](ftp://nope)" }]), /Unsupported link/);
    await rejects(() => store.editProse(d, [{ blockId: id, from: 0, to: 0, before: "First **bold** para.", after: "[x](review-source:head/src/nope.ts#L1)" }]), /nope|not exist|does not/i);
    await rejects(() => store.editProse(d, [{ blockId: seqId, from: 0, to: 0, before: "", after: "x" }]), /not a Markdown block/);
    const all = store.getDoc(d).content.find((b) => b.id === id).markdown.split("\n");
    await rejects(() => store.editProse(d, [{ blockId: id, from: 0, to: all.length - 1, before: all.join("\n"), after: "" }]), /can't be left empty/);
    assert.equal(store.getDoc(d).version, v1);
    await store.applyEdit(d, { type: "remove", targetId: id });
});

await test("patch edits, baseVersion guards, changes since a version, and friendlier schema errors", async () => {
    const d = doc.documentId;
    const ins = await store.applyEdit(d, { type: "insert", content: { type: "markdown", markdown: "# Plan\n\n- step one\n- step two\n- step three\n\nDone when tests pass." } });
    const id = ins.targetId;
    const other = (await store.applyEdit(d, { type: "insert", content: { type: "markdown", markdown: "Another block." } })).targetId;
    const md = () => store.getDoc(d).content.find((b) => b.id === id).markdown;
    const v0 = store.getDoc(d).version;
    // find/replace, exactly once
    await store.applyEdit(d, { type: "patch", targetId: id, ops: [{ find: "step two", replace: "step 2" }] });
    assert.equal(md(), "# Plan\n\n- step one\n- step 2\n- step three\n\nDone when tests pass.");
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: id, ops: [{ find: "step", replace: "x" }] }), /occurs 3 times/);
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: id, ops: [{ find: "nowhere", replace: "x" }] }), /isn't in/);
    // line ranges (numbered from the current text), with expect; line ops before finds; inserts with to = from - 1
    await store.applyEdit(d, { type: "patch", targetId: id, ops: [{ lines: [5, 5], text: "- step three\n- step four", expect: "- step three" }, { lines: [3, 2], text: "- step zero" }, { find: "tests pass", replace: "CI is green" }] });
    assert.equal(md(), "# Plan\n\n- step zero\n- step one\n- step 2\n- step three\n- step four\n\nDone when CI is green.");
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: id, ops: [{ lines: [1, 1], text: "x", expect: "# Nope" }] }), /expect must match lines 1–1/);
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: id, field: "title", ops: [{ find: "a", replace: "b" }] }), /no text field "title"/);
    // baseVersion: refused only when the target itself changed since
    const vRead = store.getDoc(d).version;
    await store.editProse(d, [{ blockId: id, from: 0, to: 0, before: "# Plan", after: "# The plan" }]); // the user edits in place
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: id, baseVersion: vRead, ops: [{ find: "step one", replace: "step 1" }] }), /changed \(markdown\) since version \d+: first in v\d+, by the user/);
    await store.applyEdit(d, { type: "update", targetId: other, baseVersion: vRead, changes: { markdown: "Another block, edited." } });
    // the user's save follows its text when Copilot's patch shifted the lines
    await store.applyEdit(d, { type: "patch", targetId: id, ops: [{ lines: [2, 1], text: "Intro line." }] });
    await store.editProse(d, [{ blockId: id, from: 8, to: 8, before: "Done when CI is green.", after: "Done when CI is green and docs updated." }]);
    assert.match(md(), /^# The plan\nIntro line\.\n/);
    assert.match(md(), /docs updated\.$/);
    // changes since a version: who, what, and a line diff
    const ch = store.changesSince(d, v0);
    assert.ok(ch.versions.some((v) => v.by === "user") && ch.versions.some((v) => v.by === "copilot"));
    const c1 = ch.changed.find((x) => x.id === id);
    assert.equal(c1.change, "modified");
    assert.match(c1.diff, /^@@ line 1\n- # Plan\n\+ # The plan/m);
    assert.match(c1.diff, /\+ - step zero/);
    assert.ok(ch.changed.some((x) => x.id === other && x.change === "modified"));
    // dry runs understand patch too (Discuss mode holds them)
    assert.equal(await store.checkEdits(d, [{ type: "patch", targetId: id, ops: [{ find: "Intro line.", replace: "Intro." }] }]), 1);
    await rejects(() => store.checkEdits(d, [{ type: "patch", targetId: id, baseVersion: vRead, ops: [{ find: "Intro line.", replace: "Intro." }] }]), /changed.* since version/);
    // schema: a Markdown-only child may leave out its type; restating the type in update is fine
    const sec = await store.applyEdit(d, { type: "insert", content: { type: "section", title: "S", children: [{ markdown: "child" }] } });
    assert.equal(store.getDoc(d).content.find((b) => b.id === sec.targetId).children[0].type, "markdown");
    await rejects(() => store.applyEdit(d, { type: "insert", content: { type: "section", title: "S", children: [{ text: "x" }] } }), /missing type/);
    await store.applyEdit(d, { type: "update", targetId: other, changes: { type: "markdown", markdown: "Same type restated." } });
    // insert and replace at the same line, in either order; overlapping ops refused
    for (const order of [0, 1]) {
        const t = (await store.applyEdit(d, { type: "insert", content: { type: "markdown", markdown: "a\nb" } })).targetId;
        const ops = [{ lines: [2, 1], text: "x" }, { lines: [2, 2], text: "B" }];
        await store.applyEdit(d, { type: "patch", targetId: t, ops: order ? ops.reverse() : ops });
        assert.equal(store.getDoc(d).content.find((b) => b.id === t).markdown, "a\nx\nB");
        await rejects(() => store.applyEdit(d, { type: "patch", targetId: t, ops: [{ lines: [1, 2], text: "q" }, { lines: [2, 1], text: "z" }] }), /overlap/);
        await store.applyEdit(d, { type: "remove", targetId: t });
    }
    // a move since baseVersion conflicts with another move, not with a text edit; changes reports reorders within a parent
    const vMove = store.getDoc(d).version;
    const order = store.getDoc(d).content.map((b) => b.id);
    const others = [id, sec.targetId].sort((x, y) => order.indexOf(x) - order.indexOf(y));
    await store.applyEdit(d, order.indexOf(other) < order.indexOf(others[0]) ? { type: "move", targetId: other, afterId: others[1] } : { type: "move", targetId: other, beforeId: others[0] });
    await rejects(() => store.applyEdit(d, { type: "move", targetId: other, afterId: id, baseVersion: vMove }), /moved or its contents changed since version/);
    assert.equal(store.changesSince(d, vMove).changed.find((x) => x.id === other)?.change, "moved");
    await store.applyEdit(d, { type: "update", targetId: other, baseVersion: vMove, changes: { markdown: "moved, then edited" } });
    for (const x of [id, other, sec.targetId]) await store.applyEdit(d, { type: "remove", targetId: x });
    // a brand-new doc is at version 0, and that's a valid baseline
    const fresh = await store.create({ title: "Fresh" });
    const f0 = (await store.applyEdit(fresh.documentId, { type: "insert", baseVersion: 0, content: { type: "markdown", markdown: "hi" } })).targetId;
    assert.ok(store.changesSince(fresh.documentId, 0).changed.some((x) => x.id === f0 && x.change === "added"));
    await store.remove(fresh.documentId);
});

await test("addressing: heading paths (read, under) and message regions (read, rewrite, refused when changed)", async () => {
    const d = doc.documentId;
    const sec = (await store.applyEdit(d, { type: "insert", content: { type: "section", title: "Plan", children: [{ type: "markdown", markdown: "# Goals\n\nShip it.\n\n## Review findings\n\n- one\n- two\n\n### Detail\n\nsmall\n\n## Risks\n\n```\n# not a heading\n```\nnone" }] } })).targetId;
    const md = store.getDoc(d).content.find((b) => b.id === sec).children[0].id;
    const text = () => store.getDoc(d).content.find((b) => b.id === sec).children.find((b) => b.id === md).markdown;
    // the outline names headings; paths resolve through sections and heading ranks; code fences don't count
    assert.match(store.outline(store.getDoc(d)), /## Review findings {2}\(lines 5–13\)/);
    const r1 = store.readHeading(d, "Plan > Review findings");
    assert.equal(r1.heading, "Plan > Goals > Review findings");
    assert.equal(r1.markdown, "- one\n- two\n\n### Detail\n\nsmall");
    assert.equal(store.readHeading(d, "Detail").heading, "Plan > Goals > Review findings > Detail");
    assert.throws(() => store.resolveHeading(store.getDoc(d), "not a heading"), /no heading/);
    assert.throws(() => store.resolveHeading(store.getDoc(d), "Review"), /Close: "Plan > Goals > Review findings"/);
    assert.equal(store.readHeading(d, "Plan").children[0].id, md);
    // under: replace keeps the heading and what follows; append adds to the end; baseVersion guards only that text
    const v1 = store.getDoc(d).version;
    await store.applyEdit(d, { type: "under", heading: "Plan > Review findings", markdown: "- A\n- B" });
    assert.equal(text(), "# Goals\n\nShip it.\n\n## Review findings\n\n- A\n- B\n\n## Risks\n\n```\n# not a heading\n```\nnone");
    await store.applyEdit(d, { type: "under", heading: "Risks", markdown: "- none known", append: true, baseVersion: v1 }); // Risks untouched since v1
    assert.match(text(), /none\n\n- none known$/);
    await rejects(() => store.applyEdit(d, { type: "under", heading: "Review findings", baseVersion: v1, markdown: "x" }), /changed since version/);
    // a section of only text can be replaced whole; a section with a diagram can only be appended to
    const plain = (await store.applyEdit(d, { type: "insert", content: { type: "section", title: "Notes", children: [{ markdown: "old" }] } })).targetId;
    await store.applyEdit(d, { type: "under", heading: "Notes", markdown: "new notes" });
    const notes = store.getDoc(d).content.find((b) => b.id === plain);
    assert.equal(notes.title, "Notes");
    assert.deepEqual(notes.children.map((c) => c.markdown), ["new notes"]);
    // regions: what a message pointed at, rewritten in place even after lines above moved
    const reg = store.registerRegions(d, [{ blockId: md, unit: "6-7" }, { blockId: plain }, { blockId: "nope" }]);
    assert.equal(reg.refs.length, 2);
    assert.equal(reg.refs[0].lines, "7–8");
    const ref = reg.refs[0].ref;
    assert.equal(store.readRegion(d, ref).markdown, "- A\n- B");
    await store.applyEdit(d, { type: "patch", targetId: md, ops: [{ find: "Ship it.", replace: "Ship it.\n\nSoon." }] });
    assert.equal(store.readRegion(d, ref).status, "moved");
    await store.applyEdit(d, { type: "region", ref, markdown: "- A (fixed)\n- B\n- C" });
    assert.match(text(), /## Review findings\n\n- A \(fixed\)\n- B\n- C\n\n## Risks/);
    await store.applyEdit(d, { type: "region", ref, markdown: "- A (fixed twice)\n- B\n- C" }); // the ref follows its new text
    assert.match(text(), /A \(fixed twice\)/);
    await rejects(() => store.applyEdit(d, { type: "region", ref: reg.refs[1].ref, markdown: "x" }), /not text/);
    // changed by the user since the message: refused, nothing saved
    const all = text().split("\n");
    const at = all.indexOf("- A (fixed twice)");
    await store.editProse(d, [{ blockId: md, from: at, to: at, before: "- A (fixed twice)", after: "- A (the user's words)" }]);
    const v2 = store.getDoc(d).version;
    await rejects(() => store.applyEdit(d, { type: "region", ref, markdown: "x" }), /was changed since the message/);
    assert.equal(store.getDoc(d).version, v2);
    assert.equal(store.readRegion(d, ref).status, "changed");
    // Discuss mode's dry runs understand the new edits; a batch never conflicts with itself, and checks exactly what applying does
    assert.equal(await store.checkEdits(d, [{ type: "under", heading: "Risks", markdown: "- maybe one" }]), 1);
    const vb = store.getDoc(d).version;
    const pair = [{ type: "under", heading: "Risks", baseVersion: vb, markdown: "- x" }, { type: "under", heading: "Risks", baseVersion: vb, markdown: "- y" }];
    assert.equal(await store.checkEdits(d, pair), 2);
    await store.applyEdits(d, pair);
    assert.equal(store.readHeading(d, "Risks").markdown, "- y");
    // edits leave everything outside their span exactly as it was (a fenced block's double blank line survives)
    const fence = (await store.applyEdit(d, { type: "insert", content: { type: "markdown", markdown: "# A\n\nold a\n\n# B\n\n```\nx\n\n\ny\n```\n\n\ntail" } })).targetId;
    const fmd = () => store.getDoc(d).content.find((b) => b.id === fence).markdown;
    await store.applyEdit(d, { type: "under", heading: "A", markdown: "new a" });
    assert.equal(fmd(), "# A\n\nnew a\n\n# B\n\n```\nx\n\n\ny\n```\n\n\ntail");
    const fr = store.registerRegions(d, [{ blockId: fence, unit: "2-2" }]).refs[0].ref;
    await store.applyEdit(d, { type: "region", ref: fr, markdown: "" });
    assert.equal(fmd(), "# A\n\n# B\n\n```\nx\n\n\ny\n```\n\n\ntail");
    await store.applyEdit(d, { type: "remove", targetId: fence });
    for (const x of [sec, plain]) await store.applyEdit(d, { type: "remove", targetId: x });
});

await test("heading paths: titles with > or › in them, exact arrays, escapes, and formatting kept apart from words", async () => {
    const d = doc.documentId;
    const sec = (await store.applyEdit(d, { type: "insert", content: { type: "section", title: "Plan", children: [{ type: "markdown", markdown: "# Inputs > Outputs\n\nmaps\n\n# Inputs\n\n## Outputs\n\nnested\n\n## parse_input_file\n\nsnake\n\n## a*b and **bold** and `code`\n\nmixed\n\n# Before › after\n\nchevron" }] } })).targetId;
    const body = (q) => store.readHeading(d, q).markdown;
    // One title containing " > " vs two levels: both exist, so the string is ambiguous and the error offers exact paths
    assert.throws(() => store.resolveHeading(store.getDoc(d), "Inputs > Outputs"), /matches 2 headings: \["Plan","Inputs > Outputs"\], \["Plan","Inputs","Outputs"\]/);
    assert.equal(body(["Plan", "Inputs > Outputs"]), "maps");
    assert.equal(body(["Inputs", "Outputs"]), "nested");
    assert.equal(body("Inputs \\> Outputs"), "maps");
    assert.equal(store.readHeading(d, ["Plan", "Inputs > Outputs"]).path.join("|"), "Plan|Inputs > Outputs");
    // a title with › is found whole
    assert.equal(body("Before › after"), "chevron");
    // underscores and single asterisks inside words are part of the title; formatting pairs are not
    assert.equal(body("parse_input_file"), "snake");
    assert.equal(body("a*b and bold and code"), "mixed");
    assert.equal(store.readHeading(d, "parse_input_file").heading, "Plan > Inputs > parse_input_file");
    await store.applyEdit(d, { type: "remove", targetId: sec });
});

await test("edit feedback: scoped conflicts, clear messages, atomic batches, expect, text fields, near misses, export", async () => {
    const d = doc.documentId;
    const sec = (await store.applyEdit(d, { type: "insert", content: { type: "section", title: "Plan", children: [{ markdown: "# Goals\n\nShip [it](review-source:head/src/api.ts#L1-L2)." }, { type: "code", language: "ts", text: "const a = 1;\nconst b = 2;" }] } })).targetId;
    const kids = () => store.getDoc(d).content.find((b) => b.id === sec).children;
    const [md, code] = kids().map((k) => k.id);
    // 1. renaming the parent isn't a change to the child (and changes doesn't list the child)
    const v0 = store.getDoc(d).version;
    await store.applyEdit(d, { type: "update", targetId: sec, changes: { title: "The plan" } });
    await store.applyEdit(d, { type: "replace", targetId: md, baseVersion: v0, content: { type: "markdown", markdown: "# Goals\n\nShip it soon." } });
    assert.deepEqual(store.changesSince(d, v0).changed.map((x) => x.id).sort(), [md, sec].sort());
    assert.deepEqual(store.changesSince(d, v0).changed.find((x) => x.id === sec).fields, ["title"]);
    // ...and a real conflict names the version, who and what
    const v1 = store.getDoc(d).version;
    await store.editProse(d, [{ blockId: md, from: 2, to: 2, before: "Ship it soon.", after: "Ship it today." }]);
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: md, baseVersion: v1, ops: [{ find: "Goals", replace: "Aims" }] }), new RegExp(`${md} changed \\(markdown\\) since version ${v1}: first in v${v1 + 1}, by the user \\(an in-place edit`));
    // 2. a batch is all or nothing
    const v2 = store.getDoc(d).version;
    await rejects(() => store.applyEdits(d, [{ type: "patch", targetId: md, ops: [{ find: "today", replace: "now" }] }, { type: "remove", targetId: "nope" }]), /edits\[1\] failed, so nothing was saved/);
    assert.equal(store.getDoc(d).version, v2);
    // ...and applying a held suggestion tags its versions, so the transcript doesn't count them as the running turn's
    await store.applyEdits(d, [{ type: "patch", targetId: md, ops: [{ find: "today", replace: "soon" }] }], { origin: "suggestion" });
    assert.equal(store.getDoc(d).lastEdit.origin, "suggestion");
    await store.applyEdits(d, [{ type: "patch", targetId: md, ops: [{ find: "soon", replace: "today" }] }]);
    assert.equal(store.getDoc(d).lastEdit.origin, undefined);
    // 3. expect may be the whole range or just its first line
    await store.applyEdit(d, { type: "patch", targetId: md, ops: [{ lines: [1, 3], expect: "# Goals", text: "# Goals\n\nShip it now." }] });
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: md, ops: [{ lines: [1, 3], expect: "# Nope", text: "x" }] }), /all of them, or just line 1/);
    // 7. a code block's text is its default field; a near miss says where
    await store.applyEdit(d, { type: "patch", targetId: code, ops: [{ find: "const b = 2;", replace: "const b = 3;" }] });
    assert.equal(kids().find((k) => k.id === code).text, "const a = 1;\nconst b = 3;");
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: code, ops: [{ find: "const  b = 3;", replace: "x" }] }), /matches if spacing and line breaks are ignored/);
    await rejects(() => store.applyEdit(d, { type: "patch", targetId: code, ops: [{ find: "const c = 3;", replace: "x" }] }), /closest \(lines 2–2\): "const b = 3;"/);
    // 5. Markdown export: headings nest, code links become paths, code is fenced, the header's sha256 is the body's
    const out = await store.docMarkdown(d);
    assert.match(out.markdown, /^---\nmarginal:\n {2}documentId: /);
    assert.match(out.markdown, new RegExp(`version: ${store.getDoc(d).version}`));
    assert.match(out.body, /\n## The plan\n\n### Goals\n\nShip it now\./);
    assert.match(out.body, /```ts\nconst a = 1;\nconst b = 3;\n```/);
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(out.body).digest("hex"), out.sha256);
    assert.ok(out.markdown.includes(`sha256: ${out.sha256}`));
    const scoped = await store.docMarkdown(d, { heading: "The plan > Goals" });
    assert.match(scoped.body, /^## Goals\n\nShip it now\.\n$/);
    const { mkdtempSync, readFileSync: rd } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "wb-exp-")), "sub", "plan.md");
    const ex = await store.exportDoc(d, { path: file });
    assert.equal(rd(file, "utf8").includes(`sha256: ${ex.sha256}`), true);
    await rejects(() => store.exportDoc(d, { path: "relative.md" }), /absolute/);
    await rejects(() => store.exportDoc(d, { path: join(tmpdir(), "x.txt") }), /\.md/);
    // fences: a four-backtick block holding a three-backtick line stays code (no heading shifted, none indexed)
    const fenced = (await store.applyEdit(d, { type: "insert", parentId: sec, content: { type: "markdown", markdown: "# Real\n\n````md\n```\n# not a heading\n````\n\n## After" } })).targetId;
    assert.match((await store.docMarkdown(d)).body, /\n# not a heading\n/);
    assert.deepEqual(store.headingIndex({ content: [store.getDoc(d).content.find((b) => b.id === sec).children.find((k) => k.id === fenced)] }).map((e) => e.text), ["Real", "After"]);
    // removing a flow node guards the edges it would take with it
    const flow = (await store.applyEdit(d, { type: "insert", content: { type: "flow_diagram", title: "F", nodes: [{ key: "a", label: "A" }, { key: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "go" }] } })).targetId;
    const f0 = store.getDoc(d).content.find((b) => b.id === flow);
    const vf = store.getDoc(d).version;
    await store.applyEdit(d, { type: "update", targetId: f0.edges[0].id, changes: { label: "go now" } });
    await rejects(() => store.applyEdit(d, { type: "remove", targetId: f0.nodes[0].id, baseVersion: vf }), /changed inside since version/);
    await store.applyEdit(d, { type: "remove", targetId: flow });
    await store.applyEdit(d, { type: "remove", targetId: sec });
});

await test("settings: defaults, partial merges, and bad values fall back", async () => {
    const { readSettings, writeSettings, parseSettings } = await import("../extensions/marginal/lib/settings.mjs");
    assert.deepEqual(readSettings().shortcuts, { jump: true, stepKeys: true, tourKey: true, markdown: true, chat: true });
    assert.equal(readSettings().theme, "auto");
    const s = writeSettings({ shortcuts: { jump: false }, theme: "win95" });
    assert.equal(s.shortcuts.jump, false);
    assert.equal(s.shortcuts.markdown, true);
    assert.equal(writeSettings({ effects: false }).theme, "win95");
    assert.equal(readSettings().effects, false);
    assert.deepEqual(parseSettings({ theme: "nope", effects: "yes", shortcuts: { jump: "no" } }), { shortcuts: { jump: true, stepKeys: true, tourKey: true, markdown: true, chat: true }, theme: "auto", effects: true, interrupt: { doc: false, command: true }, command: { worktrees: false } });
    assert.equal(readSettings().command.worktrees, false, "worktrees are hidden by default");
    assert.equal(writeSettings({ command: { worktrees: true } }).command.worktrees, true);
    assert.equal(writeSettings({ theme: "dark" }).command.worktrees, true, "other changes keep it");
    assert.equal(parseSettings({ command: { worktrees: "yes" } }).command.worktrees, false);
    writeSettings({ shortcuts: { jump: true }, theme: "auto", effects: true, command: { worktrees: false } });
});

await test("database_lens relationship checks", async () => {
    const lens = (field) => ({
        type: "database_lens",
        title: "Inventory",
        actors: { api: "API" },
        stores: { pg: { label: "Postgres", storage: "relational", collections: { holds: { label: "holds", fields: { id: { label: "id", dataType: "uuid", primaryKey: true } } } } } },
        useCases: [{ label: "Reserve", operations: [{ kind: "write", store: "pg", collection: "holds", field, actor: "api", label: "insert hold", source: { file: "src/api.ts", startLine: 6 } }] }],
    });
    await store.applyEdit(doc.documentId, { type: "insert", content: lens("id") });
    await rejects(() => store.applyEdit(doc.documentId, { type: "insert", content: lens("nope") }), /Unknown field in pg\.holds: nope/);
});

await test("move into section, cannot move into itself", async () => {
    await store.applyEdit(doc.documentId, { type: "move", targetId: seqId, parentId: sectionId, afterId: mdId });
    const sec = store.getDoc(doc.documentId).content.find((b) => b.id === sectionId);
    assert.deepEqual(sec.children.map((c) => c.id), [mdId, seqId]);
    await rejects(() => store.applyEdit(doc.documentId, { type: "move", targetId: sectionId, parentId: sectionId }), /inside itself/);
});

await test("outline is readable and includes IDs", async () => {
    const text = store.outline(store.getDoc(doc.documentId));
    assert.match(text, new RegExp(`\\[${sectionId}\\] section "What / why"`));
    assert.match(text, /api → inv \(async\): hold\(items\)/);
});

await test("history + restore", async () => {
    const h = store.history(doc.documentId);
    assert.equal(h[0].version, 0);
    const before = store.getDoc(doc.documentId).version;
    const r = await store.restore(doc.documentId, 2);
    assert.equal(r.version, before + 1);
    assert.equal(store.getDoc(doc.documentId).content.length, 1);
});

await test("file lenses report uncategorized files", async () => {
    let r = await store.lensEdit(doc.documentId, { op: "list" });
    assert.deepEqual(r.uncategorized.sort(), ["src/api.test.ts", "src/api.ts"]);
    r = await store.lensEdit(doc.documentId, { op: "insert", title: "Tests", paths: ["src/api.test.ts"], collapsed: true });
    assert.deepEqual(r.uncategorized, ["src/api.ts"]);
    r = await store.lensEdit(doc.documentId, { op: "insert", title: "Implementation", paths: ["src/"] });
    assert.deepEqual(r.uncategorized, []);
});

await test("scratchpad: prepends, and sources need their own pins", async () => {
    await store.applyEdit("scratchpad", { type: "insert", content: { type: "markdown", markdown: "first" } });
    await store.applyEdit("scratchpad", { type: "insert", content: { type: "markdown", markdown: "second" } });
    assert.equal(store.getDoc("scratchpad").content[0].markdown, "second");
    await rejects(() => store.applyEdit("scratchpad", { type: "insert", content: { type: "code_peek", source: { file: "src/api.ts", startLine: 1 } } }), /has no pins/);
    await store.applyEdit("scratchpad", { type: "insert", content: { type: "code_peek", source: { file: "src/api.ts", startLine: 1, endLine: 3, pins: { repositoryId: repoId, head: pins.head } } } });
    await rejects(() => store.remove("scratchpad"), /cannot be deleted/);
});

await test("activity begin/end", async () => {
    let r = store.setActivity(doc.documentId, { action: "begin", focus: "Reading the diff" });
    assert.equal(r.activity[0].focus, "Reading the diff");
    r = store.setActivity(doc.documentId, { action: "end" });
    assert.equal(r.activity.length, 0);
});

await test("set_target reports broken sources after repin", async () => {
    await store.applyEdit(doc.documentId, { type: "insert", content: { type: "code_peek", source: { file: "src/api.ts", startLine: 10, endLine: 12 } } });
    const r = await store.setTarget(doc.documentId, { repositoryId: repoId, base: pins.base, head: pins.base });
    assert.ok(r.brokenSources.length >= 1);
});

await test("persistence: reload from disk in a fresh process", async () => {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const s = await import(${JSON.stringify(pathToFileURL(join(extDir, "lib", "store.mjs")).href)}); console.log(JSON.stringify(s.list().map(d=>[d.documentId,d.version])));`], { env: process.env, encoding: "utf8" });
    const list = JSON.parse(out);
    assert.ok(list.some(([id]) => id === doc.documentId));
});

await test("instructions topics", async () => {
    for (const t of ["authoring", "scratchpad", "blocks", "file-lenses"]) assert.ok(getInstructions(t).length > 200);
});

await test("delete doc", async () => {
    await store.remove(doc.documentId);
    assert.equal(store.hasDoc(doc.documentId), false);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
rmSync(tmp, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
