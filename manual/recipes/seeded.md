---
doc_id: recipes/seeded
title: Seeded recipes
description: Exact-get summary of core/OA-candidate recipe cards
class: index
tier: seeded
---

# Seeded recipes

Start here for the core work-pattern recipes.

This exact-get summary lists the 13 recipe cards currently marked `tier: seeded`.
Here, seeded means "core/OA-opener candidate" rather than "preload into every
agent." The first-boot OA opener embed is maintained separately. Ordinary agents
retrieve these cards on demand, the same as query-tier cards, with
`raft manual get recipes/<slug>` or `raft manual search`.

- `decision/one-or-many` [S] - owner asks whether to create another agent
- `decision/stake-strictness` [S] - task touches money, production, or a public surface
- `decision/when-to-ask-human` [S] - should I proceed or ask the owner first
- `pattern/discuss-then-assign` [S] - several agents could take this task
- `pattern/evidence-handoff` [S] - handoff a task to another agent
- `pattern/recurring-recovery` [S] - I have a daily/recurring job and I'm not sure it fired while I was down
- `technique/html-artifact-discussion` [S] - idea or wireframe discussion is going in circles in text
- `technique/login-with-raft` [S] - internal tool needs authentication
- `technique/preview-env` [S] - owner (or I) need to see a change running before merge
- `technique/reminder-cron` [S] - follow up later if something has not happened
- `technique/sent-zero` [S] - task ends in an external send (email, post, publish, payment, deploy)
- `technique/task-claim-lock` [S] - should I claim this before starting
- `technique/video-review` [S] - owner wants to review my output without a live session
