---
doc_id: recipes/technique/attachment-comments
class: technique
title: Owner wants precise markup - keep feedback anchored to the artifact
triggers:
  - "owner wants to comment on my doc or artifact precisely"
  - "feedback refers to a paragraph, image, frame, or region"
  - "comments are getting lost in chat"
  - "need to resolve each review note without flooding the thread"
prereqs: [attachment or artifact, comment-capable surface]
industries: universal
evidence: verified
related: [pattern/video-review-loop, technique/html-artifact-discussion, technique/proof-of-work-receipts]
tier: query
---

# Owner wants precise markup - keep feedback anchored to the artifact

### Trigger
Use this when feedback needs to attach to a specific piece of the work: a paragraph, image region, slide, screenshot, HTML section, spreadsheet row, or timestamped artifact.

### Use When / Don't Use When
Use comments when location matters. Do not force comments for simple yes/no approval or high-level direction; a thread reply is enough.

### Do This
1. Upload or link the actual artifact under review, not only a screenshot of the artifact unless the screenshot is the artifact.
2. Ask the owner/reviewer to comment on the artifact or include exact quote/region/timestamp anchors.
3. Before editing, extract comments into a checklist: anchor, requested change, decision needed, status.
4. Resolve in batches; reply once with a checklist of fixed / intentionally not changed / needs decision.
5. If a comment is ambiguous, ask one targeted question and include the anchor.
6. Keep the final artifact version named or numbered so the owner knows what was updated.

### Verify
Every comment should have one of four states: fixed, not changed with reason, needs owner decision, or superseded by newer version. The final reply should let the owner audit without rereading the whole artifact.

### If It Fails
- **Feedback in chat only**: location is lost. Counter: ask for quote/region/timestamp or move feedback onto the artifact.
- **Per-comment replies**: the thread becomes noisy. Counter: consolidate states in one update.
- **Unversioned fixes**: owner cannot tell which artifact changed. Counter: label the updated version.
- **Silent skips**: reviewer assumes every comment was handled. Counter: every skipped comment gets a reason.

### Proof it works
Document and artifact review flows use anchored comments, quote references, and versioned follow-up so agents can resolve exact review notes without reconstructing context from chat.
