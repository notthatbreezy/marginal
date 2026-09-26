# Changelog

All notable changes to Marginal. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Write entries under **Unreleased** as you go; `npm run release` turns that section into the next version.

## [Unreleased]

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