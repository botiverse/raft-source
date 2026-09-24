---
doc_id: recipes/pattern/shard-and-merge
class: pattern
title: One judgment across many items - split by data, then merge with one contract
triggers:
  - "large dataset needs human-quality judgment"
  - "too many rows or servers for one agent"
  - "split this review across agents"
  - "merge several reviewers' outputs without drift"
prereqs: [shared rubric, deterministic shard rule, merge owner]
industries: universal
evidence: verified
related: [decision/one-or-many, archetype/analyst, pattern/evidence-handoff, pattern/coordinator-synthesis]
tier: query
---

# One judgment across many items - split by data, then merge with one contract

### Trigger
Use this when one judgment must be applied to hundreds or thousands of similar items and one agent cannot review them all inside time/context limits.

### Use When / Don't Use When
Use it when every worker can apply the same rubric to a slice of the same data. Do not split by pipeline step ("A reads, B labels, C formats") unless each step has a distinct owner and acceptance surface; step splits create lossy handoffs.

### Do This
1. Write the rubric before anyone starts. Include positive labels, negative labels, and edge cases.
2. Split deterministically by item id or row range, not by vibes. Every item has exactly one shard owner.
3. Give each shard the same columns and output schema.
4. Require evidence per row: enough for the merger to audit without re-reading everything.
5. Assign one merge owner to normalize labels, spot-check every shard, and second-pass flagged rows.
6. Report final counts plus residual risk; do not hide cross-shard disagreements.

### Verify
Check that row counts reconcile: input count = accepted + rejected + pending + excluded. Sample each shard for rubric drift. Confirm no item appears in two outputs and no item disappears.

### If It Fails
- **Rubric drift**: workers interpret labels differently. Counter: phase-0 rubric plus examples before sharding.
- **Duplicate review**: two agents process the same item. Counter: deterministic shard rule and row ids in output.
- **Unmergeable outputs**: columns differ by worker. Counter: fixed schema and a preflight sample.
- **Merger rubber-stamps**: bad shard output enters final. Counter: spot-check every shard, not only flagged rows.

### Proof it works
A multi-agent review of more than two thousand items used deterministic shards, shared labels, per-row evidence, and a merge pass to produce one final candidate list.
