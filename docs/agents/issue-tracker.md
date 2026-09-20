# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Scope and interpretation

Use the [source ownership table](documentation.md#信息归属) to locate the current Spec and development roadmap. Read product requirements from the Spec, and stage scope and completion conditions from the roadmap and relevant issues. For historical changes, establish which requirements applied to the change being reviewed.

Read issue state, body, and relevant comments together. Check completion comments and linked PRs when determining progress; a stale body may still describe work as pending. If sources materially conflict, identify their scope and the discrepancy rather than resolving it by date alone.

Issue operations follow the current assignment and applicable workflow. Stage start and handoff conditions remain in the roadmap; reading an issue does not itself start implementation or require creating another issue.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <body-file>`.
- **Read an issue**: `gh issue view <number> --json number,title,state,body,labels,comments --jq '{number,title,state,body,labels:[.labels[].name],comments:[.comments[] | {body,createdAt,url}]}'` to retrieve the issue state, body, labels, and dated comments together.
- **List issues**: `gh issue list --state open --json number,title,state,body,labels,comments --jq '[.[] | {number,title,state,body,labels:[.labels[].name],comments:[.comments[] | {body,createdAt,url}]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside this clone.

For multi-line issue or PR bodies and comments, write the exact text to a UTF-8 file using PowerShell, then pass it with `--body-file`. Use a single-quoted here-string when writing literal content so PowerShell preserves `$` and backticks. To close with a multi-line explanation, post it using `gh issue comment <number> --body-file <body-file>`, then close the issue without duplicating the comment.

## Pull requests as a triage surface

**PRs as a request surface: no.**

This setting controls intake and triage of requests. Reading PRs, reviewing changes, and checking merge results remain available regardless of this setting.

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, retaining only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` author associations.
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit --add-label` or `--remove-label`, and `gh pr close`.

GitHub shares one number space across issues and PRs. For a bare reference such as `#42`, try `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Use the **Read an issue** command under **Conventions** above.

## Wayfinding operations

Use this section only for tasks explicitly using the Wayfinding workflow. Ordinary investigation, planning, implementation, and review follow the current assignment and relevant issue agreements.

The map is a single issue with child issues as tickets.

- **Map**: create one issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog.
- **Child ticket**: link an issue to the map as a GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`. Once claimed, assign the ticket to the driving developer.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database ID obtained with `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. Where dependencies are unavailable, add `Blocked by: #<number>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, excluding assigned tickets and tickets with open blockers. The first remaining ticket in map order wins.
- **Claim**: run `gh issue edit <number> --add-assignee @me`; claiming is the session's first write.
- **Resolve**: comment with the answer, close the issue, and append a context pointer with its link to the map's Decisions-so-far section.
