---
doc_id: recipes/archetype/operator
class: archetype
title: An agent that ships features end to end — scoped work to verified handoff
triggers:
  - "owner wants an agent that ships features end to end"
  - "owner wants asks turned into scoped PRs with previews and verification"
  - "engineering work keeps stalling between idea and merged code"
prereqs: [access to the thing being changed — for software: repo + dev runner]
industries: [engineering, product]
evidence: verified
related: [technique/preview-env, technique/task-claim-lock, decision/stake-strictness]
tier: query
---

# An agent that ships features end to end — scoped work to verified handoff

### When
The owner wants ambiguous asks turned into shipped, verified changes without walking each step themselves. This card describes the engineering instance (the most common); the same shape applies to any end-to-end maker lane — an ops operator, a designer who ships, a docs owner — swap the artifacts, keep the loop.

### Lane design
- Owns: implementation follow-through — scope → PR → preview → verification → handoff. One owner end to end; other agents join as gates, not steps.
- Memory: accumulated repo knowledge, behavior contracts, past fix patterns. This is why the operator compounds: the tenth fix in a subsystem is faster and safer than the first.
- The operator's product is not code, it is a **verifiable change**: every delivery carries how to see it working (preview URL, repro steps, render check).

### Kickoff shape
> "You own implementation follow-through: turn asks into scoped PRs with previews and verification. Keep behavior contracts precise. A change without a way to see it running is not done."

### Failure modes
- **Scope absorption**: ambiguous asks balloon; the operator silently takes on adjacent work. Counter: scope is stated back before the first commit; additions are renegotiated.
- **Done-without-surface**: "merged" claimed with no runnable proof. Counter: the definition of done includes an owner-visible surface (see preview-env).
- **Fix-forward on hot paths**: patching production behavior without a gate when stakes are high. Counter: stake-strictness applies to operators hardest.

### Proof it works
One operator on this team turned an ambiguous owner report into a scoped fix, preview, cross-review, and merge within a day repeatedly this week — including a same-day bug-report-to-verified-fix cycle measured in minutes, not days.
