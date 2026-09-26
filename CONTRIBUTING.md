# Contributing

Thanks for helping. Marginal is small on purpose: no build step, no npm dependencies, plain ES modules.

## Layout

| Path | What |
|---|---|
| `plugin.json`, `.github/plugin/marketplace.json` | The plugin manifest (ships `extensions/marginal/`) and a one-plugin marketplace, so `copilot plugin marketplace add` works. |
| `extension.mjs` (root) | A one-line shim so a clone into `~/.copilot/extensions/marginal` also works. |
| `extensions/marginal/extension.mjs` | Joins the Copilot session, declares the `marginal` canvas and its actions. |
| `extensions/marginal/lib/` | Node side: git access (`git.mjs`), doc storage (`store.mjs`), block schemas (`blocks.mjs`), the loopback server (`server.mjs`), side chat (`chat.mjs`), agent guidance (`instructions.mjs`). |
| `extensions/marginal/lib/command/` | Command center: plan model and validation, lease, poller, event log, snapshots, walkthroughs. |
| `extensions/marginal/web/` | The panel UI (`app.js`, shared helpers in `core.js`, `stepper.js`, `selection.js`, `guide.js`). |
| `extensions/marginal/web/command/` | The Command tab (map, fronts, timeline, views, monitors, walkthrough, tour). |
| `test/` | `node:test` suites and a smoke test. They create throwaway git repos and set `MARGINAL_DATA_DIR` to a temp dir. |
| `tools/` | `devserver.mjs` (standalone Command tab with a fake repo) and `scope-css.mjs`. |

## Workflow

1. Clone into `~/.copilot/extensions/marginal` (the root `extension.mjs` loads `extensions/marginal/`), or symlink your checkout there. Uninstall the plugin version first if you have it.
2. Edit, then reload extensions in the Copilot app. The panel URL and token change on every reload.
3. `npm test` before sending a change. It needs Node 20+ and `git`.
4. For Command-tab UI work, `npm run dev` prints a URL for a fully simulated mission wall (`--walk`, `--revising`, `--not-owner` and `--empty` show other states).

## Conventions

- Validate external input once, at the boundary, and return structured issues rather than throwing deep inside.
- Command actions are atomic: on any issue, nothing is written.
- Git calls go through `extensions/marginal/lib/command/gitx.mjs` (`--no-optional-locks`, at most four concurrent processes). Never change a user's HEAD, index or working tree.
- UI automation for screenshots must be headless and must never take window focus.
- Keep colours to theme tokens (`--bg`, `--fg`, `--blue`, …) and `color-mix()` so light and dark themes both work.
## Releasing

Releases are cut by GitHub Actions, so nothing depends on a local setup. Versions are semver and live in three places that must agree: `plugin.json`, `.github/plugin/marketplace.json` (`metadata.version` and the plugin entry) and `package.json`. The tests check this.

1. As changes land, describe them under **Unreleased** in `CHANGELOG.md`. The release fails if that section is empty.
2. Run the **release** workflow: Actions → release → Run workflow, pick `patch`, `minor` or `major` (or type an exact version), and run. Tick **Dry run** first to see the version and notes without changing anything. From a terminal: `gh workflow run release --repo notthatbreezy/marginal -f bump=minor`.
3. The workflow runs the tests, bumps all three manifests, moves the Unreleased notes under the new version with today's date, commits `Release vX.Y.Z` to `main` as github-actions[bot], tags it, pushes, and publishes a GitHub release with those notes.

You can also cut a release locally with `npm run release -- patch` (`--dry-run` previews) and `git push origin main --follow-tags`. The pushed tag triggers the same workflow, which publishes it.

People on the marketplace follow `main`: `copilot plugin update marginal` picks up whatever is there. To stay on a release, pin the marketplace to a tag: `copilot plugin marketplace add notthatbreezy/marginal#v0.1.0`.