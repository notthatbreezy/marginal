// Build-time helper: scope the Command mockup stylesheet under `.cc` so it can't leak into the whiteboard.
// Usage: node tools/scope-css.mjs <in.css>  → prints scoped CSS
import { readFileSync } from "node:fs";

const css = readFileSync(process.argv[2], "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const scopeSel = (sel) =>
    sel
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s === ".cc" || s.startsWith(".cc ") || s.startsWith(".cc.") || s.startsWith(".cc:") ? s : `.cc ${s}`))
        .join(",\n");

function scope(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const open = text.indexOf("{", i);
        if (open < 0) break;
        const head = text.slice(i, open).trim();
        let depth = 1;
        let j = open + 1;
        while (j < text.length && depth) {
            if (text[j] === "{") depth++;
            else if (text[j] === "}") depth--;
            j++;
        }
        const body = text.slice(open + 1, j - 1);
        if (head.startsWith("@keyframes")) out += `${head} {${body}}\n`;
        else if (head.startsWith("@media")) out += `${head} {\n${scope(body)}}\n`;
        else out += `${scopeSel(head)} {${body.trim() ? `\n    ${body.trim().replace(/;\s*/g, ";\n    ").replace(/\n    $/, "")}\n` : ""}}\n`;
        i = j;
    }
    return out;
}
process.stdout.write(scope(css));
