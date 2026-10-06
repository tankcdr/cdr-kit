export const meta = {
  name: 'ship-epic',
  description: 'Ship a GitHub epic (or a single issue): an Opus coordinator (Fable advising) orders its issues into parallel tracks, a team per track builds and QAs each issue, the coordinator reviews and merges it, then one PR into the base branch and up to 5 AI-review fix rounds. Driven by the repo\'s .claude/ship-profile.json.',
  whenToUse: 'An epic whose open child issues are ready to build, or one ready issue, in a repo with a .claude/ship-profile.json. Pass the issue number: /cdr:ship-epic 237 (also #237, epic 237, issue 237).',
  phases: [
    { title: 'Plan', detail: 'load the repo profile; Opus coordinator orders the open child issues into stages of parallel tracks; Fable advises' },
    { title: 'Setup', detail: 'epic branch from the base branch, one worktree per parallel track' },
    { title: 'Build', detail: 'per issue: an Opus lead plans and picks each step; tests first (Sonnet writes them, the lead checks they fail for the right reason), then Sonnet implements against them while Opus QA tries to break it, then Haiku documents from the lead\'s brief and the lead checks it; coordinator review; merge into the epic branch' },
    { title: 'Epic check', detail: 'merge the base branch, full gates, the epic Done when; Fable advises; a team fixes any gaps' },
    { title: 'PR', detail: 'one PR into the base branch' },
    { title: 'PR review', detail: 'wait for the AI review and checks on the self-hosted runners (a check about every 10 minutes), triage, fix, push; up to 5 fix rounds' },
  ],
}

// Run: /cdr:ship-epic 237, or Workflow({name: 'cdr:ship-epic', args: {epic: 237}})
//
// The coordinator is this script plus Opus decision agents: nothing carries between agents except what the
// script passes along. Fable advises at two fixed points (the plan, and the epic before its PR), and the Opus
// agents may spawn the plugin's Fable cdr:advisor subagent for one hard call. Every agent() call names its model
// inline, so no agent inherits the session's model; keep the two Fable calls as top-level awaits outside any loop.
//
// Everything repo-specific (repo, base branch, gates, worktree setup, review rules, the review workflows and
// their known flakes) comes from <main checkout>/.claude/ship-profile.json, which the first agent loads.
// The PR review loop here replaces pr-review-loop's two rounds for the epic PR, reusing the plugin's
// wait-review and its comment markers (wait-review filters out comments that start with <!-- pr-review-loop).

// Settings
const MAX_TEAMS = 3 // parallel tracks in one stage
const TEAM_ROUNDS = 10 // steps per issue (tests, implement + QA, docs, coordinator review), each judged by the lead, before it counts as stuck
const FIX_ROUNDS = 5 // PR review fix attempts
const CHECKS_PER_WAIT = 14 // 8-minute checks per review wait: about 110 minutes, wait-review's own limit
const NO_RUN_CHECKS = 2 // checks in a row without a review run on the head: the review isn't running
const GIT = '/usr/bin/git -c submodule.recurse=false'

// args: 237, '237', '#237', 'epic 237', 'issue 237' or {epic: 237}. GitHub decides which it is: an issue with
// sub-issues ships as an epic, one without ships on its own.
const EPIC = Number(args && typeof args === 'object' ? args.epic : (String(args ?? '').match(/\d+/) || [])[0])
if (!Number.isInteger(EPIC) || EPIC <= 0) throw new Error('ship-epic needs an issue number, e.g. /cdr:ship-epic 237')

// The repo profile: <main checkout>/.claude/ship-profile.json (see the plugin README for its fields).
const STR = { type: 'string' }
const LOADED = { type: 'object', properties: { ok: { type: 'boolean' }, problem: STR, root: STR, home: STR, profileJson: STR, children: { type: 'integer' } }, required: ['ok', 'problem', 'root', 'home', 'profileJson', 'children'] }
phase('Plan')
const loaded = await agent(`Load the ship profile for this repository. Run each command and copy its output exactly.

1. root: dirname of the output of /usr/bin/git rev-parse --path-format=absolute --git-common-dir (the main checkout, also when you start in a worktree).
2. home: echo $HOME
3. profileJson: the full contents of <root>/.claude/ship-profile.json, verbatim. If the file doesn't exist, ok is false and problem says "no <root>/.claude/ship-profile.json"; report the rest anyway.
4. children: gh api repos/<repo>/issues/${EPIC}/sub_issues --paginate --jq length, where <repo> is the profile's "repo" field (0 when the command prints nothing). If gh fails, ok is false and problem is its error.

ok is true when every step worked. Change nothing.`, { model: 'haiku', agentType: 'general-purpose', label: 'load profile', schema: LOADED })
if (!loaded || !loaded.ok) throw new Error('ship-epic could not load the repo profile: ' + (loaded ? loaded.problem : 'the loader returned nothing'))
let P
try {
  P = JSON.parse(loaded.profileJson)
} catch (e) {
  throw new Error(loaded.root + '/.claude/ship-profile.json did not parse as the loader returned it (' + e.message + '); check the file with jq . and re-run')
}
const missing = ['repo', 'base', 'setup', 'gates', 'review', 'docs', 'context', 'rules', 'blockingRules'].filter((k) => P[k] == null)
  .concat(['typecheck', 'test', 'targeted', 'build', 'smoke', 'smokeWhen'].filter((k) => !P.gates || P.gates[k] == null).map((k) => 'gates.' + k))
  .concat(['workflow', 'checks', 'runners', 'flakes'].filter((k) => !P.review || P.review[k] == null).map((k) => 'review.' + k))
  .concat(P.contract ? ['when', 'files', 'refresh'].filter((k) => P.contract[k] == null).map((k) => 'contract.' + k) : [])
if (missing.length) throw new Error(loaded.root + '/.claude/ship-profile.json is missing: ' + missing.join(', '))

const REPO = P.repo
const BASE = P.base
const ROOT = loaded.root // the main checkout: read, never edited
const MEMORY = loaded.home + '/.claude/projects/' + ROOT.replace(/[^A-Za-z0-9]/g, '-') + '/memory/MEMORY.md'
const IS_EPIC = loaded.children > 0
const KIND = IS_EPIC ? 'epic' : 'issue'
const EPIC_BRANCH = KIND + '/' + EPIC
const EPIC_WT = ROOT + '/.claude/worktrees/' + KIND + '-' + EPIC
const REVIEW_WF = P.review.workflow
const CHECKS_WF = P.review.checks
// A gate command with <wt> replaced by the worktree it runs in.
const gate = (name, wt) => P.gates[name].split('<wt>').join(wt)
const extraGates = (wt) => (P.gates.extra || []).map((g) => ' ' + g.when + ': ' + g.run.split('<wt>').join(wt) + ' too.').join('')
// Optional contract artifacts (an OpenAPI document, its captured examples): generated, so the implementer
// regenerates them with the change and nobody edits them by hand, the documenter least of all.
const contractLine = (wt) => P.contract
  ? 'Contract artifacts, generated: ' + P.contract.files.join(', ') + '. When ' + P.contract.when + ', the implementer regenerates them (' + P.contract.refresh.split('<wt>').join(wt) + ') and commits them with the change; nobody edits them by hand.' + (P.contract.rules ? ' ' + P.contract.rules : '')
  : ''

const RULES = [
  'Rules:',
  '- git: ' + GIT + ' -C <worktree> <command>, one git command per Bash call. Never edit the main checkout at ' + ROOT + ' or a worktree that is not yours.',
  '- Never git stash, reset --hard, clean, or checkout/restore paths: other agents share these worktrees and branches, and those commands destroy their work. To run old code, copy the file aside (git show <rev>:<path> into a scratch file) and swap it in by hand.',
  '- No Claude or Claude Code attribution anywhere: no Co-Authored-By trailer, no "Generated with" line.',
  ...P.rules.map((r) => '- ' + r),
  '- Review rules: the feedback entries listed in ' + MEMORY + ' (if it exists); open the ones that touch this change. Always blocking: ' + P.blockingRules.join('; ') + '.',
].join('\n')

