// Synthetic page-management demos over the real server/UI; never reads personal Marginal data.
// $env:PYTHONPATH=(Resolve-Path artifacts\print-tools\python).Path
// node tools\demos\record-pages.mjs [--out=docs\images]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { fixture, page as document } from "../../test/fixtures/pages.mjs";
import { createRecorder, overlayScript } from "./recorder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every((arg) => arg.startsWith("--out=")), "Usage: record-pages.mjs [--out=directory]");
const out = resolve(root, args[0]?.slice(6) ?? join("docs", "images"));
const evidence = join(root, "artifacts", "pages-recording", String(Date.now()));
mkdirSync(out, { recursive: true });
mkdirSync(evidence, { recursive: true });

const reference = '<copilot-ref kind="session" target-id="release-helper" label="Build helper" />';
const final = "END OF EDITOR UPDATE CHECKLIST";
const sections = ["Prepare the update", "Keep a rollback path", "Update the editor", "Check extensions",
    "Verify the workspace", "Review language services", "Check debugging", "Check terminal workflows",
    "Share the rollout", "Retain the checklist"];
const guide = sections.map((title, i) => `## ${i + 1}. ${title}

Start with a small workspace, note its current editor version, and keep the previous installer available. Compare the same files before and after the update so a changed setting is easy to spot.

Use the team's ordinary commands to check completion, navigation, debugging, and the integrated terminal. Record a short result for each check. A successful rollout ends with a working editor and a clear way to repeat these checks next time.
`).join("\n");
const data = fixture([
    document("editor-upgrade", {
        title: "Updating VSCode", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z",
        content: [{ id: "md-1", type: "markdown", markdown: `# Editor update guide

A fictional rollout, coordinated with ${reference}.

Literal examples stay code: \`${reference}\`

${guide}

## Final check

${final}` }],
    }),
    document("rollout-notes", {
        title: "Editor rollout notes", createdAt: "2026-10-10T10:00:00.000Z", updatedAt: "2026-10-29T10:00:00.000Z",
        content: [{ id: "md-1", type: "markdown", markdown: "Notes on updating VSCode across the team. Start with a small pilot." }],
    }),
    document("rollback-guide", {
        title: "VSCode rollback checklist", createdAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-24T10:00:00.000Z",
        content: [{ id: "md-1", type: "markdown", markdown: "Before updating the editor, save the previous VSCode installer and workspace settings." }],
    }),
    document("maintenance", {
        title: "Database maintenance", updatedAt: "2026-10-28T10:00:00.000Z",
        content: [{ id: "md-1", type: "markdown", markdown: "A separate fictional maintenance checklist." }],
    }),
    document("old-rollout", {
        title: "Previous editor rollout", updatedAt: "2026-09-15T10:00:00.000Z", archivedAt: "2026-10-02T10:00:00.000Z",
        content: [{ id: "md-1", type: "markdown", markdown: "Previous notes on updating VSCode, retained in the archive." }],
    }),
]);
process.env.MARGINAL_DATA_DIR = data.root;
process.env.MARGINAL_NO_BROWSER = "1";
const { startServer } = await import("../../extensions/marginal/lib/server.mjs");
const { createCannedChat } = await import("./canned-chat.mjs");
const store = await import("../../extensions/marginal/lib/store.mjs");
const chat = createCannedChat({ reply: () => ({ text: "This demonstration uses fictional pages." }) });
chat.seed([{ id: "release-demo-message", type: "assistant.message", timestamp: "2026-10-29T10:00:00.000Z",
    data: { messageId: "release-demo-reply", content: `I've sent the rollout checklist to ${reference}. The editor update is ready to review.` } }]);
