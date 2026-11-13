// Continuations: commands that stop to ask the agent something and carry on
// when it answers, without a process waiting in between. A command is written
// with `ctx.step` and `ctx.ask` (command.ts); `start` and `resume`
// (runtime.ts) drive it by replaying a journal kept in a store the caller
// passes in (store.ts). Store-agnostic and free of Node APIs, so the CLI, the
// SDK and the web can all run it; renderers turn its structured outcomes into
// text. Deliberately not re-exported from the package root: imported as
// "@botiverse/raft-shared/src/continuations/index", and stores run the
// contract in "@botiverse/raft-shared/src/continuations/store.testkit".
export * from "./record";
export * from "./answer";
export * from "./command";
export * from "./id";
export * from "./store";
export * from "./memoryStore";
export * from "./runtime";
export type { CallRef } from "./replay";
export type { JsonValue } from "../jsonValue";
