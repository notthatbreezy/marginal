# Marginal

**Code-linked docs and a live Command center for GitHub Copilot.**

Marginal is a canvas extension for the [GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions). Copilot draws structured, reviewable explanations of your code as RFC-style **docs**: prose with sequence and flow diagrams, call-stack diffs, database schema views and verified code peeks. You can comment on any paragraph, diagram or line range in the margin, and the feedback goes straight back to the agent. When Copilot implements a multi-step plan, a doc's **Command** tab becomes a live mission wall: the plan's phases, a territory map of the repository that lights up as files change, and what the orchestrator and its helper agents are doing right now.

> **Status: alpha.** It depends on the Copilot SDK's canvas extension surface, which is marked **experimental** and may change between Copilot releases.

![A Marginal doc: prose, a sequence diagram and a guided tour](docs/images/doc.png)

## What you get

### Docs

- **Blocks the agent can draw:** Markdown, sections, callouts, code, `code_peek` (verified slices of real files at pinned commits), sequence diagrams, flow diagrams, call-stack diffs, database schema views ("data lenses": which code reads and writes which tables and fields), trace quotes and images. Blocks are validated at write time, so every file reference resolves.
- **Inspect diagrams:** click any step of a sequence diagram, flow diagram or call-stack diff (or its **Inspect** button) and every step opens in a side panel with its explanation, code and notes. When there's room the doc moves over, so the whole diagram stays visible; on a narrow window the panel covers the doc and the diagram scrolls sideways instead. The two stay in sync: click the diagram to jump to a step, scroll the steps (or press ↑/↓) and the diagram highlights where you are. Step text has the same margin controls as the doc. Ask "can you show an example of this interface?" and Copilot adds it to that step as **notes and examples**, which appear in place.
- **Comment in the margin:** hover a paragraph, list item, diagram or code range to get margin controls for *Comment* and *Copy*. Ctrl/Cmd-click or Shift-click selects several at once. Code views support GitHub-style gutter line selection.
- **Edit prose yourself:** the pencil under Comment and Copy (or **Edit** in the top bar for a Ctrl/Shift-click selection) makes paragraphs, headings, list items and quotes editable in place. Bold, italic and links (URLs, `#headings`, or a file path such as `src/app.ts#L10-L20` for a code link) sit in the margin; Markdown converts as you type (`` `code` ``, `**bold**`, `*italic*`, and `- ` or `1. ` at the start of a line for lists). **Shift+Enter** saves and **Esc** cancels. Diagrams, code and tables stay Copilot's. Saves are refused, never merged, if Copilot changed the same text meanwhile; History marks your versions, and Copilot is told what you changed.
- **Side chat:** a small, draggable chat whose replies stream from your Copilot session. When Copilot changes the doc while answering, the page stays where you're reading; the changes are listed under its reply, and a click takes you to each one. It keeps one conversation from when you open it until you close it: comment on something else and the next message is about that instead, labelled in the history so you can click back to it. Ctrl/Cmd-click adds to what the chat is about. Minimize it to a pill to keep reading.
- **Discuss or Edit:** a switch under the chat input (remembered for each doc) says whether Copilot may change the doc while it answers. In **Discuss** it answers only; the canvas refuses its doc changes, and any edit it would make waits under the reply as a suggestion you can **Preview** in the doc (marked like tracked changes), **Apply** or **Dismiss**. Ctrl/⌘+Shift+Enter sends one message in the other mode.
- **Table width:** tables that don't fit the reading column go wide on their own. The width button in a table's margin switches between *Text width*, *Wide* and *Full width*, and you can drag column borders (double-click one to reset). Your choices are remembered per table.
- **Find your way around:** a **Contents** card (top left) shows the doc's outline as a tree: sections, and the diagrams, code and headings inside them. Choose how many levels to show (1, 2, 3 or All), fold or unfold any group with its ▸ (Alt-click for everything inside), and the list scrolls within a card no taller than about 60% of the window. Minimize it to a pill or close it, and reopen it from the header. Press **Ctrl/⌘-J** to jump anywhere by typing part of a name.
- **Diff, Commits and History tabs** for the change the doc explains. Copilot can organize the Diff tab into **file groups**, collapsible sections such as "Data model", "API" and "Tests & config" in reading order, so a large change reads by concern instead of alphabetically.
- **Scratchpad:** an always-present doc for quick sketches that aren't tied to a branch.
- **Settings** (the gear in the header): turn optional keyboard shortcuts off one by one, and, in a browser window, pick a theme: System, Light, Dark, Windows 3.0, Windows 95, Vista, a retro-future HUD, or 16-bit retrowave, each with its effects on or off. Settings are shared by every panel and window. Under **When Copilot is busy**, choose whether the Command chat and the doc chat interrupt Copilot's current turn (it reads the message at its next step) or wait until it finishes.
- **Open in your browser:** the globe in the header opens the current doc and tab in your default browser, with room to spread out. The window stays live while the Copilot session that opened it is running, and it follows your OS light/dark setting.