// Helpers
const list = (xs) => (xs && xs.length ? xs.map((x) => '- ' + x).join('\n') : '- (none)')
const fixList = (xs) => (xs && xs.length ? xs.map((x) => '- ' + (x.where ? x.where + ': ' : '') + x.problem + (x.fix ? ' Fix: ' + x.fix : '')).join('\n') : '- (none)')
const show = (x) => JSON.stringify(x, null, 2)
const failure = (e) => String((e && e.message) || e)

function need(result, what) {
  if (!result) throw new Error(what + ' returned nothing (skipped, or the agent failed)')
  return result
}

// Merges into the epic branch run one at a time, whichever track finishes first.
let mergeChain = Promise.resolve()
function serialized(fn) {
  const run = mergeChain.then(fn)
  mergeChain = run.catch(() => null)
  return run
}

// Schemas
const STRS = { type: 'array', items: STR }
const INT = { type: 'integer' }
const BOOL = { type: 'boolean' }
const arr = (items) => ({ type: 'array', items })
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) })
const FIX = obj({ where: STR, problem: STR, fix: STR })
const RAN = obj({ command: STR, passed: BOOL, evidence: STR })

const PLAN = obj({
  epicTitle: STR,
  doneWhen: STRS,
  issues: arr(obj({ number: INT, title: STR, scope: STR, doneWhen: STRS, dependsOn: arr(INT) })),
  stages: arr(obj({ tracks: arr(obj({ issues: arr(INT) })) })),
  skipped: arr(obj({ number: INT, reason: STR })),
  rationale: STR,
  risks: STRS,
  issuesFile: STR,
})
const PLAN_ADVICE = obj({ approve: BOOL, changes: STRS, risks: STRS })
const SETUP = obj({ ok: BOOL, problem: STR, stamp: STR, slots: arr(obj({ path: STR, branch: STR })), epicHead: STR, ahead: INT })
const ACCEPT = obj({ line: STR, check: STR, kind: { type: 'string', enum: ['unit', 'smoke', 'none'] }, why: STR })
const DOC_BRIEF = obj({ file: STR, section: STR, reader: STR, source: STR })
const TEAM_PLAN = obj({ base: STR, summary: STR, steps: STRS, files: STRS, acceptance: arr(ACCEPT), verify: STRS, docs: arr(DOC_BRIEF), blocked: STR })
const TESTS = obj({ sha: STR, files: STRS, ran: arr(RAN), failsFor: arr(obj({ test: STR, reason: STR })), blockers: STRS })
const IMPL = obj({ changed: arr(obj({ file: STR, change: STR })), ran: arr(RAN), deviations: STRS, blockers: STRS })
const DOCS = obj({ sha: STR, edited: arr(obj({ file: STR, change: STR })), notDocumented: STRS })
const QA = obj({ items: arr(obj({ severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: STR, problem: STR, fix: STR })), ran: arr(RAN), tried: STR })
const LEAD = obj({ next: { type: 'string', enum: ['tests', 'implement', 'docs', 'review'] }, items: arr(FIX), rejected: arr(obj({ problem: STR, reason: STR })), blocked: STR, summary: STR, note: STR })
const REVIEW = obj({ done: BOOL, criteria: arr(obj({ criterion: STR, met: BOOL, evidence: STR })), gaps: arr(FIX), blocked: STR, ran: arr(RAN) })
const MERGE = obj({ ok: BOOL, problem: STR, commit: STR, epicHead: STR, fastForward: BOOL, conflicts: STRS, ran: arr(RAN) })
const EPIC_CHECK = obj({
  devMerge: STR,
  gates: arr(RAN),
  doneWhen: arr(obj({ line: STR, status: { type: 'string', enum: ['met', 'unmet', 'after-pr', 'out-of-scope'] }, evidence: STR })),
  gaps: arr(FIX),
  diffFile: STR,
})
const EPIC_ADVICE = obj({ ready: BOOL, gaps: arr(FIX), notes: STRS })
const OPEN_PR = obj({ number: INT, url: STR, since: STR, headSha: STR, reused: BOOL })
const WAIT = obj({ exitCode: INT, reportFile: STR, noReviewRun: BOOL, prState: STR })
const TRIAGE = obj({
  actionable: arr(obj({ source: STR, where: STR, problem: STR, fix: STR })),
  declined: arr(obj({ source: STR, reason: STR })),
  reruns: STRS,
  checksGreen: BOOL,
  summary: STR,
})
const PR_FIX = obj({ commits: arr(obj({ sha: STR, finding: STR, test: STR, failsWithoutFix: BOOL })), notFixed: arr(obj({ finding: STR, reason: STR })), ran: arr(RAN) })
const PR_CHECK = obj({ problems: arr(FIX), ran: arr(RAN) })
const PUSHED = obj({ since: STR, headSha: STR, remoteSha: STR, pushError: STR, commentUrl: STR })
const POSTED = obj({ url: STR })

// Prompts
const planPrompt = `You coordinate ${REPO} epic #${EPIC}. Decide which of its child issues to build, in what order, and which can run in parallel. You plan; you write no code.

Read:
- The epic: gh issue view ${EPIC} --json title,body. Its Build order, Not in this epic and Done when sections are constraints.
- ${IS_EPIC ? "Its children: gh api repos/" + REPO + "/issues/" + EPIC + "/sub_issues --paginate --jq '.[] | {number, title, state, labels: [.labels[].name]}'" : 'It has no sub-issues: it is a single issue. Plan it as the only issue (one stage, one track, unless it is delivered or must be skipped), and use its own Done when lines for doneWhen too.'}
- Each open child in full: gh issue view <n> --comments, and its blockers: gh api repos/${REPO}/issues/<n>/dependencies/blocked_by --jq '.[] | {number, state}'
- Work that already exists: ${GIT} -C ${ROOT} fetch origin ${BASE}, then ${GIT} -C ${ROOT} log --oneline origin/${BASE}..${EPIC_BRANCH} (this workflow's branch from an earlier run, if it exists; a child whose commit is there is delivered). Open PRs: gh pr list --state open --json number,title,headRefName,body.${P.planNotes ? ' ' + P.planNotes : ''}
- ${P.context} the children touch, and enough of the code they name to see real dependencies.

Decide:
- Plan only open children. Skip one that is delivered on the epic branch, covered by an open PR, labelled ready-for-human, needs-info or wontfix, or blocked by an open issue outside this epic, and give the reason. Skip whatever depends on a skipped child too.
- The epic's Build order and the native blockers are dependencies. Add any dependency the code shows (a child that imports, extends or tests another's work), recorded or not.
- Shape: stages that run one after another. A stage has 1 to ${MAX_TEAMS} tracks that run at the same time, one team each, each track an ordered list of issues. Put two issues on separate tracks only when neither needs the other's code and they won't rewrite the same files (shared docs are fine: the merge handles them). When unsure, same track: a wrong split costs more than a slower run.
- Every planned issue sits in exactly one track, after everything it depends on (an earlier stage, or earlier in its own track).
- For each planned issue: its scope in two or three sentences, its Done when lines verbatim, and dependsOn (the issues of this epic it needs, planned or delivered).
- doneWhen: the epic's own Done when lines, verbatim.
- issuesFile: write the epic body and every planned child's full body into one markdown file (mktemp) for the advisor who reviews this plan, and give its path.

A call you can't settle from the code (a hidden dependency, a split you doubt): spawn subagent_type "cdr:advisor" (Fable) for that one decision. Spawn nothing else.`

function planAdvicePrompt(p) {
  return `The coordinator of ${REPO} epic #${EPIC} proposes this build plan. Review it before the teams start.

${show({ stages: p.stages, issues: p.issues, skipped: p.skipped, rationale: p.rationale, risks: p.risks })}

The epic and every planned issue in full: ${p.issuesFile}. The code is in ${ROOT}.

Look for: a dependency the plan misses (two parallel tracks where one needs the other's code or both rewrite the same files), an order that builds on something not built yet, a wrong skip, an issue that can't be built as written. approve is false only for a change that matters; list each change concretely (move #n after #m, put #a and #b on one track, unskip #c).`
}

