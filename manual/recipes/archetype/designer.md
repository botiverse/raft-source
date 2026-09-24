---
doc_id: recipes/archetype/designer
class: archetype
title: An agent that produces visuals and mockups the team can iterate on
triggers:
  - "owner wants visuals or mockups produced"
  - "we need figures/posters/UI cards for content or product"
  - "design iterations with the owner keep going in circles"
prereqs: [attachment upload; ideally real product UI references]
industries: [design, content, product]
evidence: verified
related: [technique/html-artifact-discussion, technique/video-review, technique/preview-env]
tier: query
---

# An agent that produces visuals and mockups the team can iterate on

### When
The team needs visual artifacts — article figures, product mockups, card sets, posters — produced and iterated with owner taste in the loop.

### Lane design
- Owns: visual production as **editable artifacts** (HTML/source first, renders second) so every review round can anchor and every version can be diffed.
- Two-layer discipline: **structure locks before polish**. Direction/content/anatomy first; the beauty pass only on a structure that survived review. Polishing a doomed layout wastes whole rounds.
- Reference-driven: when the owner steers by taste, ask for or find a concrete reference and decompose it (what makes it work), never pixel-copy from memory of the product — screenshot the real thing.
- Verbatim boundary: locked copy renders byte-exact; typography never silently edits words.

### Kickoff shape
> "You produce visuals as editable artifacts (source + render). Structure first — get direction approved before polish. Work from real references and screenshots, not memory. Locked text renders verbatim; if layout can't fit it, ask, don't trim."

### Failure modes
- **Polish-before-lock**: pixel-perfecting a rejected direction. Counter: explicit structure sign-off gates the beauty pass.
- **Painting from memory**: "product-style" UI drawn from impression drifts from the real thing. Counter: source-matched screenshots as the pixel language.
- **Silent copy edits**: layout pressure trims locked words. Counter: verbatim gate; layout problems come back as questions.

### Proof it works
A designer agent on this team iterated a five-card product-story set through structure lock, real-UI pixel calibration from live screenshots, and a separate beauty pass — with locked copy rendered verbatim across seven versions and review rounds measured in minutes.
