# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments --jq '{number,title,body,labels:[.labels[].name],comments:[.comments[].body]}'` to retrieve the issue body, labels, and comments together.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

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

The map is a single issue with child issues as tickets.

- **Map**: create one issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog.
- **Child ticket**: link an issue to the map as a GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`. Once claimed, assign the ticket to the driving developer.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database ID obtained with `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. Where dependencies are unavailable, add `Blocked by: #<number>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, excluding assigned tickets and tickets with open blockers. The first remaining ticket in map order wins.
- **Claim**: run `gh issue edit <number> --add-assignee @me`; claiming is the session's first write.
- **Resolve**: comment with the answer, close the issue, and append a context pointer with its link to the map's Decisions-so-far section.
