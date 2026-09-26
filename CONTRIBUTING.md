# Contributing

Thanks for helping. Marginal is small on purpose: no build step, no npm dependencies, plain ES modules.

## Layout

| Path | What |
|---|---|
| `extension.mjs` | Joins the Copilot session, declares the `marginal` canvas and its actions. |
| `lib/` | Node side: git access (`git.mjs`), doc storage (`store.mjs`), block schemas (`blocks.mjs`), the loopback server (`server.mjs`), side chat (`chat.mjs`), agent guidance (`instructions.mjs`). |
| `lib/command/` | Command center: plan model and validation, lease, poller, event log, snapshots, walkthroughs. |
| `web/` | The panel UI (`app.js`, shared helpers in `core.js`, `stepper.js`, `selection.js`, `guide.js`). |
| `web/command/` | The Command tab (map, fronts, timeline, views, monitors, walkthrough, tour). |
| `test/` | `node:test` suites and a smoke test. They create throwaway git repos and set `MARGINAL_DATA_DIR` to a temp dir. |
| `tools/` | `devserver.mjs` (standalone Command tab with a fake repo) and `scope-css.mjs`. |

## Workflow

1. Clone into `~/.copilot/extensions/marginal` (or symlink your checkout there).
2. Edit, then reload extensions in the Copilot app. The panel URL and token change on every reload.
3. `npm test` before sending a change. It needs Node 20+ and `git`.
4. For Command-tab UI work, `npm run dev` prints a URL for a fully simulated mission wall (`--walk`, `--revising`, `--not-owner` and `--empty` show other states).

## Conventions

- Validate external input once, at the boundary, and return structured issues rather than throwing deep inside.
- Command actions are atomic: on any issue, nothing is written.
- Git calls go through `lib/command/gitx.mjs` (`--no-optional-locks`, at most four concurrent processes). Never change a user's HEAD, index or working tree.
- UI automation for screenshots must be headless and must never take window focus.
- Keep colours to theme tokens (`--bg`, `--fg`, `--blue`, …) and `color-mix()` so light and dark themes both work.