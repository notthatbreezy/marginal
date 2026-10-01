// Headless (Edge, nothing takes focus) UI test of the Pull requests tab on the dev scenario (tools/demos/pr-scenario.mjs):
// exact oracles for the list (P1, P2) and, with --detail, the detail view (P3, P5, P9).
// Usage: node tools/demos/prs-ui-test.mjs [--detail] [--out=dir]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const out = argv.find((a) => a.startsWith("--out="))?.slice(6) ?? null;
if (out) mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: ok ? "" : detail });
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const b = await chromium.launch({ channel: "msedge", headless: true });
const promptLog = join(mkdtempSync(join(tmpdir(), "mg-prompts-")), "prompts.jsonl");
const prompts = () => (existsSync(promptLog) ? readFileSync(promptLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const d = spawn(process.execPath, [join(root, "tools/devserver.mjs"), "--single", "--prs", "--seconds=180"], { windowsHide: true, env: { ...process.env, PR_REVIEW_MS: "7000", PROMPT_LOG: promptLog } });
let errOut = "";
d.stderr.on("data", (x) => (errOut += x));
d.info = await new Promise((res, rej) => {
    let s = "";
    d.stdout.on("data", (x) => {
        s += x;
        const m = s.match(/\{.*\}/s);
        if (m) try { res(JSON.parse(m[0])); } catch {}
    });
    d.on("exit", () => rej(new Error(errOut)));
});
const errors = [];
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const shot = (name) => out && p.screenshot({ path: join(out, `${name}.png`) });
const rows = () =>
    p.evaluate(() =>
        [...document.querySelectorAll(".pr-list tbody tr")].map((r) => {
            const td = [...r.querySelectorAll("td")];
            return {
                num: r.querySelector(".pr-num")?.textContent,
                depth: Math.round(parseFloat(r.querySelector(".pr-title").style.paddingLeft || "0") / 18),
                state: td[1].innerText.trim(),
                review: td[2].innerText.trim(),
                checks: td[3].innerText.replace(/\s+/g, " ").trim(),
                checksTitle: td[3].querySelector(".pr-checks")?.title ?? "",
                comments: td[4].innerText.replace(/\s+/g, " ").trim(),
                watching: td[5].innerText.replace(/\s+/g, " ").trim(),
            };
        }),
    );

try {
    await p.goto(`${d.info.url}&tab=prs`);
    await p.waitForFunction(() => document.querySelectorAll(".pr-list tbody tr").length === 4 && ![...document.querySelectorAll(".pr-list tbody tr")].some((r) => /…/.test(r.children[1].innerText)), null, { timeout: 20000 });
    await shot("list");
    // ---- P1: every row equals the scenario exactly
    const r = await rows();
    eq("P1 order and stacking", r.map((x) => [x.num, x.depth]), [["#41", 0], ["#42", 1], ["#43", 2], ["#38", 0]]);
    eq("P1 states", r.map((x) => x.state), ["Open", "Open", "Draft", "Merged"]);
    eq("P1 review decisions", r.map((x) => x.review), ["Changes requested", "Approved", "No decision", "Approved"]);
    eq("P1 checks", r.map((x) => x.checks), ["✓ 11 ✗ 1", "✓ 12 ● 1", "✓ 9 ● 3", "✓ 14"]);
    check("P1 failing check names on hover", r[0].checksTitle.startsWith("Failing: lint (eslint)"), r[0].checksTitle);
    eq("P1 unresolved / total", r.map((x) => x.comments), ["1 unresolved / 8", "0 unresolved / 1", "0 unresolved / 0", "0 unresolved / 9"]);
    eq("P1 watching", r.map((x) => x.watching), ["Handling: up to Push & resolve", "Watching notes new comments in the chat", "Watching just shows new comments", "Stopped: merged Turn watching on to start again"]);
    eq("P1 tab label", await p.locator('#tabs [data-tab="prs"]').innerText(), "Pull requests · 4");

    // ---- P2: a pasted URL appears without a reload; a duplicate in another form is refused; GHE URLs parse
    const input = p.locator(".pr-add-url");
    await input.fill("https://acme.ghe.com/acme/relay/pull/77");
    await p.locator(".pr-bar .pr-btn").click();
    await p.waitForFunction(() => document.querySelectorAll(".pr-list tbody tr").length === 5, null, { timeout: 8000 }).catch(() => {});
    const added = (await rows()).find((x) => x.num === "#77");
    check("P2 pasted GHE URL listed live", !!added, JSON.stringify(await rows()));
    await p.waitForFunction(() => document.querySelector('#tabs [data-tab="prs"]').innerText === "Pull requests · 5", null, { timeout: 5000 }).catch(() => {});
    eq("P2 tab count follows", await p.locator('#tabs [data-tab="prs"]').innerText(), "Pull requests · 5");
    await input.fill("https://github.com/ACME/relay/pull/41/files");
    await p.locator(".pr-bar .pr-btn").click();
    await p.waitForTimeout(600);
    eq("P2 duplicate refused (same PR, other URL form)", (await rows()).length, 5);
    eq("P2 duplicate says so", await p.locator("#toast").innerText(), "It's already on this doc.");
    await input.fill("https://github.com/acme/relay/issues/9");
    await p.locator(".pr-bar .pr-btn").click();
    await p.waitForTimeout(400);
    check("P2 a non-PR URL is refused with a reason", /pull request URL looks like/.test(await p.locator("#toast").innerText()), await p.locator("#toast").innerText());

    // a URL being typed survives the list re-rendering under it (every update re-renders)
    await input.fill("https://github.com/acme/rel");
    await input.focus();
    // a PR registered with stacksOn (the same register the pr action uses) appears live, under its base
    const docId = d.info.docId;
    const top = await p.evaluate(() => [...document.querySelectorAll(".pr-list tbody tr")].find((r) => r.querySelector(".pr-num")?.textContent === "#43")?.dataset.pr);
    await p.evaluate(async ({ docId, top }) => {
        await fetch(`/api/prs/add?doc=${encodeURIComponent(docId)}`, { method: "POST", headers: { "x-wb-token": new URLSearchParams(location.search).get("t"), "content-type": "application/json" }, body: JSON.stringify({ url: "https://github.com/acme/relay/pull/44", stacksOn: top }) });
    }, { docId, top });
    await p.waitForFunction(() => [...document.querySelectorAll(".pr-list tbody tr .pr-num")].some((n) => n.textContent === "#44"), null, { timeout: 8000 }).catch(() => {});
    const r44 = (await rows()).find((x) => x.num === "#44");
    check("P2 a stacked PR registered meanwhile appears live, under its base", r44?.depth === 3, JSON.stringify(await rows()));
    eq("P2 what you were typing in the URL box survives the re-render, still focused", await p.evaluate(() => { const i = document.querySelector(".pr-add-url"); return [i.value, document.activeElement === i]; }), ["https://github.com/acme/rel", true]);
    await input.fill("");
    eq("P2 the index holds exactly the PRs added (4 + pasted + stacked)", (await rows()).length, 6);

    // ---- live: the scripted review reaches #41 and Copilot handles it, with no reload
    await p.waitForFunction(() => /queued for Copilot|Copilot is on|sending/.test(document.querySelector(".pr-list tbody tr")?.innerText ?? ""), null, { timeout: 30000 });
    await shot("list-handling");
    const during = (await rows())[0];
    check("live: new comments badge", /^3 new ?3 unresolved \/ 10$/.test(during.comments), during.comments);
    check("live: the batch is shown", /Handling: up to Push & resolve 3 new comments (queued for Copilot|…)|Copilot is on 3 new comments/.test(during.watching), during.watching);
    await p.waitForFunction(() => /last batch done/.test(document.querySelector(".pr-list tbody tr")?.innerText ?? ""), null, { timeout: 45000 });
    await p.waitForFunction(() => /1 unresolved \/ 10/.test(document.querySelector(".pr-list tbody tr")?.innerText ?? ""), null, { timeout: 20000 }).catch(() => {});
    await shot("list-after");
    const done = (await rows())[0];
    check("live: Copilot's replies and resolutions observed (2 of the 3 open threads resolved)", /1 unresolved \/ 10/.test(done.comments), done.comments);

    // ---- a PR Marginal can't check (the dev gh isn't logged in to acme.ghe.com): row, tab label, chat note, detail
    await p.waitForFunction(() => [...document.querySelectorAll(".pr-list tbody tr")].some((r) => /^#77/.test(r.innerText) && /Can't check GitHub/.test(r.innerText)), null, { timeout: 10000 }).catch(() => {});
    const r77 = (await rows()).find((x) => x.num === "#77");
    // #77 (acme.ghe.com: not logged in) and #44 (github.com: no repo behind it, a 404 for every account)
    check("auth: the row says Marginal can't check it, why, what to run, and when it tries again", /^Can't check GitHub gh isn't logged in to acme\.ghe\.com\. Run: gh auth login --hostname acme\.ghe\.com Next try \d{1,2}:\d{2}/.test(r77?.watching ?? ""), r77?.watching);
    await p.waitForFunction(() => document.querySelector('#tabs [data-tab="prs"] .tab-n')?.classList.contains("warn"), null, { timeout: 5000 }).catch(() => {});
    eq("auth: the tab label is marked, and says why on hover", await p.evaluate(() => { const n = document.querySelector('#tabs [data-tab="prs"] .tab-n'); return [n.classList.contains("warn"), n.title]; }), [true, "Marginal can't check 2 pull requests on GitHub"]);
    const r44b = (await rows()).find((x) => x.num === "#44");
    check("auth: a repo no account can see says so (not a bare 404), naming the accounts tried", /^Can't check GitHub None of your gh accounts on github\.com \(you\) can see acme\/relay#44: the repository is private to them, or the PR doesn't exist\. To add an account that can: gh auth login --hostname github\.com Next try \d{1,2}:\d{2}/.test(r44b?.watching ?? ""), r44b?.watching);
    await p.keyboard.press("Control+i");
    await p.waitForSelector("#chat:not([hidden])", { timeout: 5000 });
    await p.waitForFunction(() => /Marginal can't check #77/.test(document.querySelector("#chat-log")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
    await p.evaluate(() => document.querySelector("#chat-log .chat-notice:last-of-type")?.scrollIntoView({ block: "end" }));
    const notes = await p.evaluate(() => [...document.querySelectorAll("#chat-log .chat-notice")].map((n) => n.innerText.replace(/\s+/g, " ")));
    const n77 = notes.filter((t) => /#77/.test(t));
    check("auth: the chat hears once, from Marginal (no agent turn)", n77.length === 1 && /^Marginal can't check #77 \(acme\/relay\) on GitHub, so new review comments on it won't be handled until it can\. gh isn't logged in to acme\.ghe\.com\. Run: gh auth login --hostname acme\.ghe\.com From Marginal · Pull requests Show the PR$/.test(n77[0]), JSON.stringify(notes));
    check("auth: no prompt went to Copilot for it", !prompts().some((x) => /#77|acme\/relay\/pull\/77/.test(x.prompt)), "a prompt mentioned #77");
    await shot("auth-chat-note");
    await p.locator("#chat-log .chat-notice", { hasText: "#77" }).locator(".cn-open").click();
    await p.waitForSelector(".pr-detail .pr-fail", { timeout: 8000 }).catch(() => {});
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    await shot("auth-detail");
    const fail = await p.evaluate(() => ({
        head: document.querySelector(".pr-detail")?.innerText.replace(/\s+/g, " ").slice(0, 40),
        box: document.querySelector(".pr-fail")?.innerText.replace(/\s+/g, " "),
        railNote: document.querySelectorAll(".pr-rail .pr-note.warn").length,
        sub: document.querySelector(".pr-switch .pr-sub")?.innerText,
    }));
    check("auth: Show the PR opens #77's detail", /#77/.test(fail.head ?? ""), JSON.stringify(fail));
    check("auth: the detail says what's wrong once, with when it retries and Try again now", /^Marginal can't check this PR on GitHub gh isn't logged in to acme\.ghe\.com\. Run: gh auth login --hostname acme\.ghe\.com It tries again at \d{1,2}:\d{2}.*, and backs off up to every 10 minutes\. Try again now$/.test(fail.box ?? "") && fail.railNote === 0, JSON.stringify(fail));
    check("auth: the rail doesn't claim it checks every minute", /^can't check GitHub; next try \d{1,2}:\d{2}/.test(fail.sub ?? ""), fail.sub);
    await p.locator("button", { hasText: "All pull requests" }).click();
    await p.waitForSelector(".pr-list tbody tr");

    if (argv.includes("--detail")) {
        const detail = await import("./prs-ui-detail.mjs");
        await detail.run({ p, rows, check, eq, shot, url: d.info.url, prompts });
    }
} catch (e) {
    check("no exception", false, e.stack);
} finally {
    check("no page errors", !errors.length, errors.join("\n"));
    d.kill();
    await b.close();
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
