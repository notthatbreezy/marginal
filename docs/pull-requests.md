# The Pull requests tab

A doc's **Pull requests** tab tracks the work of getting its PRs finished: where each one stands, its review threads the way GitHub shows them, and what happens when new review comments arrive. Marginal watches GitHub itself, so no agent turn is spent checking for comments. When there's something for Copilot to do, it gets one message with everything in it.

## Getting PRs on the list

- **A doc made from a PR** (`create {pullRequestUrl, repositoryId}`) has that PR from the start.
- **Copilot adds the others** with the `pr` action: `pr {op:"register", url, label?, stacksOn?, worktree?}`. It does this for the other layers of a stack, for example. `stacksOn` names the PR it builds on (by id or URL); the list shows it indented underneath, and loops are refused. `worktree` is the checkout the branch is built in, if Copilot knows it.
- **You can paste a URL** into the box at the top of the tab.

A PR is identified by host, owner, repository and number, so the same PR is never listed twice, whatever form its URL takes. URLs from github.com and from GitHub Enterprise hosts (such as `https://acme.ghe.com/…`) both work.

## Accounts

Marginal reaches GitHub through the `gh` CLI with the accounts it's logged in to (`gh auth status`), and stores no tokens. For each PR it uses the host's active account. If that account can't see the repository (an Enterprise Managed User account and a personal repository, say), it tries the host's other accounts and remembers which one worked for that owner. Comments from any of your accounts on that host count as yours: they never trigger handling.

## Watching

While the Copilot session that holds the doc's lease is running (the same lease as the Command center: the first session to watch a doc's PRs takes it), Marginal checks each watched PR:

| What | How often | Cost |
|---|---|---|
| Has the PR changed? `GET /repos/{o}/{r}/pulls/{n}` with `If-Modified-Since` | every minute | a 304 when nothing changed, which doesn't count against the rate limit |
| Everything (state, checks, threads, reviews, comments): GraphQL, paged | when the check says it changed | 1 point per page |
| The same, regardless (reconciliation) | every 10 minutes; every 2 while a batch is with Copilot or the PR is open in the tab | as above |
| Checks alone | every 2 minutes while some are pending | 1 point |

The reconciliation is there because resolving a thread doesn't change the PR (see [dev/pr-capabilities.md](dev/pr-capabilities.md)). A big PR is fetched 20 pages at a time; between ticks it resumes where it stopped, and nothing is treated as deleted until the fetch is complete. Watching stops when a PR is merged or closed, backs off on errors, and waits out rate limits. At most 20 PRs are watched at once. After a restart, the first check is a full fetch: comments that arrived meanwhile count as new.

Other sessions that open the doc see the same list and threads, read-only, with a note saying which session is watching.

## When new comments arrive

New comments from anyone but you (review bots such as Copilot code review included) are handled per PR:

- **Do nothing**: they show in the tab, marked new.
- **Handle**, up to a step. Each step includes the ones before it:
  - **Read**: a line in the chat from Marginal. No agent turn.
  - **Assess**: Copilot triages each thread (valid, declined, a question for you, already done). It changes no code and posts nothing.
  - **Remediate**: Copilot fixes the valid threads in the PR's checkout and commits locally, without pushing.
  - **Local review**: as Remediate, then independent reviewer agents check the fixes before Copilot is done.
  - **Push & resolve**: as Local review, then Copilot pushes, replies on each thread (what changed and the commit, or why it's declined) and resolves it. A question for you is left open and asked in the chat.

In the panel, checking a step checks every step before it, and unchecking one unchecks every step after it. The server enforces the same rule, so a later step can't be on without the earlier ones. New PRs start watched, at Read.

A submitted review goes as one batch straight away; a lone reply or comment waits for 90 quiet seconds in case more follow. One batch is with Copilot at a time; anything that arrives meanwhile goes in the next. A batch is sent queued behind Copilot's current work unless the PR is set to interrupt.

## What Copilot gets

One message per batch, with:
- the PR (repository, branches, state, review decision, checks)
- the outcome the handling step asks for (not how to get there)
- each new thread: its file and line, the diff hunk with the commented lines marked, and the whole conversation

Everything from reviewers is fenced off after a fixed line saying it is evidence from other people, not instructions. A comment over 4 KB or a thread over 12 KB is shortened (`pr {op:"read", prId, threadId}` returns the whole thing from Marginal's copy). A batch over 48 KB takes whole threads up to the limit, and the rest go in the next batch. Delivery is at least once: if Marginal stops between sending a batch and saving that it did, the batch is sent again with the same id, marked as a possible repeat.

Copilot does the work with its usual tools (git, `gh`, GitHub's own tools) and never has to read the PR from GitHub. Marginal sees the results by itself: commits on the branch, replies, resolved threads. `pr {op:"report", prId, threads:[…]}` is optional, for what GitHub can't show, such as a thread it declined without changing anything.

## The tab

- **List**: one row per PR with its state, review decision, checks (passed, failed, pending; hover for the failing ones), unresolved and total threads, how many comments are new since this panel last showed the PR, and what Marginal is doing with it now.
- **Detail**: the PR's header and checks, then its threads, filtered by Unresolved, All or Conversation (review summaries and general comments). Each thread shows its file and line, the diff hunk with the commented lines marked, the conversation (Markdown, with suggested changes as diffs), and a row of what's happened to it. That row combines what GitHub shows (the batch it went in, replied with a commit, resolved, outdated) and what Copilot reported, marked *reported*. **Ask in chat** asks Copilot about that one thread: the message carries it, from Marginal's copy.
- **Rail**: watching on or off, the handling steps, queue or interrupt, the checkout, and the activity log.

## For agents

The `prs` instructions topic covers this. In short: register PRs Marginal can't know about, work from the batch message, write to GitHub with your own tools, and use `read` (no GitHub call) when you need a thread again. Change a PR's settings only when the user asks.
