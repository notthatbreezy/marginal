// Command tab: the implementation mission wall.
// Instrument strip, territory map, fronts rail, checkpoint timeline, off-plan filter,
// views & follow, auto-root, fisheye pins, monitors dock, hunk rows. Everything renders "as of" a time: live = now.
import { shortcut } from "../settings.js";
import { INSTANCE, api, bus, h, put, svc } from "../core.js";
import { compilePatterns, parseLayout, patternsTouchDir, phasePatterns, planPatterns } from "../command/patterns.js";
import { buckets, changesAt, velocity } from "./derive.js";
import { renderFronts, renderTimeline } from "./fronts.js";
import { PHASE_STAGE, renderPhases } from "./phases.js";
import { helpersPopover, renderProgressLine, todosPopover } from "./progress.js";
import { renderMonitors } from "./monitors.js";
import { buildTree, findNode } from "./squarify.js";
import { createTreemap } from "./treemap.js";
import { PIN_WEIGHT, autoRoot, commonDir, emptyLayout, followDecision, hunkList, hunkRows, layoutFromView, quietSinceZoom, sameLayout, viewChoices } from "./views.js";
import { createWalkthrough, stopMarkdown } from "./walkthrough.js";
import { startCommandTour } from "./tour.js";
import { createSelection, withModifier } from "../selection.js";

const STALE_MS = 30_000; // lease liveness, aged locally between heartbeats (owner.mjs STALE_MS)
const MAX_MONITORS = 3;
const ADD_CHAT_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 5.5v4M6 7.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
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
    walk: null, // walkthrough pop-up controller
    walkLink: null, // { files: Map(path → stop #), stopOn, root, key } while a walkthrough is open
    sel: null, // multi-select over map tiles
    inChat: new Set(), // paths currently in the Command chat focus
    ownerHere: null,
    announced: { phases: "", offPlan: 0 },
};

