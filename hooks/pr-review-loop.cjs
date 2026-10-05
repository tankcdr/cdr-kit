#!/usr/bin/env node
// pr-review-loop.cjs - PostToolUse [Bash]
// After `gh pr create` opens a PR in the repo that <main checkout>/.claude/ship-profile.json names, tells the session
// that opened it to run the cdr:pr-review-loop skill: wait for the AI review and checks, act on them, push, once more,
// then post that the PR needs human review. A subagent that opens a PR hands the loop to its caller rather than
// blocking on the runners for up to two hours.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (input.tool_name !== 'Bash') process.exit(0);
// Loose on purpose: the rtk hook may have rewritten the command (`rtk gh pr create ...`).
if (!/\bgh\s+pr\s+create\b/.test(String((input.tool_input || {}).command || ''))) process.exit(0);
const m = JSON.stringify(input.tool_response ?? '').match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
if (!m) process.exit(0);

let profile;
try {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  profile = JSON.parse(fs.readFileSync(path.join(path.dirname(common), '.claude', 'ship-profile.json'), 'utf8'));
} catch { process.exit(0); } // not a git checkout, or no profile: this repo doesn't use the loop
const [, repo, pr] = m;
if (repo.toLowerCase() !== String(profile.repo).toLowerCase()) process.exit(0);

const url = `https://github.com/${repo}/pull/${pr}`;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext:
      `PR #${pr} (${url}) was just opened. Run the PR review loop on it now: invoke the cdr:pr-review-loop skill ` +
      `and follow it (two rounds of wait for the AI review and checks, act, push; then post that the PR needs human review). ` +
      `Start round 1's wait in the background before you report back. ` +
      `If you are a subagent, don't run the loop: put "PR #${pr}: run the cdr:pr-review-loop" in your final report and let your caller run it.`,
  },
}));
