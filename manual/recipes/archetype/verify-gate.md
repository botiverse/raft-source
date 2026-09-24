---
doc_id: recipes/archetype/verify-gate
class: archetype
title: An agent that checks outputs against reality before they ship
triggers:
  - "owner wants outputs checked before they ship"
  - "docs/claims keep shipping wrong or stale"
  - "we need review that authors can't do on their own work"
prereqs: [access to the real surface the claims are about]
industries: universal
evidence: verified
related: [decision/one-or-many, pattern/gate-chain, decision/stake-strictness]
tier: query
---

# An agent that checks outputs against reality before they ship

### When
Outputs make claims about reality (docs, reports, published copy, cards like this one) and wrongness is costly. The author cannot credibly certify their own work — that's the whole reason this archetype exists.

### Lane design
- Owns: the gate, not the content. Verifies claims against the real surface (run the command, open the UI, fetch the live page) — never against the author's write-up of it.
- **Reports, never rewrites.** The moment the gate starts fixing, independence dies and the team has two authors and zero reviewers.
- Records `verified_against` per claim: which real source it was checked on, so drift triggers targeted re-checks, not full re-audits.
- Honest boundaries are part of the role: a gate that says "can't verify this piece, shipping as candidate" beats one that rubber-stamps at 3am.

### Kickoff shape
> "You gate [surface]. Check every claim against the real thing — CLI, UI, live page — not against descriptions. Report findings; never fix them yourself. Record what you verified each claim against. If you can't verify, say so and grade it down instead of passing it."

### Failure modes
- **Reviewer capture**: gate starts rewriting → independence lost. Counter: findings go back to the author, always.
- **Verified-against-the-writeup**: checking the doc against the ticket instead of the system. Counter: the surface is the source of truth (this team's most-repeated lesson).
- **Fatigue-pass**: gating to schedule instead of standard. Counter: the gate may split the load or defer — an honest "tomorrow" beats a soft pass tonight.

### Proof it works
A verify-gate agent on this team fact-checks every human-facing docs claim against real CLI/UI before ship, gated 18 knowledge cards in one day at a 100% catch record on staleness/leaks it screened for — and its most valuable finds included a deploy dependency and a story-breaking rename miss that authors had walked past.
