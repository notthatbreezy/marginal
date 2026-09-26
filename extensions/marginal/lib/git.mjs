// Read-only Git access against pinned, immutable commits.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { InputError } from "./errors.mjs";
import { atomicWriteJson, paths } from "./paths.mjs";

const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd, args, { allowFail = false } = {}) {
    return new Promise((resolvePromise, reject) => {
        execFile(
            "git",
            ["-c", "core.quotepath=off", "-c", "color.ui=never", ...args],
            { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
            (error, stdout, stderr) => {
                if (error && !allowFail) {
                    const message = (stderr || error.message || "").trim().split("\n").slice(0, 3).join(" ");
                    reject(new InputError(`git ${args[0]} failed: ${message}`));
                    return;
                }
                resolvePromise(error ? null : stdout);
            },
        );
    });
}

function run(cmd, args, cwd) {
    return new Promise((resolvePromise) => {
        execFile(cmd, args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) =>
            resolvePromise(error ? { ok: false, error: (stderr || error.message).trim() } : { ok: true, stdout }),
        );
    });
}

/** Repository-relative, forward-slash paths only; nothing that could escape the repo. */
export function checkSourcePath(file) {
    if (
        typeof file !== "string" ||
        file.trim() === "" ||
        file.startsWith("/") ||
        file.includes("\\") ||
        /^[a-zA-Z]:/.test(file) ||
        file.split("/").some((part) => part === ".." || part === ".") ||
        /[\u0000-\u001f]/.test(file)
    )
        throw new InputError(`Source file must be a repository-relative path with forward slashes: ${JSON.stringify(file)}`);
}

// ---------- repository registry ----------

let registry = null;

function loadRegistry() {
    if (registry) return registry;
    try {
        registry = JSON.parse(readFileSync(paths.repositories, "utf8"));
    } catch {
        registry = { repositories: [] };
    }
    return registry;
}

function saveRegistry() {
    atomicWriteJson(paths.repositories, registry);
}

export function listRepositories() {
    return loadRegistry().repositories.map(({ id, name, path }) => ({ id, name, path }));
}

export function getRepository(repositoryId) {
    const repo = loadRegistry().repositories.find((r) => r.id === repositoryId);
    if (!repo) throw new InputError(`Unknown repositoryId: ${repositoryId}. Call register_repository first.`);
    return repo;
}

export async function registerRepository(path) {
    if (typeof path !== "string" || !path.trim()) throw new InputError("path is required.");
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new InputError(`Not a directory: ${abs}`);
    const top = (await git(abs, ["rev-parse", "--show-toplevel"])).trim();
    const root = resolve(top);
    const reg = loadRegistry();
    const existing = reg.repositories.find((r) => r.path.toLowerCase() === root.toLowerCase());
    if (existing) return { repositoryId: existing.id, name: existing.name, path: existing.path, created: false };
    const name = basename(root);
    const hash = createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 6);
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo"}-${hash}`;
    reg.repositories.push({ id, name, path: root, registeredAt: new Date().toISOString() });
    saveRegistry();
    return { repositoryId: id, name, path: root, created: true };
}

// ---------- revisions ----------

export async function resolveCommit(repositoryId, rev) {
    const repo = getRepository(repositoryId);
    if (typeof rev !== "string" || !rev.trim() || rev.startsWith("-")) throw new InputError(`Invalid revision: ${rev}`);
    const out = await git(repo.path, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true });
    if (!out) throw new InputError(`Revision not found in ${repo.name}: ${rev}`);
    return out.trim();
}

/**
 * Resolve a comparison to immutable commits. With mergeBase (the default when
 * base and head differ), base becomes the merge-base so the comparison shows
 * only what head adds, like a pull request.
 */
export async function resolvePins(repositoryId, base, head, { mergeBase = true } = {}) {
    const headSha = await resolveCommit(repositoryId, head ?? "HEAD");
    let baseSha = await resolveCommit(repositoryId, base ?? head ?? "HEAD");
    if (mergeBase && baseSha !== headSha) {
        const repo = getRepository(repositoryId);
        const mb = await git(repo.path, ["merge-base", baseSha, headSha], { allowFail: true });
        if (mb) baseSha = mb.trim();
    }
    return { repositoryId, base: baseSha, head: headSha };
}

/** The branch a change most likely targets: origin/HEAD, then main/master (remote first). */
export async function defaultBase(repositoryId) {
    const repo = getRepository(repositoryId);
    const sym = await git(repo.path, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFail: true });
    if (sym) return sym.trim().replace(/^refs\/remotes\//, "");
    for (const rev of ["origin/main", "origin/master", "main", "master"]) {
        const ok = await git(repo.path, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true });
        if (ok) return rev;
    }
    return "HEAD";
}