**Select, comment, chat.** Ctrl-click several paragraphs, comment on them together, and read the streamed reply without losing your place. Minimize the chat to keep reading; code links open the exact lines.

![Selecting two list items, commenting, a streamed reply, minimizing the chat and opening a code link](docs/images/demo-docs-comment.webp)

**Inspect a diagram, and ask for more.** Click a step and the steps open beside the diagram, in sync as you scroll or step through. Comment on a step and ask for an example, and Copilot adds it to the step.

![Inspecting a sequence diagram: the steps open beside it, scrolling and arrow keys move the highlight, and a requested example is added to a step](docs/images/demo-docs-inspect.webp)

| Inspecting a sequence diagram | Inspecting a call-stack diff |
|---|---|
| ![Inspecting a sequence diagram](docs/images/inspect-sequence.png) | ![Inspecting a call-stack diff](docs/images/inspect-call-stack.png) |

### Command center

![The Command center](docs/images/command-center.png)

- **Phases:** the plan's deliverables, each with its stage (planned, implementing, in review, blocked with a reason, complete), what it builds, what it has changed so far and its recent pace. Click one to show only its files on the map. The orchestrator builds the phases in one checkout, which the canvas watches; with several at once (parallel sessions, stacked PRs) they're listed too, as Worktrees.
- **Progress, observed:** the instrument strip shows what the orchestrator is doing now, its todos done / total and how many helper agents are running; click either count for the list. Each phase card shows its todos, the one it's on and its running helpers, and an **Other** card collects todos that match no phase. All of it comes from the session's own events and todo list: the orchestrator never reports progress.
- **Territory map:** every file in the repository, sized by lines of code. Changed files are coloured and warm with churn, and a ring pings on each change. Dashed outlines show the plan's footprint and blue marks the active phase's files. Edits outside the plan get a yellow hatch.
- **Timeline:** the phases in order over a histogram of edits, and under it one bar per helper-agent run. A helper that sits idle holds no lane and returns to one when it's resumed; past four lanes, the extra runs merge into a `+n` block that lists them on hover. Click a phase to apply its suggested view or ask the orchestrator about it.
- **Views, follow, pins and monitors:** the orchestrator can suggest a view for each phase, and it applies automatically while you follow. Pin areas to draw them 3× larger (the pin button lists them), or open live diff-feed monitors on folders.
- **Walkthroughs:** ask "walk me through P2" (or "what's new since my last review") to get a stepper with one stop per idea, each with its diff. The map zooms and badges each stop's files. The Command chat docks under the walkthrough, and Copilot revises or expands stops in place when you ask about them. Every walkthrough is kept in a list, where you can reopen one and see which you've reviewed.
- **Command chat:** a persistent chat with the orchestrating session. Point at tiles, phases or walkthrough stops to attach them as focus chips.
- **Guided tour:** press **?** (or click the **?** in the map header) for a one-minute tour of all of the above.

**Watch the plan land, then get walked through it.** Edits light up the map live while the orchestrator works through its todos. A walkthrough zooms the map to each stop's code, and you can ask the orchestrator about any stop.

![Live edits on the map, a walkthrough stepping through its stops, and a question to the orchestrator](docs/images/demo-command.webp)

| Walkthrough | Guided tour |
|---|---|
| ![Walkthrough](docs/images/walkthrough.png) | ![Guided tour](docs/images/guided-tour.png) |

## Install

Requirements: the GitHub Copilot app with canvas extensions, and `git` on your `PATH`. There is nothing to build and there are no npm dependencies; the Copilot runtime supplies `@github/copilot-sdk`.

Install it as a Copilot plugin. This repository is its own plugin marketplace:

```sh
copilot plugin marketplace add notthatbreezy/marginal
copilot plugin install marginal@marginal
```

Then restart the Copilot app, or ask Copilot to reload extensions. The canvas registers as **Marginal** (canvas id `marginal`). Update with `copilot plugin update marginal`, remove with `copilot plugin uninstall marginal`.

