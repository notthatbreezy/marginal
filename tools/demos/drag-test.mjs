// Drags the chat window around real pages headlessly (nothing takes focus) and checks it moves anywhere in the
// viewable area: the bar follows the pointer exactly, a drag never changes the window's size, every edge and corner
// is reachable, and a smaller viewport brings the whole window back into view.
//   npm i --no-save playwright-core
//   node tools/demos/drag-test.mjs [--out=file.json]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
const SIZES = [[1500, 900], [1280, 720], [1366, 600], [900, 700], [700, 900]];

async function devserver(flags) {
    const p = spawn(process.execPath, [join(root, "tools", "devserver.mjs"), "--single", "--seconds=300", ...flags], { windowsHide: true, env: { ...process.env, APP_MESSAGE_MS: "999999" } });
    p.info = await new Promise((res, rej) => {
        let s = "";
        p.stdout.on("data", (x) => {
            s += x;
            const m = s.match(/\{.*\}/s);
            if (m) try { res(JSON.parse(m[0])); } catch {}
        });
        p.on("exit", rej);
    });
    return p;
}

const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? "msedge", headless: true });
const rows = [];
let failures = 0;
for (const [label, flags] of [["empty chat", ["--canned-chat"]], ["full chat", ["--transcript"]]]) {
    const dev = await devserver(flags);
    for (const tab of ["board", "command"])
        for (const scale of [1, 1.5])
            for (const [vw, vh] of SIZES) {
                const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: scale });
                const page = await ctx.newPage();
                await page.goto(`${dev.info.url}&tab=${tab}`);
                await page.waitForTimeout(1500);
                if (await page.locator("#chat").isHidden()) await page.keyboard.press("Control+i");
                await page.waitForSelector("#chat:not([hidden])");
                await page.waitForTimeout(700);
                const box = async () => {
                    const r = await page.locator("#chat").boundingBox();
                    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                };
                const drag = async (dx, dy) => {
                    const bar = await page.locator("#chat-bar").boundingBox();
                    const sx = bar.x + 60;
                    const sy = bar.y + bar.height / 2;
                    await page.mouse.move(sx, sy);
                    await page.mouse.down();
                    for (let i = 1; i <= 10; i++) await page.mouse.move(sx + (dx * i) / 10, sy + (dy * i) / 10);
                    await page.mouse.up();
                    await page.waitForTimeout(80);
                };
                const problems = [];
                let b = await box();
                // Steps: the window moves with the pointer (clamped at the edges) and keeps its size.
                for (const [dx, dy] of [[0, -150], [0, -150], [0, 120], [0, 120], [-300, 0], [250, 0]]) {
                    await drag(dx, dy);
                    const n = await box();
                    const want = { x: Math.max(0, Math.min(b.x + dx, vw - b.w)), y: Math.max(0, Math.min(b.y + dy, vh - b.h)) };
                    if (n.w !== b.w || n.h !== b.h) problems.push(`size ${b.w}×${b.h} → ${n.w}×${n.h} on a drag of ${dx},${dy}`);
                    if (Math.abs(n.x - want.x) > 1 || Math.abs(n.y - want.y) > 1) problems.push(`drag ${dx},${dy} moved it to ${n.x},${n.y}, expected ${want.x},${want.y}`);
                    b = n;
                }
                // Every edge and corner, and the window never leaves the viewport.
                const corners = [];
                for (const [tx, ty, name] of [[-3000, -3000, "top-left"], [3000, -3000, "top-right"], [3000, 3000, "bottom-right"], [-3000, 3000, "bottom-left"]]) {
                    await drag(tx, ty);
                    const n = await box();
                    const ok = (n.x === 0 || n.x === vw - n.w) && (n.y === 0 || n.y === vh - n.h) && n.x >= 0 && n.y >= 0 && n.x + n.w <= vw && n.y + n.h <= vh;
                    corners.push(ok);
                    if (!ok) problems.push(`${name}: at ${n.x},${n.y} (${n.w}×${n.h})`);
                }
                // A smaller viewport: the whole window comes back into view.
                await page.setViewportSize({ width: Math.round(vw * 0.6), height: Math.round(vh * 0.6) });
                await page.waitForTimeout(250);
                const s = await box();
                const inView = s.x >= 0 && s.y >= 0 && s.x + s.w <= Math.round(vw * 0.6) + 1 && s.y + s.h <= Math.round(vh * 0.6) + 1;
                if (!inView) problems.push(`after shrinking to ${Math.round(vw * 0.6)}×${Math.round(vh * 0.6)}: at ${s.x},${s.y} ${s.w}×${s.h}`);
                const row = { chat: label, tab: tab === "board" ? "Doc" : "Command", size: `${vw}×${vh}`, scale, window: `${b.w}×${b.h}`, followsPointer: !problems.some((p) => p.startsWith("drag") || p.startsWith("size")), corners: corners.filter(Boolean).length, afterShrink: inView, ok: !problems.length, problems };
                if (!row.ok) failures++;
                rows.push(row);
                await ctx.close();
            }
    dev.kill();
}
await browser.close();
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.chat.padEnd(10)} ${r.tab.padEnd(8)} ${r.size.padEnd(9)} ×${r.scale}  ${r.window.padEnd(8)} corners ${r.corners}/4${r.problems.length ? `  ${r.problems.join("; ")}` : ""}`);
console.log(`${rows.length - failures}/${rows.length} passed`);
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
process.exit(failures ? 1 : 0);
