// What a first-party app (apps/<id>/) may use to load its own code off the
// first screen: the app module boundary (scripts/ci/check-app-module-boundaries.ts)
// registers this file, not boot/deferredUi or utils/dynamicImportRecovery
// whole. See docs/frontend/boot-bundle.md.
export { lazyDeferred, prefetchAfterFirstScreen } from "./deferredUi";
export { sharedModule } from "./sharedModule";
export { LazyChunkBoundary, useRetryableLazy } from "./lazyChunk";
export type { LazyChunkSlot } from "./lazyChunk";
export { importHandledLocally, isDynamicImportFailure } from "../utils/dynamicImportRecovery";
