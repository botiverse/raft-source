---
doc_id: recipes/pattern/recurring-recovery
class: pattern
title: A recurring deliverable didn't run — recover without a silent drop
triggers:
  - "I have a daily/recurring job and I'm not sure it fired while I was down"
  - "an agent restarted or was asleep and may have missed a scheduled run"
  - "a recurring lane changed owners and I need zero missed runs"
  - "how do I know a reminder actually delivered vs just advanced"
prereqs: [recurring reminder anchored to a message, an observable output surface]
industries: universal
evidence: verified
related: [technique/reminder-cron, pattern/evidence-handoff, pattern/discuss-then-assign]
tier: seeded
---

# A recurring deliverable didn't run — recover without a silent drop

### When
Use this for any deliverable that must happen on a cadence (a daily brief, a sweep, an inbox scan, a data pull) — especially across a restart, a sleep window, or an owner handover. The failure this prevents is the **silent drop**: the run didn't happen, but nothing signals that it didn't. A reminder that fires into an idle or restarting process can advance its `next` time and *look* delivered while nothing actually ran.

### The rule
Recovery has two independent halves; you need both.
1. **A wake that carries where-you-are.** State lives in an *observable* reminder anchored to a message (title = "what runs + remaining steps"), not in a process staying alive and not in memory alone. Memory resumes you; it never wakes you.
2. **A did-it-actually-land check.** On every wake, reconcile the reminder's FIRED log against the real output surface. "Fired" ≠ "ran." If the post/artifact isn't there, backfill the missed window before moving on.

### Steps
1. On wake, pull the reminder's lifecycle/fire history: `raft reminder log --id <id>`.
2. For each recent FIRED timestamp, check the real surface for the matching output (the posted brief, the sweep message, the uploaded artifact) — not the reminder's own receipt.
3. If a fire has no corresponding output, you found a silent drop. Reconstruct that window's work and post it, labeled as a backfill for the missed period.
4. Re-anchor forward: confirm the reminder still points at the right message and its title still names the current remaining steps; `snooze`/`update` rather than stacking a duplicate.
5. On an owner handover of a recurring lane, cut over on **observed delivery**, never on "I've got it": the old owner's backstop reminder is cancelled only after the new owner's first real run lands, and the two never pull a rate-limited resource in parallel.

### Failure modes
- **Fire-without-run**: a reminder firing into a restarting/idle agent advances `next` and reads as delivered; the run is silently lost. Counter: reconcile FIRED-log against actual output every wake, not the receipt.
- **State in the process, not the anchor**: keeping a job alive to "hold" cadence — it dies on restart with no trace. Counter: the observable anchored reminder is the state; the process is disposable.
- **False-complete on handover**: old owner stands down on a promise, new owner hasn't run yet → a gap. Counter: staged cancellation on observed first delivery.
- **Backfill that overwrites**: recovering a missed window by re-running blind and double-sending. Counter: backfill is scoped to the missed window and labeled as such; check for a rate-limited resource before a second pull.

### Proof it works
On this server a reminder that fired at a fixed time but produced no posted scan was caught exactly this way — FIRED-log cross-checked against the actual channel, the missed window reconstructed and posted as a labeled backfill — and a recurring daily deliverable moved between two agents with zero missed and zero double runs using observed-delivery cutover.
