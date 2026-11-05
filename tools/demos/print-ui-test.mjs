// Headless Edge / real Marginal / actual PDF proof. No app, endpoint or model replacements.
// $env:PYTHONPATH=(Resolve-Path artifacts\print-tools\python).Path
// node tools\demos\print-ui-test.mjs --out=artifacts\print-validation\run-001
// Optional focused selection: $env:PRINT_CASE="PR-TC08"
import { fork, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { SENTENCE, FINAL, WIDE, TABLE_WIDE, TALL, paragraph, numbered, SOURCE_CITATION, TITLES } from "./print-scenario.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
if (args.some((arg) => !arg.startsWith("--out=")) || args.filter((arg) => arg.startsWith("--out=")).length > 1) throw new Error("Usage: print-ui-test.mjs [--out=artifacts\\print-validation\\unique-run]");
const baseDir = join(root, "artifacts", "print-validation");
const out = resolve(root, args.find((arg) => arg.startsWith("--out="))?.slice(6) ?? join("artifacts", "print-validation", `run-${Date.now()}`));
const outRel = relative(baseDir, out);
if (!outRel || outRel === ".." || outRel.startsWith(`..${sep}`) || resolve(out, "..") === out || existsSync(out)) throw new Error("Output must be a NEW owned directory below artifacts\\print-validation");
mkdirSync(out, { recursive: true });
const nonce = randomUUID();
writeFileSync(join(out, ".print-owner"), nonce);
const scratch = join(out, "control-scratch");
mkdirSync(scratch);
const runtimeScratch = join(scratch, "browser-runtime");
mkdirSync(runtimeScratch);
for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = runtimeScratch;
const helper = join(root, "test", "fixtures", "print-pdf.py");
const python = process.env.PRINT_PYTHON ?? "python";
const results = [], captures = [], controls = [], errors = [], requests = [];
const report = { schema: 1, started: new Date().toISOString(), command: [process.execPath, ...process.argv.slice(1)], cwd: root, out,
    selection: process.env.PRINT_CASE ?? null,
    versions: { node: process.version }, results, captures, controls, errors, requests, scope: "Synthetic Doc browser printing only; PR-TC07 integrated docs/original suites remain coordinator-owned.",
    coordinatorGates: ["original targeted tests", "pages-ui-test.mjs", "npm test", "README/Unreleased/Docs.md", "independent integrated review"] };
class OracleError extends Error {
    constructor(oracle, detail) { super(`${oracle}: ${detail}`); this.oracle = oracle; }
}
const must = (ok, oracle, detail) => { if (!ok) throw new OracleError(oracle, detail); };
const normal = (text) => text.replace(/\s+/g, " ").trim();
const compact = (text) => text.replace(/\s+/g, "");
const fullText = (pdf) => normal(pdf.pages.map(bodyText).join(" "));
const fullCompact = (pdf) => compact(pdf.pages.map(bodyText).join(""));
const count = (text, token) => text.split(token).length - 1;
const finiteBox = (box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] >= box[0] && box[3] >= box[1];
const margin = 15 * 72 / 25.4;
const rgb = (hex) => [hex >> 16 & 255, hex >> 8 & 255, hex & 255];
const near = (a, b, delta = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= delta);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sourceHashes = () => Object.fromEntries(["tools\\demos\\print-ui-test.mjs", "tools\\demos\\print-scenario.mjs", "test\\fixtures\\print-pdf.py",
    ...["print.css", "app.js", "index.html", "themes.css", "style.css", "settings.css", "core.js", "references.js", "tables.js", "toc.js", "scrollbars.js", "settings.js"].map((p) => `extensions\\marginal\\web\\${p}`),
    ...["store.mjs", "git.mjs", "blocks.mjs", "server.mjs", "catalog.mjs"].map((p) => `extensions\\marginal\\lib\\${p}`)]
    .filter((p) => existsSync(join(root, p))).map((p) => [p, hash(join(root, p))]));
let browser, context, child, info, rpcId = 0;
const waiters = new Map();
const baselines = new Map();
let workerLog = "";

async function test(name, fn) {
    if (process.env.PRINT_CASE && !name.includes(process.env.PRINT_CASE)) return;
    const start = Date.now();
    try {
        const detail = await fn();
        results.push({ name, ok: true, milliseconds: Date.now() - start, ...(detail === undefined ? {} : { detail }) });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, ok: false, milliseconds: Date.now() - start, oracle: error.oracle ?? "execution", error: error.stack });
        console.error(`FAIL ${name}: ${error.message}`);
    }
}
async function rpc(op) {
    must(child?.connected, "worker", "Fixture child is disconnected");
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`Worker ${op} timeout`)); }, 15000);
        waiters.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
        child.send({ id, op });
    });
}
function loadInspection(dir) {
    const path = join(dir, "inspection.json");
    must(existsSync(path) && statSync(path).size > 100, "evidence", `Missing/empty ${path}`);
    const pdf = JSON.parse(readFileSync(path, "utf8"));
    must(pdf.schema === 1 && pdf.dpi === 144 && Number.isInteger(pdf.pageCount) && pdf.pageCount > 0 && Array.isArray(pdf.pages) && pdf.pages.length === pdf.pageCount, "evidence", "Malformed PDF report");
    must(typeof pdf.pdf === "string" && existsSync(pdf.pdf) && statSync(pdf.pdf).size > 100, "evidence", "Missing/empty actual PDF");
    for (const [i, page] of pdf.pages.entries()) {
        must(page.index === i && Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0 &&
            typeof page.text === "string" && Array.isArray(page.spans) && Array.isArray(page.words) && Array.isArray(page.images) && Array.isArray(page.drawings), "evidence", `Malformed page ${i}`);
        must(page.spans.every((s) => typeof s.text === "string" && finiteBox(s.bbox) && Number.isFinite(s.color) && Number.isFinite(s.ink)) &&
            page.words.every((s) => typeof s.text === "string" && finiteBox(s.bbox)) && page.images.every((s) => finiteBox(s.bbox) && s.width > 0 && s.height > 0) &&
            page.drawings.every((s) => finiteBox(s.bbox)), "evidence", `Malformed extraction page ${i}`);
        must(typeof page.raster === "string" && /^page-\d{3}\.png$/.test(page.raster) && existsSync(join(dir, page.raster)) && statSync(join(dir, page.raster)).size > 100, "evidence", `Missing/empty page ${i} raster`);
    }
    must(pdf.pages.some((p) => p.spans.some((s) => s.text.trim()) || p.images.length), "evidence", "No actual content evidence");
    return pdf;
}
function extract(file, dir) {
    const command = [helper, "--pdf", file, "--out", dir];
    const run = spawnSync(python, command, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    must(!run.error && run.status === 0, "extractor", `${python} ${command.join(" ")}; status ${run.status}; ${run.error ?? run.stderr}`);
    const pdf = loadInspection(dir);
    report.versions.pymupdf = pdf.version;
    return pdf;
}
async function capture(page, name, { format = "A4", background = false, control = false } = {}) {
    const parent = control ? scratch : out;
    const file = join(parent, `${name}.pdf`), dir = join(parent, name);
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: file, format, margin: { top: "15mm", right: "15mm", bottom: "15mm", left: "15mm" },
        displayHeaderFooter: false, printBackground: background, preferCSSPageSize: false });
    const pdf = extract(file, dir);
    if (!control) baselines.set(page.printFixture, pdf);
    (control ? controls : captures).push({ name, format, background, pdf: relative(out, file), inspection: relative(out, join(dir, "inspection.json")), pages: pdf.pageCount,
        sha256: hash(file), extractorCommand: [python, helper, "--pdf", file, "--out", dir], extractorExit: 0, ...(control ? { scratchRemovedAfterSummary: true } : {}) });
    return pdf;
}
async function fault(page, name, css, oracle, options = {}, companion) {
    const baseline = baselines.get(page.printFixture);
    must(!!baseline, "control-prerequisite", `${name} needs an actual positive PDF first`);
    // A negative is not independent if its target already fails without the fault.
    oracle(baseline);
    const style = await page.addStyleTag({ content: css });
    try {
        const pdf = await capture(page, name, { ...options, control: true });
        if (companion) companion(pdf);
        let failed;
        try { oracle(pdf); } catch (error) { failed = error; }
        must(failed instanceof OracleError, "negative-control", `${name} did not fail its named oracle`);
        return { observedOracle: failed.oracle, observedFailure: failed.message, actualPages: pdf.pageCount };
    } finally { await style.evaluate((node) => node.remove()); }
}
function includes(pdf, token, oracle = "content") {
    must(fullCompact(pdf).includes(compact(token)), oracle, `Missing ${token.slice(0, 100)}`);
}
function excludes(pdf, tokens, oracle = "chrome-absence") {
    const text = fullText(pdf);
    for (const token of tokens) must(!text.includes(token), oracle, `Unexpected ${token}`);
}
function locate(pdf, marker) {
    for (const page of pdf.pages) {
        const span = page.spans.find((s) => s.text.includes(marker));
        if (span) return { page: page.index, bbox: span.bbox, span };
    }
    throw new OracleError("position", `No searchable span for ${marker}`);
}
function inFooterPosition(page, [x0, y0, x1, y1]) {
    return y0 > page.height - margin && y1 < page.height && Math.abs((x0 + x1) / 2 - page.width / 2) < 2;
}
function bodyText(page) {
    // Margin counters are separate from prose; bounds() exempts only the validated exact footer.
    return page.spans.filter((span) => !(/^\d+\/\d+$/.test(span.text.trim()) && inFooterPosition(page, span.bbox)))
        .map((span) => span.text).join(" ");
}
function pageFooter(page, total) {
    const expected = `${page.index + 1}/${total}`;
    const candidates = page.spans.filter((span) => span.text.trim() === expected && span.bbox[1] > page.height - margin);
    must(candidates.length === 1, "page-numbers", `Page ${page.index + 1}: expected one ${expected} footer, got ${candidates.length}`);
    const footer = candidates[0];
    must(inFooterPosition(page, footer.bbox),
        "page-numbers", `Page ${page.index + 1}: footer is not centered and fully inside the bottom margin: ${footer.bbox}`);
    return footer;
}
function pageNumbers(pdf) {
    for (const page of pdf.pages) pageFooter(page, pdf.pageCount);
}
function bounds(pdf, oracle = "printable-bounds") {
    for (const page of pdf.pages) {
        const footer = pageFooter(page, pdf.pageCount);
        for (const span of page.spans) if (span !== footer && span.text.trim()) {
            const [x0, y0, x1, y1] = span.bbox;
            must(x0 >= margin - 2 && y0 >= margin - 2 && x1 <= page.width - margin + 2 && y1 <= page.height - margin + 2, oracle,
                `page ${page.index + 1} ${JSON.stringify(span.text.slice(0, 90))} bbox ${span.bbox} outside ${margin}..${page.width - margin},${page.height - margin}`);
        }
    }
}
function finalParagraph(pdf) {
    must(fullText(pdf).includes(FINAL), "final-paragraph", "Complete final paragraph missing");
    must(locate(pdf, "PRN_FINAL_OMEGA").page >= 1, "final-paragraph", "Final paragraph is not on a later sheet");
}
function foldContent(pdf) {
    for (const text of ["PRN_FOLDED_OUTER", "PRN_FOLDED_CONTENT", "PRN_FOLDED_INNER", "PRN_FOLDED_INNER_CONTENT"]) includes(pdf, text, "folded-content");
}
function completeProse(pdf) {
    const text = fullText(pdf);
    for (let n = 1; n <= 120; n++) must(count(text, paragraph(n)) === 1, "complete-prose", `Paragraph ${n} must retain all four complete sentences exactly once`);
    must(count(text, SENTENCE) === 480, "complete-prose", `Expected 480 whole sentences, got ${count(text, SENTENCE)}`);
}
function longFlow(pdf) {
    must(pdf.pageCount >= 2, "multipage", `Only ${pdf.pageCount} page(s)`);
    must(count(fullText(pdf), TITLES.long) === 1, "title", "Document title must print exactly once");
    completeProse(pdf); foldContent(pdf); finalParagraph(pdf); bounds(pdf);
    const expected = [...Array.from({ length: 40 }, (_, i) => numbered("PRN_P", i + 1).replace("PRN_P_", "PRN_P")),
        "PRN_FOLDED_OUTER", "PRN_FOLDED_CONTENT", "PRN_FOLDED_INNER", "PRN_FOLDED_INNER_CONTENT",
        ...Array.from({ length: 80 }, (_, i) => `PRN_P${String(i + 41).padStart(3, "0")}`), "PRN_FINAL_OMEGA"];
    let last = -1;
    for (const marker of expected) { const i = fullText(pdf).indexOf(marker); must(i > last, "reading-order", `${marker} not after preceding content`); last = i; }
    const lastPage = pdf.pages.at(-1), footer = pageFooter(lastPage, pdf.pageCount);
    must(lastPage.spans.some((s) => s !== footer && s.text.trim()) || lastPage.images.length, "trailing-page", "Trailing blank page");
}
function heading(pdf) {
    const h = locate(pdf, "PRN_BOUNDARY_HEADING"), p = locate(pdf, "PRN_BOUNDARY_BODY_FIRST");
    must(h.page === p.page && h.bbox[1] < p.bbox[1], "heading-cohesion", `Heading page ${h.page + 1}, first body page ${p.page + 1}`);
    includes(pdf, "PRN_BOUNDARY_BODY_MIDDLE"); includes(pdf, "PRN_BOUNDARY_BODY_LAST");
}
function code(pdf) {
    for (const tag of ["PRN_EMBED", "PRN_FENCE"]) for (let n = 1; n <= 180; n++) includes(pdf, numbered(tag, n), "code-lines");
    includes(pdf, WIDE, "wide-code");
    for (const token of ["PRN_EMBED_CAPTION", "PRN_FENCE_CAPTION", "PRN_CODE_END"]) includes(pdf, token);
    must(pdf.pageCount >= 2, "code-fragmentation", "Long code did not fragment");
    must(pdf.pages.every((page) => /PRN_(?:EMBED|FENCE)_\d{3}|PRN_WIDE_BEGIN|PRN_(?:EMBED|FENCE)_CAPTION|PRN_CODE_END/.test(compact(page.text))),
        "code-fragmentation", "Code output contains an empty/header-only sheet");
    bounds(pdf);
}
function citation(pdf) { includes(pdf, SOURCE_CITATION, "source-citation"); }
function sourceCode(pdf) {
    citation(pdf);
    for (let n = 1; n <= 160; n++) includes(pdf, numbered("PRN_SOURCE", n), "source-lines");
    includes(pdf, "PRN_DIFF_NEW_ONLY", "current-code-view"); excludes(pdf, ["PRN_DIFF_OLD_ONLY"], "current-code-view");
    includes(pdf, "PRN_SOURCE_END"); excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]); bounds(pdf);
}
function diffView(pdf) {
    citation(pdf);
    for (const [marker, mark, color] of [["PRN_DIFF_OLD_ONLY", "−", 0x991b1b], ["PRN_DIFF_NEW_ONLY", "+", 0x166534]]) {
        includes(pdf, marker, "current-diff-view");
        const at = locate(pdf, marker), page = pdf.pages[at.page];
        const sign = page.spans.find((s) => s.text.trim() === mark && Math.abs(s.bbox[1] - at.bbox[1]) < 4 && s.bbox[2] <= at.bbox[0] + 2);
        must(sign && near(rgb(sign.color), rgb(color)) && sign.ink > 0, "diff-marks", `Missing/dim/wrong-color ${mark} alongside ${marker}`);
    }
    includes(pdf, "PRN_SOURCE_END"); excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]); bounds(pdf);
}
function tableCells(pdf) {
    const text = fullCompact(pdf);
    let last = -1;
    for (let row = 1; row <= 100; row++) for (let col = 1; col <= 8; col++) {
        const marker = `PRN_T${String(row).padStart(3, "0")}_C${col}`, i = text.indexOf(marker);
        must(i > last && count(text, marker) === 1, "table-cells", `${marker} missing/duplicated/out of row-column order`); last = i;
    }
    includes(pdf, TABLE_WIDE, "table-right-edge"); includes(pdf, "PRN_TALL_ROW_END", "tall-row");
    // PDF content order includes the other cells and repeating headers between
    // fragments of this oversized cell. Remove only those known table identities.
    const tallStart = text.indexOf("PRN_T050_C4") + "PRN_T050_C4".length;
    const tallEnd = text.indexOf("PRN_TALL_ROW_END") + "PRN_TALL_ROW_END".length;
    const tallText = text.slice(tallStart, tallEnd).replace(/PRN_T\d{3}_C[1-8]|PRN_TH[1-8]/g, "");
    must(tallText === compact(TALL), "tall-row", "Oversized cell did not retain all 30 complete sentences in order");
    includes(pdf, "PRN_TABLE_END"); bounds(pdf, "table-bounds");
}
function tableHeaders(pdf) {
    const first = pdf.pages.findIndex((p) => compact(p.text).includes("PRN_T001_C1"));
    const last = pdf.pages.findIndex((p) => compact(p.text).includes("PRN_T100_C8"));
    must(first >= 0 && last >= first, "table-headers", "Missing table boundary rows");
    // Include sheets containing only the middle of the oversized row: they may
    // have no ordinary cell identifier but still need continuation headers.
    const pages = pdf.pages.slice(first, last + 1);
    must(pages.length >= 2, "table-headers", "Table did not continue onto another sheet");
    for (const page of pages) for (let col = 1; col <= 8; col++) must(compact(page.text).includes(`PRN_TH${col}`), "table-headers", `Page ${page.index + 1} is missing repeating header ${col}`);
}
function selectedDatabase(pdf) {
    for (const token of ["PRN_DB_SELECTED", "PRN_DB_SELECTED_SUMMARY", "PRN_DB_SELECTED_OP", "read", "PRN_DB_ACTOR", "PRN_DB_STORE", "prn_records"]) includes(pdf, token, "selected-database");
    excludes(pdf, ["PRN_DB_DEFAULT", "PRN_DB_DEFAULT_SUMMARY", "PRN_DB_DEFAULT_OP"], "selected-database");
    const selected = pdf.pages.flatMap((p) => p.spans).filter((s) => s.text.trim() === "PRN_DB_SELECTED");
    must(selected.length === 1 && selected[0].ink > 0 && Math.max(...rgb(selected[0].color)) < 150, "selected-database", "Selected readable label missing, duplicated or illegible");
}
function stackStatus(pdf) {
    for (const token of ["Before (base)", "After (head)", "PRN_STACK_REMOVED", "PRN_STACK_ADDED", "print-source.mjs:1"]) includes(pdf, token, "stack-status");
    for (const [marker, status] of [["PRN_STACK_REMOVED", "gone"], ["PRN_STACK_ADDED", "new"]]) {
        const at = locate(pdf, marker), page = pdf.pages[at.page];
        const label = page.spans.find((s) => s.text.trim() === status && Math.abs(s.bbox[1] - at.bbox[1]) < 5);
        const location = page.spans.find((s) => s.text.includes("print-source.mjs:1") && Math.abs(s.bbox[1] - at.bbox[1]) < 5);
        must(label && location && label.ink > 0 && Math.max(...rgb(label.color)) < 190, "stack-status", `No legible ${status}/location associated with ${marker}`);
    }
    const text = fullText(pdf).toLowerCase();
    const contextOrder = ["before (base)", "prn_stack_removed", "after (head)", "prn_stack_added"].map((s) => text.indexOf(s));
    must(contextOrder.every((v, i) => v >= 0 && (i === 0 || v > contextOrder[i - 1])), "stack-status", "Frame/status lost its base/head context");
}
function imageEdges(pdf) {
    const images = pdf.pages.flatMap((page) => page.images.map((image) => ({ ...image, page }))).filter((im) => im.width === 800 && im.height === 1600);
    must(images.length === 1, "image-corners", `Expected exactly one loaded authored PNG, got ${images.length}`);
    const image = images[0], [x0, y0, x1, y1] = image.bbox;
    must(near([(x1 - x0) / (y1 - y0)], [.5], .005) && x0 >= margin - 2 && y0 >= margin - 2 && x1 <= image.page.width - margin + 2 && y1 <= image.page.height - margin + 2, "image-corners", `PNG distorted/outside printable page: ${image.bbox}`);
    for (const [corner, expected] of Object.entries({ tl: [220, 30, 30], tr: [30, 170, 45], bl: [30, 60, 220], br: [220, 170, 20], white: [255, 255, 255] })) must(near(image.samples[corner], expected, 18), "image-corners", `${corner} lost: ${image.samples[corner]}`);
    for (const name of ["top", "bottom", "left", "right", "center"]) must(image.samples[name].every((v) => v < 70), "image-border-cross", `${name} border/cross lost: ${image.samples[name]}`);
    includes(pdf, "PRN_IMAGE_CAPTION");
}
function graphics(pdf) {
    for (const token of ["PRN_SMALL_SEQUENCE", "PRN_TALL_SEQUENCE", "PRN_WIDE_FLOW", "PRN_SMALL_1", "PRN_SMALL_2", "PRN_SEQ_FIRST", "PRN_SEQ_LAST", "PRN_FLOW_FIRST", "PRN_FLOW_LAST",
        ...Array.from({ length: 26 }, (_, i) => `PRN_S${i + 2}`), ...Array.from({ length: 6 }, (_, i) => `PRN_N${i + 2}`),
        ...Array.from({ length: 7 }, (_, i) => `PRN_E${i + 1}`), "PRN_STACK_069", "PRN_DB_FIELD_100", "PRN_GRAPHICS_END"]) includes(pdf, token, "graphic-labels");
    const text = fullCompact(pdf);
    for (const token of [...Array.from({ length: 26 }, (_, i) => `PRN_S${i + 2}`), ...Array.from({ length: 6 }, (_, i) => `PRN_N${i + 2}`),
        ...Array.from({ length: 7 }, (_, i) => `PRN_E${i + 1}`)]) must(pdf.pages.some((page) => page.words.some((w) => w.text === token)),
        "graphic-labels", `Exact graph label ${token} missing (a longer label's prefix does not count)`);
    for (let n = 1; n <= 69; n++) must(count(text, numbered("PRN_STACK", n)) === 2, "graphic-labels", `Shared stack frame ${n} must survive in both base/head paths`);
    for (let n = 1; n <= 100; n++) must(count(text, numbered("PRN_DB_FIELD", n)) === 1, "graphic-labels", `Database field ${n} missing/duplicated`);
    for (const [start, end] of [["PRN_SMALL_1", "PRN_SMALL_2"], ["PRN_SEQ_FIRST", "PRN_SEQ_LAST"], ["PRN_FLOW_FIRST", "PRN_FLOW_LAST"]]) {
        const a = locate(pdf, start), b = locate(pdf, end);
        must(a.page === b.page, "graphic-fit", `${start}/${end} split across sheets`);
        const page = pdf.pages[a.page];
        const painted = page.drawings.filter((d) => d.ink > 0 && ((d.color && d.strokeOpacity > 0) || (d.fill && d.fillOpacity > 0)));
        for (const d of painted) {
            const [x0, y0, x1, y1] = d.bbox;
            const nonwhite = (d.color && d.strokeOpacity > 0 && d.color.some((c) => c < .95)) || (d.fill && d.fillOpacity > 0 && d.fill.some((c) => c < .95));
            if (nonwhite) must(x0 >= margin - 2 && y0 >= margin - 2 && x1 <= page.width - margin + 2 && y1 <= page.height - margin + 2, "graphic-edges", `Painted vector outside page ${a.page + 1}: ${d.bbox}`);
        }
        must(painted.length >= (start === "PRN_SMALL_1" ? 4 : start === "PRN_SEQ_FIRST" ? 56 : 14), "graphic-edges", `Missing painted paths for ${start}`);
        if (start !== "PRN_FLOW_FIRST") {
            for (const at of [a, b]) {
                const lines = painted.filter((d) => d.bbox[0] <= at.bbox[0] && d.bbox[2] >= at.bbox[2] && d.bbox[3] - d.bbox[1] < 3 &&
                    d.bbox[1] >= at.bbox[3] - 3 && d.bbox[1] <= at.bbox[3] + 10);
                must(lines.length > 0, "graphic-edges", `No raster-visible message edge below ${at.span.text}`);
                must(painted.some((d) => d.items === 3 && d.bbox[2] - d.bbox[0] > 2 && d.bbox[3] - d.bbox[1] > 2 &&
                    Math.abs((d.bbox[1] + d.bbox[3]) / 2 - lines[0].bbox[1]) < 4), "graphic-edges", `Missing arrowhead for ${at.span.text}`);
            }
            // Chromium can materialize dashes as filled subpaths rather than a PDF
            // dash operator. Preserve both representations instead of demanding one.
            must(painted.some((d) => (d.dashes && !/^\[\s*\]\s*0$/.test(d.dashes)) ||
                (d.fill && d.fillOpacity > 0 && d.items >= 12 && d.bbox[2] - d.bbox[0] > 20 && d.bbox[3] - d.bbox[1] < 3)), "graphic-edges", "Dashed/solid message distinction lost");
        } else {
            for (const at of [a, b]) must(painted.some((d) => d.color && d.strokeOpacity > 0 && d.bbox[0] < at.bbox[0] && d.bbox[2] > at.bbox[2] &&
                d.bbox[1] < at.bbox[1] && d.bbox[3] > at.bbox[3] && d.bbox[3] - d.bbox[1] < 100), "graphic-edges", `Missing fitted node border around ${at.span.text}`);
        }
    }
    imageEdges(pdf); bounds(pdf);
    excludes(pdf, ["PRN_INSPECT_ONLY_NOTE", "PRN_CHROME_", "PRN_CHAT_SECRET"]);
    selectedDatabase(pdf); stackStatus(pdf);
}
function paperRaster(pdf) {
    for (const page of pdf.pages) must(Array.isArray(page.corners) && page.corners.length === 4 && page.corners.every((c) => c.every((v) => v >= 250)), "paper-white", `Nonwhite physical paper corner page ${page.index + 1}`);
    for (const marker of [TITLES.ui, "PRN_UI_CODE_INK", "PRN_UI_DIAGRAM"]) {
        const at = locate(pdf, marker);
        must(at.span.ink > 2 && Math.max(...rgb(at.span.color)) < 190, "paper-ink", `${marker} has no dark raster ink/foreground`);
    }
    must(pdf.pages.some((p) => p.drawings.filter((d) => d.ink > 0 && ((d.color && d.strokeOpacity > 0 && d.color.every((v) => v < .6)) ||
        (d.fill && d.fillOpacity > 0 && d.fill.every((v) => v < .6)))).length >= 4), "paper-ink", "SVG dark edges/arrowheads missing from actual PDF");
}
const palette = { "--bg": "#ffffff", "--fg": "#1f2328", "--muted": "#4b5563", "--border": "#9ca3af", "--surface": "#f3f4f6", "--surface-2": "#e5e7eb",
    "--blue": "#0969da", "--green": "#166534", "--red": "#991b1b", "--yellow": "#854d0e", "--purple": "#6b21a8" };
