// Loopback HTTP server for the whiteboard iframe: static assets, JSON reads, SSE pushes.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { InputError } from "./errors.mjs";
import { diffFiles, diffPatch, getRepository, listCommits, listTree, parsePatch, readFileAt } from "./git.mjs";
import { locIndex } from "./command/loc.mjs";
import { readLease } from "./command/owner.mjs";
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
        if (!doc.target) throw new InputError("This whiteboard has no repository target.");
        watchCommand(doc.id);
        const repo = getRepository(doc.target.repositoryId);
        const what = sub[0];
        if (what === "state" && req.method === "GET") {
            const lease = readLease(doc.id);
            return send(res, 200, { state: readState(doc.id), prefs: readPrefs(doc.id), lease, isOwnerHere: !!lease?.live && lease.sessionId === getSessionId?.(), seq: lastSeq(doc.id), repository: repo.name, target: doc.target });
        }
        if (what === "events" && req.method === "GET") {
            const since = Number(url.searchParams.get("since") ?? 0) || 0;
            refreshLog(doc.id);
            return send(res, 200, { events: eventsSince(doc.id, since), seq: lastSeq(doc.id) });
        }
        if (what === "tree" && req.method === "GET") return send(res, 200, await locIndex(repo.id, repo.path));
        if (what === "prefs" && req.method === "POST") return send(res, 200, writePrefs(doc.id, await readBody(req)));
        return send(res, 404, { error: "not found" });
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

        if (parts[1] === "ask" && parts[2] === "end" && method === "POST") {
            const { threadId } = await readBody(req);
            if (typeof threadId === "string") chat.end(threadId);
            return send(res, 200, { ended: true });
        }

        if (parts[1] === "ask" && method === "POST") {
            const { documentId, blockId, quote, message, threadId } = await readBody(req);
            if (typeof message !== "string" || !message.trim()) throw new InputError("message is required.");
            const instanceId = url.searchParams.get("instance") ?? "";
            const doc = documentId ? store.getDoc(documentId) : null;
            const lines = [];
            if (threadId) lines.push(`[Whiteboard side-chat follow-up${doc ? ` on "${doc.title}" (documentId: ${doc.id})` : ""}${blockId ? `, element ${blockId}` : ""}]`);
            else {
                if (doc) lines.push(`[Whiteboard side-chat on "${doc.title}" (documentId: ${doc.id})${blockId ? `, element ${blockId}` : ""}]`);
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
            lines.push(message.trim().slice(0, 8000));
            lines.push("(The user reads your reply in a small chat popup on the whiteboard: keep it short and conversational. Make any whiteboard changes with the whiteboard canvas actions; they appear live.)");
            const where = doc ? `On whiteboard “${doc.title}”${blockId ? ` (${blockId})` : ""}` : "From the whiteboard";
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
        urlFor: (instanceId) => `http://127.0.0.1:${port}/?instance=${encodeURIComponent(instanceId)}&t=${token}`,
    };
}
