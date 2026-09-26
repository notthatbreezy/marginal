// Agent-facing guidance. Adapted from devdotfast/whiteboard's instructions (MIT) for this canvas's actions.
// Portions adapted from devdotfast/whiteboard (MIT, (c) 2026 dev.fast); see THIRD-PARTY-NOTICES.txt.

const common = `All calls are invoke_canvas_action on an open "marginal" canvas instance. documentId defaults to whatever that panel is showing.
Sources: {file, side?: "head"|"base" (default head), startLine, endLine?, pins?}. file is repository-relative with forward slashes. Every range is verified against the pinned commit before saving, so read the code first (read_file / diff) and cite verified line numbers.
Markdown links to code: [label](review-source:head/src/file.ts#L10-L24) — use base/ for old code. External links must be https://.`;

const blocks = `**Block types** (insert via edit {type:"insert", content, parentId?, afterId?, beforeId?})
- markdown {markdown, pins?} — prose. Link code inline with review-source: links.
- section {title, defaultCollapsed?, children[]} and callout {title?, tone: info|warning|danger|success, children[]} — containers. Insert children with parentId.
- code {language, text, caption?} — illustrative code that is NOT in the repo (proposed APIs, pseudocode).
- code_peek {source, caption?, diff?} — a verified slice of real code. diff:true shows the base→head change around the range.
- sequence {title, actors: {key: label}, steps[]} — who calls whom over time. step {type:"step", from, to, label, style: call|return|async, source? | code?{language,text}, explanation?}. Give steps a one- or two-sentence explanation next to their source: the diagram's Tour button walks the steps one at a time and shows the explanation above the code.
- flow_diagram {title, description?, direction?: right|down, nodes[], edges[]} — branches, retries, state machines. node {type:"flow_node", key, label, description?, kind?: process|decision|terminal, attachments?: [{label, sources[]}]}; edge {type:"flow_edge", from, to, label?, style?: solid|dashed}. Nodes with a description or attachments become stops in the diagram's Tour.
- call_stack_diff {title, base: frames[], head: frames[]} — old vs new path through a user flow. frame {key?, parentKey?, source, callSite?, label?, via?: {kind: call|queue|callback|rpc, reason}}. parentKey names an earlier frame on the same side; the same key on both sides aligns a frame across base/head. Base-column sources default to side "base".
- database_lens {title, actors: {key: label}, stores: {key: {label, storage: relational|document, collections: {key: {label, key?, fields: {name: {label, dataType, nullable?, primaryKey?, references?: {store, collection, field}, example?, fields?}}}}}}, useCases: [{label, summary?, operations: [{kind: read|write, store, collection, field?, actor, label, detail?, source}]}]} — schema changes and who reads/writes them.
- trace_quote {text, role?: user|assistant|tool, attribution?} — quote a requirement or decision from the conversation, verbatim.
- image {url (https or data:image/...;base64), alt, caption?}
- divider {}

**Editing**
- edit accepts {edit} or {edits: [...]}; each edit is saved as its own version and animates live on the canvas.
- Draw a diagram whole in one insert. Add to an existing diagram by inserting a unit (step / flow_node / flow_edge) with parentId = the diagram id. A new flow_node may carry link: {from|to: existingKey, label?, style?} to add its edge in the same edit.
- update {targetId, changes} patches fields (null removes an optional field). Child collections change through insert/move/remove, or replace the whole block.
- move {targetId, parentId?, afterId?|beforeId?}; remove {targetId}; replace {targetId, content}.
- Results return targetId and first-level children ids so you can keep addressing new parts without re-reading.`;

