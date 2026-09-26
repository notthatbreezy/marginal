// Command tab: the implementation mission wall. M1: instrument strip + territory map, live from the change log.
import { $, api, bus, h, put } from "../core.js";
import { compilePatterns, patternsTouchDir, phasePatterns, planPatterns } from "../command/patterns.js";
import { changesAt, velocity } from "./derive.js";
import { buildTree } from "./squarify.js";
import { createTreemap } from "./treemap.js";

const cc = {
    host: null,
    docId: null,
    data: null, // { state, prefs, lease, isOwnerHere, seq, repository, target }
    events: [],
    tree: null,
    files: [],
    ui: { root: "", windowKey: "auto" },
    tm: null,
    off: [],
    raf: 0,
    lastRender: 0,
    liveTimer: 0,
};

export function isMounted() {
    return !!cc.host?.isConnected;
}

export async function mountCommand(host, { documentId }) {
    unmountCommand();
    cc.host = host;
    cc.docId = documentId;
    cc.events = [];
    cc.ui = { root: "", windowKey: "auto" };
    host.classList.add("cc-host");
    const root = h("div", { class: "cc" });
    root.append(buildStrip(), buildMap());
    put(host, root);
    cc.off.push(bus.on("command", onEvent));
    cc.liveTimer = setInterval(() => cc.events.length && schedule(), 5000);
    await reloadAll();
}

export function unmountCommand() {
    for (const off of cc.off) off();
    cc.off = [];
    clearInterval(cc.liveTimer);
    cancelAnimationFrame(cc.raf);
    cc.host?.classList.remove("cc-host");
    cc.host = null;
    cc.tm = null;
}

async function reloadAll() {
    const q = `doc=${encodeURIComponent(cc.docId)}`;
    const [data, ev, tree] = await Promise.all([api(`/command/state?${q}`), api(`/command/events?${q}&since=0`), api(`/command/tree?${q}`)]);
    if (!isMounted()) return;
    cc.data = data;
    cc.events = ev.events;
    cc.files = tree.files;
    rebuildTree();
    schedule(true);
}

async function reloadState() {
    cc.data = await api(`/command/state?doc=${encodeURIComponent(cc.docId)}`);
    schedule(true);
}

function onEvent(ev) {
    if (!isMounted() || ev.documentId !== cc.docId) return;
    if (ev.kind === "events") {
        const last = cc.events.at(-1)?.seq ?? 0;
        const fresh = ev.events.filter((e) => e.seq > last);
        if (fresh.length) {
            cc.events.push(...fresh);
            if (fresh.some((e) => !cc.tree?.map.has(e.file))) rebuildTree();
            schedule();
        }
    } else if (ev.kind === "state" || ev.kind === "prefs") reloadState();
    else if (ev.kind === "compacted" || ev.kind === "tree") reloadAll();
}

function rebuildTree() {
    const extra = new Map();
    for (const e of cc.events) if (e.totals.add > 0) extra.set(e.file, e.totals.add);
    cc.tree = buildTree(cc.files, extra);
}

/** Coalesce to ≤ 4 renders per second, one rAF per burst. */
function schedule(now = false) {
    if (cc.raf) return;
    const wait = now ? 0 : Math.max(0, 250 - (performance.now() - cc.lastRender));
    cc.raf = requestAnimationFrame(() =>
        setTimeout(() => {
            cc.raf = 0;
            cc.lastRender = performance.now();
            render();
        }, wait),
    );
}

// ---------- derived view model ----------
function matchers(plan) {
    const all = planPatterns(plan);
    const fp = compilePatterns(all);
    const activePhases = (plan?.phases ?? []).filter((p) => p.state.status === "active");
    const act = compilePatterns(activePhases.flatMap(phasePatterns));
    const perPhase = activePhases.map((p) => [p, compilePatterns(phasePatterns(p))]);
    return {
        footprint: (p) => !!p && fp(p),
        active: (p) => !!p && act(p),
        touchesFootprint: (dir) => patternsTouchDir(all, dir),
        phaseOf: (p) => perPhase.find(([, mt]) => mt(p))?.[0] ?? null,
    };
}

function render() {
    if (!isMounted() || !cc.data) return;
    const st = cc.data.state;
    const now = Date.now();
    renderStrip(st, now);
    renderMapHead(st);
    const empty = cc.host.querySelector(".cc-empty");
    if (!st.plan) {
        if (!empty) cc.host.querySelector(".stage").append(emptyState());
        return;
    }
    empty?.remove();
    const fronts = new Map(st.fronts.map((f) => [f.id, f]));
    cc.tm.render({
        tree: cc.tree,
        root: cc.ui.root,
        repoName: cc.data.repository,
        changes: changesAt(cc.events),
        fronts,
        match: matchers(st.plan),
        pins: new Map(),
        now,
    });
}

