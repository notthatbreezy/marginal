// Records the README demo animations headlessly (nothing takes focus) into docs/images/demo-*.webp.
//   npm i --no-save playwright-core sharp gifenc pngjs
//   node tools/demos/record.mjs [docs-comment] [docs-inspect] [command] [stills] [readme] [--gif] [--sheet] [--out=dir]
//   readme: the README's stills (doc.png, command-center.png, walkthrough.png, guided-tour.png)
// Doc demos run a private server over a COPY of your Marginal data (MARGINAL_DATA_DIR in a temp dir) with a canned
// chat, so nothing reaches a real Copilot session. They use DEMO_DOC, which must exist in your data and whose repo
// must be registered; the Command demo uses tools/devserver.mjs's fictional "relay" repo and needs nothing.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createCannedChat } from "./canned-chat.mjs";
import { createRecorder, overlayScript } from "./recorder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const out = argv.find((a) => a.startsWith("--out="))?.slice(6) ?? join(root, "docs", "images");
const picked = argv.filter((a) => !a.startsWith("--"));
const want = (name) => !picked.length || picked.includes(name);
const ext = flag("gif") ? "gif" : "webp";
const W = 1040;
const H = 700;
const DEMO_DOC = process.env.DEMO_DOC ?? "marginal-document-first-markdown-review--973c";
const theme = readFileSync(join(here, "host-theme.css"), "utf8");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? "msedge", headless: true });
const temps = [];
let lastPage = null;

async function newPage(url, ready, size = { width: W, height: H }, { toc = false } = {}) {
    const page = await browser.newPage({ viewport: size });
    page.on("pageerror", (e) => console.error("page error:", e.message));
    await page.addInitScript(({ css, toc }) => {
        localStorage.setItem("marginal.toc", toc ? "open" : "closed"); // keep recordings about the feature they show
        addEventListener("DOMContentLoaded", () => {
            document.documentElement.dataset.colorMode = "light";
            const st = document.createElement("style");
            st.textContent = css;
            document.head.prepend(st);
        });
    }, { css: theme, toc });
    await page.addInitScript(overlayScript);
    lastPage = page;
    await page.goto(url);
    await page.waitForSelector(ready, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    return page;
}

async function finish(rec, name) {
    const file = join(out, `demo-${name}.${ext}`);
    const r = await rec.save(file);
    console.log(`${name}: ${r.frames} frames, ${r.seconds.toFixed(1)}s, ${(r.bytes / 1024).toFixed(0)} KB → ${file}`);
    if (flag("sheet")) await rec.sheet(join(out, `demo-${name}.sheet.png`));
}

// ---------------------------------------------------------------- doc demos: private server + canned chat
let docServer = null;
async function docs() {
    if (docServer) return docServer;
    const src = process.env.MARGINAL_DATA_DIR ?? join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "marginal");
    if (!existsSync(join(src, "docs", DEMO_DOC))) throw new Error(`demo doc ${DEMO_DOC} not found in ${src}`);
    const tmp = mkdtempSync(join(tmpdir(), "wb-demo-"));
    temps.push(tmp);
    cpSync(src, join(tmp, "data"), { recursive: true });
    if (process.env.DEMO_HEAD_REF) {
        // Display label only (pins are commit SHAs): keep personal branch names out of the recording.
        const cur = join(tmp, "data", "docs", DEMO_DOC, "current.json");
        const doc = JSON.parse(readFileSync(cur, "utf8"));
        doc.target.headRef = process.env.DEMO_HEAD_REF;
        writeFileSync(cur, JSON.stringify(doc, null, 2));
    }
    process.env.MARGINAL_DATA_DIR = join(tmp, "data");
    process.env.MARGINAL_NO_BROWSER = "1";
    const store = await import("../../extensions/marginal/lib/store.mjs");
    const { startServer } = await import("../../extensions/marginal/lib/server.mjs");
    const chat = createCannedChat({
        reply: (m) => {
            if (/return|example/i.test(m.prompt))
                return {
                    statuses: ["Reading src/server.ts"],
                    text: "`startViewer()` resolves to a small handle: the panel's `url` (loopback origin plus the random prefix), `refresh()` to re-push a snapshot, and an idempotent `close()`. I added it to this step as a note, with the code.",
                    after: () =>
                        store.applyEdit(DEMO_DOC, {
                            type: "update",
                            targetId: "step-6",
                            changes: {
                                notes: [
                                    {
                                        title: "What it returns",
                                        text: "The extension keeps this handle per panel instance and hands `url` back to the host:",
                                        code: { language: "ts", text: 'const viewer = await startViewer(options);\nviewer.url;      // "http://127.0.0.1:52817/3f9c…e1/"\nviewer.refresh(); // push a fresh snapshot\nawait viewer.close(); // idempotent' },
                                    },
                                    { title: "The return statement", source: { file: "src/server.ts", startLine: 210, endLine: 226 } },
                                ],
                            },
                        }),
                };
            return {
                statuses: ["Reading src/server.ts"],
                text: "Different scopes. The `Host`/`Origin` check runs on **every** request, before routing. The re-read only happens on `send`: right before dispatch the file is read again and the selection re-resolved, so an edit made after you selected can't slip a stale quote through.",
            };
        },
    });
    const instances = new Map([["demo", { documentId: DEMO_DOC }]]);
    instances.save = () => {};
    const s = await startServer({ chat, instances, getSessionId: () => "demo" });
    docServer = { url: s.urlFor("demo"), store };
    return docServer;
}