async function paperStyles(page) {
    const styles = await page.evaluate((keys) => {
        const style = getComputedStyle(document.documentElement);
        const get = (selector, property) => getComputedStyle(document.querySelector(selector)).getPropertyValue(property);
        return { tokens: Object.fromEntries(keys.map((k) => [k, style.getPropertyValue(k).trim().toLowerCase()])),
            backgrounds: ["body", "#main", ".doc[data-print-title]"].map((s) => get(s, "background-color")),
            foreground: get(".doc[data-print-title]", "color"), muted: get(".caption", "color"), surface: get(".frame-head", "background-color"),
            title: getComputedStyle(document.querySelector(".doc[data-print-title]"), "::before").content,
            chrome: ["#bar", "#toc", "#chat", "#peek", "#settings", "#jump", "#gutter", "#tw-menu", "#col-grip"].map((s) => [s, document.querySelector(s) ? get(s, "display") : "absent"]),
            units: [...document.querySelectorAll(".diagram [data-unit]")].map((e) => getComputedStyle(e).opacity) };
    }, Object.keys(palette));
    for (const [key, value] of Object.entries(palette)) must(styles.tokens[key] === value, "paper-palette", `${key}: ${styles.tokens[key]} != ${value}`);
    must(styles.backgrounds.every((s) => s === "rgb(255, 255, 255)") && styles.foreground === "rgb(31, 35, 40)" &&
        styles.muted === "rgb(75, 85, 99)" && styles.surface === "rgb(243, 244, 246)", "paper-palette", JSON.stringify(styles));
    must(styles.chrome.every(([, display]) => display === "none" || display === "absent"), "chrome-shapes", JSON.stringify(styles.chrome));
    must(styles.units.every((opacity) => opacity === "1"), "inspect-opacity", `Dimmed diagram units ${styles.units}`);
    return styles;
}

