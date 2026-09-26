// Git runner for Command: any worktree, no shell, never takes optional locks, ≤ 4 concurrent processes.
import { execFile } from "node:child_process";

const MAX_CONCURRENT = 4;
const MAX_BUFFER = 64 * 1024 * 1024;
let running = 0;
const queue = [];

/** Per-process counters; tests use them to prove pollers are deduplicated. */
export const gitStats = { total: 0, byKind: {} };

function acquire() {
    if (running < MAX_CONCURRENT) {
        running++;
        return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
}
function release() {
    const next = queue.shift();
    if (next) next();
    else running--;
}

/**
 * Run git in `cwd`. Resolves { ok, code, stdout, stderr }; never rejects for a non-zero exit.
 * `env` is merged over process.env (used for GIT_INDEX_FILE snapshots).
 */
export async function gitx(cwd, args, { env, input, encoding = "utf8", kind } = {}) {
    await acquire();
    gitStats.total++;
    const k = kind ?? args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "?";
    gitStats.byKind[k] = (gitStats.byKind[k] ?? 0) + 1;
    try {
        return await new Promise((resolve) => {
            const child = execFile(
                "git",
                ["--no-optional-locks", "-c", "core.longpaths=true", "-c", "core.quotepath=off", "-c", "color.ui=never", ...args],
                { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: MAX_BUFFER, windowsHide: true, encoding },
                (error, stdout, stderr) => resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, stdout, stderr: String(stderr ?? "") }),
            );
            if (input !== undefined) child.stdin.end(input);
        });
    } finally {
        release();
    }
}

/** Convenience: stdout on success, null otherwise. */
export async function gitOut(cwd, args, opts) {
    const r = await gitx(cwd, args, opts);
    return r.ok ? r.stdout : null;
}
