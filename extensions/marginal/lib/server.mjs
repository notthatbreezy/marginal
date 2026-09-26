// Loopback HTTP server for the panel iframe: static assets, JSON reads, SSE pushes.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { InputError } from "./errors.mjs";
import { diffFiles, diffPatch, getRepository, listCommits, listTree, parsePatch, readFileAt } from "./git.mjs";
import { fileHunks, filePatch } from "./command/hunks.mjs";
import { locIndex } from "./command/loc.mjs";
import { readLease } from "./command/owner.mjs";
import { activity } from "./command/index.mjs";
import { revisingStatus } from "./command/walkthrough.mjs";
import { eventsSince, lastSeq, onCommand, readPrefs, readState, refreshLog, watchCommand, writePrefs } from "./command/state.mjs";
import * as store from "./store.mjs";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const MAX_BODY = 256 * 1024;

function send(res, status, body, type = "application/json; charset=utf-8") {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new InputError("Request body too large."));
                req.destroy();
            } else chunks.push(c);
        });
        req.on("end", () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
            } catch {
                reject(new InputError("Invalid JSON body."));
            }
        });
        req.on("error", reject);
    });
}

/** Resolve the pins and commit a source reference reads from. */
function resolveSourcePins(doc, source) {
    const pins = source.pins ?? doc?.target;
    if (!pins) throw new InputError("This reference has no pins.");
    const side = source.side ?? "head";
    const commit = side === "base" ? pins.base : pins.head;
    if (!commit) throw new InputError("No commit for that side.");
    return { pins, side, commit };
}

async function sourceSlice(doc, source) {
    const { pins, side, commit } = resolveSourcePins(doc, source);
    const file = await readFileAt(pins.repositoryId, commit, source.file);
    if (!file.exists) throw new InputError(`${source.file} does not exist at ${commit.slice(0, 8)}.`);
    const start = source.startLine ?? 1;
    const end = source.endLine ?? source.startLine ?? file.lines.length;
    const result = {
        file: source.file,
        side,
        commit,
        repository: getRepository(pins.repositoryId).name,
        startLine: start,
        endLine: end,
        total: file.lines.length,
        lines: file.lines.slice(start - 1, end).map((text, i) => ({ n: start + i, text })),
    };
    if (source.diff && pins.base && pins.base !== pins.head) {
        // Whole-file diff with full context, then slice the rows spanning the range on the source's side.
        const [f] = parsePatch(await diffPatch(pins.repositoryId, pins.base, pins.head, [source.file], { context: 100000 }));
        const rows = f?.hunks.flatMap((h) => h.lines) ?? [];
        const key = side === "base" ? "base" : "head";
        const first = rows.findIndex((r) => r[key] !== undefined && r[key] >= start);
        let last = -1;
        rows.forEach((r, i) => {
            if (r[key] !== undefined && r[key] <= end) last = i;
        });
        if (first >= 0 && last >= first) {
            // Include deletions/additions that sit just after the range's last line.
            while (last + 1 < rows.length && rows[last + 1][key] === undefined) last++;
            const slice = rows.slice(first, last + 1);
            // A diff only helps when the range mixes old and new code; all-added or unchanged ranges read better as plain code.
            const kinds = new Set(slice.map((r) => r.kind));
            if (kinds.has("del") || (kinds.has("add") && kinds.has("ctx"))) result.diff = slice;
        }
    }
    return result;
}

