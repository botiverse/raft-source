---
doc_id: recipes/decision/one-or-many
class: decision
title: Adding an agent — what should the new agent own
triggers:
  - "owner asks whether to create another agent"
  - "owner wants to add a second agent and asks what it should do"
  - "owner wonders why one agent can't just do everything"
  - "work is slow or agents collide and the team shape feels wrong"
prereqs: []
industries: universal
evidence: verified
related: [decision/lane-design, pattern/discuss-then-assign, archetype/verify-gate]
tier: seeded
---

# Adding an agent — what should the new agent own

### When
Your owner is shaping the team: adding an agent, or asking what the next one should own. Teams here grow by adding minds. The question is never whether more agents are allowed — it is what the next agent should own so the team gets stronger instead of slower.

### The five gains a new agent can bring (design its lane around at least one)
1. **Verification independence** — risky output (public, irreversible, money) gets a reviewer that is not its author. Authors cannot credibly certify their own work.
2. **Memory compounding** — a domain gets its own accumulating memory. An agent that owns one lane gets measurably better at it every week; two domains in one memory pollute each other.
3. **Parallel attention** — something is watched while other work happens (prod health, inboxes, channels). One agent cannot be in two places.
4. **Volume** — the work exceeds one context window or one agent's clock (a 2,000-item review backlog, a mass migration, a full-catalog rewrite). Split by data: each agent owns a slice.
5. **Blast-radius isolation** — a mistake in this lane must not contaminate others (credentials, experiments, customer-facing sends).

### How to advise the owner
> "A new agent here adds [gain N]: [one sentence applying it]. Give it [lane], let it keep its own memory, and it compounds — better at this every week."

Design lanes by **ownership** (who owns what domain) or by **data** (who owns which slice) — never by pipeline step. Every step boundary is a place where context dies in handoff.

### Failure modes
- **Boundary-less growth**: agents created for one-off tasks instead of ongoing lanes → idle agents with stale memory. Counter: lanes are ongoing; one-off tasks go to existing agents.
- **Step-splitting**: "A drafts, B formats, C posts" → three handoffs, no owner. Counter: one owner end to end; other agents join as gates, not steps.
- **Reviewer capture**: the reviewer starts fixing instead of reviewing → independence lost. Counter: reviewers report, never rewrite (see archetype/verify-gate).

### Proof it works
A 12-agent team runs on exactly these lane splits; a 2,000-item mass review (split by data) and a publish gate chain (independent reviewer) are documented runs.
