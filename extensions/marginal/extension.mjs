// Extension: Marginal — a canvas where the agent draws structured explanations of code
// (sequence / flow diagrams, call-stack diffs, database lenses, verified code peeks).
// Inspired by devdotfast/whiteboard (MIT).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { createChat } from "./lib/chat.mjs";
import { adoptLeases, attachMission, commandActions } from "./lib/command/index.mjs";
import { InputError } from "./lib/errors.mjs";
import * as git from "./lib/git.mjs";
import { getInstructions } from "./lib/instructions.mjs";
import { atomicWriteJson, paths } from "./lib/paths.mjs";
import { startServer } from "./lib/server.mjs";
import * as store from "./lib/store.mjs";

// Panel → shown document. Only UI state; documents themselves live in the store.
const panelsFile = join(paths.root, "panels.json");
const instances = new Map(existsSync(panelsFile) ? Object.entries(safeJson(panelsFile)) : []);
instances.save = () => atomicWriteJson(panelsFile, Object.fromEntries([...instances].slice(-50)));

function safeJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return {};
    }
}

let session;
let serverPromise;
// The panel can open while the extension is still joining the session, so resolve it lazily.
const chat = createChat(() => session);
const server = () => (serverPromise ??= startServer({ chat, instances, getSessionId: () => session?.sessionId }));

/** Run a handler, translating validation errors into CanvasErrors the agent can act on. */
const wrap = (fn) => async (ctx) => {
    try {
        return await fn(ctx.input ?? {}, ctx);
    } catch (e) {
        if (e instanceof CanvasError) throw e;
        if (e instanceof InputError) throw new CanvasError("invalid_input", e.message);
        throw new CanvasError("internal_error", e?.message ?? String(e));
    }
};

function docIdFor(input, ctx) {
    const id = input.documentId ?? instances.get(ctx.instanceId)?.documentId;
    if (!id) throw new InputError("No doc is shown in this panel. Pass documentId, or create / show one first.");
    return id;
}

async function show(ctx, documentId) {
    if (documentId) store.getDoc(documentId);
    const entry = instances.get(ctx.instanceId) ?? {};
    entry.documentId = documentId ?? null;
    instances.set(ctx.instanceId, entry);
    instances.save();
    (await server()).notifyShow(ctx.instanceId);
}

async function resolveTargetInput(target) {
    if (!target) return undefined;
    const repo = git.getRepository(target.repositoryId);
    const head = target.head ?? "HEAD";
    const base = target.base ?? (await git.defaultBase(repo.id));
    const pins = await git.resolvePins(repo.id, base, head, { mergeBase: target.mergeBase !== false });
    return { ...pins, baseRef: base, headRef: head };
}

const pinsSchema = {
    type: "object",
    description: "Repository and commits a source reads from (from resolve_pins). Required on scratchpad sources; optional elsewhere (defaults to the doc target).",
    properties: { repositoryId: { type: "string" }, head: { type: "string" }, base: { type: "string" } },
    required: ["repositoryId", "head"],
};
const docId = { type: "string", description: "Doc id. Defaults to the doc shown in this panel." };
const targetSchema = { type: "object", properties: { repositoryId: { type: "string" }, base: { type: "string" }, head: { type: "string" }, mergeBase: { type: "boolean" } }, required: ["repositoryId"] };

function findElement(content, targetId) {
    for (const b of content) {
        if (b.id === targetId) return b;
        for (const u of [...(b.steps ?? []), ...(b.nodes ?? []), ...(b.edges ?? []), ...(b.base ?? []), ...(b.head ?? [])]) if (u.id === targetId) return u;
        const hit = b.children && findElement(b.children, targetId);
        if (hit) return hit;
    }
}

async function pinsFor(i, ctx) {
    const pins = i.pins ?? store.getDoc(docIdFor(i, ctx)).target;
    if (!pins) throw new InputError("Pass pins (the scratchpad has no target).");
    return pins;
}

