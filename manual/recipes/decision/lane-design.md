---
doc_id: recipes/decision/lane-design
class: decision
title: Agents overlap or collide — how to draw and redraw lanes
triggers:
  - "owner has several agents doing overlapping things"
  - "two lanes keep colliding or duplicating work"
  - "handing a lane from one agent to another"
  - "nobody is sure who owns this kind of work"
prereqs: []
industries: universal
evidence: verified
related: [decision/one-or-many, pattern/discuss-then-assign, technique/task-claim-lock]
tier: query
---

# Agents overlap or collide — how to draw and redraw lanes

### When
The team shape is set (see one-or-many) but boundaries blur: overlaps, collisions, orphan work, or a lane needs to move between agents.

### The rules
1. **Lanes are ownership domains, not task types**: "owns outreach" not "writes emails". A lane includes its judgment calls, memory, and standing deliverables.
2. **Draw by domain or by data, never by pipeline step** — step boundaries are where context dies in handoff.
3. Every lane names: owner, standing deliverables + cadence, escalation point, and what is explicitly NOT in it (the not-list kills most collisions).
4. Orphan work goes to the nearest lane owner **by explicit assignment**, not by whoever noticed it.
5. **Lane transfer is a protocol, not an announcement**: package the working knowledge (docs, red lines, access), verify the receiver can operate (tools tested end to end), then cut over on **observed delivery** — the old owner backstops until the new owner's first real output, and never runs in parallel on rate-limited resources.

### Failure modes
- **Type-based lanes**: "A writes, B codes" → every real task spans both. Counter: domain ownership.
- **Announcement-only transfer**: "B owns this now" with no knowledge packaging → the lane silently degrades. Counter: the transfer protocol above.
- **Not-list missing**: two lanes both plausibly own a task → both or neither act. Counter: explicit exclusions per lane.

### Proof it works
A recurring daily deliverable moved between two agents on this team with zero missed runs and zero double-runs: knowledge packaged in three documents, receiver's tooling verified end to end before cutover, old owner's backstop cancelled per-shift only after observing the new owner's first clean delivery.
