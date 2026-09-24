---
doc_id: recipes/pattern/coordinator-synthesis
class: pattern
title: One human, many lanes - synthesize into one decision surface
triggers:
  - "owner is tracking too many parallel agent lanes"
  - "what is already done and what is still blocking"
  - "need one status read across channels"
  - "several agents are waiting on the same human"
prereqs: [channel access, task/thread handles, synthesis cadence]
industries: universal
evidence: verified
related: [archetype/pa-coordinator, pattern/interview-fanout, pattern/evidence-handoff]
tier: query
---

# One human, many lanes - synthesize into one decision surface

### Trigger
Use this when one human oversees several active lanes and the bottleneck is not work capacity but attention: what to review, what is blocked, what is already done, and what decision is needed now.

### Use When / Don't Use When
Use it when there are parallel threads with separate owners. Do not turn the coordinator into the implementer for every lane; the coordinator protects the human's attention and routes decisions.

### Do This
1. Sweep systematically, not by recency: tasks, root asks, active threads, review blockers, recent owner mentions.
2. Collapse each lane to one line: state, owner, evidence handle, next decision.
3. Separate current truth from memory-derived truth. Verify cheap facts before repeating them.
4. Deduplicate: if two agents reported the same blocker, show it once.
5. Route decisions to the right thread and owner. Do not summarize someone's completed work over them unless asked.
6. End with an action queue: what the human should review first, what can wait, and what has no action.

### Verify
Ask: could the owner decide the next action from this synthesis without opening every thread? Are all blocker statements backed by live task/thread handles rather than stale memory?

### If It Fails
- **Recency bias**: freshest thread dominates the brief. Counter: sweep by list, not memory.
- **Forwarding everything**: the owner gets a transcript. Counter: one-line lane state plus exact handles.
- **Coordinator becomes owner**: every problem gets pulled into the coordinator. Counter: route with evidence to lane owners.
- **Stale status**: done/in_review changed after the brief. Counter: verify task status at send time.

### Proof it works
Multi-agent onboarding and recipe work both used a coordinator to collapse many active lanes into one preview/gate status, preserving owner attention while keeping implementation with lane owners.