const actions = [
    {
        name: "instructions",
        description: "Read how to author docs. Call this first. Topics: authoring (explain a change/branch/PR), scratchpad (sketch an explanation), blocks (block reference), file-lenses, command (Command center protocol for multi-worktree implementation plans, checkpoint walkthroughs).",
        inputSchema: { type: "object", properties: { topic: { type: "string", enum: ["authoring", "scratchpad", "blocks", "file-lenses", "command"] } } },
        handler: wrap((i) => getInstructions(i.topic ?? "authoring")),
    },
    {
        name: "list",
        description: "List docs (the scratchpad is always first) and registered repositories.",
        handler: wrap(() => ({ docs: store.list(), repositories: git.listRepositories() })),
    },
    {
        name: "show",
        description: "Switch this panel to a doc, or pass documentId null to show the home list.",
        inputSchema: { type: "object", properties: { documentId: { type: ["string", "null"] } }, required: ["documentId"] },
        handler: wrap(async (i, ctx) => {
            await show(ctx, i.documentId);
            return { shown: i.documentId };
        }),
    },
    {
        name: "register_repository",
        description: "Register a local git checkout so docs can cite its code. Returns repositoryId.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        handler: wrap((i) => git.registerRepository(i.path)),
    },
    {
        name: "resolve_pins",
        description: "Resolve revisions (branches, tags, HEAD, SHAs) to immutable commits. By default base becomes the merge-base with head.",
        inputSchema: { type: "object", properties: { repositoryId: { type: "string" }, base: { type: "string" }, head: { type: "string" }, mergeBase: { type: "boolean" } }, required: ["repositoryId"] },
        handler: wrap((i) => git.resolvePins(i.repositoryId, i.base ?? i.head ?? "HEAD", i.head ?? "HEAD", { mergeBase: i.mergeBase !== false })),
    },
    {
        name: "create",
        description: "Create a doc pinned to a comparison and show it in this panel. Pass target {repositoryId, base?, head?} (refs are resolved; base defaults to origin's default branch) or pullRequestUrl + repositoryId.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string" },
                target: targetSchema,
                pullRequestUrl: { type: "string" },
                repositoryId: { type: "string" },
                reuseExisting: { type: "boolean", description: "For pullRequestUrl: return the existing doc for that PR (default true)." },
                show: { type: "boolean", description: "Show in this panel (default true)." },
            },
        },
        handler: wrap(async (i, ctx) => {
            let result;
            if (i.pullRequestUrl) {
                const url = git.parsePullRequestUrl(i.pullRequestUrl).url;
                const existing = i.reuseExisting !== false && store.findByPullRequest(url);
                if (existing) result = { ...store.summary(existing), created: false, note: "Existing doc for this PR; use set_target to repin." };
                else {
                    const repositoryId = i.repositoryId ?? i.target?.repositoryId;
                    if (!repositoryId) throw new InputError("repositoryId is required with pullRequestUrl.");
                    const pr = await git.resolvePullRequest(repositoryId, url);
                    const target = { ...pr.pins, baseRef: pr.baseRef, headRef: `#${url.split("/").pop()}` };
                    result = { ...(await store.create({ title: i.title ?? pr.title, target, pullRequest: { url, title: pr.title, state: pr.state } })), created: true };
                }
            } else {
                if (!i.title) throw new InputError("title is required.");
                result = { ...(await store.create({ title: i.title, target: await resolveTargetInput(i.target) })), created: true };
            }
            if (i.show !== false) await show(ctx, result.documentId);
            return result;
        }),
    },
    {
        name: "read",
        description: "Read a doc as an outline with element IDs. targetId returns one element in full; full:true returns the whole JSON; version reads history.",
        inputSchema: { type: "object", properties: { documentId: docId, targetId: { type: "string" }, full: { type: "boolean" }, version: { type: "integer" } } },
        handler: wrap((i, ctx) => {
            const id = docIdFor(i, ctx);
            const doc = i.version !== undefined ? store.getVersion(id, i.version) : store.getDoc(id);
            if (i.targetId) {
                const el = findElement(doc.content, i.targetId);
                if (!el) throw new InputError(`Unknown targetId: ${i.targetId}`);
                return el;
            }
            if (i.full) return { documentId: doc.id, title: doc.title, version: doc.version, target: doc.target, pullRequest: doc.pullRequest, lenses: doc.lenses, content: doc.content };
            return store.outline(doc);
        }),
    },
    {
        name: "edit",
        description: "Apply edits: {edit} or {edits:[...]}. Types: insert {content, parentId?, afterId?, beforeId?}, update {targetId, changes}, replace {targetId, content}, move {targetId, parentId?, afterId?, beforeId?}, remove {targetId}. Each saves a version and animates live. See instructions topic 'blocks'.",
        inputSchema: { type: "object", properties: { documentId: docId, edit: { type: "object" }, edits: { type: "array", items: { type: "object" } } } },
        handler: wrap(async (i, ctx) => {
            const id = docIdFor(i, ctx);
            const edits = i.edits ?? (i.edit ? [i.edit] : []);
            if (!edits.length) throw new InputError("Pass edit or edits.");
            const results = [];
            for (const [n, e] of edits.entries()) {
                try {
                    results.push(await store.applyEdit(id, e));
                } catch (err) {
                    if (!(err instanceof InputError)) throw err;
                    throw new InputError(`${edits.length > 1 ? `edits[${n}] failed (${n} earlier edit(s) were saved): ` : ""}${err.message}`);
                }
            }
            return i.edit && !i.edits ? results[0] : results;
        }),
    },
    {
        name: "activity",
        description: "Show that you are working on the doc: begin/renew with a short focus ('Drawing the checkout flow'), end when done. Expires after 2 minutes idle.",
        inputSchema: { type: "object", properties: { documentId: docId, action: { type: "string", enum: ["begin", "renew", "end"] }, scope: { type: "string", enum: ["document", "lenses"] }, focus: { type: "string" } }, required: ["action"] },
        handler: wrap((i, ctx) => store.setActivity(docIdFor(i, ctx), i)),
    },
    {
        name: "diff",
        description: "Read the doc's change like git diff. format 'files' (default) lists changed files; 'patch' returns patches where every line carries base and head line numbers. paths is a pathspec.",
        inputSchema: { type: "object", properties: { documentId: docId, format: { type: "string", enum: ["files", "patch"] }, paths: { type: "array", items: { type: "string" } }, context: { type: "integer" }, maxBytes: { type: "integer" } } },
        handler: wrap(async (i, ctx) => {
            const doc = store.getDoc(docIdFor(i, ctx));
            if (!doc.target) throw new InputError("This doc has no target to diff.");
            const t = doc.target;
            if (i.format === "patch") return git.numberPatch(await git.diffPatch(t.repositoryId, t.base, t.head, i.paths, { context: i.context ?? 3 }), i.maxBytes ?? 40000);
            return git.diffFiles(t.repositoryId, t.base, t.head, i.paths);
        }),
    },
    {
        name: "read_file",
        description: "Read a file (or line range) at a pinned commit, with line numbers. Uses the doc's target unless pins are given.",
        inputSchema: { type: "object", properties: { documentId: docId, pins: pinsSchema, file: { type: "string" }, side: { type: "string", enum: ["head", "base"] }, startLine: { type: "integer" }, endLine: { type: "integer" } }, required: ["file"] },
        handler: wrap(async (i, ctx) => {
            const pins = await pinsFor(i, ctx);
            const rev = i.side === "base" ? pins.base : pins.head;
            if (!rev) throw new InputError("No commit for that side.");
            const commit = await git.resolveCommit(pins.repositoryId, rev);
            const f = await git.readFileAt(pins.repositoryId, commit, i.file);
            if (!f.exists) throw new InputError(`${i.file} does not exist at ${commit.slice(0, 10)}.`);
            if (f.binary) return "(binary file)";
            const start = Math.max(1, i.startLine ?? 1);
            const end = Math.min(f.lines.length, i.endLine ?? start + 499);
            const body = f.lines.slice(start - 1, end).map((l, k) => `${String(start + k).padStart(5)}  ${l}`).join("\n");
            return `${i.file} @ ${commit.slice(0, 10)} (${i.side ?? "head"}), lines ${start}-${end} of ${f.lines.length}\n${body}`;
        }),
    },
    {
        name: "list_tree",
        description: "List a directory at a pinned commit.",
        inputSchema: { type: "object", properties: { documentId: docId, pins: pinsSchema, side: { type: "string", enum: ["head", "base"] }, path: { type: "string" } } },
        handler: wrap(async (i, ctx) => {
            const pins = await pinsFor(i, ctx);
            return git.listTree(pins.repositoryId, await git.resolveCommit(pins.repositoryId, i.side === "base" ? pins.base : pins.head), i.path ?? "");
        }),
    },
    {
        name: "commits",
        description: "List the commits between the doc's base and head.",
        inputSchema: { type: "object", properties: { documentId: docId } },
        handler: wrap(async (i, ctx) => {
            const t = store.getDoc(docIdFor(i, ctx)).target;
            return t ? git.listCommits(t.repositoryId, t.base, t.head) : [];
        }),
    },
    {
        name: "lens",
        description: "Group changed files for the Diff tab: op insert {title, paths, collapsed?, afterId?}, update {targetId, title?, paths?, collapsed?}, remove {targetId}, list. paths are files or 'dir/' prefixes. Returns still-uncategorized files.",
        inputSchema: { type: "object", properties: { documentId: docId, op: { type: "string", enum: ["insert", "update", "remove", "list"] }, targetId: { type: "string" }, title: { type: "string" }, paths: { type: "array", items: { type: "string" } }, collapsed: { type: "boolean" }, afterId: { type: "string" } }, required: ["op"] },
        handler: wrap((i, ctx) => store.lensEdit(docIdFor(i, ctx), i)),
    },
    {
        name: "set_target",
        description: "Repin a doc to new commits (e.g. after new pushes). Content is kept; the result lists sources that no longer resolve so you can repair them.",
        inputSchema: { type: "object", properties: { documentId: docId, target: targetSchema, pullRequestUrl: { type: "string" } }, required: ["target"] },
        handler: wrap(async (i, ctx) => {
            const id = docIdFor(i, ctx);
            const pr = i.pullRequestUrl ? { url: git.parsePullRequestUrl(i.pullRequestUrl).url } : undefined;
            return store.setTarget(id, await resolveTargetInput(i.target), pr);
        }),
    },
    {
        name: "rename",
        description: "Rename a doc.",
        inputSchema: { type: "object", properties: { documentId: docId, title: { type: "string" } }, required: ["title"] },
        handler: wrap((i, ctx) => store.rename(docIdFor(i, ctx), i.title)),
    },
    {
        name: "history",
        description: "List saved versions of a doc.",
        inputSchema: { type: "object", properties: { documentId: docId } },
        handler: wrap((i, ctx) => store.history(docIdFor(i, ctx))),
    },
    {
        name: "restore",
        description: "Restore a doc's content to an earlier version (saved as a new version).",
        inputSchema: { type: "object", properties: { documentId: docId, version: { type: "integer" } }, required: ["version"] },
        handler: wrap((i, ctx) => store.restore(docIdFor(i, ctx), i.version)),
    },
    {
        name: "delete",
        description: "Permanently delete a doc. Only when the user asks.",
        inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] },
        handler: wrap((i) => store.remove(i.documentId)),
    },
    ...commandActions({ resolveDoc: docIdFor, getSessionId: () => session?.sessionId }),
];

