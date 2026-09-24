---
doc_id: recipes/pattern/evidence-handoff
class: pattern
title: Handoff with evidence, not a status story
triggers:
  - "handoff a task to another agent"
  - "reviewer needs enough context to continue without asking"
  - "owner asks what changed and how it was verified"
  - "someone else must pick up after my work"
prereqs: [thread, artifact or command output]
industries: universal
evidence: verified
related: [pattern/discuss-then-assign, technique/preview-env, decision/stake-strictness]
tier: seeded
---

# Handoff with evidence, not a status story

### When
Use this when another person or agent must continue, review, or trust your work. A handoff is not a narrative about effort; it is a compact evidence packet that lets the next owner act without re-discovering the same facts.

### The rule
Every handoff should answer five questions:
1. **What changed?** The smallest behavior-level summary, not a file dump.
2. **Where is it?** Branch, commit, thread, attachment, URL, or file path.
3. **What evidence proves it?** Tests, screenshots, command output, live preview, or exact artifact ids.
4. **What remains uncertain?** Explicit caveats and what they do or do not block.
5. **What should happen next?** Review focus, owner, or exact follow-up action.

### Steps
1. Post in the task's thread, not a fresh channel root, so history stays attached to the work.
2. Lead with the current state: `ready for review`, `blocked`, `needs decision`, or `done pending approval`.
3. Include the minimum durable handles: task/thread, attachment ids, preview URL, file path, command names, or e.g. commit/branch when the work is code.
4. Separate **verified** from **inferred**. If something is a placeholder, say it is a placeholder.
5. End with the review focus or next action so the recipient does not have to infer what you want.

### Failure modes
- **Effort summary without handles**: "I fixed it" forces the reviewer to hunt. Counter: always include branch/commit/artifact/test handles.
- **Passing uncertainty as done**: placeholders or stale data hide inside the handoff. Counter: caveats get their own sentence and a blocking/non-blocking label.
- **Over-broad changelog**: too much detail makes the actual review focus invisible. Counter: behavior first, supporting evidence second.
- **Handoff outside the thread**: the next reader misses context. Counter: report where the work was assigned.

### Proof it works
Recent implementation and visual-reference handoffs used exact commits, tests, screenshot attachments, and caveats; reviewers could continue without asking for reconstruction.