export async function describeCommit(repositoryId, sha) {
    const repo = getRepository(repositoryId);
    const out = await git(repo.path, ["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%aI", sha]);
    const [hash, subject, author, date] = out.trim().split("\x1f");
    return { sha: hash, subject, author, date };
}

// ---------- file content (immutable per commit, so cacheable) ----------

const fileCache = new Map();
const FILE_CACHE_LIMIT = 400;

export async function readFileAt(repositoryId, commit, file) {
    checkSourcePath(file);
    const key = `${repositoryId}\0${commit}\0${file}`;
    if (fileCache.has(key)) return fileCache.get(key);
    const repo = getRepository(repositoryId);
    const out = await git(repo.path, ["show", `${commit}:${file}`], { allowFail: true });
    let entry;
    if (out === null) entry = { exists: false };
    else if (out.includes("\u0000")) entry = { exists: true, binary: true, lines: [] };
    else {
        // Tolerate stray carriage returns (e.g. \r\r\n) so they never reach rendered or copied code.
        const lines = out.split(/\r*\n/).map((l) => l.replace(/\r+$/, ""));
        if (out.endsWith("\n")) lines.pop();
        entry = { exists: true, binary: false, lines };
    }
    if (fileCache.size >= FILE_CACHE_LIMIT) fileCache.delete(fileCache.keys().next().value);
    fileCache.set(key, entry);
    return entry;
}

export async function listTree(repositoryId, commit, path = "") {
    if (path) checkSourcePath(path.replace(/\/$/, ""));
    const repo = getRepository(repositoryId);
    const spec = path ? `${commit}:${path.replace(/\/$/, "")}` : `${commit}:`;
    const out = await git(repo.path, ["ls-tree", "-z", "--long", spec], { allowFail: true });
    if (out === null) throw new InputError(`Not a directory at ${commit.slice(0, 8)}: ${path || "/"}`);
    return out
        .split("\0")
        .filter(Boolean)
        .map((line) => {
            const [meta, name] = line.split("\t");
            const [, type, , size] = meta.split(/\s+/);
            return { name, path: path ? `${path.replace(/\/$/, "")}/${name}` : name, type: type === "tree" ? "dir" : "file", size: size === "-" ? undefined : Number(size) };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

// ---------- diffs ----------

function pathspec(paths) {
    if (!paths?.length) return [];
    for (const p of paths) checkSourcePath(p.replace(/\/$/, ""));
    return ["--", ...paths];
}

export async function diffFiles(repositoryId, base, head, paths) {
    if (base === head) return [];
    const repo = getRepository(repositoryId);
    const [statusOut, numOut] = await Promise.all([
        git(repo.path, ["diff", "--name-status", "-M", "-z", base, head, ...pathspec(paths)]),
        git(repo.path, ["diff", "--numstat", "-M", "-z", base, head, ...pathspec(paths)]),
    ]);
    const files = [];
    const parts = statusOut.split("\0").filter((p) => p !== "");
    for (let i = 0; i < parts.length; ) {
        const code = parts[i++];
        const letter = code[0];
        if (letter === "R" || letter === "C") {
            files.push({ status: letter === "R" ? "renamed" : "copied", previousPath: parts[i++], path: parts[i++] });
        } else {
            files.push({ status: { A: "added", D: "deleted", M: "modified", T: "modified" }[letter] ?? "modified", path: parts[i++] });
        }
    }
    // numstat -z: "add\tdel\tpath\0" or "add\tdel\t\0old\0new\0" for renames.
    const stats = new Map();
    const np = numOut.split("\0");
    for (let i = 0; i < np.length; i++) {
        const rec = np[i];
        if (!rec) continue;
        const [add, del, p] = rec.split("\t");
        let file = p;
        if (p === "" || p === undefined) {
            i += 2;
            file = np[i];
        }
        stats.set(file, { additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del), binary: add === "-" });
    }
    return files.map((f) => ({ ...f, ...(stats.get(f.path) ?? { additions: 0, deletions: 0 }) }));
}

/** Parse a unified diff into files and hunks with explicit line numbers per side. */
export function parsePatch(text) {
    const files = [];
    let file = null;
    let hunk = null;
    let baseLine = 0;
    let headLine = 0;
    for (const line of text.split("\n")) {
        if (line.startsWith("diff --git ")) {
            const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
            file = { path: m ? m[2] : line, previousPath: m && m[1] !== m[2] ? m[1] : undefined, header: [], hunks: [] };
            files.push(file);
            hunk = null;
            continue;
        }
        if (!file) continue;
        const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
        if (h) {
            baseLine = Number(h[1]);
            headLine = Number(h[3]);
            hunk = { header: line, context: h[5].trim(), lines: [] };
            file.hunks.push(hunk);
            continue;
        }
        if (!hunk) {
            if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
            if (line) file.header.push(line);
            continue;
        }
        if (line.startsWith("+")) hunk.lines.push({ kind: "add", head: headLine++, text: line.slice(1) });
        else if (line.startsWith("-")) hunk.lines.push({ kind: "del", base: baseLine++, text: line.slice(1) });
        else if (line.startsWith(" ")) hunk.lines.push({ kind: "ctx", base: baseLine++, head: headLine++, text: line.slice(1) });
    }
    return files;
}

export async function diffPatch(repositoryId, base, head, paths, { context = 3 } = {}) {
    if (base === head) return "";
    const repo = getRepository(repositoryId);
    const ctx = Math.max(0, Math.min(200, Number.isFinite(context) ? Math.floor(context) : 3));
    return git(repo.path, ["diff", "-M", `-U${ctx}`, "--no-ext-diff", base, head, ...pathspec(paths)]);
}

/** Agent-friendly patch text: every hunk line carries its base and head line numbers. */
export function numberPatch(text, maxBytes = 40000) {
    const files = parsePatch(text);
    const out = [];
    let used = 0;
    const skipped = [];
    for (const f of files) {
        const chunk = [`diff --git a/${f.previousPath ?? f.path} b/${f.path}`, ...f.header];
        for (const h of f.hunks) {
            chunk.push(h.header);
            for (const l of h.lines) {
                const b = l.base === undefined ? "" : String(l.base);
                const hd = l.head === undefined ? "" : String(l.head);
                const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
                chunk.push(`${b.padStart(5)} ${hd.padStart(5)} ${mark} ${l.text}`);
            }
        }
        const s = chunk.join("\n") + "\n";
        if (used + s.length > maxBytes && out.length) {
            skipped.push(f.path);
            continue;
        }
        if (used + s.length > maxBytes) {
            out.push(s.slice(0, maxBytes) + "\n[… file truncated at byte budget …]\n");
            used = maxBytes;
            continue;
        }
        out.push(s);
        used += s.length;
    }
    if (skipped.length)
        out.push(`[${skipped.length} more files over the ${maxBytes}-byte budget: ${skipped.join(", ")}. Fetch them with paths:[…], format:"patch".]`);
    return out.join("\n");
}

export async function listCommits(repositoryId, base, head) {
    if (base === head) return [];
    const repo = getRepository(repositoryId);
    const out = await git(repo.path, ["log", "--first-parent", "--format=%H%x1f%an%x1f%aI%x1f%s", `${base}..${head}`, "--max-count=500"]);
    return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [sha, author, date, subject] = line.split("\x1f");
            return { sha, author, date, subject };
        });
}

