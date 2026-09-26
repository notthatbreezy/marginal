// Release tooling: the version lives in three manifests and must agree; CHANGELOG cutting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const { bump, cutChangelog, notesFor, versions } = await import("../scripts/release-lib.mjs");

test("plugin.json, marketplace.json and package.json carry the same version", () => {
    const v = versions();
    assert.equal(new Set(Object.values(v)).size, 1, JSON.stringify(v));
    assert.match(v.plugin, /^\d+\.\d+\.\d+$/);
});

test("bump", () => {
    assert.equal(bump("0.1.0", "patch"), "0.1.1");
    assert.equal(bump("0.1.3", "minor"), "0.2.0");
    assert.equal(bump("0.9.9", "major"), "1.0.0");
    assert.equal(bump("0.1.0", "2.3.4"), "2.3.4");
    assert.throws(() => bump("0.1.0", "huge"));
});

test("cutChangelog moves Unreleased under the version and keeps an empty Unreleased", () => {
    const src = "# Changelog\n\n## [Unreleased]\n\n### Added\n- a thing\n\n## [0.1.0] - 2026-01-01\n\n- first\n";
    const { text, notes } = cutChangelog(src, "0.2.0", "2026-02-02");
    assert.equal(notes, "### Added\n- a thing");
    assert.match(text, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-02-02\n\n### Added\n- a thing\n\n## \[0\.1\.0\] - 2026-01-01/);
    assert.throws(() => cutChangelog("# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - x\n- y\n", "0.2.0", "d"), /empty/);
    assert.throws(() => cutChangelog("# Changelog\n", "0.2.0", "d"), /no "## \[Unreleased\]"/);
});
test("notesFor extracts one version's section", () => {
    const src = "# C\n\n## [Unreleased]\n\n## [0.2.0] - d\n\n### Added\n- x\n\n## [0.1.0] - d\n\n- y\n";
    assert.equal(notesFor(src, "0.2.0"), "### Added\n- x");
    assert.equal(notesFor(src, "0.1.0"), "- y");
    assert.equal(notesFor(src, "0.3.0"), "");
});