# Command center

The Command tab of a doc with a repository target tracks a multi-step implementation while it happens. The orchestrating Copilot session describes the plan. The extension observes the worktrees doing the work and draws where edits land. Agents never report individual edits.

## Concepts

| Term | Meaning |
|---|---|
| **Plan** | `{id, title, base, phases[]}`. `base` defaults to the doc's base commit. |
| **Phase** | A deliverable: `{id, title, expects[], steps[], suggestedView?}`, where `expects` is what it builds (files, `dir/`, globs). Stages: `pending` (planned) → `active` (implementing) → `review` → `done` (complete), or `blocked` with a note saying on what; inputs also accept planned / implementing / complete. A `done` phase always carries a checkpoint: a commit you name, or a hidden snapshot of the worktree (branch, HEAD and index untouched). |
| **Step** | A smaller unit inside a phase, optionally attributed to one front. |
| **Expects** | Repository-relative files, `dir/` prefixes or globs (`src/**/*.ts`). Together they form the plan's footprint. |
| **Front** | A watched worktree: plumbing for where work happens. `command_plan set {worktree}` watches the checkout the phases are built in, which is all the usual case needs. More fronts only for parallel sessions or stacked PRs; the Command tab lists them as Worktrees only when there are several and the **Show worktrees** setting is on. Edits are attributed by `git diff` against the front's base (the plan base; for a stacked layer, the layer below; or a given `base`), or against the merge-base once its branch has moved past it ("base moved"). |
| **Off-plan** | A file a front changed that matches none of the phases or steps it is associated with (active or done). With no association, the whole plan footprint counts. Reported by command_read {include:["offplan"]} and usable as a view filter; the Command tab doesn't mark it. |
| **View** | `{id, title, root?, pins?, monitors?, filters?}`: a map layout. Paths are concrete (no globs). |
| **Walkthrough** | A pinned `{base, head}` commit pair plus stops. Each stop is one idea with ranges from that diff. |

## Agent protocol

Every `command_*` action validates its whole input first. On any problem it returns `{ok:false, issues:[{path, code, message, hint}]}` and changes nothing. Issue codes include `required`, `type`, `enum`, `format`, `unknown_id`, `duplicate_id`, `stale_revision`, `path_outside_repo`, `path_not_in_diff`, `range_out_of_bounds`, `worktree_not_repo`, `worktree_other_repo`, `duplicate_worktree`, `ref_unresolvable`, `empty_diff` and `not_owner`. Hints use real data, such as the nearest changed file or the valid ids.

