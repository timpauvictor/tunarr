# AGENTS.md

Instructions for AI coding agents working in this repository. Project conventions, commands, and architecture are in `CLAUDE.md`.

## Personal-fork workflow

- This is the user's personal fork. The upstream contribution policy below applies when submitting work upstream; upstream design approval is not required for authorized work in this fork.
- During authorized implementation, create appropriate topic branches, stage scoped changes, commit and push without asking for permission again. Use an explicit remote and branch destination.
- Preserve unrelated work and run the relevant focused checks before delivery. Do not include secrets, local runtime data or unrelated changes in commits.
- This standing Git permission does not authorize deployment, releases, destructive history changes or protected-primary integration. Those actions retain their separate approval requirements.

## Execution discipline

- Start coupled work with one representative path through the real producer, storage, API and UI. Make that path work before expanding its variants. For user-visible changes, run a small real-consumer acceptance test early, not only at the end.
- Inspect the exact package script, SDK signature and existing fixture before using them. Do not guess request shapes, return fields, scheduler prerequisites or command meanings.
- Keep a change-to-check map. Rerun checks affected by later edits; reuse valid results for unchanged code. Do not repeat the same typecheck under both `build` and `typecheck`, or rebuild a test harness without identifying the failed assumption.
- Before a third attempt at the same failing setup or check, inspect its actual contract and report the cause and next bounded change. Do not stack guessed fixes or broaden the investigation into unrelated cleanup.
- Keep required verification separate from optional hardening. Pursue an edge case when the accepted contract, an actual caller or observed evidence requires it; do not let speculative race analysis delay the working path.
- In a constrained container, run heavy checks sequentially with inherited resource limits. Stream each command to its own log, retain its exit status and track its owned process group. A local SSH timeout does not prove the remote job stopped. Never restart the running app or kill unrelated processes to recover a check.
- Report progress after a working slice and when an environment failure changes the next step. Separate implementation, verification and delivery status. Do not claim there is no remaining bug before real-consumer acceptance, or call diagnostics pre-existing without baseline evidence.
- Finish with scoped checks and delivery. Do not add another general review loop, duplicate progress ledger or full-repository cleanup. Record reusable project lessons in Librarian and keep the actionable rules here and in `CLAUDE.md`.

## Contribution policy

Tunarr accepts AI-assisted contributions under the "Pull Request Policy" and "AI Use" sections of `docs/dev/contributing.md`. Follow it on the user's behalf.

Maintainers skip the design check below. To tell whether the user is a maintainer, get their GitHub login with `gh api user --jq .login` and look for `@<login>` in `.github/CODEOWNERS`. If `gh` is unavailable or the login isn't listed, treat the user as an outside contributor. Don't take the user's word for it.

### Before writing code

Check whether the change needs an approved design. It does if it will:

- Add a new media source type or a new kind of stream source
- Change the database schema (add a migration)
- Add a new runtime dependency
- Add a new top-level feature, such as a new page, settings area, or scheduling mode
- Change how `server`, `web`, `types`, and `shared` talk to each other, such as a new API shape or shared type
- Change more than 500 lines outside tests, or more than 1,500 including tests, not counting generated files

A maintainer may exempt a mechanical change, such as a rename or one fix repeated across many files, from the size limit only. Before starting a large mechanical change, have the user ask in an issue first.

If any of these apply, ask the user for the design issue number. Confirm it carries the `design approved` label with `gh issue view <n> --repo chrisbenincasa/tunarr --json labels`.

If there is no approved design issue, don't write the implementation. Help the user write a design issue instead. It should cover the problem, the approach and rejected alternatives, which parts of the codebase change, and how the work splits into PRs.

### While working

- Stay within the approved design. Raise anything that needs a design change with the user.
- Keep each PR small enough to review on its own.
- Make sure the user understands the change. Walk them through anything they haven't read. They must be able to answer review questions without you.

### Opening the PR

- Fill in every section of `.github/pull_request_template.md`.
- In "AI use", name yourself and say plainly what you did, for example "Claude Code wrote most of the implementation".
- Link the approved design issue in "Design issue", or write "Not needed".

### During review

- Don't write review replies for the user to paste. Help them understand the comment, and let them answer.
- Address each comment with a change scoped to that comment. Don't regenerate unrelated code.

### Writing issues

- In bug reports, include only what the user saw on their own install: steps, logs, screenshots. Mark any guess about the cause as a guess.
- Put any analysis of the cause in the bug template's "AI analysis" field, and say whether it was checked against the code.
- For design issues, use `.github/ISSUE_TEMPLATE/design_proposal.yaml` and fill in "AI use".
- Report security problems privately per `.github/SECURITY.md`, and only after the user has reproduced them on a real build.