export async function startServer({ chat, instances, getSessionId }) {
    const token = randomBytes(18).toString("base64url");
    const clients = new Set(); // { res, instanceId }

    function push(client, event) {
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    chat.subscribe((event) => {
        for (const c of clients) if (c.instanceId === event.instanceId) push(c, event);
    });

    store.subscribe("*", (event) => {
        for (const c of clients) {
            const shown = instances.get(c.instanceId)?.documentId ?? null;
            if (event.type === "catalog") push(c, event);
            else if (event.documentId && event.documentId === shown) push(c, event);
        }
    });

    // Command center: one SSE event type with a `kind`; live change events travel as deltas, never as doc versions.
    onCommand((event) => {
        for (const c of clients) {
            const shown = instances.get(c.instanceId)?.documentId ?? null;
            if (event.documentId === shown) push(c, { type: "command", ...event });
        }
    });

    function notifyShow(instanceId) {
        const documentId = instances.get(instanceId)?.documentId ?? null;
        for (const c of clients) if (c.instanceId === instanceId) push(c, { type: "show", documentId });
    }

    const docFor = (id) => store.getDoc(decodeURIComponent(id));

    /** /api/command/{state,events,tree,prefs}?doc=… (hunks and walkthrough routes arrive in later milestones). */
    async function commandRoute(req, res, url, sub) {
        const doc = store.getDoc(url.searchParams.get("doc") ?? "");
        if (!doc.target) throw new InputError("This doc has no repository target.");
        watchCommand(doc.id);
        const repo = getRepository(doc.target.repositoryId);
        const what = sub[0];
        if (what === "state" && req.method === "GET") {
            const lease = readLease(doc.id);
            return send(res, 200, { state: readState(doc.id), prefs: readPrefs(doc.id), lease, isOwnerHere: !!lease?.live && lease.sessionId === getSessionId?.(), revising: revisingStatus(doc.id), seq: lastSeq(doc.id), repository: repo.name, target: doc.target });
        }
        if (what === "events" && req.method === "GET") {
            const since = Number(url.searchParams.get("since") ?? 0) || 0;
            refreshLog(doc.id);
            return send(res, 200, { events: eventsSince(doc.id, since), seq: lastSeq(doc.id) });
        }
        if (what === "tree" && req.method === "GET") return send(res, 200, await locIndex(repo.id, repo.path));
        if (what === "init" && req.method === "POST") {
            // "Initialize command center": ask this panel's session to become the orchestrator and set the plan.
            const lease = readLease(doc.id);
            if (lease?.live && lease.sessionId !== getSessionId?.()) throw new InputError(`Session ${lease.sessionId} already orchestrates this doc; open it there.`);
            const body = await readBody(req);
            const goal = typeof body?.goal === "string" ? body.goal.trim().slice(0, 2000) : "";
            const st = readState(doc.id);
            const t = doc.target;
            const lines = [
                `[Command center: initialize on "${doc.title}" (documentId: ${doc.id})]`,
                goal ? `The user's goal: ${goal}` : "The user didn't give a goal; infer it from this doc, the branch and our conversation.",
                [
                    "Set up the Command center for the implementation work this doc is about, so its Command tab can track it live:",
                    '1. Read instructions {topic:"command"}.',
                    `2. Work out the plan from the doc content, the change ${t.base.slice(0, 8)}…${t.head.slice(0, 8)} in ${repo.name} (${repo.path}) and anything we've already discussed. Checkpoints (phases) → steps → expects (prefer directories and globs).`,
                    '3. command_plan {op:"set"} (this claims the Command lease for this session), then command_front {op:"register"} for every worktree that will be edited — your own checkout and any child sessions\' worktrees. Mark the current phase active.',
                    "4. Optionally add a suggestedView per phase with command_view.",
                    "5. If the goal is genuinely unclear, ask me one short question in this chat instead of guessing.",
                ].join("\n"),
                st.fronts.length ? `Fronts already registered: ${st.fronts.map((f) => `${f.id} (${f.worktree})`).join(", ")}.` : null,
                "(Reply in the Command chat popup: one or two sentences summarising the plan you set.)",
            ].filter(Boolean);
            const result = await chat.send({ instanceId: url.searchParams.get("instance") ?? "", prompt: lines.join("\n\n"), displayPrompt: `Initialize the command center${goal ? `: ${goal.slice(0, 300)}` : ""}\n\nCommand center on “${doc.title}”` });
            return send(res, 200, result);
        }
        if (what === "activity" && req.method === "GET") {
            const lease = readLease(doc.id);
            return send(res, 200, { items: lease?.live && lease.sessionId === getSessionId?.() ? activity.slice(-50) : [] });
        }
        if (what === "prefs" && req.method === "POST") return send(res, 200, writePrefs(doc.id, await readBody(req)));
        if ((what === "hunks" || what === "patch") && req.method === "GET") {
            const st = readState(doc.id);
            const front = st.fronts.find((f) => f.id === url.searchParams.get("front"));
            if (!front || !st.plan) throw new InputError("Unknown front.");
            const base = front.effectiveBase ?? st.plan.base;
            const file = url.searchParams.get("file") ?? "";
            if (what === "hunks") return send(res, 200, { rows: await fileHunks(front.worktree, base, file) });
            const [f] = parsePatch(await filePatch(front.worktree, base, file, Number(url.searchParams.get("context") ?? 3)));
            return send(res, 200, f ?? { path: file, hunks: [] });
        }
        return send(res, 404, { error: "not found" });
    }

    /** Command chat: always to the orchestrator (this panel's session must hold the lease), with a structured focus block. */
    async function askCommand({ doc, instanceId, quote, message, threadId, focus, context }) {
        const lease = readLease(doc.id);
        if (lease?.live && lease.sessionId !== getSessionId?.()) throw new InputError(`Command chat talks to the orchestrator (session ${lease.sessionId}): open this doc in that session.`);
        const f = parseFocus(focus);
        writePrefs(doc.id, { focus: f });
        const lines = [`[Command center chat${threadId ? " follow-up" : ""} on "${doc.title}" (documentId: ${doc.id}), tab: command]`];
        if (typeof quote === "string" && quote.trim()) lines.push(quote.trim().slice(0, 4000).split("\n").map((l) => `> ${l}`).join("\n"));
        if (typeof context === "string" && context.trim()) lines.push(`[Viewing: ${context.trim().slice(0, 1500)}]`);
        lines.push(message.trim().slice(0, 8000));
        if (f.items.length || f.replayAt) lines.push("Focus (what the user is pointing at on the Command map):\n```json\n" + JSON.stringify(f, null, 1).slice(0, 6000) + "\n```");
        lines.push('(The user reads your reply in the Command chat popup: keep it short. For "walk me through…" use command_diff then command_walkthrough {op:"show"}; for questions about a stop prefer command_walkthrough {op:"edit"}. Views: command_view.)');
        const chips = f.items.length ? ` · ${f.items.length} focused` : "";
        return chat.send({ instanceId, threadId, prompt: lines.join("\n\n"), displayPrompt: `${message.trim().slice(0, 2000)}\n\nCommand chat on “${doc.title}”${chips}` });
    }

    async function route(req, res, url) {
        const parts = url.pathname.split("/").filter(Boolean);
        const method = req.method;

        if (parts[0] !== "api") {
            // The browser shares the pattern matcher with the server (single source of truth).
            if (url.pathname === "/command/patterns.js") return send(res, 200, readFileSync(join(dirname(fileURLToPath(import.meta.url)), "command", "patterns.mjs")), MIME[".js"]);
            const name = parts.length === 0 ? "index.html" : parts.join("/");
            // Flat assets plus exactly one module subdirectory (web/command/).
            if (!/^(command\/)?[a-z0-9_-]+(\.[a-z0-9]+)+$/i.test(name)) return send(res, 404, { error: "not found" });
            const ext = name.slice(name.lastIndexOf("."));
            try {
                return send(res, 200, readFileSync(join(webDir, name)), MIME[ext] ?? "application/octet-stream");
            } catch {
                return send(res, 404, { error: "not found" });
            }
        }

        const auth = req.headers["x-wb-token"] ?? url.searchParams.get("t");
        if (auth !== token) return send(res, 403, { error: "forbidden" });

        if (parts[1] === "events" && method === "GET") {
            const instanceId = url.searchParams.get("instance") ?? "";
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
            const client = { res, instanceId };
            clients.add(client);
            push(client, { type: "show", documentId: instances.get(instanceId)?.documentId ?? null });
            const ping = setInterval(() => res.write(": ping\n\n"), 20000);
            ping.unref?.();
            req.on("close", () => {
                clearInterval(ping);
                clients.delete(client);
            });
            return;
        }

        if (parts[1] === "catalog" && method === "GET") return send(res, 200, store.list());

        if (parts[1] === "command") return commandRoute(req, res, url, parts.slice(2));

        if (parts[1] === "instance" && parts[2] && parts[3] === "show" && method === "POST") {
            const { documentId } = await readBody(req);
            if (documentId) store.getDoc(documentId);
            const entry = instances.get(parts[2]);
            if (!entry) throw new InputError("Unknown panel.");
            entry.documentId = documentId ?? null;
            instances.save();
            return send(res, 200, { documentId: entry.documentId });
        }

        if (parts[1] === "open-external" && method === "POST") {
            // Open the current view in the default browser. The browser gets its own panel instance so the agent's
            // "show" (which targets the canvas panel) doesn't yank it around, and side-chat replies stay per window.
            const { documentId, tab } = await readBody(req);
            if (documentId) store.getDoc(documentId);
            const id = `browser-${randomBytes(6).toString("hex")}`;
            instances.set(id, { documentId: documentId ?? null, external: true });
            instances.save();
            const target = `${urlFor(id, server.address().port)}${["command", "diff", "commits", "history"].includes(tab) ? `&tab=${tab}` : ""}`;
            openInBrowser(target);
            return send(res, 200, { url: target });
        }

        if (parts[1] === "ask" && parts[2] === "end" && method === "POST") {
            const { threadId } = await readBody(req);
            if (typeof threadId === "string") chat.end(threadId);
            return send(res, 200, { ended: true });
        }

        if (parts[1] === "ask" && method === "POST") {
            const { documentId, blockId, quote, message, threadId, tab, focus, context, kind } = await readBody(req);
            if (typeof message !== "string" || !message.trim()) throw new InputError("message is required.");
            const instanceId = url.searchParams.get("instance") ?? "";
            const doc = documentId ? store.getDoc(documentId) : null;
            if (tab === "command" && doc?.target) return send(res, 200, await askCommand({ doc, instanceId, quote, message, threadId, focus, context }));
            const lines = [];
            if (threadId) lines.push(`[Marginal side-chat follow-up${doc ? ` on "${doc.title}" (documentId: ${doc.id})` : ""}${blockId ? `, element ${blockId}` : ""}]`);
            else {
                if (doc) lines.push(`[Marginal side-chat on "${doc.title}" (documentId: ${doc.id})${blockId ? `, element ${blockId}` : ""}]`);
                if (typeof quote === "string" && quote.trim())
                    lines.push(
                        quote
                            .trim()
                            .slice(0, 4000)
                            .split("\n")
                            .map((l) => `> ${l}`)
                            .join("\n"),
                    );
            }
            // Docked chats (tour, walkthrough) say where the reader is on every message, since they move between steps.
            if (typeof context === "string" && context.trim()) lines.push(`[Viewing: ${context.trim().slice(0, 1500)}]`);
            lines.push(message.trim().slice(0, 8000));
            if (kind === "tour")
                lines.push(
                    "(The user is in the full-screen tour of that diagram, with this chat docked under the step. When they ask for more explanation, an example, or what something looks like, add it to that step as notes: edit {type:\"update\", targetId:<the step/node/frame id>, changes:{notes:[...existing, {title?, text?, source? | code?}]}}. Use source for a real example from the code (read it first) and code for an illustrative sketch. The tour updates in place. Reply briefly in the chat.)",
                );
            else lines.push("(The user reads your reply in a small chat popup on the doc: keep it short and conversational. Make any changes with the Marginal canvas actions; they appear live.)");
            const where = doc ? `On doc “${doc.title}”${kind === "tour" ? " · tour" : blockId ? ` (${blockId})` : ""}` : "From the doc";
            const result = await chat.send({ instanceId, threadId, prompt: lines.join("\n\n"), displayPrompt: `${message.trim().slice(0, 2000)}\n\n${where}` });
            return send(res, 200, result);
        }

        if (parts[1] === "docs" && parts[2]) {
            const doc = docFor(parts[2]);
            const sub = parts[3];
            if (!sub && method === "GET") {
                let repository;
                if (doc.target) repository = getRepository(doc.target.repositoryId).name;
                return send(res, 200, { doc, repository, activity: store.summary(doc).activity });
            }
            if (sub === "history" && method === "GET") return send(res, 200, store.history(doc.id));
            if (sub === "versions" && parts[4] && method === "GET") return send(res, 200, store.getVersion(doc.id, Number(parts[4])));
            if (sub === "source" && method === "POST") {
                const { source } = await readBody(req);
                if (!source || typeof source.file !== "string") throw new InputError("source.file is required.");
                return send(res, 200, await sourceSlice(doc, source));
            }
            if (sub === "tree" && method === "GET") {
                const side = url.searchParams.get("side") === "base" ? "base" : "head";
                const pins = doc.target;
                if (!pins) throw new InputError("No target.");
                return send(res, 200, await listTree(pins.repositoryId, pins[side], url.searchParams.get("path") ?? ""));
            }
            if (sub === "diff" && method === "GET") {
                if (!doc.target) return send(res, 200, { files: [], lenses: [] });
                const t = doc.target;
                const path = url.searchParams.get("path");
                if (path) {
                    const ctx = Number(url.searchParams.get("context") ?? 3);
                    const [file] = parsePatch(await diffPatch(t.repositoryId, t.base, t.head, [path], { context: ctx }));
                    return send(res, 200, file ?? { path, hunks: [] });
                }
                return send(res, 200, { files: await diffFiles(t.repositoryId, t.base, t.head), lenses: doc.lenses });
            }
            if (sub === "commits" && method === "GET") {
                if (!doc.target) return send(res, 200, []);
                return send(res, 200, await listCommits(doc.target.repositoryId, doc.target.base, doc.target.head));
            }
            if (sub === "rename" && method === "POST") {
                const { title } = await readBody(req);
                return send(res, 200, await store.rename(doc.id, title));
            }
            if (sub === "delete" && method === "POST") return send(res, 200, await store.remove(doc.id));
        }
        return send(res, 404, { error: "not found" });
    }

    const urlFor = (instanceId, port) => `http://127.0.0.1:${port}/?instance=${encodeURIComponent(instanceId)}&t=${token}`;
    const server = createServer(async (req, res) => {
        const port = server.address().port;
        // Loopback only, and reject DNS-rebinding hosts.
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        try {
            await route(req, res, url);
        } catch (e) {
            if (!res.headersSent) send(res, e instanceof InputError ? 400 : 500, { error: e instanceof InputError ? e.message : `Internal error: ${e.message}` });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    return {
        server,
        notifyShow,
        urlFor: (instanceId) => urlFor(instanceId, port),
    };
}

/** Focus payload (docs/command-center.md#focus-payload) from the panel: keep only well-formed items. */
export function parseFocus(v) {
    const items = [];
    const s = (x, max = 300) => (typeof x === "string" && x.length <= max ? x : null);
    const n = (x) => (Number.isInteger(x) && x > 0 ? x : null);
    for (const it of Array.isArray(v?.items) ? v.items.slice(0, 40) : []) {
        if (it?.kind === "path" && s(it.path) !== null) items.push({ kind: "path", path: it.path, isDir: !!it.isDir });
        else if (it?.kind === "front" && s(it.frontId, 64)) items.push({ kind: "front", frontId: it.frontId });
        else if (it?.kind === "phase" && s(it.phaseId, 64)) items.push({ kind: "phase", phaseId: it.phaseId });
        else if (it?.kind === "step" && s(it.stepId, 64)) items.push({ kind: "step", stepId: it.stepId });
        else if (it?.kind === "stop" && s(it.walkthroughId, 64) && s(it.stopId, 64)) items.push({ kind: "stop", walkthroughId: it.walkthroughId, stopId: it.stopId, revision: n(it.revision) ?? 0 });
        else if (it?.kind === "range" && s(it.file) && n(it.startLine) && n(it.endLine) && s(it.pins?.base, 80) && s(it.pins?.head, 80)) items.push({ kind: "range", file: it.file, startLine: it.startLine, endLine: it.endLine, pins: { base: it.pins.base, head: it.pins.head } });
    }
    return { items, ...(s(v?.replayAt, 40) ? { replayAt: v.replayAt } : {}) };
}
/** Launch the OS default browser without a shell (the URL carries `&`, which cmd.exe would split). */
export function openInBrowser(url) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new InputError("Only this extension's own local URLs can be opened.");
    if (process.env.MARGINAL_NO_BROWSER) return; // tests and headless tooling
    const [cmd, args] =
        process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
}