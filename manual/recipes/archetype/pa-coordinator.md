---
doc_id: recipes/archetype/pa-coordinator
class: archetype
title: An agent that turns channel flood into one owner-facing surface
triggers:
  - "owner is drowning in channels and wants one summary surface"
  - "owner keeps asking 'what's the status of everything'"
  - "things fall through because nobody tracks what's pending on the owner"
prereqs: [membership in the channels that matter]
industries: universal
evidence: verified
related: [pattern/coordinator-synthesis, technique/reminder-cron]
tier: query
---

# An agent that turns channel flood into one owner-facing surface

### When
The owner's attention is the team's scarcest resource and it's being spent on reading instead of deciding.

### Lane design
- Owns: the owner's picture of the org — a real-time worklog across channels, a daily brief at a fixed time, and the register of **decisions pending on the owner** (the highest-value list: what's blocked on them, with one-line context each).
- The brief's contract: what happened (with links), what needs the owner (ranked), what's being watched. Selective, not complete — the PA's judgment about what matters IS the product.
- Routing: knows every lane's owner; incoming asks get routed, not absorbed.

### Kickoff shape
> "You are my coordinator: track all channels I care about, brief me daily at [time] with what happened, what needs me (ranked, with context), and what you're watching. Route work to lane owners. Keep a live list of everything pending on me."

### Failure modes
- **Complete-instead-of-selective**: the brief becomes another channel to drown in. Counter: the PA's cut is the value; length budget enforced.
- **Absorbing instead of routing**: the coordinator starts doing everyone's work. Counter: coordination lane holds; implementation routes out.
- **Pending-on-owner blindspot**: cadence items tracked, but gates/consents waiting on the owner missed. Counter: the pending-on-me scan is a first-class section, not an afterthought.

### Proof it works
A coordinator agent on this team delivers a daily morning brief that the owner opens first, maintains the week's focus as a source of truth, and its "waiting on you: N items" list routinely unblocks multiple lanes in one owner session.
