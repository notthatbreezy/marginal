// Checkpoint walkthrough pop-up: a non-modal, right-anchored stepper over the Command map.
// The agent owns the content (command_walkthrough show/edit); this module renders it, keeps the user on the same stop
// across revisions, and reports stop changes so the map can zoom, badge and pulse the stop's files.
import { h, markdown, svc } from "../core.js";
import { createStepper } from "../stepper.js";

const REVISING_MS = 60_000;
const short = (sha) => (sha ?? "").slice(0, 7);

/**
 * o: { mount, onStop(w, stop, i), onClose(w), onCopy(w, stop, i), onComment(w, stop, i), onAsk(w, stop, i), frontOf(path) → front|null }
 */
export function createWalkthrough(o) {
    let stepper = null;
    let cur = null; // the walkthrough being shown
    let seenSeq = null;
    let seenRev = null;
    let revisingAt = 0;
    let serverClose = false; // closes driven by state (agent closed it / another walkthrough) are not user dismissals
    const chipHost = h("div", { class: "walk-status" });

    function statusChips() {
        const revising = revisingAt && Date.now() - revisingAt < REVISING_MS;
        const updated = cur?.lastEdit && Date.now() - Date.parse(cur.lastEdit.at) < 20_000;
        return [
            revising ? h("span", { class: "revising", role: "status" }, h("span", { class: "pulse" }), "Agent is revising the walkthrough…") : null,
            !revising && updated ? h("span", { class: "updated", role: "status" }, h("i"), "Updated just now") : null,
        ];
    }
    const paintStatus = () => chipHost.replaceChildren(...statusChips().filter(Boolean));

    function renderStage(stops) {
        return [
            h("div", { class: "walk-title" }, cur.title),
            h("div", { class: "walk-range" }, h("span", {}, cur.labels.from), h("span", { class: "sha" }, short(cur.pins.base)), "→", h("span", {}, cur.labels.to), h("span", { class: "sha" }, short(cur.pins.head))),
            h(
                "ol",
                { class: "rail" },
                stops.map((s, i) =>
                    h(
                        "li",
                        { "data-i": String(i), class: cur.lastEdit?.inserted?.includes(s.id) && Date.now() - Date.parse(cur.lastEdit.at) < 5000 ? "inserted" : "" },
                        h("span", { class: "dot" }, String(i + 1)),
                        h("div", { class: "rail-body" }, h("div", { class: "lbl" }, s.title, s.category ? [h("br"), h("span", { class: `cat ${s.category}` }, s.category)] : null)),
                    ),
                ),
            ),
        ];
    }

    function renderStop(stop, i) {
        const files = [...new Set(stop.ranges.map((r) => r.file))];
        const fronts = [...new Map(files.map((f) => o.frontOf?.(f)).filter(Boolean).map((f) => [f.id, f])).values()];
        const changed = cur.lastEdit?.changed?.includes(stop.id) && Date.now() - Date.parse(cur.lastEdit.at) < 5000;
        return [
            h("h2", { class: `tour-h${changed ? " revised" : ""}` }, stop.title),
            h(
                "div",
                { class: "walk-meta" },
                stop.category ? h("span", { class: `cat ${stop.category}` }, stop.category) : null,
                files.map((f) => h("span", { class: "path" }, f)),
                fronts.length ? h("span", { "aria-hidden": "true" }, "·") : null,
                fronts.map((f) => h("span", { class: `wf f${f.color + 1}` }, h("span", { class: "fdot" }), f.label)),
            ),
            h("div", { class: "walk-text md", html: markdown(stop.explanation) }),
            stop.ranges.map((r) => svc.codeView({ file: r.sourceFile ?? r.file, side: r.side, startLine: r.startLine, endLine: r.endLine, pins: cur.pins }, { diff: true, context: 3 })),
        ];
    }

    function open(w, stopId) {
        cur = w;
        stepper = createStepper({
            mount: o.mount,
            id: "walkthrough",
            modal: false,
            label: `Walkthrough: ${w.title}`,
            stops: w.stops,
            headerExtra: chipHost,
            renderStage,
            renderStop: (s, i) => renderStop(s, i),
            onStop: (i, s) => o.onStop?.(cur, s, i),
            onClose: () => {
                const was = cur;
                stepper = null;
                cur = null;
                o.onClose?.(was, { user: !serverClose });
                serverClose = false;
            },
            actions: [
                { label: "Copy", title: "Copy this stop as Markdown", onClick: (i, s) => o.onCopy?.(cur, s, i) },
                { label: "Comment", title: "Comment on this stop in the Command chat", onClick: (i, s) => o.onComment?.(cur, s, i) },
                { label: "Ask about this stop", title: "Ask the orchestrator about this stop (adds it and its code to the chat focus)", onClick: (i, s) => o.onAsk?.(cur, s, i) },
            ],
        });
        stepper.root.classList.add("walk");
        const k = w.stops.findIndex((s) => s.id === stopId);
        if (k > 0) stepper.go(k, { animate: false });
        paintStatus();
    }

    return {
        get open() {
            return !!stepper;
        },
        get current() {
            return cur;
        },
        get stop() {
            return stepper ? stepper.stops[stepper.index] : null;
        },
        /** Reconcile with server state: w = the walkthrough in view (or null), view = { id, stopId, seq }. */
        sync(w, view) {
            if (!w || !view) {
                if (stepper) (serverClose = true), stepper.close();
                return;
            }
            if (stepper && cur.id !== w.id) (serverClose = true), stepper.close();
            if (!stepper) {
                open(w, view.stopId);
                seenSeq = view.seq;
                seenRev = w.revision;
                return;
            }
            const jump = view.seq !== seenSeq ? view.stopId : undefined; // focus_stop (or a fresh show) moves the user
            if (w.revision !== seenRev || jump) {
                cur = w;
                revisingAt = 0;
                stepper.update(w.stops, { focusId: jump });
            }
            seenSeq = view.seq;
            seenRev = w.revision;
            paintStatus();
        },
        revising(active) {
            revisingAt = active ? Date.now() : 0;
            paintStatus();
        },
        tick: paintStatus,
        close() {
            stepper?.close();
        },
        destroy() {
            if (stepper) {
                const s = stepper;
                stepper = null;
                cur = null;
                s.root.remove();
            }
        },
    };
}

/** Markdown for Copy. */
export function stopMarkdown(w, stop, i) {
    const refs = stop.ranges.map((r) => `- \`${r.sourceFile ?? r.file}\` ${r.side === "base" ? "(before) " : ""}L${r.startLine}–${r.endLine}`).join("\n");
    return `### ${i + 1}. ${stop.title}${stop.category ? ` _(${stop.category})_` : ""}\n\n${stop.explanation}\n\n${refs}\n\n_${w.title}: ${w.labels.from} ${short(w.pins.base)} → ${w.labels.to} ${short(w.pins.head)}_`;
}