function revisePrompt(p, advice, problems) {
  return `${planPrompt}

You already drafted this plan:
${show(p)}

Revise it. You own the decision: take the advice that holds up against the issues and the code.
The advisor (Fable): ${advice ? show(advice) : '(no advice)'}
Problems in the plan's shape, which you must fix:
${list(problems)}`
}

function setupPrompt(slots) {
  const slotStep = slots
    ? 'stamp: date +%m%d%H%M. For k = 1 to ' + slots + ': ' + GIT + ' -C ' + ROOT + ' worktree add -b ' + EPIC_BRANCH + '-<stamp>-w<k> ' + ROOT + '/.claude/worktrees/' + KIND + '-' + EPIC + '-<stamp>-w<k> ' + EPIC_BRANCH
    : 'No track worktrees this run: stamp is empty and slots is [].'
  return `Set up the worktrees that build ${REPO} epic #${EPIC}.

1. ${GIT} -C ${ROOT} fetch origin ${BASE}
2. The integration worktree ${EPIC_WT}, on branch ${EPIC_BRANCH}:
   - It exists: it must be on ${EPIC_BRANCH}, with an empty git status --porcelain and no merge in progress. Otherwise stop with ok false and say what you found in problem. Keep it as it is; don't reset it.
   - Only the branch exists: ${GIT} -C ${ROOT} worktree add ${EPIC_WT} ${EPIC_BRANCH}
   - Neither: ${GIT} -C ${ROOT} worktree add -b ${EPIC_BRANCH} ${EPIC_WT} origin/${BASE}
3. ${slotStep}
4. In the integration worktree and every track worktree (<wt>; <root> is ${ROOT}): ${P.setup.split('<root>').join(ROOT)}
5. Report ok, problem (empty when ok), stamp, slots in order (path and branch), epicHead (${GIT} -C ${EPIC_WT} rev-parse HEAD) and ahead (${GIT} -C ${EPIC_WT} rev-list --count origin/${BASE}..HEAD).

Touch nothing else: not the main checkout's files, not other worktrees or branches.

${RULES}`
}

const issueBrief = (i) => '#' + i.number + ' ' + i.title + '\n' + i.scope + '\nDone when:\n' + list(i.doneWhen)
const taskSource = (task) => (task.issue ? 'The issue, the source of truth: gh issue view ' + task.issue + ' --comments.' : 'The task:\n' + task.brief)

function teamPlanPrompt(task) {
  const sync = task.sync ? 'First bring it up to date: ' + task.sync + '. If that fails, stop and say so in blocked.\n' : ''
  const epicRead = task.issue ? ' Read it in full, with the decisions in the epic: gh issue view ' + EPIC + ' --json body.' : ''
  const contract = contractLine(task.wt)
  return `You lead the team that builds ${task.key} (${task.title}) for ${REPO} epic #${EPIC}: a Sonnet implementer who also writes the tests, a Haiku documenter and an Opus adversarial QA. You plan now; after every step you judge it and pick the next one. The team works test-first: the tests for the acceptance lines are written and committed before the code, you check they fail for the right reason, and the code is then written to pass them unchanged. The docs come last, from your brief, and you check them against the code.

Worktree: ${task.wt}. Only your team works there.
${sync}Record base: the commit this task builds on, ${GIT} -C ${task.wt} rev-parse HEAD, unless ${GIT} -C ${task.wt} log shows commits from an earlier attempt at this task; then the commit before them. The worktree may also hold uncommitted work from an earlier attempt: check git status and build on what is sound.

${task.brief}
${taskSource(task)}${epicRead}
Read ${P.context} this touches, and the code it names.

Plan:
- summary: what will change, in two sentences.
- steps for the implementer, and files to touch. Name the existing function or module each piece extends: a second implementation of existing behaviour is the worst finding in this repo.${contract ? ' ' + contract + ' Regenerating them is an implementer step, not docs.' : ''}
- acceptance: one entry per Done when line. line: the line verbatim. check: the test or command that proves it. kind: unit when a test written before the code can prove it (the default; the tests step writes these), smoke when only an end-to-end run or a gate can (a whole route through the smoke, a migration, a generated file), none when no check in this repo can (an owner step after deploy, a decision). why: one line for smoke and none, empty for unit.
- verify: exact commands. ${gate('typecheck', task.wt)}; the targeted test files (${gate('targeted', task.wt)}); ${gate('test', task.wt)}; and ${gate('smoke', task.wt)} when ${P.gates.smokeWhen}.${extraGates(task.wt)}
- docs: the brief for the documenter, one entry per doc this changes (${P.docs}). file; section (the heading it goes under, or "new: <heading>"); reader (what a reader of that doc must learn from this change, concretely enough to check the doc against); source (the test, fixture or capture any example or value in it is copied from; empty when the entry has none). An empty list when no doc changes.
- blocked: empty, unless the task can't be built as written (a missing decision, a contradiction with an ADR or the code); then exactly what a human must decide.

${RULES}`
}

const acceptList = (plan) => list(plan.acceptance.map((a) => a.line + ' (' + a.kind + ': ' + a.check + ')'))
const frozenFiles = (tests) => tests.files.join(', ')

function testsPrompt(task, plan, items, tests) {
  const unit = plan.acceptance.filter((a) => a.kind === 'unit')
  const work = tests.sha
    ? 'Your lead sent these items back on the tests committed so far (' + frozenFiles(tests) + '). Fix these only, as new commits:\n' + fixList(items)
    : 'Write the tests for these acceptance lines, and only the tests:\n' + list(unit.map((a) => a.line + ' Proved by: ' + a.check))
  return `Test-first step for ${task.key} (${task.title}), epic #${EPIC}, in worktree ${task.wt}, and only there.
${work}

Your lead's plan, for the names the code will have:
${show({ summary: plan.summary, steps: plan.steps, files: plan.files })}
${taskSource(task)}

- Test files only; no source. A test may import an export the plan says will exist: that import failing is a fair red.
- Each test proves its line: it would fail against a wrong implementation, and it never mocks the thing under test.
- Run every new test and read the output. Each must fail now, and fail because the behaviour is missing: not a typo, a wrong path or a broken fixture.
- Commit before you report: only the test files, "test(<scope>): <what> (${task.issue ? '#' + task.issue : 'epic #' + EPIC})" in the style of ${GIT} -C ${task.wt} log --oneline -15, no co-author trailer.
Report sha (HEAD after your commit), files (every test file you wrote or changed), ran (the commands and their failing output), failsFor (each test and why it fails now) and blockers (an acceptance line you can't test as planned, and why).

${RULES}`
}

function implPrompt(task, plan, items, tests, first) {
  const fixes = first
    ? ''
    : 'Your lead sent these items back. Fix these, and only these:\n' + fixList(items) + '\nA behaviour bug gets a regression test that you show failing with the fix removed (copy the file aside, undo the fix, run the test, put the file back).\n'
  const frozen = tests.sha
    ? 'The tests in ' + frozenFiles(tests) + ' (committed at ' + tests.sha + ') are the spec: make them pass. You may add test cases; you may not change or delete a line of them. One that looks wrong goes in deviations, by name and with why, and your lead decides.\n'
    : ''
  return `Build ${task.key} (${task.title}) for epic #${EPIC} in worktree ${task.wt}, and only there.
${fixes}${frozen}
Your lead's plan:
${show({ summary: plan.summary, steps: plan.steps, files: plan.files, verify: plan.verify })}
Acceptance:
${acceptList(plan)}
${taskSource(task)}

Commit your work before you report, so QA and review see it: stage only this task's files (code, tests${P.contract ? ', the regenerated contract artifacts' : ''}; never build output or .tools), in the style of ${GIT} -C ${task.wt} log --oneline -15, no co-author trailer. ${first ? 'One commit for the build, "<type>(<scope>): <what> (' + (task.issue ? '#' + task.issue : 'epic #' + EPIC) + ')"' : 'One commit per item fixed'}; work an earlier attempt left uncommitted goes in too. Nothing of the task may stay uncommitted.
Run every verify command before you report, and read the output.

${RULES}`
}

