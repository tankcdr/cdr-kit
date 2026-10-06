# Changelog

## 0.4.1 (2026-10-06)

- `pr-review-context` takes `BASE_SHA` and `HEAD_SHA` (CI: the event's). Before, it always read the PR's live head,
  so a re-run of an older run after a push reviewed the old checkout but labelled it with the new head.

## 0.4.0 (2026-10-06)

- **`/cdr:pr-review <N>`** (Codex: `$cdr:pr-review <N>`), a PR review that runs in Claude Code, Codex and CI. A
  correctness reviewer and a ponytail over-engineering reviewer run as parallel sub-agents; the same agent then
  verifies each finding against the code and writes one comment for the agent that fixes the PR. `pr-review-post`
  computes the verdict from the verified findings (`request-changes` for a confirmed blocking or major finding,
  `accept-with-suggestions` for minor or uncertain ones, else `accept`) and heads the comment with it and a
  `<!-- cdr:pr-review verdict=<v> head=<sha> -->` line, so CI jobs and agents can act on it. `--no-post` returns the
  review instead, for a CI step that posts it without giving the model a token.
- `bin/pr-review-context` gathers the review's inputs (description, git diff, comments, closed issues and their
  epics) into `.review/`; `bin/pr-review-post` posts the result.
- `review.focus` in the profile (optional): what the product is and where a defect costs most, for the correctness
  reviewer.
- pr-review-loop and ship-epic's triage read the verdict line, and `review.workflow` and `review.checks` may name the
  same workflow.

## 0.3.1 (2026-10-06)

- **One review layer per issue.** QA is the review; the lead's done merges the issue. The per-issue coordinator
  review is gone: on #277 it re-read the same diff and re-ran the gates after QA already had.
- **The smoke gate runs once per issue**, in QA. The implementer runs typecheck and tests, not the smoke.
- **A single issue skips the Fable plan advisor and the epic check.** There's no order or split to review, and QA
  already ran the gates on the branch the PR opens from. An epic keeps both.
- `TEAM_ROUNDS` is 8, down from 10, now that review is no longer a step.
- Tests first no longer depends on the test suite. The plan tags a line `test` when any test (unit, integration or
  end to end) can be written before the code, `gate` when only a gate run proves it, and `none` otherwise. It also
  lists the further tests its steps add, so the tests step writes those first too. In 0.3.0 the trigger was `unit`,
  so an issue whose Done when asked for an integration test skipped the tests step.

## 0.3.0 (2026-10-06)

- **The issue lead picks every step.** Before this, the script fixed each round as implement, document, QA, then a
  fresh Opus lead that saw only the three reports. Now the lead decides the next step (tests, implement, docs or
  coordinator review) after each one. Every lead call gets the plan and a journal of earlier rounds with the lead's
  own notes, and runs at high effort. `TEAM_ROUNDS` is now 10 steps per issue, up from 7 rounds.
- **Test-first.** The plan tags each Done-when line `unit`, `smoke` or `none`. For `unit` lines the implementer writes
  and commits the tests first, and the lead checks they fail for the right reason. The code is then built to pass
  them: it may add test cases but not change or delete a line, and QA and the coordinator review check the diff.
- **Docs oversight.** The plan's `docs` is now a brief: for each doc, what a reader must learn and where any example
  comes from. The documenter runs once the code passes QA, copies examples only from tests, fixtures or captures, and
  the lead checks the docs commit against the code. Review only follows checked docs, and the coordinator review
  treats an unsourced example as a gap.
- **`contract` in the profile** (optional): generated contract artifacts and their refresh command. The implementer
  regenerates and commits them with a change that matches `when`, and the documenter never edits them.
  `/cdr:ship-init` asks about it.
- QA runs only when the implementer's verification is green, so a failing build goes straight back.

## 0.2.0 (2026-10-05)

- The plugin ships the agents ship-epic builds with: `cdr:sonnet-implementer`, `cdr:haiku-documentor`,
  `cdr:opus-adversary` and `cdr:advisor`. Before this, the workflow expected them in `~/.claude/agents` and failed
  without them.
- MIT license, a README for people outside the original repository, and this changelog.
- The workflow's git-safety rule explains why it forbids `stash`, `reset --hard` and `clean` (agents share the
  worktrees) instead of naming a local hook.

## 0.1.0 (2026-10-05)

First release.

- `/cdr:ship-epic`: plan, build, check and open one PR for an epic or a single issue, then up to 5 AI-review fix
  rounds.
- `/cdr:ship-init`: draft a repository's `.claude/ship-profile.json`.
- `cdr:pr-review-loop` skill and its `gh pr create` hook: two review rounds, then "Needs human review".
- `wait-review`: wait for a PR's review and checks runs, then print them and the new comments.
