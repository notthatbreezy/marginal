import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Data lives beside the extension (<extension>/artifacts, git-ignored) wherever it is installed;
// WHITEBOARD_DATA_DIR overrides it (tests and the dev server point it at a temp directory).
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.WHITEBOARD_DATA_DIR || join(extensionDir, "artifacts");

export const paths = {
    root,
    whiteboards: join(root, "whiteboards"),
    repositories: join(root, "repositories.json"),
};

mkdirSync(paths.whiteboards, { recursive: true });

export function atomicWriteJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, file);
}