const instances = new Map([["browser-pages-recording", { documentId: null }]]);
instances.save = () => {};
let server, browser, context, page;
const errors = [], recordings = [];
const width = 1120, height = 760;
async function rows(ids) {
    await page.waitForFunction((ids) => document.querySelector(".home")?.dataset.state === "current" &&
        JSON.stringify([...document.querySelectorAll("#pages-results .card")].map((el) => el.dataset.documentId)) === JSON.stringify(ids), ids);
}
async function still(name) {
    await page.evaluate(() => { window.__demo.caption(""); window.__demo.hide(true); });
    await page.screenshot({ path: join(out, `${name}.png`) });
    await page.evaluate(() => window.__demo.hide(false));
}
async function choose(rec, selector, value, ids, caption) {
    await rec.move(page.locator(selector));
    await page.locator(selector).selectOption(value);
    await rows(ids);
    await rec.caption(caption);
    await rec.frame(1900);
}
async function theme(value) {
    await page.locator("#settings-btn").click();
    await page.locator(`.set-theme[data-t="${value}"]`).click();
    await page.locator('[aria-label="Close settings"]').click();
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, value);
}
async function finish(rec, name) {
    const result = await rec.save(join(out, `${name}.gif`));
    await rec.sheet(join(evidence, `${name}.sheet.png`));
    recordings.push({ name, ...result });
    console.log(JSON.stringify({ name, ...result }));
}
try {
    server = await startServer({ chat, transcript: chat.transcript, instances, getSessionId: () => "synthetic-release-demo" });
    browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? "msedge", headless: true });
    context = await browser.newContext({ viewport: { width, height }, timezoneId: "UTC", reducedMotion: "reduce" });
    const url = server.urlFor("browser-pages-recording"), origin = new URL(url).origin;
    await context.route("**/*", (route) => {
        const request = new URL(route.request().url());
        return request.protocol === "http:" && request.origin === origin ? route.continue() : route.abort();
    });
    await context.addInitScript(overlayScript);
    await context.addInitScript(() => localStorage.setItem("marginal.toc", "closed"));
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await rows(["rollout-notes", "maintenance", "rollback-guide", "editor-upgrade"]);
    await theme("light");
    const search = await createRecorder(page, { width, height });
    await search.caption("Find pages by their titles and authored content");
    await search.frame(1600);
    await search.click(page.locator("#pages-query"));
    await search.type("updating VSCode");
    await rows(["editor-upgrade", "rollout-notes", "rollback-guide"]);
    assert.equal(await page.locator("#pages-sort").inputValue(), "relevance");
    await search.caption("Relevance puts the title match first");
    await search.frame(2400);
    await still("pages");
    await choose(search, "#pages-sort", "updated-desc", ["rollout-notes", "rollback-guide", "editor-upgrade"], "Sort matching pages by their last update");
    await choose(search, "#pages-sort", "created-desc", ["rollback-guide", "rollout-notes", "editor-upgrade"], "Or show the most recently created first");
    await search.move(page.locator("#pages-from"));
    await page.locator("#pages-from").fill("2026-10-25");
    await rows(["rollout-notes"]);
    await search.caption("Combine search with an Updated date range");
    await search.frame(2400);
    await finish(search, "demo-pages-search");

    await page.locator("#pages-from").fill("");
    await page.locator("#pages-sort").selectOption("relevance");
    await rows(["editor-upgrade", "rollout-notes", "rollback-guide"]);
    const archive = await createRecorder(page, { width, height });
    const before = structuredClone(store.getDoc("editor-upgrade"));
    await archive.caption("Archive a page to keep Active focused");
    await archive.frame(1700);
    await archive.click(page.locator('[data-document-id="editor-upgrade"] .page-archive'));
    await rows(["rollout-notes", "rollback-guide"]);
    await archive.frame(1700);
    await choose(archive, "#pages-scope", "archived", ["editor-upgrade", "old-rollout"], "Archived pages stay searchable and editable");
    assert.ok(store.getDoc("editor-upgrade").archivedAt);
    await archive.click(page.locator('[data-document-id="editor-upgrade"] .page-archive'));
    await rows(["old-rollout"]);
    await archive.caption("Unarchive brings it back, with its dates intact");
    await archive.frame(1700);
    await choose(archive, "#pages-scope", "active", ["editor-upgrade", "rollout-notes", "rollback-guide"], "Back in Active, with the same search");
    for (const key of ["createdAt", "updatedAt", "content"]) assert.deepEqual(store.getDoc("editor-upgrade")[key], before[key]);
    assert.equal(store.getDoc("editor-upgrade").archivedAt, null);
    await finish(archive, "demo-pages-archive");

    await page.locator('[data-document-id="editor-upgrade"] .page-open').click();
    await page.waitForSelector("#main .session-ref");
    assert.ok((await page.locator("#main code").first().innerText()).includes("<copilot-ref"));
    await theme("solarized-light");
    await still("solarized-light");
    await theme("solarized-dark");
    await still("solarized-dark");
    await theme("light");
    await page.locator("#chat-btn").click();
    await page.waitForSelector("#chat .session-ref");
    await still("session-references");
    await page.locator("#chat-close").click();

    const pdf = join(evidence, "pages.pdf"), inspectionDir = join(evidence, "pdf");
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: pdf, format: "A4", displayHeaderFooter: false, printBackground: false,
        margin: { top: "15mm", right: "15mm", bottom: "15mm", left: "15mm" } });
    const extraction = spawnSync(process.env.PRINT_PYTHON ?? "python",
        [join(root, "test", "fixtures", "print-pdf.py"), "--pdf", pdf, "--out", inspectionDir],
        { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180000 });
    assert.equal(extraction.error, undefined);
    assert.equal(extraction.status, 0, extraction.stderr);
    const print = JSON.parse(readFileSync(join(inspectionDir, "inspection.json"), "utf8"));
    assert.ok(print.schema === 1 && Number.isInteger(print.pageCount) && print.pageCount > 1 &&
        Array.isArray(print.pages) && print.pages.length === print.pageCount);
    assert.ok(print.pages.at(-1).text.includes(final));
    for (const [i, sheet] of print.pages.entries()) {
        assert.match(sheet.raster, /^page-\d{3}\.png$/);
        assert.equal(sheet.spans.filter((span) => span.text.trim() === `${i + 1}/${print.pageCount}` &&
            span.bbox[1] > sheet.height - 15 * 72 / 25.4).length, 1);
    }
    await page.emulateMedia({ media: "screen" });
    await page.setViewportSize({ width: 1440, height: 980 });
    const sheets = print.pages.map((sheet, i) => `<figure><figcaption>Page ${i + 1} of ${print.pageCount}</figcaption>
        <img src="data:image/png;base64,${readFileSync(join(inspectionDir, sheet.raster)).toString("base64")}"></figure>`).join("");
    await page.setContent(`<!doctype html><meta charset="utf-8"><title>Actual Marginal PDF output</title>
        <style>body{margin:0;padding:28px 32px;background:#f3f4f6;color:#1f2328;font:16px Arial,sans-serif}
        h1{font-size:28px;margin:0 0 8px}p{margin:0 0 24px}main{display:flex;gap:24px;justify-content:center}
        figure{margin:0;flex:1;max-width:420px}figcaption{text-align:center;margin:0 0 12px;font-weight:bold}
        img{display:block;width:100%;box-shadow:0 3px 14px #0002}</style>
        <h1>The complete Doc, across ${print.pageCount} numbered pages</h1>
        <p>Actual browser Save as PDF output, including the final checklist and centered X/Y footers.</p><main>${sheets}</main>`);
    await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
    await page.screenshot({ path: join(out, "print-pages.png") });
    assert.deepEqual(errors, []);
    writeFileSync(join(evidence, "recording.json"), JSON.stringify({ syntheticOnly: true, browser: browser.version(),
        recordings, printPages: print.pageCount, pageErrors: errors }, null, 2));
    console.log(`Screenshots and GIFs: ${out}\nActual PDF and contact sheets: ${evidence}`);
} finally {
    try { await browser?.close(); }
    finally {
        try {
            if (server) {
                server.server.closeAllConnections();
                await new Promise((resolve, reject) => server.server.close((error) => error ? reject(error) : resolve()));
            }
        } finally { data.close(); }
    }
}
