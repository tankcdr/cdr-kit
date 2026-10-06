---
name: pr-review-loop
description: After this session opens a PR in a repo with a .claude/ship-profile.json, wait for its AI review and checks on the self-hosted runners, act on what they and any other comments raise, push, and do that once more; then post that the PR needs human review. Started automatically by the cdr plugin's hook after `gh pr create`; also `/cdr:pr-review-loop <PR#>`.
---

# PR review loop

Two rounds, then a human. Each round: wait, read, act, update the PR. Never a third round.

## The profile

Read `<main checkout>/.claude/ship-profile.json` first (the main checkout: dirname of
`git rev-parse --path-format=absolute --git-common-dir`). It gives:

- `repo`: owner/name. `base`: the branch AI review runs on PRs into.
- `review.workflow`: the AI review workflow (a reviewer posts findings, a verifier keeps or dismisses each, a bot
  posts one comment; cdr's `pr-review` skill is one). `review.checks`: the gates workflow (it may be the same
  workflow). Both run when a PR into `base` is opened and on every
  push to it, on `review.runners`, so the push that ends round 1 is what starts round 2's review.
- `gates`: the commands that must pass before you push (`<wt>` is the checkout you work in).
- `review.flakes`: known flaky failures, which get a rerun, not a code change.

No profile: say so in one line and stop.

## Start

1. `gh pr view <N> -R <repo> --json baseRefName,headRefName,createdAt,state`. The base must be `base`: no AI review
   runs for a PR into another branch, so for one, skip the loop and say so in one line.
2. Work in the checkout or worktree that holds the PR's branch (the one it was created from).
3. Tell the user one line: "Watching PR #N: review round 1 of 2."

## Each round (r = 1, then 2)

1. **Wait.** Run `REPO=<repo> REVIEW_WORKFLOW=<review.workflow> CHECKS_WORKFLOW=<review.checks> ${CLAUDE_PLUGIN_ROOT}/bin/wait-review <N> <since>`
   with `run_in_background: true` and `timeout: 7200000`. `<since>` is the PR's `createdAt` for round 1 and the
   time you recorded just before round 1's push for round 2. Don't poll: the session is re-invoked when it exits.
   The runners are shared, so a round can queue behind other PRs.
   - Exit 0: both runs finished; read on.
   - Exit 3: no review run appeared for the head (the runners are down, or the workflow trigger changed). Act on
     the comments it printed if any, then hand off, and tell the user the review never ran.
   - Exit 4: timed out. Hand off, saying so.
2. **Read** its output: the run results and every comment, inline comment and review since `<since>`. The AI review
   comment lists findings with the verifier's verdicts. A `pr-review` comment starts with
   `<!-- cdr:pr-review verdict=<v> head=<sha> -->`: `request-changes` means fix its Required changes,
   `accept-with-suggestions` means triage its Suggestions and Uncertain lines, `accept` means nothing from the review
   (checks skipped after a `request-changes` verdict are not failures). A failed checks run: `gh run view <id> -R <repo> --log-failed | tail -200`.
   If the PR merged while you waited (`gh pr view <N> --json state`), fixes can't go onto it. Open a follow-up PR
   against `base` from the same branch; the hook starts that PR's own loop. Post the hand-off on the merged PR,
   pointing to the follow-up.
3. **Triage** every finding the verifier kept and every comment that asks for a change. Check each against the code
   yourself: a verdict is not proof. Real: fix it. Not real: decline it, with file:line evidence. If nothing is
   actionable (no kept findings, no change requests, checks green), stop here and hand off.
4. **Fix** the way the repo does: a regression test shown failing without its fix, one finding per commit, the
   profile's `gates.typecheck` and `gates.test` green (and `gates.smoke` when `gates.smokeWhen` holds), no Claude
   co-author trailer. A checks failure that matches one of `review.flakes` gets `gh run rerun <id> -R <repo> --failed`,
   not a code change.
5. **Update the PR.** Record `date -u +%Y-%m-%dT%H:%M:%SZ` (round 2's `<since>`), then push. Post one PR comment that
   starts with `<!-- pr-review-loop round r -->`: what was fixed (with commit) and what was declined (with the
   reason). Edit the PR body if the fixes change what it says. No Claude attribution in either.
6. After round 1, go back to step 1 for round 2. After round 2, hand off: don't wait for or act on the review
   your round-2 push starts.

## Hand off

Post a PR comment that starts with `<!-- pr-review-loop done -->` and leads with **Needs human review.** Give the
rounds run, what was fixed, what was declined and why, anything still open, and, when round 2 pushed, that a
review of that push is still coming. Then tell the user in chat: "PR #N needs human review", one line on where it
stands, and the link. Never merge.
