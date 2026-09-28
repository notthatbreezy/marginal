// Settings: keyboard shortcuts (each can be turned off) and, in browser windows, the theme. Shared by every panel
// and window through the extension (see lib/settings.mjs); a change in one applies everywhere at once.
import { $, h, put, api, INSTANCE, toast } from "./core.js";

export const STANDALONE = INSTANCE.startsWith("browser-");
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl";

export const settings = { shortcuts: { jump: true, stepKeys: true, tourKey: true, markdown: true, chat: true }, theme: "auto", effects: true, interrupt: { doc: false, command: true }, command: { worktrees: false } };
const listeners = new Set();
export const onSettings = (fn) => (listeners.add(fn), () => listeners.delete(fn));
/** Is this optional shortcut turned on? */
export const shortcut = (name) => settings.shortcuts[name] !== false;

const SHORTCUTS = [
    { key: "chat", keys: [MOD, "I"], label: "Open and close the chat", detail: "The chat with Copilot, on any tab. It reopens where you left it, with the conversation." },
    { key: "jump", keys: [MOD, "J"], label: "Jump to a section", detail: "Opens the jump palette on a doc." },
    { key: "stepKeys", keys: ["↑", "↓", "←", "→"], label: "Arrow keys step", detail: "Move between steps while inspecting a diagram, and between walkthrough stops." },
    { key: "tourKey", keys: ["?"], label: "Command center tour", detail: "Starts the guided tour on the Command tab." },
    { key: "markdown", keys: ["`", "**", "- "], label: "Markdown as you type", detail: "While editing, `code`, **bold**, *italic* and list markers format as you type." },
];
const INTERRUPTS = [
    { key: "command", label: "Command chat interrupts", detail: "Messages to the orchestrator reach it mid-turn: it reads them at its next step and can change course." },
    { key: "doc", label: "Doc chat interrupts", detail: "Questions from a doc reach Copilot mid-turn, even while it works on something else in the main chat." },
];
export const THEMES = [
    { id: "auto", label: "System", note: "Follows your OS light or dark setting" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "win3", label: "Windows 3.0", note: "1990" },
    { id: "win95", label: "Windows 95" },
    { id: "vista", label: "Vista", note: "Aero glass" },
    { id: "future", label: "Retro-future", note: "The HUD the '80s promised" },
    { id: "arcade", label: "16-bit", note: "Genesis-era retrowave" },
];