function emptyState() {
    const lease = cc.data.lease;
    return h(
        "div",
        { class: "cc-empty" },
        h("div", { class: "cc-empty-t" }, "No implementation plan yet"),
        h("p", {}, "When an orchestrating Copilot session starts on this whiteboard, the plan's territory lights up here as its fronts edit files."),
        h("p", { class: "muted" }, "The orchestrator calls ", h("code", {}, 'command_plan {op:"set"}'), " to begin, then registers each worktree with ", h("code", {}, 'command_front {op:"register"}'), "."),
        lease ? h("p", { class: "muted" }, `Lease: ${lease.sessionId}${lease.live ? "" : " (stale)"}`) : null,
    );
}

// ---------- instrument strip ----------
function buildStrip() {
    return h(
        "section",
        { class: "strip", "aria-label": "Mission instruments" },
        h("span", { class: "lamp", role: "status", hidden: true }),
        h("div", { class: "readout", title: "Lines added + removed per minute" }, h("span", { class: "v num churn" }, "0"), h("span", { class: "u" }, "lines/min churn"), h("span", { class: "net num" })),
        h("span", { class: "sep" }),
        h("div", { class: "readout minor" }, h("span", { class: "v num files" }, "0"), h("span", { class: "u" }, "files/min")),
        h("div", { class: "readout minor" }, h("span", { class: "v num evs" }, "0"), h("span", { class: "u" }, "changes/min")),
        h(
            "label",
            { class: "window", title: "Velocity window. Auto scales with session age." },
            h(
                "select",
                {
                    "aria-label": "Velocity window",
                    onchange: (e) => {
                        cc.ui.windowKey = e.target.value;
                        schedule(true);
                    },
                },
                ["auto", "1m", "5m", "15m", "1h", "all"].map((k) => h("option", { value: k }, k)),
            ),
        ),
        h("span", { class: "strip-grow" }),
    );
}

function renderStrip(st, now) {
    const strip = cc.host.querySelector(".strip");
    const lamp = strip.querySelector(".lamp");
    const ms = st.mission ?? { status: "unknown" };
    const leaseLive = cc.data.lease?.live;
    lamp.hidden = ms.status === "unknown" && !st.plan;
    lamp.className = `lamp ${!leaseLive && st.plan ? "offline" : { working: "working", awaiting_operator: "waiting", complete: "complete" }[ms.status] ?? "idle"}`;
    const sub = ms.status === "awaiting_operator" && ms.prompt ? h("span", { class: "sub", title: ms.prompt }, ms.prompt) : null;
    if (!leaseLive && st.plan) put(lamp, h("span", { class: "dot" }), "Orchestrator offline");
    else if (ms.status === "working") put(lamp, h("span", { class: "pulse" }), "Working", sub);
    else if (ms.status === "awaiting_operator") put(lamp, h("span", { class: "dot" }), "Waiting on you", sub);
    else if (ms.status === "complete") put(lamp, "✓ Complete");
    else put(lamp, h("span", { class: "dot" }), "Idle");
    const v = velocity(cc.events, { at: now, windowKey: cc.ui.windowKey });
    strip.querySelector(".churn").textContent = v.churn;
    const net = strip.querySelector(".net");
    net.textContent = v.net ? `net ${v.net > 0 ? "+" : "−"}${Math.abs(v.net)}` : "";
    net.className = `net num ${v.net > 0 ? "add" : v.net < 0 ? "del" : ""}`;
    strip.querySelector(".files").textContent = v.files;
    strip.querySelector(".evs").textContent = v.events;
    const sel = strip.querySelector(".window select");
    sel.value = cc.ui.windowKey;
    sel.options[0].textContent = cc.ui.windowKey === "auto" ? v.label : `auto · ${v.auto.label}`;
}

// ---------- map ----------
function buildMap() {
    const stage = h("div", { class: "stage" }, h("div", { class: "tm" }));
    const section = h(
        "section",
        { class: "map", "aria-label": "Territory map" },
        h(
            "div",
            { class: "map-head" },
            h("div", { class: "crumbs" }),
            h("div", { class: "legend" }, h("span", {}, h("i", { class: "lg fp" }), "Plan"), h("span", {}, h("i", { class: "lg ph" }), "Active checkpoint")),
            h("div", { class: "grow" }),
        ),
        stage,
    );
    cc.tm = createTreemap(stage.querySelector(".tm"), {
        onZoom: (p) => {
            cc.ui.root = p;
            schedule(true);
        },
    });
    return section;
}

function renderMapHead() {
    const crumbs = cc.host.querySelector(".crumbs");
    const parts = cc.ui.root ? cc.ui.root.split("/") : [];
    const items = [h("button", { class: `path crumb${parts.length ? "" : " here"}`, onclick: () => ((cc.ui.root = ""), schedule(true)) }, `${cc.data.repository ?? "repo"}/`)];
    parts.forEach((p, i) => {
        const path = parts.slice(0, i + 1).join("/");
        items.push(h("button", { class: `path crumb${i === parts.length - 1 ? " here" : ""}`, onclick: () => ((cc.ui.root = path), schedule(true)) }, `${p}/`));
    });
    put(crumbs, items);
}

export function refresh() {
    if (isMounted()) reloadAll();
}