async function screenState(page) {
    return page.evaluate(() => {
        const $ = (s) => document.querySelector(s);
        const geometry = (s) => { const r = $(s)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100) : null; };
        const cs = (s) => { const e = $(s); return e ? { display: getComputedStyle(e).display, background: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color, overflow: getComputedStyle(e).overflow } : null; };
        return { theme: document.documentElement.dataset.theme, effects: document.documentElement.hasAttribute("data-effects"),
            body: cs("body"), main: cs("#main"), doc: cs(".doc"), geometry: [geometry("#main"), geometry(".doc")],
            scroll: $("#main").scrollTop, folds: [...document.querySelectorAll(".section")].map((e) => [e.closest("[data-id]")?.dataset.id, e.classList.contains("collapsed")]),
            picks: [...document.querySelectorAll(".picked")].map((e) => e.dataset.id ?? e.dataset.unit ?? e.dataset.prose ?? e.textContent.trim()),
            inspectedUnits: [...document.querySelectorAll("#main .insp-on")].map((e) => e.dataset.unit),
            inspectMargins: [...document.querySelectorAll("#main .inspecting")].map((e) => e.style.marginRight),
            overlays: ["#chat", "#peek", "#toc", "#settings", "#jump"].map((s) => [s, !!$(s) && !$(s).hidden]),
            table: [...document.querySelectorAll(".md table")].map((t) => ({ mode: t.dataset.tw, cols: [...t.querySelectorAll("col")].map((c) => c.getAttribute("style")), geometry: (() => { const r = t.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100); })() })),
            storage: Object.fromEntries(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)])),
            screenTitle: getComputedStyle($(".doc"), "::before").content };
    });
}
function sameScreen(before, after) {
    const a = structuredClone(before), b = structuredClone(after);
    must(Math.abs(a.scroll - b.scroll) <= 1, "screen-state", `Scroll ${a.scroll} -> ${b.scroll}`);
    a.scroll = b.scroll;
    must(JSON.stringify(a) === JSON.stringify(b), "screen-state", `Screen changed\nbefore ${JSON.stringify(a)}\nafter ${JSON.stringify(b)}`);
    must(after.body.display === "flex" && /auto|scroll/.test(after.main.overflow) && (after.screenTitle === "none" || after.screenTitle === "normal"), "screen-layout", "Print layout leaked onto screen");
}
async function newPage(name, { width = 1400, theme = "light", host = false } = {}) {
    const page = await context.newPage();
    page.printFixture = name;
    await page.setViewportSize({ width, height: 900 });
    page.on("pageerror", (e) => errors.push({ fixture: name, error: e.message }));
    page.on("request", (req) => { if (req.url().includes("/api/") && req.method() !== "GET") requests.push({ fixture: name, method: req.method(), path: new URL(req.url()).pathname }); });
    try {
    await page.goto(host ? info.hostUrl : info.urls[name], { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`.doc[data-print-title="${TITLES[name]}"]`, { timeout: 15000 });
    // Store insertion owns stable IDs. These test-only aliases address geometry/fault
    // stimuli without changing the model or the renderer's real data-id attributes.
    await page.evaluate((ids) => {
        for (const [fixture, id] of Object.entries(ids)) for (const el of document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) el.dataset.printFixture = fixture;
    }, info.blockIds[name]);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.querySelector("#main .loading, #main .error") && [...document.querySelectorAll("#main img")].every((im) => im.complete && im.naturalWidth > 0), null, { timeout: 30000 });
    const link = await page.locator('head > link[rel="stylesheet"]').last().evaluate((el) => ({ href: el.getAttribute("href"), media: el.media, sheet: !!el.sheet }));
    must(link.href === "print.css" && link.media === "print" && link.sheet, "integrated-assets", `Final print stylesheet unavailable: ${JSON.stringify(link)}`);
    if (host) {
        await page.addStyleTag({ content: ":root { color-scheme:dark; --bg:#181818; --fg:#eeeeee; --surface:#242424; --muted:#aaaaaa; --border:#444444 }" });
    } else await setTheme(page, theme);
    if (await page.locator("#chat").isVisible()) await page.locator("#chat-close").click();
    if (await page.locator("#peek").isVisible()) await page.locator("#peek-close").click();
    await page.evaluate(() => { document.querySelector("#main").scrollTop = 0; });
    return page;
    } catch (error) {
        const path = join(out, `readiness-${name}-${Date.now()}`);
        writeFileSync(`${path}.json`, JSON.stringify(await page.evaluate(() => ({ url: location.href, main: document.querySelector("#main")?.outerHTML, body: document.body.className, errors: [...document.querySelectorAll(".error")].map((e) => e.textContent) })).catch(() => ({})), null, 2));
        await page.screenshot({ path: `${path}.png` }).catch(() => {});
        await page.close();
        throw error;
    }
}
async function setTheme(page, theme) {
    await page.locator("#settings-btn").click();
    await page.locator(`.set-theme[data-t="${theme}"]`).click();
    await page.waitForFunction((id) => document.documentElement.dataset.theme === id, theme);
    await page.locator('[aria-label="Close settings"]').click();
    await page.waitForTimeout(300);
}
async function openContents(page) {
    if (!await page.locator("#toc").isVisible()) await page.locator("#toc-btn").click();
    await page.waitForSelector("#toc:not([hidden])");
    if (await page.locator("#toc").evaluate((el) => el.classList.contains("min"))) await page.locator(".toc-bar").click();
}
async function openChrome(page, { inspect = true } = {}) {
    await openContents(page);
    if (inspect) {
        await page.locator(".insp-btn").first().click();
        await page.waitForSelector("#peek:not([hidden])");
    }
    await page.locator("#chat-btn").click();
    await page.waitForSelector("#chat:not([hidden])");
    for (const [selector, marker] of [["#bar", "PRN_CHROME_NAV"], ["#toc", "PRN_CHROME_CONTENTS"], ["#chat-log", "PRN_CHAT_SECRET"], ["#peek", "PRN_CHROME_INSPECT"]]) {
        if (selector === "#peek" && !inspect) continue;
        await page.locator(selector).evaluate((el, text) => { const span = document.createElement("span"); span.dataset.printProbe = ""; span.textContent = text; el.append(span); }, marker);
        must(await page.locator(selector).isVisible(), "chrome-readiness", `${selector} not actually visible`);
    }
}
async function tableMode(page, mode, resize = false) {
    await page.emulateMedia({ media: "screen" });
    await page.locator(".md table th").first().hover();
    await page.waitForSelector("#g-width:not([hidden])", { timeout: 8000 });
    await page.locator("#g-width").click();
    const label = { text: "Text width", wide: "Wide", full: "Full width" }[mode];
    await page.locator('#tw-menu [role="menuitemradio"]', { hasText: label }).click();
    await page.waitForFunction((m) => document.querySelector(".md table")?.dataset.tw === m, mode);
    if (resize) {
        const cell = await page.locator(".md table th").first().boundingBox();
        must(!!cell, "table-readiness", "No first header bounds");
        await page.mouse.move(cell.x + cell.width - 1, cell.y + cell.height / 2);
        await page.waitForSelector("#col-grip:not([hidden])", { timeout: 8000 });
        const grip = await page.locator("#col-grip").boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, cell.y + cell.height / 2);
        await page.mouse.down(); await page.mouse.move(grip.x + 35, cell.y + cell.height / 2, { steps: 8 }); await page.mouse.up();
        must(await page.locator("colgroup.tw col").count() === 8, "table-readiness", "Actual column drag did not store 8 proportions");
    }
}
async function hGeometry(page) {
    await page.addStyleTag({ content: `@media print {
      #main#main#main .doc::before { display:none !important }
      #main#main#main .block, #main#main#main .md, #main#main#main h1, #main#main#main p { margin:0 !important; padding:0 !important }
      #main#main#main [data-print-fixture="md-prn-spacer"] { height:258mm !important }
      #main#main#main h1 { font:14pt/6mm Arial !important }
      #main#main#main [data-print-fixture="md-prn-heading-body"] p { font:12pt/6mm "Courier New" !important; width:75mm !important }
    }` });
}

