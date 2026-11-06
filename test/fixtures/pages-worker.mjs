import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { actionProbe } from "./pages-actions.mjs";
import { harness as h, emit, observeHooks } from "./pages-sdk.mjs";
import { directoryBytes, PHRASE, storeProbe } from "./pages.mjs";
import * as store from "../../extensions/marginal/lib/store.mjs";
import * as owner from "../../extensions/marginal/lib/command/owner.mjs";
import * as command from "../../extensions/marginal/lib/command/index.mjs";
import * as commandState from "../../extensions/marginal/lib/command/state.mjs";
import * as poller from "../../extensions/marginal/lib/command/poller.mjs";

const root = process.env.MARGINAL_DATA_DIR;
const instanceId = "panel-actions";
const NativeDate = Date;
function wallTime(iso) {
    const epoch = NativeDate.parse(iso);
    globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [epoch])); }
        static now() { return epoch; }
    };
}
const canvas = (name, input = {}) => {
    const action = h.canvas.actions.find((action) => action.name === name);
    assert.ok(action, `registered canvas action ${name}`);
    return action.handler({ input, instanceId, sessionId: "session-page-tests" });
};
const headless = (name, input = {}) => h.registration.tools.find((tool) => tool.name === "marginal").handler({ action: name, input });
const rows = (docs) => docs.map((doc) => doc.documentId);
const expectedRows = (ids) => ["scratchpad", ...ids];