const freshUi = () => ({
    windowKey: "auto",
    focusFront: null,
    hoverFront: null,
    focusPhase: null,
    hoverPhase: null,
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
    root.append(buildStrip(), buildMap(), h("aside", { class: "rail-fronts", "aria-label": "Phases" }, h("div", { class: "rail-phases" }), h("div", { class: "rail-worktrees", hidden: true })), h("section", { class: "timeline", "aria-label": "Phases timeline" }), h("div", { class: "sr-only", "aria-live": "polite", role: "status" }));
    put(host, root);
    cc.off.push(bus.on("command", onEvent));
    const onKey = (e) => keydown(e);
    // A control that opens a popover toggles it itself (closing here first would reopen it on click).
    const onDown = (e) => cc.ui.menu && !e.target.closest(".cc-menu") && !e.target.closest("[aria-haspopup]") && closeMenu();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    cc.off.push(() => document.removeEventListener("keydown", onKey), () => document.removeEventListener("pointerdown", onDown, true));
    cc.liveTimer = setInterval(() => {
        if (!cc.data) return;
        schedule(); // ages "live" rings, lease liveness and relative times
        cc.walk?.tick();
    }, 5000);
    cc.sel = createSelection({
        keyOf: (el) => el.dataset.path,
        elOf: (p) => cc.tm?.elFor(p) ?? null,
        units: () => [...cc.host.querySelectorAll(".stage .tn")],
        actions: {
            chat: (keys) => (svc.addToCommandChat?.(keys.map(pathItem)), cc.sel.clear()),
            comment: (keys) => (svc.addToCommandChat?.(keys.map(pathItem), { quote: keys.join("\n"), quoteLabel: `${keys.length} path${keys.length === 1 ? "" : "s"}` }), cc.sel.clear()),
            copy: async (keys) => svc.toast?.((await svc.copyText?.(keys.join("\n"))) ? `Copied ${keys.length} path${keys.length === 1 ? "" : "s"}` : "Copy failed"),
        },
    });
    cc.walk = createWalkthrough({
        mount: root,
        frontOf: (path) => {
            const c = changesAt(cc.events).get(path);
            return c ? cc.data.state.fronts.find((f) => f.id === c.lead) ?? null : null;
        },
        reviewedOf: (w) => !!prefs().reviewed?.[w.id],
        onStop: (w, stop) => {
            linkStop(w, stop);
            // Reaching the last stop counts as reviewed (the list can undo it); "since the last review" starts there.
            if (w.stops.at(-1)?.id === stop.id && !prefs().reviewed?.[w.id]) {
                savePrefs({ reviewed: { ...(prefs().reviewed ?? {}), [w.id]: { at: new Date().toISOString(), head: w.pins.head } } });
                announce(`Marked “${w.title}” reviewed`);
                setTimeout(() => cc.walk?.tick(), 0);
            }
            svc.refreshChatRef?.();
        },
        // The Command chat docks under the walkthrough while it is open: one conversation across its stops.
        onOpen: (slot) =>
            svc.dockChat?.(slot, {
                mode: "command",
                kind: "walkthrough",
                placeholder: "Ask about this stop…",
                ref: () => {
                    const w = cc.walk?.current;
                    const s = cc.walk?.stop;
                    return w && s ? `Walkthrough · stop ${cc.walk.index + 1} of ${w.stops.length} · ${s.title}` : "Walkthrough";
                },
                context: () => {
                    const w = cc.walk?.current;
                    const s = cc.walk?.stop;
                    return w && s ? `Walkthrough "${w.title}" (id ${w.id}, revision ${w.revision}), stop ${cc.walk.index + 1} of ${w.stops.length}: "${s.title}" (stop id ${s.id}). Ranges: ${s.ranges.map((r) => `${r.sourceFile ?? r.file}${r.side === "base" ? " (before)" : ""} L${r.startLine}-${r.endLine}`).join(", ")}. To expand it, use command_walkthrough {op:"edit"} (update_stop / insert_stop).` : "";
                },
            }),
        onClose: (w, { user }) => {
            svc.undockChat?.();
            cc.walkLink = null;
            const v = cc.data.state.walkthroughView;
            if (user && w) savePrefs({ walkthroughPick: null, walkthroughDismissed: v ? { id: v.id, seq: v.seq } : null });
            schedule(true);
        },
        onCopy: async (w, stop, i) => svc.toast?.((await svc.copyText?.(stopMarkdown(w, stop, i))) ? "Stop copied as Markdown" : "Copy failed"),
        onComment: (w, stop, i) => svc.addToCommandChat?.([stopItem(w, stop, i)], { quote: `Stop ${i + 1}: ${stop.title}\n\n${stop.explanation}`, quoteLabel: `stop ${i + 1}` }),
        onAsk: (w, stop, i) => svc.addToCommandChat?.([stopItem(w, stop, i), ...stop.ranges.map((r) => rangeItem(w, r))]),
    });
    Object.assign(svc, {
        commandChatBlocked: chatBlockedReason,
        commandFocusPayload: (focus) => ({ items: focus.map((f) => f.item) }),
        onCommandChatOpen: () => {
            // While a walkthrough is open, the chat sits to its left instead of over its stop actions.
            const walk = cc.host?.querySelector(".walk");
            const box = document.getElementById("chat");
            if (!walk || !box || svc.isChatDocked?.()) return;
            const wr = walk.getBoundingClientRect();
            if (box.getBoundingClientRect().right > wr.left + 1) box.style.right = `${Math.max(0, innerWidth - wr.left + 12)}px`;
        },
        onFocusChange: (focus) => {
            cc.inChat = new Set(focus.filter((f) => f.item.kind === "path").map((f) => f.item.path));
            schedule(true);
        },
    });
    const place = () => root.style.setProperty("--cc-top", `${Math.round(host.getBoundingClientRect().top) + 8}px`);
    place();
    addEventListener("resize", place);
    cc.off.push(() => removeEventListener("resize", place));
    await reloadAll();
}

export function unmountCommand() {
    flushPrefs();
    cc.tour?.close();
    cc.tour = null;
    svc.undockChat?.(); // before the walkthrough (and the chat docked in it) leaves the DOM
    cc.walk?.destroy();
    cc.walk = null;
    cc.walkLink = null;
    cc.sel?.clear();
    cc.sel = null;
    svc.hideCommandChat?.();
    for (const k of ["commandChatBlocked", "commandFocusPayload", "onCommandChatOpen", "onFocusChange"]) delete svc[k];
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
        if (data.revising?.active) cc.revising = Date.parse(data.revising.at); // a rejection that happened before this panel connected
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
    } else if (ev.kind === "revising") {
        cc.walk?.revising(ev.active);
        cc.revising = ev.active ? Date.now() : 0;
        schedule(true);
    } else if (ev.kind === "progress") {
        if (!cc.data) return;
        cc.data.progress = ev.progress ?? null;
        refreshProgPop();
        schedule();
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
    if (target && quietSinceZoom(cc.ui.userZoomAt)) applyView(target.suggestedView, { phaseId: target.id });
}

function togglePin(path) {
    userLayout((l) => {
        l.pins = l.pins.includes(path) ? l.pins.filter((p) => p !== path) : [...l.pins, path];
    });
    announce(cc.ui.layout.pins.includes(path) ? `Pinned ${path}` : `Unpinned ${path}`);
}

function clearPins() {
    const n = cc.ui.layout.pins.length;
    userLayout((l) => {
        l.pins = [];
    });
    cc.ui.findPin = null;
    announce(`Unpinned ${n} area${n === 1 ? "" : "s"}`);
}
/** Where a pin is on the map: outlined while its chip is hovered, flashed when the chip is clicked. */
function paintPinFind() {
    const f = cc.ui.findPin;
    for (const el of cc.host.querySelectorAll(".tn.pin-find")) if (el.dataset.path !== f?.path) el.classList.remove("pin-find", "pin-flash");
    if (!f) return;
    if (f.until && Date.now() > f.until) return void (cc.ui.findPin = null);
    const el = cc.tm.elFor(f.path);
    el?.classList.add("pin-find");
    el?.classList.toggle("pin-flash", !!f.until);
}
function findPin(path, { flash = false } = {}) {
    if (!path) {
        if (!cc.ui.findPin?.until) cc.ui.findPin = null;
        return paintPinFind();
    }
    // Not on the map at this zoom: zoom out to the pinned area's folder so it can be seen.
    if (flash && !cc.tm.elFor(path)) zoomTo(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    cc.ui.findPin = { path, until: flash ? Date.now() + 1800 : 0 };
    paintPinFind();
    if (flash) setTimeout(() => cc.ui.findPin?.path === path && ((cc.ui.findPin = null), paintPinFind()), 1850);
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
    const activePhases = (plan?.phases ?? []).filter((p) => p.state.status === "active" || p.state.status === "review");
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

/** Each phase with what's changed so far within what it delivers (its expects), and its pace over the last 30 min. */
function phaseRows(st, changes, now) {
    const N = 10;
    const from = now - 30 * 60_000;
    const span = (now - from) / N;
    return st.plan.phases.map((ph) => {
        const inside = compilePatterns(phasePatterns(ph));
        const row = { phase: ph, stage: PHASE_STAGE[ph.state.status] ?? "planned", add: 0, del: 0, files: 0, series: new Array(N).fill(0) };
        for (const [path, c] of changes) {
            if (!inside(path)) continue;
            row.add += c.add;
            row.del += c.del;
            row.files++;
        }
        for (const e of cc.events) {
            const t = Date.parse(e.at);
            if (t < from || e.initial || e.baseline || !e.phaseIds?.includes(ph.id)) continue;
            const i = Math.min(N - 1, Math.floor((t - from) / span));
            row.series[i] += Math.abs(e.delta?.add ?? 0) + Math.abs(e.delta?.del ?? 0);
        }
        return row;
    });
}

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
    // A front that hasn't started: which checkpoint it's planned for.
    const inPlay = (ph) => ph.state.status === "active" || ph.state.status === "review";
    const planned = (plan?.phases ?? []).find((ph) => ph.state.status !== "done" && !inPlay(ph) && (ph.state.frontIds ?? []).includes(frontId));
    const active = (plan?.phases ?? []).some((ph) => inPlay(ph) && (ph.state.frontIds ?? []).includes(frontId));
    if (planned && !active) return { phase: `Planned for ${planned.id.toUpperCase()} · ${planned.title ?? planned.id}` };
    for (const ph of plan?.phases ?? []) {
        if (!inPlay(ph)) continue;
        const step = ph.steps.find((s) => s.state.status === "active" && s.state.frontId === frontId);
        if (step || ph.state.frontIds?.includes(frontId)) return { phase: `${ph.id.toUpperCase()} · ${ph.title}`, step: step?.title ?? null };
    }
    return { phase: null, step: null };
}

/** Where the timeline starts: the first real edit, phase start or helper (at least a minute back). */
function timelineStart(st, now) {
    const first = cc.events.find((e) => !e.baseline)?.at ?? cc.events[0]?.at;
    const since = (st.plan?.phases ?? []).map((p) => (p.state.since ? Date.parse(p.state.since) : Infinity));
    const helpers = (cc.data?.progress?.helpers?.list ?? []).map((x) => Date.parse(x.startedAt)).filter(Number.isFinite);
    return Math.min(first ? Date.parse(first) : now, ...since, ...helpers, now - 60_000);
}

// ---------- render ----------
function render() {
    if (!isMounted() || !cc.data) return;
    const st = cc.data.state;
    const now = Date.now();
    const at = now;
    if (st.plan) maybeFollow(st);
    const changes = changesAt(cc.events, Infinity);
    const offCount = [...changes.values()].filter(isOff).length;
    renderStrip(st, at, offCount);
    renderNudge();
    const main = cc.host.querySelector(".cc");
    syncWalkthrough(st);
    main.classList.toggle("walking", !!cc.walk?.open);
    syncOwner();
    const empty = cc.host.querySelector(".cc-empty");
    if (!st.plan) {
        renderMapHead(st, "");
        fitMapHead();
        if (!empty) cc.host.querySelector(".stage").append(emptyState());
        renderInit();
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
    let root = cc.walkLink ? cc.walkLink.root : auto ? autoRoot(st.plan, [...changes.keys()]) : L.root;
    if (root && !findNode(cc.tree, root)) root = "";
    renderMapHead(st, root, auto);
    fitMapHead();
    const fronts = new Map(st.fronts.map((f) => [f.id, f]));
    const pins = new Map(L.pins.map((p) => [p, PIN_WEIGHT]));
    const onlyFront = cc.ui.hoverFront ?? cc.ui.focusFront;
    const phaseOn = cc.ui.hoverPhase ?? cc.ui.focusPhase;
    const phaseObj = phaseOn && st.plan.phases.find((p) => p.id === phaseOn);
    const onlyPhase = phaseObj ? compilePatterns(phasePatterns(phaseObj)) : null;
    const vf = L.filters ?? {};
    const offOnly = cc.ui.offOnly || !!vf.offPlanOnly;
    const viewFronts = vf.frontIds?.length ? new Set(vf.frontIds) : null;
    const filter =
        onlyFront || onlyPhase || offOnly || viewFronts || vf.hideTests || vf.minChurn
            ? (path, c) => {
                  if (vf.hideTests && TEST_PATH.test(path)) return false;
                  if (onlyPhase && !onlyPhase(path)) return false;
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
        decorateFile: decorateHunks,
        tipExtra: (node, c) => (isOff(c) ? h("div", { class: "warn" }, "Off-plan: outside what the phases being worked on deliver.") : null),
        badges: cc.walkLink?.files,
        stopOn: cc.walkLink?.stopOn,
        stopKey: cc.walkLink?.key,
        inChat: cc.inChat,
    });
    cc.sel.paint(); // tiles are rebuilt every render; re-apply the selection
    paintPinFind();
    renderPhases(cc.host.querySelector(".rail-phases"), phaseRows(st, changes, now), {
        focusId: cc.ui.focusPhase,
        chatIcon: ADD_CHAT_SVG,
        progress: cc.data.progress,
        onToggle: (id) => {
            cc.ui.focusPhase = cc.ui.focusPhase === id ? null : id;
            announce(cc.ui.focusPhase ? `Showing only ${id.toUpperCase()}'s files` : "Showing all phases");
            schedule(true);
        },
        onHover: (id) => {
            if (cc.ui.hoverPhase === id) return;
            cc.ui.hoverPhase = id;
            schedule(true);
        },
        onAddChat: svc.addToCommandChat ? (p) => svc.addToCommandChat([phaseItem(p)]) : null,
    });
    // Worktrees are plumbing: listed only when there are several (parallel sessions, stacked PRs).
    const wt = cc.host.querySelector(".rail-worktrees");
    wt.hidden = st.fronts.length < 2;
    if (wt.hidden) put(wt);
    else renderFronts(wt, frontRows(st, changes), {
        title: "Worktrees",
        focusId: cc.ui.focusFront,
        series: sparkSeries(now),
        onToggle: (id) => {
            cc.ui.focusFront = cc.ui.focusFront === id ? null : id;
            announce(cc.ui.focusFront ? `Showing only ${fronts.get(id)?.label ?? id}` : "Showing all fronts");
            schedule(true);
        },
        onHover: (id) => {
            if (cc.ui.hoverFront === id) return; // a re-render under a still pointer re-fires mouseenter
            cc.ui.hoverFront = id;
            schedule(true);
        },
        onAddChat: svc.addToCommandChat ? (id) => svc.addToCommandChat([frontItem(fronts.get(id))]) : null,
    });
    renderTimeline(cc.host.querySelector(".timeline"), {
        plan: st.plan,
        fronts: st.fronts,
        events: cc.events,
        from: timelineStart(st, now),
        now,
        onPhase: (p, el) => openPhaseMenu(p, el, st),
        helpers: cc.data.progress?.helpers?.list,
        trimmedUntil: cc.data.progress?.helpers?.trimmedUntil,
        wholeRun: cc.ui.wholeRun,
        onRange: () => {
            cc.ui.wholeRun = !cc.ui.wholeRun;
            schedule(true);
        },
    });
    renderMonitors(cc.host.querySelector(".dock"), {
        monitors: L.monitors,
        events: cc.events,
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
    return h(
        "div",
        { class: "cc-empty" },
        h("div", { class: "cc-empty-t" }, "No implementation plan yet"),
        h("p", {}, "When an orchestrating Copilot session starts on this doc, the plan's territory lights up here as its fronts edit files."),
        h("div", { class: "cc-init" }),
        h("p", { class: "muted" }, "Or ask for it in chat: the orchestrator calls ", h("code", {}, 'command_plan {op:"set"}'), " to begin, then registers each worktree with ", h("code", {}, 'command_front {op:"register"}'), "."),
    );
}

/**
 * "Initialize command center": asks this panel's Copilot session to become the orchestrator and set the plan.
 * Kept in place across renders so the goal text and focus survive the 4 Hz refresh.
 */
function renderInit() {
    const host = cc.host.querySelector(".cc-init");
    if (!host) return;
    const l = cc.data.lease;
    const otherOwner = l && leaseLive() && !cc.data.isOwnerHere ? l.sessionId : null;
    const pending = cc.ui.initPending && Date.now() - cc.ui.initPending < 10 * 60_000;
    const mode = otherOwner ? "other" : pending ? "pending" : "ready";
    if (host.dataset.mode === mode) return;
    host.dataset.mode = mode;
    if (mode === "other") {
        put(host, h("p", { class: "cc-init-note" }, `Session ${otherOwner.slice(0, 8)} is orchestrating this doc. Open it in that session to set up the plan.`));
        return;
    }
    if (mode === "pending") {
        put(
            host,
            h("div", { class: "cc-init-pending", role: "status" }, h("span", { class: "pulse" }), "Copilot is drafting the plan… the map lights up as soon as it's set."),
            h("button", { class: "cc-init-link", onclick: () => svc.addToCommandChat?.([]) }, "Open the conversation"),
        );
        return;
    }
    const goal = h("textarea", { class: "cc-init-goal", rows: "2", maxlength: "2000", placeholder: "What are we building? (optional; Copilot also reads this doc and the branch)", "aria-label": "Goal for the implementation plan" });
    const btn = h("button", { class: "primary cc-init-btn", onclick: () => initialize(goal.value, btn) }, "Initialize command center");
    goal.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            initialize(goal.value, btn);
        }
    });
    put(host, goal, h("div", { class: "cc-init-row" }, btn, h("span", { class: "muted" }, "This session becomes the orchestrator.")));
}

async function initialize(goal, btn) {
    btn.disabled = true;
    try {
        const r = await api(`/command/init?${q()}&instance=${encodeURIComponent(INSTANCE)}`, { method: "POST", body: { goal: goal.trim() || undefined } });
        cc.ui.initPending = Date.now();
        svc.attachCommandThread?.(r.threadId, goal.trim() ? `Initialize the command center: ${goal.trim()}` : "Initialize the command center");
    } catch (e) {
        svc.toast?.(e.message);
        btn.disabled = false;
        return;
    }
    renderInit();
}

// ---------- instrument strip ----------
function buildStrip() {
    return h(
        "section",
        { class: "strip", "aria-label": "Mission instruments" },
        h("span", { class: "lamp", role: "status", hidden: true }),
        h("div", { class: "progress-line", role: "group", "aria-label": "Progress", hidden: true }),
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
        h("span", { class: "tour-slot" }),
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
    renderProgressLine(strip.querySelector(".progress-line"), st.plan ? cc.data.progress : null, { onTodos: (a) => toggleProgPop("todos", a), onHelpers: (a) => toggleProgPop("helpers", a) });
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
    const add = h("button", { class: "addchat tile-add", hidden: true, title: "Add to chat", "aria-label": "Add this to the Command chat", html: ADD_CHAT_SVG, onclick: () => add.dataset.path !== undefined && svc.addToCommandChat?.([pathItem(add.dataset.path)]) });
    let hideT = 0;
    add.addEventListener("pointerenter", () => clearTimeout(hideT));
    add.addEventListener("pointerleave", () => (hideT = setTimeout(() => (add.hidden = true), 150)));
    stage.append(add);
    new ResizeObserver(() => fitMapHead()).observe(section.querySelector(".map-head"));
    cc.tm = createTreemap(stage.querySelector(".tm"), {
        onZoom: (p) => zoomTo(p),
        onHover: (p, el) => {
            cc.ui.hover = p;
            clearTimeout(hideT);
            if (p === null || !el || !svc.addToCommandChat) return void (hideT = setTimeout(() => (add.hidden = true), 150));
            const r = el.getBoundingClientRect();
            const sr = stage.getBoundingClientRect();
            add.dataset.path = p;
            add.style.left = `${Math.max(2, Math.min(r.right - sr.left - 26, sr.width - 26))}px`;
            add.style.top = `${Math.max(2, r.top - sr.top + 3)}px`;
            add.hidden = false;
        },
    });
    // Ctrl/Cmd+click toggles a tile, Shift+click extends; a plain click elsewhere on the map clears.
    stage.addEventListener("mousedown", (e) => withModifier(e) && e.target.closest(".tn") && e.preventDefault(), true);
    stage.addEventListener(
        "click",
        (e) => {
            const el = e.target.closest(".tn");
            if (withModifier(e) && el) {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) cc.sel.range(el);
                else cc.sel.toggle(el);
            } else if (cc.sel?.size && !e.target.closest(".addchat")) cc.sel.clear();
        },
        true,
    );
    return section;
}

function renderMapHead(st, root, auto = false) {
    const crumbs = cc.host.querySelector(".crumbs");
    const parts = root ? root.split("/") : [];
    const crumbKey = JSON.stringify([cc.data.repository, root, auto, !!st.plan]);
    if (crumbs.dataset.key !== crumbKey) {
        crumbs.dataset.key = crumbKey;
        const repo = `${cc.data.repository ?? "repo"}/`;
        // Short of room the middle folders fold into "…" (a menu of them); the repo and the folder shown stay.
        const mids = parts.slice(0, -1).map((p, i) => ({ name: `${p}/`, path: parts.slice(0, i + 1).join("/") }));
        const sep = (cls = "") => h("span", { class: `sepc${cls}`, "aria-hidden": "true" }, "›");
        put(
            crumbs,
            h("button", { class: `path crumb root${parts.length ? "" : " here"}`, title: `${repo}\nZoom to the repository root`, onclick: () => zoomTo("") }, repo),
            mids.length ? [sep(" more"), h("button", { class: "path crumb crumb-more", title: `${mids.map((m) => m.name).join(" › ")}\nShow the folders in between`, "aria-haspopup": "menu", onclick: (e) => openCrumbMenu(e.currentTarget, mids) }, "…")] : null,
            mids.map((m) => [sep(" mid"), h("button", { class: "path crumb mid", title: `${m.path}/`, onclick: () => zoomTo(m.path) }, m.name)]),
            parts.length ? [sep(), h("button", { class: "path crumb here", title: `${root}/`, onclick: () => zoomTo(root) }, `${parts.at(-1)}/`)] : null,
            st.plan
                ? auto
                    ? h("span", { class: "auto", title: "Zoom root chosen automatically to cover the plan and live edits" }, "auto")
                    : h("button", { class: "auto auto-btn", title: "Let the zoom follow the plan and live edits again", onclick: () => userLayout((l) => (l.root = null)) }, "↺ auto")
                : null,
        );
    }

    const L = cc.ui.layout;
    const legend = cc.host.querySelector(".legend");
    // The colour key; pins live behind the pin button in the controls.
    if (!legend.childElementCount) put(legend, h("span", {}, h("i", { class: "lg fp" }), "Plan"), h("span", {}, h("i", { class: "lg ph" }), "Active phase"), h("span", {}, h("i", { class: "lg op" }), "Off-plan"));

    const ctl = cc.host.querySelector(".view-ctl");
    // Rebuilt only when what it shows changes: a 4 Hz rebuild could swallow a click between mousedown and mouseup.
    const same = (key) => ctl.dataset.key === key || ((ctl.dataset.key = key), false);
    if (!st.plan) return same("noplan") || put(ctl, tourButtons());
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
    const view = st.walkthroughView;
    const walk = view && !cc.walk?.open ? st.walkthroughs.find((x) => x.id === view.id) : null;
    const revisingNow = cc.revising && Date.now() - cc.revising < 60_000 && !cc.walk?.open;
    const key = JSON.stringify([choices.map((v) => [v.id, v.title, v.origin, v.phaseId]), select.value, custom, follow, !!showReturn, sugg?.id, walk && [walk.id, walk.stops.length, walk.title], st.walkthroughs.length, !!cc.walk?.open, !!revisingNow, current?.origin, L.pins]);
    if (same(key)) return;
    put(
        ctl,
        revisingNow ? h("span", { class: "revising", role: "status" }, h("span", { class: "pulse" }), "Agent is revising the walkthrough…") : null,
        st.walkthroughs.length && !cc.walk?.open
            ? h("button", { class: "return walk-reopen", title: "Walkthroughs of this work: open one, or see what you've reviewed", "aria-haspopup": "menu", onclick: (e) => openWalkMenu(e.currentTarget, st) }, "▸ ", h("span", { class: "long" }, "Walkthroughs"), h("span", { class: "short" }, "Walks"), ` · ${st.walkthroughs.length}`)
            : null,
        showReturn ? h("button", { class: "return", title: `Apply the view suggested for ${sugg.title}`, onclick: () => applyView(sugg.suggestedView, { phaseId: sugg.id }) }, "Return", h("span", { class: "long" }, " to suggested")) : null,
        custom ? h("button", { class: "return save-view", title: "Save this layout as a view", onclick: () => saveCurrentView() }, "Save", h("span", { class: "long" }, " view")) : null,
        h("label", { class: "viewpick", title: "Views set the zoom, pins and monitors" }, current?.origin && current.origin !== "user" ? h("span", { class: "spark-ic", "aria-hidden": "true" }, "✦") : null, h("span", { class: "long" }, "View:"), select),
        h(
            "button",
            {
                class: `follow pin-btn${L.pins.length ? " has" : ""}`,
                title: L.pins.length ? `${L.pins.length} pinned (drawn ${PIN_WEIGHT}× larger): find or unpin them` : "Pinned areas (P over a tile pins it)",
                "aria-label": `Pinned areas${L.pins.length ? `: ${L.pins.length}` : ""}`,
                "aria-haspopup": "dialog",
                onclick: (e) => (cc.ui.menu?.classList.contains("pin-menu") ? closeMenu() : openPinMenu(e.currentTarget)),
            },
            h("span", { html: PIN_SVG }),
            L.pins.length ? h("span", { class: "pin-n" }, String(L.pins.length)) : null,
        ),
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
        tourButtons(),
    );
}

/**
 * The map header stays on one line. When it doesn't fit it gives way in steps, cheapest first: the colour legend
 * goes, the folders between the repo and the shown one fold into "…", and the
 * controls drop their longer words; last, the names that remain end in an ellipsis.
 */
function fitMapHead() {
    const head = cc.host?.querySelector(".map-head");
    if (!head || !head.clientWidth) return;
    const crumbs = head.querySelector(".crumbs");
    const sig = `${head.clientWidth}|${crumbs.dataset.key}|${head.querySelector(".legend").dataset.key}|${head.querySelector(".view-ctl").dataset.key}`;
    if (head.dataset.fit === sig) return;
    head.dataset.fit = sig;
    const legend = head.querySelector(".legend");
    // Every part that can shrink must show all of itself, not just the header as a whole.
    const whole = (el) => el.scrollWidth <= el.clientWidth + 1;
    // One line: nothing overflows sideways, and nothing has wrapped below the first row.
    // (Items are centred on the line, so a wrapped one sits a row lower: compare centres, ignoring empty spacers.)
    const oneRow = (el) => {
        const mids = [...el.children]
            .map((k) => k.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => r.top + r.height / 2);
        return !mids.length || Math.max(...mids) - Math.min(...mids) < 10;
    };
    const fits = () => whole(head) && whole(crumbs) && whole(legend) && oneRow(head);
    for (let level = 0; level <= 3; level++) {
        head.dataset.compact = String(level);
        if (fits()) break;
    }
}
function openCrumbMenu(anchor, mids) {
    closeMenu();
    const menu = h("div", { class: "cc-menu crumb-menu", role: "menu", "aria-label": "Folders" }, mids.map((m) => h("button", { role: "menuitem", title: `${m.path}/`, onclick: () => (closeMenu(), zoomTo(m.path)) }, m.path.split("/").map((x, i) => (i ? [h("span", { class: "sepc" }, " › "), x] : x)))));
    placeMenu(menu, anchor);
}
const PIN_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M9.6 2.2l4.2 4.2-1.9.6-2.4 2.4.4 3.1-1.4 1.4-2.6-2.6-3.2 3.2M5.5 8.2L2.9 5.6l1.4-1.4 3.1.4 2.4-2.4z"/></svg>';
/** The pins popover (like Settings): each pinned area to find or unpin, or how to pin when there are none. */
function openPinMenu(anchor) {
    closeMenu();
    const pins = cc.ui.layout.pins;
    const menu = h(
        "div",
        { class: "cc-menu pin-menu pin-pop", role: "dialog", "aria-label": "Pinned areas" },
        h("div", { class: "pp-head" }, h("span", {}, "Pinned areas"), h("button", { class: "chat-icon pp-x", title: "Close (Esc)", "aria-label": "Close", onclick: () => closeMenu(), html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' })),
        pins.length ? null : h("p", { class: "pp-empty" }, "Nothing pinned. Press ", h("kbd", {}, "P"), " over a tile to pin it: pinned areas are drawn ", String(PIN_WEIGHT), "× larger, so the parts you care about stay readable when the map is busy."),
        pins.map((p) =>
            h(
                "div",
                { class: "wm-row", onmouseenter: () => findPin(p), onmouseleave: () => findPin(null) },
                h("button", { role: "menuitem", class: "pm-name", title: "Show it on the map", onclick: () => (closeMenu(), findPin(p, { flash: true })) }, p || "(the whole repo)"),
                h("button", { class: "pc-x", title: `Unpin ${p}`, "aria-label": `Unpin ${p}`, onclick: () => (findPin(null), togglePin(p), openPinMenu(cc.host.querySelector(".pin-btn") ?? anchor)) }, "×"),
            ),
        ),
        pins.length ? h("div", { class: "pp-foot" }, h("span", {}, "Drawn ", String(PIN_WEIGHT), "× larger · ", h("kbd", {}, "P"), " on a tile toggles"), pins.length > 1 ? h("button", { class: "pm-clear", onclick: () => (closeMenu(), clearPins()) }, "Clear all") : null) : null,
    );
    placeMenu(menu, anchor);
}
/** Drop a menu under the header control that opened it, kept inside the map. */
function placeMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    const hr = cc.host.getBoundingClientRect();
    cc.host.querySelector(".cc").append(menu);
    const w = menu.offsetWidth || 240;
    // Under the control, opening towards the middle: right-aligned for controls on the right.
    const x = r.left - hr.left > hr.width / 2 ? r.right - hr.left - w : r.left - hr.left;
    menu.style.left = `${Math.max(8, Math.min(x, hr.width - w - 8))}px`;
    menu.style.top = `${r.bottom - hr.top + 6}px`;
    cc.ui.menu = menu;
    menu.querySelector("button")?.focus();
}

// ---------- guided tour (discoverability) ----------
const HELP_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".85" fill="currentColor"/></svg>';
/** "?" always; plus a one-time "Take the tour" nudge until the tour has been started or dismissed on this doc. */
function tourButtons() {
    return h("button", { class: "follow tour-help", title: "Tour the Command center (?)", "aria-label": "Tour the Command center", html: HELP_SVG, onclick: () => openTour() });
}
/** The nudge lives at the end of the instrument strip, where there is room; shown until started or dismissed. */
function renderNudge() {
    const slot = cc.host.querySelector(".strip .tour-slot");
    const show = !prefs().guideSeen && !cc.tour;
    if (slot.dataset.show === String(show)) return;
    slot.dataset.show = String(show);
    put(
        slot,
        show
            ? h(
                  "span",
                  { class: "tour-nudge" },
                  h("button", { class: "tour-nudge-go", onclick: () => openTour() }, "New here? Take the tour"),
                  h("button", { class: "tour-nudge-x", title: "Dismiss", "aria-label": "Dismiss the tour suggestion", onclick: () => (savePrefs({ guideSeen: true }), schedule(true)) }, "✕"),
              )
            : null,
    );
}
function openTour() {
    if (cc.tour) return;
    if (!prefs().guideSeen) savePrefs({ guideSeen: true });
    cc.tour = startCommandTour({
        hasPlan: () => !!cc.data?.state.plan,
        onClose: () => {
            cc.tour = null;
            schedule(true);
        },
    });
    schedule(true);
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

// ---------- progress popovers (todos, helpers) ----------
function buildProgPop(kind) {
    const args = [cc.data.progress, cc.data.state.plan];
    const menu = kind === "todos" ? todosPopover(...args, { onClose: closeMenu }) : helpersPopover(...args, { now: Date.now(), onClose: closeMenu });
    menu.dataset.pop = kind;
    return menu;
}
function toggleProgPop(kind, anchor) {
    if (cc.ui.menu?.dataset.pop === kind) return closeMenu();
    closeMenu();
    placeMenu(buildProgPop(kind), anchor);
}
/** An open popover follows the progress as it changes, keeping its place and scroll. */
function refreshProgPop() {
    const m = cc.ui.menu;
    const kind = m?.dataset.pop;
    if (!kind || !cc.data) return;
    const top = m.scrollTop;
    m.replaceChildren(...buildProgPop(kind).childNodes);
    m.scrollTop = top;
}

/**
 * The list's call to action: ask the orchestrator for a walkthrough of what's new since the latest review (or of
 * everything so far, before any review). The Command chat opens, so its reply and any questions show there.
 */
function walkNextButton(st, reviewed, latestId) {
    const last = latestId && st.walkthroughs.find((w) => w.id === latestId);
    const blocked = chatBlockedReason();
    const label = last ? "Walk me through what's new since my last review" : "Walk me through the work so far";
    const context = last
        ? `The user clicked "${label}" in the walkthrough list. Their latest reviewed walkthrough is "${last.title}" (id ${last.id}), which ended at ${last.pins.head.slice(0, 10)}. Make a new walkthrough with its own id: command_diff then command_walkthrough {op:"show"} from {ref:"reviewed"} to the latest done phase's checkpoint, or {ref:"live", frontId} for work still in progress. If nothing changed since, say so; if the range is unclear, ask here.`
        : `The user clicked "${label}" in the walkthrough list (nothing reviewed yet). Make a walkthrough with its own id: command_diff then command_walkthrough {op:"show"} from {ref:"base"} to the latest done phase's checkpoint, or {ref:"live", frontId} for work still in progress. If the range is unclear, ask here.`;
    return h(
        "div",
        { class: "wm-foot" },
        h(
            "button",
            {
                class: "wm-next",
                disabled: !!blocked,
                title: blocked ?? (last ? `Asks the orchestrator for a walkthrough from where “${last.title}” ended to now. The Command chat opens for its reply.` : "Asks the orchestrator for a walkthrough from the plan's base to now. The Command chat opens for its reply."),
                onclick: () => {
                    closeMenu();
                    if (svc.sendCommandChat?.(last ? "Walk me through what's new since my last review." : "Walk me through the work so far.", { context })) announce("Asked the orchestrator for a walkthrough");
                },
            },
            h("span", { class: "wm-next-t" }, label),
            last ? h("span", { class: "wm-next-s" }, `from the end of “${last.title}”`) : null,
        ),
    );
}

/** Every walkthrough of this work, newest first: open one, mark it reviewed (or not). */
function openWalkMenu(anchor, st) {
    closeMenu();
    const reviewed = prefs().reviewed ?? {};
    const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const latest = Object.entries(reviewed).sort((a, b) => b[1].at.localeCompare(a[1].at))[0]?.[0];
    const openIt = (w) => {
        closeMenu();
        savePrefs({ walkthroughPick: { id: w.id, seq: st.walkthroughView?.seq ?? 0 }, walkthroughDismissed: null });
        schedule(true);
    };
    const toggle = (w) => {
        const next = { ...(prefs().reviewed ?? {}) };
        if (next[w.id]) delete next[w.id];
        else next[w.id] = { at: new Date().toISOString(), head: w.pins.head };
        savePrefs({ reviewed: next });
        openWalkMenu(anchor, st);
    };
    const list = [...st.walkthroughs].reverse();
    const menu = h(
        "div",
        { class: "cc-menu walk-menu", role: "menu", "aria-label": "Walkthroughs" },
        h("div", { class: "cc-menu-h" }, "Walkthroughs", h("span", { class: "grow" }), h("span", { class: "wm-n" }, `${list.length}`)),
        list.map((w) => {
            const rv = reviewed[w.id];
            return h(
                "div",
                { class: `wm-row${rv ? " rv" : ""}` },
                h(
                    "button",
                    { role: "menuitem", class: "wm-open", title: `Open “${w.title}”`, onclick: () => openIt(w) },
                    h("span", { class: "wm-t" }, w.title),
                    h("span", { class: "wm-s" }, `${w.labels.from} → ${w.labels.to} · ${w.stops.length} stop${w.stops.length === 1 ? "" : "s"} · ${when(w.updatedAt)}`),
                ),
                h(
                    "button",
                    { class: "wm-rv", title: rv ? `Reviewed ${when(rv.at)}${w.id === latest ? " (the latest review: new walkthroughs can start from here)" : ""}. Click to unmark` : "Mark reviewed", "aria-pressed": String(!!rv), onclick: () => toggle(w) },
                    rv ? (w.id === latest ? "✓ Latest review" : "✓ Reviewed") : "Mark reviewed",
                ),
            );
        }),
        walkNextButton(st, reviewed, latest),
    );
    const r = anchor.getBoundingClientRect();
    const hr = cc.host.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - hr.left - 340, hr.width - 348))}px`;
    menu.style.top = `${r.bottom - hr.top + 6}px`;
    cc.host.querySelector(".cc").append(menu);
    cc.ui.menu = menu;
    menu.querySelector("button")?.focus();
}

function openPhaseMenu(p, anchor, st) {
    closeMenu();
    const items = [];
    if (p.suggestedView) items.push(["Apply suggested view", () => (applyView(p.suggestedView, { phaseId: p.id }), closeMenu())]);
    if (svc.addToCommandChat) items.push(["Ask about this phase", () => (closeMenu(), svc.addToCommandChat([phaseItem(p)]))]);
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
    if (e.key === "Escape" && cc.sel?.size) return cc.sel.clear();
    if (e.key === "Escape" && cc.walk?.open && !e.target.closest?.("#chat")) return cc.walk.close();
    if (e.key === "?" && !cc.tour && shortcut("tourKey")) {
        e.preventDefault();
        return openTour();
    }
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

// ---------- conversation: focus items, chat gating ----------
function pathItem(path) {
    const isDir = !!findNode(cc.tree, path)?.dir;
    return { key: `path:${path}`, kindLabel: isDir ? "dir" : "file", label: `${path || cc.data.repository}${isDir ? "/" : ""}`, cls: "pathc", item: { kind: "path", path, isDir } };
}
function frontItem(f) {
    return { key: `front:${f.id}`, label: f.label, cls: `frontc f${f.color + 1}`, dot: true, item: { kind: "front", frontId: f.id } };
}
function phaseItem(p) {
    return { key: `phase:${p.id}`, kindLabel: "phase", label: p.id.toUpperCase(), title: p.title, cls: "stopc", item: { kind: "phase", phaseId: p.id } };
}
function stopItem(w, stop, i) {
    return { key: `stop:${w.id}:${stop.id}`, kindLabel: "stop", label: String(i + 1), title: stop.title, cls: "stopc", item: { kind: "stop", walkthroughId: w.id, stopId: stop.id, revision: w.revision } };
}
function rangeItem(w, r) {
    const name = r.file.slice(r.file.lastIndexOf("/") + 1);
    const file = r.sourceFile ?? r.file;
    return { key: `range:${file}:${r.side}:${r.startLine}-${r.endLine}:${w.pins.head}`, kindLabel: r.side === "base" ? "before" : "lines", label: `${name}:${r.startLine}–${r.endLine}`, title: file, cls: "pathc", item: { kind: "range", file, startLine: r.startLine, endLine: r.endLine, pins: { base: w.pins.base, head: w.pins.head } } };
}

function chatBlockedReason() {
    if (!cc.data) return "Loading…";
    const l = cc.data.lease;
    // Nobody orchestrating yet (or the owner went stale): this panel's session is the one to talk to — it becomes the
    // orchestrator when it sets the plan. Only a live *other* owner blocks the chat.
    if (l && leaseLive() && !cc.data.isOwnerHere) return `The Command chat talks to the orchestrator (session ${l.sessionId.slice(0, 8)}). Open this doc in that session to chat with it.`;
    return null;
}
/** Ownership can change under an open chat (lease taken over, or went stale). */
function syncOwner() {
    const here = !!cc.data?.isOwnerHere && leaseLive();
    if (cc.data?.state.plan && cc.ui.initPending) cc.ui.initPending = 0; // the plan arrived
    if (here === cc.ownerHere) return;
    cc.ownerHere = here;
    svc.refreshCommandChatBlocked?.();
}

// ---------- walkthrough ↔ map ----------
function syncWalkthrough(st) {
    if (!cc.walk) return;
    const view = st.walkthroughView ?? null;
    // One the user opened from the list shows until the agent shows a newer one.
    const pick = prefs().walkthroughPick;
    const picked = pick && (!view || pick.seq >= view.seq) ? st.walkthroughs.find((x) => x.id === pick.id) : null;
    if (picked) {
        const at = prefs().walkthroughStop?.id === picked.id ? prefs().walkthroughStop.stopId : picked.stops[0].id;
        cc.walk.sync(picked, { id: picked.id, stopId: at, seq: -1 - pick.seq }); // its own seq: agent focus moves don't apply
    } else {
        const w = view ? st.walkthroughs.find((x) => x.id === view.id) : null;
        const d = prefs().walkthroughDismissed;
        const dismissed = !!(view && d && d.id === view.id && d.seq === view.seq);
        cc.walk.sync(dismissed ? null : w, dismissed ? null : view);
    }
    if (!cc.walk.open) cc.walkLink = null;
}

/** Entering a stop zooms the map to its files, badges every stop's files with its number, and pulses the stop's tile. */
function linkStop(w, stop) {
    const files = new Map();
    w.stops.forEach((s, j) => s.ranges.forEach((r) => files.has(r.file) || files.set(r.file, j + 1)));
    const own = [...new Set(stop.ranges.map((r) => r.file))];
    const focus = stop.focus ?? own[0];
    const dirs = [focus, ...own].filter((p) => cc.tree && findNode(cc.tree, p));
    let root = dirs.length ? commonDir(dirs.map((p) => (findNode(cc.tree, p)?.dir ? `${p}/x` : p))) : "";
    // Keep some surroundings: a tiny directory (a couple of files) reads better from its parent.
    if (root && (findNode(cc.tree, root)?.children.length ?? 0) < 4) root = root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "";
    cc.walkLink = { files, stopOn: focus, root, key: `${w.id}:${stop.id}:${w.revision}` };
    savePrefs({ walkthroughStop: { id: w.id, stopId: stop.id, revision: w.revision } });
    schedule(true);
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
    if (offCount > cc.announced.offPlan) announce(`${offCount} off-plan edit${offCount === 1 ? "" : "s"}`);
    cc.announced.offPlan = offCount;
}

export function refresh() {
    if (isMounted()) reloadAll();
}
