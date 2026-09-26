// Headless dev server for the Command tab: a temp "relay" repo with worktrees, a real plan + fronts driven through the
// command actions, scripted edits, and the real loopback server. No Copilot session needed; nothing takes focus.
// Usage: node tools/devserver.mjs [--edits] [--seconds=N]   → prints JSON {url, instance, docId, repo, fronts}
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = new Set(process.argv.slice(2));
const seconds = Number([...args].find((a) => a.startsWith("--seconds="))?.split("=")[1] ?? 600);
const tmp = mkdtempSync(join(tmpdir(), "wb-dev-"));
process.env.COPILOT_HOME = join(tmp, "home");

const store = await import("../lib/store.mjs");
const gitm = await import("../lib/git.mjs");
const { ACTIONS } = await import("../lib/command/actions.mjs");
const poller = await import("../lib/command/poller.mjs");
const { startServer } = await import("../lib/server.mjs");
poller.CADENCE.fast = 500;
poller.CADENCE.slow = 1500;

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `// ${tag} ${i}`).join("\n") + "\n";
const FILES = {
    "src/runner/executor.ts": 420, "src/runner/queue.ts": 260, "src/runner/lease.ts": 210, "src/runner/worker-pool.ts": 340,
    "src/triggers/schedule.ts": 380, "src/triggers/webhook.ts": 290, "src/triggers/cron-parse.ts": 450, "src/triggers/index.ts": 40,
    "src/api/routes.ts": 520, "src/api/auth.ts": 310, "src/api/handlers/jobs.ts": 410, "src/api/handlers/runs.ts": 360, "src/api/handlers/health.ts": 60,
    "src/store/db.ts": 280, "src/store/runs-repo.ts": 330, "src/store/migrations/001_init.sql": 140, "src/store/migrations/002_runs.sql": 90,
    "src/telemetry/metrics.ts": 220, "src/telemetry/tracing.ts": 180, "src/util/time.ts": 120, "src/util/ids.ts": 60, "src/util/errors.ts": 140,
    "tests/runner/executor.test.ts": 300, "tests/triggers/schedule.test.ts": 240, "tests/api/routes.test.ts": 280,
    "docs/runner.md": 180, "docs/api.md": 260, "docs/ops.md": 140,
    "web/app.tsx": 600, "web/components/Table.tsx": 300, "web/components/Chart.tsx": 420, "web/components/Nav.tsx": 150, "web/styles.css": 500,
    "package.json": 60, "README.md": 120,
};
const repo = join(tmp, "relay");
for (const [p, n] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), lines(n, p));
}
git(tmp, "init", "-q", "-b", "main", repo);
git(repo, "config", "user.email", "dev@example.com");
git(repo, "config", "user.name", "dev");
git(repo, "add", ".");
git(repo, "commit", "-qm", "relay base");
const wts = { runner: join(tmp, "wt-runner"), triggers: join(tmp, "wt-triggers"), tests: join(tmp, "wt-tests") };
git(repo, "worktree", "add", "-q", wts.runner, "-b", "feature/retry");
git(repo, "worktree", "add", "-q", wts.triggers, "-b", "feature/sched");
git(repo, "worktree", "add", "-q", wts.tests, "-b", "feature/tests");

