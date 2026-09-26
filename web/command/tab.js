// Command tab: the implementation mission wall.
// M1 instrument strip + territory map; M2 fronts rail, checkpoint timeline + scrub replay, off-plan filter,
// views & follow, auto-root, fisheye pins, monitors dock, hunk rows. Everything renders "as of" a time: live = now.
import { api, bus, h, put, svc } from "../core.js";
import { compilePatterns, parseLayout, patternsTouchDir, phasePatterns, planPatterns } from "../command/patterns.js";
import { buckets, changesAt, velocity } from "./derive.js";
import { renderFronts, renderTimeline } from "./fronts.js";
import { renderMonitors } from "./monitors.js";
import { buildTree, findNode } from "./squarify.js";
import { createTreemap } from "./treemap.js";
import { PIN_WEIGHT, autoRoot, emptyLayout, followDecision, hunkList, hunkRows, layoutFromView, quietSinceZoom, sameLayout, viewChoices } from "./views.js";

const STALE_MS = 30_000; // lease liveness, aged locally between heartbeats (owner.mjs STALE_MS)
const MAX_MONITORS = 3;
const FOLLOW_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const cc = {
    host: null,
    docId: null,
    data: null, // { state, prefs, lease, isOwnerHere, seq, repository, target }
    events: [],
    tree: null,
    files: [],
    ui: null,
    tm: null,
    off: [],
    raf: 0,
    lastRender: 0,
    liveTimer: 0,
    loading: null, // SSE events that arrive while a full reload is in flight
    announced: { phases: "", offPlan: 0 },
};

const freshUi = () => ({
    windowKey: "auto",
    at: null, // replay position (ms); null = live
    focusFront: null,
    hoverFront: null,
    offOnly: false,
    layout: emptyLayout(), // root null = auto
    viewId: null, // the view the current layout came from (null = auto / custom)
    userZoomAt: 0,
    hover: null,
    menu: null,
});

export function isMounted() {
    return !!cc.host?.isConnected;
}

export async function mountCommand(host, { documentId }) {
    unmountCommand();
    cc.host = host;
    cc.docId = documentId;
    cc.events = [];
    cc.ui = freshUi();
    cc.announced = { phases: "", offPlan: 0 };
    host.classList.add("cc-host");
    const root = h("div", { class: "cc" });
    root.append(buildStrip(), buildMap(), h("aside", { class: "rail-fronts", "aria-label": "Fronts" }), h("section", { class: "timeline", "aria-label": "Checkpoints" }), h("div", { class: "sr-only", "aria-live": "polite", role: "status" }));
    put(host, root);
    cc.off.push(bus.on("command", onEvent));
    const onKey = (e) => keydown(e);
    const onDown = (e) => cc.ui.menu && !e.target.closest(".cc-menu") && closeMenu();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    cc.off.push(() => document.removeEventListener("keydown", onKey), () => document.removeEventListener("pointerdown", onDown, true));
    cc.liveTimer = setInterval(() => cc.data && schedule(), 5000); // ages "live" rings, lease liveness and relative times
    await reloadAll();
}

export function unmountCommand() {
    flushPrefs();
    for (const off of cc.off) off();
    cc.off = [];
    clearInterval(cc.liveTimer);
    cancelAnimationFrame(cc.raf);
    cc.raf = 0;
    cc.host?.classList.remove("cc-host");
    cc.host = null;
    cc.tm = null;
}

// ---------- data ----------
const q = () => `doc=${encodeURIComponent(cc.docId)}`;

/** Merge events by seq (idempotent, ordered). */
function mergeEvents(base, more) {
    if (!more.length) return base;
    const last = base.at(-1)?.seq ?? 0;
    if (more.every((e) => e.seq > last)) return [...base, ...more.filter((e, i, a) => i === 0 || e.seq > a[i - 1].seq)];
    const m = new Map(base.map((e) => [e.seq, e]));
    for (const e of more) m.set(e.seq, e);
    return [...m.values()].sort((a, b) => a.seq - b.seq);
}

