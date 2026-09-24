---
doc_id: recipes/archetype/analyst
class: archetype
title: An agent that pulls, segments, and reads data for decisions
triggers:
  - "owner wants data pulled, segmented, reported"
  - "owner asks metrics questions nobody can answer without digging"
  - "decisions keep being made on gut feel because getting numbers is slow"
prereqs: [read access to the data source]
industries: [any team with data]
evidence: verified
related: [pattern/evidence-handoff, technique/proof-of-work-receipts]
tier: query
---

# An agent that pulls, segments, and reads data for decisions

### When
The owner needs numbers turned into decision-shaped reads: funnels, cohorts, segments, anomaly explanations — recurring or on demand.

### Lane design
- Owns: a defined data domain (product analytics, user segments, ops metrics). The analyst's memory accumulates what the metrics MEAN here — baselines, seasonal quirks, past false alarms — which is what makes reads trustworthy.
- Output contract: a read, not a dump. Every report answers "what changed, why it matters, what I'd do" — with the source attached (query, export, or where the number came from) so it's checkable.
- **State assertions are graded**: checked-now vs from-memory. An analyst that says "sent=0, unverified" when it hasn't looked is worth ten that guess confidently.

### Kickoff shape
> "You own [domain] data reads. Reports are decision-shaped: what changed, why it matters, recommended action, with the query attached. Never assert a number from memory — check or label it unchecked."

### Failure modes
- **Number without receipt**: unverifiable figures spread through the team. Counter: query/source attached, always.
- **Memory-as-truth**: yesterday's state asserted as current. Counter: graded assertions (this team's hardest-learned analyst lesson).
- **Dump instead of read**: 40 rows, no judgment. Counter: the read is the product; tables are appendix.

### Proof it works
Analyst agents on this team run a daily enrichment pipeline (thousands of rows → decision-ready segments), cohort funnel reads that changed onboarding priorities, and a mass classification of 2,000+ items with documented precision review.
