// Records the README demo animations headlessly (nothing takes focus) into docs/images/demo-*.webp.
//   npm i --no-save playwright-core sharp gifenc pngjs
//   node tools/demos/record.mjs [docs-comment] [docs-tour] [command] [--gif] [--sheet] [--out=dir]
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

async function newPage(url, ready) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on("pageerror", (e) => console.error("page error:", e.message));
    await page.addInitScript(({ css }) => {
        addEventListener("DOMContentLoaded", () => {
            document.documentElement.dataset.colorMode = "light";
            const st = document.createElement("style");
            st.textContent = css;
            document.head.prepend(st);
        });
    }, { css: theme });
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

async function docsTour() {
    const { url } = await docs();
    const page = await newPage(url, `#main .block[data-id="seq-4"] .tour-btn`);
    const rec = await createRecorder(page, { width: W, height: H });
    await page.locator(`#main .block[data-id="seq-4"]`).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(400);
    await rec.frame(1200);
    await rec.caption("Diagrams have a guided tour");
    await rec.click(page.locator(`#main .block[data-id="seq-4"] .tour-btn`), { settle: 600 });
    await rec.frame(1400);
    await rec.caption("Each step shows its code, with notes and examples");
    await page.locator(".stepper .tour-note").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(250);
    await rec.frame(2400);
    await rec.caption("Step through with the arrow keys", "→");
    await rec.key("ArrowRight", { settle: 450 });
    await rec.frame(1600);
    await rec.caption("One chat for the whole tour, docked under the diagram");
    await rec.click(page.locator("#chat-text"));
    await rec.type("What does startViewer return? Add an example.", { perFrame: 4 });
    await rec.frame(500);
    await rec.click(page.locator("#chat-send"), { settle: 150 });
    await rec.caption("Ask for an example — Copilot adds it to the step");
    await rec.watch(async () => (await page.locator(".tour-note").count()) > 0, { max: 20_000, frameMs: 120 });
    await page.waitForTimeout(500);
    await rec.frame(1200);
    await rec.caption("The example now lives on the step, for everyone who takes the tour");
    await page.locator(".stepper .tour-note").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(250);
    await rec.frame(3200);
    await rec.caption("");
    await rec.key("Escape", { settle: 400 });
    await rec.frame(800);
    await finish(rec, "docs-tour");
    await page.close();
}

// ---------------------------------------------------------------- Command center demo: fixture devserver
async function command() {
    const dev = spawn(process.execPath, [join(root, "tools", "devserver.mjs"), "--edits", "--walk", "--canned-chat", "--seconds=240"], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    try {
        const info = await new Promise((resolve, reject) => {
            let buf = "";
            dev.stdout.on("data", (x) => {
                buf += x;
                const line = buf.split("\n").find((l) => l.startsWith("{"));
                if (line) resolve(JSON.parse(line));
            });
            dev.on("exit", (c) => reject(new Error(`devserver exited ${c}`)));
            setTimeout(() => reject(new Error("devserver did not start")), 90_000);
        });
        temps.push(info.tmp);
        const page = await newPage(`${info.url}&tab=command`, ".cc .map-head");
        const rec = await createRecorder(page, { width: W, height: H });
        await page.evaluate(() => localStorage.setItem("marginal.cc.tourSeen", "1"));
        if (await page.locator(".cc .walk .tour-close").count()) await page.locator(".cc .walk .tour-close").click();
        if (await page.locator(".cc .tour-nudge-x").count()) await page.locator(".cc .tour-nudge-x").click();
        await page.waitForTimeout(600);
        await rec.caption("The plan, and every front working on it");
        await rec.frame(1400);
        await rec.caption("Live: each front's edits light up the file map");
        await rec.watch(async () => false, { max: 3000, every: 260, frameMs: 260 });
        await rec.caption("The orchestrator explains each checkpoint with a walkthrough");
        await rec.click(page.locator(".cc .walk-reopen"), { settle: 700 });
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
    if (want("docs-tour")) await docsTour();
    if (want("command")) await command();
} catch (e) {
    console.error(e);
    await lastPage?.screenshot({ path: join(out, "demo-failure.png") }).catch(() => {});
    process.exitCode = 1;
} finally {
    await browser.close();
    for (const t of temps) rmSync(t, { recursive: true, force: true, maxRetries: 3 });
    process.exit(process.exitCode ?? 0);
}