async function reloadAll() {
    cc.loading = [];
    try {
        const [data, ev, tree] = await Promise.all([api(`/command/state?${q()}`), api(`/command/events?${q()}&since=0`), api(`/command/tree?${q()}`)]);
        if (!isMounted()) return;
        cc.data = data;
        cc.events = mergeEvents(ev.events, cc.loading); // keep SSE deltas that raced the snapshot
        cc.files = tree.files;
        restoreLayout();
        rebuildTree();
    } finally {
        cc.loading = null;
    }
    schedule(true);
}

async function reloadState() {
    const data = await api(`/command/state?${q()}`);
    if (!isMounted()) return;
    data.prefs = { ...data.prefs, ...prefsPatch }; // don't flap back while our own write is still debounced
    cc.data = data;
    schedule(true);
}

async function recoverGap() {
    const since = cc.events.at(-1)?.seq ?? 0;
    const ev = await api(`/command/events?${q()}&since=${since}`);
    if (!isMounted()) return;
    cc.events = mergeEvents(cc.events, ev.events);
    rebuildTree();
    schedule();
}

function onEvent(ev) {
    if (!isMounted() || ev.documentId !== cc.docId) return;
    if (ev.kind === "events") {
        if (cc.loading) return void cc.loading.push(...ev.events);
        const last = cc.events.at(-1)?.seq ?? 0;
        const fresh = ev.events.filter((e) => e.seq > last);
        if (!fresh.length) return;
        if (fresh[0].seq !== last + 1) return void recoverGap(); // missed some: fetch the gap instead of skipping it
        cc.events.push(...fresh);
        if (fresh.some((e) => !cc.tree?.map.has(e.file))) rebuildTree();
        schedule();
    } else if (ev.kind === "lease") {
        if (!cc.data) return;
        const was = cc.data.lease?.sessionId;
        cc.data.lease = ev.lease;
        if (ev.lease?.sessionId !== was) reloadState(); // ownership moved: server recomputes isOwnerHere
        else schedule();
    } else if (ev.kind === "state" || ev.kind === "prefs") reloadState();
    else if (ev.kind === "compacted" || ev.kind === "tree") reloadAll();
}

function rebuildTree() {
    const extra = new Map();
    for (const e of cc.events) if (e.totals.add > 0) extra.set(e.file, e.totals.add);
    cc.tree = buildTree(cc.files, extra);
}

const leaseLive = () => {
    const l = cc.data?.lease;
    return !!l?.heartbeatAt && Date.now() - Date.parse(l.heartbeatAt) < STALE_MS;
};

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

// ---------- layout (views, follow, pins, monitors) ----------
const prefs = () => cc.data?.prefs ?? {};
let prefsTimer = 0;
let prefsPatch = {};
let prefsDoc = null; // the document the pending patch belongs to (captured, never re-read from cc at flush time)
function flushPrefs() {
    clearTimeout(prefsTimer);
    prefsTimer = 0;
    if (!prefsDoc || !Object.keys(prefsPatch).length) return;
    const body = prefsPatch;
    const doc = prefsDoc;
    prefsPatch = {};
    prefsDoc = null;
    api(`/command/prefs?doc=${encodeURIComponent(doc)}`, { method: "POST", body }).catch(() => {});
}
function savePrefs(patch) {
    if (prefsDoc && prefsDoc !== cc.docId) flushPrefs();
    prefsDoc = cc.docId;
    Object.assign(cc.data.prefs, patch);
    Object.assign(prefsPatch, patch);
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(flushPrefs, 300);
}

function restoreLayout() {
    const p = prefs();
    cc.ui.layout = p.layout ? parseLayout(p.layout) : emptyLayout(); // prefs.json is shared: never trust its shape
    cc.ui.viewId = p.viewId ?? null;
}

/** A user-initiated layout change: persists and pauses follow for this phase (until "Return to suggested"). */
function userLayout(mut) {
    const before = JSON.stringify(cc.ui.layout);
    mut(cc.ui.layout);
    if (JSON.stringify(cc.ui.layout) === before) return;
    cc.ui.viewId = null;
    savePrefs({ layout: cc.ui.layout, viewId: null, adjustedSince: new Date().toISOString(), adjustedPhase: prefs().appliedPhase ?? null });
    schedule(true);
}

