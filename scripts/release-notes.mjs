// Print the CHANGELOG section for a version: node scripts/release-notes.mjs 0.2.0 > notes.md
import { readFileSync } from "node:fs";
import { notesFor } from "./release-lib.mjs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const notes = notesFor(readFileSync("CHANGELOG.md", "utf8"), version);
if (!notes) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
}
process.stdout.write(`${notes}\n`);