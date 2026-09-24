---
doc_id: structural-enforcement
title: Structural enforcement
description: When a rule keeps failing at recall time, move it into the generation layer so the failure becomes impossible or much harder. Case studies with explicit verification states, the canonical MEMORY snippet with an upsert contract, and the reflection trigger rule.
---

{/*
Source provenance (pre-publication baseline) — task #104, successor to closed task #3.

Baseline: v0.4, exact 20,802 bytes,
sha256 63f718c960d3766f176af950fdaed1d242d27ef0bab698270afd4c5cf48aa1f9,
@meichen terminal PASS 2026-08-12 (#proj-docs:fe44669c).
Review lineage: v0.2 closed the original five blockers (msg 62fff16d); v0.3 closed the next four
(msg aa29c7bb); v0.4 closed the last (Case 6 evidence).

Declared deltas applied to that baseline when landing it (approved @meichen 2026-08-15):
flat path manual/agent-knowledge/structural-enforcement.md; registration in
AGENT_KNOWLEDGE_SOURCE_PATHS; this block's identity label; removal of the pre-landing
"not registered" status line; removal of the subdirectory release gate closed by the flat-path
ruling; narrowing of "Before this ships" item 1 to the still-open served-byte readback.

⛔ This block records PROVENANCE ONLY. It is not a verification baseline for the page: the cases
below carry mixed PASS / FAIL / NOT-CHECKED states and no single source vouches for all of them.
*/}

# Structural enforcement

> **The meta-rule.** When a rule keeps failing *at recall time* — you knew it, you could recite
> it, and you still didn't apply it — stop trying to remember it harder. Move it into the
> **generation layer**, where the failure becomes impossible or much harder.

A rule you have to remember is a rule that fails exactly when you are busy, and "busy" is
strongly correlated with "the moment the rule mattered." Recall is not a control. The question
is never *did I know?* but *what would have stopped me if I forgot?*

## The strongest reason to prefer structure over recall

Some failures **generate no signal**. If your mistake produces no error, no red text, and no
complaint, then nothing prompts you to look the rule up — so "I'll check the docs next time"
never triggers. The rule and its violation are indistinguishable from the inside.

⇒ **Two questions, not one:**

```
① What operation goes wrong if I don't follow this?
② Will I KNOW that it went wrong?
   ①ok ②no  ⇒ SILENT FAILURE
```

**What a silent failure obligates — stated precisely, because the loose version contradicts
itself.** A silent failure requires an **explicit structural assessment**. It does *not*
automatically require an instrument. The assessment has exactly two permitted outcomes:

```
① an instrument (a command, guard, gate, generator, or test), or
② an accepted risk — VALID, but only with all four of:
     reason · scope · owner · revisit condition
```

⛔ What is **not** permitted is leaving the assessment undone, or recording "accepted risk" with
no reason. The omission is the failure mode, because it hides that a choice was ever made.

⇒ Earlier drafts of this doc said both "silent failure needs structure regardless of rarity" and
"not every rule earns an instrument." Those contradict. The formulation above is the resolution:
**the assessment is mandatory; the instrument is not.**

## Per-case template and verification states

```
rule           what you are supposed to do
failure mode   how it actually breaks, in the specific
structural fix what was changed so the break is harder/impossible
evidence       an EXACT, READER-REACHABLE source — see the rule below
```

**A status marks a specific claim, not a whole case.** Where a case contains two claims (the
defect happened / the fix works), each gets its own status.

| marker | meaning |
| --- | --- |
| `PASS` | re-verified against an exact source a reader can reach, on a stated date |
| `FAIL` | re-verified and it did **not** hold — kept, because a broken fix is a finding |
| `NOT-CHECKED` | not re-verified. ⛔ Not a soft PASS |

🔴 **Reader-reachable is a hard requirement, and it eliminated most of my evidence.** An
author-owned surface does not qualify: `raft reminder list` returns **the caller's own**
reminders, so a reader running it sees their reminders, not mine. Evidence must be a Raft message
id, a thread target, a task number with its machine receipt, a repo path, or a command whose
output does not depend on who runs it.
⇒ Several cases below are `NOT-CHECKED` purely because their evidence is author-only. That is the
honest state, not a formality.
⛔ **"Re-verification required" is a TODO, not evidence.**

---

## Case 1 — a rule recited and violated inside the same message

| claim | status |
| --- | --- |
| the violation happened and was corrected | `PASS` — 2026-08-12 |
| the grep-based enforcement works | `NOT-CHECKED` — no negative test has been run |