function applyView(v, { phaseId } = {}) {
    cc.ui.layout = layoutFromView(v);
    cc.ui.viewId = v.id;
    const patch = { layout: cc.ui.layout, viewId: v.id, adjustedSince: null };
    if (phaseId) patch.appliedPhase = phaseId;
    savePrefs(patch);
    announce(`View: ${v.title ?? v.id}`);
    schedule(true);
}

function resetAuto() {
    cc.ui.layout = emptyLayout();
    cc.ui.viewId = null;
    savePrefs({ layout: cc.ui.layout, viewId: null, adjustedSince: new Date().toISOString(), adjustedPhase: prefs().appliedPhase ?? null });
    schedule(true);
}

function activeSuggestion(st) {
    return (st.plan?.phases ?? []).filter((p) => p.state.status === "active" && p.suggestedView).at(-1) ?? null;
}

/** Follow + explicit apply requests, evaluated each render (cheap). */
function maybeFollow(st) {
    const req = st.applyRequest;
    if (req && req.seq > (prefs().appliedApplySeq ?? 0)) {
        const v = viewChoices(st, prefs()).find((x) => x.id === req.id);
        savePrefs({ appliedApplySeq: req.seq });
        if (v) return applyView(v);
    }
    const target = followDecision({ state: st, prefs: prefs() });
    if (target && quietSinceZoom(cc.ui.userZoomAt) && cc.ui.at === null) applyView(target.suggestedView, { phaseId: target.id });
}

function togglePin(path) {
    userLayout((l) => {
        l.pins = l.pins.includes(path) ? l.pins.filter((p) => p !== path) : [...l.pins, path];
    });
    announce(cc.ui.layout.pins.includes(path) ? `Pinned ${path}` : `Unpinned ${path}`);
}

function toggleMonitor(path) {
    userLayout((l) => {
        if (l.monitors.some((m) => m.path === path)) l.monitors = l.monitors.filter((m) => m.path !== path);
        else l.monitors = [...l.monitors, { path, mode: "diff-feed" }].slice(-MAX_MONITORS);
    });
}

