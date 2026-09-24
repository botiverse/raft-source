# Wrong-patch verification artifact — `markdownCodeSpans` overlap (task #92)

This is a **patch that does not fix the defect but satisfies a criterion.**
It is kept deliberately. Any future revision of the task #92 acceptance criteria
must show that this artifact still **FAILS** them. If a revision lets it pass,
the criteria were weakened — and that becomes visible at the moment of revision
rather than at the next incident.

## Why keep it

Mutations are designed by the people who wrote the criteria, so they test the
failure modes those people imagined. This artifact was written by someone
genuinely trying to fix the bug, so it tests whether the criteria hold up
against a **real** error. Artifacts like this cannot be manufactured on demand;
when one turns up, it is kept.

## It is executable, not prose

`mergeOverlappingSpans.ts` holds the wrong implementation; `wrongPatch.test.ts`
runs the criteria against it. **A README cannot do this job** — prose has no
pass/fail, so it reads the same whether the criteria still catch this patch or
have stopped catching it, and a pasted snippet drifts from the real source with
nothing emitting a signal. The gate has to be able to go red.

```
criteria intact          => wrongPatch.test.ts passes (the patch is still rejected)
criteria weakened enough => it goes RED, at revision time
```

## What it does

`markdownCodeSpans` merges overlapping ranges instead of preventing them:

```js
const merged = [];
for (const span of spans) {
  const last = merged[merged.length - 1];
  if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
  else merged.push({ ...span });
}
return merged;
```

Merging preserves the spurious span's **extent** and folds it into the fence, so
the merged code span reaches the wrapped name's opening backtick and the name
still lands in prose.

## Measured behaviour

| criterion | result |
|---|---|
| identity property — `replaceOutsideMarkdownCode(s, identity) === s` | **GREEN** — satisfied |
| canonical S1 — `extractRaftMentionHandles("```\nx\n```\nA \`@handle\` B\n")` | `["handle"]` — **still leaking** |

So the identity property alone would have accepted it. Canonical does **not**,
because S1 asserts the extraction result itself — a consequence of the review
rule that every expected-green row must carry S1, so that "never parsed" and
"parsed then correctly excluded" cannot both read as green.

**Therefore:** the identity property may accompany an extraction assertion. It
may never replace one.
