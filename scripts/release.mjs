#!/usr/bin/env node
// Cut a release: bump the version everywhere it lives, turn CHANGELOG's "Unreleased" section into that version,
// commit and tag. Nothing is pushed; the script prints the one command that publishes it.
//
//   node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run]
//
// Usually run by the "release" GitHub Actions workflow (Actions → release → Run workflow), which also pushes and
// publishes. Locally, pushing the tag runs the same workflow's publish job.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { MANIFESTS, bump, cutChangelog, die, readJson, versions, writeJson } from "./release-lib.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const which = args.find((a) => !a.startsWith("--"));
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
try {
    if (!which) die("usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run]");
    const v = versions();
    if (new Set(Object.values(v)).size !== 1) die(`manifest versions disagree: ${JSON.stringify(v)}`);
    const current = v.plugin;
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    const next = tags.length === 0 && /^\d+\.\d+\.\d+$/.test(which) ? which : bump(current, which);
    if (tags.includes(`v${next}`)) die(`tag v${next} already exists`);
    if (git("branch", "--show-current") !== "main") die("release from main");
    if (git("status", "--porcelain")) (dry ? console.warn : die)("the working tree has uncommitted changes");
    let fetched = true;
    try {
        git("fetch", "--quiet", "origin", "main");
    } catch {
        fetched = false;
        console.warn("release: couldn't reach origin; continuing with the local main");
    }
    if (fetched && git("rev-list", "--count", "HEAD..origin/main") !== "0") die("main is behind origin/main; pull first");
    const date = new Date().toISOString().slice(0, 10);
    const { text, notes } = cutChangelog(readFileSync("CHANGELOG.md", "utf8"), next, date);
    console.log(`Releasing v${next} (was ${current})\n\n${notes}\n`);
    if (dry) process.exit(0);
    console.log("Running tests…");
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], { stdio: "inherit", shell: process.platform === "win32" });
    const plugin = readJson(MANIFESTS.plugin);
    plugin.version = next;
    writeJson(MANIFESTS.plugin, plugin);
    const market = readJson(MANIFESTS.marketplace);
    market.metadata.version = next;
    for (const p of market.plugins) if (p.name === plugin.name) p.version = next;
    writeJson(MANIFESTS.marketplace, market);
    const pkg = readJson(MANIFESTS.pkg);
    pkg.version = next;
    writeJson(MANIFESTS.pkg, pkg);
    writeFileSync("CHANGELOG.md", text);
    git("add", MANIFESTS.plugin, MANIFESTS.marketplace, MANIFESTS.pkg, "CHANGELOG.md");
    git("commit", "-m", `Release v${next}`);
    git("tag", "-a", `v${next}`, "-m", `v${next}\n\n${notes}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=v${next}\n`); // the release workflow publishes it
    console.log(`\nTagged v${next}. Publish it with:\n\n  git push origin main --follow-tags\n`);
} catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
}
