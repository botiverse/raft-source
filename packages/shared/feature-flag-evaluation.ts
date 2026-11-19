/**
 * Narrow import leaf for pure feature-flag evaluation so the Feature Flag Admin
 * Worker and the API server run the exact same rule ordering, bucket hashing,
 * plan cohort matching, and fallback logic without importing the package root.
 */
export * from "./src/featureFlagEvaluation";
