// A value a caller may get synchronously or as a promise: store interfaces
// answer synchronously when they are backed by the CLI's SQLite ledger and
// asynchronously elsewhere. Neutral ground for the modules that share the
// shape (the seen policy, continuations), so neither imports it from the other.

export type MaybePromise<T> = T | Promise<T>;
