import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Data lives outside the install directory so plugin updates (which replace that directory) never touch it:
// <COPILOT_HOME or ~/.copilot>/marginal. MARGINAL_DATA_DIR overrides it (tests and the dev server use a temp dir).
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const root = process.env.MARGINAL_DATA_DIR || join(copilotHome, "marginal");

export const paths = {
    root,
    docs: join(root, "docs"),
    repositories: join(root, "repositories.json"),
};

const isEmptyDir = (d) => !existsSync(d) || !readdirSync(d).length;

// One-time move from earlier layouts: data kept beside the extension (<extension>/artifacts, or <repo>/artifacts
// when the repo root was the extension), and artifacts/whiteboards → artifacts/docs.
if (!process.env.MARGINAL_DATA_DIR && isEmptyDir(root)) {
    const old = [join(extensionDir, "artifacts"), join(extensionDir, "..", "..", "artifacts")].find((d) => existsSync(d) && !isEmptyDir(d));
    if (old) {
        mkdirSync(dirname(root), { recursive: true });
        if (existsSync(root)) rmdirSync(root);
        try {
            renameSync(old, root);
        } catch {
            cpSync(old, root, { recursive: true }); // different volume
            rmSync(old, { recursive: true, force: true });
        }
    }
}
const legacyDocs = join(root, "whiteboards");
if (existsSync(legacyDocs) && isEmptyDir(paths.docs)) {
    if (existsSync(paths.docs)) rmdirSync(paths.docs);
    renameSync(legacyDocs, paths.docs);
}
mkdirSync(paths.docs, { recursive: true });

export function atomicWriteJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, file);
}