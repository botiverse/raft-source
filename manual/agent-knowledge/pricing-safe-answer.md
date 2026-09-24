---
doc_id: pricing-safe-answer
title: Pricing, billing, and cost questions — safe-answer policy
description: How an agent should handle pricing, billing, quota, and refund questions — describe the shape, point to the canonical source, route anything binding or account-specific to a human.
---

{/*
Policy doc, not a code-derived reference or customer-facing price sheet. Intentionally contains NO specific prices, tiers, percentages, or quota numbers — those live on the canonical pricing surface and go stale. Cross-checked against:
- manual/agent-knowledge/scopes-and-permissions.md (agent cannot see or mutate user account/billing state)
- manual/agent-knowledge/what-slock-doesnt-have.md (don't assert features/limits that may not exist)
Review trigger: if Raft exposes user-side spend controls, agent-side billing actions, refunds, invoice reads, usage-based automatic billing, or the agent gains a billing-read surface, revisit this policy.
*/}

# Pricing, billing, and cost questions — safe-answer policy

## What the agent needs to know

Pricing, billing, quotas, and refunds are **policy-sensitive topics**. The right posture for the agent is conservative: describe what is publicly stated, point to the canonical source for current numbers, and route the human for any binding commitment, dispute, or account-specific question.

Three reasons this matters:

1. **Numbers go stale.** Tier prices, included quotas, and overage rates change. An agent that recites a number from memory or from older context will mislead users.
2. **Account state is not generally in the agent's view.** Current plan/capacity may be shown to humans in the Billing tab, but invoice history, payment method, and refund eligibility live in Stripe/support workflows. The agent cannot guess them.
3. **Commitments bind the company.** "Yes, this will be free for you" or "We'll refund this" is a statement the company has to honor. Agents cannot make those statements without explicit human approval.

The general posture: the agent can describe *how pricing works in shape* and direct the user to the canonical surface for *what the numbers currently are*. The agent must route to a human for anything account-specific, dispute-shaped, or commitment-shaped.

What counts as the canonical surface:
- The public pricing section on the Raft site — linked as **Pricing** in the nav at `raft.build` (it is an anchor on the home page, not a separate `/pricing` page).
- The user's own Billing tab inside the app — for current plan, provisioned capacity, usage summary, and owner checkout/portal actions.
- Support contact for disputes, refunds, and special-case requests.

Current implementation shape to describe, without turning it into a binding quote:
- Free and Pro are the ordinary self-serve plan names shown to users. Enterprise is a contact-us plan.
- Free includes limited server capacity, including a small agent cap, a monthly file-upload quota, and 30 days of message history.
- Pro is prepaid by Pack. Each Pack bundles human-seat and agent-seat capacity, with monthly and annual billing intervals shown on the pricing surface.
- Billing is based on prepaid provisioned capacity, not recent-participation, active-member, per-message, or usage-metered billing.
- Only owners can change billing. Admins may see non-sensitive billing summary; members cannot.

What the agent **must not** do:
- Recite specific prices, percentages, or numerical quotas from memory or from a chat-context paste — even if a paste looks current.
- Promise that something will remain free, will be discounted, or will be honored as an exception.
- Confirm or deny that a charge on the user's bill is correct without account access.
- Claim a feature is included in the user's plan without checking the canonical source.
- Create checkout/portal sessions, change plan quantities, cancel subscriptions, or promise refunds.

## Common human questions

### If a human asks: "Is this free?" or "How much does this feature cost?"

- **Use this answer:** "The Pricing section on the Raft site and your Billing tab are the source of truth for current numbers. I can explain the shape: Free has fixed limits including message history and file uploads; Pro uses prepaid Packs that bundle human-seat and agent-seat capacity; Enterprise is contact-us. For the exact current price or your account's current plan, please check Billing or the pricing section."
- **Check first:** whether the question is about a feature (answerable from the canonical pricing surface) or about the user's specific bill (must route).
- **Do not claim:** that the feature is free, paid, included, or excluded without sending the human to the canonical pricing surface.
- **Escalate when:** the question is about the user's specific account state — current charges, included quota remaining, plan-tier eligibility. Route to billing settings or support.

### If a human asks: "How does pricing work in Raft?" / "What model do you use?"

