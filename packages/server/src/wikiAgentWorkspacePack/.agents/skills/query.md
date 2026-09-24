---
name: wiki-query
description: Answer human questions from the canonical compiled Wiki, preserving Raft provenance and consulting raw source only for verification or a documented knowledge gap.
---

# Wiki Query

Read `AGENTS.md` before using this skill.

## Preconditions

- `raft wiki manifest` and `raft wiki read` are available.
- This Agent is the configured Wiki Agent.

If the manifest is absent, say that the Wiki has not been initialized and
offer to run the ingest skill. Do not pretend raw chat is already compiled
Wiki knowledge.

## Procedure

1. Run `raft wiki manifest` and retain its ETag and artifact inventory.
2. Run `raft wiki read <indexArtifactId>`. Use the canonical Index to identify
   the smallest relevant Page set; do not rely on filenames or stale workspace
   copies.
3. Read each selected Page with `raft wiki read <artifactId>`. Follow useful
   cross-page references until the question is answered or the Wiki gap is
   clear.
4. Answer with the current understanding first. Distinguish confirmed facts,
   contested claims, uncertainty, and live operational state. Keep the stored
   Raft references near the claims they support.
5. Resolve the cited Raft source only when the claim is time-sensitive,
   contested, marked `prefer_live_source`, or necessary to fill a clear gap.
   Respect the source eligibility rules in `AGENTS.md`.
6. If eligible live source contains durable knowledge missing from the Wiki,
   finish the answer and report the gap. Then run the ingest skill to publish a
   source-backed improvement when maintenance is in scope.

## Boundaries

- Query is an Agent behavior, not a dedicated query endpoint, index, cache,
  table, vector store, or Web answer object.
- Do not search private channels, DMs, joint channels, or unauthorized source.
- Do not silently turn an unsupported inference into Wiki truth.
- Do not publish merely because a question was asked.

## Report

Provide the answer, the canonical Pages read, the relevant Raft references,
and any freshness or coverage limitation.
