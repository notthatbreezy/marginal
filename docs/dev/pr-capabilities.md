# Pull requests tab: what GitHub actually does

These are the results of the compatibility gate (phase pr0), measured with `gh` on 2026-10-01 against two hosts:
- **github.com**: the private sandbox `notthatbreezy/marginal-sandbox`, PR #1.
- **A `*.ghe.com` host**: GitHub Enterprise Cloud with data residency (`/meta` has no `installed_version`, so it isn't GHES). The PRs read there were private, so their responses aren't committed.

The fixtures in `test/fixtures/prs/` come from the sandbox.

## GraphQL

The query in `extensions/marginal/lib/prs/github.mjs` returns every field the tab uses, on both hosts:

- **The PR**: `state`, `isDraft`, `merged`, `reviewDecision`, `headRefOid`, `updatedAt`.
- **Checks**: `statusCheckRollup` with its contexts, as CheckRun and StatusContext.
- **Review threads**: `isResolved`, `isOutdated`, `path`, `line` and `originalLine`, `startLine`, `diffSide`, plus their comments.
- **Each comment**: `databaseId`, `author`, `body`, `createdAt`, `lastEditedAt`, `diffHunk`, `replyTo`, and its `pullRequestReview`.
- **Also**: the PR's `reviews` and its conversation `comments`.

Cost and shape:
- **Cost**: 1 point per query (`rateLimit.cost`), for PRs with up to 17 reviews and 14 checks, at 50 items per page.
- **Every reply is its own review.** Replying to a thread creates a `COMMENTED` review with an empty body, so reviews with an empty body are wrappers, not summaries.
- **Copilot code review** comments as `copilot-pull-request-reviewer`. A GitHub Actions workflow comments as `github-actions`. GraphQL logins have no `[bot]` suffix.

## Is the PR unchanged? `If-Modified-Since`, not the ETag

The check is a `GET /repos/{o}/{r}/pulls/{n}`.

| | github.com | *.ghe.com |
|---|---|---|
| ETag stable between identical requests | yes | **no** (a new ETag on every request) |
| `If-None-Match` → 304 | yes | never |
| `If-Modified-Since: <Last-Modified>` → 304 | yes | yes |
| A 304 counts against the rate limit | no | no |
| `gh api -i` with a 304 | exits 1, headers printed | same |

Marginal sends `If-Modified-Since` with the last `Last-Modified` it saw (the PR's `updated_at`).

What changes `updated_at` on github.com (`test/fixtures/prs/etag-matrix.json`):

| Event | ETag changes | `updated_at` changes |
|---|---|---|
| Nothing (control) | no | no |
| Someone else's reply in a thread | yes | yes |
| A new review with line comments | yes | yes |
| A conversation comment | yes | yes |
| Editing a comment | yes | yes |
| A push | yes | yes |
| Your own reply in a thread | yes | **no** |
| Resolving or unresolving a thread | **no** | **no** |

So the cheap check catches every comment from someone else, which is everything that triggers handling. It misses resolution changes and, sometimes, your own replies. Those come from the full fetch: the periodic reconciliation, and every fetch triggered by another change.
