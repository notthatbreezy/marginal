# Changelog

All notable changes to Marginal. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Write entries under **Unreleased** as you go; the **release** workflow (or `npm run release`) turns that section into the next version.

## [Unreleased]

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

