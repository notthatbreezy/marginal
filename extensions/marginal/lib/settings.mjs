// Reader settings shared by every Marginal panel and browser window: keyboard shortcuts and the browser theme.
// Kept in <data>/settings.json (the panel's origin changes on every reload, so browser storage wouldn't last).
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson, paths } from "./paths.mjs";

export const THEMES = ["auto", "light", "dark", "win3", "win95", "vista", "future", "arcade"];
export const SHORTCUTS = ["jump", "stepKeys", "tourKey", "markdown"];
export const DEFAULTS = Object.freeze({ shortcuts: Object.freeze(Object.fromEntries(SHORTCUTS.map((k) => [k, true]))), theme: "auto", effects: true });

/** Anything unknown or malformed falls back to the default, field by field. */
export function parseSettings(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const sc = s.shortcuts && typeof s.shortcuts === "object" ? s.shortcuts : {};
    return {
        shortcuts: Object.fromEntries(SHORTCUTS.map((k) => [k, typeof sc[k] === "boolean" ? sc[k] : true])),
        theme: THEMES.includes(s.theme) ? s.theme : "auto",
        effects: typeof s.effects === "boolean" ? s.effects : true,
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
    const next = parseSettings({ ...cur, ...p, shortcuts: { ...cur.shortcuts, ...(p.shortcuts && typeof p.shortcuts === "object" ? p.shortcuts : {}) } });
    atomicWriteJson(paths.settings, next);
    return next;
}
