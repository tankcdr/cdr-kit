# Changelog

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
