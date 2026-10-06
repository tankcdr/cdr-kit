# Changelog

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
