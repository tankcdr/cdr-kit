---
name: ship-init
description: Draft and write the repo's .claude/ship-profile.json, which /cdr:ship-epic and cdr:pr-review-loop read. Scans the repo for its GitHub name, base branch, gate commands, PR workflows and worktree setup, then asks the user for what a scan can't settle. Trigger: /cdr:ship-init, "set up ship-epic for this repo".
---

# Ship profile init

Writes `<main checkout>/.claude/ship-profile.json`. The plugin README lists every field; `${CLAUDE_PLUGIN_ROOT}/README.md`.
The main checkout is the dirname of `git rev-parse --path-format=absolute --git-common-dir`.

A profile already there: show it, ask what to change, and edit only that.

## Scan

Fill every field you can from the repo, and note where each value came from:

- `repo`: `gh repo view --json nameWithOwner -q .nameWithOwner`.
- `base`: the branch most recent PRs merged into (`gh pr list --state merged -L 30 --json baseRefName`); the default
  branch when there are none.
- `gates`: from the build tool: `package.json` scripts (and the package manager its lockfile implies), a Makefile,
  `Cargo.toml`, `pyproject.toml`, `go.mod`. Write each as a command with `-C <wt>` or `cd <wt> &&` so it runs in a
  worktree. `targeted` is how to run named test files (`<files>`). No smoke or e2e suite: `smoke` is the same as
  `test` and `smokeWhen` is `never`.
- `review.workflow`, `review.checks`: the workflows in `.github/workflows/` that run on `pull_request` into `base`.
  The AI review is the one that posts a review comment; the checks are the one that runs the gates. Their `runs-on`
  gives `review.runners` (`the self-hosted runners` for `self-hosted`). With cdr's `pr-review` skill as the review,
  one workflow may run both: then both fields name it.
- `review.focus` (optional, read by cdr's `pr-review`): one or two sentences on what the product is and where a
  defect costs most (payments, auth, data migrations), from the README.
- `setup`: what a fresh worktree lacks: the dependency install (frozen lockfile), submodules, and gitignored tools
  or env files that tests need (copy from `<root>`). End with a cheap preflight if the repo has one.
- `context`: `CONTEXT.md`, `docs/adr/`, an `AGENTS.md` or `CLAUDE.md`, whichever exist.
- `docs`: the docs files a change usually touches (READMEs, `AGENTS.md`, `.env.example`, `docs/`). Leave out
  generated files; they go in `contract`.
- `contract` (optional): generated contract artifacts, such as an OpenAPI document or captured examples, and the
  script that regenerates them (an `openapi`, `snapshot` or `generate` script in `package.json`). `files` are the
  generated paths, `refresh` the command, `when` the changes that need it, `rules` where examples come from.
- `rules`: toolchain quirks a fresh agent would trip on (a monorepo `-C` convention, long commands that need the
  600000 ms Bash timeout, a submodule setting).
- `blockingRules`: the feedback memories in `~/.claude/projects/<root with non-alphanumerics as ->/memory/` that
  name a must-fix review finding, one short phrase each.

## Ask

Show the draft as JSON, then ask the user, with AskUserQuestion, only what the scan couldn't settle:

- Which candidate `blockingRules` to keep, and any to add.
- Known flaky check failures (`review.flakes`): exact error text, so a triager can match them.
- `smokeWhen`, if there is a smoke suite: which changes need it.
- `contract.rules`, if there is a contract: how examples are produced (recorded, captured, written by hand).
- Which workflow is which, if more than one runs on PRs.

## Write

Write the file, run `jq . <file>` to prove it parses, and check every required field is set: `repo`, `base`,
`context`, `docs`, `setup`, `rules`, `blockingRules`, `gates.{typecheck,test,targeted,build,smoke,smokeWhen}`,
`review.{workflow,checks,runners,focus,flakes}`. Then tell the user to commit it, and to enable the plugin for the repo
(`claude plugin install cdr@cdr-kit --scope project`) if it isn't already.