function docsPrompt(task, plan, summary, items) {
  const work = items.length
    ? 'Your lead sent these items back on your docs. Fix these only:\n' + fixList(items)
    : "Your lead's brief, one entry per doc to change:\n" + list(plan.docs.map((d) => d.file + (d.section ? ' (' + d.section + ')' : '') + ': ' + d.reader + (d.source ? ' Examples from: ' + d.source : '')))
  return `Document ${task.key} (${task.title}) for epic #${EPIC}. The code is in worktree ${task.wt}: edit files there only, by absolute path, then commit them ("docs(<scope>): <what>", only the doc files you edited, no co-author trailer).
${work}

What the change does: ${summary}
The code: ${GIT} -C ${task.wt} diff ${plan.base}
- Read the code each entry points at before you write. Every claim is something the code or a test shows.
- An example value, request or response is copied from the test, fixture or capture the brief names, never made up. Nothing to copy from: leave the example out and say so in notDocumented.
${P.contract ? '- Never edit ' + P.contract.files.join(', ') + ': they are generated.\n' : ''}Report sha (your commit; empty if you edited nothing), edited and notDocumented.`
}

function qaPrompt(task, plan, tests, items) {
  const again = items.length ? 'Your lead sent these items to the implementer last; check each is really fixed:\n' + fixList(items) + '\n' : ''
  const contract = contractLine(task.wt)
  return `Try to break ${task.key} (${task.title}), built for epic #${EPIC} in worktree ${task.wt} on top of commit ${plan.base}. The changes are committed: ${GIT} -C ${task.wt} log ${plan.base}..HEAD lists them and ${GIT} -C ${task.wt} diff ${plan.base} shows them. Task work left uncommitted (${GIT} -C ${task.wt} status --porcelain) is a major item.
${again}
${taskSource(task)}
Acceptance:
${acceptList(plan)}
Verify commands (run them yourself and read the output):
${list(plan.verify)}
${tests.sha ? 'The tests written first are the spec: ' + GIT + ' -C ' + task.wt + ' diff ' + tests.sha + ' HEAD -- ' + tests.files.join(' ') + ' may only add lines. A changed or deleted assertion is a major item.\n' : ''}${contract ? contract + ' A change to a route, request or response without them regenerated is a major item; so is a hand edit to one.\n' : ''}
Severity: blocker (wrong behaviour, money, security, data loss), major (a Done when not met, a test that proves nothing, a second implementation), minor (worth fixing now, wouldn't block a merge). No style nits.

${RULES}`
}

function leadPrompt(task, plan, round, journal, tests, step) {
  const docsNext = plan.docs.length ? '"docs"' : '"review" (the plan names no docs)'
  const what = {
    tests: () => 'The tests step just reported:\n' + show(step.report) + '\nCheck the tests yourself: ' + GIT + ' -C ' + task.wt + ' diff ' + plan.base + ' HEAD -- ' + (tests.files.join(' ') || '<the files above>') + ', and run them. Each must encode its acceptance line, would fail against a wrong implementation, mocks nothing it tests, and fails now for the right reason: a failed assertion or the missing export the plan names, not a typo, a wrong path or a broken fixture. All sound: next "implement". Otherwise next "tests", with the items.',
    implement: () => 'Implementer:\n' + show(step.impl) + '\nQA: ' + (step.qa ? show(step.qa) : "(skipped: the implementer's verification was not green, or it ran none)") + '\nEach QA item: accept it (real and in scope; check the code when that isn\'t obvious) or reject it with the reason. Failing verification is an accepted item; so is an implementer blocker you can settle (settle it in the item). A deviation that calls a test wrong: read the test. Wrong: next "tests", with the change as the item. Right: it stays, and an item says so. Code accepted (QA ran, verification green, nothing accepted): next ' + docsNext + '. Otherwise next "implement", with the items.',
    docs: () => 'The documenter reported:\n' + show(step.docs) + '\nRead the docs diff yourself (' + (step.docs.sha ? GIT + ' -C ' + task.wt + ' show ' + step.docs.sha : 'nothing was committed') + ') against the code and your brief. An item for each claim the code doesn\'t back, each example or value not copied from a test, fixture or capture, each generated file edited by hand, each brief entry left unwritten without a sound reason. Sound: next "review". Otherwise next "docs", with the items, or "implement" when the docs exposed a gap in the code.',
    review: () => 'The epic coordinator reviewed the task and sent back these gaps. They are binding:\n' + fixList(step.gaps) + '\nRoute them: next is the step that owns them ("tests", "implement" or "docs"), with its gaps as the items. Gaps for another step go in note, for your next round.',
  }[step.kind]()
  return `You lead the team on ${task.key} (${task.title}) in worktree ${task.wt}: a Sonnet implementer who also writes the tests, a Haiku documenter and an Opus adversarial QA. You planned it, and you pick each next step. Round ${round} of at most ${TEAM_ROUNDS}.

Your plan:
${show({ base: plan.base, summary: plan.summary, steps: plan.steps, acceptance: plan.acceptance, verify: plan.verify, docs: plan.docs })}
Tests the code must pass unchanged: ${tests.sha ? frozenFiles(tests) + ' (at ' + tests.sha + ')' : 'none committed yet'}
Earlier rounds, with your notes:
${list(journal)}

This round: ${what}

Report next, items (where, problem, fix; one owner each), rejected (QA items you reject, with the reason), blocked (empty, unless a human must decide something before this can be built; then what), summary (what the change does now, in three sentences, for the PR) and note (what your next round needs that the items don't say).
"review" sends the task to the epic coordinator: only when the code is accepted and the docs are written and checked. An item back for the second time without progress, or a call you can't make: spawn subagent_type "cdr:advisor" (Fable) for that one decision.

${RULES}`
}

function reviewPrompt(task, plan, summary, tests) {
  const contract = contractLine(task.wt)
  return `You coordinate ${REPO} epic #${EPIC}. The team says ${task.key} (${task.title}) is done in worktree ${task.wt}. Check that it is really done before it merges. You didn't build it: trust the code and the commands you run, not the reports.

The changes are committed on top of ${plan.base}: git log ${plan.base}..HEAD and git diff ${plan.base}. Task work left uncommitted (git status --porcelain) is a gap.
${taskSource(task)}
The team's summary: ${summary}
Their verify commands: ${plan.verify.join('; ')}

- Every Done when line: met, with evidence you produced (a test you read and ran, file:line), or not.
- Test-first: ${tests.sha ? 'the tests at ' + tests.sha + ' (' + frozenFiles(tests) + ') encode the acceptance lines, and git diff ' + tests.sha + ' HEAD -- ' + tests.files.join(' ') + ' only adds lines.' : 'the plan wrote no tests first; each acceptance line it marked smoke or none says why, and the reason holds.'}
- Run ${gate('typecheck', task.wt)} and ${gate('test', task.wt)}, and ${gate('smoke', task.wt)} if their verify lists it. Read the output.
- Scope: nothing the task didn't ask for, nothing it asked for missing, no second implementation of existing behaviour (grep for one).
- The docs follow the change, and the code backs every claim in them. An example value not copied from a test, fixture or capture is a gap.${contract ? '\n- ' + contract : ''}
- done: every Done when line met (or left to an owner step after deploy, below) and the gates green. Otherwise the gaps (where, problem, fix) go back to the team.
- blocked: empty, unless a human must decide something before this can merge; then say what. A Done when line that only an owner step after deploy can prove (DNS, a tunnel ingress rule, a live URL, a listing) is not blocked and not a gap: mark it met false with evidence starting "after deploy:" and the exact owner step, and it doesn't stop done.
A gap you're unsure of: spawn subagent_type "cdr:advisor" (Fable) for that one decision.

${RULES}`
}