function zoomTo(path) {
    cc.ui.userZoomAt = Date.now();
    userLayout((l) => {
        l.root = path || "";
    });
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

const isOff = (c) => !!c && [...c.fronts.values()].some((v) => v.offPlan);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i;

function frontRows(st, changes) {
    const rows = st.fronts.map((front) => ({ front, add: 0, del: 0, files: 0, offPlan: 0, where: whereOf(st.plan, front.id) }));
    const by = new Map(rows.map((r) => [r.front.id, r]));
    for (const c of changes.values())
        for (const [id, v] of c.fronts) {
            const r = by.get(id);
            if (!r) continue;
            r.add += v.add;
            r.del += v.del;
            r.files++;
            if (v.offPlan) r.offPlan++;
        }
    return rows;
}

function whereOf(plan, frontId) {
    for (const ph of plan?.phases ?? []) {
        if (ph.state.status !== "active") continue;
        const step = ph.steps.find((s) => s.state.status === "active" && s.state.frontId === frontId);
        if (step || ph.state.frontIds?.includes(frontId)) return { phase: `${ph.id.toUpperCase()} · ${ph.title}`, step: step?.title ?? null };
    }
    return { phase: null, step: null };
}

function timeRange(st, now) {
    const first = cc.events.find((e) => !e.baseline)?.at ?? cc.events[0]?.at;
    const since = (st.plan?.phases ?? []).map((p) => (p.state.since ? Date.parse(p.state.since) : Infinity));
    const from = Math.min(first ? Date.parse(first) : now, ...since, now - 60_000);
    return { from, to: now };
}

// ---------- render ----------
function render() {
    if (!isMounted() || !cc.data) return;
    const st = cc.data.state;
    const now = Date.now();
    const at = cc.ui.at ?? now;
    const replay = cc.ui.at !== null;
    if (st.plan) maybeFollow(st);
    const changes = changesAt(cc.events, replay ? at : Infinity);
    const offCount = [...changes.values()].filter(isOff).length;
    renderStrip(st, at, offCount);
    const main = cc.host.querySelector(".cc");
    main.classList.toggle("replaying", replay);
    const empty = cc.host.querySelector(".cc-empty");
    if (!st.plan) {
        renderMapHead(st, "");
        if (!empty) cc.host.querySelector(".stage").append(emptyState());
        cc.host.querySelector(".rail-fronts").hidden = true;
        cc.host.querySelector(".timeline").hidden = true;
        cc.host.querySelector(".dock").hidden = true;
        return;
    }
    empty?.remove();
    cc.host.querySelector(".rail-fronts").hidden = false;
    cc.host.querySelector(".timeline").hidden = false;
    const L = cc.ui.layout;
    const auto = L.root === null;
    let root = auto ? autoRoot(st.plan, [...changes.keys()]) : L.root;
    if (root && !findNode(cc.tree, root)) root = "";
    renderMapHead(st, root, auto);
    const fronts = new Map(st.fronts.map((f) => [f.id, f]));
    const pins = new Map(L.pins.map((p) => [p, PIN_WEIGHT]));
    const onlyFront = cc.ui.hoverFront ?? cc.ui.focusFront;
    const vf = L.filters ?? {};
    const offOnly = cc.ui.offOnly || !!vf.offPlanOnly;
    const viewFronts = vf.frontIds?.length ? new Set(vf.frontIds) : null;
    const filter =
        onlyFront || offOnly || viewFronts || vf.hideTests || vf.minChurn
            ? (path, c) => {
                  if (vf.hideTests && TEST_PATH.test(path)) return false;
                  if (!c) return !(onlyFront || offOnly || viewFronts || vf.minChurn);
                  if (onlyFront && !c.fronts.has(onlyFront)) return false;
                  if (viewFronts && ![...c.fronts.keys()].some((id) => viewFronts.has(id))) return false;
                  if (offOnly && !isOff(c)) return false;
                  if (vf.minChurn && c.add + c.del < vf.minChurn) return false;
                  return true;
              }
            : null;
    cc.tm.render({
        tree: cc.tree,
        root,
        repoName: cc.data.repository,
        changes,
        fronts,
        match: matchers(st.plan),
        pins,
        now: at,
        filter,
        offPlan: (path, c) => isOff(c),
        decorateFile: replay ? null : decorateHunks,
        tipExtra: (node, c) => (isOff(c) ? h("div", { class: "warn" }, "Off-plan: outside every active checkpoint this front is working on.") : null),
    });
    renderFronts(cc.host.querySelector(".rail-fronts"), frontRows(st, changes), {
        focusId: cc.ui.focusFront,
        series: sparkSeries(now),
        onToggle: (id) => {
            cc.ui.focusFront = cc.ui.focusFront === id ? null : id;
            announce(cc.ui.focusFront ? `Showing only ${fronts.get(id)?.label ?? id}` : "Showing all fronts");
            schedule(true);
        },
        onHover: (id) => {
            cc.ui.hoverFront = id;
            schedule(true);
        },
        onAddChat: svc.addToCommandChat ? (id) => svc.addToCommandChat({ kind: "front", id }) : null,
    });
    const range = timeRange(st, now);
    renderTimeline(cc.host.querySelector(".timeline"), {
        plan: st.plan,
        fronts: st.fronts,
        events: cc.events,
        ...range,
        at: cc.ui.at,
        onScrub: (t) => {
            cc.ui.at = t === null || t >= now ? null : Math.max(range.from, t);
            schedule(true);
        },
        onPhase: (p, el) => openPhaseMenu(p, el, st),
    });
    renderMonitors(cc.host.querySelector(".dock"), {
        monitors: L.monitors,
        events: replay ? cc.events.filter((e) => Date.parse(e.at) <= at) : cc.events,
        changes,
        fronts,
        docId: cc.docId,
        now: at,
        renderDiff: svc.renderDiff ?? (() => h("div", { class: "loading" }, "Diff unavailable")),
        onClose: (path) => toggleMonitor(path),
        onMode: (path, mode) => userLayout((l) => (l.monitors = l.monitors.map((m) => (m.path === path ? { ...m, mode } : m)))),
        onFocus: (path) => zoomTo(path),
    });
    announceChanges(st, offCount);
}

function sparkSeries(now) {
    const b = buckets(cc.events, { from: now - 30 * 60_000, to: now, count: 10 });
    return b;
}

function decorateHunks(el, n, c, w, hgt) {
    if (!c || w < 150 || hgt < 64 || c.kind === "deleted" || c.fronts.size !== 1) return;
    const rows = hunkRows(cc.docId, c.lead, n.path, `${c.add}/${c.del}`, () => schedule());
    if (!rows?.length) return;
    const fit = Math.max(1, Math.floor((hgt - 44) / 18));
    const list = hunkList(rows.slice(0, fit));
    list.style.setProperty("--fc", `var(--front-${cc.data.state.fronts.find((f) => f.id === c.lead)?.color ?? 5})`);
    el.append(list);
}

function emptyState() {
    const lease = cc.data.lease;
    return h(
        "div",
        { class: "cc-empty" },
        h("div", { class: "cc-empty-t" }, "No implementation plan yet"),
        h("p", {}, "When an orchestrating Copilot session starts on this whiteboard, the plan's territory lights up here as its fronts edit files."),
        h("p", { class: "muted" }, "The orchestrator calls ", h("code", {}, 'command_plan {op:"set"}'), " to begin, then registers each worktree with ", h("code", {}, 'command_front {op:"register"}'), "."),
        lease ? h("p", { class: "muted" }, `Lease: ${lease.sessionId}${leaseLive() ? "" : " (stale)"}`) : null,
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
        h(
            "button",
            {
                class: "offplan",
                hidden: true,
                "aria-pressed": "false",
                onclick: () => {
                    cc.ui.offOnly = !cc.ui.offOnly;
                    schedule(true);
                },
            },
            h("span", { class: "hatch-swatch" }),
            h("span", { class: "n" }),
        ),
        h("span", { class: "strip-grow" }),
    );
}

function renderStrip(st, at, offCount) {
    const strip = cc.host.querySelector(".strip");
    const lamp = strip.querySelector(".lamp");
    const ms = st.mission ?? { status: "unknown" };
    const live = leaseLive();
    lamp.hidden = ms.status === "unknown" && !st.plan;
    lamp.className = `lamp ${!live && st.plan ? "offline" : { working: "working", awaiting_operator: "waiting", complete: "complete" }[ms.status] ?? "idle"}`;
    const sub = ms.status === "awaiting_operator" && ms.prompt ? h("span", { class: "sub", title: ms.prompt }, ms.prompt) : null;
    if (!live && st.plan) put(lamp, h("span", { class: "dot" }), "Orchestrator offline");
    else if (ms.status === "working") put(lamp, h("span", { class: "pulse" }), "Working", sub);
    else if (ms.status === "awaiting_operator") put(lamp, h("span", { class: "dot" }), "Waiting on you", sub);
    else if (ms.status === "complete") put(lamp, "✓ Complete");
    else put(lamp, h("span", { class: "dot" }), "Idle");
    const v = velocity(cc.events, { at, windowKey: cc.ui.windowKey });
    strip.querySelector(".churn").textContent = v.churn;
    const net = strip.querySelector(".net");
    net.textContent = v.net ? `net ${v.net > 0 ? "+" : "−"}${Math.abs(v.net)}` : "";
    net.className = `net num ${v.net > 0 ? "add" : v.net < 0 ? "del" : ""}`;
    strip.querySelector(".files").textContent = v.files;
    strip.querySelector(".evs").textContent = v.events;
    const sel = strip.querySelector(".window select");
    sel.value = cc.ui.windowKey;
    sel.options[0].textContent = cc.ui.windowKey === "auto" ? v.label : `auto · ${v.auto.label}`;
    const chip = strip.querySelector(".offplan");
    chip.hidden = !offCount && !cc.ui.offOnly;
    chip.classList.toggle("on", cc.ui.offOnly);
    chip.setAttribute("aria-pressed", String(cc.ui.offOnly));
    chip.title = cc.ui.offOnly ? "Showing only off-plan edits (click to show all)" : "Show only off-plan edits";
    chip.querySelector(".n").textContent = `${offCount} off-plan`;
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
            h("div", { class: "legend" }),
            h("div", { class: "grow" }),
            h("div", { class: "view-ctl" }),
        ),
        stage,
        h("div", { class: "dock", hidden: true, "aria-label": "Monitors" }),
    );
    cc.tm = createTreemap(stage.querySelector(".tm"), {
        onZoom: (p) => zoomTo(p),
        onHover: (p) => {
            cc.ui.hover = p;
        },
    });
    return section;
}