async function docsComment() {
    const { url } = await docs();
    const page = await newPage(url, `#main .block[data-id="md-2"] .md [data-l]`);
    const rec = await createRecorder(page, { width: W, height: H });
    const units = page.locator(`#main .block[data-id="md-2"] .md [data-l]`);
    await rec.frame(900);
    await rec.caption("Hover any paragraph, list item or diagram part");
    await rec.move(units.nth(0), { offset: { x: -120, y: 0 } });
    await page.waitForTimeout(250);
    await rec.frame(1100);
    await rec.caption("Ctrl-click to select several", "Ctrl");
    await rec.click(units.nth(2), { modifiers: ["Control"], offset: { x: -160, y: 0 } });
    await rec.frame(500);
    await rec.click(units.nth(3), { modifiers: ["Control"], offset: { x: -200, y: 0 } });
    await rec.frame(1200);
    await rec.caption("Comment on the whole selection");
    await rec.click(page.locator("#multi-comment"));
    await rec.frame(1300);
    await rec.caption("Ask Copilot — the highlight and the location stay visible");
    await rec.type("Do both checks run on every request?", { perFrame: 4 });
    await rec.frame(500);
    await rec.click(page.locator("#chat-send"), { settle: 150 });
    await rec.caption("The reply streams in");
    await rec.watch(async () => (await page.locator("#chat-log .msg.assistant, #chat-log .assistant").count()) > 0 && !(await page.locator("#chat .pulse, #chat .working").count()), { frameMs: 120 });
    await rec.frame(2600);
    await rec.caption("Minimize to keep reading; the conversation stays");
    await rec.click(page.locator("#chat-min"));
    await rec.frame(1500);
    await rec.click(page.locator("#chat-bar"), { offset: { x: -20, y: 0 } });
    await rec.frame(1200);
    await rec.caption("Code links open the exact lines at the doc's commit");
    await rec.click(page.locator("#chat-close"));
    await page.keyboard.press("Escape");
    await rec.click(units.nth(1).locator("a").first());
    await rec.frame(2600);
    await rec.caption("");
    await rec.frame(600);
    await finish(rec, "docs-comment");
    await page.close();
}

