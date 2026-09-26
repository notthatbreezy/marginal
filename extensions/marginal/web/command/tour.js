// The Command center's guided tour: what each part of the mission wall does and how to drive it.
// Steps adapt to what's on screen (no off-plan chip → no off-plan step; walkthrough present → its step appears).
import { h } from "../core.js";
import { kbd, startGuide } from "../guide.js";

const isAttrs = (x) => x && typeof x === "object" && !(x instanceof Node) && !Array.isArray(x);
const p = (...kids) => (isAttrs(kids[0]) ? h("p", kids[0], ...kids.slice(1)) : h("p", {}, ...kids));
const ul = (...items) => h("ul", {}, items.map((x) => h("li", {}, ...[x].flat())));

/** o: { hasPlan(): boolean, onClose(completed) } */
export function startCommandTour(o = {}) {
    const plan = () => o.hasPlan?.() !== false;
    return startGuide(
        [
            {
                id: "welcome",
                title: "The Command center",
                body: () => [
                    p("A live mission wall for a multi-step implementation. Your orchestrating Copilot session sets a plan of checkpoints, registers the worktrees doing the work as ", h("b", {}, "fronts"), ", and this tab shows where edits are landing as they happen."),
                    p({ class: "guide-muted" }, "About a minute. Use ", kbd("→"), " and ", kbd("←"), " to move, ", kbd("Esc"), " to stop."),
                ],
            },
            { id: "init", when: () => !plan(), target: ".cc .cc-init", title: "Start here", body: () => p("Nothing is being tracked yet. ", h("b", {}, "Initialize command center"), " asks this panel's Copilot session to read the doc and the branch, set the plan and register its worktrees. Add a goal to steer it.") },
            {
                id: "strip",
                target: ".cc .strip",
                placement: "bottom",
                title: "Instruments",
                body: () => [
                    p("The lamp tells you what the orchestrator is doing: ", h("b", {}, "Working"), ", ", h("b", {}, "Waiting on you"), " (with its question) or ", h("b", {}, "Complete"), ". It goes grey when the orchestrator is offline."),
                    p("Churn is lines added plus removed per minute. The window scales with session age; pick one to override it."),
                ],
            },
            { id: "offplan", when: plan, target: ".cc button.offplan:not([hidden])", placement: "bottom", title: "Off-plan edits", body: () => p("Files a front touched outside the checkpoints it's working on get a yellow hatch. Click the chip to show only those; click again for everything.") },
            {
                id: "map",
                when: plan,
                target: ".cc .stage",
                title: "The territory map",
                body: () => [
                    p("Every file in the repository, sized by lines. Changed files take their front's colour and warm up with churn; a ring pings when one changes. Dashed outlines are the plan's footprint, blue is the active checkpoint."),
                    ul(["Hover a tile for who changed it, how much and when"], ["Double-click a folder to zoom in; ", kbd("⌫"), " zooms out"], [kbd("P"), " over a tile pins it (drawn 3× larger); ", kbd("M"), " opens a monitor on its folder"], ["Big changed files list their changed functions"]),
                ],
            },
            { id: "crumbs", when: plan, target: ".cc .crumbs", placement: "bottom", title: "Where you are", body: () => p("Breadcrumbs zoom back out. ", h("b", {}, "auto"), " means the zoom follows the plan and live edits; once you zoom yourself, ", h("b", {}, "↺ auto"), " hands it back.") },
            {
                id: "views",
                when: plan,
                target: ".cc .view-ctl",
                placement: "bottom",
                title: "Views and follow",
                body: () => [
                    p("A view is a saved zoom, pins and monitors. The orchestrator can suggest one per checkpoint (✦); with follow on ", h("span", { class: "guide-ic" }, "◎"), ", it applies as each checkpoint starts."),
                    p("Change the layout and follow holds off for that checkpoint; ", h("b", {}, "Return to suggested"), " brings it back, ", h("b", {}, "Save view"), " keeps yours."),
                ],
            },
            { id: "dock", when: plan, target: ".cc .dock:not([hidden])", placement: "top", title: "Monitors", body: () => p("A monitor follows one folder: a feed of edits as they land (click a row for the file's current diff) or a table of every changed file. Close it with ✕.") },
            {
                id: "fronts",
                when: plan,
                target: ".cc .rail-fronts",
                placement: "left",
                title: "Fronts",
                body: () => [p("One card per worktree: where it is in the plan, what it has changed, its recent pace, and anything it touched off-plan. A blocked front shows why."), ul(["Hover a card to preview its files on the map"], ["Click it to show only that front; click again for all"], ["The chat bubble adds the front to the Command chat"])],
            },
            {
                id: "timeline",
                when: plan,
                target: ".cc .timeline .track",
                placement: "top",
                title: "Checkpoints",
                body: () => p("The plan's phases in order: ✓ done, blue active, grey still to come. Click one to apply its view, replay from its first edit or completion, or ask the orchestrator about it."),
            },
            {
                id: "scrub",
                when: plan,
                target: ".cc .hist-wrap",
                placement: "top",
                title: "Replay",
                body: () => [p("Edits over time, stacked by front. Drag or click here to see the map as it was at that moment; ", kbd("←"), " ", kbd("→"), " step, ", kbd("End"), " returns."), p("While replaying the map is outlined in yellow; ", h("b", {}, "◀ Live"), " comes back.")],
            },
            {
                id: "chat",
                target: "#chat-fab:not([hidden])",
                placement: "left",
                title: "Talk to the orchestrator",
                body: () => [
                    p("The Command chat goes to the session running the plan and remembers the conversation when you close it."),
                    ul(["Point at things first: the ", h("b", {}, "+"), " on a hovered tile, a front's chat bubble, or a checkpoint's menu adds them as chips"], ["Ctrl-click tiles to select several (Shift-click for a range), then ", h("b", {}, "Add to chat"), " in the header"], ["Ask “walk me through the last checkpoint” for a guided walkthrough of what changed"]),
                ],
            },
            { id: "walk", target: ".cc .walk-reopen", placement: "bottom", title: "Walkthroughs", body: () => p("When the orchestrator explains a change, it opens as a walkthrough beside the map: one stop per idea, with the diff, and the map zooming to each stop's files. This button brings back one you closed.") },
            {
                id: "done",
                title: "That's the tour",
                body: () => [
                    h("div", { class: "guide-keys" }, [
                        [kbd("P"), "pin the hovered tile"],
                        [kbd("M"), "monitor its folder"],
                        [kbd("⌫"), "zoom out"],
                        [[kbd("Ctrl"), " click"], "select tiles"],
                        [kbd("Esc"), "clear, close"],
                        [kbd("?"), "this tour"],
                    ].map(([k, d]) => [h("span", { class: "k" }, k), h("span", {}, d)])),
                    p({ class: "guide-muted" }, "Run it again any time from ", h("b", {}, "?"), " in the map header, or press ", kbd("?"), "."),
                ],
            },
        ],
        { label: "Command center tour", onClose: o.onClose },
    );
}
