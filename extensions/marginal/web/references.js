// Pure source scanner shared by catalog search and the browser renderer/editor.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const readable = (text) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);

/** The supported fence starts at column zero of the current Markdown container. */
export function fenceOpening(line) {
    const match = /^(`{3,})[ \t]*([\w+-]*)/.exec(line);
    return match ? { length: match[1].length, language: match[2] } : null;
}

export function isFenceClose(line, length) {
    const match = /^(`{3,})[ \t]*$/.exec(line);
    return !!match && match[1].length >= length;
}

function stripQuotePrefix(line, limit = Infinity) {
    let depth = 0;
    while (depth < limit && line.startsWith(">")) {
        line = line.replace(/^>\s?/, "");
        depth++;
    }
    return { line, depth };
}

export const isMarkdownTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
export const isMarkdownTableStart = (line, next = "") => isMarkdownTableRow(line) && /^\s*\|?\s*:?-{2,}/.test(next);
export const isMarkdownBlockStart = (line) => isMarkdownTableRow(line) || /^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|(-{3,}|\*{3,})\s*$)/.test(line);

/** Bound literal matching by the consumer's actual containers. */
function inlineLimits(source, container) {
    if (container === "inline") return [{ start: 0, end: source.length, group: 0, kind: "paragraph" }];
    let offset = 0, group = 0;
    /** @type {{kind: "block" | "paragraph" | "list" | "table-header" | "table", depth: number}} */
    let previous = { kind: "block", depth: -1 };
    const rawLines = source.split("\n");
    const lines = rawLines.map((raw, index) => {
        const { line, depth } = stripQuotePrefix(raw.replace(/\r$/, ""));
        /** @type {typeof previous.kind | "list-continuation"} */
        let kind;
        if (container === "plain") kind = fenceOpening(line) ? "block" : "paragraph";
        else if (!line.trim()) kind = "block";
        else if ((index === 0 && container === "list") || /^\s*([-*+]|\d+[.)])\s+/.test(line)) kind = "list";
        else if (previous.kind === "list" && previous.depth === depth && /^\s{2,}/.test(line)) kind = "list-continuation";
        else if (previous.kind === "table-header" && previous.depth === depth) kind = "table";
        else if (isMarkdownTableRow(line)) {
            const next = stripQuotePrefix((rawLines[index + 1] ?? "").replace(/\r$/, ""));
            kind = previous.kind === "table" && previous.depth === depth ? "table"
                : next.depth === depth && isMarkdownTableStart(line, next.line) ? "table-header" : "paragraph";
        }
        else kind = isMarkdownBlockStart(line) ? "block" : "paragraph";
        const continued = container === "plain" ? kind === "paragraph" && previous.kind === "paragraph"
            : previous.depth === depth && (kind === "list-continuation" || kind === "paragraph" && previous.kind === "paragraph" && !isMarkdownBlockStart(line));
        if (!continued) group++;
        const result = { start: offset, end: offset + raw.length, group, kind };
        offset += raw.length + 1;
        previous = { kind: kind === "list-continuation" ? "list" : kind, depth };
        return result;
    });
    for (let i = lines.length - 2; i >= 0; i--) if (lines[i].group === lines[i + 1].group) lines[i].end = lines[i + 1].end;
    return lines;
}