// Inspect needs room beside the panel for the doc to move over, so this one records wider.
const WIDE = { width: 1680, height: 860 };
async function docsInspect() {
    const { url } = await docs();
    const page = await newPage(url, `#main .block[data-id="seq-4"] .insp-btn`, WIDE);
    const rec = await createRecorder(page, WIDE);
    await rec.captionAt("left"); // the chat and the panel own the bottom right
    await page.locator(`#main .block[data-id="seq-4"]`).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(400);
    await rec.frame(1300);
    await rec.caption("Click any step in a diagram to inspect it");
    await rec.frame(900);
    await rec.click(page.locator(`#main .block[data-id="seq-4"] .msg[data-unit="step-6"]`), { settle: 900 });
    await rec.frame(1600);
    await rec.caption("Every step, with its code, beside the diagram; the doc moves over");
    await rec.frame(2600);
    await rec.caption("Scroll the steps and the diagram follows");
    await rec.move({ x: WIDE.width - 380, y: 420 });
    for (let k = 0; k < 8; k++) {
        await page.mouse.wheel(0, 150);
        await page.waitForTimeout(140);
        await rec.frame(240);
    }
    await rec.frame(1800);
    await rec.caption("Or step with the arrow keys", "↓");
    await rec.key("ArrowDown", { settle: 900 });
    await rec.frame(1700);
    await rec.key("ArrowDown", { settle: 900 });
    await rec.frame(1700);
    await rec.caption("Click the diagram to jump back to a step");
    await rec.click(page.locator(`#main .block[data-id="seq-4"] .msg[data-unit="step-6"]`), { settle: 900 });
    await rec.frame(1800);
    await rec.caption("Step text has the doc's margin controls: comment, copy, Ctrl-click");
    await rec.move(page.locator('.insp-step[data-i="1"] .step-text [data-pk]').first(), { offset: { x: -120, y: 0 } });
    await page.waitForTimeout(300);
    await rec.frame(2000);
    await rec.click(page.locator("#g-comment"), { settle: 500 });
    await rec.frame(1600);
    await rec.type("What does startViewer return? Add an example.", { perFrame: 4 });
    await rec.frame(900);
    await rec.click(page.locator("#chat-send"), { settle: 150 });
    await rec.caption("Ask for an example and Copilot adds it to the step");
    await rec.watch(async () => (await page.locator('.insp-step[data-i="1"] .step-note').count()) > 0, { max: 20_000, frameMs: 120 });
    await page.waitForTimeout(700);
    await rec.frame(3400);
    await rec.caption("Esc closes the chat, then the panel; the doc moves back", "Esc");
    await rec.key("Escape", { settle: 500 });
    await rec.frame(1300);
    await rec.key("Escape", { settle: 700 });
    await rec.frame(1600);
    await rec.caption("");
    await rec.frame(500);
    await finish(rec, "docs-inspect");
    await page.close();
}

/** README stills: Inspect on a sequence diagram and on a call-stack diff. */
async function stills() {
    const { url } = await docs();
    const page = await newPage(url, `#main .block[data-id="seq-4"] .insp-btn`, WIDE);
    await page.addStyleTag({ content: "#demo-cursor,#demo-caption{display:none!important}" });
    await page.locator(`#main .block[data-id="seq-4"] .msg[data-unit="step-7"]`).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, "inspect-sequence.png") });
    await page.locator(`#main .block[data-id="stack-31"] .fr`).nth(2).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, "inspect-call-stack.png") });
    console.log(`stills → ${join(out, "inspect-sequence.png")}, inspect-call-stack.png`);
    await page.close();
}

