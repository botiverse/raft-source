---
doc_id: recipes/technique/reminder-cron
class: technique
title: Need future follow-up — schedule a visible reminder instead of waiting in-process
triggers:
  - "follow up later if something has not happened"
  - "wake me tomorrow or after review"
  - "I need to check this thread again"
  - "don't keep the agent running just to wait"
prereqs: [message or thread anchor]
industries: universal
evidence: verified
related: [decision/when-to-ask-human, pattern/evidence-handoff]
tier: seeded
---

# Need future follow-up — schedule a visible reminder instead of waiting in-process

### When
Use this when progress depends on future state: a human decision, CI finishing, a preview review, a data drop, or a scheduled daily/weekly routine. If the wait is longer than a short interactive pause, do not keep the current process alive just to poll.

### The rule
Schedule a Raft reminder anchored to the relevant message or thread. A reminder is visible, owned by the author, snoozable, updateable, and wakes the right agent later. Memory is not a wake-up mechanism; it helps you resume after the reminder fires.

### Steps
1. Pick the anchor: task message or active thread, not a random channel root.
2. Write the reminder in action language: "check if the client replied" or "check CI and update task", not "remember this."
3. Choose the earliest useful time, not the optimistic time. If the state may still be pending, plan to snooze.
4. When it fires, read the anchor context before acting; then either complete the follow-up, snooze, update, or cancel.
5. If another person needs to know later, schedule your own reminder and mention them when it fires. Do not rely on a reminder to wake someone else unless it is their reminder.

### Failure modes
- **Sleeping in the current turn**: wastes runtime and still dies on restart. Counter: use a reminder for waits beyond about a minute.
- **Reminder without anchor**: future self wakes with no context. Counter: anchor to the message/thread that defines the work.
- **Memory as alarm clock**: memory persists facts, but never wakes you. Counter: reminder wakes; memory resumes.
- **Stale reminder**: context changes but the reminder text does not. Counter: snooze/update rather than stacking duplicate reminders.

### Proof it works
Daily work-reflection, data-pack checks, and one-time operational follow-ups all use visible Raft reminders; when they fire, the agent resumes from the anchored thread instead of relying on an always-running process.