function mergePrompt(task, slot) {
  const message = task.issue ? '<type>(<scope>): <what it delivers> (#' + task.issue + ')' : 'fix(<scope>): <what> (epic #' + EPIC + ')'
  const commit = 'The team committed the task in ' + task.wt + ' as it went. Read git status: if any of its files (code, tests, docs; never build output or .tools) are still uncommitted, commit them "' + message + '" in the style of git log --oneline -15. No co-author trailer. The task\'s sha is HEAD.'
  if (!slot) return commit + '\n\nReport ok, problem (empty when ok), commit (the sha), epicHead (the same sha), fastForward true, conflicts [] and ran [].\n\n' + RULES
  return `${task.key} (${task.title}) passed review in worktree ${slot.path} (branch ${slot.branch}).

1. ${commit}
2. In the integration worktree ${EPIC_WT} (branch ${EPIC_BRANCH}): ${GIT} -C ${EPIC_WT} merge --no-edit ${slot.branch}. A conflict means another track merged first: keep both sides' intent and never drop the other track's work (doc conflicts are expected).
3. If the merge was not a fast-forward: ${gate('typecheck', EPIC_WT)} and ${gate('test', EPIC_WT)} must pass. Fix whatever the merge broke in ${EPIC_WT} and commit it ("fix(<scope>): <what> after merging #${task.issue}"). A fast-forward keeps the team's verification.

Report ok, problem (empty when ok), commit (the task's sha), epicHead, fastForward, conflicts (each file and how you resolved it), and ran.

${RULES}`
}

function epicCheckPrompt() {
  return `You coordinate ${REPO} epic #${EPIC} (${plan.epicTitle}). Every planned issue is merged into ${EPIC_BRANCH} in worktree ${EPIC_WT}. Check the epic as a whole before it goes to a PR.

1. Bring it up to date: ${GIT} -C ${EPIC_WT} fetch origin ${BASE}, then ${GIT} -C ${EPIC_WT} merge --no-edit origin/${BASE}. Resolve conflicts keeping both sides' intent, and commit. devMerge: what happened.
2. Gates, run in ${EPIC_WT} and read: ${gate('typecheck', EPIC_WT)}; ${gate('build', EPIC_WT)}; ${gate('test', EPIC_WT)}; ${gate('smoke', EPIC_WT)}.${extraGates(EPIC_WT)} (What changed: ${GIT} -C ${EPIC_WT} diff --stat origin/${BASE}...HEAD.)
3. The epic's Done when lines, each met (with evidence: output, file:line), unmet, after-pr (provable only after the PR: closed tickets, checks on ${P.review.runners}) or out-of-scope (the epic hands it to another epic):
${list(plan.doneWhen)}
4. Gaps only the whole shows: an end-to-end path no single issue owned, two issues implementing the same behaviour, docs that contradict each other.
5. diffFile: write ${GIT} -C ${EPIC_WT} diff origin/${BASE}...HEAD into a file (mktemp) for the advisor who reads this next, and give its path.

A failing gate and an unmet line are gaps. Report every gap as where, problem, fix. Fix nothing yourself except merge conflicts in step 1.

Issues delivered:
${list(done.map((d) => '#' + d.number + ' ' + d.title + ' (' + d.commit.slice(0, 9) + ')'))}

${RULES}`
}

function epicAdvicePrompt(check) {
  return `${REPO} epic #${EPIC} (${plan.epicTitle}) is built on ${EPIC_BRANCH} in ${EPIC_WT}; you can read the files there. Its full diff against ${BASE}: ${check.diffFile}. The epic and its issues in full: ${plan.issuesFile}.

The coordinator's check:
${show({ devMerge: check.devMerge, gates: check.gates, doneWhen: check.doneWhen, gaps: check.gaps })}

Issues delivered: ${done.map((d) => '#' + d.number).join(', ') || 'none in this run'}. Skipped by the plan: ${show(plan.skipped)}

Is the epic ready for its PR? Judge the evidence, not the claims: a gate reported green without output, a Done when marked met on a weak argument, an end-to-end path nobody ran, the same behaviour built twice across issues. ready is false only for something the PR must not ship without. List those as gaps (where, problem, fix), leaving out the gaps the check already lists.`
}

function openPrPrompt(check, gapRun) {
  return `Open the pull request for ${REPO} epic #${EPIC} (${plan.epicTitle}) from ${EPIC_BRANCH} into ${BASE}.

1. since: date -u +%Y-%m-%dT%H:%M:%SZ, before you push.
2. ${GIT} -C ${EPIC_WT} push -u origin ${EPIC_BRANCH}
3. An open PR from ${EPIC_BRANCH} already (gh pr list --head ${EPIC_BRANCH} --state open --json number,url)? Update its body with gh pr edit and reuse it (reused true). Otherwise gh pr create --base ${BASE} --head ${EPIC_BRANCH} --title <title> --body-file <file>.
4. Report number, url, since, headSha (${GIT} -C ${EPIC_WT} rev-parse HEAD) and reused.

Title: in the style of gh pr list --state merged -L 8 --json title; what the epic delivers, ending "(epic #${EPIC})".
Body${P.prBodyModel ? ', modelled on PR #' + P.prBodyModel + ' (gh pr view ' + P.prBodyModel + ' --json body)' : ''}:
- One line on what it implements.
- A closing keyword before every issue it delivers: "Closes #a, closes #b, ..." (a comma list closes only the first). Delivered: the issues below, plus any child the plan skipped as already on the epic branch. "Closes #${EPIC}" too only if no open child of the epic is left undelivered. Children it doesn't deliver: "Refs", and why.
- What's in it: one bullet per issue, from the summaries below.
- Deliberate behaviour worth knowing, and known follow-ups, if there are any.
- Verification: the gate results below.
- One line: each issue was built test-first by a team (a lead who planned and judged every step, an implementer, a documenter and an adversarial QA) and reviewed by the epic coordinator before it merged into the epic branch.
No Claude attribution in the title or the body.

The pr-review-loop hook will tell you to hand the review loop to your caller: this workflow runs it. Just report.

Issues:
${show(done)}
Skipped by the plan: ${show(plan.skipped)}
Epic check: ${show({ devMerge: check.devMerge, gates: check.gates, doneWhen: check.doneWhen })}
${gapRun ? 'Gaps fixed after the epic check: ' + gapRun.summary : ''}`
}

function waitPrompt(pr, since) {
  return `Check PR #${pr} once for its AI review. Run this as one Bash command with the timeout at 600000. It polls GitHub by itself for up to 8 minutes; add no sleeps or loops of your own.

f=$(mktemp -t ship-epic-${EPIC}); REPO=${REPO} REVIEW_WORKFLOW=${REVIEW_WF} CHECKS_WORKFLOW=${CHECKS_WF} WAIT_MINUTES=8 wait-review ${pr} ${since} > "$f" 2>&1; echo "exit=$? file=$f"; grep -c "${REVIEW_WF}: no run for this head" "$f"; gh pr view ${pr} -R ${REPO} --json state -q .state

Report exitCode (the number after exit=), reportFile (the path after file=), noReviewRun (true when the grep count is 1 or more) and prState (the last line). Don't read or summarise the file.`
}

function triagePrompt(pr, reportFile, since, round, history) {
  return `Triage review round ${round} of PR #${pr} (${REPO} epic #${EPIC}, branch ${EPIC_BRANCH}, worktree ${EPIC_WT}). ${reportFile} holds the run results on the PR head, then every comment, inline comment and review posted since ${since}. Read all of it.

For each finding the verifier kept, and each comment that asks for a change:
- Check it against the code in ${EPIC_WT} yourself. A verdict is not proof.
- Real: actionable, with source (who raised it, and the finding's id or title), where (file:line), the problem and the fix.
- Not real, or not this PR's job: declined, with source and the file:line evidence.
Findings the verifier dismissed stay dismissed unless you can show they're real.
A failed ${CHECKS_WF} run: gh run view <id> -R ${REPO} --log-failed | tail -200. A known flake (${P.review.flakes.join(', ')}) gets gh run rerun <id> -R ${REPO} --failed and its id goes in reruns; a real failure is actionable.
checksGreen: ${CHECKS_WF} passed on the head.
Earlier rounds, for consistency (a finding declined before stays declined unless this review brings new evidence):
${history.length ? show(history) : '(this is the first round)'}

${RULES}`
}