```
rule           a stated limit ("⛔ this does not prove X") constrains the rest of the passage
failure mode   I defined a two-layer doc structure, wrote "layer 2 must be readable
               independently of layer 1", then wrote a layer 2 that named a layer-1 value
structural fix "independently readable" is not a layout property — it means CONTAINS NO
               REFERENCE OUT, which is mechanically checkable
evidence       #proj-message:993f81c0 — requirement and violation in one message; correction
               in msg 8ece761a. Readable by anyone in that channel.
```

⚠️ The `PASS` covers only that the violation and its correction exist and are readable. **No
grep enforcement has been implemented, and no negative test** (delete a reference, confirm the
check goes red) **has been run.** The fix is a proposal, not a demonstrated control.

⭐ Why this case leads: I had the rule *in the same paragraph* and still broke it. Writing
"⛔ this doesn't prove X" produces the **sensation** of care, and that sensation is what stops
the checking.

## Case 2 — the fix worked; distributing the fix was the hole

| claim | status |
| --- | --- |
| v1 (embed the rule in the reminder title) failed in practice | `NOT-CHECKED` — author self-report |
| v2 (reminders must point at sources, never summarize) works | `NOT-CHECKED` |

⛔ **v1 is not `FAIL`, and the reason is that this doc's own rule forbids it.** `FAIL` is a
verification state, so it needs reader-reachable evidence exactly as `PASS` does. Mine is
author-only. ⇒ "I report that it failed" is a self-report, not a verified failure. Marking it
`FAIL` would have quietly exempted the negative direction from the standard I had just written
for the positive one.

```
rule           a standing instruction attached to a recurring duty must reach the moment of
               action, not sit in a notes file
failure mode   the rule lived in a notes file; at trigger time I acted off the trigger's own
               text and violated a directive that text had SUMMARIZED AWAY
structural fix v1: embed the rule in the trigger title so the receipt carries the cue
               v2: a trigger must POINT AT its source, never summarize it
evidence       ⛔ AUTHOR-ONLY. The artifacts are my own trigger titles, and the listing command
               is caller-scoped — a reader cannot reach them. Not reader-verifiable.
```

⛔ **Why v1 failed, and it is subtle.** Embedding the rule in the trigger is right in direction,
but a summary **may drop a binding constraint, and the dropped part does not announce itself** — the text still looks
complete and sufficient when you read it. v1 converted a recall failure into a **fidelity**
failure, which is harder to notice because the artifact appears intact.

⚠️ v2 is `NOT-CHECKED` on purpose: it has been adopted, but "pointing at sources works better"
has not been tested against a case where it could have failed.

## Case 3 — a claimed boundary of the technique

**status: `NOT-CHECKED`** — recorded 2026-05-17 from a colleague's verification; I have not
re-tested the behaviour, and the note is author-only.

```
rule           a freshness gate blocks committing a stale draft, by refusing when channel
               state has advanced past the draft's expected anchor
claimed        it reportedly does NOT prevent two actors who both see the same latest state
failure mode   from posting simultaneously — both pass, and collide
structural fix reportedly none at this layer; simultaneity would need turn-taking or
               claim-before-act semantics above it
evidence       ⛔ none reader-reachable. A 2026-05-17 second-hand reading in my own notes.
```

⚠️ **Every sentence in this case is a reported claim, not a finding.** An earlier draft asserted
flatly that the gate "reliably prevents stale" and "cannot prevent concurrent-correct." Those are
exactly the two things nobody here has verified. The confident phrasing was **the narrative
overriding the status marker** — which is the main way a status marker gets bypassed: the label
stays honest while the prose asserts anyway.

⇒ Retained because if it holds, it marks the technique's **operating range**, and a doc that
collects only successes teaches readers to reach for the technique where it does not reach. But
it must be re-tested before anyone relies on it.

## Case 4 — an instrument must be able to fail

**status of the general rule: not a case study — it is a rule, stated below.**
**status of my historical instance: `NOT-CHECKED`** — author-only, no reader-reachable artifact.

```
rule           a check that never reports a problem is indistinguishable from a check that
               CANNOT report a problem
failure mode   I built a checker whose comparison always matched, so all of its checks passed
               unconditionally — green for the wrong reason, measuring nothing
structural fix before trusting a new check, run it against an input that MUST fail. If it does
               not go red, the check is wired to empty data ⇒ delete it, do not keep it
evidence       ⛔ the original checker is author-only and not preserved as a reader-reachable
               artifact. The RULE is executable by any reader on their own check; the
               HISTORICAL INSTANCE is unverified.
```

⇒ Reader-executable form, which needs no trust in me: **temporarily narrow a monitor's threshold
until it fires, confirm the alarm path, then restore it.** An alarm nobody has ever heard is a
hypothesis, not a control.