// Boot screens: shown once per window for each retro theme while effects are on (skipped for reduced motion).
const BOOT = {
    win3: () => [h("div", {}, h("div", { class: "logo" }, h("i"), h("i"), h("i"), h("i")), h("div", { class: "big" }, "Marginal"), h("div", { class: "small" }, "Version 3.0 · Copyright © 1985–1990, Marginal. All rights reserved."))],
    win95: () => [h("div", {}, "Marginal", h("sup", {}, "95")), h("div", { class: "bar" })],
    vista: () => [h("div", {}, h("div", { class: "orb" }), "Starting Marginal")],
    future: () => [h("div", {}, ...["Marginal systems interface // 2019", "Establishing uplink", "Reading doc manifest ........ OK", "Territory map ............... OK", "Interface online"].map((t, k) => h("div", { class: `ln${k === 4 ? " a" : ""}`, style: `animation-delay:${120 + k * 230}ms` }, "> " + t)))],
    arcade: () => [h("div", {}, h("div", { class: "logo" }, "Marginal"), h("div", { class: "start" }, "Press start"), h("div", { class: "tm" }, "© 1992 Marginal · 16-bit"))],
};
function boot(theme) {
    const key = `marginal.boot.${theme}`;
    try {
        if (sessionStorage.getItem(key) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        sessionStorage.setItem(key, "1");
    } catch {}
    document.getElementById("boot")?.remove();
    const el = h("div", { id: "boot", class: `b-${theme}`, "aria-hidden": "true", style: `--boot-ms:${theme === "future" ? 1100 : 900}ms` }, BOOT[theme]());
    const skip = () => el.remove();
    el.addEventListener("pointerdown", skip); // a click or key skips it
    addEventListener("keydown", skip, { once: true });
    document.body.append(el);
    setTimeout(skip, 1600);
}
function apply() {
    const root = document.documentElement;
    // Themes are for browser windows only; inside the Copilot app the app's own theme always wins.
    if (STANDALONE) {
        const prev = root.dataset.theme;
        const set = () => {
            root.dataset.theme = settings.theme;
            // Effects are the theme's wallpapers and extras; reduced motion only stills their animation (themes.css).
            root.toggleAttribute("data-effects", settings.effects);
        };
        const switching = prev !== undefined && (prev !== settings.theme || root.hasAttribute("data-effects") !== settings.effects);
        // Switching: a quick crossfade where the browser can do it cheaply, otherwise instant. Never a boot screen.
        if (switching && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(set);
        else set();
        // The boot screen is for opening a window in a retro theme, not for trying themes on.
        if (prev === undefined && settings.effects && BOOT[settings.theme]) boot(settings.theme);
    }
    for (const fn of listeners) fn(settings);
    render();
}
function adopt(s) {
    if (!s || typeof s !== "object") return;
    Object.assign(settings.shortcuts, s.shortcuts ?? {});
    Object.assign(settings.interrupt, s.interrupt ?? {});
    Object.assign(settings.command, s.command ?? {});
    if (s.theme) settings.theme = s.theme;
    if (typeof s.effects === "boolean") settings.effects = s.effects;
    apply();
}
export async function loadSettings() {
    try {
        adopt(await api("/settings"));
    } catch {
        apply();
    }
}
/** Called with the SSE "settings" event another window caused. */
export const settingsChanged = (s) => adopt(s);
async function change(patch) {
    const before = structuredClone(settings);
    adopt({ ...settings, ...patch, shortcuts: { ...settings.shortcuts, ...(patch.shortcuts ?? {}) }, interrupt: { ...settings.interrupt, ...(patch.interrupt ?? {}) }, command: { ...settings.command, ...(patch.command ?? {}) } });
    try {
        adopt(await api("/settings", { method: "POST", body: patch }));
    } catch (e) {
        adopt(before);
        toast(`Couldn't save settings: ${e.message}`);
    }
}

// ---------------- the panel ----------------
const GEAR = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></svg>';
const btn = h("button", { id: "settings-btn", class: "icon", title: "Settings", "aria-label": "Settings", "aria-haspopup": "dialog", "aria-expanded": "false", html: GEAR });
const body = h("div", { class: "set-body" });
const pop = h("div", { id: "settings", role: "dialog", "aria-label": "Settings", hidden: true }, h("div", { class: "set-head" }, h("span", {}, "Settings"), h("button", { class: "chat-icon set-x", title: "Close (Esc)", "aria-label": "Close settings", onclick: () => close(), html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' })), body);

function toggle(on, label, onchange) {
    return h("button", { class: `set-switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(on), "aria-label": label, onclick: () => onchange(!on) }, h("span", { class: "knob" }));
}
function render() {
    if (pop.hidden) return;
    const themes = STANDALONE
        ? [
              h("div", { class: "set-h" }, "Theme"),
              h(
                  "div",
                  { class: "set-themes", role: "radiogroup", "aria-label": "Theme" },
                  THEMES.map((t) =>
                      h(
                          "button",
                          { class: `set-theme${settings.theme === t.id ? " on" : ""}`, role: "radio", "aria-checked": String(settings.theme === t.id), "data-t": t.id, title: t.note ?? t.label, onclick: () => change({ theme: t.id }) },
                          h("span", { class: `set-swatch sw-${t.id}`, "aria-hidden": "true" }),
                          h("span", { class: "set-tl" }, t.label),
                          t.note ? h("span", { class: "set-tn" }, t.note) : null,
                      ),
                  ),
              ),
              ["win3", "win95", "vista", "future", "arcade"].includes(settings.theme)
                  ? h(
                        "div",
                        { class: "set-row" },
                        h("div", { class: "set-rt" }, h("div", { class: "set-rl" }, "Effects"), h("div", { class: "set-rd" }, "The theme's extras: its desktop, animations, glow and the like.")),
                        toggle(settings.effects, "Effects", (v) => change({ effects: v })),
                    )
                  : null,
          ]
        : [h("div", { class: "set-h" }, "Theme"), h("p", { class: "set-note" }, "Inside the Copilot app, Marginal uses the app's theme. Open it in your browser (the globe in the header) to choose Light, Dark, Windows 3.0, Windows 95, Vista, Retro-future or 16-bit there.")];
    put(body,
        ...themes,
        h("div", { class: "set-h" }, "Keyboard shortcuts"),
        SHORTCUTS.map((s) =>
            h(
                "div",
                { class: "set-row" },
                h("div", { class: "set-rt" }, h("div", { class: "set-rl" }, s.label, h("span", { class: "set-keys" }, s.keys.map((k) => h("kbd", {}, k)))), h("div", { class: "set-rd" }, s.detail)),
                toggle(shortcut(s.key), s.label, (v) => change({ shortcuts: { [s.key]: v } })),
            ),
        ),
        h("p", { class: "set-note" }, "Always on: ", h("kbd", {}, "Shift"), "+", h("kbd", {}, "Enter"), " sends or saves, ", h("kbd", {}, "Esc"), " closes or cancels."),
        h("div", { class: "set-h" }, "When Copilot is busy"),
        INTERRUPTS.map((s) =>
            h(
                "div",
                { class: "set-row" },
                h("div", { class: "set-rt" }, h("div", { class: "set-rl" }, s.label), h("div", { class: "set-rd" }, s.detail)),
                toggle(settings.interrupt[s.key] !== false, s.label, (v) => change({ interrupt: { [s.key]: v } })),
            ),
        ),
        h("p", { class: "set-note" }, "Off, a message waits until Copilot finishes what it's doing, which can be a long time while it waits on helper agents."),
        h("div", { class: "set-h" }, "Command center"),
        h(
            "div",
            { class: "set-row" },
            h("div", { class: "set-rt" }, h("div", { class: "set-rl" }, "Show worktrees"), h("div", { class: "set-rd" }, "List the checkouts being watched under the phases, when there are several (parallel sessions, stacked PRs). They're tracked either way.")),
            toggle(settings.command.worktrees === true, "Show worktrees", (v) => change({ command: { worktrees: v } })),
        ),
    );
}
let returnFocus = null;
function open() {
    returnFocus = document.activeElement;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    render();
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
    pop.querySelector("button.on, .set-switch")?.focus({ preventScroll: true });
}
function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
}
btn.onclick = () => (pop.hidden ? open() : close());
document.addEventListener("pointerdown", (e) => !pop.hidden && !e.target.closest?.("#settings, #settings-btn") && close(), true);
document.addEventListener(
    "keydown",
    (e) => {
        if (e.key === "Escape" && !pop.hidden) {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    },
    true,
);
$("#open-external").before(btn);
document.body.append(pop);
