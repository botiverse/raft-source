/**
 * A publish check's ticket (task #proj-workspace:#130; the server's
 * packages/server/src/apps/artifacts/checkFrame.ts): Raft's server signs a
 * ticket with viewer `system:check` and subject `v1:check:<artifact>:<version>`,
 * which the check's headless browser opens top-level. It names no ancestor
 * (no ticket does: the shared verifier refuses one) and adds nothing to any
 * response's `frame-ancestors`. A pure function: the Worker
 * (raftContentService.ts) and its tests both take it from here.
 */

/** The subject of a check's ticket: the one Artifact and version it opens (the server's `checkContentSubject`). */
export const checkSubjectOf = (artifact: string, version: string): string => `v1:check:${artifact}:${version}`;