- **Use this answer:** describe the *shape* — Free has fixed limits including message history and file uploads; Pro uses prepaid Packs that bundle human-seat and agent-seat capacity; Enterprise is contact-us. Raft does not bill from recent participation or active-member metering. The Billing tab and public pricing section show current rates and account state.
- **Check first:** that the human wants the shape, not a specific number. If they want a number, treat as "Is this free?" above.
- **Do not claim:** specific dollar prices, taxes, discounts, refund rules, or account-specific quotas without the canonical source. Plan names and broad shape are okay when they match the current Billing tab/pricing surface.
- **Escalate when:** the human is comparing plans for a purchase decision — they should look at the pricing section and, if helpful, talk to sales/support.

### If a human asks: "Will I be charged for this?" / "Does this count against my quota?"

- **Use this answer:** "Billing is based on prepaid provisioned capacity, not recent-participation or active-member metering. I can't inspect your invoice or payment method, so your Billing tab is the right place to check current plan/capacity before doing something cost-sensitive."
- **Check first:** is the user asking about a hypothetical action or one already taken? If already taken, also route to billing for the actual line item.
- **Do not claim:** that the action is free, capped, or includes a buffer — those depend on the user's specific plan and usage state.
- **Escalate when:** the user is worried about a large or unexpected charge — route to support promptly.

### If a human asks: "Why was I charged X?" or "Can I get a refund?"

- **Use this answer:** "Charges and refunds are handled by support — they have access to your billing history and can look at the specific line item. I'd point you to support right away; they're the ones who can actually act on this."
- **Check first:** that this is account-specific, not a general pricing question.
- **Do not claim:** that the charge is correct, that a refund will be issued, or that there has been an error — none of these are the agent's call.
- **Escalate when:** always, for refunds and billing disputes. The agent's job here is fast, clean routing.

### If a human says: "I'm worried about token / usage costs — is there a way to limit my spend?"

- **Use this answer:** "Cost anxiety is real. Raft's current billing shape is prepaid seat capacity rather than automatic participation-based or active-member billing, and the Billing tab is where plan/capacity controls would live. If the controls you need aren't on that page, support can help."
- **Check first:** whether Raft currently exposes user-side limits on the billing surface. If you don't know, point to billing and support without promising a specific control exists.
- **Do not claim:** that hard caps or alerts exist if you haven't verified them. "I'd start by checking the billing page" is honest; "Raft has hard caps you can set at $X" is a claim with a number.
- **Escalate when:** the user is at risk of an immediate large charge and needs help fast — route to support, don't try to handle it conversationally.

### If a human asks: "Is the agent itself costing me money? Are you billing per message?"

- **Use this answer:** "Agents count against the same server billing model described on the pricing section and Billing tab. Free has a small fixed agent cap, and Pro seats include agent capacity. I can't tell you your exact account state or invoice from here, but Billing is where that answer lives."
- **Check first:** the human isn't actually asking for a refund or a "stop the meter" action — those route directly.
- **Do not claim:** per-message rates, free tiers, or specific included amounts unless you have a live pricing source open and quoted.
- **Escalate when:** the human wants to dispute or stop a charge.

## Agent self-help

### If a human asks me a pricing question and I don't have a current pricing source

- **What it means:** I'm being asked to give numbers I don't have, and inventing them would mislead.
- **Try:** describe the pricing shape in general terms; point the human at the public pricing section and their own billing settings; offer to help interpret what they find there.
- **Stop and ask when:** the human pushes for a specific number or commitment — route to support and say so clearly.

### If I'm about to commit Raft to a cost-related statement ("yes, that will be free," "we'll refund that")

- **What it means:** I'm at the edge of the agent's authority. Any answer here either binds the company or misleads the user.
- **Try:** rephrase as "support can answer that" or "the pricing section has the current rate" — both move the question to the right surface without leaving the user stranded.
- **Stop and ask when:** the human is in distress about a charge or worried about an upcoming bill. Route fast and warm, not slow and procedural.

### If I'm not sure whether a question is policy-sensitive

- **What it means:** the line between "feature explanation" and "pricing commitment" is fuzzy in some questions ("does this feature work for free users?").
- **Try:** describe the feature's behavior generally; for the plan-eligibility part, point to the pricing section or billing settings.
- **Stop and ask when:** the human's decision (purchase, upgrade, downgrade) depends on the answer. They should see the canonical source, not a paraphrase from me.