export const instructions = {
    authoring: `You are writing an interactive, RFC-style doc that a staff engineer will read to understand a change.

${common}

**Flow** — do these first steps without extra detours:
1. register_repository {path} → repositoryId.
2. create {title, target: {repositoryId, base, head}} (base/head can be refs such as "origin/main" and "HEAD"; they resolve to the merge-base and head commits), or create {pullRequestUrl, repositoryId}. The panel switches to the new doc.
3. activity {action:"begin", focus:"Reading the diff"}.
4. diff {format:"files"}, then diff {format:"patch", paths:[...]} for the files that matter.
5. Immediately put down a first pass of the what/why section, then keep going.
6. Optionally group changed files with lens {op:"insert", title, paths} so the Diff tab reads in a sensible order (tests, docs, generated files and config first, then implementation split by design area). Aim to leave nothing uncategorized.

**Structure** — top-level sections, in order (omit any that don't earn their place):
- What / why: a succinct description of the change and, if you know it, why it was made.
- Requirements: the user's own words, as short bullets (trace_quote works well). Omit if you don't have them.
- Design: components, data and control flow — not functions. Pick the single diagram that best shows the shape: sequence (participants over time), flow_diagram (branches, retries, states) or database_lens (schema / data access). For contract changes show the key types as code_peek. Include key decisions, tradeoffs and alternatives you have evidence for.
- Implementation: how the code delivers the design, walked in reading order from the entry point. call_stack_diff for old vs new paths rooted at the user/agent entry point (include unchanged frames along the way); code_peek for the few spots that carry the mechanism or an invariant; link everything else inline.

**Guidelines**
- Write incrementally — the user watches the canvas update live. Show visible progress every few seconds and renew activity with a new focus as you move between areas.
- Keep it short for small changes.
- Whenever prose or a diagram node describes real code, attach or link it.
- Before finishing, read {full:true} and fix contradictions or unverified claims, then activity {action:"end"}.

**Updating an existing doc**: set_target to the new commits (it reports sources that no longer resolve), read the diff since the old head, and update the affected blocks.

${blocks}`,

    scratchpad: `The scratchpad (documentId "scratchpad") is a single always-present doc with no target — use it to sketch an explanation the way you would on a real whiteboard: a short paragraph, a sequence or flow diagram, a call tree, a code peek.

${common}

**When**: the user asks to be shown how something works, wants a picture of a flow / call path / data shape, is thinking out loud, or the explanation spans several files or repos (anything you'd otherwise draw as ASCII art). Answer in chat when a sentence does it. Don't review a change here — create a doc instead.

**How**
1. Open the canvas with input {documentId:"scratchpad"} (or show {documentId:"scratchpad"} on an open panel).
2. The scratchpad has no pins, so every source reference carries its own: register_repository, then resolve_pins {repositoryId, head:"HEAD"} and put pins {repositoryId, head} on each code_peek source, step source, node attachment source, frame source and database operation source (add base only when comparing two commits). Put the same pins on markdown blocks that use review-source: links.
3. Read what you cite with read_file {pins, file, startLine, endLine} or list_tree.
4. activity {action:"begin", documentId:"scratchpad"}, then insert blocks. With no placement, inserts go to the TOP of the pad (newest first) — a multi-block thought reads top-down only if you insert it bottom-up, or chain each block with afterId of the previous one.
5. In chat, say in one line what you drew; don't repeat the diagram.

Keep it a log, not a document: newest thought on top, no sections or status markers unless asked. To clear, remove blocks.

${blocks}`,

    blocks,

    "file-lenses": `Group a doc's changed files into file lenses for the Diff tab.
1. activity {action:"begin", scope:"lenses"}.
2. diff {format:"files"} for the overview.
3. First lens away non-implementation changes: tests, docs, generated files and lockfiles, config and build, fixtures and snapshots, pure renames, formatting-only changes.
4. Split the remaining implementation files by the part of the design each serves (data model, API, UI surface…) in reading order. Keep each lens readable in one sitting.
5. lens {op:"insert", title, paths:[files or "dir/" prefixes], collapsed?} — each response lists what is still uncategorized. Finish with nothing uncategorized, then activity {action:"end", scope:"lenses"}.`,

    command: `**Command center protocol.** The Command tab of a doc with a repository target is a live mission wall for a multi-step implementation: a territory map of the repo lights up as the worktrees you (and your child sessions) edit change. When implementing a multi-step plan:
1. command_plan {op:"set", plan:{id, title, base?, phases:[{id, title, expects:[paths, "dir/" or globs], steps?:[{id, title, expects}], suggestedView?}]}} once. Prefer directories and globs over exhaustive file lists. This claims the doc's Command lease for YOUR session: only this session may change Command state afterwards, and the Command chat talks to it.
2. command_front {op:"register", id, label, worktree:<absolute path>} once per worktree that gets edited (each child session's worktree, plus your own checkout if you edit directly). One worktree = one front.
3. On each transition: command_plan {op:"phase", phaseId, status:"active", frontIds} when a checkpoint starts, and status:"done" when it's reached — pass commit:<sha> if you committed there; otherwise the canvas snapshots the worktree into a hidden checkpoint commit (your branch, HEAD and index are never touched). op:"step" {stepId, status, frontId} when cheap.
4. command_front {op:"status", id, status:"blocked"|"done", note?} when a front blocks or finishes.
5. command_view {op:"set", phaseId, view:{id, title, root?, pins?, monitors?}} to suggest how the map should look during a phase (applied automatically while the user follows).
6. When the user asks for a walkthrough ("walk me through P1→P2"): command_diff {from:{phaseId:"p1"}, to:{phaseId:"p2"}} (or {ref:"base"} / {ref:"live", frontId}), read what you cite, then command_walkthrough {op:"show", walkthrough:{id, title, from, to, stops:[{id, title, explanation, category?, ranges:[{file, side?, startLine, endLine}], focus?}]}} — one narrative beat per stop, ranges only from that diff. For follow-up questions about a stop, prefer command_walkthrough {op:"edit", id, baseRevision, edits:[{op:"update_stop"|"insert_stop"|"remove_stop"|"focus_stop", …}]} over a new walkthrough.
7. Command chat messages carry a Focus JSON block (paths, fronts, phases, stops, code ranges the user pointed at). command_read {include:["focus","walkthrough"]} returns the same plus the stop on screen.
8. Every command_* action returns {ok:false, issues:[{path, code, message, hint}]} on invalid input and changes nothing. Read the issues, fix everything, resend the whole request. Never partially retry.
You never report individual edits — the canvas observes the worktrees directly. Mission status comes from your session's events; command_status {status} is only a fallback.`,
};

export function getInstructions(topic = "authoring") {
    const text = instructions[topic];
    if (!text) return `Unknown topic ${topic}. Topics: ${Object.keys(instructions).join(", ")}`;
    return text;
}