| Action | Ops |
|---|---|
| `command_plan` | `set {plan, worktree?}` claims the lease, replaces the plan (states of surviving ids are kept) and watches `worktree` · `phase {phaseId, status: planned\|implementing\|review\|blocked\|complete, note?, commit?, frontIds?}` (note required when blocked; with one watched worktree frontIds is implied) · `step {stepId, status, frontId?}` · `read` |
| `command_front` | Only for parallel work or stacked PRs. `plan {fronts: [{id, label, note?, stacksOn?}]}` (the whole set: planned fronts left out are dropped, working ones kept and listed) · `register {id, label, worktree, stacksOn?, base?, status?, note?}` (a planned front becomes implementing; registering a complete front's worktree takes it over) · `status {id, status: planned\|implementing\|review\|blocked\|complete, note?}` · `remove {id}` · `list` · `advance {from, to, label?, worktree?, phaseId?, commit?, nextPhaseId?}` (one call up a stack: phase done, layer complete, next layer registered on it, next phase active) |
| `command_view` | `set {view, phaseId?}` (with `phaseId` it becomes that phase's suggestion) · `apply {id}` · `remove {id}` · `list` |
| `command_status` | `{status: working\|awaiting_operator\|complete, prompt?}`. This is a fallback; the lamp normally follows the session's own events. |
| `command_diff` | `{phase}` (what that phase delivered: from the phase before it, or the base, to its checkpoint or live work) or `{from, to, format?: files\|patch, paths?, context?, maxBytes?}` over checkpoint refs: `{phaseId}` · `{sha}` · `{ref:"base"}` · `{ref:"live", frontId}` (a snapshot of that worktree now) · `{walkthrough: id}` (where that walkthrough ended) · `{ref:"reviewed"}` (where the latest walkthrough the user reviewed ended) |
| `command_walkthrough` | `show {walkthrough}` · `edit {id, baseRevision, edits[]}` with `update_stop`, `insert_stop`, `remove_stop` and `focus_stop` · `close {id}` · `read {id?}`. A stop range is `{file, side?, startLine, endLine}` or `{file, side?, symbol}` (a declaration, resolved to its lines); results carry notes for resolved symbols and for ranges that miss the file's changes |
| `command_read` | `{include?: plan, fronts, stats, offplan, focus, views, mission, walkthrough}` |

The `instructions` action's `command` topic gives the agent the same protocol in prose.

## Progress

The Command tab shows how the work is going without the orchestrator reporting any of it. Marginal's extension runs in the orchestrator's session and reads what the runtime already produces:

| Shown | From |
|---|---|
| **Now:** what the orchestrator is doing | the `assistant.intent` event (the orchestrator's own, not a helper's) while it's fresh, else its todo in progress |
| **Todos** done / total, and the list | `session.todos_changed`, then `session.rpc.plan.readSqlTodosWithDependencies()` |
| **Helpers** running, and each one's span | `subagent.started` / `completed` / `failed`, and `session.rpc.tasks.list()` after `session.background_tasks_changed` (it fills in what was missed, such as during an extensions reload; shell tasks are ignored) |

- **Status line** (the instrument strip): `Now: …`, `Todos n / m` and `k helpers running`. The last two open popovers: the todos grouped by phase, and the helpers with their state and time.
- **Phase cards**: each phase's todo count, its todo in progress as "Now:", and its running helpers. An **Other** card collects what matched no phase.
- **Helper lanes** under the timeline's histogram, on the same time axis: one bar per run (running, done, failed, cancelled). A background helper idling between runs holds no lane, so the lanes track how many run at once, not how many there have been; when it's resumed it returns to its lane if that's free (a dotted line joins its runs), and hovering a run highlights all of them. At most four lanes: past that, the extra runs merge into `+n` blocks on the last lane, and hovering one lists what's in it. Runs longer than an hour show their last hour, with a toggle for the whole run; if more than 200 helpers have come and gone, the lanes say from when older ones weren't kept.

Resuming an idle background helper sends no event, so its new run starts when the next task-list read sees it running (within a second or two).

Each todo and helper is matched to a phase once, the first time it's seen, and keeps it: a todo whose id or title starts with a phase id (`p2-wire`, `P2: …`) belongs to that phase; otherwise it belongs to the first phase that was in play (implementing or in review) when the todo was created, or to Other when none was. Helpers match by when they started. Each phase records its stage changes (history in its state), so a blocked or delivered stretch doesn't count as in play even after the phase resumes. A todo that's already done when the Command center first sees it, was created before it started watching and isn't named for a phase is earlier work and isn't counted.

The RPC reads are debounced (the runtime signals task changes in bursts) and the panel hears at most one update a second. Missing pieces are simply absent: no todo list, no pill.

## Ownership

- `command_plan {op:"set"}` explicitly claims the doc's Command lease for the calling session. Opening a panel never claims it.
- The owner process heartbeats every 10 s. The lease goes stale after 30 s without a heartbeat, and only then can another session take over. A live owner calling `set` again just renews the lease.
- Mutations from any other session return `not_owner`, and the hint names the owner. Reads work from any session.
- Only the owner process polls worktrees. A process that loses the lease stops its pollers immediately.
- The Command chat talks to the panel's own session. It is disabled only while a different session holds a live lease.

## Focus payload

Each Command chat message carries a fenced JSON block describing what the user pointed at. `command_read {include:["focus"]}` returns the same data, plus the walkthrough stop on screen:

```ts
type Focus = {
  items: (
    | { kind: "path"; path: string; isDir: boolean }
    | { kind: "front"; frontId: string }
    | { kind: "phase"; phaseId: string }
    | { kind: "step"; stepId: string }
    | { kind: "stop"; walkthroughId: string; stopId: string; revision: number }
    | { kind: "range"; file: string; startLine: number; endLine: number; pins: { base: string; head: string } }
  )[];
};
```

## Storage

Per doc, under `~/.copilot/marginal/docs/<id>/command/`:

| File | Contents |
|---|---|
| `state.json` | Plan, fronts, views, walkthroughs and mission. Written only by the owner and revisioned. |
| `prefs.json` | UI preferences such as follow, layout, saved views, the tour-seen flag and the last chat focus. Any panel may write it, and it is validated on every read and write. |
| `events.jsonl` | The append-only change log. It is compacted once at 20 MB: events older than 6 h fold into per-file baselines plus minute buckets. |
| `owner.json` | The lease. |
| `progress.json` | Observed progress: the latest intent, the last todo snapshot with each todo's phase, and the last 200 helpers. Written only by the owner; derived, so it's rebuilt from the session if lost. |

The line-count cache lives in `~/.copilot/marginal/loc-cache/`. Checkpoint snapshots are git refs under `refs/marginal/checkpoints/<doc>/` in your repository, and they are deleted with the doc.

## Deliberate limits

- Monitors have two modes, diff feed and files.
- Pins use a fixed 3× weight.
- The mission lamp uses explicit session events only: turns, tool starts, user-input, plan-approval and permission requests, and task completion. After 30 s of idling it switches to "waiting on you".
- Activity inside child sessions isn't observable. Their edits still show up, because their worktrees are polled.
