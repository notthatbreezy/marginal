// LOC index for treemap sizing: `git ls-files -s` + `cat-file --batch` line counts, cached by blob sha per repository.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson, paths } from "../paths.mjs";
import { gitOut, gitx } from "./gitx.mjs";

const HUGE = 2 * 1024 * 1024;
const cacheDir = join(paths.root, "loc-cache");
const caches = new Map(); // repositoryId -> Map(sha -> lines)
const indexes = new Map(); // repositoryId -> { key, files: [[path, lines]], at }

function cacheFor(repositoryId) {
    let c = caches.get(repositoryId);
    if (c) return c;
    c = new Map();
    try {
        for (const [sha, n] of Object.entries(JSON.parse(readFileSync(join(cacheDir, `${repositoryId}.json`), "utf8")))) c.set(sha, n);
    } catch {}
    caches.set(repositoryId, c);
    return c;
}
function saveCache(repositoryId) {
    mkdirSync(cacheDir, { recursive: true });
    atomicWriteJson(join(cacheDir, `${repositoryId}.json`), Object.fromEntries(cacheFor(repositoryId)));
}

/** Count lines of blobs not in the cache; binary and huge blobs count as 1 (visible, never dominant). */
async function countBlobs(repoPath, shas, cache) {
    const todo = [...new Set(shas)].filter((s) => !cache.has(s));
    if (!todo.length) return;
    const check = await gitOut(repoPath, ["cat-file", "--batch-check"], { input: todo.join("\n") + "\n", kind: "cat-file" });
    const small = [];
    for (const line of (check ?? "").split("\n")) {
        const [sha, type, size] = line.split(" ");
        if (!sha || type !== "blob") continue;
        if (Number(size) > HUGE) cache.set(sha, 1);
        else small.push(sha);
    }
    // Read contents in chunks to bound memory.
    for (let i = 0; i < small.length; i += 2000) {
        const chunk = small.slice(i, i + 2000);
        const r = await gitx(repoPath, ["cat-file", "--batch"], { input: chunk.join("\n") + "\n", encoding: "buffer", kind: "cat-file" });
        if (!r.ok) continue;
        const buf = r.stdout;
        let pos = 0;
        while (pos < buf.length) {
            const nl = buf.indexOf(10, pos);
            if (nl < 0) break;
            const [sha, type, sizeStr] = buf.subarray(pos, nl).toString("latin1").split(" ");
            const size = Number(sizeStr);
            const start = nl + 1;
            const body = buf.subarray(start, start + size);
            pos = start + size + 1;
            if (type !== "blob") continue;
            if (!size) {
                cache.set(sha, 0);
                continue;
            }
            if (body.subarray(0, 8000).includes(0)) {
                cache.set(sha, 1);
                continue;
            }
            let n = 0;
            for (let j = 0; j < body.length; j++) if (body[j] === 10) n++;
            cache.set(sha, body[body.length - 1] === 10 ? n : n + 1);
        }
    }
}

/**
 * The repository's tracked files with line counts: { key, files: [[path, lines]] }.
 * Recomputed only when the ls-files output changes; cached per repository.
 */
export async function locIndex(repositoryId, repoPath) {
    const out = await gitOut(repoPath, ["ls-files", "-s", "-z"], { kind: "ls-files" });
    if (out === null) return { key: null, files: [] };
    const entries = [];
    for (const rec of out.split("\0")) {
        if (!rec) continue;
        const tab = rec.indexOf("\t");
        const [mode, sha] = rec.slice(0, tab).split(" ");
        if (mode === "160000") continue; // submodule
        entries.push([rec.slice(tab + 1), sha]);
    }
    const key = `${entries.length}:${hash(out)}`;
    const hit = indexes.get(repositoryId);
    if (hit?.key === key) return hit;
    const cache = cacheFor(repositoryId);
    const before = cache.size;
    await countBlobs(
        repoPath,
        entries.map(([, s]) => s),
        cache,
    );
    if (cache.size !== before) saveCache(repositoryId);
    const idx = { key, files: entries.map(([p, s]) => [p, cache.get(s) ?? 1]), at: new Date().toISOString() };
    indexes.set(repositoryId, idx);
    return idx;
}

function hash(s) {
    return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

export const hasCache = (repositoryId) => existsSync(join(cacheDir, `${repositoryId}.json`));
