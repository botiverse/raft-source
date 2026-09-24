---
doc_id: recipes/playbook/billing-strictness
class: playbook
title: Billing strictness loop
triggers:
  - "the work touches payments, billing, subscriptions, credits, or invoices"
  - "owner asks whether a paid/free/pro entitlement is correct"
  - "user says they paid but the product does not unlock"
prereqs: [provider dashboard or sandbox, app DB/read access, product contract source]
industries: SaaS, marketplaces, paid communities
evidence: verified
related: [decision/stake-strictness, technique/sent-zero, technique/acceptance-surface, archetype/operator]
tier: query
---

# Billing strictness loop

## When

Use this when money or entitlement changes are involved. Do **not** treat "checkout succeeded" as "the product should unlock" until you have traced every layer that grants the user-visible behavior. Billing work is strict because a false positive charges or blocks a real user.

## Steps

1. Name the user-visible claim first:
   > "I am verifying whether [account/workspace] should currently have [paid feature/limit/credit]."
2. Recover the latest product contract from the canonical owner/source. If contract wording is drift-prone, cite the exact source you checked and mark it current-at-time.
3. Map the full state chain, usually:
   1. provider object (customer/subscription/invoice/payment intent)
   2. webhook/event projection
   3. local billing/subscription row
   4. entitlement/permission check used by the product surface
   5. the actual UI/API behavior the user sees
4. Verify each layer independently. Prefer provider sandbox/webhook replay for changes; never infer from local DB alone.
5. If a change can charge, refund, cancel, downgrade, email, or expose paid access, stage it and ask for a human fire/approval step (see `technique/sent-zero`).
6. Report in this shape:
   > "Provider says X; local projection says Y; entitlement code reads Z; live surface shows W. Therefore [decision]. Residual risk: [one line or none]."

## Failure modes

- **Single-layer truth**: "Stripe says paid" or "DB says pro" is treated as final. Counter: require the full chain through the actual entitlement surface.
- **Stale product contract**: an old pricing rule is applied confidently. Counter: re-check the canonical contract/source before answering.
- **Webhook blind spot**: provider state changed but local projection did not. Counter: inspect event delivery/replay state before changing user access manually.
- **Silent irreversible action**: agent refunds/cancels/charges directly. Counter: stage and get explicit human fire unless a written delegation says otherwise.

## Proof it works

Vivian-side interview synthesis identified billing as the strongest strict-loop case: checkout, subscription, invoice, webhook projection, and local entitlement can all diverge. The same strict chain prevented stale pricing/access claims from being reported as canonical.
