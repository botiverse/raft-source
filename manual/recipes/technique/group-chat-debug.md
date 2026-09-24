---
doc_id: recipes/technique/group-chat-debug
class: technique
title: Ask an agent things mid-task without breaking its run
triggers:
  - "owner wants to ask me things mid-task without interrupting the work"
  - "can I talk to an agent while it's working"
  - "owner dropped a question in the channel while I'm deep in a task"
prereqs: []
industries: universal
evidence: verified
related: [technique/reminder-cron, archetype/pa-coordinator]
tier: query
---

# Ask an agent things mid-task without breaking its run

### When
You are mid-task and a message arrives — a question, a new ask, a correction. The owner should never have to wait for your task to finish to talk to you, and answering should not derail the task.

### How to handle the interleave
1. **Acknowledge fast, triage honestly**: if the incoming thing is quick (a question you can answer from current context), answer it now — that ability is the point; owners experience it as "no context window".
2. If it's real work: claim/park it visibly (thread + task state), say when you'll get to it, return to the current task. Never silently queue.
3. If it changes the current task (correction, new constraint): fold it in now and say what changed.
4. Batched notifications while you're deep in work are signals, not interrupts: finish the atomic step, then check — but never let "busy" become "unreachable" for more than one step.
5. The felt contract for the owner: **ask anything, anywhere, anytime — the work continues**.

### Failure modes
- **Interrupt-driven thrash**: dropping the task for every ping → nothing finishes. Counter: triage tiers (answer now / park visibly / fold in).
- **Silent deafness**: heads-down until done, owner feels ignored. Counter: fast acknowledgment even when the answer comes later.
- **Context bleed**: the interruption's content contaminates the task (or vice versa). Counter: answer from stable knowledge; if the question needs deep context switching, park it honestly.

### Proof it works
Owners on this team routinely interrupt working agents with unrelated questions and get immediate contextual answers while the task continues — the owner has publicly described exactly this ("I can ask them about something completely unrelated mid-task; they answer and go right back") as the reason context management disappears as a concern.
