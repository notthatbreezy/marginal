// The `pr` canvas action: a doc's pull requests, for agents. Thin over the service (index.mjs). Nothing here asks
// an agent to poll or report: Marginal watches GitHub itself, and sees commits, replies and resolved threads.
import { InputError } from "../errors.mjs";

const OPS = ["register", "remove", "list", "read", "refresh", "report", "settings"];

export const DESCRIPTION =
    'A doc\'s pull requests (the Pull requests tab); Marginal watches them on GitHub itself and sends new review comments to this session when the user asks it to. op "register" {url, label?, stacksOn?:<prId or URL of another PR on the doc>, worktree?} adds one (a doc made from a PR has it already); "list"; "read" {prId, threadId?, threads?:"unresolved"|"new"|"all"} returns it as Marginal last saw it (no GitHub call); "refresh" {prId} checks GitHub now; "report" {prId, threads:[{threadId, status:"assessed"|"fixed"|"reviewed"|"declined"|"question", note?, commit?}]} (optional) records what GitHub can\'t show; "settings" {prId, watch?, handle?:"none"|"read"|"assess"|"remediate"|"localReview"|"pushResolve", deliver?:"queue"|"interrupt"} when the user asks; "remove" {prId}. See instructions topic "prs".';

export function prActions({ resolveDoc, service }) {
    return [
        {
            name: "pr",
            description: DESCRIPTION,
            inputSchema: { type: "object", properties: { documentId: { type: "string" }, op: { type: "string", description: OPS.join(" | ") }, prId: { type: "string" }, url: { type: "string" } }, required: ["op"] },
            handler: async (ctx) => {
                const i = ctx.input ?? {};
                const docId = resolveDoc(i, ctx);
                switch (i.op) {
                    case "register": {
                        if (!i.url) throw new InputError("register needs url (https://<host>/<owner>/<repo>/pull/<n>).");
                        const r = service.register(docId, { url: i.url, label: i.label, stacksOn: i.stacksOn, worktree: i.worktree, settings: i.settings, by: "agent" });
                        const o = service.ownership(docId);
                        return {
                            prId: r.entry.id,
                            created: r.created,
                            url: r.entry.url,
                            stacksOn: r.entry.stacksOn,
                            settings: r.entry.settings,
                            watching: r.watching ? "this session" : o.watcher ? `session ${o.watcher}` : "nobody",
                            note: r.created ? "Marginal fetches it now and watches it from here; you don't need to check GitHub for comments." : "Already on this doc; updated what you passed.",
                        };
                    }
                    case "list":
                        return {
                            prs: (await service.list(docId)).prs.map((p) => ({ prId: p.id, url: p.url, title: p.title, state: p.state, reviewDecision: p.reviewDecision, checks: p.checks, threads: p.threads, stacksOn: p.stacksOn, label: p.label, settings: p.settings, batch: p.batch, stopped: p.stopped, error: p.error?.message ?? null })),
                        };
                    case "read":
                        return service.read(docId, need(i, "prId"), { threadId: i.threadId ?? null, threads: i.threads ?? "unresolved" });
                    case "refresh":
                        return service.refresh(docId, need(i, "prId")).then((p) => ({ prId: p.id, state: p.state, checks: p.checks, threads: p.threads, checkedAt: p.checkedAt }));
                    case "report":
                        return service.report(docId, need(i, "prId"), i.threads);
                    case "settings":
                        return service.settings(docId, need(i, "prId"), { watch: i.watch, handle: i.handle, steps: i.steps, deliver: i.deliver, label: i.label, worktree: i.worktree }, { by: "agent" });
                    case "remove":
                        return service.remove(docId, need(i, "prId"));
                    default:
                        throw new InputError(`op must be one of ${OPS.join(", ")}.`);
                }
            },
        },
    ];
}

function need(i, k) {
    if (typeof i[k] !== "string" || !i[k]) throw new InputError(`${k} is required.`);
    return i[k];
}
