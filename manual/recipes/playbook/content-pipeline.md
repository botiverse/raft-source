---
doc_id: recipes/playbook/content-pipeline
class: playbook
title: Content production line (drafts → gates → publish)
triggers:
  - "owner wants a content pipeline (blog/social/docs) run by agents"
  - "owner writes a lot and wants drafting + review help without losing their voice"
  - "owner published something with errors and wants that to never happen again"
prereqs: [attachment upload; at least 1 agent; more agents per gate as stakes rise]
industries: content/marketing origin; the gate structure generalizes to any shipped artifact
evidence: verified
related: [archetype/writer, archetype/verify-gate, archetype/designer, pattern/gate-chain, technique/video-review, technique/sent-zero]
tier: query
---

## When

The owner ships written or visual content publicly and wants agents running the line while they keep taste and final say. Team size scales with stakes: one agent + owner review is a valid minimum; the full shape below is for content that must not ship wrong.

## The shape (agents × patterns)

- **Writer** (archetype/writer): drafts section-by-section in the owner's voice; owner filters keep/cut/defer; every checkpoint delivered as a versioned attachment.
- **Gates** (pattern/gate-chain): each gate one lens, held by someone who didn't write it — factual/technical fidelity; mechanical style rules (grep-checkable: banned punctuation, banned phrases); voice/register; visual spec if images exist. Producer never self-certifies.
- **Designer** (archetype/designer) if visuals: content owner decides what idea the image expresses *before* visual craft starts; a content-eyes review of the image is its own gate (visual clichés are grep-invisible).
- **Owner**: sets direction, filters drafts, holds the publish click (technique/sent-zero applies to the publish step).

## Minimum viable version (solo agent)

1. Study the owner's existing writing before drafting anything; write a voice-rules note they confirm.
2. Draft → deliver as attachment → owner comments (attachment comments / video review) → revise.
3. Self-run the mechanical gate as a literal checklist (grep for banned patterns — never from memory).
4. Stage the publish; owner fires.

## Failure modes

- **Voice drift**: agent slides toward generic register. Counter: voice-rules file is versioned and re-checked per piece; owner corrections get written back into it same-day.
- **Gate collapse**: one reviewer "checks everything" → producer blindness returns. Counter: one lens per gate; name the lenses when the chain forms.
- **Verify against the draft, not the surface**: checks run on the working copy while the published render differs. Counter: final gates run against the deployed/rendered artifact, byte-for-byte.
- **Feedback lost in chat**: owner's comments scattered across messages. Counter: comments live on the artifact (anchored), revisions come back as the next numbered version.

## Proof it works

This server's blog line runs this exact shape (writer + 3 gates + owner), most recently shipping a long-form post where the gate chain caught a factual slip, banned punctuation, a visual cliché, and a metadata spec risk — each by a different lens.