function tagEnd(source, start) {
    let quote = null;
    for (let i = start; i < source.length; i++) {
        const c = source[i];
        if (quote) {
            if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") return i + 1;
    }
    return source.length;
}

function sessionLabel(source) {
    const opening = /^<copilot-ref(?=\s)/.exec(source);
    if (!opening) return null;
    const attributes = new Map();
    let rest = source.slice(opening[0].length);
    while (!/^\s*\/>$/.test(rest)) {
        const match = /^\s+([a-z][a-z-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(rest);
        if (!match || !["kind", "target-id", "label"].includes(match[1]) || attributes.has(match[1])) return null;
        attributes.set(match[1], match[3]);
        rest = rest.slice(match[0].length);
    }
    if (attributes.size !== 3 || attributes.get("kind") !== "session") return null;
    if (!readable(attributes.get("target-id")).trim()) return null;
    const label = readable(attributes.get("label"));
    return label.trim() ? label : null;
}

/**
 * @typedef {{type: "text", text: string}
 *   | {type: "literal", kind: "inline", ticks: number, text: string}
 *   | {type: "literal", kind: "fence", text: string}
 *   | {type: "session", label: string, source: string}} ReferenceContent
 * @typedef {ReferenceContent & {start: number, end: number}} ReferenceSegment
 * @typedef {"markdown" | "list" | "inline" | "plain"} ReferenceContainer
 */

/** @param {ReferenceContainer} container
 * @param {string | null} literalBarrier A private frame marker absent from the authored source.
 * @returns {ReferenceSegment[]} Source positions are UTF-16 offsets; no target is resolved or separately exposed.
 */
export function scanReferences(source, container = "markdown", literalBarrier = null) {
    const segments = [];
    let limits, currentLine = 0;
    let nextBarrier = literalBarrier === null ? -1 : source.indexOf(literalBarrier);
    let textStart = 0;
    let i = 0;
    const push = (part, end) => {
        if (i > textStart) segments.push({ type: "text", text: source.slice(textStart, i), start: textStart, end: i });
        if (part.type === "session") segments.push({ ...part, source: source.slice(i, end), start: i, end });
        else segments.push({ ...part, text: source.slice(i, end), start: i, end });
        i = textStart = end;
    };
    while (i < source.length) {
        if (container !== "inline" && (i === 0 || source[i - 1] === "\n")) {
            const lineEnd = source.indexOf("\n", i);
            const context = stripQuotePrefix(source.slice(i, lineEnd < 0 ? source.length : lineEnd).replace(/\r$/, ""));
            const opening = fenceOpening(context.line);
            if (opening) {
                let end = lineEnd < 0 ? source.length : lineEnd + 1;
                while (end < source.length) {
                    const next = source.indexOf("\n", end);
                    const content = stripQuotePrefix(source.slice(end, next < 0 ? source.length : next).replace(/\r$/, ""), context.depth);
                    // Recursive core blockquotes end when a required quote prefix disappears.
                    if (content.depth < context.depth) break;
                    end = next < 0 ? source.length : next + 1;
                    if (isFenceClose(content.line, opening.length)) break;
                }
                push({ type: "literal", kind: "fence" }, end);
                continue;
            }
        }
        if (source[i] === "`") {
            const run = /^`+/.exec(source.slice(i))[0];
            limits ??= inlineLimits(source, container);
            while (currentLine + 1 < limits.length && limits[currentLine + 1].start <= i) currentLine++;
            let limit = limits[currentLine].end;
            if (limits[currentLine].kind === "table-header" || limits[currentLine].kind === "table") {
                const pipe = source.slice(i + run.length, limit).indexOf("|");
                if (pipe >= 0) limit = i + run.length + pipe;
            }
            if (literalBarrier !== null) {
                while (nextBarrier >= 0 && nextBarrier < i + run.length) nextBarrier = source.indexOf(literalBarrier, nextBarrier + literalBarrier.length);
                if (nextBarrier >= 0) limit = Math.min(limit, nextBarrier);
            }
            let end = i + run.length;
            let closed = false;
            while (end < limit) {
                if (source[end] !== "`") {
                    end++;
                    continue;
                }
                const closing = /^`+/.exec(source.slice(end))[0];
                end += closing.length;
                if (closing.length === run.length) {
                    push({ type: "literal", kind: "inline", ticks: run.length }, end);
                    closed = true;
                    break;
                }
            }
            if (closed) continue;
            i += run.length;
            continue;
        }
        if (source.startsWith("<copilot-ref", i)) {
            let end = tagEnd(source, i);
            const raw = source.slice(i, end);
            const label = sessionLabel(raw);
            if (label !== null) {
                push({ type: "session", label }, end);
                continue;
            }
            // A malformed/non-self-closing reference owns its nested source, too.
            if (!/\/>$/.test(raw)) {
                const closing = /<\/copilot-ref\s*>/g;
                closing.lastIndex = end;
                const match = closing.exec(source);
                end = match ? match.index + match[0].length : source.length;
            }
            i = end;
            continue;
        }
        i++;
    }
    if (textStart < source.length) segments.push({ type: "text", text: source.slice(textStart), start: textStart, end: source.length });
    return segments;
}

/** Protect accepted atoms before block/cell parsing; lineAt maps framed boundaries to physical source lines. */
export function frameReferences(source, preserveInlineSource = false) {
    let marker = "\u0003";
    while (source.includes(marker)) marker += "\u0003";
    /** @type {Extract<ReferenceContent, {type: "session"}>[]} */
    const atoms = [];
    const lineStarts = [0];
    let physicalLine = 0;
    const text = scanReferences(source).map((part) => {
        if (part.type === "session") {
            physicalLine += part.source.split("\n").length - 1;
            return `${marker}${atoms.push({ type: "session", label: part.label, source: part.source }) - 1}${marker}`;
        }
        const raw = preserveInlineSource && part.type === "literal" && part.kind === "inline" ? part.text : part.text.replace(/\r\n/g, "\n");
        for (const c of raw) if (c === "\n") lineStarts.push(++physicalLine);
        return raw;
    }).join("");
    lineStarts.push(physicalLine + 1);
    const pattern = new RegExp(`${marker}(\\d+)${marker}`, "g");
    return {
        lines: text.split("\n"),
        restore: (text) => text.replace(pattern, (token, i) => atoms[Number(i)]?.source ?? token),
        /** @returns {ReferenceContent[]} Keep admitted atoms and the whole inline unit's lexical context.
         */
        inlineParts(text) {
            /** @type {ReferenceContent[]} */
            const parts = [];
            for (const { start: _start, end: _end, ...part } of scanReferences(text, "inline", marker)) {
                if (part.type !== "text") {
                    parts.push(part);
                    continue;
                }
                let start = 0;
                for (const match of part.text.matchAll(pattern)) {
                    if (match.index > start) parts.push({ type: "text", text: part.text.slice(start, match.index) });
                    const atom = atoms[Number(match[1])];
                    if (!atom) throw new Error("Unknown reference frame token");
                    parts.push(atom);
                    start = match.index + match[0].length;
                }
                if (start < part.text.length) parts.push({ type: "text", text: part.text.slice(start) });
            }
            return parts;
        },
        lineAt: (line) => lineStarts[line],
    };
}

/** Keep authored code/source intact, replacing only recognized prose references with safe labels. */
/** @param {ReferenceContainer} container */
export function referenceText(source, container = "markdown") {
    return scanReferences(source, container).map((part) => part.type === "session" ? part.label : part.text).join("");
}