try {
    report.sourceHashesAtStart = sourceHashes();
    const { chromium } = await import("playwright-core");
    report.versions.playwright = JSON.parse(readFileSync(join(root, "node_modules", "playwright-core", "package.json"), "utf8")).version;
    report.versions.python = execFileSync(python, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
    report.versions.git = execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).trim();
    const prerequisite = spawnSync(python, ["-c", "import pymupdf; print(pymupdf.VersionBind)"], { encoding: "utf8", windowsHide: true });
    must(prerequisite.status === 0, "prerequisite", `PyMuPDF unavailable: ${prerequisite.stderr}`);
    report.versions.pymupdf = prerequisite.stdout.trim();
    browser = await chromium.launch({ channel: "msedge", headless: true });
    report.versions.edge = browser.version();
    context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: "reduce" });
    child = fork(join(root, "tools", "demos", "print-scenario.mjs"), ["--worker"], { cwd: root, windowsHide: true, silent: true,
        env: { ...process.env, PRINT_RUN_ROOT: out, PRINT_RUN_NONCE: nonce } });
    child.stdout.on("data", (chunk) => { workerLog += chunk; });
    child.stderr.on("data", (chunk) => { workerLog += chunk; });
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Print worker readiness timeout: ${workerLog}`)), 45000);
        child.on("message", (message) => {
            if (message?.type === "ready") { clearTimeout(timer); resolve(message); }
            else if (Number.isInteger(message?.id)) {
                const pending = waiters.get(message.id); waiters.delete(message.id);
                if (pending) message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.snapshot);
            }
        });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${workerLog}`)); });
    });
    info = await ready;
    must(Object.keys(TITLES).every((key) => typeof info.ids?.[key] === "string" && typeof info.urls?.[key] === "string") && /^[0-9a-f]{40}$/.test(info.head) && /^[0-9a-f]{40}$/.test(info.base), "worker", "Malformed readiness boundary");
    for (const name of Object.keys(TITLES)) {
        const url = new URL(info.urls[name]);
        must(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.searchParams.get("instance") === `browser-print-${name}` && url.searchParams.get("t"),
            "worker", `Nonlocal or malformed fixture URL for ${name}`);
        must(info.blockIds?.[name] && typeof info.blockIds[name] === "object" && !Array.isArray(info.blockIds[name]) &&
            Object.values(info.blockIds[name]).every((id) => typeof id === "string" && id.length > 0), "worker", `Malformed fixture ID map ${name}`);
    }
    must(new URL(info.hostUrl).origin === new URL(info.urls.ui).origin && new URL(info.hostUrl).searchParams.get("instance") === "print-host-ui", "worker", "Nonlocal host fixture URL");
    const readiness = await fetch(info.urls.long);
    must(readiness.ok && (await readiness.text()).includes('id="main"'), "http-readiness", "Real server not responsive");
    report.fixture = { ids: info.ids, base: info.base, head: info.head };

    await test("PR-TC08 single-page Doc prints 1/1 without changing screen or stored state", async () => {
        const page = await newPage("empty");
        try {
            await page.locator("#main > .doc").evaluate((doc) => {
                const literal = document.createElement("p");
                literal.textContent = "1/1";
                doc.append(literal);
            });
            const before = await rpc("snapshot"), screen = await screenState(page);
            const pdf = await capture(page, "numbered-single-a4");
            must(pdf.pageCount === 1, "page-numbers", `Expected single-page fixture, got ${pdf.pageCount}`);
            pageNumbers(pdf); bounds(pdf);
            must(count(fullText(pdf), "1/1") === 1, "page-numbers", "Body literal was discarded or margin footer leaked into prose");
            await page.emulateMedia({ media: "screen" });
            sameScreen(screen, await screenState(page));
            must(JSON.stringify(before) === JSON.stringify(await rpc("snapshot")), "persistent-state", "Numbering changed stored state");
        } finally { await page.close(); }
    });
    await test("PR-TC08 A4 and Letter number every sheet with the actual total", async () => {
        const page = await newPage("long");
        try {
            for (const format of ["A4", "Letter"]) {
                const pdf = await capture(page, `numbered-long-${format.toLowerCase()}`, { format });
                pageNumbers(pdf); longFlow(pdf);
            }
        } finally { await page.close(); }
    });
    for (const [name, content] of [["missing", "none"], ["repeated-current", '"1/" counter(pages)'], ["wrong-total", 'counter(page) "/1"']]) {
        await test(`PR-TC08 negative ${name} page footer is detected`, async () => {
            const page = await newPage("long");
            try {
                return await fault(page, `negative-page-number-${name}`,
                    `@media print { @page marginal-doc { @bottom-center { content: ${content}; } } }`, pageNumbers,
                    {}, (pdf) => { completeProse(pdf); finalParagraph(pdf); });
            } finally { await page.close(); }
        });
    }
    await test("PR-TC08 negative footer-only trailing sheet is still detected", async () => {
        const page = await newPage("long");
        try {
            return await fault(page, "negative-numbered-trailing-page",
                '@media print { #main > .doc[data-print-title]::after { content: ""; display: block; break-before: page; height: 1px; } }',
                longFlow, {}, pageNumbers);
        } finally { await page.close(); }
    });
    await test("PR-TC08 Home does not acquire Doc page footers", async () => {
        const page = await newPage("empty");
        try {
            await page.locator("#home").click();
            await page.waitForSelector('.home[data-state="current"]');
            const pdf = await capture(page, "unnumbered-home-a4");
            must(pdf.pages.every((sheet) => sheet.spans.every((span) =>
                span.bbox[1] <= sheet.height - margin || !/^\d+\/\d+$/.test(span.text.trim()))),
                "page-numbers", "Doc page numbering leaked onto Home");
        } finally {
            try {
                await page.emulateMedia({ media: "screen" });
                await page.getByText(TITLES.empty, { exact: true }).click();
                await page.waitForSelector(`.doc[data-print-title="${TITLES.empty}"]`);
            } finally { await page.close(); }
        }
    });

    await test("PR-TC01 A4 + Letter + scrolled full prose/title/folds/bounds and nonwrites", async () => {
        const page = await newPage("long");
        try {
            must(await page.locator("#main").evaluate((el) => el.scrollTop) === 0, "initial-scroll", "First PDF must start without scrolling");
            must(await page.locator('[data-print-fixture="sec-prn-folded"] > .section').evaluate((el) => el.classList.contains("collapsed")), "fold-readiness", "Outer fixture not folded");
            const before = await rpc("snapshot"), screen = await screenState(page);
            for (const format of ["A4", "Letter"]) longFlow(await capture(page, `long-light-${format.toLowerCase()}`, { format }));
            await page.emulateMedia({ media: "screen" });
            sameScreen(screen, await screenState(page));
            await page.evaluate(() => { const main = document.querySelector("#main"); main.scrollTop = main.scrollHeight; });
            longFlow(await capture(page, "long-light-a4-scrolled"));
            const after = await rpc("snapshot");
            must(JSON.stringify(before) === JSON.stringify(after), "persistent-state", "Print changed source/version/settings bytes or sent chat");
        } finally { await page.close(); }
    });
    await test("PR-TC01 negative disabled stylesheet fails completeness", async () => {
        const page = await newPage("long");
        try {
            await page.locator('link[href="print.css"]').evaluate((el) => { el.disabled = true; });
            const pdf = await capture(page, "negative-screen-layout", { control: true });
            let failure;
            try { finalParagraph(pdf); } catch (e) { failure = e; }
            must(failure?.oracle === "final-paragraph", "negative-control", "Original screen-layout PDF did not fail final-paragraph oracle");
            return { observedOracle: failure.oracle, observedFailure: failure.message, actualPages: pdf.pageCount };
        } finally { await page.close(); }
    });
    await test("PR-TC01 negative missing final despite multipage", async () => {
        const page = await newPage("long");
        try { return await fault(page, "negative-final", '@media print { #main#main#main [data-print-fixture="md-prn-final"] { display:none!important } }', finalParagraph, {}, (pdf) => { must(pdf.pageCount > 1, "control-isolation", "Control lost multipage"); completeProse(pdf); }); }
        finally { await page.close(); }
    });
    await test("PR-TC01 negative folded descendants", async () => {
        const page = await newPage("long");
        try { return await fault(page, "negative-fold", "@media print { #main#main#main .section.collapsed > .children { display:none!important } }", foldContent, {}, (pdf) => { completeProse(pdf); finalParagraph(pdf); }); }
        finally { await page.close(); }
    });
    await test("PR-TC01 negative intermediate sentence with all identifiers/end intact", async () => {
        const page = await newPage("long");
        try {
            await page.locator('[data-print-fixture="md-prn-p60"] p').evaluate((el, text) => { const at = el.textContent.indexOf(text) + text.length; el.textContent = el.textContent.slice(0, at) + el.textContent.slice(at).replace(text, ""); }, SENTENCE);
            const pdf = await capture(page, "negative-middle-sentence", { control: true });
            for (let n = 1; n <= 120; n++) includes(pdf, `PRN_P${String(n).padStart(3, "0")}`, "control-isolation");
            foldContent(pdf); finalParagraph(pdf);
            let failure; try { completeProse(pdf); } catch (e) { failure = e; }
            must(failure?.oracle === "complete-prose" && failure.message.includes("60"), "negative-control", "Middle prose control did not fail paragraph 60");
            return { observedOracle: failure.oracle, observedFailure: failure.message };
        } finally { await page.close(); }
    });

    await test("PR-TC03 heading boundary cohesion", async () => {
        const page = await newPage("heading");
        try { await hGeometry(page); heading(await capture(page, "heading-a4")); }
        finally { await page.close(); }
    });
    await test("PR-TC03 negative heading without keep-with-next", async () => {
        const page = await newPage("heading");
        try {
            await hGeometry(page);
            return await fault(page, "negative-heading", "@media print { #main#main#main :is(h1,.block,.md,p) { break-after:auto!important; break-before:auto!important; break-inside:auto!important } }", heading);
        } finally { await page.close(); }
    });
    await test("PR-TC03 all 360 code lines/wide token/captions/bounds", async () => {
        const page = await newPage("code");
        try { code(await capture(page, "code-a4")); }
        finally { await page.close(); }
    });
    await test("PR-TC03 negative wide code clipping", async () => {
        const page = await newPage("code");
        try { return await fault(page, "negative-wide-code", "@media print { #main#main#main .frame { overflow:hidden!important } #main#main#main .code { min-width:max-content!important; white-space:pre!important; overflow-wrap:normal!important; word-break:normal!important } }",
            (pdf) => { includes(pdf, WIDE, "wide-code"); bounds(pdf, "wide-code"); }); }
        finally { await page.close(); }
    });
    await test("PR-TC03 negative fixed code viewport", async () => {
        const page = await newPage("code");
        try { return await fault(page, "negative-code-height", "@media print { #main#main#main .frame-body { height:60mm!important; max-height:60mm!important; overflow:hidden!important } }", (pdf) => includes(pdf, "PRN_EMBED_180", "code-lines")); }
        finally { await page.close(); }
    });
    await test("PR-TC03 actual Git source Code then Diff/current identity/marks", async () => {
        const page = await newPage("source");
        try {
            const toggle = page.locator('[data-print-fixture="peek-prn-source"] .frame-head button');
            must(await toggle.isVisible(), "source-readiness", "Actual Code/Diff toggle missing");
            const markToggle = () => toggle.evaluate((button) => { const span = document.createElement("span"); span.textContent = " PRN_CHROME_SOURCE_TOGGLE"; button.append(span); });
            await markToggle();
            sourceCode(await capture(page, "source-code-a4"));
            await page.emulateMedia({ media: "screen" });
            await page.locator('[data-print-fixture="peek-prn-source"] .frame-head button', { hasText: "Diff" }).click();
            await page.waitForFunction(() => document.querySelector('[data-print-fixture="peek-prn-source"] .ln.del .t')?.textContent.includes("PRN_DIFF_OLD_ONLY") && document.querySelector('[data-print-fixture="peek-prn-source"] .ln.add .t')?.textContent.includes("PRN_DIFF_NEW_ONLY"));
            await markToggle();
            diffView(await capture(page, "source-diff-a4"));
        } finally { await page.close(); }
    });
    await test("PR-TC02 negative source citation loss independently detected", async () => {
        const page = await newPage("source");
        try { return await fault(page, "negative-citation", "@media print { #main#main#main .frame-head a { display:none!important } }", citation, {}, (pdf) => { includes(pdf, "PRN_SOURCE_END"); excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]); }); }
        finally { await page.close(); }
    });
    await test("PR-TC02 negative Diff old row loss with head/end retained", async () => {
        const page = await newPage("source");
        try {
            await page.locator('[data-print-fixture="peek-prn-source"] .frame-head button', { hasText: "Diff" }).click();
            await page.waitForSelector(".ln.del");
            return await fault(page, "negative-diff-old", "@media print { #main#main#main .ln.del { display:none!important } }", (pdf) => includes(pdf, "PRN_DIFF_OLD_ONLY", "current-diff-view"), {},
                (pdf) => { includes(pdf, "PRN_DIFF_NEW_ONLY"); includes(pdf, "PRN_SOURCE_END"); citation(pdf); excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]); });
        } finally { await page.close(); }
    });

    for (const mode of ["full", "wide", "text"]) await test(`PR-TC04 ${mode} table 800 cells/long row/header continuation/preferences`, async () => {
        const page = await newPage("table");
        try {
            await tableMode(page, mode, mode === "full");
            const before = await screenState(page), persisted = await rpc("snapshot");
            const pdf = await capture(page, `table-${mode}-a4`);
            tableCells(pdf); tableHeaders(pdf); excludes(pdf, ["PRN_CHROME_", "Drag a column", "Text width", "Full width"]);
            await page.emulateMedia({ media: "screen" }); sameScreen(before, await screenState(page));
            must(JSON.stringify(persisted) === JSON.stringify(await rpc("snapshot")), "persistent-state", "Table print changed persistent bytes");
        } finally { await page.close(); }
    });
    await test("PR-TC04 negative retained screen width/custom columns", async () => {
        const page = await newPage("table");
        try {
            await tableMode(page, "full", true);
            return await fault(page, "negative-table-width", "@media print { #main#main#main .md table { width:var(--tw)!important; max-width:none!important; margin-left:calc((100% - var(--tw))/2)!important } #main#main#main .md table col:first-child { width:40%!important } }",
                (pdf) => { includes(pdf, TABLE_WIDE, "table-right-edge"); bounds(pdf, "table-bounds"); });
        } finally { await page.close(); }
    });
    await test("PR-TC04 negative tall-row/late-cell clipping", async () => {
        const page = await newPage("table");
        try { return await fault(page, "negative-table-height", "@media print { #main#main#main [data-print-fixture=\"md-prn-table\"] { height:100mm!important; max-height:100mm!important; overflow:hidden!important } }",
            (pdf) => { includes(pdf, "PRN_TALL_ROW_END", "tall-row"); includes(pdf, "PRN_T100_C8", "table-cells"); }, {}, (pdf) => includes(pdf, "PRN_TABLE_END")); }
        finally { await page.close(); }
    });
    await test("PR-TC04 negative nonrepeating header", async () => {
        const page = await newPage("table");
        try { return await fault(page, "negative-table-header", "@media print { #main#main#main thead { display:table-row-group!important } }", tableHeaders); }
        finally { await page.close(); }
    });

    for (const inspected of [false, true]) await test(`PR-TC05 graphics ${inspected ? "Inspect" : "normal"} vectors/PNG/status/database`, async () => {
        const page = await newPage("graphics", { width: inspected ? 800 : 1400 });
        try {
            must(await page.locator("#main").evaluate((el) => el.scrollTop) === 0 && await page.locator("#main img").evaluate((el) => el.naturalWidth === 800 && el.loading === "eager"), "image-readiness", "Offscreen image was not ordinarily/eagerly loaded");
            must(await page.locator(".insp-btn").first().isVisible(), "chrome-readiness", "Actual diagram Inspect control missing");
            await page.locator(".insp-btn").evaluateAll((buttons) => buttons.forEach((button) => { const span = document.createElement("span"); span.textContent = " PRN_CHROME_INSPECT_BUTTON"; button.append(span); }));
            await page.locator(".db-cases button", { hasText: "PRN_DB_SELECTED" }).click();
            let inspectBefore = null;
            if (inspected) {
                await page.locator('[data-print-fixture="seq-prn-tall"] .insp-btn').click();
                await page.waitForSelector("#peek:not([hidden])");
                await page.waitForFunction(() => [...document.querySelectorAll(".block.inspecting [data-unit]")].some((e) => Number(getComputedStyle(e).opacity) < .9) &&
                    [...document.querySelectorAll(".block.inspecting")].some((e) => parseFloat(e.style.marginRight) > 0));
                inspectBefore = await page.locator(".block.inspecting").evaluate((el) => ({ inlineMargin: el.style.marginRight,
                    opacity: [...el.querySelectorAll("[data-unit]")].map((e) => getComputedStyle(e).opacity) }));
            }
            await page.evaluate(() => { document.querySelector("#main").scrollTop = 0; });
            const pdf = await capture(page, `graphics-${inspected ? "inspect" : "normal"}-a4`);
            const dims = await page.locator(".diagram svg").evaluateAll((svgs) => svgs.map((svg) => { const r = svg.getBoundingClientRect(), v = svg.viewBox.baseVal; return { width: r.width, height: r.height, ratio: v.width / v.height, opacity: [...svg.querySelectorAll("[data-unit]")].map((e) => getComputedStyle(e).opacity) }; }));
            for (const d of dims) must(Math.abs(d.width / d.height - d.ratio) < .02 && d.height <= 210 * 96 / 25.4 + 1 && d.opacity.every((o) => o === "1"), "graphic-fit", JSON.stringify(d));
            const db = await page.locator(".db-cases").evaluate((el) => [...el.querySelectorAll("button")].map((button) => {
                const s = getComputedStyle(button);
                return { selected: button.classList.contains("on"), display: s.display, background: s.backgroundColor, border: s.borderWidth };
            }));
            must(db.every((s) => s.selected ? s.display !== "none" && s.background === "rgba(0, 0, 0, 0)" && s.border === "0px" : s.display === "none"), "selected-database", "Database selector still has button-bar appearance");
            if (inspected) must(await page.locator(".block.inspecting").evaluate((el) => getComputedStyle(el).marginRight) === "0px", "graphic-fit", "Inspect inline shrink remains in print");
            const detail = { paintedSvgGeometry: dims, inspectBefore, printedDatabaseLabels: db };
            captures.at(-1).graphicsSupplement = detail;
            graphics(pdf);
            return detail;
        } finally { await page.close(); }
    });
    await test("PR-TC02 active Inspect does not emphasize actual PDF labels", async () => {
        const normalPdf = loadInspection(join(out, "graphics-normal-a4"));
        const inspectedPdf = loadInspection(join(out, "graphics-inspect-a4"));
        for (const token of ["PRN_SEQ_FIRST", "PRN_SEQ_LAST"]) {
            const normalSpan = locate(normalPdf, token).span, inspectedSpan = locate(inspectedPdf, token).span;
            must(typeof normalSpan.font === "string" && normalSpan.font.length > 0 &&
                normalSpan.font === inspectedSpan.font && Math.abs(normalSpan.size - inspectedSpan.size) < .01 && normalSpan.color === inspectedSpan.color,
            "inspect-emphasis", `${token}: normal ${normalSpan.font}/${normalSpan.size}/${normalSpan.color}; Inspect ${inspectedSpan.font}/${inspectedSpan.size}/${inspectedSpan.color}`);
        }
    });
    await test("PR-TC05 negative tall SVG height clipping", async () => {
        const page = await newPage("graphics");
        try { return await fault(page, "negative-tall-svg", '@media print { #main#main#main [data-print-fixture="seq-prn-tall"] .diagram { height:210mm!important; max-height:210mm!important; overflow:hidden!important } #main#main#main [data-print-fixture="seq-prn-tall"] svg { max-height:none!important; height:1200px!important; max-width:none!important } }',
            (pdf) => { includes(pdf, "PRN_SEQ_LAST", "graphic-fit"); bounds(pdf, "graphic-fit"); }); }
        finally { await page.close(); }
    });
    await test("PR-TC05 negative wide flow right-edge clipping", async () => {
        const page = await newPage("graphics");
        try { return await fault(page, "negative-wide-svg", '@media print { #main#main#main [data-print-fixture="flow-prn-wide"] .diagram { overflow:hidden!important } #main#main#main [data-print-fixture="flow-prn-wide"] svg { max-width:none!important; max-height:none!important; width:2000px!important; height:auto!important } }',
            (pdf) => { includes(pdf, "PRN_FLOW_LAST", "graphic-fit"); bounds(pdf, "graphic-fit"); }); }
        finally { await page.close(); }
    });
    await test("PR-TC05 negative hidden offscreen image despite caption/end", async () => {
        const page = await newPage("graphics");
        try { return await fault(page, "negative-image", "@media print { #main#main#main .img img { visibility:hidden!important } }", imageEdges, {},
            (pdf) => { includes(pdf, "PRN_IMAGE_CAPTION"); includes(pdf, "PRN_GRAPHICS_END"); must(pdf.pageCount > 1, "control-isolation", "Lost document pages"); }); }
        finally { await page.close(); }
    });
    await test("PR-TC05 negative active Inspect dimming", async () => {
        const page = await newPage("ui");
        try {
            await page.locator(".insp-btn").click(); await page.waitForSelector("#peek:not([hidden])");
            const before = await capture(page, "baseline-inspect-opacity", { control: true });
            must(["PRN_SMALL_1", "PRN_SMALL_2"].every((marker) => locate(before, marker).span.ink > 2), "control-prerequisite", "Inspect baseline already lacks dark raster ink");
            const style = await page.addStyleTag({ content: "@media print { #main#main#main .diagram [data-unit] { opacity:.15!important } }" });
            try {
                const pdf = await capture(page, "negative-inspect", { control: true });
                includes(pdf, "PRN_UI_END");
                const opacity = await page.locator(".diagram [data-unit]").evaluateAll((units) => units.map((e) => getComputedStyle(e).opacity));
                const inks = ["PRN_SMALL_1", "PRN_SMALL_2"].map((marker) => locate(pdf, marker).span.ink);
                let failure, rasterFailure;
                try { must(opacity.every((v) => v === "1"), "inspect-opacity", JSON.stringify(opacity)); } catch (e) { failure = e; }
                try { must(inks.every((n) => n > 2), "inspect-raster-ink", JSON.stringify(inks)); } catch (e) { rasterFailure = e; }
                must(failure?.oracle === "inspect-opacity" && rasterFailure?.oracle === "inspect-raster-ink", "negative-control", "Inspect dimming did not fail both opacity and actual-raster ink oracles");
                return { observedOracle: failure.oracle, observedRasterOracle: rasterFailure.oracle, actualRasterDarkInk: inks };
            } finally { await style.evaluate((e) => e.remove()); }
        } finally { await page.close(); }
    });
    await test("PR-TC02 negative selected database label loss", async () => {
        const page = await newPage("graphics");
        try {
            await page.locator(".db-cases button", { hasText: "PRN_DB_SELECTED" }).click();
            return await fault(page, "negative-db-label", "@media print { #main#main#main .db-cases .on { display:none!important } }", selectedDatabase, {},
                (pdf) => { includes(pdf, "PRN_GRAPHICS_END"); excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]); });
        } finally { await page.close(); }
    });
    await test("PR-TC02 negative stack status loss", async () => {
        const page = await newPage("graphics");
        try { return await fault(page, "negative-stack-status", "@media print { #main#main#main .stack .st { display:none!important } }", stackStatus, {},
            (pdf) => { includes(pdf, "PRN_GRAPHICS_END"); excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]); }); }
        finally { await page.close(); }
    });

    for (const theme of ["light", "dark", "solarized-light", "solarized-dark", "host-dark", "arcade", "win3"]) {
        for (const background of theme === "light" || theme === "dark" ? [false, true] : [false]) await test(`PR-TC02 ${theme} backgrounds ${background ? "on" : "off"} actual PDF/chrome/palette`, async () => {
            const page = await newPage("ui", { theme, host: theme === "host-dark" });
            try {
                await openChrome(page);
                if (theme === "arcade" || theme === "win3") must(await page.evaluate(() => document.documentElement.hasAttribute("data-effects")), "theme-readiness", "Retro effects not enabled");
                const pdf = await capture(page, `ui-${theme}-${background ? "backgrounds" : "no-backgrounds"}`, { background });
                includes(pdf, TITLES.ui); includes(pdf, "PRN_UI_END"); foldContent(pdf);
                excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]); paperRaster(pdf);
                const styles = await paperStyles(page);
                return { theme, background, styles };
            } finally { await page.close(); }
        });
    }
    for (const surface of ["settings", "jump", "gutter", "width-menu"]) await test(`PR-TC02 actual ${surface} chrome absent`, async () => {
        const page = await newPage(surface === "width-menu" ? "table" : "ui");
        try {
            let selector;
            if (surface === "settings") { await page.locator("#settings-btn").click(); selector = "#settings"; }
            if (surface === "jump") { await page.keyboard.press("Control+j"); selector = "#jump"; }
            if (surface === "gutter") { await page.locator('[data-print-fixture="md-prn-u1"] p').hover(); selector = "#gutter"; }
            if (surface === "width-menu") {
                await page.locator(".md table th").first().hover(); await page.waitForSelector("#g-width:not([hidden])"); await page.locator("#g-width").click(); selector = "#tw-menu";
            }
            await page.waitForSelector(`${selector}:not([hidden])`);
            await page.locator(selector).evaluate((el, text) => { const span = document.createElement("span"); span.textContent = text; el.append(span); }, `PRN_CHROME_${surface.toUpperCase().replace("-", "_")}`);
            must(await page.locator(selector).isVisible(), "chrome-readiness", `${surface} not visible`);
            const pdf = await capture(page, `chrome-${surface}`);
            excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]);
            must(!await page.locator(selector).isVisible(), "chrome-shapes", `${surface} still painted (including ancestor visibility)`);
        } finally { await page.close(); }
    });
    await test("PR-TC02 negative real outside-main chrome leakage", async () => {
        const page = await newPage("ui");
        try {
            await openChrome(page);
            return await fault(page, "negative-chrome", "@media print { html:has(#main>.doc[data-print-title]) body > #toc#toc, html:has(#main>.doc[data-print-title]) body > #chat#chat { display:block!important } }",
                (pdf) => excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]));
        } finally { await page.close(); }
    });
    await test("PR-TC02 negative missing retro paper overrides/backgrounds on", async () => {
        const page = await newPage("ui", { theme: "win3" });
        try {
            await openChrome(page);
            paperRaster(await capture(page, "baseline-retro-palette", { background: true, control: true }));
            await paperStyles(page);
            // Remove paper-color declarations from this page's real CSSOM only.
            // Geometry, content flow and outside-main hiding remain in force.
            const removed = await page.evaluate(() => {
                const link = document.querySelector('link[href="print.css"]');
                let count = 0;
                const walk = (rules) => {
                    for (const rule of rules) {
                        if (rule.style) for (const prop of [...rule.style]) if (/^--(?:bg|fg|muted|border|surface|blue|green|red|yellow|purple)|^(?:color|color-scheme|background(?:-.+)?|border-color|fill|stroke)$/.test(prop)) {
                            rule.style.removeProperty(prop); count++;
                        }
                        if (rule.cssRules) walk(rule.cssRules);
                    }
                };
                walk(link.sheet.cssRules);
                return count;
            });
            must(removed > 20, "control-prerequisite", "No actual paper-color overrides removed");
            const pdf = await capture(page, "negative-paper", { background: true, control: true });
            excludes(pdf, ["PRN_CHROME_", "PRN_CHAT_SECRET"]);
            let failure; try { paperRaster(pdf); } catch (e) { failure = e; }
            must(failure instanceof OracleError && ["paper-white", "paper-ink"].includes(failure.oracle), "negative-control", "Retro output did not fail paper ink/color oracle");
            return { observedOracle: failure.oracle, observedFailure: failure.message, removedColorDeclarations: removed, chromeStillAbsent: true };
        } finally { await page.close(); }
    });
    for (const width of [1400, 800]) for (const [name, theme] of [
        ["long", "light"], ["long", "dark"], ["table", "light"], ["table", "dark"],
        ["graphics", "light"], ["graphics", "dark"], ["graphics", "solarized-light"],
    ]) {
        await test(`PR-TC06 ${name}/${theme}/${width} real PDF screen/state restoration`, async () => {
            const page = await newPage(name, { width, theme });
            try {
                if (name === "table") await tableMode(page, "full", true);
                if (name === "long") {
                    const head = page.locator('[data-print-fixture="sec-prn-folded"] .section-head').first();
                    await head.click(); await head.click(); // establish an actual reader fold choice, not just the fixture default
                    await page.locator('[data-print-fixture="md-prn-p1"] p').click({ modifiers: ["Control"] });
                }
                if (name === "graphics") {
                    await page.locator(".db-cases button", { hasText: "PRN_DB_SELECTED" }).click();
                    await page.locator(".insp-btn").first().click(); await page.waitForSelector("#peek:not([hidden])");
                }
                await page.locator("#chat-btn").click(); await page.waitForSelector("#chat:not([hidden])");
                if (await page.locator("#toc-btn").isVisible()) await openContents(page);
                await page.evaluate(() => { document.querySelector("#main").scrollTop = 100; });
                await page.waitForTimeout(100);
                const before = await screenState(page), persisted = await rpc("snapshot");
                await page.screenshot({ path: join(out, `screen-${name}-${theme}-${width}-before.png`) });
                await capture(page, `state-${name}-${theme}-${width}`);
                await page.emulateMedia({ media: "screen" }); await page.waitForTimeout(100);
                sameScreen(before, await screenState(page));
                must(JSON.stringify(persisted) === JSON.stringify(await rpc("snapshot")), "persistent-state", "Print mutated model/version/settings/source bytes");
                await page.screenshot({ path: join(out, `screen-${name}-${theme}-${width}-after.png`) });
                await page.locator("#chat-close").click();
                must(!await page.locator("#chat").isVisible(), "post-print-controls", "Chat close stopped working");
                if (name === "long") {
                    const head = page.locator('[data-print-fixture="sec-prn-folded"] .section-head').first();
                    await head.click();
                    must(!await page.locator('[data-print-fixture="sec-prn-folded"] > .section').evaluate((el) => el.classList.contains("collapsed")), "post-print-controls", "Fold control stopped working");
                }
                if (name === "table") await tableMode(page, "text");
                if (name === "graphics") { await page.locator("#peek-close").click(); must(!await page.locator("#peek").isVisible(), "post-print-controls", "Inspect close stopped working"); }
            } finally { await page.close(); }
        });
    }
    await test("PR-TC06 negative leaked print rules on screen", async () => {
        const page = await newPage("ui");
        try {
            const before = await screenState(page);
            const style = await page.addStyleTag({ content: "html body { display:block!important; height:auto!important; overflow:visible!important; background:white!important;color:#1f2328!important } #main#main { overflow:visible!important;height:auto!important }" });
            try {
                let failure; try { sameScreen(before, await screenState(page)); } catch (e) { failure = e; }
                must(failure instanceof OracleError, "negative-control", "Screen leak oracle did not fail");
                return { observedOracle: failure.oracle, observedFailure: failure.message };
            } finally { await style.evaluate((e) => e.remove()); }
        } finally { await page.close(); }
    });
    await test("PR-TC06 negative print lifecycle expands screen fold", async () => {
        const page = await newPage("ui");
        try {
            const before = await screenState(page);
            await page.evaluate(() => { addEventListener("beforeprint", () => document.querySelector(".section.collapsed").classList.remove("collapsed"), { once: true }); });
            await capture(page, "negative-state-fold", { control: true });
            await page.emulateMedia({ media: "screen" });
            let failure; try { sameScreen(before, await screenState(page)); } catch (e) { failure = e; }
            must(failure?.oracle === "screen-state", "negative-control", "Fold state change was not detected");
            return { observedOracle: failure.oracle };
        } finally { await page.close(); }
    });
    await test("PR-TC06 negative print lifecycle rewrites table preference bytes", async () => {
        const page = await newPage("table");
        try {
            await tableMode(page, "full", true);
            const before = await screenState(page);
            await page.evaluate(() => { addEventListener("beforeprint", () => localStorage.setItem("marginal.tables", "{}"), { once: true }); });
            await capture(page, "negative-state-table", { control: true }); await page.emulateMedia({ media: "screen" });
            let failure; try { sameScreen(before, await screenState(page)); } catch (e) { failure = e; }
            must(failure?.oracle === "screen-state", "negative-control", "Preference-byte change was not detected");
            await page.evaluate((value) => localStorage.setItem("marginal.tables", value), before.storage["marginal.tables"]);
            return { observedOracle: failure.oracle };
        } finally { await page.close(); }
    });
    await test("PR-TC07 empty document retains real message/title", async () => {
        const page = await newPage("empty");
        try {
            const pdf = await capture(page, "empty-a4");
            includes(pdf, TITLES.empty); must(pdf.pages.some((p) => /empty|nothing|no blocks|start/i.test(p.text)), "empty-document", "Existing empty-document message missing");
        } finally { await page.close(); }
    });
    await test("PR-TC07 negative withheld PDF extractor is not skipped", async () => {
        const first = captures[0];
        must(!!first, "prerequisite", "No real PDF available for extractor control");
        const run = spawnSync(python, ["-S", helper, "--pdf", join(out, first.pdf), "--out", join(scratch, "missing-module")],
            { cwd: root, windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONPATH: "" }, timeout: 30000 });
        must(run.status !== 0 && /ModuleNotFoundError.*pymupdf/s.test(run.stderr), "negative-control", `Expected actual missing-module failure, got ${run.status}: ${run.stderr}`);
        return { status: run.status, observedFailure: run.stderr.trim() };
    });
    await test("PR-TC07 negative missing/empty actual PDF/raster/report fails evidence", async () => {
        const first = captures[0];
        must(!!first, "prerequisite", "No inspection available for missing-evidence control");
        const dir = dirname(join(out, first.inspection)), inspected = loadInspection(dir), raster = join(dir, inspected.pages[0].raster);
        const moved = join(scratch, "withheld-raster.png");
        renameSync(raster, moved);
        let failure;
        try { loadInspection(dir); } catch (e) { failure = e; }
        finally { renameSync(moved, raster); }
        must(failure?.oracle === "evidence", "negative-control", "Missing raster did not fail evidence validation");
        const json = join(dir, "inspection.json"), saved = join(scratch, "withheld-inspection.json");
        renameSync(json, saved); let reportFailure;
        try { loadInspection(dir); } catch (e) { reportFailure = e; } finally { renameSync(saved, json); }
        must(reportFailure?.oracle === "evidence", "negative-control", "Missing report did not fail evidence validation");
        const pdfPath = join(out, first.pdf), savedPdf = join(scratch, "withheld-actual.pdf");
        renameSync(pdfPath, savedPdf); let pdfFailure, emptyFailure;
        try {
            try { loadInspection(dir); } catch (e) { pdfFailure = e; }
            writeFileSync(pdfPath, "");
            try { loadInspection(dir); } catch (e) { emptyFailure = e; }
        } finally { rmSync(pdfPath, { force: true }); renameSync(savedPdf, pdfPath); }
        must(pdfFailure?.oracle === "evidence" && emptyFailure?.oracle === "evidence", "negative-control", "Missing/empty actual PDF did not fail evidence validation");
        return { observedOracle: failure.oracle, rasterFailure: failure.message, reportFailure: reportFailure.message, pdfFailure: pdfFailure.message, emptyPdfFailure: emptyFailure.message };
    });
    await test("PR-TC07 retained evidence is nonempty and complete", async () => {
        must(captures.length >= 25, "evidence", `Only ${captures.length} acceptance captures`);
        for (const item of captures) { const pdf = loadInspection(dirname(join(out, item.inspection))); must(hash(join(out, item.pdf)) === item.sha256 && pdf.pageCount === item.pages, "evidence", `Changed evidence ${item.name}`); }
        must(errors.length === 0, "browser-errors", JSON.stringify(errors));
        must(requests.every((r) => !/\/ask(?:\/|$)|\/edit(?:\/|$)|\/restore(?:\/|$)/.test(r.path)), "no-print-mutations", JSON.stringify(requests));
    });
} catch (error) {
    results.push({ name: "Required prerequisites and harness execution", ok: false, oracle: error.oracle ?? "execution", error: error.stack });
    console.error(error.stack);
} finally {
    if (context) await context.close().catch((e) => errors.push({ cleanup: e.message }));
    if (browser) await browser.close().catch((e) => errors.push({ cleanup: e.message }));
    if (child) {
        if (child.connected) child.send({ id: ++rpcId, op: "close" });
        if (child.exitCode === null) await new Promise((done) => {
            const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000);
            const deadline = setTimeout(() => { errors.push({ cleanup: `Owned worker ${child.pid} did not exit after termination` }); done(); }, 10000);
            child.once("exit", () => { clearTimeout(killTimer); clearTimeout(deadline); done(); });
        });
    }
    report.cleanup = { browserDisconnected: !browser?.isConnected(), workerPid: child?.pid ?? null,
        workerExitCode: child?.exitCode ?? null, workerSignal: child?.signalCode ?? null, workerDisconnected: !child?.connected,
        runtimeScratch: relative(out, runtimeScratch) };
    report.finished = new Date().toISOString();
    report.workerLog = workerLog;
    report.sourceHashes = sourceHashes();
    if (report.sourceHashesAtStart && JSON.stringify(report.sourceHashesAtStart) !== JSON.stringify(report.sourceHashes))
        results.push({ name: "PR-TC07 exact source revision remained stable during proof", ok: false, oracle: "source-revision", error: "Source changed during the run; rerun the integrated revision." });
    report.ok = results.length > 0 && results.every((r) => r.ok) && errors.length === 0;
    report.summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
    if (readFileSync(join(out, ".print-owner"), "utf8") === nonce) {
        rmSync(join(out, "owned"), { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
        rmSync(join(out, ".print-owner"));
    }
    writeFileSync(join(out, "inventory.json"), JSON.stringify(readdirSync(out, { recursive: true }).filter((p) => statSync(join(out, p)).isFile()).map((p) => ({ path: p, bytes: statSync(join(out, p)).size, sha256: hash(join(out, p)) })), null, 2));
    console.log(JSON.stringify({ ok: report.ok, ...report.summary, out }));
    process.exitCode = report.ok ? 0 : 1;
}
