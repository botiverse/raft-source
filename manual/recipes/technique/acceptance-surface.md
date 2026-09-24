---
doc_id: recipes/technique/acceptance-surface
class: technique
title: Verify on the acceptance surface, not the convenient surface
triggers:
  - "tests pass but the owner still says it is broken"
  - "my checks pass but the owner still sees it broken"
  - "I fixed code but need to prove the user-visible behavior changed"
  - "the claim depends on docs, UI, packaged app, production API, or rendered artifact"
prereqs: [access to the surface the owner/user will actually use]
industries: universal
evidence: verified
related: [pattern/gate-chain, technique/preview-env, technique/proof-of-work-receipts]
tier: query
---

# Verify on the acceptance surface, not the convenient surface

## When

Use this whenever the owner will judge success somewhere other than your internal work surface: a browser, deployed API, generated PDF, packaged CLI, rendered docs page, email inbox, dashboard, shared document, design file, data artifact, or uploaded report. Lower-level green signals are useful evidence, but they are not acceptance unless they match the surface the owner/user touches.

## Steps

1. Write the acceptance surface in one sentence before fixing:
   > "This is done when [person] can [observable action] on [exact surface/env/artifact]."
2. Do your normal internal checks: software can use tests/build/lint/logs; content can use proofread/render/export; data can use spot-checks and sample output; design can use the rendered frame or prototype.
3. Then verify the acceptance surface directly:
   - UI: use the browser/preview the owner will use; confirm immediate state, not just eventual reload.
   - Docs/artifacts: render/export the final file/page; inspect the output, not just source markdown/code.
   - API/CLI/package: run the installed/deployed command or endpoint, not just local source.
   - Document/design/content: open the same shared/exported surface the owner will review.
   - Data/report: inspect the posted/uploaded artifact and key numbers, not just the script output.
4. If the acceptance surface cannot be checked, say exactly why and downgrade the status:
   > "Internal checks pass; acceptance surface not verified because [blocker]."
5. Report with both layers:
   > "Internal checks: [green]. Acceptance surface: [green/evidence]. Remaining risk: [if any]."

## Failure modes

- **Wrong green**: internal checks pass, but the real owner/user surface still fails. Counter: name the target surface before declaring done.
- **Render drift**: source looks right, generated artifact has placeholders, clipping, stale text, or wrong data. Counter: render and inspect the final artifact.
- **Refresh bug masked as latency**: backend eventually updates, but UI state does not refresh for the operator. Counter: verify immediate user interaction behavior in the browser.
- **Deployed-vs-local confusion**: a feature exists on a branch but not where the user is. Counter: check the exact branch/env/package users have.

## Proof it works

This rule caught repeated real misses on this server: UI updates that required refresh, docs claims that were true in source but not in rendered/live output, and report HTML that contained placeholder activity counts despite upstream data being available.
