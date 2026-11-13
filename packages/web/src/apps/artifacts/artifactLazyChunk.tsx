// The Artifact viewer's and frame's retryable chunks: the shared boundary and
// retry (boot/lazyChunk), under the names this app uses.
export { LazyChunkBoundary as ArtifactChunkBoundary, useRetryableLazy } from "../../boot/appChunkLoading";
export type { LazyChunkSlot } from "../../boot/appChunkLoading";
