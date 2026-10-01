// A pull request's identity: {host, owner, repo, number}, on github.com or any GitHub Enterprise host.
// Everything (URLs, gh calls, storage keys, dedupe) goes through these, so the host is never lost.
import { createHash } from "node:crypto";

import { InputError } from "../errors.mjs";

const PR_URL = /^https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** https://<host>/<owner>/<repo>/pull/<n>, optionally followed by /files, a query or a fragment. */
export function parsePrUrl(url) {
    const m = PR_URL.exec(String(url ?? "").trim());
    if (!m) throw new InputError("A pull request URL looks like https://github.com/owner/repo/pull/123 (or the same on a GitHub Enterprise host).");
    const host = m[1].toLowerCase();
    const owner = m[2];
    const repo = m[3].replace(/\.git$/i, "");
    const number = Number(m[4]);
    if (!Number.isSafeInteger(number) || number < 1) throw new InputError("The pull request number must be a positive integer.");
    return { host, owner, repo, number, url: prUrl({ host, owner, repo, number }) };
}

export const prUrl = ({ host, owner, repo, number }) => `https://${host}/${owner}/${repo}/pull/${number}`;

/** Case-insensitive canonical key: two URLs for the same PR give the same key. */
export const prKey = ({ host, owner, repo, number }) => `${host}/${owner}/${repo}#${number}`.toLowerCase();

/** A short, stable, file-safe id for a PR on a doc, e.g. "marginal-sandbox-1-3f2a". */
export function prIdFor(pr) {
    const slug = `${pr.repo}-${pr.number}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return `${slug}-${createHash("sha256").update(prKey(pr)).digest("hex").slice(0, 4)}`;
}