To stay on a tagged release instead of the latest `main`, add the marketplace at a tag, e.g. `copilot plugin marketplace add notthatbreezy/marginal#v0.6.0`. Releases and their notes are on the [releases page](https://github.com/notthatbreezy/marginal/releases); see [CHANGELOG.md](CHANGELOG.md).

Your docs live in `~/.copilot/marginal/` (or `$COPILOT_HOME/marginal/`), outside the plugin, so updating or reinstalling keeps them.

<details>
<summary>Other ways to install</summary>

- **One command, deprecated by the CLI:** `copilot plugin install notthatbreezy/marginal`. Direct repository installs still work but print a deprecation warning.
- **From a clone:** `git clone https://github.com/notthatbreezy/marginal ~/.copilot/extensions/marginal` (Windows: `%USERPROFILE%\.copilot\extensions\marginal`), or into `.github/extensions/marginal/` in one repository. Use this when you want to hack on it. Don't combine it with the plugin install, or you'll get two Marginal canvases.

</details>

## Use

Ask Copilot things like:

- "Explain my branch in Marginal."
- "Sketch how checkout calls the payment service on the Marginal scratchpad."
- "Organize the Diff tab into file groups."
- "Start a Marginal doc for this issue and put the plan in it."

The agent calls the canvas's `instructions` action first (topics: `authoring`, `scratchpad`, `blocks`, `file-lenses` for file groups, `command`), then draws with actions such as `create`, `edit`, `read_file`, `diff` and `lens` (file groups). The same actions work without an open panel through the `marginal` tool, and `export` writes a doc (or one heading's part) to a Markdown file, diagrams included as text, for handing to people or helper agents.

**Command center.** Open a doc that has a repository target and switch to the **Command** tab.

- Click **Initialize command center**, optionally describing the goal. This session reads the doc and the branch, sets a plan of phases, and gives the canvas the checkout it builds in.
- Or ask the agent to follow the `command` instructions topic when it starts a multi-step implementation.

The orchestrator moves each phase through its stages as the work goes; everything else (edits, its todos, its helper agents) the canvas observes on its own.

The protocol is described in [docs/command-center.md](docs/command-center.md).

## How it works

- The plugin (`plugin.json`) ships one canvas extension, `extensions/marginal/`. Its `extension.mjs` joins the Copilot session with `joinSession()` and declares the canvas and its actions with `createCanvas()`. Each panel is served by a local HTTP server bound to `127.0.0.1`; every request needs a random per-panel token.
- Docs, pins and the Command center's state, event log and progress live in `~/.copilot/marginal/` and never leave your machine. Set `MARGINAL_DATA_DIR` to store them elsewhere.
- Code is read from your local repositories with `git` at pinned commits. The Command center polls each watched worktree with `git diff` and `git ls-files`, running at most four git processes at once and passing `--no-optional-locks`.
- Progress comes from the orchestrator's session: its intent and helper-agent events, plus two read-only runtime calls for its todo list and its tasks, debounced and sent to the panel at most once a second.
- **Checkpoint snapshots:** when a phase completes without a commit, the worktree's current contents are captured as a hidden commit under `refs/marginal/checkpoints/<doc>/…` in your repository. This uses a temporary index; your branch, HEAD, index and files are never touched. The refs are removed when the doc is deleted.
- Only one Copilot session drives a doc's Command state at a time. That session holds a lease, claimed when it sets the plan. Other sessions can read the state but can't change it.
- The browser UI is plain ES modules (`extensions/marginal/web/`) with no framework and no build step.

## Develop

```sh
npm test                 # unit + integration tests (node:test, real git repos in a temp dir) and a backend smoke test
npm run dev              # a standalone Command tab with a fake repo, worktrees and scripted edits; prints a URL
```

`tools/devserver.mjs` also takes `--single` (every phase in one checkout), `--progress` (a scripted orchestrator's todos, intent and helpers; add `--many-helpers`, `--long`, `--reload`, `--stages` or `--bare` for other cases), `--walk` (show a walkthrough), `--revising` (a rejected walkthrough), `--canned-chat` (scripted Command chat replies), `--not-owner` (read-only chat) and `--empty` (no plan yet). `tools/demos/record.mjs` records the README's images and demos headlessly. After changing the extension, reload extensions in the Copilot app. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and license

Marginal grew out of [devdotfast/whiteboard](https://github.com/devdotfast/whiteboard) (MIT). Its block vocabulary, agent guidance and patch conventions are adapted here; see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). Marginal itself is released under the [MIT License](LICENSE).

*GitHub and Copilot are trademarks of GitHub, Inc. This project is not affiliated with or endorsed by GitHub.*
