import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const root = join(copilotHome, "extensions", "whiteboard", "artifacts");

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
