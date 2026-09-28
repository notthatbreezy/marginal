// A scripted orchestrator session for the dev server's --progress mode: the same events and RPC results the Copilot
// app delivers (shapes from test/fixtures/progress-run.jsonl), fed through the real collector.
import { appendFileSync } from "node:fs";

const { attachProgress } = await import("../../extensions/marginal/lib/command/collector.mjs");
const { onCommand } = await import("../../extensions/marginal/lib/command/state.mjs");

const sqlNow = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createProgressSession({ sessionId, logFile = null, flushMs = 1000, bare = false }) {
    const handlers = new Set();
    const rows = [];
    const tasks = new Map(); // toolCallId -> TaskInfo (what tasks.list returns)
    const session = {
        sessionId,
        on(fn) {
            handlers.add(fn);
            return () => handlers.delete(fn);
        },
        rpc: {
            plan: { readSqlTodosWithDependencies: async () => ({ rows: rows.map((r) => ({ ...r })), dependencies: [] }) },
            tasks: { list: async () => ({ tasks: [...tasks.values()].map((t) => ({ ...t })) }) },
        },
    };
    const emit = (type, data = {}, agentId) => {
        const ev = { type, id: `${type}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), ...(agentId ? { agentId } : {}), data };
        for (const fn of [...handlers]) fn(ev);
    };
    // The runtime signals background task changes in bursts (mostly shell commands).
    const burst = () => {
        for (let i = 0; i < 6; i++) emit("session.background_tasks_changed");
    };
    let collector = attachProgress(session, { flushMs });
    if (logFile) onCommand((e) => e.kind === "progress" && e.progress && appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), running: e.progress.helpers?.running ?? 0, todos: e.progress.todos ? `${e.progress.todos.done}/${e.progress.todos.total}` : null, now: e.progress.now?.text ?? null }) + "\n"));

    // bare: a session that keeps no todo list and says no intent (only helpers).
    const setTodos = (list) => {
        if (bare) return;
        for (const [id, title, status] of list) {
            const r = rows.find((x) => x.id === id);
            if (r) Object.assign(r, { title, status });
            else rows.push({ id, title, description: "", status, createdAt: sqlNow() });
        }
        emit("session.todos_changed");
    };
    const status = (id, s) => {
        if (bare) return;
        rows.find((x) => x.id === id).status = s;
        emit("session.todos_changed");
    };
    const intent = (text) => bare || emit("assistant.intent", { intent: text });
    let n = 0;
    const start = (name, description, { type = "task", mode = "background", model = "gpt-5.6-terra" } = {}) => {
        const toolCallId = `toolu_${++n}`;
        const agentId = `agent-${n}`;
        tasks.set(toolCallId, { type: "agent", id: agentId, toolCallId, displayName: name, description, status: "running", agentType: type, executionMode: mode, model, startedAt: new Date().toISOString() });
        emit("subagent.started", { toolCallId, agentName: type, agentDisplayName: name, agentDescription: description, agentType: type, model, executionMode: mode }, agentId);
        burst();
        return toolCallId;
    };
    const end = (toolCallId, { failed = null, cancelled = false } = {}) => {
        const t = tasks.get(toolCallId);
        const durationMs = Date.now() - Date.parse(t.startedAt);
        Object.assign(t, { status: failed ? "failed" : cancelled ? "cancelled" : "idle", idleSince: new Date().toISOString(), activeTimeMs: durationMs });
        if (failed) emit("subagent.failed", { toolCallId, agentName: t.agentType, agentDisplayName: t.displayName, error: failed, durationMs }, t.id);
        else emit("subagent.completed", { toolCallId, agentName: t.agentType, agentDisplayName: t.displayName, durationMs, ...(cancelled ? { cancelled: true } : {}) }, t.id);
        burst();
    };

    return {
        session,
        /** Before any phase is in play: the planning todos, which land in Other. */
        async start() {
            setTodos([
                ["read-issue", "Read the issue and draft the plan", "done"],
                ["ask-cron", "Confirm cron-parse's API with its owner", "pending"],
            ]);
            await collector.refresh();
        },
        /** P1 done, P2 implementing: the phase todos (named p1-…, p2-…) and one unnamed todo matched by timing. */
        async phase2() {
            setTodos([
                ["p1-scaffold", "Scaffold the runner docs", "done"],
                ["p2-policy", "Retry policy type and nextDelay()", "done"],
                ["p2-executor", "Wire backoff into the executor", "in_progress"],
                ["p2-sched", "Schedule-aware retries", "pending"],
                ["p2-tests", "Retry policy unit tests", "pending"],
                ["lint-runner", "Fix lint in src/runner", "pending"],
                ["p3-metrics", "Retry metrics", "pending"],
                ["p4-docs", "Document retries", "pending"],
            ]);
            intent("Wiring backoff into the executor");
            const scout = start("map-call-sites", "Find every executor call site", { type: "explore", mode: "sync", model: "gpt-5.6-luna" });
            await sleep(900);
            end(scout);
            await collector.refresh();
        },
        /** The live part, about 30 s. */
        async live({ manyHelpers = false, reload = false } = {}) {
            const at = async (s, fn) => {
                const wait = s * 1000 - (Date.now() - t0);
                if (wait > 0) await sleep(wait);
                fn();
            };
            const t0 = Date.now();
            let rv1, tests, lint, rv2;
            const burstIds = [];
            await at(2, () => (rv1 = start("review-sol", "Review the retry policy (Sol Fast)", { type: "code-review", model: "gpt-5.6-sol-fast" })));
            await at(3, () => (tests = start("run-tests", "Run the runner unit tests", { type: "task", mode: "sync", model: "gpt-5.6-luna" })));
            if (manyHelpers)
                await at(4, () => {
                    for (let i = 1; i <= 12; i++) burstIds.push(start(`scan-${i}`, `Scan package ${i} for retry call sites`, { type: "explore", model: "gpt-5.6-luna" }));
                });
            await at(6, () => intent("Running the executor unit tests"));
            if (reload)
                await at(8, () => {
                    // Extensions reload: the collector goes away; events in the gap reach nobody.
                    collector.stop();
                    collector = null;
                });
            await at(9, () => end(tests));
            if (manyHelpers) for (let i = 0; i < burstIds.length; i++) await at(9 + i, () => end(burstIds[i], i === 4 ? { failed: "timed out" } : {}));
            await at(10, () => {
                status("p2-executor", "done");
                status("p2-sched", "in_progress");
            });
            if (reload)
                await at(12, () => {
                    collector = attachProgress(session, { flushMs }); // rebuilt from progress.json + the two reads
                });
            await at(13, () => (lint = start("fix-lint", "Fix lint in src/runner", { type: "task", model: "gpt-5.5" })));
            await at(15, () => (rv2 = start("review-terra", "Review the retry policy (Terra)", { type: "code-review", model: "gpt-5.6-terra" })));
            await at(16, () => end(lint, { failed: "lint: 3 errors in executor.ts" }));
            await at(18, () => intent("Waiting on 2 reviewers"));
            await at(22, () => end(rv1));
            await at(24, () => end(rv2, { cancelled: true }));
            await at(26, () => {
                status("p2-sched", "done");
                status("p2-tests", "in_progress");
                intent("Writing the retry policy unit tests");
            });
        },
        stop: () => collector?.stop(),
    };
}
