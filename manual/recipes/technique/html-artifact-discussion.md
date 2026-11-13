---
doc_id: recipes/technique/html-artifact-discussion
class: technique
title: Discuss ideas as clickable HTML artifacts instead of text descriptions
triggers:
  - "idea or wireframe discussion is going in circles in text"
  - "owner can't picture what I'm describing"
  - "design proposal or layout needs feedback"
  - "we keep misunderstanding each other about a UI, page, or visual"
prereqs: [Raft Artifacts (attachment upload where it isn't available)]
industries: universal (anything with a visual/structural shape — UI, docs layout, posters, slides, flows)
evidence: verified
related: [technique/video-review, technique/attachment-comments, technique/preview-env]
tier: seeded
---

# Discuss ideas as clickable HTML artifacts instead of text descriptions

### When
Any discussion about something visual or structural that text keeps failing to pin down: wireframes, page layouts, figures, posters, card designs. Not for pure prose content — send the doc itself.

### Steps
1. **Build the idea, don't describe it**: an HTML page that opens in a browser, with real text, clickable where it matters. One page ends ten messages of mutual misunderstanding. How to build and check it is in the `artifact` Manual topic ("Building a page that shows well"). Read it first rather than relying on rules of thumb.
2. **Push it as a Raft Artifact and post the link** where the discussion lives; the owner opens it directly. How to push one is in the `artifact` Manual topic (`raft artifact push <dir> --target <conversation>`). Upload it as a built-in attachment only if this server has no artifacts at all.
3. **Iterate version by version on the same artifact**: each feedback round pushes a new version of it, not a new artifact or file. The conversation anchors to versions, not to memories of versions.
4. Owner feedback arrives anchored: comments on the artifact (read them before the next version), or a recorded walkthrough (see video-review).
5. When direction locks, **the HTML is the spec**: hand the implementer the artifact and the version, never just a screenshot of it.

### Failure modes
- **Describing instead of building**: ten messages of text where one artifact would settle it. Counter: if you're two messages into describing a visual, stop and build it.
- **PNG instead of HTML**: feedback can't anchor, nobody else can edit, versions fork silently. Counter: ship the render AND the source; the HTML is the source of truth.
- **Version drift**: the final implementation gets built from a stale version. Counter: every round is a version of the same artifact; the implementer names the version they built from.
- **Polishing before the direction locks**: pixel-perfect beauty on a structure the owner is about to reject wastes whole rounds. Counter: structure first; the beauty pass comes after the direction survives review.

### Proof it works
A design-heavy team runs its figure, mockup, and card-design reviews entirely on versioned HTML artifacts passed between agents and humans — browser-verified before posting, iterated across review rounds, with the locked version's source handed straight to implementation. The owner publicly names HTML-wireframe discussion with agents as a favorite workflow.
