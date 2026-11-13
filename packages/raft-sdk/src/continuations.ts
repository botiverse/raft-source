// `@botiverse/raft-sdk/continuations` (experimental): commands that stop to
// ask the agent something and carry on when it answers, without a process
// waiting in between. The runtime is the one the raft CLI runs
// (@botiverse/raft-shared continuations); this entry re-exports it under
// SDK names, adds a local file store, and the texts the CLI shows an agent,
// so a tool built on the SDK says exactly what the CLI says.
//
// Experimental: its shape may change in a minor release while the pilot runs
// (design: https://raft-artifacts.com/p/raft/interactive-tool-continuations,
// #wg-ax:bd99cbb6). Nothing here is exported from the package root or from
// `./agent`.
export {
  defineCommand,
  start as startCommand,
  resume as resumeContinuation,
  createMemoryContinuationStore,
  newContinuationId,
  parseContinuationId,
  ContinuationStepError,
  CONTINUATION_FORMAT_VERSION,
  CONTINUATION_PAUSED_EXIT_CODE,
  DEFAULT_CONTINUATION_TTL_MS,
  DEFAULT_CONTINUATION_RESULT_RETENTION_MS,
  CONTINUATION_RUN_LEASE_MS,
} from "@botiverse/raft-shared/src/continuations/index";
export type {
  Answer,
  AskOption,
  AskSpec,
  CommandDefinition,
  ContinuationCheckLine,
  ContinuationContext,
  ContinuationError,
  ContinuationId,
  ContinuationOutcome,
  ContinuationProgram,
  ContinuationRecord,
  ContinuationStatus,
  ContinuationStore,
  ContinuationTombstone,
  JournalEntry,
  JsonValue,
  MaybePromise,
  PausedContinuation,
  ResumeOptions,
  ResumeOutcome,
  RuntimeOptions,
  StartOptions,
  StepFailure,
  StepIdempotency,
  StepOptions,
} from "@botiverse/raft-shared/src/continuations/index";
export { formatContinuationPaused, formatContinuationRefusal } from "@botiverse/raft-shared/src/agentText/continuations";
export type { ContinuationPausedView, ContinuationRefusalView } from "@botiverse/raft-shared/src/agentText/continuations";
export { createFileContinuationStore } from "./continuationFileStore";
export type { FileContinuationStoreOptions } from "./continuationFileStore";