// ---------------------------------------------------------------- the fixture devserver (Command tab)
async function devserver(flags) {
    const proc = spawn(process.execPath, [join(root, "tools", "devserver.mjs"), ...flags, "--seconds=240"], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    proc.info = await new Promise((resolve, reject) => {
        let buf = "";
        proc.stdout.on("data", (x) => {
            buf += x;
            const line = buf.split("\n").find((l) => l.startsWith("{"));
            if (line) resolve(JSON.parse(line));
        });
        proc.on("exit", (c) => reject(new Error(`devserver exited ${c}`)));
        setTimeout(() => reject(new Error("devserver did not start")), 90_000);
    });
    temps.push(proc.info.tmp);
    return proc;
}

// ---------------------------------------------------------------- README stills
async function readme() {
    const SIZE = { width: 1440, height: 900 };
    const hide = "#demo-cursor,#demo-caption{display:none!important}";
    const { url } = await docs();
    const doc = await newPage(url, "#main .block", { width: 1280, height: 800 }, { toc: true });
    await doc.addStyleTag({ content: hide });
    await doc.screenshot({ path: join(out, "doc.png") });
    await doc.close();
    const dev = await devserver(["--single", "--progress", "--walk"]);
    try {
        const t0 = Date.now();
        const page = await newPage(`${dev.info.url}&tab=command`, ".cc .map-head", SIZE);
        await page.addStyleTag({ content: hide });
        await page.evaluate(() => localStorage.setItem("marginal.cc.tourSeen", "1"));
        // The walkthrough the devserver shows.
        await page.waitForSelector(".cc .walk", { timeout: 15_000 });
        await page.waitForTimeout(1500);
        await page.mouse.move(2, 896); // off every control, so nothing shows a hover state
        await page.screenshot({ path: join(out, "walkthrough.png") });
        await page.locator(".cc .walk .tour-close").click();
        await page.waitForTimeout(400);
        if (await page.locator(".cc .tour-nudge-x").isVisible()) await page.locator(".cc .tour-nudge-x").click();
        // Mid-run: phases, progress in the strip and on the cards, helper lanes (about 20 s into the progress script).
        const wait = 21_000 - (Date.now() - t0);
        if (wait > 0) await page.waitForTimeout(wait);
        await page.mouse.move(2, 896);
        await page.screenshot({ path: join(out, "command-center.png") });
        await tourStill(page, /phase/i, join(out, "guided-tour.png"));
        console.log(`readme stills → ${out}: doc.png, walkthrough.png, command-center.png, guided-tour.png`);
        await page.close();
    } finally {
        dev.kill();
    }
}
/** Open the Command tour and step to the first stop whose title matches. */
async function tourStill(page, title, file) {
    await page.locator(".cc .tour-help").click();
    await page.waitForSelector("#guide-title", { timeout: 10_000 });
    await page.waitForTimeout(700);
    for (let i = 0; i < 14; i++) {
        const t = await page.evaluate(() => document.querySelector("#guide-title")?.textContent ?? "");
        if (title.test(t)) break;
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(450);
    }
    await page.waitForTimeout(600);
    await page.screenshot({ path: file });
}

// ---------------------------------------------------------------- Command center demo: fixture devserver
async function command() {
    const dev = await devserver(["--single", "--progress", "--edits", "--walk", "--canned-chat"]);
    const info = dev.info;
    try {
        const page = await newPage(`${info.url}&tab=command`, ".cc .map-head");
        const rec = await createRecorder(page, { width: W, height: H });
        await page.evaluate(() => localStorage.setItem("marginal.cc.tourSeen", "1"));
        if (await page.locator(".cc .walk .tour-close").count()) await page.locator(".cc .walk .tour-close").click();
        if (await page.locator(".cc .tour-nudge-x").count()) await page.locator(".cc .tour-nudge-x").click();
        await page.waitForTimeout(600);
        await rec.caption("The plan's phases, and what the orchestrator is doing now");
        await rec.frame(1600);
        await rec.caption("Live: edits light up the file map as the work happens");
        await rec.watch(async () => false, { max: 3000, every: 260, frameMs: 260 });
        await rec.caption("The orchestrator explains what a phase delivered with a walkthrough");
        await rec.click(page.locator(".cc .walk-reopen"), { settle: 500 });
        await rec.frame(900);
        await rec.click(page.locator(".cc .walk-menu .wm-open").first(), { settle: 700 });
        await rec.frame(1800);
        for (let k = 0; k < 3; k++) {
            await rec.caption(k ? "" : "Each stop zooms the map to the code it's about", k ? undefined : "→");
            await rec.key("ArrowRight", { settle: 700 });
            await rec.frame(k === 2 ? 1400 : 2000);
        }
        await rec.caption("Ask the orchestrator from any stop");
        await rec.click(page.locator("#chat-text"));
        await rec.type("Why requeue instead of sleeping?", { perFrame: 4 });
        await rec.frame(400);
        await rec.click(page.locator("#chat-send"), { settle: 150 });
        await rec.caption("");
        await rec.watch(async () => (await page.evaluate(() => document.querySelector("#chat-log")?.textContent ?? "")).includes("survives restarts"), { max: 20_000, frameMs: 120 });
        await rec.frame(3200);
        await finish(rec, "command");
        await page.close();
    } finally {
        dev.kill();
    }
}

try {
    if (want("docs-comment")) await docsComment();
    if (want("docs-inspect")) await docsInspect();
    if (want("command")) await command();
    if (want("stills")) await stills();
    if (want("readme")) await readme();
} catch (e) {
    console.error(e);
    await lastPage?.screenshot({ path: join(out, "demo-failure.png") }).catch(() => {});
    process.exitCode = 1;
} finally {
    await browser.close();
    for (const t of temps) rmSync(t, { recursive: true, force: true, maxRetries: 3 });
    process.exit(process.exitCode ?? 0);
}
