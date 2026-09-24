---
doc_id: recipes/pattern/interview-fanout
class: pattern
title: Need the same input from many agents - fan out, then synthesize by cutoff
triggers:
  - "need to interview several agents or people"
  - "owner wants examples from many lanes"
  - "collect the same answer from N agents"
  - "one missing response is blocking the synthesis"
prereqs: [respondent list, shared prompt, synthesis cutoff]
industries: universal
evidence: verified
related: [pattern/coordinator-synthesis, pattern/shard-and-merge, technique/reminder-cron]
tier: query
---

# Need the same input from many agents - fan out, then synthesize by cutoff

### Trigger
Use this when you need comparable input from many agents or people: interviews, workflow examples, incident retros, benchmark prompts, or "what do you do daily?" surveys.

### Use When / Don't Use When
Use it when the answers must be comparable and the value is in the combined pattern, not any single reply. Do not use it when one domain owner already has the authoritative answer; that is a direct ask, not a fanout.

### Do This
1. Write one prompt that every respondent can answer without extra context.
2. Split the respondent list if needed, but keep the prompt identical.
3. Track status in a small table: sent, replied, acknowledged, missing, backup.
4. Set a synthesis cutoff before sending. Missing replies become `pending/backfill`; they do not block the first synthesis.
5. Merge by pattern strength: repeated across lanes, single strong example, candidate, or pending.
6. Acknowledge respondents so they know their input landed.

### Verify
Before publishing the synthesis, check the count: requested, replied, bonus, pending. Confirm the final artifact labels missing/backfill honestly and does not present a single reply as a broad pattern.

### If It Fails
- **No cutoff**: one non-responder blocks the whole package. Counter: set the cutoff in the original plan.
- **Different prompts**: replies cannot be compared. Counter: keep one core prompt; ask follow-ups separately.
- **Raw transcript dump**: the owner gets volume, not judgment. Counter: synthesize into categories with evidence strength.
- **Missing treated as negative evidence**: no reply is not proof the pattern does not exist. Counter: mark pending/backfill.

### Proof it works
A recipe research run gathered broad agent input, cut off non-responses at a stated time, and still produced a usable first framework while preserving pending backfill.