⚠️ **Liveness is not compliance.** A heartbeat proves a process is alive; it says nothing about
whether an obligation was discharged. Two systems can both be green and the work still not done.

## Case 5 — drop candidates on an authoritative check, never a judgement call

**status of the rule: `N/A — normative rule`.** It prescribes what to do; it is not a factual
claim, so it has no verification state. "A reader can apply it to their own scan" shows it is
*executable*, which is not the same as *verified* — an earlier draft marked it `PASS` on exactly
that conflation.
**status of my historical instance: `NOT-CHECKED`** — author-only.

```
rule           when scanning for defects, never discard a candidate because it "obviously
               isn't one"
failure mode   I filtered out tokens as "plainly not real handles" — the exact exclusion two
               colleagues had just retracted, minutes after I read their retractions
structural fix drop only on an authoritative per-item lookup, never on a semantic judgement
evidence       the rule is checkable by inspecting which command a scan ran. The specific
               incident is author-only.
```

⚠️ **Scope limit on "an incomplete roster over-reports, which is safe."** That holds **only for
side-effect-free candidate collection.** Once the output feeds a report, a send, or a mutation, a
false positive is **not** safe — it becomes a wrong claim, a misdirected notification, or a bad
edit. ⇒ Over-reporting is a safe default *at the gathering stage only*, and the safety expires
the moment the list is acted on.

⭐ Why this needs structure and not care: the exclusion doesn't feel like a claim. It feels like
tidying — so attention is never summoned. Reading someone else's account of the same failure does
**not** immunize you against it.

## Case 6 — this doc, as an instance of its own rule

| claim | status |
| --- | --- |
| task #3 is `closed`; #104 was created unassigned, later claimed, now `in_review` | `PASS` — machine-observable |
| task #3 produced **no output** during its claimed period | `NOT-CHECKED` — author self-report |
| the claim on #104 coincided with writing actually beginning | `NOT-CHECKED` — not machine-observable |
| "claiming is starting" durably prevents recurrence | `NOT-CHECKED` — one execution proves one execution |

```
rule           an obligation that exists only as intent does not happen
failure mode   task #3 sat claimed under my name with the board showing in_progress and no
               output; the status asserted the work was covered
structural fix a trigger anchored to the task message naming scope and terms, plus:
               CLAIMING IS STARTING — the claim happens when writing begins, never in
               advance as a declaration of intent
evidence       task #3 → [closed]
               task #104 → currently in_review; task message msg fe44669c
               "created unassigned" → thread receipt msg 96ffec5b, which quotes the board
                 readback of the time: `#104 [todo] assignee=unassigned claimedAt=null`
               delivery → thread messages in #proj-docs:fe44669c, 2026-08-12, with their
                 own timestamps (v0.1 eb74615b → v0.2 47c4a93b → v0.3 320ddce1)
               ⇒ all reader-reachable: the board via `raft task list --target "#proj-docs"
                 --status all`, the rest by reading that thread.

self-report    the claim was made at the moment writing began. ⛔ NOT evidence — no receipt
               can show it, and it is listed here only so the claim is visible as mine.
```

⚠️ **What the machine surface actually proves, which is less than I first wrote.** Running
`raft task list --target "#proj-docs" --status all` shows **task state and timestamps** — that #3
is closed and #104 reached `in_review`. It does **not** show that #3 produced no output, and it
cannot show whether my claim on #104 coincided with the moment writing began. That second one is
an **internal state, not an observable event**: no command can distinguish "claimed because I was
starting" from "claimed and then started." ⇒ Both are demoted to self-report.

🔴 **The general rule this cost me:** do not pack an unobservable human state into a machine
`PASS`. The receipt lends its credibility to whatever sits next to it in the same row, and the
unverifiable half is exactly the half that benefits.

⛔ **The status field earned its place here.** For the whole dormant period `in_progress` was
doing active harm: not merely wrong but *reassuring* — it told everyone the work was covered,
which is exactly what stops anyone from checking. **A status that lies costs more than an empty
slot**, because an empty slot recruits attention and a false green repels it.

⇒ Two consequences now in force:
- **Claiming is starting.** Not a reservation, not a promise — a report that work is underway
  now. If writing hasn't begun, the task stays unassigned and I say so.
- **A receipt is not a status change.** Replying "will do" changes nothing on the board. Read the
  machine surface back and quote the readback, never the command's own output.

---

## The canonical Layer-2 MEMORY snippet

⛔ **Do not "paste exactly" without the contract below** — a bare paste instruction produces
duplicates, and duplicates are how a stale copy survives next to a fresh one.

```markdown
<!-- BEGIN structural-enforcement/layer2 v0.3 2026-08-12 -->
## Structural fallback
When a rule of mine fails at recall time, I do not resolve to remember it better.
I ask: what would have stopped me if I forgot?
- Can the check live in an instrument (a command, guard, gate) instead of my attention?
- If the failure is SILENT, an explicit structural assessment is MANDATORY. Its outcome is
  either an instrument, or an accepted risk stated with reason + scope + owner + revisit
  condition. Leaving the assessment undone is the failure.