function prFixPrompt(pr, findings, check) {
  const what = check
    ? 'The fix check found these problems in the fixes you just committed. Fix them as new commits; do not rewrite history:\n' + fixList(check.problems)
    : 'Fix these review findings on PR #' + pr + ', one finding per commit:\n' + fixList(findings)
  return `${what}

Work in worktree ${EPIC_WT} (branch ${EPIC_BRANCH}), and only there.
- Each fix gets a regression test you show failing with the fix removed (copy the file aside, undo the fix, run the test, put the file back). Say "fails without the fix" in the commit message.
- Commit messages in the style of ${GIT} -C ${EPIC_WT} log --oneline -15. No co-author trailer.
- Then ${gate('typecheck', EPIC_WT)} and ${gate('test', EPIC_WT)} must pass, and ${gate('smoke', EPIC_WT)} too when ${P.gates.smokeWhen}.
- Don't push.
- A finding you conclude is wrong: don't fix it; put it in notFixed with the evidence.

${RULES}`
}

function prCheckPrompt(pr, findings, fix) {
  return `Check the fixes just committed on ${EPIC_BRANCH} in ${EPIC_WT} for the review findings on PR #${pr}.

Findings:
${fixList(findings)}
Commits: ${show(fix.commits)}
Not fixed, with the implementer's reasons: ${show(fix.notFixed)}

For each commit: does it fix the finding at its root (grep for a second site with the same behaviour), does its regression test fail without the fix and pass with it, did it break anything? Is each "not fixed" reason sound? Run ${gate('typecheck', EPIC_WT)} and ${gate('test', EPIC_WT)} yourself. problems: what must change (empty when the fixes hold).

${RULES}`
}

const postSteps = (pr, body) => 'Post the comment between the ===== lines exactly as written: write it to a file from mktemp with the Write tool, then gh pr comment ' + pr + ' -R ' + REPO + ' --body-file <file>.\n=====\n' + body + '\n====='

function pushPrompt(pr, body) {
  return `Push the fixes on PR #${pr} and post the round comment.

1. since: date -u +%Y-%m-%dT%H:%M:%SZ, before the push.
2. ${GIT} -C ${EPIC_WT} push origin ${EPIC_BRANCH}. If it fails, stop: post nothing and report the error in pushError.
3. headSha: ${GIT} -C ${EPIC_WT} rev-parse HEAD. remoteSha: ${GIT} -C ${EPIC_WT} ls-remote origin refs/heads/${EPIC_BRANCH} (the first field). Copy both exactly from the command output. If they differ, stop: post nothing and say so in pushError.
4. ${postSteps(pr, body)}

Report since, headSha, remoteSha, pushError (empty when the push landed) and commentUrl.`
}

function roundComment(round, triage, commits, notFixed) {
  const lines = [
    '<!-- pr-review-loop round ' + round + ' -->',
    '**ship-epic review round ' + round + ' of at most ' + FIX_ROUNDS + '.**',
    '',
    'Fixed:',
    list(commits.map((c) => c.sha.slice(0, 9) + ' ' + c.finding)),
    '',
    'Declined:',
    list(triage.declined.map((d) => d.source + ': ' + d.reason)),
  ]
  if (notFixed.length) lines.push('', 'Not fixed:', list(notFixed.map((n) => n.finding + ': ' + n.reason)))
  if (triage.reruns.length) lines.push('', 'Re-ran as known flakes: ' + triage.reruns.join(', '))
  return lines.join('\n')
}

function handoffComment(outcome, rounds, history, open) {
  const why = {
    clean: 'the last review raised nothing to fix.',
    exhausted: 'the review after the last fix round still raised the findings below.',
    unfixable: 'the last round produced no fix for the findings below.',
    'review-timeout': 'the review of the last push did not finish within about 110 minutes.',
    'review-not-running': 'no ' + REVIEW_WF + ' run appeared for the last push; check ' + P.review.runners + '.',
    'push-failed': 'the last fix round did not reach GitHub (see Not fixed); push ' + EPIC_BRANCH + ' and check it.',
  }[outcome] || 'the PR is ' + outcome.replace('pr-', '') + '.'
  const lines = ['<!-- pr-review-loop done -->', '**Needs human review.**', '', 'ship-epic ran ' + rounds + ' fix round(s) on this PR and stopped because ' + why]
  for (const h of history) {
    lines.push('', '**Round ' + h.round + '**', 'Fixed:', list(h.fixed), 'Declined:', list(h.declined.map((d) => d.source + ': ' + d.reason)))
    if (h.notFixed.length) lines.push('Not fixed:', list(h.notFixed.map((n) => n.finding + ': ' + n.reason)))
    if (h.reruns.length) lines.push('Re-ran as known flakes: ' + h.reruns.join(', '))
  }
  if (open.length) lines.push('', '**Still open**', fixList(open))
  return lines.join('\n')
}

function checkPlan(p) {
  const problems = []
  const at = new Map()
  p.stages.forEach((stage, si) => {
    if (stage.tracks.length < 1 || stage.tracks.length > MAX_TEAMS) problems.push('stage ' + (si + 1) + ' has ' + stage.tracks.length + ' tracks; 1 to ' + MAX_TEAMS + ' allowed')
    stage.tracks.forEach((track, ti) => {
      if (!track.issues.length) problems.push('stage ' + (si + 1) + ' track ' + (ti + 1) + ' is empty')
      track.issues.forEach((n, pos) => {
        if (at.has(n)) problems.push('#' + n + ' is in more than one track')
        at.set(n, { si, ti, pos })
      })
    })
  })
  const skipped = new Set(p.skipped.map((s) => s.number))
  for (const issue of p.issues) {
    const mine = at.get(issue.number)
    if (!mine) {
      problems.push('#' + issue.number + ' is planned but in no track')
      continue
    }
    for (const dep of issue.dependsOn) {
      if (skipped.has(dep)) problems.push('#' + issue.number + ' depends on #' + dep + ', which is skipped')
      const theirs = at.get(dep)
      if (theirs && !(theirs.si < mine.si || (theirs.si === mine.si && theirs.ti === mine.ti && theirs.pos < mine.pos))) {
        problems.push('#' + issue.number + ' depends on #' + dep + ', which does not finish before it starts')
      }
    }
  }
  for (const n of at.keys()) {
    if (!p.issues.some((i) => i.number === n)) problems.push('#' + n + ' is in a track but not in issues')
  }
  return problems
}

