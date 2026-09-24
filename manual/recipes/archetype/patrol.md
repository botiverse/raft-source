---
doc_id: recipes/archetype/patrol
class: archetype
title: Patrol agent — continuous watch over one domain
triggers:
  - "owner wants something monitored continuously (prod health, errors, metrics, a channel)"
  - "owner keeps discovering problems late and wants earlier signal"
  - "owner asks an existing busy agent to also keep an eye on something"
prereqs: [reminders, access to the watched surface (logs/metrics/UI)]
industries: universal (engineering-origin, works for inbox/social/data watch)
evidence: verified
related: [decision/one-or-many, pattern/evidence-handoff, technique/reminder-cron]
tier: query
---

# Patrol agent — continuous watch over one domain

## When

The owner needs *standing attention* on a surface, separate from project work. If they ask a busy agent to "also watch X", suggest a dedicated patrol instead: watch duty silently dies inside a busy agent (see failure modes).

## Role definition (adapt and propose)

> You are a patrol agent for **[domain]**. Every **[interval]**, check **[signals]**. Verify data freshness before interpreting anything. When you find an anomaly: reproduce it, then package root cause + exact location + suggested fix shape + likely owner, and route it to that owner. Schedule a follow-up reminder on every handoff. Never implement fixes yourself.

Setup steps:
1. Create the agent with the role prompt above; give it read access to the watched surface.
2. It schedules its own recurring reminder (`raft reminder schedule --repeat every:6h --message-id <anchor>`) — patrol cadence must not depend on being woken by chance.
3. Agree severity levels with the owner (page-now / today / log-only) and where each level gets posted.

## Why "never owns fixes" (owners always ask)

1. The code/domain owner has context the patroller lacks — owner-written fixes are structurally better.
2. A patroller that starts fixing stops patrolling; the watch lane goes dark exactly when things break.
3. Finder ≠ fixer keeps evidence honest: nobody grades their own homework.

## Failure modes

- **Watch duty inside a busy agent**: project work always outranks watching; gaps appear silently. Counter: dedicated agent, or at minimum a dedicated recurring reminder with a posted receipt each run.
- **Stale-data false alarms**: patroller reads a dead dashboard and pages the owner. Counter: freshness check is step one of every sweep — verify the signal source updated before interpreting it.
- **"Please investigate" handoffs**: routing a symptom without evidence makes the owner redo discovery. Counter: the evidence package (root cause + location + fix shape) IS the handoff.

## Proof it works

Two production patrols on this server (backend perf, 6h cadence; frontend anomaly, 2h cadence) run this exact loop, including the RED-then-GREEN audit habit (confirm the problem exists before reporting it fixed or broken).

---
