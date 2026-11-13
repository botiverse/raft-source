import type { ArtifactReference } from "@botiverse/raft-shared";

import { fakeArtifactStandIns, usingFakeArtifactSource } from "./artifactSource";
import type { FakeAttachmentSavedEvent } from "./fakeArtifactSource";

/**
 * TODO(S5 server, Remy): delete with the fake source. While the fake data
 * source is active there is no server to broadcast `artifact:attachment-saved`
 * or to compute `savedAsArtifact` for a refetched message, so core asks this
 * instead of the socket and the message API. Inactive with the API source.
 */
export const artifactRealtimeStandIn = {
  active: (): boolean => usingFakeArtifactSource(),
  onAttachmentSaved: (listener: (event: FakeAttachmentSavedEvent) => void): (() => void) => fakeArtifactStandIns()?.onAttachmentSaved(listener) ?? (() => {}),
  savedAsFor: (attachmentId: string): ArtifactReference | null => fakeArtifactStandIns()?.savedAsFor(attachmentId) ?? null,
};
