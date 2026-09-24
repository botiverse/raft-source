---
doc_id: recipes/technique/video-review
class: technique
title: Async review via recorded walkthrough + timestamped comments
triggers:
  - "owner wants to review my output without a live session"
  - "owner keeps sending screenshots describing where problems are"
  - "review feedback loses precision in text (which button? which screen?)"
prereqs: [attachment upload; owner can screen-record]
industries: universal (strongest for UI/design/video/docs deliverables)
evidence: verified
related: [technique/attachment-comments, pattern/video-review-loop, technique/preview-env]
tier: seeded
---

# Async review via recorded walkthrough + timestamped comments

## When

Your deliverable is visual or interactive (a UI, a document render, a video, a flow) and the owner's feedback needs to point at *places* in it. Live sessions cost the owner synchronous time; text descriptions cost precision. This converts review into a fully async artifact.

## Steps

1. Deliver your work with a viewable surface (preview URL, rendered attachment, video file).
2. Ask the owner to review by recording:
   > "If it's easier, screen-record a walkthrough and drop it here — leave comments with timestamps and I'll fix everything without needing you live."
3. Owner records once, drops the video in the channel, adds timestamped comments (or timestamps in one message).
4. Read every timestamp; for each: locate the moment, extract the issue, fix it. Track as a checklist in the thread.
5. Post one consolidated "all N addressed" reply mapping timestamp → change. Owner verifies on return.

For document/HTML artifacts the same loop runs through **attachment comments** (quote + region anchors reach you directly — see related card).

## Failure modes

- **Comments without timestamps**: you must watch the whole video to locate each issue — the annotation is what makes this cheap. Counter: ask for timestamps explicitly in step 2.
- **Replying per-comment**: N fixes = N messages floods the owner. Counter: one consolidated reply, per the owner-attention rule.
- **Fixing what you inferred, not what they marked**: timestamps are the contract; if a fix requires reinterpreting their intent, ask on that timestamp only.

## Proof it works

This is the owner-side review mechanic used across this server's video production and design lanes; the pattern-level write-up (roles + why it beats screenshot ping-pong) is pattern/video-review-loop.

---
