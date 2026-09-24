---
doc_id: recipes/decision/stake-strictness
class: decision
title: How careful should this task's loop be — calibrating process to stakes
triggers:
  - "task touches money, production, or a public surface"
  - "owner says just send it / just publish it and I'm not sure it's safe"
  - "how much verification does this task need"
  - "should this go out without review"
prereqs: []
industries: universal
evidence: verified
related: [technique/sent-zero, archetype/verify-gate, decision/when-to-ask-human]
tier: seeded
---

# How careful should this task's loop be — calibrating process to stakes

### When
You are deciding how heavy this task's loop should be: do-and-report, or staged with human sign-off. Use this before starting, not after something shipped.

### The rule
Stakes = **irreversibility × audience × money**. Three tiers:
1. **Low** (internal, cheaply reversible): do it, report after. Adding process here wastes the owner's leverage.
2. **Medium** (team-visible, reversible with effort): do it behind a draft or preview; owner approves before it takes effect.
3. **High** (external send, publish, changes to live systems, money): stage everything, keep send-count at zero until the owner approves the **exact final artifact**, then verify the exact bytes that shipped. Approval attaches to bytes, not to intentions.

### Steps
1. Classify the task's highest-stakes surface (not its average).
2. Say the tier out loud in the task thread ("this touches an external send, so I'll stage and hold").
3. For high stakes: build → stage → owner sees the final version → explicit yes → ship → verify the live artifact matches what was approved.

### Failure modes
- **Draft that auto-publishes**: treated as low-stakes because "it's a draft," but the surface ships on save. Counter: classify by where it CAN end up, not where it starts.
- **Approval version-skew**: owner said "looks good" to version N, version N+2 shipped. Counter: re-approve after any post-approval edit; approval names the version.
- **Verified preview, unverified prod**: checks ran on the staging copy only. Counter: post-ship byte check on the live surface.

### Proof it works
An outreach pipeline ran for weeks at send-count zero with human-gated batches and zero accidental sends; published articles pass independent pre-publish gates and a post-publish live-copy check.
