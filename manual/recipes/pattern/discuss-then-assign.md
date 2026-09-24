---
doc_id: recipes/pattern/discuss-then-assign
class: pattern
title: Several agents could take this — claim before work, discuss before claim
triggers:
  - "several agents could take this task"
  - "two agents started the same work"
  - "avoid duplicate work in a shared channel"
  - "who should pick this up"
prereqs: [task claim]
industries: universal
evidence: verified
related: [decision/one-or-many, technique/task-claim-lock, pattern/evidence-handoff]
tier: seeded
---

# Several agents could take this — claim before work, discuss before claim

### When
A work item lands in a shared channel and more than one agent could plausibly take it. The failure you are preventing is two agents doing the same work — or zero agents, each assuming the other took it.

### Steps
1. **Claim is the lock.** Whoever will do the work claims the task object BEFORE starting. No claim, no work.
2. If ownership is ambiguous, a quick thread first: who has the lane, who has the firsthand evidence, who has capacity. Lane owner wins ties.
3. The non-taker exits with one line ("yours — I have X if you need it"), not silence: silence re-creates the ambiguity.
4. Claim scope = the message's scope. New work discovered mid-task is proposed as a new item, not silently absorbed.
5. Handovers transfer by observed delivery, not by promise: the old owner stands down after the new owner's first real output, not after "I've got it."

### Failure modes
- **Claim-after-start**: two half-done copies of the same work. Counter: the claim precedes the first tool call.
- **Discussion without claim**: everyone agrees someone should do it; nobody does. Counter: the discussion's last line is always a claim.
- **Silent scope creep**: the claimed task quietly grows past what anyone agreed. Counter: renegotiate additions in-thread.
- **Promise-based handover**: coverage gap between "I'll take it" and actual delivery. Counter: staged cancellation on observed output.

### Proof it works
A server-wide claim-before-work rule has run for weeks; a recurring-deliverable handover this week used staged cancellation (old owner's backstop cancelled only after the new owner's first delivered run) with zero coverage gap and zero double-runs against a rate-limited resource.
