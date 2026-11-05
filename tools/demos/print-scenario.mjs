// Synthetic browser-print fixtures. Only the unused SDK/chat edge is synthetic;
// documents, parsing, Git, source requests, static assets and rendering are real.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const SENTENCE = "A paper copy preserves this authored explanation beyond the scrolling screen.";
export const FINAL = "PRN_FINAL_OMEGA The complete document reaches this unique final paragraph. Nothing after the scrolling viewport is discarded.";
export const WIDE = `PRN_WIDE_BEGIN${"X".repeat(300)}PRN_WIDE_END`;
export const TABLE_WIDE = `${"Y".repeat(300)}PRN_TABLE_RIGHT_EDGE`;
export const TALL = `${"Tall cell content continues without clipping. ".repeat(30)}PRN_TALL_ROW_END`;
export const paragraph = (n) => `PRN_P${String(n).padStart(3, "0")} ${Array(4).fill(SENTENCE).join(" ")}`;
export const numbered = (tag, n) => `${tag}_${String(n).padStart(3, "0")}`;
export const SOURCE_CITATION = "print-source.mjs:1–160";
export const TITLES = Object.freeze({ long: "PRN_DOCUMENT_TITLE", heading: "PRN_HEADING_TITLE", code: "PRN_CODE_TITLE", source: "PRN_SOURCE_TITLE", table: "PRN_TABLE_TITLE", graphics: "PRN_GRAPHICS_TITLE", ui: "PRN_UI_TITLE", empty: "PRN_EMPTY_TITLE" });