// One team on one task. The lead plans, then picks each step (tests, implement + QA, docs, coordinator review)
// and judges it. A workflow agent starts fresh every call, so the lead's memory is the journal this loop keeps
// (each round's step, its outcome and the lead's note) plus the plan, both handed to every lead call.
async function teamLoop(task) {
  const plan = need(await agent(teamPlanPrompt(task), { model: 'opus', effort: 'high', agentType: 'general-purpose', label: task.key + ' plan', phase: task.phase, schema: TEAM_PLAN }), task.key + ' plan')
  if (plan.blocked) return { status: 'stuck', reason: 'lead: ' + plan.blocked, rounds: 0 }
  const journal = []
  const tests = { sha: '', files: [] } // the tests written first: the code must pass them with lines only added
  let next = plan.acceptance.some((a) => a.kind === 'unit') ? 'tests' : 'implement'
  let items = []
  let built = false // the implementer has run at least once
  let codeDone = false // QA ran on the code as it stands and the lead accepted it
  let docsDone = !plan.docs.length // the docs match the accepted code
  let summary = plan.summary
  for (let round = 1; round <= TEAM_ROUNDS; round++) {
    const step = { kind: next }
    let outcome
    if (next === 'tests') {
      step.report = need(await agent(testsPrompt(task, plan, items, tests), { model: 'sonnet', effort: 'high', agentType: 'cdr:sonnet-implementer', label: task.key + ' tests ' + round, phase: task.phase, schema: TESTS }), task.key + ' tests')
      if (step.report.sha) tests.sha = step.report.sha
      tests.files = [...new Set(tests.files.concat(step.report.files))]
      outcome = 'tests at ' + (tests.sha.slice(0, 9) || '(none committed)') + ', ' + step.report.failsFor.length + ' failing'
    } else if (next === 'implement') {
      step.impl = need(await agent(implPrompt(task, plan, items, tests, !built), { model: 'sonnet', effort: 'high', agentType: 'cdr:sonnet-implementer', label: task.key + ' implement ' + round, phase: task.phase, schema: IMPL }), task.key + ' implementer')
      built = true
      docsDone = !plan.docs.length
      const green = step.impl.ran.length > 0 && step.impl.ran.every((r) => r.passed) && !step.impl.blockers.length
      step.qa = green ? need(await agent(qaPrompt(task, plan, tests, items), { model: 'opus', effort: 'high', agentType: 'cdr:opus-adversary', label: task.key + ' QA ' + round, phase: task.phase, schema: QA }), task.key + ' QA') : null
      outcome = step.impl.changed.length + ' file(s) changed, verification ' + (green ? 'green, QA raised ' + step.qa.items.length + ' item(s)' : 'not green, QA skipped')
    } else if (next === 'docs') {
      step.docs = need(await agent(docsPrompt(task, plan, summary, items), { model: 'haiku', agentType: 'cdr:haiku-documentor', label: task.key + ' document ' + round, phase: task.phase, schema: DOCS }), task.key + ' documenter')
      outcome = step.docs.edited.length + ' doc(s) edited' + (step.docs.notDocumented.length ? ', ' + step.docs.notDocumented.length + ' left out' : '')
    } else {
      const review = need(await agent(reviewPrompt(task, plan, summary, tests), { model: 'opus', effort: 'high', agentType: 'general-purpose', label: task.key + ' coordinator review', phase: task.phase, schema: REVIEW }), task.key + ' coordinator review')
      if (review.blocked) return { status: 'stuck', reason: 'coordinator: ' + review.blocked, rounds: round }
      if (review.done) return { status: 'done', rounds: round, summary }
      step.gaps = review.gaps
      outcome = 'the coordinator sent ' + review.gaps.length + ' gap(s) back'
      log(task.key + ': ' + outcome)
    }
    const lead = need(await agent(leadPrompt(task, plan, round, journal, tests, step), { model: 'opus', effort: 'high', agentType: 'general-purpose', label: task.key + ' lead ' + round, phase: task.phase, schema: LEAD }), task.key + ' lead')
    if (lead.blocked) return { status: 'stuck', reason: 'lead: ' + lead.blocked, rounds: round }
    if (lead.summary) summary = lead.summary
    next = lead.next
    if (step.kind === 'tests' || step.kind === 'implement') codeDone = step.kind === 'implement' && !!step.qa && (next === 'docs' || next === 'review')
    if (step.kind === 'docs' && next === 'review') docsDone = true
    // Docs and review only follow code QA ran on and the lead accepted; review only follows checked docs.
    if ((next === 'docs' || next === 'review') && !codeDone) next = 'implement'
    if (next === 'review' && !docsDone) next = 'docs'
    items = lead.items
    journal.push('Round ' + round + ', ' + step.kind + ': ' + outcome + '. Next: ' + next + ' with ' + items.length + ' item(s)' + (lead.rejected.length ? ', ' + lead.rejected.length + ' QA item(s) rejected' : '') + '.' + (lead.note ? ' Note: ' + lead.note : ''))
    log(task.key + ': round ' + round + ' (' + step.kind + ') -> ' + next + ', ' + items.length + ' item(s)')
  }
  return { status: 'stuck', reason: 'not done after ' + TEAM_ROUNDS + ' rounds; next was ' + next + ', open: ' + (items.map((f) => f.problem).join('; ') || 'none'), rounds: TEAM_ROUNDS }
}

// One track: its issues in order, each merged into the epic branch before the next starts.
async function runTrack(track, slot) {
  for (let k = 0; k < track.issues.length; k++) {
    const info = plan.issues.find((i) => i.number === track.issues[k])
    const task = { key: '#' + info.number, title: info.title, issue: info.number, brief: issueBrief(info), wt: slot.path, sync: GIT + ' -C ' + slot.path + ' merge --ff-only ' + EPIC_BRANCH, phase: 'Build' }
    let stop = null
    try {
      const r = await teamLoop(task)
      if (r.status !== 'done') {
        stop = r.reason
      } else {
        const m = need(await serialized(() => agent(mergePrompt(task, slot), { model: 'opus', effort: 'medium', agentType: 'general-purpose', label: task.key + ' merge', phase: 'Build', schema: MERGE })), task.key + ' merge')
        if (!m.ok) {
          stop = 'merge: ' + m.problem
        } else {
          done.push({ number: info.number, title: info.title, rounds: r.rounds, commit: m.commit, summary: r.summary })
          log(task.key + ' merged into ' + EPIC_BRANCH + ' (' + m.commit.slice(0, 9) + ', ' + r.rounds + ' team round(s))')
        }
      }
    } catch (e) {
      stop = failure(e)
    }
    if (stop) {
      stuck.push({ number: info.number, title: info.title, reason: stop, worktree: slot.path })
      notStarted.push(...track.issues.slice(k + 1))
      log(task.key + ' is stuck: ' + stop)
      return
    }
  }
}

// Plan
let plan = need(await agent(planPrompt, { model: 'opus', effort: 'xhigh', agentType: 'general-purpose', label: 'coordinator: plan', schema: PLAN }), 'coordinator plan')
const planAdvice = await agent(planAdvicePrompt(plan), { model: 'fable', effort: 'high', agentType: 'cdr:advisor', label: 'advisor: plan', schema: PLAN_ADVICE })
if (!planAdvice) log('The plan advisor returned nothing; going on with the coordinator plan')
let planProblems = checkPlan(plan)
if ((planAdvice && !planAdvice.approve) || planProblems.length) {
  plan = need(await agent(revisePrompt(plan, planAdvice, planProblems), { model: 'opus', effort: 'high', agentType: 'general-purpose', label: 'coordinator: revise plan', schema: PLAN }), 'coordinator revise')
  planProblems = checkPlan(plan)
  if (planProblems.length) return { epic: EPIC, outcome: 'plan-invalid', problems: planProblems, plan }
}
log('Plan: ' + plan.issues.length + ' issue(s) in ' + plan.stages.length + ' stage(s); skipped: ' + (plan.skipped.map((s) => '#' + s.number + ' (' + s.reason + ')').join(', ') || 'none'))

// Setup
phase('Setup')
const slotCount = Math.max(0, ...plan.stages.map((s) => s.tracks.length))
const setup = need(await agent(setupPrompt(slotCount), { model: 'sonnet', effort: 'medium', agentType: 'general-purpose', label: 'setup', schema: SETUP }), 'setup')
if (!setup.ok) return { epic: EPIC, outcome: 'setup-failed', problem: setup.problem }
if (setup.slots.length !== slotCount) return { epic: EPIC, outcome: 'setup-failed', problem: 'asked for ' + slotCount + ' track worktrees, got ' + setup.slots.length }
if (!plan.issues.length && setup.ahead === 0) return { epic: EPIC, outcome: 'nothing-to-ship', skipped: plan.skipped }
const worktrees = [EPIC_WT].concat(setup.slots.map((s) => s.path))

// Build
phase('Build')
const done = []
const stuck = []
const notStarted = []
for (let si = 0; si < plan.stages.length; si++) {
  const stage = plan.stages[si]
  if (stuck.length) {
    notStarted.push(...stage.tracks.flatMap((t) => t.issues))
    continue
  }
  log('Stage ' + (si + 1) + ' of ' + plan.stages.length + ': ' + stage.tracks.map((t) => t.issues.map((n) => '#' + n).join(' > ')).join(' | '))
  await parallel(stage.tracks.map((track, ti) => () => runTrack(track, setup.slots[ti])))
}
if (stuck.length) {
  return {
    epic: EPIC,
    outcome: 'stuck',
    merged: done.map((d) => '#' + d.number + ' ' + d.title),
    stuck,
    notStarted,
    skipped: plan.skipped,
    worktrees,
    next: 'No PR opened. The merged issues are on ' + EPIC_BRANCH + ' in ' + EPIC_WT + '; the work of a stuck issue is committed on its track branch in its worktree. Settle what stopped it (finish it there and merge it into ' + EPIC_BRANCH + ', or fix the issue), then run ship-epic again: it reuses ' + EPIC_BRANCH + ' and skips the issues already on it.',
  }
}

