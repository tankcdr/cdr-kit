# cdr-kit

tankcdr's Claude Code plugin marketplace. One plugin, `cdr`:

| Component | Use |
|---|---|
| `/cdr:ship-epic <N>` (workflow) | Ship an epic, or a single issue: an Opus coordinator plans parallel tracks, a team per track builds and QAs each issue, then one PR into the base branch and up to 5 AI-review fix rounds. Accepts `237`, `#237`, `epic 237`, `issue 237`. An issue with sub-issues ships as an epic on `epic/N`; one without ships on `issue/N`. |
| `cdr:pr-review-loop` (skill) | Two rounds of wait for the AI review and checks, triage, fix, push; then "Needs human review". |
| `pr-review-loop` hook | After `gh pr create` opens a PR in the profile's repo, tells the session to run `cdr:pr-review-loop`. |
| `wait-review` (bin) | Waits for the review and checks runs on a PR's head, then prints them and every comment since a time. |

Everything repo-specific lives in the repo, in `.claude/ship-profile.json`. A repo without one is left alone.

## Install

```sh
claude plugin marketplace add tankcdr/cdr-kit          # or tankcdr/cdr-kit#v0.1.0 to pin a release
claude plugin install cdr@cdr-kit --scope project      # from the repo that has the profile
```

Updates: `claude plugin update cdr@cdr-kit`, then `/reload-plugins`.

## `.claude/ship-profile.json`

Committed in the repo's main checkout. In commands, `<wt>` is the worktree the command runs in and `<root>` the
main checkout.

| Field | Meaning |
|---|---|
| `repo` | `owner/name` on GitHub. |
| `base` | The branch PRs go into and AI review runs on. |
| `context` | What to read for domain context, e.g. `CONTEXT.md, the ADRs in docs/adr/`. |
| `docs` | The docs a change may need to update. |
| `setup` | Steps for every new worktree (install, copy untracked tools, a preflight check). |
| `gates.typecheck`, `gates.test`, `gates.build`, `gates.smoke` | Gate commands. |
| `gates.targeted` | How to run named test files (`<files>`). |
| `gates.smokeWhen` | When a change needs the smoke gate. |
| `gates.extra` | Optional `[{when, run}]`: further gates for some changes (e.g. contracts). |
| `rules` | Repo-specific rules for every agent (toolchain quirks, long commands). |
| `blockingRules` | Review findings that always block. |
| `review.workflow`, `review.checks` | The GitHub Actions workflow names of the AI review and the gates. |
| `review.runners` | Where they run, for messages (e.g. `the self-hosted runners`). |
| `review.flakes` | Known flaky failures that get a rerun instead of a fix. |
| `planNotes` | Optional: a note for the planner (e.g. who else opens PRs). |
| `prBodyModel` | Optional: a PR number whose body the epic PR follows. |

The workflow also reads the review rules in your Claude Code memory for the repo
(`~/.claude/projects/<root with non-alphanumerics as ->/memory/MEMORY.md`) when it exists.

## Requirements

`gh` (authenticated), `jq`, `git`. The workflow's agents name their models inline and use the agent types
`sonnet-implementer`, `haiku-documentor`, `opus-adversary` and `advisor` from `~/.claude/agents`.
