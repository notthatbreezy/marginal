// Hunk rows for deep semantic zoom: `git diff -U0 <base> -- <file>` per front, labelled with git's function context.
import { gitOut, gitx } from "./gitx.mjs";
import { normalizeRepoPath } from "./patterns.mjs";

/** Parse `-U0` output into [{ context, baseStart, baseLen, headStart, headLen, add, del }]. */
export function parseHunks(text) {
    const out = [];
    let cur = null;
    for (const line of text.split("\n")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
        if (m) {
            cur = { context: m[5].trim(), baseStart: Number(m[1]), baseLen: m[2] === undefined ? 1 : Number(m[2]), headStart: Number(m[3]), headLen: m[4] === undefined ? 1 : Number(m[4]), add: 0, del: 0 };
            out.push(cur);
        } else if (cur && line.startsWith("+") && !line.startsWith("+++")) cur.add++;
        else if (cur && line.startsWith("-") && !line.startsWith("---")) cur.del++;
    }
    return out;
}

/** Group adjacent hunks under the same function context so rows read as "@@ fn()  +n −m". */
export function groupHunks(hunks) {
    const rows = [];
    for (const hk of hunks) {
        const label = hk.context || `line ${Math.max(1, hk.headLen === 0 ? hk.headStart + 1 : hk.headStart)}`;
        const last = rows.at(-1);
        if (last && last.label === label) {
            last.add += hk.add;
            last.del += hk.del;
            last.hunks++;
        } else rows.push({ label, add: hk.add, del: hk.del, headStart: hk.headStart, hunks: 1 });
    }
    return rows;
}

export async function fileHunks(worktree, base, file) {
    const n = normalizeRepoPath(file);
    if (n.error) throw new Error(n.message);
    const out = await gitOut(worktree, ["diff", "-U0", "--no-ext-diff", "--no-color", base, "--", n.path], { kind: "diff-hunks" });
    return out === null ? [] : groupHunks(parseHunks(out)); // new files have no function context worth listing;
}

/** Untracked files have no diff against base; show them as all-added (`git diff --no-index` exits 1 on differences). */
async function untrackedPatch(worktree, path, context) {
    const tracked = await gitx(worktree, ["ls-files", "--error-unmatch", "--", path], { kind: "ls-files" });
    if (tracked.ok) return "";
    const r = await gitx(worktree, ["diff", "--no-index", `-U${context}`, "--no-ext-diff", "--no-color", "--", "/dev/null", path], { kind: "diff-untracked" });
    return r.code === 1 ? r.stdout : "";
}

/** Unified patch for one file in one front's worktree (monitor diff-feed rows). */
export async function filePatch(worktree, base, file, context = 3) {
    const n = normalizeRepoPath(file);
    if (n.error) throw new Error(n.message);
    const ctx = Math.max(0, Math.min(20, context));
    const out = (await gitOut(worktree, ["diff", `-U${ctx}`, "--no-ext-diff", "--no-color", base, "--", n.path], { kind: "diff-patch" })) ?? "";
    return out || untrackedPatch(worktree, n.path, ctx);
}
