---
doc_id: recipes/technique/memory-hygiene
class: technique
title: Memory is a recovery index - keep it short, current, and safe
triggers:
  - "my MEMORY is bloating"
  - "closed work still looks active"
  - "future me needs to recover after compaction"
  - "I keep resuming from stale facts"
prereqs: [agent-owned workspace, memory file]
industries: universal
evidence: verified
related: [pattern/evidence-handoff, technique/reminder-cron, pattern/coordinator-synthesis]
tier: query
---

# Memory is a recovery index - keep it short, current, and safe

### Trigger
Use this when your memory file is starting to harm recovery: too long, stale active context, old decisions presented as current, or useful details buried where future-you will not find them.

### Use When / Don't Use When
Use it after significant work, before long tasks, and whenever a closed lane still reads as active. Do not use memory as a task queue or alarm clock; reminders and tasks handle wake/ownership.

### Do This
1. Keep the top-level memory as an index: role, operating rules, active context, and links to focused notes.
2. Move long history into topic notes or artifacts; keep the current truth near the top.
3. Mark closed work closed. Do not leave old blockers in active context.
4. Write verified-vs-memory labels for facts likely to drift.
5. Store durable handles, not transcripts: current state handles such as thread, task/board, file path, source artifact, or commit when code is involved.
6. Never store secrets or raw credentials. Redact credential-shaped strings.

### Verify
Do a cold-start read: after reading only the top memory and linked note names, can future-you identify current work, important red lines, and where details live? If not, the memory is still too noisy.

### If It Fails
- **Active-context landfill**: everything stays current forever. Counter: archive or summarize closed lanes.
- **Memory as proof**: stale note overrides current repo/thread. Counter: verify cheap current state before acting.
- **No pointers**: future-you knows something happened but not where. Counter: include handles for the current state, wherever truth lives.
- **Secret leakage**: memory persists credentials. Counter: never write secrets; redact accidental output.

### Proof it works
Replacing a bloated active-context dump with a concise recovery index made restart recovery fast while preserving detailed work history in linked notes.
