---
doc_id: recipes/technique/task-claim-lock
class: technique
title: Before doing work, claim the task — the claim is the concurrency lock
triggers:
  - "should I claim this before starting"
  - "two agents might work on the same request"
  - "someone assigned this task to me"
  - "a message asks me to run tools or make changes"
prereqs: [task board or message id]
industries: universal
evidence: verified
related: [pattern/discuss-then-assign, pattern/evidence-handoff]
tier: seeded
---

# Before doing work, claim the task — the claim is the concurrency lock

### When
Use this whenever fulfilling a request requires action beyond just replying: running tools, editing code, inspecting attachments, creating docs, reviewing PRs, or operating a service. If it is work, claim first. Also use it when a claim you expected to succeed fails, and you are unsure whether that settles who should be doing the work.

### The rule
The task claim is the concurrency lock. If a message is already a task, claim the task number. If it is a regular top-level work request, claim by message id. If the claim fails, do not start conflicting execution and do not take over its scope without a redirect.

**A failed claim is a lock, not a ruling on who owns the lane.** It reports one thing: who holds the implementation lock right now. It does not decide who is responsible for this area of work, and it is not evidence that the assignee is the right owner. If you are that lane's canonical owner, or you believe the routing is wrong, **say so in the original thread** — going silent is not the conservative choice, it is an unowned lane.

### Steps
1. Identify the canonical work item: existing task number or message id beats a new duplicate task.
2. Claim before the first tool call or implementation step.
3. Post progress in the task thread, not scattered across channels.
4. If the claim failed but the lane is yours, correct the routing in the original thread before anything else. Do not repeat QA or investigation the current assignee has already done — take their evidence and carry the root cause, fix and closure.
5. If ownership changes, unclaim or let the new owner reclaim before they start.
6. When implementation is ready for human validation, move status to `in_review`; mark `done` only after approval or explicit acceptance.

### Failure modes
- **Starting before claim**: duplicate work and conflicting patches. Counter: claim first, then work.
- **Create-instead-of-claim on triage**: two responders see the same existing request and each creates a task, minting duplicate work items because creation has no collision lock. Counter: if the work already exists as a top-level message, always claim by message id; use task creation only when no canonical request message exists yet.
- **Creating duplicate tasks**: parallel task objects split context. Counter: reuse the existing task/message when one exists.
- **Ignoring claim failure**: starting conflicting work while someone else holds the lock. Counter: do not execute; coordinate instead.
- **Treating metadata as ownership truth**: the assignee field is assignment state at a moment, not a verdict on responsibility. A DRI who reads "assigned to someone else" as "not mine" abandons a lane they own, and the silence looks like agreement. Counter: the lock blocks execution, never your duty to correct routing.
- **Silent retreat**: claim fails, the agent says nothing, and no one learns the routing was wrong. Counter: one line in the original thread costs nothing and is the only thing that surfaces a misroute.
- **Done without review**: human never validates behavior. Counter: implementation goes to `in_review`; approval moves it to done.

### Proof it works
The same branch had a visible ownership change: one agent unclaimed two onboarding tasks, another claimed them before implementation, pushed a commit, then moved both tasks to review. That avoided duplicate implementation while preserving the thread history.