// ---------- pull requests ----------

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/i;

export function parsePullRequestUrl(url) {
    const m = PR_URL.exec(url ?? "");
    if (!m) throw new InputError("pullRequestUrl must look like https://github.com/owner/repo/pull/123");
    return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
}

/** Fetch a PR's head and base into private refs (never moving branches) and pin head against its merge-base. */
export async function resolvePullRequest(repositoryId, url) {
    const pr = parsePullRequestUrl(url);
    const repo = getRepository(repositoryId);
    const remotesOut = await git(repo.path, ["remote", "-v"]);
    const slug = `${pr.owner}/${pr.repo}`.toLowerCase();
    const remote = remotesOut
        .split("\n")
        .map((l) => l.split(/\s+/))
        .find(([, u]) => u && u.toLowerCase().replace(/\.git$/, "").endsWith(slug))?.[0];
    if (!remote) throw new InputError(`No remote in ${repo.name} points at github.com/${pr.owner}/${pr.repo}.`);
    const view = await run("gh", ["pr", "view", String(pr.number), "--repo", `${pr.owner}/${pr.repo}`, "--json", "title,baseRefName,headRefName,state"], repo.path);
    if (!view.ok) throw new InputError(`gh pr view failed (${view.error}). Pass an explicit target instead.`);
    const info = JSON.parse(view.stdout);
    const refBase = `refs/marginal/github/${pr.owner}/${pr.repo}/pull/${pr.number}`;
    await git(repo.path, ["fetch", "--no-tags", remote, `+refs/pull/${pr.number}/head:${refBase}/head`, `+refs/heads/${info.baseRefName}:${refBase}/base`]);
    const pins = await resolvePins(repositoryId, `${refBase}/base`, `${refBase}/head`, { mergeBase: true });
    return { pins, title: info.title, baseRef: info.baseRefName, headRef: info.headRefName, state: info.state, url: pr.url };
}
