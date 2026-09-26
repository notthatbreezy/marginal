# Command center

The Command tab of a doc with a repository target tracks a multi-step implementation while it happens. The orchestrating Copilot session describes the plan. The extension observes the worktrees doing the work and draws where edits land. Agents never report individual edits.

## Concepts

| Term | Meaning |
|---|---|
| **Plan** | `{id, title, base, phases[]}`. `base` defaults to the doc's base commit. |
| **Phase** (checkpoint) | `{id, title, expects[], steps[], suggestedView?}` with state `pending` → `active` → `done`. A `done` phase always carries a checkpoint: a commit you name, or a hidden snapshot. |
| **Step** | A smaller unit inside a phase, optionally attributed to one front. |
| **Expects** | Repository-relative files, `dir/` prefixes or globs (`src/**/*.ts`). Together they form the plan's footprint. |
| **Front** | One registered worktree. Its edits are attributed to it by `git diff` against the plan base, or against the merge-base once the worktree's branch has moved past the base (shown as "base moved"). |
| **Off-plan** | A file a front changed that matches none of the phases or steps it is associated with (active or done). With no association, the whole plan footprint counts. |
| **View** | `{id, title, root?, pins?, monitors?, filters?}`: a map layout. Paths are concrete (no globs). |
| **Walkthrough** | A pinned `{base, head}` commit pair plus stops. Each stop is one idea with ranges from that diff. |

## Agent protocol

Every `command_*` action validates its whole input first. On any problem it returns `{ok:false, issues:[{path, code, message, hint}]}` and changes nothing. Issue codes include `required`, `type`, `enum`, `format`, `unknown_id`, `duplicate_id`, `stale_revision`, `path_outside_repo`, `path_not_in_diff`, `range_out_of_bounds`, `worktree_not_repo`, `worktree_other_repo`, `duplicate_worktree`, `ref_unresolvable`, `empty_diff` and `not_owner`. Hints use real data, such as the nearest changed file or the valid ids.

| Action | Ops |
|---|---|
| `command_plan` | `set {plan}` claims the lease and replaces the plan (states of surviving ids are kept) · `phase {phaseId, status, frontIds?, commit?}` · `step {stepId, status, frontId?}` · `read` |
| `command_front` | `register {id, label, worktree}` · `status {id, status: active\|blocked\|done, note?}` · `remove {id}` · `list` |
| `command_view` | `set {view, phaseId?}` (with `phaseId` it becomes that phase's suggestion) · `apply {id}` · `remove {id}` · `list` |
| `command_status` | `{status: working\|awaiting_operator\|complete, prompt?}`. This is a fallback; the lamp normally follows the session's own events. |
| `command_diff` | `{from, to, format?: files\|patch, paths?, context?, maxBytes?}` over checkpoint refs: `{phaseId}` · `{sha}` · `{ref:"base"}` · `{ref:"live", frontId}` (a snapshot of that worktree now) |
| `command_walkthrough` | `show {walkthrough}` · `edit {id, baseRevision, edits[]}` with `update_stop`, `insert_stop`, `remove_stop` and `focus_stop` · `close {id}` · `read {id?}` |
| `command_read` | `{include?: plan, fronts, stats, offplan, focus, views, mission, walkthrough}` |

The `instructions` action's `command` topic gives the agent the same protocol in prose.

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
  replayAt?: string; // ISO time when the user is scrubbed into the past
};
```

## Storage

Per doc, under `artifacts/docs/<id>/command/`:

| File | Contents |
|---|---|
| `state.json` | Plan, fronts, views, walkthroughs and mission. Written only by the owner and revisioned. |
| `prefs.json` | UI preferences such as follow, layout, saved views, the tour-seen flag and the last chat focus. Any panel may write it, and it is validated on every read and write. |
| `events.jsonl` | The append-only change log. It is compacted once at 20 MB: events older than 6 h fold into per-file baselines plus minute buckets. |
| `owner.json` | The lease. |

The line-count cache lives in `artifacts/loc-cache/`. Checkpoint snapshots are git refs under `refs/marginal/checkpoints/<doc>/` in your repository, and they are deleted with the doc.

## Deliberate limits

- Replay is scrub-only; there's no play button.
- Monitors have two modes, diff feed and files.
- Pins use a fixed 3× weight.
- The mission lamp uses explicit session events only: turns, tool starts, user-input, plan-approval and permission requests, and task completion. After 30 s of idling it switches to "waiting on you".
- The activity lane in the chat is held in memory by the owner process.
- Activity inside child sessions isn't observable. Their edits still show up, because their worktrees are polled.