// Epic check
phase('Epic check')
const epicCheck = need(await agent(epicCheckPrompt(), { model: 'opus', effort: 'high', agentType: 'general-purpose', label: 'coordinator: epic check', schema: EPIC_CHECK }), 'epic check')
const epicAdvice = await agent(epicAdvicePrompt(epicCheck), { model: 'fable', effort: 'high', agentType: 'cdr:advisor', label: 'advisor: epic', schema: EPIC_ADVICE })
if (!epicAdvice) log('The epic advisor returned nothing; going on with the coordinator check')
const gaps = epicCheck.gaps.concat(epicAdvice && !epicAdvice.ready ? epicAdvice.gaps : [])
let gapRun = null
if (gaps.length) {
  log('Epic check: ' + gaps.length + ' gap(s); a team fixes them on ' + EPIC_BRANCH)
  const task = { key: 'epic gaps', title: 'gaps the epic check found', issue: null, brief: 'Fix these gaps found when the epic was checked as a whole:\n' + fixList(gaps), wt: EPIC_WT, sync: null, phase: 'Epic check' }
  let r
  try {
    r = await teamLoop(task)
    if (r.status === 'done') {
      const m = need(await agent(mergePrompt(task, null), { model: 'sonnet', effort: 'medium', agentType: 'general-purpose', label: 'epic gaps commit', phase: 'Epic check', schema: MERGE }), 'epic gaps commit')
      if (!m.ok) r = { status: 'stuck', reason: 'commit: ' + m.problem }
    }
  } catch (e) {
    r = { status: 'stuck', reason: failure(e) }
  }
  if (r.status !== 'done') {
    return { epic: EPIC, outcome: 'stuck', merged: done.map((d) => '#' + d.number + ' ' + d.title), stuck: [{ task: 'epic gaps', reason: r.reason, worktree: EPIC_WT }], gaps, worktrees, next: 'No PR opened: the epic check found gaps the team could not close. They are listed in gaps; the work so far is on ' + EPIC_BRANCH + '.' }
  }
  gapRun = { gaps: gaps.length, summary: r.summary }
}

// PR
phase('PR')
const pr = need(await agent(openPrPrompt(epicCheck, gapRun), { model: 'opus', effort: 'medium', agentType: 'general-purpose', label: 'open PR', schema: OPEN_PR }), 'open PR')
log('PR #' + pr.number + (pr.reused ? ' (reused) ' : ' ') + pr.url)

// PR review: wait, triage, fix, push; FIX_ROUNDS fix rounds, then one more review so "still open" is known.
phase('PR review')
let since = pr.since
let fixes = 0
let outcome = null
let lastTriage = null
const history = []
while (!outcome) {
  let w = null
  let noRun = 0
  for (let c = 1; c <= CHECKS_PER_WAIT; c++) {
    w = need(await agent(waitPrompt(pr.number, since), { model: 'haiku', agentType: 'general-purpose', label: 'review wait ' + (fixes + 1) + '.' + c, schema: WAIT }), 'review wait')
    // Only MERGED or CLOSED ends the wait; anything else in prState is a failed gh call, so check again.
    if (w.exitCode === 0 || w.prState === 'MERGED' || w.prState === 'CLOSED') break
    noRun = w.noReviewRun ? noRun + 1 : 0
    if (noRun >= NO_RUN_CHECKS) break
  }
  if (w.prState === 'MERGED' || w.prState === 'CLOSED') {
    outcome = 'pr-' + w.prState.toLowerCase()
    break
  }
  if (w.exitCode !== 0) {
    outcome = noRun >= NO_RUN_CHECKS ? 'review-not-running' : 'review-timeout'
    break
  }
  const t = need(await agent(triagePrompt(pr.number, w.reportFile, since, fixes + 1, history), { model: 'opus', effort: 'high', agentType: 'general-purpose', label: 'triage ' + (fixes + 1), schema: TRIAGE }), 'triage')
  lastTriage = t
  if (!t.actionable.length && !t.reruns.length) {
    outcome = 'clean'
    break
  }
  if (fixes === FIX_ROUNDS) {
    outcome = 'exhausted'
    break
  }
  fixes++
  if (!t.actionable.length) {
    history.push({ round: fixes, fixed: [], declined: t.declined, notFixed: [], reruns: t.reruns })
    log('Review round ' + fixes + ': nothing to fix; re-ran flaky checks ' + t.reruns.join(', '))
    continue
  }
  const f1 = need(await agent(prFixPrompt(pr.number, t.actionable, null), { model: 'sonnet', effort: 'high', agentType: 'cdr:sonnet-implementer', label: 'fix ' + fixes, schema: PR_FIX }), 'fix')
  const chk = need(await agent(prCheckPrompt(pr.number, t.actionable, f1), { model: 'opus', effort: 'high', agentType: 'cdr:opus-adversary', label: 'fix check ' + fixes, schema: PR_CHECK }), 'fix check')
  let f2 = null
  if (chk.problems.length) f2 = need(await agent(prFixPrompt(pr.number, t.actionable, chk), { model: 'sonnet', effort: 'high', agentType: 'cdr:sonnet-implementer', label: 'fix ' + fixes + ' again', schema: PR_FIX }), 'fix again')
  const commits = f1.commits.concat(f2 ? f2.commits : [])
  const notFixed = f1.notFixed.concat(f2 ? f2.notFixed : [])
  history.push({ round: fixes, fixed: commits.map((c) => c.sha.slice(0, 9) + ' ' + c.finding), declined: t.declined, notFixed, reruns: t.reruns })
  if (!commits.length) {
    outcome = 'unfixable'
    break
  }
  const p = need(await agent(pushPrompt(pr.number, roundComment(fixes, t, commits, notFixed)), { model: 'haiku', agentType: 'general-purpose', label: 'push ' + fixes, schema: PUSHED }), 'push')
  const lastSha = commits[commits.length - 1].sha
  if (p.pushError || p.remoteSha !== p.headSha || !(p.headSha.startsWith(lastSha) || lastSha.startsWith(p.headSha))) {
    outcome = 'push-failed'
    history[history.length - 1].notFixed.push({ finding: 'the round ' + fixes + ' fixes did not reach GitHub', reason: p.pushError || 'local ' + p.headSha + ', remote ' + p.remoteSha + ', last fix ' + lastSha })
    break
  }
  since = p.since
  log('Review round ' + fixes + ': ' + commits.length + ' fix commit(s) pushed, ' + t.declined.length + ' declined')
}
const open = outcome === 'exhausted' || outcome === 'unfixable' ? lastTriage.actionable : []
const posted = await agent(postSteps(pr.number, handoffComment(outcome, fixes, history, open)) + '\nReport its url.', { model: 'haiku', agentType: 'general-purpose', label: 'hand off', schema: POSTED })
log('PR #' + pr.number + ': ' + outcome + ' after ' + fixes + ' fix round(s); needs human review')

return {
  epic: EPIC,
  pr: pr.url,
  outcome,
  fixRounds: fixes,
  issues: done.map((d) => '#' + d.number + ' ' + d.title + ' (' + d.rounds + ' team round(s))'),
  skipped: plan.skipped,
  epicGapsFixed: gapRun ? gapRun.gaps : 0,
  stillOpen: open,
  handoff: posted ? posted.url : 'the hand-off comment was not posted',
  worktrees,
  next: 'ship-epic already ran the review loop and posted "Needs human review": do not start pr-review-loop on this PR. After it merges: close its issues and the epic, and delete the remote branch.',
}