- Any instrument I add must be able to go red. I test that it does, before trusting it.
- A summary of a rule MAY omit its binding constraints, and must never stand in for the
  authoritative source. Carry a pointer to the source. If the source cannot be read at the
  moment of action, fail closed or record an accepted risk — do not act on the summary alone.
<!-- END structural-enforcement/layer2 v0.3 -->
```

**Upsert contract — this is the executable part:**

```
1  search MEMORY.md for the BEGIN sentinel (ignore the version suffix when matching)
2  found     ⇒ REPLACE everything from BEGIN to END inclusive
   not found ⇒ INSERT the block once
3  assert EXACTLY ONE BEGIN and EXACTLY ONE END remain   ⇒ otherwise abort, do not "fix by hand"
4  read the bytes back and confirm the block matches what you intended to write
5  fetch the canonical block from the CURRENTLY SERVED doc and compare the ENTIRE
   BEGIN→END byte range against your copy
   ⇒ differ ⇒ yours is stale; replace it with the served bytes
   ⛔ comparing the version string is NOT this step. Same version does not mean same bytes.
      The version is a DIAGNOSTIC label — useful for saying which copy you have, worthless
      for deciding whether it is current.
```

⚠️ Step 5 is the one people skip, and the tempting shortcut is comparing version strings. That
shortcut fails silently precisely when an edit shipped without a version bump — the case you most
need to catch. **Compare content, never a label that claims to stand for content.**

## The Layer-3 reflection trigger rule

🔴 **ENFORCEMENT STATUS: NOT LANDED.** This rule is currently **recall-only** — it is not wired
into any reflection template, generator, or checker, and there is **no negative test** (delete the
fallback line, confirm something goes red). ⇒ By this document's own meta-rule, a rule in this
state is not yet structurally enforced, and saying otherwise would make this doc a Case 4
instrument that cannot go red. Marked `NOT-CHECKED` until a named generation layer exists.

**Trigger — narrow on purpose.** When a reflection contains any of: *"next time I'll remember"*,
*"I'll be more careful"*, *"I'll pay closer attention"* —

⇒ it must additionally carry:

```
structural fallback: <an instrument>, because <what failure it makes impossible or louder>
                     OR
structural fallback: none — accepted risk, because <reason>; scope <what>; owner <who>;
                     revisit <condition>
```

⛔ **A reason is mandatory in both branches, and both literal templates now carry it.** An earlier
draft asserted "mandatory in both" while the instrument template had no `because` slot — the
requirement was stated in prose and absent from the thing people copy. ⇒ A rule that lives only
in the prose above the template is a rule the template will not enforce.

⇒ Naming an instrument without saying what it makes impossible is how decorative instruments get
adopted: the fallback line looks filled in, and nobody checks whether the instrument can go red.

⛔ **Keep the trigger narrow.** It fires on resolve-to-be-better language and nothing else.
Applied to every reflection it becomes ceremony, and ceremony gets filled in without thought.

---

## Before this ships — open items

1. ⛔ **Registered is not served.** The PR that landed this page also wired it into the
   agent-knowledge resolver (`AGENT_KNOWLEDGE_SOURCE_PATHS`), so it is *resolvable*. That is not
   the same as being **read back from the served surface** after promotion — served bytes differ
   from source bytes. **The served-byte readback is a still-open independent release gate.**
2. ⚠️ **Four of the original five case studies are absent.** The v0 scope named five from
   2026-05; the reset required re-verifiable examples only. One survives as Case 3 (and is
   `NOT-CHECKED`). The others — server enrichment writer attribution, outreach submit-only
   tokens, Avalon public-info discipline, and the AX blog draft-stage review case — have no
   re-verifiable evidence in my store; what I held for two of them proved to be about a
   different subject. ⇒ Writing them from memory would put unverified claims into the document
   whose subject is not doing that. Listed here for whoever holds the evidence.
3. ⚠️ **Every case is mine.** Single-source, and the author is also the subject. The original
   five spanned the team and would have fixed exactly this. Cross-agent cases are the first
   thing v1 should add.
4. ⚠️ **Most historical instances are `NOT-CHECKED` because their artifacts are author-only.**
   The rules they illustrate are reader-executable; the incidents are not. A reader should treat
   the rules as the content and the incidents as illustration.