function renderMapHead(st, root, auto = false) {
    const crumbs = cc.host.querySelector(".crumbs");
    const parts = root ? root.split("/") : [];
    const items = [h("button", { class: `path crumb${parts.length ? "" : " here"}`, title: "Zoom to the repository root", onclick: () => zoomTo("") }, `${cc.data.repository ?? "repo"}/`)];
    parts.forEach((p, i) => {
        const path = parts.slice(0, i + 1).join("/");
        items.push(h("span", { class: "sepc", "aria-hidden": "true" }, "›"), h("button", { class: `path crumb${i === parts.length - 1 ? " here" : ""}`, onclick: () => zoomTo(path) }, `${p}/`));
    });
    if (st.plan)
        items.push(
            auto
                ? h("span", { class: "auto", title: "Zoom root chosen automatically to cover the plan and live edits" }, "auto")
                : h("button", { class: "auto auto-btn", title: "Let the zoom follow the plan and live edits again", onclick: () => userLayout((l) => (l.root = null)) }, "↺ auto"),
        );
    put(crumbs, items);

    const L = cc.ui.layout;
    const legend = cc.host.querySelector(".legend");
    const pinsLegend = L.pins.length ? h("span", { class: "pins-legend", title: "Pinned areas are drawn larger (press P over a tile to pin or unpin)" }, h("span", { class: "pin-ic" }, "◆"), `Pinned: ${L.pins.map((p) => p.split("/").pop() + (findNode(cc.tree, p)?.dir ? "/" : "")).join(", ")} ×${PIN_WEIGHT}`) : null;
    put(legend, pinsLegend ?? [h("span", {}, h("i", { class: "lg fp" }), "Plan"), h("span", {}, h("i", { class: "lg ph" }), "Active checkpoint"), h("span", {}, h("i", { class: "lg op" }), "Off-plan")]);

    const ctl = cc.host.querySelector(".view-ctl");
    if (!st.plan) return put(ctl);
    const choices = viewChoices(st, prefs());
    const sugg = activeSuggestion(st);
    const current = choices.find((v) => v.id === cc.ui.viewId);
    const custom = !current && !(L.root === null && !L.pins.length && !L.monitors.length);
    const follow = prefs().follow !== false;
    const showReturn = sugg && !sameLayout(L, layoutFromView(sugg.suggestedView));
    const select = h(
        "select",
        {
            "aria-label": "Map view",
            onchange: (e) => {
                const id = e.target.value;
                if (id === "__auto") return resetAuto();
                if (id === "__custom") return;
                const v = choices.find((x) => x.id === id);
                if (v) applyView(v);
            },
        },
        h("option", { value: "__auto" }, "Auto"),
        custom ? h("option", { value: "__custom" }, "Custom (edited)") : null,
        choices.map((v) => h("option", { value: v.id }, `${v.origin === "user" ? "" : "✦ "}${v.title ?? v.id}${v.phaseId ? ` · ${v.phaseId.toUpperCase()}` : ""}`)),
    );
    select.value = current ? current.id : custom ? "__custom" : "__auto";
    put(
        ctl,
        showReturn ? h("button", { class: "return", title: `Apply the view suggested for ${sugg.title}`, onclick: () => applyView(sugg.suggestedView, { phaseId: sugg.id }) }, "Return to suggested") : null,
        custom ? h("button", { class: "return save-view", title: "Save this layout as a view", onclick: () => saveCurrentView() }, "Save view") : null,
        h("label", { class: "viewpick", title: "Views set the zoom, pins and monitors" }, current?.origin && current.origin !== "user" ? h("span", { class: "spark-ic", "aria-hidden": "true" }, "✦") : null, "View:", select),
        h("button", {
            class: `follow${follow ? " on" : ""}`,
            title: follow ? "Following: suggested views apply as checkpoints change (click to pause)" : "Paused: views won't change on their own (click to follow)",
            "aria-pressed": String(follow),
            "aria-label": "Follow suggested views",
            html: FOLLOW_SVG,
            onclick: () => {
                savePrefs({ follow: !follow, ...(follow ? {} : { adjustedSince: null, appliedPhase: null }) });
                announce(follow ? "Follow paused" : "Following suggested views");
                schedule(true);
            },
        }),
    );
}

