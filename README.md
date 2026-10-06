# cdr-kit

A [Claude Code](https://code.claude.com) plugin marketplace with one plugin, **`cdr`**. It ships a GitHub epic (or a
single issue) end to end with agent teams, opens one pull request, and then works that PR through your AI code
review until it needs a human.

Everything specific to a repository (its GitHub name, base branch, test commands, worktree setup, review rules,
CI workflow names) lives in that repository, in `.claude/ship-profile.json`. The plugin itself is generic, and a
repository without a profile is left alone.

## What's in the plugin

| Component | Kind | What it does |
|---|---|---|
| `/cdr:ship-epic <N>` | workflow | Plans, builds, checks and opens one PR for epic or issue `#N`, then runs up to 5 AI-review fix rounds on it. |
| `/cdr:ship-init` | skill | Scans a repository and drafts its `.claude/ship-profile.json`, asking you only what a scan can't settle. |
| `cdr:pr-review-loop` | skill | Two rounds of: wait for the PR's AI review and checks, fix what's real, push. Then posts "Needs human review". |
| PR hook | hook | After `gh pr create` opens a PR in the profile's repository, tells the session to run `cdr:pr-review-loop`. |
| `wait-review` | command | Waits for the review and checks runs on a PR's head commit, then prints them and every comment since a time. |
| `cdr:sonnet-implementer`, `cdr:haiku-documentor`, `cdr:opus-adversary`, `cdr:advisor` | agents | The team ship-epic builds each issue with: implementer, documenter, read-only adversarial QA, and a Fable advisor for one hard decision. |

## Requirements

