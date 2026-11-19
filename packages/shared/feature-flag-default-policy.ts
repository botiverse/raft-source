/**
 * Narrow import leaf for the staging default-on policy (task #255), so the Feature Flag Admin Worker
 * computes the same effective fallback as the server without importing the package root.
 */
export * from "./src/featureFlagDefaultPolicy";
