---
name: wiki-lint
description: Audit the canonical compiled Wiki for structural and semantic integrity, then repair source-backed issues through the same immutable revision and manifest CAS publication path.
---

# Wiki Lint

Read `AGENTS.md` before using this skill.

Run this skill whenever the canonical weekly Wiki lint reminder fires, and
when a human explicitly asks for a Wiki audit. The weekly reminder is the
default autonomous integrity check; it must not wait for a human request.

## Preconditions

- `raft wiki manifest`, `raft wiki read`, and `raft wiki publish` are available.
- This Agent is the configured Wiki Agent.

If any precondition is missing, report the exact blocker. A partial audit is
not a clean lint result.

## Procedure

1. Run `raft wiki manifest` and retain the complete response and ETag.
2. Read the canonical Index, Log, and every current Page with
   `raft wiki read <artifactId>`. Never lint manifest metadata without reading
   the current Markdown bodies.
3. Check structural integrity:
   - every current Page is discoverable from Index
   - Index and Log references point to current manifest artifacts
   - titles, slugs, artifact types, revision receipts, and status labels agree
   - no orphaned, duplicated, or circularly fragmented topic pages exist
   - short Pages that answer the same durable question are not needlessly
     fragmented across multiple documents
   - large Pages do not mix unrelated durable questions that should be
     independently discoverable
4. Check semantic integrity:
   - material claims have eligible, resolvable Raft source references
   - current Pages do not contradict one another without showing the conflict
   - stale or superseded conclusions are labeled and do not masquerade as live
   - time-sensitive or `prefer_live_source` claims are verified against Raft
   - summaries, owners, limits, uncertainty, and next steps match the body
5. Compare the proposed canonical documents and artifact metadata against the
   current snapshot. If no source-backed repair is required, report a clean
   read-only lint and publish nothing: no revision body, Log entry, lint
   receipt, or Manifest revision. A clean Wiki is a fixed point. Running lint
   again with no new source or canonical change must produce the same zero-write
   result.
6. For repairable source-backed issues, reorganize the Wiki when that improves
   durable retrieval and maintenance:
   - merge short or overlapping Pages that answer the same durable question
   - split oversized Pages that combine independently useful topics
   - remove duplicate inventory entries and repair orphaned navigation
   - preserve a short Page when it already answers one clear durable question
     with reliable sources; length alone is never a deletion rule
   - require high-confidence source-backed evidence for every structural
     change; if the durable topic boundary is ambiguous, leave it unchanged
7. Preserve topic identity across structural repairs:
   - the stable artifact id plus slug is the topic identity
   - on merge, keep one survivor and turn every absorbed Page into an archived
     redirect to the survivor; never remove its artifact from the Manifest
   - record the absorbed topic in the survivor so later Ingest routes matching
     evidence there instead of recreating the old fragment
   - on split, keep the original identity for its clearest durable question
     and create a new identity only for a genuinely independent question
8. Reread the manifest immediately before constructing the publication. Create
   new immutable revisions only for changed documents, reconcile Index and Log
   for every merge, split, rename, or archival change, and preserve both
   `coverage` and the prior `lastIngest` receipt byte-for-byte. Set
   `lastLint` to one new `repaired` receipt whose `repairedArtifactIds` names
   exactly the artifacts with new revisions. Publish once with the retained
   ETag through `raft wiki publish --input <publication.json>`.
9. On HTTP 409 / `WIKI_MANIFEST_PUBLISH_FAILED`, reread every affected current
   artifact and recompute the repair. Never replay an old payload with a new
   ETag.

## Boundaries

- Do not create additional lint jobs, tables, reminders, schedules, caches, or
  a second write path. The Server owns exactly one canonical weekly lint
  reminder for this Agent.
- Do not merge, split, rename, or archive Pages for superficial style or a
  mechanical byte/word threshold. Structural changes must improve retrieval,
  comprehension, or ongoing maintenance.
- Do not oscillate between equally valid layouts. Once a source-backed
  structure is clean, preserve it until new evidence changes the durable topic
  boundary.
- Do not delete or rewrite durable knowledge without source-backed reason.
- Do not treat inaccessible source as disproven; report the verification gap.

## Report

Report artifacts checked, findings by severity, structural merge/split/
navigation repairs published or skipped, the resulting manifest revision/ETag
when changed, and unresolved source or permission blockers.
