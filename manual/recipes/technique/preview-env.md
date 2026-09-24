---
doc_id: recipes/technique/preview-env
class: technique
title: Spin up a preview environment so the owner sees the change running
triggers:
  - "owner (or I) need to see a change running before merge"
  - "how do I show my work actually working"
  - "owner keeps reviewing from code diffs and missing behavior problems"
  - "spin up a preview or staging environment for review"
prereqs: [a way to render or run work-in-progress — dev server for software, rendered draft for docs/designs/decks, sample-data run for reports]
industries: universal (anything whose result can be SHOWN before it ships)
evidence: verified
related: [decision/stake-strictness, technique/video-review, technique/acceptance-surface]
tier: seeded
---

# Spin up a preview environment so the owner sees the change running

### When
A change is easier to judge by experiencing it than by reading a description of it: UI work, flows, page layouts, decks, reports — anything behavior- or appearance-shaped. Also when YOU need to verify your own change against the real result before calling it done. If the work has no runnable/renderable form at all, use an artifact preview instead (see html-artifact-discussion).

### Steps
1. Isolate the work-in-progress so the preview shows exactly what will ship — nothing more, nothing less (in software: a separate branch/worktree; elsewhere: a copy that tracks only this change).
2. Produce a surface the owner can open themselves: software → run the dev/preview server and share the URL; docs/design/deck → a rendered draft or clickable artifact; data/report → the real output on sample data.
3. **Seed it with realistic material** — an empty preview cannot be judged. Real-shaped messages, files, states; whatever the check needs to be meaningful.
4. **Run the env manifest before handing over (scripted, not remembered):** build/version matches the target; required flags are ON for the demo account / target surface (not just globally); seed data is fresh; workspace reset state is known; the preview URL is actually reachable (e.g. tunnel/host not expired). Then post the URL where the owner works, with one line on what to look at.
5. **Keep it alive until the owner confirms** — a preview is a held-open door, not a fire-and-forget link. If it must restart, say so and re-verify the URL.
6. After sign-off: clean up the env; the approved change moves through the normal ship path (see decision/stake-strictness — approval attaches to what ships, not to the preview).

### Failure modes
- **Dead link on arrival**: preview stopped before the owner looked. Counter: owner-confirmation ends the preview's life, nothing else.
- **Empty-state preview**: nothing to judge, owner bounces. Counter: seed realistic data first (step 3).
- **Preview drift**: preview verified, but different bytes ship later. Counter: re-verify the shipped surface; the preview approves a version, not the lane.
- **Env litter**: forgotten environments accumulating. Counter: cleanup is part of the recipe, tied to sign-off.
- **Flag/config drift**: the preview env didn't get the switches the review target actually needs — and their scope varies (global, per-server, per-user, per-workspace, per-role, experiment cohort, even env vars), so "prod has it" or "the global flag is on" isn't the test. Features silently don't render and the review tests the wrong reality. Counter: config setup is part of env bootstrap — scripted, not remembered; before handing over the URL, verify the flags your demo depends on are ON for the demo account / target server / target surface, not just globally. (Added 7/7 from a same-day double production bite; scope taxonomy per Cindy + ApplePI.)

### Proof it works
Two documented runs in one day on this team: a preview env spun up and seeded (messages + two file attachments + comments) specifically so a designer could reproduce real UI, and a feature preview URL held open across multiple fix rounds until the owner finished her walkthrough.
