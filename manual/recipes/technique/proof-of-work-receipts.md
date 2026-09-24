---
doc_id: recipes/technique/proof-of-work-receipts
class: technique
title: Owner wants proof without watching - send a receipt tied to the acceptance surface
triggers:
  - "owner wants to trust work happened without watching"
  - "need to prove a run, deploy, send, scan, or review completed"
  - "handoff needs command outputs or artifact ids"
  - "claim is important enough to audit later"
prereqs: [acceptance surface, captured evidence]
industries: universal
evidence: verified
related: [technique/acceptance-surface, pattern/evidence-handoff, decision/stake-strictness]
tier: query
---

# Owner wants proof without watching - send a receipt tied to the acceptance surface

### Trigger
Use this when "done" is not enough: the owner/reviewer needs to trust a posted artifact, rendered preview, data materialization, sent/unsent state, video capture, QA pass, or other acceptance surface without watching you do it. In software work, the same pattern can cover a run, deploy, or test suite.

### Use When / Don't Use When
Use receipts for high-stakes or replayable work. Do not bury routine low-stakes work in heavy receipts; for cheap reversible work, a short status and link are enough.

### Do This
1. Name the acceptance surface first: artifact, rendered page, live UI, dashboard, recipient/sent count, data row, preview URL, video file, or the owner-facing output. In software work, this can include a deployed page, production DB row, or test suite.
2. Capture the smallest proof that lets someone audit: screenshot, URL, attachment id, counts, sample output, command, checksum, manifest, or commit when code changed.
3. State scope: what the receipt proves and what it does not prove.
4. Separate verified from inferred. If a number is sampled, say sampled.
5. Redact private data and credentials before uploading receipts.
6. Put the receipt in the task thread and reference it in the handoff.

### Verify
The reviewer should be able to open or rerun the receipt path and confirm the exact claim. If the receipt proves a proxy but the claim is about a live surface, add the live-surface check.

### If It Fails
- **Proxy receipt**: internal checks passed but the real surface failed. Counter: tie receipt to the acceptance surface.
- **Unscoped receipt**: reviewer thinks it proves more than it does. Counter: include "proves / does not prove."
- **Private data leak**: raw rows or tokens get uploaded. Counter: sanitize and keep private samples local.
- **Receipt without handoff**: proof exists but nobody knows what to do next. Counter: pair with next action.

### Proof it works
Operational materializations, feature previews, and screen-recording QA runs use receipts with counts, commands, screenshots, artifacts, or checksums so reviewers can audit claims without watching the run.
