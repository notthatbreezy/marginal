// Checkpoint snapshots (also verified with Windows long paths): commit a worktree's current contents into a hidden commit
// without touching its branch, HEAD, real index or files. The temp index is seeded from a copy of the real index so
// `add -A` reuses its stat cache (cheaper than read-tree + full rehash).
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { gitOut, gitx } from "./gitx.mjs";

export const refFor = (docId, name) => `refs/whiteboard/checkpoints/${docId}/${name}`;

export async function snapshotWorktree(worktree, { message, ref } = {}) {
    const idxRel = (await gitOut(worktree, ["rev-parse", "--git-path", "index"], { kind: "rev-parse" }))?.trim();
    const head = (await gitOut(worktree, ["rev-parse", "HEAD"], { kind: "rev-parse" }))?.trim();
    if (!idxRel || !head) throw new Error(`not a git worktree: ${worktree}`);
    const realIndex = isAbsolute(idxRel) ? idxRel : resolve(worktree, idxRel);
    const dir = mkdtempSync(join(tmpdir(), "wb-snap-"));
    const tmpIndex = join(dir, "index");
    try {
        if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
        const env = { GIT_INDEX_FILE: tmpIndex };
        if (!existsSync(realIndex)) {
            const rt = await gitx(worktree, ["read-tree", "HEAD"], { env, kind: "read-tree" });
            if (!rt.ok) throw new Error(rt.stderr.trim());
        }
        const add = await gitx(worktree, ["add", "-A"], { env, kind: "add" });
        if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
        const tree = (await gitOut(worktree, ["write-tree"], { env, kind: "write-tree" }))?.trim();
        if (!tree) throw new Error("git write-tree failed");
        const sha = (await gitOut(worktree, ["-c", "user.name=Whiteboard", "-c", "user.email=whiteboard@localhost", "commit-tree", tree, "-p", head, "-m", message ?? "whiteboard checkpoint"], { kind: "commit-tree" }))?.trim();
        if (!sha) throw new Error("git commit-tree failed");
        if (ref) {
            const u = await gitx(worktree, ["update-ref", ref, sha], { kind: "update-ref" });
            if (!u.ok) throw new Error(`git update-ref failed: ${u.stderr.trim()}`);
        }
        return { sha, head, tree };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Remove every checkpoint ref of a document (called when the whiteboard is deleted). */
export async function dropRefs(repoPath, docId) {
    const out = await gitOut(repoPath, ["for-each-ref", "--format=%(refname)", `refs/whiteboard/checkpoints/${docId}/`], { kind: "for-each-ref" });
    for (const ref of (out ?? "").split("\n").filter(Boolean)) await gitx(repoPath, ["update-ref", "-d", ref], { kind: "update-ref" });
}
