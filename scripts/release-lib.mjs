// Release helpers shared by scripts/release.mjs and the tests.
import { readFileSync, writeFileSync } from "node:fs";

export const MANIFESTS = { plugin: "plugin.json", marketplace: ".github/plugin/marketplace.json", pkg: "package.json" };
export const die = (msg) => {
    throw new Error(msg);
};
export const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
export const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);

export function versions() {
    const plugin = readJson(MANIFESTS.plugin);
    const market = readJson(MANIFESTS.marketplace);
    const pkg = readJson(MANIFESTS.pkg);
    return { plugin: plugin.version, marketplace: market.metadata?.version, marketplacePlugin: market.plugins?.find((p) => p.name === plugin.name)?.version, pkg: pkg.version };
}

export function bump(current, how) {
    if (/^\d+\.\d+\.\d+$/.test(how)) return how;
    const [maj, min, pat] = current.split(".").map(Number);
    if (how === "major") return `${maj + 1}.0.0`;
    if (how === "minor") return `${maj}.${min + 1}.0`;
    if (how === "patch") return `${maj}.${min}.${pat + 1}`;
    return die(`expected patch, minor, major or X.Y.Z, got ${JSON.stringify(how)}`);
}

/** Move "## [Unreleased]" content under "## [version] - date"; returns { text, notes }. */
export function cutChangelog(text, version, date) {
    const m = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(text);
    if (!m) die("CHANGELOG.md has no \"## [Unreleased]\" section");
    const notes = m[1].trim();
    if (!notes) die("the Unreleased section of CHANGELOG.md is empty; describe what changed first");
    const cut = text.replace(m[0], `## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n\n`);
    return { text: cut, notes };
}


/** The CHANGELOG section for one version (used for the GitHub release notes). */
export function notesFor(text, version) {
    const esc = version.replace(/\./g, "\\.");
    const m = new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m").exec(text);
    return m ? m[1].trim() : "";
}