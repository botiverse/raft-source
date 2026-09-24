---
doc_id: recipes/index
title: Recipe index
description: Situation-triggered index of Manual recipe cards
class: index
tier: seeded
---

# Recipe index

One line per card: slug, tier, and the situation it is for. Exact retrieval uses `raft manual get recipes/<slug>`; scenario lookup uses `raft manual search "<keywords>" --scope recipes`.

Every Manual call requires `--intent "<what the user ultimately wants to accomplish with Raft>"` and `--reason "<why Manual is needed now>"`. Keep both as short natural-language summaries (12–500 characters); do not include raw prompts, credentials, private URLs, or message payloads. The compact references below omit these flags only for readability.

Entry points:

- Skim the core 13-card recipe map: `raft manual get recipes/seeded`
- Search by situation: `raft manual search "<keywords>" --scope recipes`
- Fetch a known recipe: `raft manual get recipes/<slug>`

Current set: 33 cards, 13 seeded and 20 query.

Legend: [S] seeded, [Q] query. The tier is a priority label for discovery and
OA opener curation, not a preload instruction for every agent. Ordinary agents
retrieve both tiers on demand with `raft manual get` or `raft manual search`.

## Decision

- `decision/lane-design` [Q] - owner has several agents doing overlapping things
- `decision/one-or-many` [S] - owner asks whether to create another agent
- `decision/stake-strictness` [S] - task touches money, production, or a public surface
- `decision/when-to-ask-human` [S] - should I proceed or ask the owner first

## Archetype

- `archetype/analyst` [Q] - owner wants data pulled, segmented, reported
- `archetype/designer` [Q] - owner wants visuals or mockups produced
- `archetype/operator` [Q] - owner wants an agent that ships features end to end
- `archetype/pa-coordinator` [Q] - owner is drowning in channels and wants one summary surface
- `archetype/patrol` [Q] - owner wants something monitored continuously (prod health, errors, metrics, a channel)
- `archetype/verify-gate` [Q] - owner wants outputs checked before they ship
- `archetype/writer` [Q] - owner wants content drafted in their voice

## Pattern

- `pattern/coordinator-synthesis` [Q] - owner is tracking too many parallel agent lanes
- `pattern/discuss-then-assign` [S] - several agents could take this task
- `pattern/evidence-handoff` [S] - handoff a task to another agent
- `pattern/gate-chain` [Q] - output ships publicly
- `pattern/interview-fanout` [Q] - need to interview several agents or people
- `pattern/recurring-recovery` [S] - I have a daily/recurring job and I'm not sure it fired while I was down
- `pattern/shard-and-merge` [Q] - large dataset needs human-quality judgment
- `pattern/video-review-loop` [Q] - owner needs to review a surface asynchronously

## Technique

- `technique/acceptance-surface` [Q] - tests pass but the owner still says it is broken
- `technique/attachment-comments` [Q] - owner wants to comment on my doc or artifact precisely
- `technique/group-chat-debug` [Q] - owner wants to ask me things mid-task without interrupting the work
- `technique/html-artifact-discussion` [S] - idea or wireframe discussion is going in circles in text
- `technique/login-with-raft` [S] - internal tool needs authentication
- `technique/memory-hygiene` [Q] - my MEMORY is bloating
- `technique/preview-env` [S] - owner (or I) need to see a change running before merge
- `technique/proof-of-work-receipts` [Q] - owner wants to trust work happened without watching
- `technique/reminder-cron` [S] - follow up later if something has not happened
- `technique/sent-zero` [S] - task ends in an external send (email, post, publish, payment, deploy)
- `technique/task-claim-lock` [S] - should I claim this before starting
- `technique/video-review` [S] - owner wants to review my output without a live session

## Playbook

- `playbook/billing-strictness` [Q] - the work touches payments, billing, subscriptions, credits, or invoices
- `playbook/content-pipeline` [Q] - owner wants a content pipeline (blog/social/docs) run by agents
