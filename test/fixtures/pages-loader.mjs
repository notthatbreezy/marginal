import { fileURLToPath } from "node:url";

const facade = new URL("./pages-sdk.mjs", import.meta.url).href;
const root = new URL("../../extensions/marginal/", import.meta.url);
const observed = new Map([
    ["lib/prs/index.mjs", ["createPrService"]],
    ["lib/prs/watcher.mjs", ["createWatcher"]],
    ["lib/server.mjs", ["startServer"]],
    ["lib/command/index.mjs", ["attachMission"]],
    ["lib/command/poller.mjs", ["stopAll", "stopPolling"]],
    ["lib/command/owner.mjs", ["stopHeartbeat"]],
    ["lib/command/state.mjs", ["unwatchCommand"]],
    ["lib/command/snapshot.mjs", ["dropRefs"]],
    ["lib/store.mjs", []],
].map(([path, names]) => [new URL(path, root).href, names]));

export async function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") return { url: facade, shortCircuit: true };
    return next(specifier, context);
}

export async function load(url, context, next) {
    const result = await next(url, context);
    if (!observed.has(url)) return result;
    let source = String(result.source);
    const wrappers = [];
    for (const name of observed.get(url)) {
        const declaration = new RegExp(`export (async )?function ${name}\\(`);
        if (!declaration.test(source)) throw new Error(`Missing transparent observation edge ${fileURLToPath(url)}:${name}`);
        source = source.replace(declaration, (_, async = "") => `${async}function __pages_${name}(`);
        wrappers.push(`export function ${name}(...args) {
            __pages.observed(${JSON.stringify(name)}, args);
            return __pages.captured(${JSON.stringify(name)}, __pages_${name}(...__pages.options(${JSON.stringify(name)}, args)));
        }`);
    }
    // Rewrite declarations in their one original module, never import a second state-module URL.
    return { ...result, source: `import * as __pages from ${JSON.stringify(facade)};\n${source}\n${wrappers.join("\n")}\n__pages.loaded(import.meta.url);` };
}