// A dependency-free, wholly synthetic 800 x 1600 PNG: border, colored corners, cross.
function syntheticPng() {
    const width = 800, height = 1600;
    const raw = Buffer.alloc(height * (1 + width * 3), 255);
    for (let y = 0; y < height; y++) {
        raw[y * (1 + width * 3)] = 0;
        for (let x = 0; x < width; x++) {
            let rgb = [255, 255, 255];
            if (x < 100 && y < 100) rgb = [220, 30, 30];
            else if (x >= 700 && y < 100) rgb = [30, 170, 45];
            else if (x < 100 && y >= 1500) rgb = [30, 60, 220];
            else if (x >= 700 && y >= 1500) rgb = [220, 170, 20];
            if (x < 12 || x >= 788 || y < 12 || y >= 1588 || Math.abs(x - 400) < 14 || Math.abs(y - 800) < 14) rgb = [20, 20, 20];
            const offset = y * (1 + width * 3) + 1 + x * 3;
            raw[offset] = rgb[0]; raw[offset + 1] = rgb[1]; raw[offset + 2] = rgb[2];
        }
    }
    function chunk(type, data) {
        const name = Buffer.from(type), body = Buffer.concat([name, data]);
        let crc = 0xffffffff;
        for (const byte of body) {
            crc ^= byte;
            for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        const head = Buffer.alloc(4), tail = Buffer.alloc(4);
        head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([head, body, tail]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function content(source) {
    const md = (id, markdown) => ({ id, type: "markdown", markdown });
    const folded = { id: "sec-prn-folded", type: "section", title: "PRN_FOLDED_OUTER", defaultCollapsed: true, children: [
        md("md-prn-folded", "PRN_FOLDED_CONTENT"),
        { id: "sec-prn-inner", type: "section", title: "PRN_FOLDED_INNER", defaultCollapsed: true, children: [md("md-prn-inner", "PRN_FOLDED_INNER_CONTENT")] },
    ] };
    const long = Array.from({ length: 120 }, (_, i) => md(`md-prn-p${i + 1}`, paragraph(i + 1)));
    long.splice(40, 0, folded);
    long.push(md("md-prn-final", FINAL));
    const code = [
        { id: "code-prn-embed", type: "code", language: "javascript", text: [...Array.from({ length: 180 }, (_, i) => `// ${numbered("PRN_EMBED", i + 1)}`), `// ${WIDE}`].join("\n"), caption: "PRN_EMBED_CAPTION" },
        md("md-prn-fence", `\`\`\`text\n${Array.from({ length: 180 }, (_, i) => numbered("PRN_FENCE", i + 1)).join("\n")}\n\`\`\`\n\nPRN_FENCE_CAPTION`),
        md("md-prn-code-end", "PRN_CODE_END"),
    ];
    const sequence = (id, count, title) => ({ id, type: "sequence", title, actors: { a: "PRN_ACTOR_A", b: "PRN_ACTOR_B" }, steps: Array.from({ length: count }, (_, i) => ({
        id: `${id}-step-${i}`, from: i % 2 ? "b" : "a", to: i % 2 ? "a" : "b",
        label: count === 28 ? i === 0 ? "PRN_SEQ_FIRST" : i === count - 1 ? "PRN_SEQ_LAST" : `PRN_S${i + 1}` : `PRN_SMALL_${i + 1}`,
        style: i % 3 === 1 ? "return" : "call", explanation: "PRN_INSPECT_ONLY_NOTE", source,
    })) });
    const frames = Array.from({ length: 69 }, (_, i) => ({ id: `fr-prn-shared-${i}`, key: `shared-${i}`, label: numbered("PRN_STACK", i + 1), source: { ...source, startLine: 1, endLine: 1 } }));
    const stack = { id: "stack-prn", type: "call_stack_diff", title: "PRN_STACK_TITLE",
        base: [{ id: "fr-prn-removed", key: "removed", label: "PRN_STACK_REMOVED", source: { ...source, startLine: 1, endLine: 1 } }, ...frames],
        head: [{ id: "fr-prn-added", key: "added", label: "PRN_STACK_ADDED", source: { ...source, startLine: 1, endLine: 1 } }, ...frames.map((f) => ({ ...f, id: `${f.id}-head` }))] };
    const database = { id: "db-prn", type: "database_lens", title: "PRN_DB_TITLE", actors: { actor: "PRN_DB_ACTOR" },
        stores: { records: { label: "PRN_DB_STORE", storage: "relational", collections: { prn_records: { label: "prn_records", fields: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i + 1}`, { label: numbered("PRN_DB_FIELD", i + 1), dataType: "text" }])) } } } },
        useCases: ["DEFAULT", "SELECTED"].map((kind) => ({ id: `uc-${kind.toLowerCase()}`, label: `PRN_DB_${kind}`, summary: `PRN_DB_${kind}_SUMMARY`,
            operations: [{ id: `op-${kind.toLowerCase()}`, kind: "read", store: "records", collection: "prn_records", actor: "actor", label: `PRN_DB_${kind}_OP`, source }] })) };
    const table = ["| " + Array.from({ length: 8 }, (_, i) => `PRN_TH${i + 1}`).join(" | ") + " |", "| " + Array(8).fill("---").join(" | ") + " |",
        ...Array.from({ length: 100 }, (_, r) => "| " + Array.from({ length: 8 }, (_, c) => `PRN_T${String(r + 1).padStart(3, "0")}_C${c + 1}${r === 12 && c === 7 ? ` ${TABLE_WIDE}` : r === 49 && c === 3 ? ` ${TALL}` : ""}`).join(" | ") + " |")].join("\n");
    const graphics = [
        sequence("seq-prn-small", 2, "PRN_SMALL_SEQUENCE"),
        sequence("seq-prn-tall", 28, "PRN_TALL_SEQUENCE"),
        { id: "flow-prn-wide", type: "flow_diagram", title: "PRN_WIDE_FLOW", direction: "right",
            nodes: Array.from({ length: 8 }, (_, i) => ({ id: `node-prn-${i}`, key: `n${i}`, label: i === 0 ? "PRN_FLOW_FIRST" : i === 7 ? "PRN_FLOW_LAST" : `PRN_N${i + 1}` })),
            edges: Array.from({ length: 7 }, (_, i) => ({ id: `edge-prn-${i}`, from: `n${i}`, to: `n${i + 1}`, label: `PRN_E${i + 1}`, style: i === 3 ? "dashed" : "solid" })) },
        stack, database,
        { id: "image-prn", type: "image", url: `data:image/png;base64,${syntheticPng().toString("base64")}`, alt: "PRN_IMAGE_BORDER_CORNERS_CROSS", caption: "PRN_IMAGE_CAPTION" },
        md("md-prn-graphics-end", "PRN_GRAPHICS_END"),
    ];
    return {
        long, code, graphics,
        source: [{ id: "peek-prn-source", type: "code_peek", source, caption: "PRN_SOURCE_CAPTION" }, md("md-prn-source-end", "PRN_SOURCE_END")],
        heading: [md("md-prn-spacer", "PRN_SPACER"), md("md-prn-heading", "# PRN_BOUNDARY_HEADING"), md("md-prn-heading-body", "PRN_BOUNDARY_BODY_FIRST PRN_BOUNDARY_BODY_MIDDLE PRN_BOUNDARY_BODY_LAST")],
        table: [md("md-prn-table", table), md("md-prn-table-end", "PRN_TABLE_END")],
        ui: [md("md-prn-ui-head", "# PRN_UI_HEADING"), md("md-prn-u1", paragraph(1)), md("md-prn-u2", paragraph(2)), structuredClone(folded),
            { ...code[0], text: "// PRN_UI_CODE_INK", caption: "PRN_UI_CODE_CAPTION" }, sequence("seq-prn-ui", 2, "PRN_UI_DIAGRAM"), md("md-prn-ui-end", "PRN_UI_END")],
        empty: [],
    };
}

async function worker() {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const run = resolve(process.env.PRINT_RUN_ROOT ?? "");
    const rel = relative(join(root, "artifacts", "print-validation"), run);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || !process.env.PRINT_RUN_NONCE ||
        readFileSync(join(run, ".print-owner"), "utf8") !== process.env.PRINT_RUN_NONCE) throw new Error("Unowned print fixture directory");
    const owned = join(run, "owned");
    process.env.MARGINAL_DATA_DIR = join(owned, "data");
    mkdirSync(owned);
    const repo = join(owned, "git");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", ["--no-pager", ...args], { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_GLOBAL: join(owned, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } }).trim();
    git("init", "--quiet", "-b", "print-fixture");
    const sourceLines = (old) => Array.from({ length: 160 }, (_, i) => `// ${numbered("PRN_SOURCE", i + 1)}${i === 79 ? old ? " PRN_DIFF_OLD_ONLY" : " PRN_DIFF_NEW_ONLY" : ""}`).join("\n") + "\n";
    const commit = (text) => {
        writeFileSync(join(repo, "print-source.mjs"), sourceLines(text === "base"));
        git("add", "--", "print-source.mjs");
        git("-c", "user.name=Print Fixture", "-c", "user.email=print-fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m",
            `${text}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`);
        return git("rev-parse", "HEAD");
    };
    const base = commit("base"), head = commit("head");
    const store = await import("../../extensions/marginal/lib/store.mjs");
    const gitm = await import("../../extensions/marginal/lib/git.mjs");
    const { parseBlock } = await import("../../extensions/marginal/lib/blocks.mjs");
    const { startServer } = await import("../../extensions/marginal/lib/server.mjs");
    const record = await gitm.registerRepository(repo);
    const target = await gitm.resolvePins(record.repositoryId, base, head);
    if (target.base !== base || target.head !== head) throw new Error("Synthetic source pins do not match the two actual fixture commits");
    const fixtures = content({ file: "print-source.mjs", startLine: 1, endLine: 160 });
    const ids = {}, blockIds = {}, instances = new Map();
    instances.save = () => {};
    for (const [name, blocks] of Object.entries(fixtures)) {
        const doc = await store.create({ title: TITLES[name], target });
        if (blocks.length) await store.applyEdits(doc.documentId, blocks.map((block) => ({ type: "insert", content: parseBlock(block) })));
        ids[name] = doc.documentId;
        const names = {};
        const pair = (original, actual) => {
            if (original.id) names[original.id] = actual.id;
            for (const key of ["children", "steps", "nodes", "edges", "base", "head", "useCases", "operations"])
                if (original[key]) original[key].forEach((item, index) => pair(item, actual[key][index]));
        };
        blocks.forEach((block, index) => pair(block, store.getDoc(doc.documentId).content[index]));
        blockIds[name] = names;
        instances.set(`browser-print-${name}`, { documentId: doc.documentId });
        instances.set(`print-host-${name}`, { documentId: doc.documentId });
    }
    let chatSends = 0;
    const chat = { subscribe: () => () => {}, pendingProposals: () => [], end: () => {}, send: async () => { chatSends++; throw new Error("Print tests must not send chat"); } };
    const transcript = { subscribe: () => () => {}, history: async () => ({ items: [], hasMore: false }), noteDocEdit: () => {} };
    const service = await startServer({ chat, transcript, instances, getSessionId: () => "synthetic-print-unused" });
    const snapshot = () => {
        const files = {};
        const walk = (dir) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) walk(path);
                else {
                    // Catalog activity/last-access and UI instance state are read bookkeeping, not document/settings writes.
                    const r = relative(process.env.MARGINAL_DATA_DIR, path);
                    if (/^(docs|settings)([\\/.]|$)/.test(r)) files[r] = createHash("sha256").update(readFileSync(path)).digest("hex");
                }
            }
        };
        walk(process.env.MARGINAL_DATA_DIR);
        const source = Object.fromEntries(["print-source.mjs", ".git\\HEAD", ".git\\config", ".git\\refs\\heads\\print-fixture"].map((path) =>
            [path, createHash("sha256").update(readFileSync(join(repo, path))).digest("hex")]));
        return { documents: Object.fromEntries(Object.values(ids).map((id) => [id, createHash("sha256").update(JSON.stringify(store.getDoc(id))).digest("hex")])), files, source, chatSends };
    };
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        service.server.closeAllConnections();
        await new Promise((done) => service.server.close(done));
        process.exit(0);
    };
    process.on("message", (message) => {
        if (!message || typeof message !== "object" || typeof message.id !== "number") return;
        if (message.op === "snapshot") process.send({ id: message.id, snapshot: snapshot() });
        else if (message.op === "close") void close();
        else process.send({ id: message.id, error: "Unsupported print worker operation" });
    });
    process.on("disconnect", () => void close());
    process.on("SIGTERM", () => void close());
    process.send({ type: "ready", ids, blockIds, urls: Object.fromEntries(Object.keys(ids).map((name) => [name, service.urlFor(`browser-print-${name}`)])),
        hostUrl: service.urlFor("print-host-ui"), base, head, sourceFile: "print-source.mjs" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 3 || process.argv[2] !== "--worker" || !process.send) throw new Error("Print scenario requires --worker and its owning driver's IPC");
    await worker();
}
