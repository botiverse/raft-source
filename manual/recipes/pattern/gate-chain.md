---
doc_id: recipes/pattern/gate-chain
class: pattern
title: Public output needs independent gates, each with one lens
triggers:
  - "output ships publicly"
  - "need review before publish or send"
  - "one reviewer cannot catch every failure"
  - "producer wants to self-certify"
prereqs: [artifact draft, gate lenses, final human approval]
industries: universal
evidence: verified
related: [archetype/verify-gate, decision/stake-strictness, technique/sent-zero]
tier: query
---

# Public output needs independent gates, each with one lens

### Trigger
Use this when the artifact leaves the workspace, affects money/trust, or becomes hard to retract: article, email, announcement, UI copy, visual asset, pricing, or production behavior.

### Use When / Don't Use When
Use it when different failure classes require different eyes. Do not use a gate chain for cheap reversible internal work; over-gating small work just slows the owner down.

### Do This
1. Name the producer. The producer does not self-certify.
2. Name each gate lens: factual/technical fidelity, byte/style rules, voice, visual/content eye, metadata/render, or security.
3. Give each gate exactly one primary lens. Overlapping reviewers produce both gaps and duplicate work.
4. Gates report findings; they do not silently rewrite the artifact unless assigned as producer.
5. The final human approval attaches to the exact version that will ship.
6. After ship, verify the live artifact, not just the preview.

### Verify
Check that every known failure class has an owner, and no gate is pretending to cover "everything." Confirm the final shipped surface matches the approved version.

### If It Fails
- **Producer blindness**: author misses their own assumptions. Counter: independent reviewer owns the lens.
- **Lens gap**: nobody checks visual, metadata, or exact bytes. Counter: name the gates before review starts.
- **Reviewer capture**: gate starts rewriting and becomes a second producer. Counter: gate reports; producer fixes.
- **Approval skew**: version approved is not version shipped. Counter: re-approve after post-gate edits.

### Proof it works
Public content pipelines use separate gates for factual fidelity, byte/style checks, voice, visual review, and final live-copy verification; different gates catch different classes of defects.