const rec = await gitm.registerRepository(repo);
const pins = await gitm.resolvePins(rec.repositoryId, "main", "main");
const doc = await store.create({ title: "Retry policy for job runner", target: pins });
const ctx = { docId: doc.documentId, doc: store.getDoc(doc.documentId), repo: gitm.getRepository(rec.repositoryId), sessionId: "orchestrator-dev" };
const call = async (name, input) => {
    const r = await ACTIONS[name](input, ctx);
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.issues)}`);
    return r;
};

await call("command_plan", {
    op: "set",
    plan: {
        id: "retry",
        title: "Retry policy for job runner",
        phases: [
            { id: "p1", title: "Scaffold", expects: ["docs/runner.md"] },
            {
                id: "p2",
                title: "Retry policy",
                expects: ["src/runner/", "src/store/migrations/", "tests/runner/"],
                steps: [
                    { id: "s-backoff", title: "Wire backoff into executor", expects: ["src/runner/retry/"] },
                    { id: "s-sched", title: "Schedule-aware retries", expects: ["src/triggers/schedule.ts", "src/store/runs-repo.ts"] },
                    { id: "s-tests", title: "Retry policy unit tests", expects: ["tests/runner/"] },
                ],
            },
            { id: "p3", title: "Telemetry", expects: ["src/telemetry/"] },
            { id: "p4", title: "Docs", expects: ["docs/"] },
        ],
    },
});
await call("command_front", { op: "register", id: "orchestrator", label: "orchestrator", worktree: repo });
await call("command_front", { op: "register", id: "runner", label: "runner-retry", worktree: wts.runner });
await call("command_front", { op: "register", id: "triggers", label: "triggers-sched", worktree: wts.triggers });
await call("command_front", { op: "register", id: "tests", label: "tests", worktree: wts.tests });
await call("command_plan", { op: "phase", phaseId: "p1", status: "active", frontIds: ["orchestrator"] });

// Scripted edits. Phase 1 happened "earlier"; phase 2 is live.
const edit = (wt, p, n, tag = "edit") => {
    const f = join(wt, p);
    mkdirSync(dirname(f), { recursive: true });
    let cur = "";
    try {
        cur = readFileSync(f, "utf8");
    } catch {}
    writeFileSync(f, cur + lines(n, tag));
};
const shrink = (wt, p, n) => {
    const f = join(wt, p);
    const ls = readFileSync(f, "utf8").split("\n");
    writeFileSync(f, ls.slice(n).join("\n"));
};
edit(repo, "docs/runner.md", 18, "docs");
await new Promise((r) => setTimeout(r, 1200));
await call("command_plan", { op: "phase", phaseId: "p1", status: "done", commit: git(repo, "rev-parse", "HEAD") });
await call("command_front", { op: "status", id: "orchestrator", status: "done" });
await call("command_view", { op: "set", phaseId: "p2", view: { id: "p2-retry", title: "Retry policy", root: "src", pins: [{ path: "src/runner" }] } });
await call("command_plan", { op: "phase", phaseId: "p2", status: "active", frontIds: ["runner", "triggers", "tests"] });
await call("command_plan", { op: "step", stepId: "s-backoff", status: "active", frontId: "runner" });
await call("command_plan", { op: "step", stepId: "s-sched", status: "active", frontId: "triggers" });
await call("command_plan", { op: "step", stepId: "s-tests", status: "active", frontId: "tests" });
await call("command_status", { status: "working" });

const script = [
    () => edit(wts.runner, "src/runner/retry/policy.ts", 180),
    () => edit(wts.runner, "src/runner/retry/backoff.ts", 120),
    () => edit(wts.runner, "src/runner/executor.ts", 64) || shrink(wts.runner, "src/runner/executor.ts", 22),
    () => edit(wts.runner, "src/store/migrations/003_retry.sql", 40),
    () => edit(wts.runner, "src/util/time.ts", 14),
    () => edit(wts.triggers, "src/triggers/schedule.ts", 48) || shrink(wts.triggers, "src/triggers/schedule.ts", 31),
    () => edit(wts.triggers, "src/triggers/cron-parse.ts", 6),
    () => edit(wts.tests, "tests/runner/retry.test.ts", 160),
    () => edit(wts.tests, "tests/runner/executor.test.ts", 42),
    () => edit(wts.runner, "src/store/runs-repo.ts", 26),
    () => edit(wts.tests, "src/store/runs-repo.ts", 8),
    () => edit(wts.runner, "src/runner/queue.ts", 12),
];
for (const step of script) {
    step();
    await new Promise((r) => setTimeout(r, 250));
}
await call("command_front", { op: "status", id: "triggers", status: "blocked", note: "Needs a decision on cron-parse's public API" });

const instances = new Map([["dev", { documentId: doc.documentId }]]);
instances.save = () => {};
const chat = { subscribe: () => () => {}, send: async () => ({ threadId: "t", messageId: "m" }), end: () => {} };
const s = await startServer({ chat, instances, getSessionId: () => "orchestrator-dev" });
process.stdout.write(JSON.stringify({ url: s.urlFor("dev"), instance: "dev", docId: doc.documentId, repo, fronts: wts, tmp }) + "\n");

if (args.has("--edits")) {
    let i = 0;
    const tick = setInterval(() => {
        const k = i++ % 3;
        if (k === 0) edit(wts.runner, "src/runner/retry/backoff.ts", 3, "live");
        if (k === 1) edit(wts.tests, "tests/runner/retry.test.ts", 4, "live");
        if (k === 2) edit(wts.runner, "src/runner/executor.ts", 2, "live");
    }, 1500);
    tick.unref();
}
setTimeout(() => process.exit(0), seconds * 1000);
