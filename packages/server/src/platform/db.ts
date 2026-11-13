// Platform entry point: the database executor. A first-party app queries only
// its own schema through it; an executor it passes to another platform entry
// (a transaction or savepoint) makes that entry read or write inside the
// app's transaction. scripts/ci/check-app-module-boundaries.ts lists the
// platform entries an app may import.
export { getDb, type DatabaseExecutor } from "../db/index";
