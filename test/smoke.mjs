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