async function eventsAt(base, token) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events?instance=${instanceId}`, { headers: { "x-wb-token": token }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const events = [], waiting = new Set();
    const task = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                let end;
                while ((end = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    if (!frame.startsWith("data: ")) continue;
                    events.push(JSON.parse(frame.slice(6)));
                    for (const notify of waiting) notify();
                }
            }
        } catch (error) { if (!controller.signal.aborted) throw error; }
    })();
    const wait = (predicate) => {
        if (events.some(predicate)) return Promise.resolve(events.find(predicate));
        return new Promise((resolve, reject) => {
            const notify = () => {
                const event = events.find(predicate);
                if (event) { clearTimeout(timer); waiting.delete(notify); resolve(event); }
            };
            const timer = setTimeout(() => { waiting.delete(notify); reject(new Error("Timed out awaiting actual SSE event")); }, 3000);
            waiting.add(notify);
        });
    };
    await wait((event) => event.type === "show");
    return { events, wait, close: async () => { controller.abort(); await reader.cancel().catch(() => {}); await task; } };
}

export async function run(scenario) {
    let stream;
    const restores = [];
    try {
        await import("../../extensions/marginal/extension.mjs");
        assert.deepEqual([...h.modules.values()], Array(9).fill(1), "one evaluation per original observed production module, including store and Command state");
        const opened = await h.canvas.open({ instanceId, input: { documentId: scenario.id ?? scenario.ids?.[0] ?? "scratchpad" } });
        const url = new URL(opened.url), token = url.searchParams.get("t"), base = url.origin;
        const api = async (path, body, headers = { "x-wb-token": token }) => {
            const response = await fetch(`${base}/api${path}`, {
                method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: await response.json() };
        };
        const success = async (path, body) => {
            const result = await api(path, body);
            assert.equal(result.status, 200, JSON.stringify(result));
            return result.body;
        };
        const bad = async (path, body, pattern) => {
            const result = await api(path, body);
            assert.equal(result.status, 400, JSON.stringify(result));
            assert.deepEqual(Object.keys(result.body), ["error"]);
            assert.match(result.body.error, pattern);
        };
        const rejectAgent = async (action, input, pattern) => {
            await assert.rejects(canvas(action, input), (error) => error.code === "invalid_input" && pattern.test(error.message));
            const result = await headless(action, input);
            assert.equal(result.resultType, "failure", JSON.stringify(result));
            assert.match(result.textResultForLlm, pattern);
        };
        const allBoundaries = async (cases) => {
            const before = directoryBytes(root), events = [];
            const off = store.subscribe("*", (event) => events.push(event));
            const cached = scenario.ids.map((id) => structuredClone(store.getDoc(id)));
            try {
                for (const [raw, ids] of cases) {
                    const http = await success(`/catalog?${new URLSearchParams(raw)}`);
                    const actualCanvas = await canvas("list", raw), actualHeadless = await headless("list", raw);
                    for (const docs of [http, actualCanvas.docs, actualHeadless.docs]) {
                        assert.deepEqual(rows(docs), expectedRows(ids), JSON.stringify(raw));
                        for (const doc of docs) {
                            assert.ok(Object.hasOwn(doc, "archivedAt"));
                            for (const key of Object.keys(doc)) assert.ok(["documentId", "kind", "title", "version", "createdAt", "updatedAt", "archivedAt", "blocks", "repository", "target", "pullRequest", "activity"].includes(key), key);
                        }
                    }
                    assert.deepEqual(actualCanvas.repositories, []);
                    assert.deepEqual(actualHeadless.repositories, []);
                }
                assert.deepEqual(scenario.ids.map((id) => store.getDoc(id)), cached);
                assert.deepEqual(events, []);
                assert.deepEqual(directoryBytes(root), before);
            } finally { off(); }
        };

        assert.deepEqual(Object.keys(h.canvas.actions.find((action) => action.name === "list").inputSchema.properties), ["query", "status", "sort", "direction", "dateField", "from", "until"]);
        for (const name of ["archive", "unarchive"]) assert.equal(h.canvas.actions.filter((action) => action.name === name).length, 1);
        assert.deepEqual(h.canvas.actions.find((action) => action.name === "restore").inputSchema.required, ["version"]);

        if (scenario.kind === "catalog") {
            await allBoundaries(scenario.cases);
        } else if (scenario.kind === "invalid") {
            const before = directoryBytes(root), cached = structuredClone(store.getDoc(scenario.id)), events = [];
            restores.push(store.subscribe("*", (event) => events.push(event)));
            for (const [raw, text] of scenario.cases) {
                const pattern = new RegExp(text);
                await bad(`/catalog?${new URLSearchParams(raw)}`, undefined, pattern);
                await rejectAgent("list", raw, pattern);
            }
            await rejectAgent("list", { query: 5 }, /query must be a string/);
            await rejectAgent("list", { query: [] }, /query must be a string/);
            for (const action of ["archive", "unarchive"]) {
                await bad(`/docs/missing/${action}`, {}, /Unknown doc/);
                await rejectAgent(action, { documentId: "missing" }, /Unknown doc/);
                await bad(`/docs/scratchpad/${action}`, {}, /scratchpad cannot/);
                await rejectAgent(action, { documentId: "scratchpad" }, /scratchpad cannot/);
            }
            await rejectAgent("restore", { documentId: scenario.id }, /No version undefined/);
            await rejectAgent("restore", { documentId: scenario.id, version: 999 }, /No version 999/);
            for (const action of ["unknown", "show"]) assert.equal((await headless(action, {})).resultType, "failure");
            assert.deepEqual(events, []);
            assert.deepEqual(store.getDoc(scenario.id), cached);
            assert.deepEqual(directoryBytes(root), before);
        } else if (scenario.kind === "bad-archive") {
            const id = scenario.id, cached = structuredClone(store.getDoc(id)), before = directoryBytes(root), events = [];
            restores.push(store.subscribe("*", (event) => events.push(event)));
            for (const raw of [{}, { query: "unrelated" }, { status: "archived" }, { status: "all" }]) {
                await bad(`/catalog?${new URLSearchParams(raw)}`, undefined, new RegExp(`${id}\\.archivedAt`));
                await rejectAgent("list", raw, new RegExp(`${id}\\.archivedAt`));
            }
            for (const action of ["archive", "unarchive", "rename", "restore"]) {
                const input = { documentId: id, title: "Must not save", version: 1 };
                if (action !== "restore") await bad(`/docs/${id}/${action}`, input, /archivedAt/);
                await rejectAgent(action, input, /archivedAt/);
            }
            await bad(`/docs/${id}`, undefined, /archivedAt/);
            assert.deepEqual((await canvas("read", { documentId: id, full: true })).archivedAt, cached.archivedAt, "raw diagnostic read still retains invalid metadata");
            assert.deepEqual(store.getDoc(id), cached);
            assert.deepEqual(events, []);
            assert.deepEqual(directoryBytes(root), before);
        } else if (scenario.kind === "auth") {
            const before = directoryBytes(root);
            for (const headers of [{}, { "x-wb-token": "wrong" }]) {
                for (const [path, body] of [["/catalog", undefined], ["/docs/arc-one/archive", {}], ["/docs/arc-one/unarchive", {}], ["/settings", { theme: "solarized-dark" }]]) assert.equal((await api(path, body, headers)).status, 403);
            }
            for (const path of ["/api/catalog", "/api/docs/arc-one/archive", "/api/settings", "/references.js"]) {
                const status = await new Promise((resolve, reject) => {
                    const method = path.includes("archive") || path.endsWith("settings") ? "POST" : "GET";
                    const req = request(`${base}${path}`, { method, headers: { Host: "attacker.invalid", Connection: "close", "content-length": method === "POST" ? "2" : "0", "x-wb-token": token } }, (res) => { res.resume(); resolve(res.statusCode); });
                    req.on("error", reject); req.end(method === "POST" ? "{}" : undefined);
                });
                assert.equal(status, 403);
            }
            const staticAsset = await fetch(`${base}/references.js`);
            assert.equal(staticAsset.status, 200);
            assert.match(staticAsset.headers.get("content-type"), /javascript/);
            assert.match(await staticAsset.text(), /export function scanReferences/);
            assert.equal((await fetch(`${base}/not-an-asset`)).status, 404);
            assert.equal((await api(`/catalog?t=${token}`, undefined, {})).status, 200);
            await bad("/docs/missing", undefined, /Unknown doc/);
            await bad("/docs/arc-one/source", { source: {} }, /source.file is required/);
            assert.deepEqual(directoryBytes(root), before);
        } else if (scenario.kind === "mutations") {
            const id = scenario.id;
            stream = await eventsAt(base, token);
            wallTime("2026-11-03T20:00:00.000Z");
            const before = structuredClone(store.getDoc(id)), attachments = directoryBytes(join(root, "docs", id, "attached"));
            const archived = await success(`/docs/${id}/archive`, {});
            assert.equal(archived.version, 3);
            assert.equal(archived.archivedAt, "2026-11-03T20:00:00.000Z");
            assert.equal(archived.createdAt, before.createdAt); assert.equal(archived.updatedAt, before.updatedAt);
            await stream.wait((event) => event.type === "version" && event.reason === "archive");
            await stream.wait((event) => event.type === "catalog");
            const unchanged = directoryBytes(root), eventMark = stream.events.length;
            await success(`/docs/${id}/archive`, {});
            assert.deepEqual(directoryBytes(root), unchanged);
            assert.equal(stream.events.length, eventMark);
            assert.equal((await success(`/docs/${id}`)).doc.archivedAt, archived.archivedAt);
            assert.equal((await canvas("read", { documentId: id, full: true })).archivedAt, archived.archivedAt);
            assert.equal((await headless("read", { documentId: id, full: true })).archivedAt, archived.archivedAt);
            assert.equal((await success(`/docs/${id}/versions/1`)).content[0].markdown, "Old text");
            const reused = await canvas("create", { pullRequestUrl: "https://github.com/acme/app/pull/7", show: false });
            assert.equal(reused.documentId, id); assert.equal(reused.created, false);
            storeProbe(root, `
                const doc=store.getDoc(${JSON.stringify(id)});
                assert.equal(doc.archivedAt,"2026-11-03T20:00:00.000Z");
                assert.equal(doc.version,3);
                assert.equal(store.history(doc.id).find(v=>v.reason==="archive").at,"2026-11-03T20:00:00.000Z");
                assert.equal(store.list({status:"archived"})[1].documentId,doc.id);
            `);
            await actionProbe(root, {
                kind: "restart", id, ids: [id, "delete-me"],
                expected: { version: 3, archivedAt: "2026-11-03T20:00:00.000Z", createdAt: before.createdAt, updatedAt: before.updatedAt },
                cases: [[{ status: "archived" }, ["arc-one"]]],
            });
            wallTime("2026-11-03T20:01:00.000Z");
            await canvas("edit", { documentId: id, edit: { type: "update", targetId: "md-1", changes: { markdown: "Edited while archived" } } });
            assert.equal(store.getDoc(id).archivedAt, archived.archivedAt);
            await stream.wait((event) => event.type === "version" && event.reason === "edit");
            await headless("restore", { documentId: id, version: 1 });
            assert.equal(store.getDoc(id).content[0].markdown, "Old text");
            assert.equal(store.getDoc(id).createdAt, before.createdAt);
            assert.equal(store.getDoc(id).archivedAt, archived.archivedAt);
            wallTime("2026-11-03T20:02:00.000Z");
            await success(`/docs/${id}/unarchive`, {});
            const active = structuredClone(store.getDoc(id));
            assert.equal(active.version, 6); assert.equal(active.archivedAt, null);
            assert.equal(active.updatedAt, "2026-11-03T20:01:00.000Z");
            const noOp = directoryBytes(root);
            await canvas("unarchive", { documentId: id });
            await headless("unarchive", { documentId: id });
            assert.deepEqual(directoryBytes(root), noOp);
            wallTime("2026-11-03T20:03:00.000Z");
            await canvas("restore", { documentId: id, version: 3 });
            assert.equal(store.getDoc(id).archivedAt, null);
            assert.equal(store.getDoc(id).content[0].markdown, "Keep this");
            assert.equal(store.getDoc(id).nextId, before.nextId);
            assert.equal(Object.hasOwn(store.getDoc(id), "savedAt"), false);
            assert.deepEqual(directoryBytes(join(root, "docs", id, "attached")), attachments);
            const history = await success(`/docs/${id}/history`);
            assert.equal(history.find((item) => item.reason === "archive").at, "2026-11-03T20:00:00.000Z");
            assert.equal(history.find((item) => item.reason === "unarchive").at, "2026-11-03T20:02:00.000Z");
            assert.equal(history.find((item) => item.version === 1).at, "2026-09-01T10:00:00.000Z");
            assert.equal((await success("/docs/delete-me/delete", {})).deleted, true);
            assert.equal(store.hasDoc("delete-me"), false);
        } else if (scenario.kind === "restart") {
            const before = directoryBytes(root), events = [];
            restores.push(store.subscribe("*", (event) => events.push(event)));
            const doc = (await success(`/docs/${scenario.id}`)).doc;
            for (const [key, value] of Object.entries(scenario.expected)) assert.deepEqual(doc[key], value, key);
            assert.equal((await canvas("read", { documentId: scenario.id, full: true })).archivedAt, doc.archivedAt ?? null);
            assert.equal((await headless("read", { documentId: scenario.id, full: true })).archivedAt, doc.archivedAt ?? null);
            if (scenario.settings) assert.deepEqual(await success("/settings"), scenario.settings);
            if (scenario.cases) await allBoundaries(scenario.cases);
            assert.deepEqual(events, []);
            assert.deepEqual(directoryBytes(root), before);
        } else if (scenario.kind === "discuss") {
            const id = scenario.id;
            emit({ type: "user.message", id: "msg-unregistered-1", data: { documentId: id, discuss: true } });
            await canvas("archive", { documentId: id });
            await headless("unarchive", { documentId: id });
            const sent = await success(`/ask?instance=${instanceId}`, { documentId: id, message: "Discuss this synthetic page", discuss: true });
            assert.equal(sent.messageId, "msg-discuss-1");
            assert.match(h.sent[0].prompt, /Discuss mode/);
            emit({ type: "user.message", id: sent.messageId, data: {} });
            const before = directoryBytes(root), events = [];
            restores.push(store.subscribe("*", (event) => events.push(event)));
            for (const action of ["archive", "unarchive"]) await rejectAgent(action, { documentId: id }, /Discuss mode/);
            assert.deepEqual(events, []);
            assert.deepEqual(directoryBytes(root), before);
            // Explicit HTTP user mutations retain user policy while agent mutation is guarded.
            await success(`/docs/${id}/archive`, {});
            await success(`/docs/${id}/unarchive`, {});
            emit({ type: "session.idle", data: {} });
            await canvas("archive", { documentId: id });
            await headless("unarchive", { documentId: id });
            assert.equal(store.getDoc(id).archivedAt, null);
        } else if (scenario.kind === "settings") {
            stream = await eventsAt(base, token);
            const fixture = { shortcuts: { jump: false }, effects: false, interrupt: { doc: true, command: false }, command: { worktrees: true } };
            await success("/settings", fixture);
            for (const theme of scenario.themes ?? ["solarized-light", "solarized-dark"]) {
                const saved = await success("/settings", { theme });
                assert.equal(saved.theme, theme); assert.equal(saved.shortcuts.jump, false);
                assert.equal(saved.effects, false); assert.deepEqual(saved.interrupt, fixture.interrupt); assert.deepEqual(saved.command, fixture.command);
                await stream.wait((event) => event.type === "settings" && event.settings.theme === theme);
                const partial = await success("/settings", { shortcuts: { stepKeys: false } });
                assert.equal(partial.theme, theme); assert.equal(partial.shortcuts.jump, false);
                for (const invalid of ["unknown", null, 5, []]) {
                    const fallback = await success("/settings", { theme: invalid });
                    assert.equal(fallback.theme, "auto");
                    assert.equal(fallback.effects, false);
                    assert.deepEqual(fallback.interrupt, fixture.interrupt);
                    assert.equal(fallback.shortcuts.jump, false);
                }
                await success("/settings", { theme });
                assert.equal(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).theme, theme);
                storeProbe(root, `
                    const {readSettings}=await import(${JSON.stringify(new URL("../../extensions/marginal/lib/settings.mjs", import.meta.url).href)});
                    assert.equal(readSettings().theme,${JSON.stringify(theme)});
                    assert.equal(readSettings().effects,false);
                `);
            }
            const saved = await success("/settings");
            return { kind: scenario.kind, settings: saved };
        } else if (scenario.kind === "lifecycle") {
            const id = scenario.id, service = h.service, watcher = h.watcher;
            assert.equal(service.watcher, watcher, "same actual factory-returned watcher, not a second state instance");
            service.register(id, { url: h.world.ident.url, settings: { watch: true, handle: "read" } });
            await watcher.settled();
            assert.equal(service.ownership(id).here, true);
            assert.deepEqual(watcher.watching(), [id]);
            const tick = async () => {
                const mark = h.world.calls.length;
                await h.clock.advance(60_000, () => watcher.settled());
                assert.ok(h.world.calls.slice(mark).some((call) => call.kind === "rest" && call.args.some((arg) => arg.startsWith("If-Modified-Since: "))), "real conditional fake-GitHub fetch after transition");
                assert.deepEqual(watcher.watching(), [id]);
            };
            await tick();
            restores.push(observeHooks(store.beforeRemove, "beforeRemove"), observeHooks(command.cleanupHooks, "cleanupHooks"));
            const oracle = () => {
                assert.deepEqual(h.calls, [], "no transparent stop/cleanup edge called");
                assert.deepEqual(watcher.watching(), [id]);
            };
            for (const action of ["archive", "unarchive"]) {
                const before = structuredClone(store.getDoc(id));
                const bytes = directoryBytes(root);
                const attached = Object.fromEntries(Object.entries(bytes).filter(([path]) => !/[\\/]versions[\\/]|[\\/]current\.json$/.test(path)));
                h.calls.length = 0; h.armed = true;
                if (scenario.boundary === "http") await success(`/docs/${id}/${action}`, {});
                else if (scenario.boundary === "canvas") await canvas(action, {});
                else {
                    const result = await headless(action, { documentId: id });
                    assert.notEqual(result.resultType, "failure", JSON.stringify(result));
                }
                oracle();
                const after = store.getDoc(id);
                for (const key of ["id", "kind", "title", "content", "createdAt", "updatedAt", "target", "pullRequest", "nextId"]) assert.deepEqual(after[key], before[key], key);
                const afterBytes = directoryBytes(root);
                assert.deepEqual(Object.fromEntries(Object.entries(afterBytes).filter(([path]) => !/[\\/]versions[\\/]|[\\/]current\.json$/.test(path))), attached);
                await tick(); oracle();
                h.armed = false;
            }
            const bytes = directoryBytes(root);
            h.calls.length = 0; h.armed = true;
            watcher.unwatch(id);
            assert.deepEqual(directoryBytes(root), bytes);
            assert.equal(h.calls.filter((call) => call.name === "beforeRemove").length, 0);
            assert.deepEqual(h.calls.map((call) => call.name), ["prs.unwatch"]);
            assert.deepEqual(watcher.watching(), []);
            assert.throws(oracle, /transparent stop\/cleanup/, "byte-only oracle passes, actual lifecycle oracle decisively fails");
            const mark = h.world.calls.length;
            await h.clock.advance(60_000, () => watcher.settled());
            assert.equal(h.world.calls.length, mark, "real unwatch stops next conditional fetch");
            h.armed = false;
        } else throw new Error(`Unknown scenario ${scenario.kind}`);
        return { kind: scenario.kind, ok: true };
    } finally {
        h.armed = false;
        globalThis.Date = NativeDate;
        await stream?.close();
        for (const restore of restores.reverse()) restore();
        h.watcher?.stopAll();
        await h.watcher?.settled();
        h.missionStop?.();
        for (const id of owner.heldHere()) owner.stopHeartbeat(id);
        for (const id of ["arc-live", "arc-one", ...(scenario.ids ?? [])]) { poller.stopAll(id); commandState.unwatchCommand(id); }
        for (const server of h.servers) {
            server.server.closeAllConnections();
            await new Promise((resolve, reject) => server.server.close((error) => error ? reject(error) : resolve()));
        }
    }
}

if (process.send) {
    process.once("message", async (scenario) => {
        try { process.send({ kind: "result", value: await run(scenario) }); }
        catch (error) { console.error(error.stack); process.exitCode = 1; }
        finally { process.disconnect(); }
    });
    process.send({ kind: "ready" });
}
