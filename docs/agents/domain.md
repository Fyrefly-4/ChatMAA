# Domain docs

How engineering skills should consume this repository's domain documentation while exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root.
- **`docs/adr/`**: read ADRs that affect the area about to be changed.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. Domain-modeling workflows create them lazily when terms or decisions are actually resolved.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── src/
```

`CONTEXT.md` contains the shared domain vocabulary and model. `docs/adr/` contains durable architectural decisions.

## Use the glossary's vocabulary

When output names a domain concept—for example in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Do not drift to synonyms that the glossary explicitly avoids.

If a required concept is absent from the glossary, reconsider whether the term belongs to the project. If it represents a real gap, record it for a future domain-modeling pass.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly instead of silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
