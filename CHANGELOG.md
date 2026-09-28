# Changelog

All notable changes to Marginal. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Write entries under **Unreleased** as you go; the **release** workflow (or `npm run release`) turns that section into the next version.

## [Unreleased]

### Changed

- **Phases are the unit of the Command center.** A phase is a deliverable (what it builds, and the files it touches) with a stage: planned, implementing, in review, blocked (with what it waits on) or complete. The right-hand rail lists phases, with what each delivers, what it has changed so far and its pace; click one to show only its files on the map. Fronts become plumbing: `command_plan set {worktree}` watches the checkout the phases are built in, which is all the usual case needs, and worktrees are listed only when there are several (parallel sessions, stacked PRs).
- `command_diff {phase:"p3"}` (and a walkthrough's `phase`) is what that phase delivered: from the phase before it, or the base, to its checkpoint, or its live work while in progress.
- The orchestrator's instructions lead with phases and one worktree, and say fronts are for parallel work or stacked PRs only. Re-planning fronts (`command_front {op:"plan"}`) replaces the set: planned fronts left out are dropped; working ones are kept and named in the result.
- **Pins moved out of the Command map's header**, which crowded it even with one: a pin button among the map's controls shows how many there are and opens a popover (like Settings) listing them, where hovering one outlines its tile, clicking finds it, × unpins it and Clear all unpins the rest; with none it explains how to pin. The header keeps the path, the colour legend and the view controls on one line, and a long repository name is always cut short (its tooltip has it whole).
- A suggested view pins at most 3 areas, and the orchestrator is told what pins are for: the active phase's files are highlighted already, so a view needs a root and maybe a monitor, not every file pinned.
- Edit batches are all or nothing: if any edit is invalid, none is saved (each edit still saves its own version when the batch applies). Applying a held Discuss suggestion is all or nothing too.
- `baseVersion` checks only what an edit relies on: an update or patch conflicts only with changes to the element's own fields (renaming its section no longer counts), a replace or remove with changes anywhere inside it (removing a flow node, also its edges), a move also with moves. Refusals name the first version that changed it, who made it and what changed.
- A `lines` patch's `expect` may be the whole range or just its first line; a code block's `text` is patched and read by line without naming the field; a `find` that misses says where the closest text is (or that only spacing differs).

### Added

- **Progress in the Command center, observed rather than reported.** The instrument strip shows what the orchestrator is doing now, its todos done / total and how many helper agents are running (the last two open popovers with the lists). Each phase card shows its todo count, its todo in progress and its running helpers, with an Other card for what matched no phase. Helper agents appear as lanes under the timeline, one bar per run (running, done, failed, cancelled): a background helper idling between runs gives its lane to others and comes back to it when resumed, at most four lanes are drawn (extra runs merge into `+n` blocks with a tooltip of what's in them), and runs longer than an hour show their last hour. All of it comes from the orchestrator's session: its intent events, its todo list and its helper agents. Nothing asks the agent to report progress; a todo whose id starts with a phase id (`p2-…`) counts for that phase, and otherwise for the phase in play when it was created.
- **Markdown export**: `export {path, heading?}` writes the doc (or one heading's part) to a .md file, and `read {format:"markdown"}` returns it: sections as nested headings, diagrams, call stacks and data lenses as text, code peeks with their code, and code links as repo paths. A header records the doc id and version, the repository and its base/head commits, and a sha256 of the body.
- **A `marginal` tool** that runs the canvas's actions without an open panel (everything but showing a doc), so reads, edits and exports keep working after the panel closes.

### Removed

- The orchestrator activity list at the top of the Command chat. What the orchestrator is doing, its todos and its helpers are now shown in the Command tab itself.

### Fixed

- Code blocks keep their line breaks (they rendered on one line).
- `changes` no longer reports elements whose content is unchanged but re-saved in a different key order.
- Headings inside a longer code fence are no longer taken for real headings (heading paths and the export read fences the way CommonMark does).
- The canvas opens with `null` input as well as `{}`.
- The `marginal` tool returns a failed action's message (it reported only "Tool execution failed").

## [0.6.0] - 2026-09-27

### Removed

- Replay on the Command timeline: scrubbing the histogram, its playhead and Live button, the phase menu's Replay items, and the replay time in Command chat focus. The histogram stays, read-only (hover a bar for its time and edit count); walkthroughs cover looking back.

### Added

- **Walkthroughs are kept.** The Command map's header lists every walkthrough of the work (up to 50, newest first, with its range, stops and time); open any of them again, and it stays open until the orchestrator shows a newer one. Reaching a walkthrough's last stop marks it **reviewed** (the list can mark or unmark by hand), and the orchestrator can start a new walkthrough where you left off: `from:{ref:"reviewed"}` is where the latest reviewed one ended, `from:{walkthrough:<id>}` where a given one did. `command_read {include:["walkthrough"]}` lists them with their reviewed times. The list ends with **Walk me through what's new since my last review** (or **the work so far**, before any review): one click asks the orchestrator for it, and the Command chat opens for its reply or any questions.
- **Message regions.** A chat message about part of a doc now tells Copilot exactly which parts, as refs ("m4.r1 = md-2 lines 5–6"; a diagram or other element by id). `edit {type:"region", ref, markdown}` rewrites exactly that text ("" removes it) without re-reading the block, finds it even when other lines moved, and is refused (nothing saved) if you changed that text since; the ref then follows its new text. `read {ref}` shows a region as it is now. Regions are kept with the doc, for the last 100 messages.
- **Heading paths.** Sections and the headings inside text are addressable by their titles: `read {heading:"Plan > Review findings"}` returns just what's under that heading (to the next heading of the same or higher level), and `edit {type:"under", heading, markdown, append?}` replaces or adds to it, keeping the heading (with `baseVersion`, refused only if that text changed). Paths can skip levels; ambiguous or unknown ones get the candidates' full paths. Any character may appear in a title: a path may also be an array of titles (exact), a string is tried every way its " > " / "›" could split (so a title like "Inputs > Outputs" is still found), and \\> keeps a literal ">". Only Markdown formatting is ignored when matching, so underscores and asterisks inside words (parse_input_file) stay part of the title. The agent's outline now lists the headings in each text block with their lines.
- **Clear** in the chat's bar tidies its view once you've moved on (for example, to the next walkthrough stop): the messages leave the screen but the conversation continues, and a "Show earlier messages" line brings them back. Only you clear it; nothing clears on its own, and a reply in progress or a suggestion awaiting Apply stays.
- **Patch edits** for the agent: `patch {targetId, ops}` changes part of a long block's text (`{find, replace}`, or `{lines:[from, to], text, expect?}` against `read {targetId, lines:true}`) instead of resending the whole block.
- **`baseVersion`** on any edit: it's refused, with nothing saved, if its target changed since that version (for example, you edited it in place), and the error says by whom. Edits to other parts of the doc still go through.
- **`changes {sinceVersion}`**: what changed since a version (each element added, removed, moved or modified, Markdown with a line diff, and whose version it was), so the agent needn't re-read the doc. When you edit prose in place, Copilot's next chat message now carries the diff itself when it's small.
- **`command_front {op:"advance"}`**: one call moves a stack up a layer (the phase done at its commit, the layer complete, the next layer registered on it in the same checkout, the next phase started), checked up front; if a later step fails, the result says what was already applied.
- **Symbol-anchored walkthrough ranges**: `{file, symbol:"nextDelay"}` (or `"Runner.run"`) resolves to that declaration's lines, with its leading comment. A miss lists what is declared there. The result's notes say what each symbol resolved to and flag ranges that show none of their file's changes, with the nearest changed lines.

### Changed

- The agent is steered to change part of a doc rather than resend it: the edit action's description leads with region / under / patch, the instructions' editing section opens with them, the Command protocol (which orchestrators read instead of the authoring guide) now covers editing docs, and an update that resends a long text to change a little of it gets a tip in its result naming the cheaper edit.
- The chat docked in a walkthrough or tour takes at most half of its column, so the stop list stays in view; its messages scroll.
- Friendlier schema: a child that is only Markdown may leave out `type` (anything else gets "missing type" with an example), `update` ignores an unchanged `id`/`type` in `changes`, and plan `expects` accept `{path}` / `{glob}` objects as well as strings.
- Your in-place prose saves follow their text when Copilot changed other lines of the same block meanwhile (a patch above them shifts line numbers); only text that itself changed is refused.
- The agent is told that right after an extension reload a canvas action can briefly fail with "provider … not connected", and to retry rather than reopen the canvas.
- A Command walkthrough now takes over the wall: it spans about two thirds of the width, with a roomier stop list, and the left keeps just the map (still zooming and badging each stop's files). The instruments, timeline, monitors, legend and view controls return when it closes.
- The Command map's header stays on one line. When it runs short of room it gives way in steps: pins fold into a "3 pinned" pill (a menu to find, unpin or clear them), the colour legend steps aside, the folders between the repo and the one shown fold into "…" (a menu of them), and the controls drop their longer words; only then do names end in an ellipsis (tooltips have them in full).
- Pins on the Command map are chips in the map's header instead of a line of names: hover one to outline its tile, click it to find it (the map zooms out if it's off screen, and the tile flashes), × unpins it, and **Clear all** unpins every one, including pins that came with a view.

## [0.5.0] - 2026-09-27

### Added

- **When Copilot is busy** (Settings): chat messages can interrupt Copilot's current turn instead of queueing behind it, so it reads them at its next step and can change course. On by default for the Command chat, whose orchestrator often stays mid-turn for a long time while it waits on helper agents; off by default for the doc chat, whose questions would otherwise land in whatever the main chat is doing. Before, every message waited for the current turn to finish.
- **Discuss / Edit** in the doc chat. A switch under the input, remembered for each doc, says whether Copilot may change the doc while it answers (Edit, as before) or should only answer (Discuss). Discuss is enforced by the canvas, not just asked for: while Copilot answers a Discuss message, its doc changes are refused, and edits it tries to make are checked and held as one suggestion under its reply, with **Apply** and **Dismiss**. Applying lands the edits like any Copilot edit (listed under the suggestion) and tells Copilot on your next message. Ctrl/⌘+Shift+Enter sends one message in the other mode without moving the switch; Discuss messages are marked as such.
- **Preview a suggestion in the doc.** Preview (beside Apply) shows the doc as it would be, marked like tracked changes: words added underlined in green, words removed struck through in red, replaced or removed paragraphs struck and new ones highlighted, new and removed blocks outlined, and changed diagram parts outlined. A bar above the doc counts the changes, steps between them, and offers Apply, Dismiss and Close (Esc). If the doc changes meanwhile, the preview follows it. Copilot is told the preview shows the change, so its reply says why rather than restating it.

### Fixed

- The Command tab's fronts list can be scrolled again: it no longer jumps back to the top while you scroll, as the work updates, or when the pointer rests on a front.

## [0.4.0] - 2026-09-27

### Added

- Stacked fronts. Layers of a PR stack are declared up front like any planned front (`stacksOn` names the layer below), and each layer's changes are measured from the layer below it rather than the plan base, so layer 2 no longer claims layer 1's files. Layers can each have a worktree, or take turns in one checkout: once a layer is complete, registering the next one there takes the worktree over and measures from the commit it finished on. The rail shows what each layer stacks on (and who took a worktree over). `register` also takes an explicit `base`.

### Changed

- The orchestrator is told to list every front the plan needs even when it can't have a worktree yet (such as a stacked layer whose base is still being written); a planned front needs none.
- A planned front in the rail can't be clicked to filter the map, since it has nothing there yet.

## [0.3.0] - 2026-09-27

### Added

- Fronts have stages: planned, implementing, review, blocked and complete. The orchestrator declares every front the plan needs up front (`command_front {op:"plan"}`), shown as planned until its worktree is registered; the rail lists fronts by stage and the header counts each. The old `active`/`done` names are still accepted and read.
- **Settings** (gear in the header). Each optional keyboard shortcut (Ctrl/⌘-J, arrow-key stepping, `?` for the Command tour, Markdown as you type) can be turned off. In a browser window you can pick a theme: System, Light, Dark, Windows 3.0, Windows 95, Vista, Retro-future (an '80s-film HUD) or 16-bit (Genesis-era retrowave). The retro themes dress the whole UI, and their **Effects** (boot screens, desktops such as the 95 wallpaper, glass, glow, scanlines, the retrowave horizon) can be switched off. Inside the Copilot app the app's theme always applies. Settings are saved with your Marginal data, so every panel and window shares them.
- Click a doc's title in the header to rename it (Enter saves, Esc cancels).
- **Edit prose in place.** A pencil under Comment and Copy (and **Edit** in the top bar for a Ctrl/Shift-click selection, contiguous or not) opens paragraphs, headings, list items and quotes for editing, outlined in green. The margin swaps to Save, Bold, Italic, Link and, set apart at the bottom, Discard; **Shift+Enter** saves, **Esc** cancels. Links take a URL, a `#heading` or a repo path (a code link). The live doc waits while you edit; a save is refused if Copilot changed the same text meanwhile. History shows your versions as yours, and Copilot's next chat message names the blocks you edited. Diagrams, code and tables aren't editable.

### Fixed

- Command-tab diff feeds no longer offer to open rows with nothing to show. Edits to files a front no longer changes (created then deleted, such as build output, or edited back) are hidden by default with a count to show them; binary files and rows whose diff comes back empty are labelled and can't be expanded.
- Comment (margin, top bar or selection button) always leaves the caret in the chat input, whether the chat was already open or not, so you can start typing right away.
- Switching themes no longer feels like the app hanging: the change is immediate (a brief crossfade), with no boot screen. The boot screen plays only when a window opens in a retro theme, and a click or key skips it.
- Theme wallpapers (the Windows 95 paper-cup pattern, the 16-bit retrowave horizon and grid) show even when the system asks for reduced motion; only their animation stops.

### Changed

- The header's title and subtitle fit the room they have: long titles end in an ellipsis, long branch names lose their middle (so both ends stay readable), and the tooltips show everything, including the full commit SHAs. On narrow panels the hint steps aside rather than running into the tabs.
- The header's hint slot says what's useful now: how to jump (Ctrl/⌘-J) and that hovering text offers comment, copy and edit while you're just reading, and Shift+Enter to send while you type in a chat.
- The editing tools stay beside an editing area on screen (the one you're typing in, else the nearest visible one), slide along tall ones, and fade out while none is in view.
- Editing converts Markdown as you type: `` `code` ``, `**bold**` and `*italic*` format when closed, and `- ` or `1. ` at the start of a line starts a list (Enter continues it, Enter on an empty item ends it, Backspace at its start undoes it).
- The margin icons and the editing tools line up with what they act on: centred on it when it's shorter than they are, level with its top otherwise.
- Copilot's live edits no longer scroll the page to where they happened. The changed part still flashes, the page keeps your place (even when text above you grows), and the doc chat lists the changes under the reply that made them: click one to go there, or to open a changed diagram step in Inspect.
- Contents follows the doc's real nesting instead of flattening everything below the top level into one list. A **Levels** control (1, 2, 3, All; remembered) sets how deep it opens, each group folds with its ▸ (Alt-click folds or opens everything inside), folded groups show how many entries they hold, and jumping with Ctrl/⌘-J opens the groups above the target. The card is capped at about 60% of the window height and scrolls.

## [0.2.0] - 2026-09-27

### Added

- Docs have a **Contents** card: sections, plus the diagrams, code peeks, callouts and headings inside them. It opens on its own when there's room beside the doc, minimizes to a pill, and closes; the header button brings it back.
- Tables have width controls: *Text width*, *Wide* or *Full width* from the width button in the margin, and draggable column borders (double-click to reset). Tables too wide for the reading column start wide. Choices are remembered per table in this browser.
- **Ctrl/⌘-J** opens a jump palette: type part of a section, diagram or heading name (or a kind, like "flow"), then Enter.

### Changed

- **Inspect** replaces the diagram Tour and Focus modes. Clicking a sequence step, flow node or call-stack frame (or the diagram's Inspect button) opens every step in the side panel with its explanation, code and notes, in sync with the diagram: clicking the diagram scrolls to a step, and scrolling or ↑/↓ moves the highlight. With room to spare the side panel moves the doc over instead of covering it; otherwise the inspected diagram shrinks to the uncovered part and scrolls sideways to the current step. Step text has the doc's comment/copy margin controls and Ctrl/Shift-click. The side panel no longer covers the header.
- The doc chat keeps its conversation while it's open. Commenting on something else refocuses the next message instead of starting a new chat, and each change of focus is labelled in the history (click it to scroll back). Ctrl/Cmd-click extends what the chat is about.

### Fixed

- A scrollbar no longer stays behind when you drag or resize the chat while it's showing.
- Illustrative code in notes, diagram steps and peeks keeps its line breaks and indentation instead of running together on one line.

### Docs

- Animated demos in the README for commenting and chat, inspecting diagrams, and the Command center, recorded with `tools/demos/record.mjs`.

## [0.1.1] - 2026-09-26

First public release.

### Docs
- Copilot draws RFC-style docs from prose, sequence and flow diagrams, call-stack diffs, database lenses, code peeks and trace quotes. Every code reference is checked when it's written.
- You can comment on or copy any paragraph, list item, diagram or code range from the margin, and multi-select with Ctrl/Shift-click. Code views have GitHub-style gutter line selection.
- A side chat streams replies from your Copilot session. It keeps what you're commenting on highlighted, labels the location, and can be minimized to a pill without losing the conversation.
- Tour and Focus modes walk a diagram step by step beside its code. A docked chat keeps one conversation for the whole tour. Copilot can add notes and examples to a step on request, and the tour updates in place.
- Diff, Commits and History tabs, file lenses, and a scratchpad for quick sketches.
- Open the current doc in your browser from the header.

### Command center
- A live territory map of the repository for multi-worktree implementations. Edits are attributed to fronts by watching git, and off-plan edits are hatched.
- Fronts rail, checkpoint timeline with scrub replay, views and follow, pins, and diff-feed/files monitors.
- Checkpoint snapshots, `command_diff`, and walkthroughs that Copilot revises in place.
- Command chat with focus chips and an activity lane; it docks under walkthroughs.
- A guided tour of the tab, and **Initialize command center** for an empty plan.

### Install
- Ships as a Copilot plugin with its own marketplace: `copilot plugin marketplace add notthatbreezy/marginal`, then `copilot plugin install marginal@marginal`.

