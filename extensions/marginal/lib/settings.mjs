// Reader settings shared by every Marginal panel and browser window: keyboard shortcuts, the browser theme, and
// whether chat messages interrupt a busy Copilot (delivered mid-turn) or wait for its current work to finish.
// Kept in <data>/settings.json (the panel's origin changes on every reload, so browser storage wouldn't last).
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson, paths } from "./paths.mjs";

export const THEMES = ["auto", "light", "dark", "win3", "win95", "vista", "future", "arcade"];
export const SHORTCUTS = ["jump", "stepKeys", "tourKey", "markdown"];
export const INTERRUPT = { doc: false, command: true }; // the orchestrator is often mid-turn for a long time
export const DEFAULTS = Object.freeze({ shortcuts: Object.freeze(Object.fromEntries(SHORTCUTS.map((k) => [k, true]))), theme: "auto", effects: true, interrupt: Object.freeze({ ...INTERRUPT }) });

/** Anything unknown or malformed falls back to the default, field by field. */
export function parseSettings(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const sc = s.shortcuts && typeof s.shortcuts === "object" ? s.shortcuts : {};
    const it = s.interrupt && typeof s.interrupt === "object" ? s.interrupt : {};
    return {
        shortcuts: Object.fromEntries(SHORTCUTS.map((k) => [k, typeof sc[k] === "boolean" ? sc[k] : true])),
        theme: THEMES.includes(s.theme) ? s.theme : "auto",
        effects: typeof s.effects === "boolean" ? s.effects : true,
        interrupt: Object.fromEntries(Object.entries(INTERRUPT).map(([k, d]) => [k, typeof it[k] === "boolean" ? it[k] : d])),
    };
}
export function readSettings() {
    try {
        return existsSync(paths.settings) ? parseSettings(JSON.parse(readFileSync(paths.settings, "utf8"))) : parseSettings({});
    } catch {
        return parseSettings({});
    }
}
/** Merge a partial change (e.g. {shortcuts: {jump: false}}) and save. */
export function writeSettings(patch) {
    const cur = readSettings();
    const p = patch && typeof patch === "object" ? patch : {};
    const part = (k) => ({ ...cur[k], ...(p[k] && typeof p[k] === "object" ? p[k] : {}) });
    const next = parseSettings({ ...cur, ...p, shortcuts: part("shortcuts"), interrupt: part("interrupt") });
    atomicWriteJson(paths.settings, next);
    return next;
}
