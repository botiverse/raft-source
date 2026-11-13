// The trace upload receiver rule lives in shared (shared/src/traceUploadUrl.ts)
// so the Computer's forced diagnostics upload picks its receiver by the same
// rule as this daemon's uploader.
export * from "@botiverse/raft-shared/src/traceUploadUrl";