function saveCurrentView() {
    const saved = prefs().savedViews ?? [];
    let n = saved.length + 1;
    while (saved.some((v) => v.id === `my-view-${n}`)) n++;
    const L = cc.ui.layout;
    const v = { id: `my-view-${n}`, title: `My view ${n}`, root: L.root, pins: L.pins.map((path) => ({ path })), monitors: L.monitors, filters: L.filters };
    savePrefs({ savedViews: [...saved, v], viewId: v.id });
    cc.ui.viewId = v.id;
    announce(`Saved ${v.title}`);
    schedule(true);
}

// ---------- phase menu ----------
function closeMenu() {
    cc.ui.menu?.remove();
    cc.ui.menu = null;
}

function openPhaseMenu(p, anchor, st) {
    closeMenu();
    const items = [];
    const at = (t) => () => {
        cc.ui.at = t;
        closeMenu();
        schedule(true);
    };
    if (p.suggestedView) items.push(["Apply suggested view", () => (applyView(p.suggestedView, { phaseId: p.id }), closeMenu())]);
    const first = cc.events.find((e) => !e.initial && !e.baseline && e.phaseIds?.includes(p.id));
    if (first) items.push(["Replay from its first edit", at(Date.parse(first.at))]);
    if (p.state.status === "done") items.push([`Replay at completion${p.state.checkpoint ? ` (${p.state.checkpoint.sha.slice(0, 7)})` : ""}`, at(Date.parse(p.state.since))]);
    if (cc.ui.at !== null) items.push(["Back to live", at(null)]);
    const menu = h(
        "div",
        { class: "cc-menu", role: "menu", "aria-label": `${p.title} actions` },
        h("div", { class: "cc-menu-h" }, `${p.id.toUpperCase()} · ${p.title}`, h("span", { class: `st ${p.state.status}` }, p.state.status)),
        items.length ? items.map(([label, fn]) => h("button", { role: "menuitem", onclick: fn }, label)) : h("div", { class: "cc-menu-empty" }, "Nothing to do here yet."),
    );
    const r = anchor.getBoundingClientRect();
    const hr = cc.host.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left - hr.left, hr.width - 248))}px`;
    menu.style.bottom = `${hr.bottom - r.top + 6}px`;
    cc.host.querySelector(".cc").append(menu);
    cc.ui.menu = menu;
    menu.querySelector("button")?.focus();
}

// ---------- keyboard ----------
function keydown(e) {
    if (!isMounted() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], .chat")) return;
    if (e.key === "Escape" && cc.ui.menu) return closeMenu();
    const st = cc.data?.state;
    if (!st?.plan) return;
    const hover = cc.ui.hover;
    if ((e.key === "p" || e.key === "P") && hover) {
        e.preventDefault();
        togglePin(hover);
    } else if ((e.key === "m" || e.key === "M") && hover) {
        e.preventDefault();
        const n = findNode(cc.tree, hover);
        toggleMonitor(n?.dir ? hover : hover.includes("/") ? hover.slice(0, hover.lastIndexOf("/")) : hover);
    } else if (e.key === "Backspace") {
        const root = cc.ui.layout.root ?? autoRoot(st.plan, [...changesAt(cc.events).keys()]);
        if (!root) return;
        e.preventDefault();
        zoomTo(root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "");
    }
}

// ---------- announcements ----------
function announce(msg) {
    const el = cc.host?.querySelector(".cc > .sr-only");
    if (el) el.textContent = msg;
}

function announceChanges(st, offCount) {
    const phases = (st.plan?.phases ?? []).map((p) => `${p.id}:${p.state.status}`).join(",");
    if (cc.announced.phases && phases !== cc.announced.phases) {
        const prev = new Map(cc.announced.phases.split(",").map((s) => s.split(":")));
        const moved = st.plan.phases.find((p) => prev.get(p.id) !== p.state.status);
        if (moved) announce(`${moved.title} is now ${moved.state.status}`);
    }
    cc.announced.phases = phases;
    if (offCount > cc.announced.offPlan && cc.ui.at === null) announce(`${offCount} off-plan edit${offCount === 1 ? "" : "s"}`);
    cc.announced.offPlan = offCount;
}

export function refresh() {
    if (isMounted()) reloadAll();
}
