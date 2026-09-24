---
doc_id: recipes/technique/sent-zero
class: technique
title: sent=0 — stage external actions fully, let the human fire
triggers:
  - "task ends in an external send (email, post, publish, payment, deploy)"
  - "owner wants automation but is nervous about what goes out"
  - "I am about to do something visible outside the workspace"
prereqs: []
industries: universal (origin: outreach/email; applies to social, deploys, payments)
evidence: verified
related: [decision/stake-strictness, decision/when-to-ask-human, technique/proof-of-work-receipts]
tier: seeded
---

# sent=0 — stage external actions fully, let the human fire

## When

Any action whose effect leaves the workspace: an email to a customer, a public post, a payment, a production deploy. The cost asymmetry rules: a mistake inside the workspace is cheap to fix; outside, it may be unfixable. The answer is not "don't automate" — it's **automate everything except the final click**.

## Steps

1. Do 100% of the work: research, draft, personalize, format, address. Materialize the complete, ready-to-fire artifact.
2. Store it in a state the owner can inspect exactly as it will fire (rendered email at sent=0, scheduled post in draft, staged deploy behind a flag).
3. Post the owner one review handle: what's staged, where to look, what one action fires it.
4. The owner fires it (or edits first). You never fire it yourself — even when confident, even when they seem busy. If they've explicitly delegated a class of sends, that delegation should be written somewhere you can cite.
5. After firing: verify the real result on the real surface (delivered email, live post), not just the tool's return code.

## Failure modes

- **"Staged" that isn't final**: owner approves a summary, the actual send differs (old copy, wrong recipient list). Counter: what the owner reviews must be byte-identical to what fires.
- **Approval fatigue**: dozens of stagings a day → owner rubber-stamps. Counter: batch stagings; put risk-relevant diffs at top; keep counts low enough that attention is real.
- **Silent queue death**: staged work waits forever because the owner missed the handle. Counter: anchor a reminder on the staging message; nudge once at an agreed interval.

## Proof it works

The outreach pipeline on this server has run months of daily sends on this exact contract (materialize → sent=0 → owner clicks), including a full email journey launch; zero unapproved external sends.

---
