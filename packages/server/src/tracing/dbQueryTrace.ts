import type { TraceAttributes } from "@botiverse/raft-shared";

export type DbQueryTracer = <T>(
  queryName: string,
  work: () => Promise<T>,
  onComplete?: (result: T) => TraceAttributes | undefined,
  onError?: (error: unknown) => TraceAttributes | undefined,
) => Promise<T>;

export const untracedDbQuery: DbQueryTracer = (_queryName, work) => work();
