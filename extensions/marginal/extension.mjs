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

/** Doc changes other than edits (which are held as a suggestion) are refused while the user is only discussing. */
function notDiscussing(docId) {
    if (chat.discussing(docId)) throw new InputError("The user asked this in Discuss mode: answer in the chat and don't change the doc. Say what you'd change; they can switch to Edit or ask you to go ahead.");
    return docId;
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
        description: "Read a doc as an outline with element IDs, headings and the doc version. heading:\"Section > Heading\" returns just the text under that heading (or a section's contents); ref:\"m4.r1\" returns a region a chat message pointed at, as it is now; targetId returns one element in full (with lines:true, optionally fromLine/toLine, its text numbered by line); full:true returns the whole JSON; format:\"markdown\" returns the doc (or one heading's part) as Markdown, diagrams as text, with a header of its version, commits and sha256; version reads history.",
        inputSchema: { type: "object", properties: { documentId: docId, heading: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: 'A path of titles: "Plan > Findings", or ["Plan", "Findings"] (exact, for titles that contain " > ")' }, ref: { type: "string" }, targetId: { type: "string" }, full: { type: "boolean" }, version: { type: "integer" }, lines: { type: "boolean" }, field: { type: "string" }, fromLine: { type: "integer" }, toLine: { type: "integer" }, format: { type: "string", enum: ["json", "markdown"] } } },
        handler: wrap(async (i, ctx) => {
            const id = docIdFor(i, ctx);
            if (i.format === "markdown") {
                const md = await store.docMarkdown(id, { heading: i.heading });
                return { documentId: id, version: md.version, sha256: md.sha256, base: md.base, head: md.head, markdown: md.markdown };
            }
            if (i.ref !== undefined) return store.readRegion(id, i.ref);
            if (i.heading !== undefined) return store.readHeading(id, i.heading, { version: i.version });
            const doc = i.version !== undefined ? store.getVersion(id, i.version) : store.getDoc(id);
            if (i.targetId) {
                const el = findElement(doc.content, i.targetId);
                if (!el) throw new InputError(`Unknown targetId: ${i.targetId}`);
                if (!i.lines) return el;
                const field = i.field ?? (typeof el.markdown === "string" ? "markdown" : typeof el.text === "string" ? "text" : "markdown");
                if (typeof el[field] !== "string") throw new InputError(`${i.targetId} has no text field "${field}"; text fields here: ${Object.entries(el).filter(([k, v]) => typeof v === "string" && !["id", "type"].includes(k)).map(([k]) => k).join(", ") || "none"}.`);
                const all = el[field].split("\n");
                const from = Math.max(1, i.fromLine ?? 1);
                const to = Math.min(all.length, i.toLine ?? all.length);
                const w = String(to).length;
                return { id: el.id, type: el.type, field, version: doc.version, lineCount: all.length, from, to, text: all.slice(from - 1, to).map((l, k) => `${String(from + k).padStart(w)}| ${l}`).join("\n") };
            }
            if (i.full) return { documentId: doc.id, title: doc.title, version: doc.version, target: doc.target, pullRequest: doc.pullRequest, lenses: doc.lenses, content: doc.content };
            return store.outline(doc);
        }),
    },
    {
        name: "edit",
        description: "Apply edits: {edit} or {edits:[...]}. To change part of existing text, use region, under or patch (never resend a whole long block). Types: region {ref:\"m4.r1\", markdown} (rewrite exactly what a chat message pointed at; \"\" removes it), under {heading:\"Section > Heading\", markdown, append?} (replace or add to the text under a heading; the heading stays), insert {content, parentId?, afterId?, beforeId?}, update {targetId, changes}, patch {targetId, field?:'markdown', ops:[{find, replace, all?} | {lines:[from,to], text, expect?}]} (change part of a long text without resending it; lines from read {targetId, lines:true}), replace {targetId, content}, move {targetId, parentId?, afterId?, beforeId?}, remove {targetId}. A batch is all or nothing: if any edit is invalid, none is saved. Any edit may carry baseVersion (the doc version you read): it's refused if what it changes changed since (update/patch: the element's own fields; replace/remove: it and its contents; move: also its place), and the error names the version, who and what. Each saves a version and animates live. See instructions topic 'blocks'.",
        inputSchema: { type: "object", properties: { documentId: docId, edit: { type: "object" }, edits: { type: "array", items: { type: "object" } } } },
        handler: wrap(async (i, ctx) => {
            const id = docIdFor(i, ctx);
            const edits = i.edits ?? (i.edit ? [i.edit] : []);
            if (!edits.length) throw new InputError("Pass edit or edits.");
            const discussing = chat.discussing(id);
            if (discussing) {
                await store.checkEdits(id, [...chat.heldEdits(discussing), ...edits]);
                const held = chat.hold(discussing, edits);
                if (!held) notDiscussing(id); // the conversation was closed: nowhere to offer it, so refuse
                return {
                    applied: false,
                    held,
                    note: `Not applied: the user asked this in Discuss mode (answer in the chat; don't change the doc). The edit${edits.length === 1 ? " was" : "s were"} checked and held as a suggestion (${held} edit${held === 1 ? "" : "s"} so far) that the user can preview in the doc (as a diff) and apply with one click. Don't retry or work around it, and don't restate the change: the preview shows it. Say in a line what it's for.`,
                };
            }
            const tips = [];
            // Resending a long text to change a little of it: say what would have been cheaper, once per call.
            for (const e of edits) {
                const before = e?.type === "update" && typeof e.changes?.markdown === "string" ? findElement(store.getDoc(id).content, e.targetId)?.markdown : null;
                {
                    if (typeof before === "string" && e.changes.markdown.length > 800 && !tips.length) {
                        const a = before;
                        const b = e.changes.markdown;
                        let p = 0;
                        while (p < a.length && p < b.length && a[p] === b[p]) p++;
                        let s = 0;
                        while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
                        const changed = b.length - p - s;
                        if (changed < b.length * 0.25) tips.push(`That update resent ${b.length} characters to change about ${Math.max(changed, 1)}. Next time use under {heading}, region {ref} or patch {ops}: they send only the change and don't overwrite the user's edits elsewhere in the block.`);
                    }
                }
            }
            const results = await store.applyEdits(id, edits); // all or nothing
            if (tips.length) return i.edit && !i.edits ? { ...results[0], tip: tips[0] } : { results, tip: tips[0] };
            return i.edit && !i.edits ? results[0] : results;
        }),
    },
    {
        name: "export",
        description: "Write the doc (or one heading's part, heading:\"Plan\") to a Markdown file for people or other agents: diagrams as text, code links as repo paths, and a header recording the doc version, the repository's base/head commits and a sha256 of the body. path: absolute, ending in .md.",
        inputSchema: { type: "object", properties: { documentId: docId, path: { type: "string" }, heading: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } }, required: ["path"] },
        handler: wrap((i, ctx) => store.exportDoc(docIdFor(i, ctx), { path: i.path, heading: i.heading })),
    },
    {
        name: "changes",
        description: "What changed in a doc since a version: each element added, removed, moved or modified (Markdown with a line diff), and which versions were the user's (edited in place) or Copilot's. Cheaper than re-reading the doc.",
        inputSchema: { type: "object", properties: { documentId: docId, sinceVersion: { type: "integer" } }, required: ["sinceVersion"] },
        handler: wrap((i, ctx) => store.changesSince(docIdFor(i, ctx), i.sinceVersion)),
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
        handler: wrap((i, ctx) => (i.op === "list" ? store.lensEdit(docIdFor(i, ctx), i) : store.lensEdit(notDiscussing(docIdFor(i, ctx)), i))),
    },
    {
        name: "set_target",
        description: "Repin a doc to new commits (e.g. after new pushes). Content is kept; the result lists sources that no longer resolve so you can repair them.",
        inputSchema: { type: "object", properties: { documentId: docId, target: targetSchema, pullRequestUrl: { type: "string" } }, required: ["target"] },
        handler: wrap(async (i, ctx) => {
            const id = notDiscussing(docIdFor(i, ctx));
            const pr = i.pullRequestUrl ? { url: git.parsePullRequestUrl(i.pullRequestUrl).url } : undefined;
            return store.setTarget(id, await resolveTargetInput(i.target), pr);
        }),
    },
    {
        name: "rename",
        description: "Rename a doc.",
        inputSchema: { type: "object", properties: { documentId: docId, title: { type: "string" } }, required: ["title"] },
        handler: wrap((i, ctx) => store.rename(notDiscussing(docIdFor(i, ctx)), i.title)),
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
        handler: wrap((i, ctx) => store.restore(notDiscussing(docIdFor(i, ctx)), i.version)),
    },
    {
        name: "delete",
        description: "Permanently delete a doc. Only when the user asks.",
        inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] },
        handler: wrap((i) => store.remove(notDiscussing(i.documentId))),
    },
    ...commandActions({ resolveDoc: docIdFor, getSessionId: () => session?.sessionId }),
];