session = await joinSession({
    canvases: [
        createCanvas({
            id: "marginal",
            displayName: "Marginal",
            description: "Draw structured, code-linked explanations (sequence/flow diagrams, call-stack diffs, schema lenses, verified code peeks) of branches, PRs and ideas; call the 'instructions' action first.",
            inputSchema: { type: "object", properties: { documentId: { type: "string", description: "Doc to show; 'scratchpad' for the sketch pad. Omit for the home list." } } },
            actions,
            open: async (ctx) => {
                try {
                    const s = await server();
                    const entry = instances.get(ctx.instanceId) ?? {};
                    const requested = ctx.input?.documentId;
                    if (requested !== undefined) {
                        store.getDoc(requested);
                        entry.documentId = requested;
                    } else if (entry.documentId && !store.hasDoc(entry.documentId)) entry.documentId = null;
                    instances.set(ctx.instanceId, entry);
                    instances.save();
                    s.notifyShow(ctx.instanceId);
                    const title = entry.documentId ? store.getDoc(entry.documentId).title : "Home";
                    return { url: s.urlFor(ctx.instanceId), title: `Marginal — ${title}` };
                } catch (e) {
                    if (e instanceof InputError) throw new CanvasError("invalid_input", e.message);
                    throw e;
                }
            },
            // Keep the panel → document mapping: reloads close and immediately rehydrate panels,
            // and the map is bounded (see instances.save), so dropping it only loses state.
            onClose: async () => {},
        }),
    ],
});

session.on((event) => {
    try {
        chat.onEvent(event);
    } catch (e) {
        session.log(`marginal side-chat: ${e?.message ?? e}`, { level: "warning", ephemeral: true });
    }
});

// Re-adopt Command leases this session held before a reload, so polling resumes without a new plan "set".
try {
    adoptLeases(session.sessionId);
    attachMission(session, { isChatTurn: () => !!chat.activeThread() });
} catch (e) {
    session.log(`marginal command: ${e?.message ?? e}`, { level: "warning", ephemeral: true });
}
