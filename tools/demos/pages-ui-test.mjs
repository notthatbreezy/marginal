// Direct, real headless browser proof. No private demo data or production test endpoints.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { canonicalPages, fixture, page as document, PHRASE } from "../../test/fixtures/pages.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(root, "artifacts", "pages-ui");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? "msedge", headless: true });
let assertions = 0, cases = 0;
const R = '<copilot-ref kind="session" target-id="synthetic-session-1" label="Build &amp; helper" />';
const EXACT = "Before <copilot-ref  kind='session'   target-id='synthetic-session-1'  label='Build  &amp;  helper' /> between <copilot-ref label=\"Build  &amp;  helper\"   target-id=\"synthetic-session-2\" kind=\"session\"  /> after";
const principal = ["a-title-phrase","b-body-phrase","c-body-phrase","k-equal-phrase","d-title-separated","e-title-one","f-cross-fields","g-body-reversed"];
const initial = ["i-history-only","h-one-token","f-cross-fields","g-body-reversed","e-title-one","d-title-separated","c-body-phrase","k-equal-phrase","b-body-phrase","a-title-phrase"];
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
async function probe(data) {
    const child = spawn(process.execPath, ["--experimental-loader", new URL("../../test/fixtures/pages-loader.mjs", import.meta.url).href, fileURLToPath(new URL("./pages-scenario.mjs", import.meta.url))], {
        cwd: root, env: { ...process.env, MARGINAL_DATA_DIR: data.root, MARGINAL_NO_BROWSER: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    const waiting = new Map(); let seq = 0, errors = "";
    child.stderr.on("data", (chunk) => errors += chunk);
    child.stdout.on("data", (chunk) => errors += chunk);
    const ready = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("message", (message) => {
            if (message.ready) return resolve();
            const pending = waiting.get(message.id);
            if (!pending) return;
            waiting.delete(message.id); clearTimeout(pending.timer);
            message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
        });
        child.on("exit", (code) => {
            if (code) reject(new Error(errors));
            for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Worker exited ${code}: ${errors}`)); }
        });
    });
    const call = (op, args = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Fixture ${op} timed out: ${errors}`)); child.kill(); }, 30_000);
        waiting.set(id, { resolve, reject, timer });
        child.send({ id, op, ...args });
    });
    await ready; await call("init");
    return { call, close: async () => {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        await call("close"); eq(await exited, 0, errors);
    } };
}
async function current(page) { await page.waitForSelector('.home[data-state="current"]'); }
async function rows(page, expected) {
    await page.waitForFunction((wanted) => document.querySelector(".home")?.dataset.state === "current" &&
        JSON.stringify([...document.querySelectorAll("#pages-results .card")].map((el) => el.dataset.documentId)) === JSON.stringify(wanted), expected);
    eq(await page.locator("#pages-results .card").evaluateAll((els) => els.map((el) => el.dataset.documentId)), expected);
}
async function withPage(name, docs, run, options = {}) {
    if (process.env.PAGES_CASE && !name.includes(process.env.PAGES_CASE)) return;
    const data = fixture(docs, options.fixture);
    let worker, context, page;
    try {
        worker = await probe(data);
        context = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce", timezoneId: options.timezone ?? "UTC", colorScheme: options.colorScheme ?? "light" });
        const opened = await worker.call("open");
        const origins = new Set([new URL(opened.url).origin]);
        await context.route("**/*", (route) => {
            const url = new URL(route.request().url());
            return url.protocol === "http:" && !origins.has(url.origin) || url.protocol === "https:" ? route.abort() : route.continue();
        });
        if(options.sourceGuardOff)await context.route("**/edit.js",async route=>{
            const response=await route.fetch(),source=await response.text();
            const guard='closest("code, [data-ref-source]")';eq(source.split(guard).length,2);
            await route.fulfill({response,body:source.replace(guard,'closest("code")')});
        });
        page = await context.newPage();
        page.setDefaultTimeout(15_000);
        await page.goto(opened.url);
        await current(page);
        await run({ page, context, worker, data, url: opened.url, restart:async()=>{
            await worker.close();worker=await probe(data);
            origins.add(new URL((await worker.call("open",{instance:"browser-fixture-restart"})).url).origin);
            return worker;
        } });
        cases++; console.log(`PASS ${name}`);
    } catch (error) {
        console.error(name, await page?.evaluate(() => {
            const p=document.querySelector(".b-markdown .md > p"),r=p?.getBoundingClientRect();
            return { state: document.querySelector(".home")?.dataset.state, status: document.querySelector("#pages-status")?.textContent, ids: [...document.querySelectorAll("#pages-results .card")].map((el) => el.dataset.documentId), hovered: document.querySelector(".unit-hover")?.outerHTML, prose:p?.outerHTML,hit:r&&document.elementFromPoint(r.x+10,r.y+10)?.outerHTML,gutter: document.querySelector("#gutter")?.outerHTML, editing: !!document.querySelector(".editing") };
        }).catch(() => null));
        if (page) await shot(page, `failed-${cases}`).catch(() => {});
        error.message = `${name}: ${error.message}`; throw error;
    }
    finally { await context?.close(); await worker?.close(); data.close(); }
}
async function query(page, text, expected) { await page.locator("#pages-query").fill(text); await rows(page, expected); }
async function select(page, id, value) { await page.locator(`#pages-${id}`).selectOption(value); await current(page); }
async function hold(page, predicate, failure) {
    let release, arrived;
    const gate = new Promise((resolve) => release = resolve), seen = new Promise((resolve) => arrived = resolve);
    let captured = false, request;
    const handler = async (route) => {
        if (captured || !predicate(new URL(route.request().url()))) return route.continue();
        captured = true; request = route.request();
        const response = await route.fetch();
        arrived();
        await gate;
        if (failure === "network") await route.abort();
        else if (failure) await route.fulfill({ status: failure, contentType: "application/json", body: '{"error":"synthetic denied"}' });
        else await route.fulfill({ response });
    };
    await page.route("**/api/catalog?**", handler);
    return { seen, release: async () => {
        const done=page.waitForEvent(failure==="network"?"requestfailed":"requestfinished",{predicate:item=>item===request});
        release();await done;
        await page.evaluate(()=>new Promise(requestAnimationFrame));
    }, remove: () => page.unroute("**/api/catalog?**", handler) };
}
async function shot(page,name){
    await page.locator("#settings:not([hidden]),#chat:not([hidden]),#peek:not([hidden])").evaluateAll(els=>Promise.all(els.flatMap(el=>el.getAnimations({subtree:true})).filter(animation=>animation.effect.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
    if(name.includes("settings"))await page.locator(".set-body").evaluateAll(els=>els.forEach(el=>el.scrollTop=0));
    return page.screenshot({path:join(out,`${name}.png`),fullPage:false});
}

try {
    await withPage("TC12 actual Home composition/archive/unarchive/return", canonicalPages(), async ({ page, worker }) => {
        await rows(page, initial);
        await query(page, PHRASE, principal);
        await select(page, "sort", "created-asc");
        await rows(page, ["a-title-phrase","f-cross-fields","g-body-reversed","d-title-separated","c-body-phrase","k-equal-phrase","e-title-one","b-body-phrase"]);
        await query(page, "", ["a-title-phrase","f-cross-fields","g-body-reversed","d-title-separated","c-body-phrase","k-equal-phrase","e-title-one","b-body-phrase","h-one-token","i-history-only"]);
        eq(await page.locator("#pages-sort").inputValue(), "created-asc");
        await query(page, PHRASE, ["a-title-phrase","f-cross-fields","g-body-reversed","d-title-separated","c-body-phrase","k-equal-phrase","e-title-one","b-body-phrase"]);
        await select(page, "sort", "relevance"); await rows(page, principal);
        await page.locator("#pages-from").fill("2026-10-01");
        await page.locator("#pages-through").fill("2026-10-31"); await rows(page, principal);
        const requests = [];
        page.on("request", (request) => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
        const before = await worker.call("read", { documentId: principal[0] });
        await page.locator(`[data-document-id="${principal[0]}"] .page-archive`).click();
        await rows(page, principal.slice(1));
        eq(requests.filter((path) => path.includes("/show")), []);
        eq(requests.filter((path) => path.endsWith("/archive")).length, 1);
        await select(page, "scope", "archived"); await rows(page, ["j-archived", principal[0]]);
        await page.locator(`[data-document-id="${principal[0]}"]`).getByRole("button", { name: /^Unarchive/ }).click();
        await rows(page, ["j-archived"]);
        eq(requests.filter((path) => path.endsWith("/unarchive")).length, 1);
        eq(requests.filter((path) => path.includes("/show")), []);
        await select(page, "scope", "active"); await rows(page, principal);
        const after = await worker.call("read", { documentId: principal[0] });
        eq([after.createdAt, after.updatedAt], [before.createdAt, before.updatedAt]);
        eq(await page.locator("#pages-from").inputValue(), "2026-10-01");
        eq(await page.locator("#pages-through").inputValue(), "2026-10-31");
        await page.locator('[data-document-id="c-body-phrase"] .page-open').click();
        await page.waitForSelector(".block.b-markdown");
        await page.locator("#home").click(); await rows(page, principal);
        eq(await page.locator("#pages-query").inputValue(), PHRASE);
        await query(page, "", initial); eq(await page.locator("#pages-sort").inputValue(), "updated-desc");
    });

    for (const [name, docs, scope, text, message] of [
        ["E0", [], "active", "", "No pages yet."],
        ["E0-all", [], "all", "", "No pages yet."],
        ["E0-archived", [], "archived", "", "No pages yet."],
        ["E1", [document("empty-j", { archivedAt: "2026-10-14T10:00:00.000Z" })], "active", "", "No active pages."],
        ["E2", [document("empty-a")], "archived", "", "No archived pages."],
        ["E3", [document("empty-a")], "active", "missingword", "No pages match this query or date range."],
    ]) await withPage(`TC12 actual empty classification ${name}`, docs, async ({ page }) => {
        await select(page, "scope", scope);
        if (text) await page.locator("#pages-query").fill(text);
        await rows(page, []);
        eq(await page.locator("#pages-status").innerText(), message);
        eq(await page.locator("#pages-scratchpad .card").count(), 1);
        if(name==="E1"){await select(page,"scope","archived");await rows(page,["empty-j"]);}
        if(name==="E2"){await select(page,"scope","active");await rows(page,["empty-a"]);}
        if(name==="E3"){await query(page,"",["empty-a"]);}
    });

    await withPage("TC12 range-only empty and independent information read",[document("empty-a")],async({page})=>{
        const reads=[];page.on("request",request=>{if(request.url().includes("/api/catalog?"))reads.push(new URL(request.url()));});
        await select(page,"sort","created-asc");await rows(page,["empty-a"]);
        eq(reads.some(url=>url.searchParams.get("status")==="all"),false);
        await page.locator("#pages-from").fill("2026-10-06");await page.locator("#pages-through").fill("2026-10-06");await rows(page,[]);
        assert.match(await page.locator("#pages-status").innerText(),/No pages match/);
        const all=reads.filter(url=>url.searchParams.get("status")==="all");assert.ok(all.length);
        eq(all.every(url=>url.searchParams.toString()==="status=all"),true);
        eq(await page.locator("#pages-results .card").count(),0);
        await page.locator("#pages-from").fill("");await page.locator("#pages-through").fill("");await rows(page,["empty-a"]);
    });
    for(const action of ["archive","unarchive"])await withPage(`TC12 rejected actual ${action} retains state and retries`,[
        document("action-page",action==="unarchive"?{archivedAt:"2026-10-14T10:00:00.000Z"}:{}),
    ],async({page,worker})=>{
        if(action==="unarchive")await select(page,"scope","archived");
        await query(page,PHRASE,["action-page"]);await page.locator("#pages-from").fill("2026-10-01");await rows(page,["action-page"]);
        const before=await worker.call("read",{documentId:"action-page"}),url=page.url();
        const handler=route=>route.fulfill({status:403,contentType:"application/json",body:'{"error":"synthetic action denial"}'});
        await page.route(`**/api/docs/action-page/${action}`,handler);
        await page.locator('[data-document-id="action-page"] .page-archive').click();
        await page.getByRole("alert").waitFor();await rows(page,["action-page"]);
        assert.match(await page.getByRole("alert").innerText(),/Couldn't.*synthetic action denial/);
        eq(await worker.call("read",{documentId:"action-page"}),before);eq(page.url(),url);
        eq([await page.locator("#pages-query").inputValue(),await page.locator("#pages-from").inputValue(),await page.locator("#pages-sort").inputValue()],[PHRASE,"2026-10-01","relevance"]);
        await page.unroute(`**/api/docs/action-page/${action}`,handler);
        await page.getByRole("button",{name:"Retry action",exact:true}).click();await rows(page,[]);
        const after=await worker.call("read",{documentId:"action-page"});
        eq([after.createdAt,after.updatedAt],[before.createdAt,before.updatedAt]);
        eq(!!after.archivedAt,action==="archive");
    });
    for(const failure of [403,"network"])await withPage(`TC14 current primary ${failure} previous provenance and retry`,canonicalPages(),async({page})=>{
        const blocked=await hold(page,url=>url.searchParams.get("query")===PHRASE,failure);
        await page.locator("#pages-query").fill(PHRASE);await blocked.seen;await blocked.release();
        await page.waitForSelector('.home[data-state="error"]');
        assert.match(await page.locator("#pages-status").innerText(),/Couldn't load pages.*Previous results/);
        eq(await page.locator("#pages-results").getAttribute("data-previous"),"true");
        eq(await page.locator("#pages-results .card").evaluateAll(els=>els.map(el=>el.dataset.documentId)),initial);
        await blocked.remove();await page.getByRole("button",{name:"Retry",exact:true}).click();await rows(page,principal);
    });
    for(const change of ["status","date"])for(const failure of [undefined,403])await withPage(`TC14 primary ${change} stale ${failure??"success"}`,canonicalPages(),async({page})=>{
        const blocked=await hold(page,url=>url.searchParams.get("query")===PHRASE,failure);
        await page.locator("#pages-query").fill(PHRASE);await blocked.seen;
        if(change==="status"){await select(page,"scope","archived");await rows(page,["j-archived"]);}
        else{await page.locator("#pages-from").fill("2026-10-07");await page.locator("#pages-through").fill("2026-10-09");await rows(page,["c-body-phrase","k-equal-phrase","d-title-separated","e-title-one"]);}
        await blocked.release();await blocked.remove();
        await rows(page,change==="status"?["j-archived"]:["c-body-phrase","k-equal-phrase","d-title-separated","e-title-one"]);
    });

    await withPage("TC14 primary success/failure/invalid/deactivation and SSE focus", canonicalPages(), async ({ page, worker }) => {
        const old = await hold(page, (url) => url.searchParams.get("query") === "updating");
        await page.locator("#pages-query").fill("updating"); await old.seen;
        await query(page, PHRASE, principal);
        await old.release(); await old.remove();
        await rows(page, principal);
        await page.locator("#pages-query").evaluate((el) => { el.focus(); el.setSelectionRange(2, 5); });
        await worker.call("rename", { documentId: "h-one-token", title: PHRASE });
        await rows(page, ["h-one-token",...principal]);
        eq(await page.locator("#pages-query").evaluate((el) => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true,2,5]);
        const stale = await hold(page, (url) => url.searchParams.get("query") === "missingword", 403);
        await page.locator("#pages-query").fill("missingword"); await stale.seen;
        await page.locator("#pages-from").fill("2026-10-20");
        await page.locator("#pages-through").fill("2026-10-01");
        await page.waitForSelector('.home[data-state="invalid-input"]');
        await stale.release(); await stale.remove();
        eq(await page.locator(".home").getAttribute("data-state"), "invalid-input");
        await page.locator("#pages-from").fill(""); await page.locator("#pages-through").fill("");
        await query(page, PHRASE, ["h-one-token",...principal]);
        const pending = await hold(page, (url) => url.searchParams.get("query") === "updating");
        await page.locator("#pages-query").fill("updating"); await pending.seen;
        await page.locator('[data-document-id="a-title-phrase"] .page-open').click();
        await page.waitForSelector(".block.b-markdown");
        await pending.release(); await pending.remove();
        eq(await page.locator(".home").count(), 0);
    });

    for (const failure of [undefined, 403, "network"]) await withPage(`TC12/14 support pending/error/stale ${failure ?? "success"}`, [document("empty-a")], async ({ page, worker }) => {
        const blocked = await hold(page, (url) => url.searchParams.size === 1 && url.searchParams.get("status") === "all", failure);
        await page.locator("#pages-query").fill("missingword"); await blocked.seen;
        await page.waitForSelector('.home[data-state="pending-classification"]');
        assert.match(await page.locator("#pages-status").innerText(), /Checking collection/);
        await page.locator("#pages-query").evaluate((el) => { el.focus(); el.setSelectionRange(1,4); });
        await worker.call("edit", { documentId: "empty-a", text: "missingword",at:"2026-10-15T10:00:00.000Z" });
        await rows(page, ["empty-a"]);
        eq(await page.locator("#pages-query").evaluate((el) => [document.activeElement === el,el.selectionStart,el.selectionEnd]), [true,1,4]);
        await blocked.release(); await blocked.remove(); await rows(page, ["empty-a"]);
    });

    for (const failure of [403, "network"]) await withPage(`TC12 current supporting ${failure} with retry`, [document("empty-a")], async ({ page }) => {
        const blocked = await hold(page, (url) => url.searchParams.size === 1 && url.searchParams.get("status") === "all", failure);
        await page.locator("#pages-query").fill("missingword"); await blocked.seen; await blocked.release();
        await page.waitForSelector('.home[data-state="error"]');
        assert.match(await page.locator("#pages-status").innerText(), /Classification unavailable.*Previous results/);
        eq(await page.locator("#pages-results").getAttribute("data-previous"), "true");
        await blocked.remove();
        await page.locator("#pages-status").getByRole("button", { name: "Retry", exact: true }).click();
        await rows(page, []); assert.match(await page.locator("#pages-status").innerText(), /No pages match/);
    });
    for(const change of ["archive","status","date","invalid","deactivate"])for(const failure of [undefined,403])await withPage(`TC14 supporting ${change} stale ${failure??"success"}`,[document("empty-a")],async({page,worker})=>{
        const blocked=await hold(page,url=>url.searchParams.toString()==="status=all",failure);
        await page.locator("#pages-query").fill("missingword");await blocked.seen;
        if(change==="archive"){
            await worker.call("archive",{documentId:"empty-a"});await rows(page,[]);
            assert.match(await page.locator("#pages-status").innerText(),/^No active pages/);
        }else if(change==="status"){
            await select(page,"scope","archived");await rows(page,[]);assert.match(await page.locator("#pages-status").innerText(),/^No archived pages/);
        }else if(change==="date"){
            await page.locator("#pages-from").fill("2026-10-06");await rows(page,[]);
        }else if(change==="invalid"){
            await page.locator("#pages-from").evaluate(el=>{el.type="text";el.value="2026-02-30";el.dispatchEvent(new Event("input",{bubbles:true}));});
            await page.waitForSelector('.home[data-state="invalid-input"]');
        }else{
            await page.locator('[data-document-id="empty-a"] .page-open').click();await page.waitForSelector(".block.b-markdown");
        }
        const state=await page.locator(".home").count()?await page.locator(".home").getAttribute("data-state"):null;
        const message=state?await page.locator("#pages-status").innerText():null;
        await blocked.release();await blocked.remove();
        eq(await page.locator(".home").count(),state===null?0:1);
        if(state){eq(await page.locator(".home").getAttribute("data-state"),state);eq(await page.locator("#pages-status").innerText(),message);}
    });

    await withPage("TC05-L real Home watcher continuity and decisive negative", [document("arc-live",{pullRequest:{url:"https://github.com/acme/app/pull/7"}})], async ({ page, worker }) => {
        eq((await worker.call("watch")).watching, ["arc-live"]); await rows(page, ["arc-live"]);
        assert.match(await page.locator('[data-document-id="arc-live"] .m').innerText(),/PR 7/);
        for (const action of ["Archive", "Unarchive"]) {
            if (action === "Unarchive") { await select(page, "scope", "archived"); await rows(page, ["arc-live"]); }
            await worker.call("arm");
            await page.locator('[data-document-id="arc-live"]').getByRole("button", { name: new RegExp(`^${action}`) }).click();
            await rows(page, []);
            eq(await worker.call("oracle"), { calls: 0, watching: ["arc-live"] });
        }
        eq(await worker.call("negative"), { negativeDetected: true });
    }, { fixture: { attachments: { [join("docs","arc-live","command","state.json")]: JSON.stringify({ plan:null,fronts:[],fixture:"inactive-command" }) } } });

    const dates = [
        ["t-before","2026-11-01T03:59:59.999Z","2026-11-01T04:00:00.000Z"],
        ["t-start","2026-11-01T04:00:00.000Z","2026-11-01T04:10:00.000Z"],
        ["t-mid","2026-11-01T16:00:00.000Z","2026-10-31T16:00:00.000Z"],
        ["t-end","2026-11-02T04:59:59.999Z","2026-11-02T05:00:00.000Z"],
        ["t-after","2026-11-02T05:00:00.000Z","2026-11-01T18:00:00.000Z"],
        ["t-unknown","not-a-date",undefined],
    ].map(([id,updatedAt,createdAt]) => document(id,{updatedAt,createdAt}));
    await withPage("TC13 real 25-hour local day, open bounds, invalidation", dates, async ({ page }) => {
        await rows(page, ["t-after","t-end","t-mid","t-start","t-before","t-unknown"]);
        const requests = [];
        page.on("request", (request) => { if (request.url().includes("/api/catalog?")) requests.push(new URL(request.url())); });
        await page.locator("#pages-from").fill("2026-11-01");
        await page.locator("#pages-through").fill("2026-11-01");
        await rows(page, ["t-end","t-mid","t-start"]);
        const bounded = requests.findLast((url) => url.searchParams.has("until"));
        eq([bounded.searchParams.get("from"),bounded.searchParams.get("until")], ["2026-11-01T04:00:00.000Z","2026-11-02T05:00:00.000Z"]);
        await select(page,"date-field","created"); await rows(page,["t-after","t-start","t-before"]);
        await select(page,"date-field","updated");
        await page.locator("#pages-through").fill(""); await rows(page,["t-after","t-end","t-mid","t-start"]);
        await page.locator("#pages-from").fill("");
        await page.locator("#pages-through").fill("2026-11-01"); await rows(page,["t-end","t-mid","t-start","t-before"]);
        await page.locator("#pages-from").evaluate((el) => { el.type="text"; el.value="2026-02-30"; el.dispatchEvent(new Event("input",{bubbles:true})); });
        await page.waitForSelector('.home[data-state="invalid-input"]');
        assert.match(await page.locator("#pages-status").innerText(),/real calendar.*Previous results/);
        await page.locator("#pages-from").fill(""); await page.locator("#pages-through").fill("");
        await rows(page,["t-after","t-end","t-mid","t-start","t-before","t-unknown"]);
        assert.match(await page.locator('[data-document-id="t-unknown"]').innerText(),/Unknown/);
    }, {timezone:"America/New_York"});
    await withPage("TC13 real 23-hour spring local day", [
        document("s-before",{updatedAt:"2026-03-08T04:59:59.999Z"}), document("s-start",{updatedAt:"2026-03-08T05:00:00.000Z"}),
        document("s-end",{updatedAt:"2026-03-09T03:59:59.999Z"}), document("s-after",{updatedAt:"2026-03-09T04:00:00.000Z"}),
    ], async ({page}) => {
        let last; page.on("request",request=>{if(request.url().includes("/api/catalog?"))last=new URL(request.url());});
        await page.locator("#pages-from").fill("2026-03-08"); await page.locator("#pages-through").fill("2026-03-08");
        await rows(page,["s-end","s-start"]);
        eq([last.searchParams.get("from"),last.searchParams.get("until")],["2026-03-08T05:00:00.000Z","2026-03-09T04:00:00.000Z"]);
    },{timezone:"America/New_York"});
    await withPage("TC13 composed query/status/date/sort",canonicalPages(),async({page})=>{
        await query(page,PHRASE,principal);
        await page.locator("#pages-from").fill("2026-10-07");await page.locator("#pages-through").fill("2026-10-09");
        await rows(page,["c-body-phrase","k-equal-phrase","d-title-separated","e-title-one"]);
        await select(page,"sort","created-asc");await rows(page,["d-title-separated","c-body-phrase","k-equal-phrase","e-title-one"]);
        await select(page,"scope","all");await rows(page,["d-title-separated","c-body-phrase","k-equal-phrase","e-title-one"]);
        await select(page,"scope","archived");await rows(page,[]);
        assert.match(await page.locator("#pages-status").innerText(),/No pages match/);
    });
    const validStoredDates=[
        "2026-02-28T10:00:00.000Z","2026-02-28T10:00:00Z","2026-02-28T12:00:00+02:00",
        "Sat, 02/28/2026 10:00:00 GMT","Sat, 2026/02/28 10:00:00 GMT","Sat 2026-2-28 10:00:00 GMT",
        "28 Feb 2026 10:00:00 GMT","Feb 28 2026 10:00:00 GMT",
    ];
    const invalidStoredDates=[
        "2026-02-30T10:00:00.000Z","Mon, 02/30/2026 10:00:00 GMT","Mon, 2026/02/30 10:00:00 GMT",
        "Mon 2026-2-30 10:00:00 GMT","30 Feb 2026 10:00:00 GMT","Feb 30 2026 10:00:00 GMT","not-a-date",
    ];
    await withPage("TC13 supported legacy dates remain readable and impossible dates unknown",[
        ...validStoredDates.map((updatedAt,i)=>document(`valid-${i}`,{updatedAt})),
        ...invalidStoredDates.map((updatedAt,i)=>document(`invalid-${i}`,{updatedAt})),
    ],async({page,worker})=>{
        await rows(page,["valid-0","valid-1","valid-2","valid-3","valid-4","valid-5","valid-6","valid-7","invalid-0","invalid-1","invalid-2","invalid-3","invalid-4","invalid-5","invalid-6"]);
        for(let i=0;i<validStoredDates.length;i++){
            assert.match(await page.locator(`[data-document-id="valid-${i}"] .m`).innerText(),/Updated: 2\/28\/2026, 10:00:00 AM/);
            eq((await worker.call("read",{documentId:`valid-${i}`})).updatedAt,validStoredDates[i]);
        }
        for(let i=0;i<invalidStoredDates.length;i++){
            assert.match(await page.locator(`[data-document-id="invalid-${i}"] .m`).innerText(),/Updated: Unknown/);
            eq((await worker.call("read",{documentId:`invalid-${i}`})).updatedAt,invalidStoredDates[i]);
        }
    });

    const pillMarkdown = [
        `Before ${R} after`, `# Heading ${R}`, `- List ${R}`, `| Name |\n| --- |\n| ${R} |`, `> Quote ${R}`,
        `\`${R}\``, ["````text","```",R,"```","````"].join("\n"),`After ${R}`,`[${R}](https://example.invalid/)`, "[ordinary](https://example.invalid/)",
        '<copilot-ref kind="session" target-id="synthetic-unsafe" label="&lt;script&gt;bad&lt;/script&gt; &amp; helper" />',
    ].join("\n\n");
    const pillDoc = document("pill-page",{title:"Synthetic reference page",content:[
        {id:"md-1",type:"markdown",markdown:pillMarkdown},
        {id:"code-1",type:"code",language:"text",text:R,caption:`Caption ${R}`},
        {id:"section-1",type:"section",title:"Nested section",children:[{id:"nested-1",type:"markdown",markdown:`Nested ${R}`}]},
        {id:"seq-1",type:"sequence",title:"Synthetic sequence",actors:{client:"Client",store:"Store"},
            steps:[{id:"step-1",from:"client",to:"store",label:"Read",notes:[{title:"Context",text:`Inspect ${R}`}]}]},
    ]});
    await withPage("TC11/15/16 actual page/plain-user/assistant/stream/history inert pills", [pillDoc], async({page,context,worker})=>{
        await page.locator('[data-document-id="pill-page"] .page-open').click();
        await page.waitForSelector(".session-ref");
        eq(await page.locator("#main .session-ref").count(),9);
        for(const selector of ["h1","li","td","blockquote",".caption",".b-section .md"])eq(await page.locator(`#main ${selector} .session-ref`).count(),1);
        eq(await page.locator("#main script,#main img,#main [onerror],#main [onclick]").count(),0);
        eq(await page.getByRole("note",{name:"Separate Copilot session: <script>bad</script> & helper",exact:true}).count(),1);
        eq(await page.locator(".b-sequence .msg").count(),1);
        assert.match(await page.locator(".b-sequence").innerText(),/Client[\s\S]*Store[\s\S]*Read/);
        assert.doesNotMatch(await page.locator(".b-sequence").innerText(),/\[object Object\]/);
        eq(await page.locator("#main pre .session-ref, #main code .session-ref, #main a .session-ref").count(),0);
        eq(await page.locator('#main a[href="https://example.invalid/"]').count(),2);
        eq(await page.locator("#main .session-ref").evaluateAll(els=>els.every(el=>!el.closest('a,button,[role="button"],[role="link"],[tabindex]')&&
            ![...el.attributes].some(a=>/href|target|tabindex/.test(a.name))&&el.getAttribute("aria-label").startsWith("Separate Copilot session"))),true);
        await worker.call("emit",{events:[
            {type:"user.message",id:"user-ref",data:{content:`First line\n${R}\n**not Markdown**`}},
            {type:"assistant.message",id:"assistant-ref",data:{messageId:"assistant-ref",content:`Assistant ${R}`}},
        ]});
        await page.locator("#chat-btn").click();
        await page.waitForSelector('.chat-u[data-id="user-ref"] .session-ref');
        eq(await page.locator('.chat-u[data-id="user-ref"] strong').count(),0);
        assert.match(await page.locator('.chat-u[data-id="user-ref"] .chat-msg').innerText(),/First line\n.*Build & helper\n\*\*not Markdown\*\*/);
        const url=page.url(), sentBefore=await page.locator("#chat-log .chat-msg").count(), pagesBefore=context.pages().length,counters=await worker.call("counters");
        const outbound=[];page.on("request",request=>{if(!request.url().includes("/api/events"))outbound.push(request.url());});
        await page.locator(".chat-msg.bot .session-ref").first().click();
        eq(page.url(),url);eq(context.pages().length,pagesBefore);eq(await page.locator("#chat-log .chat-msg").count(),sentBefore);eq(outbound,[]);
        eq(await worker.call("counters"),counters);
        await page.locator("#home").focus();
        for(let i=0;i<20;i++){await page.keyboard.press("Tab");eq(await page.evaluate(()=>!!document.activeElement?.closest(".session-ref")),false);}
        const pieces=[R.slice(0,R.indexOf("target-")+7), R.slice(R.indexOf("target-")+7,R.indexOf('label="')+7), R.slice(R.indexOf('label="')+7)];
        for(let i=0;i<pieces.length;i++){
            await worker.call("emit",{events:[{type:"assistant.message_delta",data:{messageId:"stream-ref",deltaContent:pieces[i]}}]});
            await page.waitForFunction(({length})=>document.querySelector('[data-id="stream-ref"]')?.dataset.raw?.length===length,{length:pieces.slice(0,i+1).join("").length});
            eq(await page.locator('[data-id="stream-ref"] .session-ref').count(),i===2?1:0);
        }
        await worker.call("emit",{events:[{type:"assistant.message",data:{messageId:"stream-ref",content:R}}]});
        const fenceLines=["````text","```",R,"```","````"];
        for(const [i,line] of fenceLines.entries()){
            await worker.call("emit",{events:[{type:"assistant.message_delta",data:{messageId:"stream-code",deltaContent:(i?"\n":"")+line}}]});
            await page.waitForFunction(n=>document.querySelector('[data-id="stream-code"]')?.dataset.raw?.length===n,fenceLines.slice(0,i+1).join("\n").length);
            eq(await page.locator('[data-id="stream-code"] .session-ref').count(),0);
        }
        await worker.call("emit",{events:[{type:"assistant.message",data:{messageId:"stream-code",content:fenceLines.join("\n")}}]});
        await page.reload();await page.waitForSelector(".block.b-markdown");
        if(await page.locator("#chat").isHidden())await page.locator("#chat-btn").click();
        await page.waitForSelector('[data-id="stream-ref"] .session-ref');
        eq(await page.locator('[data-id="stream-ref"] .session-ref').count(),1);
        eq(await page.locator('[data-id="stream-code"] .session-ref').count(),0);
        await page.locator("#chat-close").click();
        await page.getByRole("button",{name:"Inspect Synthetic sequence",exact:true}).click();
        await page.waitForSelector("#peek .session-ref");eq(await page.locator("#peek .session-ref").count(),1);
        await shot(page,"references-inspect");
        await page.locator("#peek-close").click();
        const navigation=[];context.on("request",request=>{if(request.url()==="https://example.invalid/")navigation.push(request.url());});
        const opened=context.waitForEvent("page");
        await page.locator('#main a[href="https://example.invalid/"]').filter({hasText:"ordinary"}).click();
        const ordinary=await opened;await ordinary.waitForLoadState().catch(()=>{});
        eq(navigation,["https://example.invalid/"]);await ordinary.close();
        await shot(page,"references-chat");
    });

    await withPage("TC16 actual page streamed fence ownership and changed labels",[document("page-stream")],async({page,worker})=>{
        await page.locator('[data-document-id="page-stream"] .page-open').click();await page.waitForSelector(".block.b-markdown");
        const lines=["````text","```",R,"```","````"];
        for(let i=0;i<lines.length;i++){
            await worker.call("edit",{documentId:"page-stream",text:lines.slice(0,i+1).join("\n")});
            const doc=await worker.call("read",{documentId:"page-stream"});
            await page.waitForFunction(version=>new RegExp(`v${version}\\b`).test(document.querySelector("#subtitle")?.textContent),doc.version);
            await page.waitForFunction(text=>document.querySelector("#main pre code")?.textContent===text,lines.slice(1,i+1).filter((_,j)=>i<4||j<3).join("\n"));
            eq(await page.locator("#main .session-ref").count(),0);
        }
        await worker.call("edit",{documentId:"page-stream",text:R.replace("Build &amp; helper","Changed &amp; safe")});
        await page.waitForSelector(".session-ref");eq(await page.locator(".session-ref").innerText(),"◉ Changed & safe");
        eq(await page.locator(".session-ref").getAttribute("aria-label"),"Separate Copilot session: Changed & safe");
        eq(await page.locator("#main").getByText("Build & helper",{exact:false}).count(),0);
    });

    async function enterEdit(page,selector=".b-markdown .md > p"){
        for(let attempt=0;attempt<3;attempt++){
            await page.mouse.move(1,1);
            await page.locator(selector).first().hover({position:{x:10,y:10}});
            try { await page.locator("#g-edit").click({timeout:1000}); break; }
            catch(error){ if(attempt===2)throw error; }
        }
        await page.waitForSelector(".editing");
    }
    async function saveEdit(page){
        const response=page.waitForResponse(response=>response.url().endsWith("/prose")&&response.request().method()==="POST");
        await page.keyboard.press("Shift+Enter");eq((await response).status(),200);
        await page.waitForSelector(".editing",{state:"detached"});
    }
    async function replaceBefore(page) {
        await page.locator(".editing").evaluate(el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange();
            let node;
            while ((node = walker.nextNode()) && !node.data.includes("Before")) {}
            if (!node) throw new Error("Missing surrounding native edit target");
            const start = node.data.indexOf("Before");
            el.focus(); range.setStart(node, start); range.setEnd(node, start + 6);
            getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        await page.keyboard.type("Around");
    }
    for (const newline of ["\n", "\r\n"]) for (const list of [false, true]) for (const [family, raw] of [
        ["blank-label", `<copilot-ref kind="session" target-id="synthetic-final" label="Build${newline}${newline}helper" />`],
        ["blank-attributes", `<copilot-ref${newline}${newline}kind="session" target-id="synthetic-final" label="Build helper" />`],
        ["heading-label", `<copilot-ref kind="session" target-id="synthetic-final" label="Build${newline}# helper" />`],
    ]) await withPage(`FINAL-reference atomic ${family} ${list ? "list" : "paragraph"} ${newline.length === 1 ? "LF" : "CRLF"}`, [
        document("final-ref", { content: [{ id: "md-1", type: "markdown", markdown:
            `${list ? "- " : ""}Before ${raw} after${newline}${newline}Following prose` }] }),
    ], async ({ page, worker }) => {
        await page.locator('[data-document-id="final-ref"] .page-open').click();
        await page.waitForSelector(".block.b-markdown");
        eq(await page.locator("#main .session-ref").count(), 1);
        const original = await worker.call("read", { documentId: "final-ref" });
        const source = original.content[0].markdown, end = raw.split("\n").length - 1;
        const selector = list ? ".b-markdown .md > ul > li" : ".b-markdown .md > p";
        eq(await page.locator(selector).first().getAttribute("data-l"), `0-${end}`);
        eq(await page.locator(".b-markdown .md > p").last().getAttribute("data-l"), `${end + 2}-${end + 2}`);
        const posts = [];
        page.on("request", request => { if (request.url().endsWith("/prose") && request.method() === "POST") posts.push(request.postDataJSON()); });
        await enterEdit(page, selector);
        eq(await page.locator(".editing [data-ref-source]").allTextContents(), [raw]);
        await page.keyboard.press("Shift+Enter"); await page.waitForSelector(".editing", { state: "detached" });
        eq(await worker.call("read", { documentId: "final-ref" }), original);
        eq(posts.length, 0);
        await enterEdit(page, selector); await replaceBefore(page); await page.keyboard.press("Escape");
        eq(await worker.call("read", { documentId: "final-ref" }), original);
        eq(posts.length, 0);
        await enterEdit(page, selector); await replaceBefore(page); await saveEdit(page);
        const expected = source.replace("Before", "Around");
        eq(posts.length, 1);
        eq([posts[0].edits[0].from, posts[0].edits[0].to], [0, end]);
        eq((await worker.call("read", { documentId: "final-ref" })).content[0].markdown, expected);
        await enterEdit(page, ".b-markdown .md > p:last-child");
        await page.locator(".editing").evaluate(el => {
            const range = document.createRange(); range.selectNodeContents(el);
            el.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        await page.keyboard.type("Following kept"); await saveEdit(page);
        eq((await worker.call("read", { documentId: "final-ref" })).content[0].markdown, expected.replace("Following prose", "Following kept"));
        await worker.call("emit", { events: [{ type: "assistant.message", id: "final-atomic-message", data: { messageId: "final-atomic-message", content: source } }] });
        await page.locator("#chat-btn").click(); await page.waitForSelector('[data-id="final-atomic-message"] .session-ref');
        eq(await page.locator('[data-id="final-atomic-message"] .session-ref').count(), 1);
        eq(await page.locator('[data-id="final-atomic-message"] h1').count(), 0);
    });

    for (const newline of ["\n", "\r\n"]) {
        const raw = `<copilot-ref${newline}${newline}kind="session" target-id="synthetic-nested" label="Build${newline}# helper" />`;
        const source = `- Before ${raw} after${newline}  - Child ${raw} kept${newline}- Following item`;
        await withPage(`FINAL-reference nested source seams ${newline.length === 1 ? "LF" : "CRLF"}`, [
            document("final-nested", { content: [{ id: "md-1", type: "markdown", markdown: source }] }),
        ], async ({ page, worker }) => {
            await page.locator('[data-document-id="final-nested"] .page-open').click(); await page.waitForSelector("#main .session-ref");
            eq(await page.locator("#main .session-ref").count(), 2);
            await enterEdit(page, ".b-markdown .md > ul > li"); await replaceBefore(page); await saveEdit(page);
            eq((await worker.call("read", { documentId: "final-nested" })).content[0].markdown, source.replace("Before", "Around"));
            eq(await page.locator(".b-markdown .md > ul > li").last().getAttribute("data-l"), "8-8");
        });
    }

    for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const place of ["header", "body"]) await withPage(
        `CELL-reference ${place} ${ticks.length} ${newline.length === 1 ? "LF" : "CRLF"}`, [
            document("cell-prose", { content: [{ id: "md-1", type: "markdown", markdown:
                (place === "header"
                    ? [`| Before ${ticks} | <copilot-ref kind="session" target-id="cellneedle" label="Build helper" /> | ${ticks} after |`, "| --- | --- | --- |", "| One | Two | Three |"]
                    : ["| A | B | C |", "| --- | --- | --- |", `| Before ${ticks} | <copilot-ref kind="session" target-id="cellneedle" label="Build helper" /> | ${ticks} after |`]).join(newline) }] }),
            document("cell-literal", { content: [{ id: "md-1", type: "markdown", markdown:
                (place === "header"
                    ? [`| Before ${ticks}<copilot-ref kind="session" target-id="cellneedle" label="Build helper" />${ticks} after | Other | Last |`, "| --- | --- | --- |", "| One | Two | Three |"]
                    : ["| A | B | C |", "| --- | --- | --- |", `| Before ${ticks}<copilot-ref kind="session" target-id="cellneedle" label="Build helper" />${ticks} after | Other | Last |`]).join(newline) }] }),
        ], async ({ page }) => {
            await query(page, "cellneedle", ["cell-literal"]);
            await query(page, "Build helper", ["cell-literal", "cell-prose"]);
            await page.locator('[data-document-id="cell-prose"] .page-open').click(); await page.waitForSelector("#main table");
            eq(await page.locator("#main table th").count(), 3); eq(await page.locator("#main table td").count(), 3);
            eq(await page.locator("#main table .session-ref").count(), 1); eq(await page.locator("#main table code").count(), 0);
        });

    for (const newline of ["\n", "\r\n"]) for (const ticks of ["```", "````"]) {
        const literal = '<copilot-ref kind="session" target-id="needleliteral" label="Literal helper" />';
        const source = `Before ${R}${ticks}literal${newline}${literal}${newline}code${ticks} after`;
        await withPage(`CONTEXT-reference adjacent code ${ticks.length} ${newline.length === 1 ? "LF" : "CRLF"}`, [
            document("context-code", { content: [{ id: "md-1", type: "markdown", markdown: source }] }),
        ], async ({ page, worker }) => {
            await query(page, "needleliteral", ["context-code"]);
            await page.locator('[data-document-id="context-code"] .page-open').click(); await page.waitForSelector("#main .session-ref");
            eq(await page.locator("#main .session-ref").count(), 1);
            eq(await page.locator("#main code").textContent(), `literal ${literal} code`);
            const original = await worker.call("read", { documentId: "context-code" }), posts = [];
            page.on("request", request => { if (request.url().endsWith("/prose") && request.method() === "POST") posts.push(request.postDataJSON()); });
            await enterEdit(page);
            eq(await page.locator(".editing [data-ref-source]").allTextContents(), [R]);
            await page.keyboard.press("Shift+Enter"); await page.waitForSelector(".editing", { state: "detached" });
            eq(await worker.call("read", { documentId: "context-code" }), original); eq(posts.length, 0);
            await enterEdit(page); await replaceBefore(page); await page.keyboard.press("Escape");
            eq(await worker.call("read", { documentId: "context-code" }), original); eq(posts.length, 0);
            await enterEdit(page); await replaceBefore(page); await saveEdit(page);
            eq(posts.length, 1);
            eq((await worker.call("read", { documentId: "context-code" })).content[0].markdown, source.replace("Before", "Around"));
        });
    }

    for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) {
        const raw = '<copilot-ref kind="session" target-id="captionneedle" label="Build helper" />';
        const caption = [`| Before ${ticks} | ${raw} | ${ticks} after |`, "| --- | --- | --- |"].join(newline);
        await withPage(`CONTEXT-reference inline caption ${ticks.length} ${newline.length === 1 ? "LF" : "CRLF"}`, [
            document("context-caption", { content: [{ id: "code-1", type: "code", language: "js", text: "const synthetic = 1;", caption }] }),
        ], async ({ page }) => {
            await query(page, "captionneedle", ["context-caption"]);
            await page.locator('[data-document-id="context-caption"] .page-open').click(); await page.waitForSelector("#main .caption");
            eq(await page.locator("#main .caption .session-ref").count(), 0);
            eq(await page.locator("#main .caption code").textContent(), ` | ${raw} | `);
            eq(await page.locator("#main table").count(), 0);
        });
    }

    for (const newline of ["\n", "\r\n"]) for (const ticks of ["`", "``", "````"]) for (const place of ["header", "body"]) {
        const row = `| Before ${ticks} | ${R} | ${ticks} after |`;
        const source = (place === "header" ? [row, "| --- | --- | --- |", "| One | Two | Three |"] : ["| A | B | C |", "| --- | --- | --- |", row]).join(newline);
        await withPage(`PLAIN-reference user ${place} ${ticks.length} ${newline.length === 1 ? "LF" : "CRLF"}`, [document("plain-user")], async ({ page, worker }) => {
            await page.locator('[data-document-id="plain-user"] .page-open').click();
            await page.waitForSelector("#chat-btn");
            await worker.call("emit", { events: [{ type: "user.message", id: "plain-literal", data: { content: source } }] });
            await page.locator("#chat-btn").click();
            const message = page.locator('[data-id="plain-literal"] .chat-msg.me');
            await message.waitFor();
            eq(await message.textContent(), source.replace(/\r\n/g, "\n"));
            eq(await message.locator(".session-ref, table, code, a").count(), 0);
            const control = `First\n${R}\n**not Markdown**`;
            await worker.call("emit", { events: [{ type: "user.message", id: "plain-prose", data: { content: control } }] });
            const prose = page.locator('[data-id="plain-prose"] .chat-msg.me');
            await prose.locator(".session-ref").waitFor();
            eq(await prose.locator(".session-ref").count(), 1);
            eq(await prose.locator("strong, a, button").count(), 0);
            eq(await prose.textContent(), "First\n◉ Build & helper\n**not Markdown**");
        });
    }

    await withPage("PLAIN-reference user fence boundaries", [document("plain-fences")], async ({ page, worker }) => {
        await page.locator('[data-document-id="plain-fences"] .page-open').click();
        await page.waitForSelector("#chat-btn");
        await page.locator("#chat-btn").click();
        for (const newline of ["\n", "\r\n"]) for (const prefix of ["", "> ", "> > "]) {
            const source = ["````text", "```", R, "```"].map(line => prefix + line).join(newline);
            const id = `plain-fence-${newline.length}-${prefix.length}`;
            await worker.call("emit", { events: [{ type: "user.message", id, data: { content: source } }] });
            const message = page.locator(`[data-id="${id}"] .chat-msg.me`);
            await message.waitFor();
            eq(await message.textContent(), source.replace(/\r\n/g, "\n"));
            eq(await message.locator(".session-ref, table, code").count(), 0);
        }
    });

    for (const newline of ["\n", "\r\n"]) for (const kind of ["paragraph", "list", "quote", "pipe-paragraph", "pipe-quote"]) for (const ticks of ["`", "``", "````"]) {
        const raw = '<copilot-ref kind="session" target-id="needleliteral" label="Build helper" />';
        const quote = kind === "quote" || kind === "pipe-quote", pipe = kind.startsWith("pipe-");
        const code = [`Before ${ticks}literal`, raw, `code${ticks} after`]
            .map((line, i) => `${quote ? "> " : kind === "list" ? i ? "  " : "- " : ""}${pipe && i === 0 ? `| ${line} |` : line}`).join(newline);
        const displayedCode = `literal ${pipe ? "| " : ""}${raw} code`;
        await withPage(`FINAL-reference wrapped ${kind} ${ticks.length} ${newline.length === 1 ? "LF" : "CRLF"}`, [
            document("final-code", { content: [{ id: "md-1", type: "markdown", markdown: code }] }),
        ], async ({ page, worker }) => {
            await query(page, "needleliteral", ["final-code"]);
            await page.locator('[data-document-id="final-code"] .page-open').click();
            await page.waitForSelector(".block.b-markdown");
            eq(await page.locator("#main code").textContent(), displayedCode);
            eq(await page.locator("#main .session-ref").count(), 0);
            eq(await page.evaluate(async source => {
                const { markdown } = await import("./core.js");
                const frame = document.createElement("div"); frame.innerHTML = markdown(source, true, "source");
                return frame.querySelectorAll("[data-ref-source]").length;
            }, code), 0);
            const original = await worker.call("read", { documentId: "final-code" });
            const selector = quote ? ".b-markdown .md > blockquote" : kind === "list" ? ".b-markdown .md > ul > li" : ".b-markdown .md > p", posts = [];
            page.on("request", request => { if (request.url().endsWith("/prose") && request.method() === "POST") posts.push(request.postDataJSON()); });
            await enterEdit(page, selector);
            eq(await page.locator(".editing [data-ref-source]").count(), 0);
            await page.keyboard.press("Shift+Enter"); await page.waitForSelector(".editing", { state: "detached" });
            eq(await worker.call("read", { documentId: "final-code" }), original); eq(posts.length, 0);
            await enterEdit(page, selector); await replaceBefore(page); await page.keyboard.press("Escape");
            eq(await worker.call("read", { documentId: "final-code" }), original); eq(posts.length, 0);
            await enterEdit(page, selector); await replaceBefore(page); await saveEdit(page);
            eq(posts.length, 1);
            eq((await worker.call("read", { documentId: "final-code" })).content[0].markdown, code.replace("Before", "Around"));
            eq(await page.locator("#main code").textContent(), displayedCode);
            eq(await page.locator("#main .session-ref").count(), 0);
        });
    }
    for (const newline of ["\n", "\r\n"]) await withPage(`FINAL-reference page assistant table and source frame ${newline.length === 1 ? "LF" : "CRLF"}`, [
        document("final-table", { content: [{ id: "md-1", type: "markdown", markdown:
            ["| Name | Other |", "| --- | --- |", `| <copilot-ref${newline}${newline}kind="session" target-id="synthetic-table" label="Build | Test" /> | Kept |`].join(newline) }] }),
    ], async ({ page, worker }) => {
        await page.locator('[data-document-id="final-table"] .page-open').click(); await page.waitForSelector("#main table");
        eq(await page.locator("#main td").allTextContents(), ["◉ Build | Test", "Kept"]);
        eq(await page.locator("#main table .session-ref").count(), 1);
        eq(await page.locator("#main table").getAttribute("data-l"), "0-4");
        const original = await worker.call("read", { documentId: "final-table" }), source = original.content[0].markdown;
        const frame = await page.evaluate(async source => {
            const { markdown } = await import("./core.js");
            const frame = document.createElement("div"); frame.innerHTML = markdown(source, true, "source");
            return { raw: frame.querySelector("[data-ref-source]")?.textContent, cells: frame.querySelectorAll("td").length, lines: frame.querySelector("table")?.dataset.l };
        }, source);
        eq(frame, { raw: `<copilot-ref${newline}${newline}kind="session" target-id="synthetic-table" label="Build | Test" />`, cells: 2, lines: "0-4" });
        await page.locator("#main td").first().hover(); eq(await page.locator("#g-edit").isVisible(), false);
        await worker.call("emit", { events: [{ type: "assistant.message", id: "final-reference-message", data: { messageId: "final-reference-message", content: source } }] });
        await page.locator("#chat-btn").click(); await page.waitForSelector('[data-id="final-reference-message"] table');
        eq(await page.locator('[data-id="final-reference-message"] td').allTextContents(), ["◉ Build | Test", "Kept"]);
        eq(await page.locator('[data-id="final-reference-message"] .session-ref').count(), 1);
        eq(await worker.call("read", { documentId: "final-table" }), original);
    });
    await withPage("TC16 exact source runs, same-label duplicates, splits, no-op/cancel/quote/malformed",[
        document("edit-ref",{content:[{id:"md-1",type:"markdown",markdown:EXACT}]}),
    ],async({page,worker})=>{
        await page.locator('[data-document-id="edit-ref"] .page-open').click();await page.waitForSelector(".session-ref");
        const original=await worker.call("read",{documentId:"edit-ref"});
        await enterEdit(page);
        eq(await page.locator("[data-ref-source]").allTextContents(),[
            "<copilot-ref  kind='session'   target-id='synthetic-session-1'  label='Build  &amp;  helper' />",
            '<copilot-ref label="Build  &amp;  helper"   target-id="synthetic-session-2" kind="session"  />',
        ]);
        await page.keyboard.press("Shift+Enter");await page.waitForSelector(".editing",{state:"detached"});
        eq((await worker.call("read",{documentId:"edit-ref"})).version,original.version);
        await enterEdit(page);await page.keyboard.press("Enter");await page.keyboard.press("Escape");
        eq((await worker.call("read",{documentId:"edit-ref"})).version,original.version);
        await enterEdit(page);
        await page.locator(".editing").evaluate(el=>{
            el.firstChild.data=el.firstChild.data.replace("Before","Around");
            for(const span of el.querySelectorAll("[data-ref-source]"))span.firstChild.splitText(25);
        });
        await saveEdit(page);
        eq((await worker.call("read",{documentId:"edit-ref"})).content[0].markdown,EXACT.replace(/^Before/,"Around"));
        for(const [from,to] of [["Build  &amp;  helper","Build   &amp;  guide"],["kind='session'",'kind="session"'],[" />"," "]]){
            await worker.call("edit",{documentId:"edit-ref",text:EXACT});
            const reset=await worker.call("read",{documentId:"edit-ref"});
            await page.waitForFunction(version=>new RegExp(`v${version}\\b`).test(document.querySelector("#subtitle")?.textContent),reset.version);
            await enterEdit(page);
            await page.locator("[data-ref-source]").first().evaluate((el,{from,to})=>el.textContent=el.textContent.replace(from,to),{from,to});
            await saveEdit(page);
            eq((await worker.call("read",{documentId:"edit-ref"})).content[0].markdown,EXACT.replace(from,to));
        }
    });
    for(const newline of ["\n","\r\n"])for(const list of [false,true])await withPage(`P3-001 ${newline==="\n"?"LF":"CRLF"} ${list?"list":"paragraph"} multiline source`,[
        document("edit-multiline",{content:[{id:"md-1",type:"markdown",markdown:`${list?"- ":""}Before <copilot-ref${newline}  kind='session' target-id='synthetic-session-newline' label='Build${newline}  helper' /> after`}]}),
    ],async({page,worker})=>{
        await page.locator('[data-document-id="edit-multiline"] .page-open').click();await page.waitForSelector(".session-ref");
        const original=await worker.call("read",{documentId:"edit-multiline"});
        const selector=list?".b-markdown .md > ul > li":".b-markdown .md > p";
        await enterEdit(page,selector);
        await page.keyboard.press("Shift+Enter");await page.waitForSelector(".editing",{state:"detached"});
        eq((await worker.call("read",{documentId:"edit-multiline"})).version,original.version);
        await enterEdit(page,selector);await page.keyboard.type("discard");await page.keyboard.press("Escape");
        eq((await worker.call("read",{documentId:"edit-multiline"})).content,original.content);
        await enterEdit(page,selector);
        const raw=await page.locator("[data-ref-source]").textContent();
        await page.locator(".editing").evaluate(el=>{
            const range=document.createRange();range.setStart(el.firstChild,0);range.setEnd(el.firstChild,6);
            el.focus();getSelection().removeAllRanges();getSelection().addRange(range);
        });
        await page.keyboard.type("Around");await saveEdit(page);
        const stored=await worker.call("read",{documentId:"edit-multiline"});
        eq(stored.content[0].markdown,original.content[0].markdown.replace("Before","Around"));
        eq(raw,`<copilot-ref${newline}  kind='session' target-id='synthetic-session-newline' label='Build${newline}  helper' />`);
    });

    for(const newline of ["\n","\r\n"])for(const list of [false,true])await withPage(`P3-001 ${newline==="\n"?"LF":"CRLF"} ${list?"list":"paragraph"} malformed source`,[
        document("edit-malformed",{content:[{id:"md-1",type:"markdown",markdown:`${list?"- ":""}Before <copilot-ref${newline}  kind='session' target-id='synthetic-malformed' label='Build${newline}  &amp; helper' /> after`}]}),
    ],async({page,worker})=>{
        await page.locator('[data-document-id="edit-malformed"] .page-open').click();await page.waitForSelector(".session-ref");
        const original=(await worker.call("read",{documentId:"edit-malformed"})).content[0].markdown;
        const selector=list?".b-markdown .md > ul > li":".b-markdown .md > p";
        for(const [from,to] of [["/>",""],["copilot-ref","changed-ref"],["kind='session'","kind='other'"]]){
            await worker.call("edit",{documentId:"edit-malformed",text:original});
            const reset=await worker.call("read",{documentId:"edit-malformed"});
            await page.waitForFunction(version=>new RegExp(`v${version}\\b`).test(document.querySelector("#subtitle")?.textContent),reset.version);
            await enterEdit(page,selector);
            const raw=await page.locator("[data-ref-source]").textContent();
            await page.locator("[data-ref-source]").evaluate((el,from)=>{
                const node=el.firstChild,start=node.data.indexOf(from),range=document.createRange();
                if(start<0)throw new Error("Missing native edit selection");
                el.closest("[contenteditable]").focus();range.setStart(node,start);range.setEnd(node,start+from.length);
                getSelection().removeAllRanges();getSelection().addRange(range);
            },from);
            if(to)await page.keyboard.type(to);else await page.keyboard.press("Backspace");
            eq(await page.locator("[data-ref-source]").textContent(),raw.replace(from,to));
            const request=page.waitForRequest(request=>request.url().endsWith("/prose")&&request.method()==="POST");
            await saveEdit(page);
            const expected=original.replace(from,to);
            eq((await request).postDataJSON().edits[0].after,expected);
            eq((await worker.call("read",{documentId:"edit-malformed"})).content[0].markdown,expected);
            eq(await page.locator("#main .session-ref").count(),0);
        }
    });

    for(const literal of ["**guide**","*guide*","`guide`"])await withPage(`TC16 real literal input ${literal}`,[
        document("edit-ref",{content:[{id:"md-1",type:"markdown",markdown:'Before <copilot-ref kind="session" target-id="synthetic-session-1" label="Seed" /> after'}]}),
    ],async({page,worker})=>{
        await page.locator('[data-document-id="edit-ref"] .page-open').click();await page.waitForSelector(".session-ref");await enterEdit(page);
        await page.locator("[data-ref-source]").evaluate(el=>{
            const node=el.firstChild,start=node.data.indexOf("Seed"),range=document.createRange();
            el.closest("[contenteditable]").focus();range.setStart(node,start);range.setEnd(node,start+4);
            getSelection().removeAllRanges();getSelection().addRange(range);
        });
        await page.keyboard.type(literal);
        eq(await page.locator("[data-ref-source] strong,[data-ref-source] em,[data-ref-source] code").count(),0);
        await saveEdit(page);
        eq((await worker.call("read",{documentId:"edit-ref"})).content[0].markdown,`Before <copilot-ref kind="session" target-id="synthetic-session-1" label="${literal}" /> after`);
        await enterEdit(page);
        await page.locator(".editing").evaluate(el=>{
            const node=el.lastChild,range=document.createRange();
            el.focus();range.setStart(node,node.textContent.length);range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range);
        });
        await page.keyboard.type(" **guide**");
        eq(await page.locator(".editing > strong").count(),1);
        await page.keyboard.press("Escape");
    });

    await withPage("TC16 decisive source-marker guard negative",[
        document("edit-ref",{content:[{id:"md-1",type:"markdown",markdown:'Before <copilot-ref kind="session" target-id="synthetic-session-1" label="Seed" /> after'}]}),
    ],async({page,worker})=>{
        await page.locator('[data-document-id="edit-ref"] .page-open').click();await page.waitForSelector(".session-ref");await enterEdit(page);
        await page.locator("[data-ref-source]").evaluate(el=>{
            const node=el.firstChild,start=node.data.indexOf("Seed"),range=document.createRange();
            el.closest("[contenteditable]").focus();range.setStart(node,start);range.setEnd(node,start+4);getSelection().removeAllRanges();getSelection().addRange(range);
        });
        await page.keyboard.type("**guide**");
        eq(await page.locator("[data-ref-source] strong").count(),1);
        await saveEdit(page);
        const actual=(await worker.call("read",{documentId:"edit-ref"})).content[0].markdown;
        const wanted='Before <copilot-ref kind="session" target-id="synthetic-session-1" label="**guide**" /> after';
        assert.throws(()=>assert.equal(actual,wanted),assert.AssertionError);assertions++;
    },{sourceGuardOff:true});

    for(const nested of [false,true])await withPage(`TC16 ${nested?"nested":"parent"} list exact source and literal code`,[
        document("edit-ref",{content:[{id:"md-1",type:"markdown",markdown:`- ${EXACT}\n  - ${EXACT}\n\nLiteral \`${EXACT}\``}]}),
    ],async({page,worker})=>{
        await page.locator('[data-document-id="edit-ref"] .page-open').click();await page.waitForSelector(".session-ref");
        await enterEdit(page,nested?".b-markdown .md > ul > li > ul > li":".b-markdown .md > ul > li");
        await page.locator(".editing").evaluate(el=>{
            el.firstChild.data=el.firstChild.data.replace("Before","Around");
            for(const span of el.querySelectorAll("[data-ref-source]"))span.firstChild.splitText(25);
        });
        await saveEdit(page);
        const expected=nested?`- ${EXACT}\n  - ${EXACT.replace(/^Before/,"Around")}\n\nLiteral \`${EXACT}\``:`- ${EXACT.replace(/^Before/,"Around")}\n  - ${EXACT}\n\nLiteral \`${EXACT}\``;
        eq((await worker.call("read",{documentId:"edit-ref"})).content[0].markdown,expected);
        await enterEdit(page,".b-markdown .md > p");
        await page.locator(".editing").evaluate(el=>el.firstChild.data=el.firstChild.data.replace("Literal","Kept"));
        await saveEdit(page);
        eq((await worker.call("read",{documentId:"edit-ref"})).content[0].markdown,expected.replace("Literal","Kept"));
    });
    await withPage("TC16 reference link label editing and copied source",[
        document("edit-ref",{content:[{id:"md-1",type:"markdown",markdown:`Before [${R}](https://example.invalid/) after`}]}),
    ],async({page,worker})=>{
        await page.locator('[data-document-id="edit-ref"] .page-open').click();await page.waitForSelector(".b-markdown .md > p");
        await enterEdit(page);
        eq(await page.locator(".editing a [data-ref-source],.editing a .session-ref").count(),0);
        await page.locator(".editing").evaluate(el=>{
            el.firstChild.data=el.firstChild.data.replace("Before","Around");const range=document.createRange();range.selectNodeContents(el);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);el.focus();
        });
        await page.keyboard.insertText(` ${EXACT}`);
        await saveEdit(page);
        eq((await worker.call("read",{documentId:"edit-ref"})).content[0].markdown,`Around [${R}](https://example.invalid/) after ${EXACT}`);
        await page.waitForSelector(".session-ref");eq(await page.locator(".b-markdown .session-ref").count(),2);
    });

    const tokenValues = async(page)=>page.evaluate(()=>{
        const names=["--bg","--fg","--surface","--muted","--border","--blue","--green","--red","--yellow","--purple"];
        const probe=document.createElement("span");document.body.append(probe);
        const colors=Object.fromEntries(names.map(name=>{probe.style.color=`var(${name})`;return[name,getComputedStyle(probe).color];}));
        probe.remove();return{...colors,scheme:getComputedStyle(document.documentElement).colorScheme};
    });
    const rgb=hex=>`rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(", ")})`;
    await withPage("TC20/21 Solarized actual chooser/palette/live windows/host/rollback/reload", [pillDoc], async({page,context,worker,data})=>{
        const second=await context.newPage(), embedded=await context.newPage();
        await embedded.addInitScript(()=>addEventListener("DOMContentLoaded",()=>{
            const style=document.createElement("style");style.textContent=":root { --bg:#202124; --fg:#e8eaed; --blue:#8ab4f8; color-scheme:dark; }";document.head.append(style);
        }));
        await second.goto((await worker.call("open",{instance:"browser-pages-second"})).url);await current(second);
        await embedded.goto((await worker.call("open",{instance:"embedded-pages"})).url);await current(embedded);
        const host=await tokenValues(embedded);
        eq([host["--bg"],host["--fg"],host["--blue"],host.scheme],[rgb("#202124"),rgb("#e8eaed"),rgb("#8ab4f8"),"dark"]);
        await embedded.locator("#settings-btn").click();eq(await embedded.locator('[role="radio"][data-t]').count(),0);
        await page.locator("#settings-btn").click();
        eq((await page.locator('[role="radio"][data-t]').evaluateAll(els=>els.map(el=>el.dataset.t))).sort(),["auto","light","dark","win3","win95","vista","future","arcade","solarized-light","solarized-dark"].sort());
        for(const [theme,bg,fg,surface,muted,border,scheme] of [
            ["solarized-light","#fdf6e3","#657b83","#eee8d5","#586e75","#93a1a1","light"],
            ["solarized-dark","#002b36","#839496","#073642","#93a1a1","#586e75","dark"],
        ]){
            await page.emulateMedia({colorScheme:scheme==="light"?"dark":"light"});
            await page.getByRole("radio",{name:theme==="solarized-light"?"Solarized Light":"Solarized Dark",exact:true}).click();
            await second.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
            eq(await tokenValues(page),{"--bg":rgb(bg),"--fg":rgb(fg),"--surface":rgb(surface),"--muted":rgb(muted),"--border":rgb(border),"--blue":rgb("#268bd2"),"--green":rgb("#859900"),"--red":rgb("#dc322f"),"--yellow":rgb("#b58900"),"--purple":rgb("#6c71c4"),scheme});
            eq(await tokenValues(second),await tokenValues(page));eq(await tokenValues(embedded),host);
            eq(await embedded.locator("html").getAttribute("data-theme"),null);
            eq(await page.getByRole("switch",{name:"Effects",exact:true}).count(),0);
            await shot(page,`${theme}-settings`);
            await page.locator('[aria-label="Close settings"]').click();
            await query(page,PHRASE,[]);
            await shot(page,`${theme}-home-no-match`);
            await page.locator("#pages-query").fill("");await rows(page,["pill-page"]);
            await page.setViewportSize({width:430,height:760});await shot(page,`${theme}-narrow-home`);
            eq(await page.locator(".pages-controls").evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
            await page.locator('[data-document-id="pill-page"] .page-open').click();await page.waitForSelector(".session-ref");
            await shot(page,`${theme}-narrow-doc`);
            await page.locator("#home").click();await current(page);await page.setViewportSize({width:1100,height:800});
            await page.reload();await current(page);eq((await tokenValues(page)).scheme,scheme);
            await page.locator("#settings-btn").click();eq(await page.locator(`[data-t="${theme}"]`).getAttribute("aria-checked"),"true");
            const persisted=readFileSync(join(data.root,"settings.json"),"utf8");
            const fail=async route=>route.request().method()==="POST"?route.fulfill({status:403,contentType:"application/json",body:'{"error":"synthetic settings denial"}'}):route.continue();
            await page.route("**/api/settings",fail);
            await page.getByRole("radio",{name:"Light",exact:true}).click();await page.waitForSelector('#toast:not([hidden])');
            eq(await page.locator("html").getAttribute("data-theme"),theme);eq(readFileSync(join(data.root,"settings.json"),"utf8"),persisted);
            await page.unroute("**/api/settings",fail);
        }
        for(const theme of ["auto","light","dark","win3","win95","vista","future","arcade"]){
            await page.locator(`[data-t="${theme}"]`).click();await page.reload();await current(page);
            eq(await page.locator("html").getAttribute("data-theme"),theme);
            if(["auto","light","dark"].includes(theme)){
                for(const os of ["light","dark"]){
                    await page.emulateMedia({colorScheme:os});
                    const dark=theme==="dark"||theme==="auto"&&os==="dark";
                    eq((await tokenValues(page))["--bg"],rgb(dark?"#0d1117":"#ffffff"));
                    eq((await tokenValues(page))["--fg"],rgb(dark?"#e6edf3":"#1f2328"));
                }
            }
            await page.locator("#settings-btn").click();
        }
        await page.locator('[data-t="solarized-light"]').click();eq((await tokenValues(page))["--bg"],rgb("#fdf6e3"));
        eq(await page.locator("#boot").count(),0);eq(await tokenValues(embedded),host);
    },{fixture:{attachments:{"settings.json":JSON.stringify({theme:"auto",effects:false,shortcuts:{jump:false},interrupt:{doc:true,command:false},command:{worktrees:true}})}}});

    for(const theme of ["solarized-light","solarized-dark"])await withPage(`TC20 ${theme} fresh window and real process restart`,[pillDoc],async({page,context,worker,restart,data})=>{
        await query(page,"retained",[]);await select(page,"sort","created-asc");await page.locator("#pages-from").fill("2026-10-01");await rows(page,[]);
        const values=await page.locator(".pages-controls input,.pages-controls select").evaluateAll(els=>els.map(el=>el.value));
        await page.locator("#settings-btn").click();
        const saved=page.waitForResponse(response=>response.url().endsWith("/api/settings")&&response.request().method()==="POST");
        await page.locator(`[data-t="${theme}"]`).click();eq((await saved).status(),200);
        eq(await page.locator(".pages-controls input,.pages-controls select").evaluateAll(els=>els.map(el=>el.value)),values);
        const settings=JSON.parse(readFileSync(join(data.root,"settings.json"),"utf8"));
        eq(settings.theme,theme);
        eq([settings.effects,settings.shortcuts.jump,settings.interrupt,settings.command.worktrees],[false,false,{doc:true,command:false},true]);
        const fresh=async(worker,instance)=>{
            const panel=await context.newPage();
            await panel.addInitScript(()=>{
                new MutationObserver(()=>{
                    if(!globalThis.firstHomeTheme&&document.querySelector(".home"))globalThis.firstHomeTheme=document.documentElement.dataset.theme;
                }).observe(document,{childList:true,subtree:true});
            });
            await panel.goto((await worker.call("open",{instance})).url);await current(panel);
            eq(await panel.evaluate(()=>globalThis.firstHomeTheme),theme);
            eq(await panel.locator("html").getAttribute("data-theme"),theme);
            eq((await tokenValues(panel))["--bg"],rgb(theme==="solarized-light"?"#fdf6e3":"#002b36"));
            await panel.locator("#settings-btn").click();eq(await panel.locator(`[data-t="${theme}"]`).getAttribute("aria-checked"),"true");
            eq(await panel.locator("#boot").count(),0);
            await panel.close();
        };
        await fresh(worker,"browser-fresh-third");
        const restarted=await restart();await fresh(restarted,"browser-restarted");
        eq(JSON.parse(readFileSync(join(data.root,"settings.json"),"utf8")),settings);
    },{fixture:{attachments:{"settings.json":JSON.stringify({theme:"auto",effects:false,shortcuts:{jump:false},interrupt:{doc:true,command:false},command:{worktrees:true}})}}});

    for(const theme of ["solarized-light","solarized-dark"])await withPage(`TC21 ${theme} representative normal and narrow real tabs`,[pillDoc],async({page,worker})=>{
        await worker.call("scene",{documentId:"pill-page"});await rows(page,["pill-page"]);
        await page.locator("#settings-btn").click();await page.locator(`[data-t="${theme}"]`).click();await page.locator('[aria-label="Close settings"]').click();
        const readable=async(selector)=>{
            const snapshot=await page.waitForFunction(selector=>{
                const values=[...document.querySelectorAll(selector)].filter(el=>el.getBoundingClientRect().width>0).map(el=>{
                const s=getComputedStyle(el);let node=el,bg;
                while(node){bg=getComputedStyle(node).backgroundColor;if(bg!=="rgba(0, 0, 0, 0)"&&bg!=="transparent")break;node=node.parentElement;}
                return {text:el.textContent.trim(),color:s.color,bg,border:s.borderColor};
                });
                return values.length?values:false;
            },selector);
            const values=await snapshot.jsonValue();await snapshot.dispose();
            assert.ok(values.length,selector);assert.ok(values.every(value=>value.color!==value.bg),JSON.stringify(values));assertions++;
        };
        for(const [width,height,size]of [[1100,800,"normal"],[430,760,"narrow"]]){
            await page.setViewportSize({width,height});await current(page);await readable(".pages-controls label,.page-open,.page-archive");
            await page.locator("#pages-query").focus();
            eq(await page.locator("#pages-query").evaluate(el=>getComputedStyle(el).outlineColor),rgb("#268bd2"));
            await shot(page,`${theme}-${size}-home-results`);
            await query(page,"unmatched-term",[]);await shot(page,`${theme}-${size}-home-no-match`);
            const failed=await hold(page,url=>url.searchParams.get("query")==="synthetic-error",403);
            await page.locator("#pages-query").fill("synthetic-error");await failed.seen;await failed.release();
            await page.waitForSelector('.home[data-state="error"]');await readable("#pages-status");await shot(page,`${theme}-${size}-home-error`);
            await failed.remove();await query(page,"",["pill-page"]);
            await page.locator('[data-document-id="pill-page"] .page-open').click();await page.waitForSelector(".session-ref");
            eq(await page.locator(".doc[data-print-title]").getAttribute("data-print-title"),"Synthetic reference page");
            await readable(".b-markdown p,.session-ref,.code,.caption");await shot(page,`${theme}-${size}-doc`);
            await page.getByRole("button",{name:"Inspect Synthetic sequence",exact:true}).click();await page.waitForSelector("#peek .session-ref");
            await readable("#peek .insp-note,.insp-step");await shot(page,`${theme}-${size}-inspect`);await page.locator("#peek-close").click();
            await worker.call("emit",{events:[
                {type:"user.message",id:`theme-user-${size}`,data:{content:`First line\n${R}\n**not Markdown**`}},
                {type:"assistant.message",data:{messageId:`theme-assistant-${size}`,content:`Assistant ${R}`}},
            ]});
            await page.locator("#chat-btn").click();await page.waitForSelector("#chat .session-ref");await readable("#chat .chat-msg");
            await shot(page,`${theme}-${size}-chat`);await page.locator("#chat-close").click();
            for(const [tab,selector,content]of [
                ["command",".phase-row","Readable implementation"],["prs",".pr-row","Synthetic pull request"],
                ["diff",".file-h","fixture.mjs"],["commits",".list-row","Synthetic after"],["history",".list-row.clickable",null],
            ]){
                const visibleSelector=tab==="command"&&width<700?".timeline .seg":selector;
                await page.locator(`#tabs [data-tab="${tab}"]`).click();await page.waitForSelector(visibleSelector);
                if(content)assert.match(await page.locator("#main").innerText(),new RegExp(content.replace(".","\\.")));
                if(tab==="command")eq(await page.locator(".phase-row").count(),2);
                if(tab==="prs"){await page.waitForSelector(".pr-checks .bad");await readable(".pr-pill,.pr-checks,.pr-title");}
                if(tab==="diff"){await page.locator(".file-h").click();await page.waitForSelector(".file-body .ln.add");}
                await readable(visibleSelector);eq(await page.locator(".doc[data-print-title]").count(),0);
                await shot(page,`${theme}-${size}-${tab}`);
            }
            await page.locator("#home").click();await current(page);
            await page.locator("#settings-btn").click();await page.waitForSelector(`[data-t="${theme}"][aria-checked="true"]`);
            eq(await page.locator("#settings").evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=7&&r.right<=innerWidth-7;}),true);
            eq(await page.locator('[data-t^="solarized-"] .set-tl').evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth+1)),true);
            await readable(`[data-t="${theme}"]`);await shot(page,`${theme}-${size}-settings`);
            await page.locator('[aria-label="Close settings"]').click();
        }
    },{fixture:{attachments:{"settings.json":JSON.stringify({theme:"auto",effects:false})}}});

    console.log(`pages-ui: ${cases} cases, ${assertions} assertions passed; screenshots: ${out}`);
} finally { await browser.close(); }
