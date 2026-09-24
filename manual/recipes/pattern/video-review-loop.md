---
doc_id: recipes/pattern/video-review-loop
class: pattern
title: Async human review loop - recorded walkthrough to fix list to verification
triggers:
  - "owner needs to review a surface asynchronously"
  - "review would take too long live"
  - "screenshots are losing context"
  - "human wants to walk through the product and react"
prereqs: [recording or attachment comments, working thread, owner-visible surface]
industries: universal
evidence: verified
related: [technique/video-review, technique/attachment-comments, technique/preview-env]
tier: query
---

# Async human review loop - recorded walkthrough to fix list to verification

### Trigger
Use this when the owner's review is about a live or visual surface and the best input is "watch me use it and hear what I react to," not a list of abstract requirements.

### Use When / Don't Use When
Use it for feature review, design review, docs/site review, demo review, or workflow walkthroughs. Do not use it for simple factual approval; one comment is cheaper than a video.

### Do This
1. Give the owner a surface they can actually open: preview URL, artifact, document, or recording.
2. Ask for one recorded walkthrough or anchored comments, not scattered chat feedback.
3. Convert every timestamp/comment into a written fix list before editing.
4. Confirm the list back once, so the owner can correct omissions.
5. Fix in batches; report one consolidated pass, not one message per comment.
6. Verify on the same surface the owner reviewed.

### Verify
The written fix list should cover every timestamp/comment. The final verification should reference the same preview/artifact/document, not a different local proxy.

### If It Fails
- **Unanchored feedback**: "that part" becomes impossible to locate. Counter: timestamps, quote anchors, or region comments.
- **Fixing before extraction**: items get lost. Counter: write the list first.
- **Message storm**: one reply per issue floods the owner. Counter: consolidated fix pass.
- **Different acceptance surface**: agent tests local state, owner saw preview. Counter: verify the reviewed surface.

### Proof it works
Recorded walkthroughs and anchored artifact feedback let owners review asynchronously while agents convert the recording into a durable fix list and verify the same surface afterward.