- Claude Code with plugins and workflows, and access to the Opus, Sonnet, Haiku and Fable models.
- [`gh`](https://cli.github.com) signed in to an account that can push to the repository and open PRs. `git` and `jq`.
- For the review loops, two GitHub Actions workflows that run on pull requests into the base branch:
  - an **AI review** workflow that posts its findings as a PR comment (any reviewer works; the loop reads comments), and
  - a **checks** workflow that runs your tests.

  Their names go in the profile. Without them, ship-epic still builds and opens the PR, and the review phase stops
  with "review not running".

## Install

```sh
claude plugin marketplace add tankcdr/cdr-kit
claude plugin install cdr@cdr-kit             # every project; or add --scope project inside one repository
```

Then run `/reload-plugins` in any open session.

## Quick start

1. In the repository: `/cdr:ship-init`. Review the drafted profile, answer its questions, and commit
   `.claude/ship-profile.json`.
2. Ship something: `/cdr:ship-epic 123` (also accepts `#123`, `epic 123` or `issue 123`). An issue with sub-issues
   ships as an epic on branch `epic/123`; one without ships on its own on `issue/123`.
3. When it hands off, the PR has a "Needs human review" comment listing what the review loop fixed and declined.
   Review and merge it yourself: the plugin never merges.

## How `/cdr:ship-epic` works

1. **Plan.** An Opus coordinator reads the epic, its open sub-issues and their blockers, and orders them into
   stages of up to 3 parallel tracks. A Fable advisor reviews the plan before any code is written.
2. **Setup.** An integration worktree on `epic/N` and one worktree per parallel track, under
   `.claude/worktrees/`, each prepared with the profile's `setup` steps.
3. **Build.** Per issue, an Opus lead plans and then picks and judges every step, up to 10:
   - **Tests first.** `cdr:sonnet-implementer` writes and commits the tests for each Done-when line a test can
     prove, and the lead checks they fail for the right reason. Lines only a smoke run or an owner step can prove
     are marked so in the plan, with why.
   - **Build.** `cdr:sonnet-implementer` makes those tests pass without changing them (it may add cases), and
     `cdr:opus-adversary` tries to break it once its verification is green.
   - **Docs.** `cdr:haiku-documentor` writes the docs from the lead's brief, which names what each doc must tell a
     reader and where any example comes from. The lead checks the docs against the code.
   - **Review.** A coordinator review checks every Done-when line, the tests and the docs before the issue merges
     into `epic/N`.

   The script keeps a journal of each step and the lead's notes, so every lead call sees the plan and what came
   before. Docs only follow code QA has passed, and review only follows checked docs.
4. **Epic check.** Merges the base branch in, runs every gate, checks the epic's own Done-when lines, and a Fable
   advisor reviews the whole diff. A team fixes any gaps.
5. **PR.** Pushes `epic/N` and opens one PR into the base branch, closing every delivered issue.
6. **PR review.** Waits for the AI review and checks, triages each finding against the code, fixes the real ones
   (each with a regression test), and pushes. Up to 5 fix rounds, then a "Needs human review" hand-off.

A run that gets stuck opens no PR and reports what stopped it. Fix that, run it again, and it picks up from
`epic/N`, skipping issues already merged there.

## `.claude/ship-profile.json`

Committed in the repository. In commands, `<wt>` is the worktree the command runs in and `<root>` the main checkout.

| Field | Meaning |
|---|---|
| `repo` | `owner/name` on GitHub. |
| `base` | The branch PRs go into and AI review runs on. |
| `context` | What agents read for domain context, e.g. `CONTEXT.md, the ADRs in docs/adr/`. |
| `docs` | The docs a change may need to update. |
| `setup` | Steps for every new worktree (install, copy untracked tools, a preflight check). |
| `gates.typecheck`, `gates.test`, `gates.build`, `gates.smoke` | Gate commands. Without a smoke suite, set `smoke` to the test command and `smokeWhen` to `never`. |
| `gates.targeted` | How to run named test files (`<files>`). |
| `gates.smokeWhen` | Which changes need the smoke gate. |
| `gates.extra` | Optional `[{ "when", "run" }]`: further gates for some changes. |
| `rules` | Repository-specific rules for every agent (toolchain quirks, long commands). |
| `blockingRules` | Review findings that always block a merge. |
| `review.workflow`, `review.checks` | The GitHub Actions workflow names of the AI review and the checks. |
| `review.runners` | Where they run, for messages (e.g. `the self-hosted runners`). |
| `review.flakes` | Known flaky check failures, which get a rerun instead of a code change. |
| `planNotes` | Optional: a note for the planner (e.g. who else opens PRs). |
| `prBodyModel` | Optional: a PR number whose body the epic PR follows. |
| `contract` | Optional `{ "when", "files", "refresh", "rules" }`: generated contract artifacts (an OpenAPI document, captured examples). When a change matches `when`, the implementer runs `refresh` and commits `files`; the documenter never edits them; QA and review check both. `rules` is optional extra guidance, e.g. where examples come from. |

Example, for a pnpm monorepo:

```json
{
  "repo": "acme/widgets",
  "base": "main",
  "context": "CONTEXT.md, the ADRs in docs/adr/",
  "docs": "README.md, docs/, .env.example",
  "setup": "pnpm -C <wt> install --frozen-lockfile",
  "gates": {
    "typecheck": "pnpm -C <wt> typecheck",
    "test": "pnpm -C <wt> test",
    "targeted": "pnpm -C <wt> exec vitest run <files>",
    "build": "pnpm -C <wt> build",
    "smoke": "pnpm -C <wt> test:e2e",
    "smokeWhen": "the change touches an API route or the checkout flow"
  },
  "rules": ["Long commands (pnpm build, pnpm test:e2e) run in the foreground with the Bash timeout at 600000."],
  "blockingRules": ["a second implementation of behaviour that already exists", "a test that depends on deployed state"],
  "review": {
    "workflow": "ai-review",
    "checks": "ci",
    "runners": "GitHub-hosted runners",
    "flakes": ["the e2e suite's 'browser closed unexpectedly'"]
  },
  "contract": {
    "when": "the change adds or changes an API route, its request or its response",
    "files": ["docs/openapi.json"],
    "refresh": "pnpm -C <wt> openapi:generate",
    "rules": "Response examples come from recorded responses, never typed by hand."
  }
}
```

If you use Claude Code's memory for the repository, the workflow's agents also read the review rules saved there
(`~/.claude/projects/<repo path with non-alphanumerics as ->/memory/MEMORY.md`).

## Behaviour to know about

- **It never merges** and never force-pushes. It pushes `epic/N` or `issue/N` and comments on the PR.
- **No AI attribution:** commits, PR bodies and comments carry no Claude co-author trailer or "Generated with" line.
- **Comment markers:** the loops' own PR comments start with `<!-- pr-review-loop ... -->`, and `wait-review`
  skips them when it collects review comments.
- **Worktrees stay** after a run, under `.claude/worktrees/`, so you can inspect or finish a stuck issue there.

## Updating

```sh
claude plugin marketplace update cdr-kit
claude plugin update cdr@cdr-kit
```

Then `/reload-plugins`. To stay on a release instead of following the latest, add the marketplace pinned to its
tag, for example `claude plugin marketplace add tankcdr/cdr-kit#v0.3.0`. See [CHANGELOG.md](CHANGELOG.md).

Releases bump `version` in `.claude-plugin/plugin.json` and get a matching `vX.Y.Z` tag. `claude plugin update`
compares that version, so a commit without a bump reaches nobody.

## License

[MIT](LICENSE)