/**
 * The same actions without a panel: for when the canvas is closed, or a worker only needs to read, edit or export a
 * doc. Everything but showing a doc works; pass documentId.
 */
const HEADLESS_SKIP = new Set(["show"]);
const headlessTool = {
    name: "marginal",
    description: `Marginal docs without an open panel: run any Marginal canvas action by name with its input (pass documentId). Actions: ${actions.map((a) => a.name).filter((n) => !HEADLESS_SKIP.has(n)).join(", ")}. Same inputs and results as invoke_canvas_action on the Marginal canvas; call {action:"instructions"} first. To show a doc to the user, open the Marginal canvas instead.`,
    parameters: { type: "object", properties: { action: { type: "string", description: "Action name, e.g. read, edit, changes, export, list, create" }, input: { type: "object", description: "The action's input (include documentId)" } }, required: ["action"] },
    skipPermission: true,
    // A thrown error reaches the agent only as "Tool execution failed", so failures are returned with their message.
    handler: async ({ action, input } = {}) => {
        const fail = (message) => ({ textResultForLlm: message, resultType: "failure" });
        const act = actions.find((a) => a.name === action);
        if (!act) return fail(`Unknown Marginal action ${JSON.stringify(action)}. Actions: ${actions.map((a) => a.name).join(", ")}.`);
        if (HEADLESS_SKIP.has(action)) return fail("show needs a panel: open the Marginal canvas with {documentId}.");
        const inp = { ...(input && typeof input === "object" ? input : {}) };
        if (action === "create" && inp.show === undefined) inp.show = false; // nothing to show it in
        if (action === "create" && inp.show) return fail("create with show needs a panel: open the Marginal canvas, or pass show:false.");
        try {
            return await act.handler({ input: inp, instanceId: null, sessionId: session?.sessionId });
        } catch (e) {
            return fail(e?.message ?? String(e));
        }
    },
};

session = await joinSession({
    tools: [headlessTool],
    canvases: [
        createCanvas({
            id: "marginal",
            displayName: "Marginal",
            description: "Draw structured, code-linked explanations (sequence/flow diagrams, call-stack diffs, schema lenses, verified code peeks) of branches, PRs and ideas; call the 'instructions' action first.",
            inputSchema: { type: ["object", "null"], properties: { documentId: { type: "string", description: "Doc to show; 'scratchpad' for the sketch pad. Omit for the home list." } } },
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
