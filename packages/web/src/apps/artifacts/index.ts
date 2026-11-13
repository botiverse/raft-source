// Workspace Artifacts in the web app (feat/workspace-artifacts, S3). The rest
// of the web app imports only from here (scripts/ci/check-app-module-
// boundaries.mjs); everything is behind workspace_artifacts_v0.
export { default as ArtifactMessageRefs, artifactLinkOf, useArtifactLinkTargets } from "./ArtifactMessageRefs";
/** The one way an Artifact clicked inside Raft opens: in the layout it was clicked in (#proj-workspace:#104). */
export { openArtifactOnPlainClick } from "./openArtifactInPlace";
export type { ArtifactLink, ArtifactLinkState } from "./ArtifactMessageRefs";
/** A message's Artifact links for core's per-message link-card hook: their one read, and what their chip shows. */
export { useArtifactLinkSummaries } from "./artifactSource";
/** The fake data source dev build (VITE_ARTIFACTS_SOURCE=fake): main.tsx installs it before the first render. */
export { installFakeArtifactSourceForDev } from "./artifactSource";
export { artifactObjectRefOf } from "./apiArtifactSource";
export { artifactAppHosts, artifactUrl, useArtifactAppHosts } from "./artifactLinks";
export type { ArtifactLinkTarget } from "./artifactLinks";
export { ArtifactLinkPreview, useArtifactsAppName } from "./ArtifactLinkPreview";
/** An Artifact kind's icon, as an Artifact link's chip shows it. */
export { artifactKindIcon } from "./ArtifactCardParts";
/** An Artifact's Activity row (core's `GET /api/channels/inbox` object rows): its icon, title, who did what, and the version and review it opens at. */
export { artifactActivityComment, artifactActivityExcerpt, artifactActivityImagesOnly, artifactActivityPinnedVersion, artifactActivityReview, artifactActivityRowParts, artifactActivityTarget } from "./artifactActivityRow";
/** What an opener of an Artifact (a card, a Files or Activity row) spreads on itself: pressing, hovering or focusing it starts the open. */
export { rememberArtifactCard, useArtifactOpenIntent } from "./artifactOpenIntent";
export type { ArtifactActivityRowParts } from "./artifactActivityRow";
/** The viewer of an Artifact opened from its Activity row, in Activity's main area; loaded only when one opens. */
export const loadArtifactActivityViewer = () => import("./ArtifactActivityViewer");
export type { ArtifactActivityViewerProps } from "./ArtifactActivityViewer";
export { ARTIFACT_CARD_MIN_WIDTH, ArtifactCoverViewer, useArtifactClosed, useArtifactHeaderBack, useArtifactHost, useArtifactShell, useArtifactSideCard, useShellArtifactCard } from "./ArtifactSideCard";
export type { ArtifactCardPlace, ArtifactSideCard } from "./ArtifactSideCard";
/** The title of the Artifact open beside a conversation, for the side window's switch chip (features/webPreview). */
export { useOpenArtifactTitle } from "./artifactShownTitle";
export { ArtifactSavedAttachments, canSaveAsArtifact, setArtifactSessionScope, useArtifactAttachmentMenu } from "./ArtifactAttachment";
export { artifactRealtimeStandIn } from "./artifactRealtimeStandIn";
export { usePhoneHistoryEntry } from "./artifactPhoneHistory";
export type { ArtifactAttachmentContext, ArtifactAttachmentInput } from "./ArtifactAttachment";
export { artifactLinkSendNoteKey, setArtifactShareHost } from "./artifactShareHost";
/** "Send to conversation": an Artifact as what core's Forward dialog forwards. */
export { useArtifactForward } from "./ArtifactForward";
export type { ArtifactForward } from "./ArtifactForward";
/** Who can be @mentioned on an Artifact: the object audience behind core's mention picker. */
export { artifactMentionCandidates } from "./artifactMentionCandidates";
/** A conversation's own Artifacts in its Files tab (#proj-workspace:#59): their list and one row each. */
export { openConversationArtifact, useConversationArtifacts } from "./conversationArtifacts";
/** A channel's announcement (its strip, its details row): opened beside the channel, and whether it is open there. */
export { openChannelAnnouncement, useArtifactOpenBeside } from "./conversationArtifacts";
export type { ConversationArtifactsView } from "./conversationArtifacts";
export type { ArtifactForwardDialogProps, ArtifactForwardTarget, ArtifactLinkSendDialogProps, ArtifactHostConversation, ArtifactMessagePlace, ArtifactOpenMessageOptions, ArtifactShareHost, ArtifactUploadLimitsHost } from "./artifactShareHost";
/** The Artifacts home page (S7), loaded only on its route. */
export const loadArtifactsDashboard = () => import("./ArtifactsDashboard");
export type { ArtifactsDashboardProps } from "./ArtifactsDashboard";
/** The Artifacts group of core's search (`GET /api/search`): its row, and where a hit opens. */
export { ArtifactSearchHit } from "./ArtifactSearchHit";
export type { ArtifactSearchHitProps } from "./ArtifactSearchHit";
/** The Artifacts home page's address of the Artifact open over it (`?artifact=`, `&version=`, `&from=`): its host keeps the viewer there. */
export { ARTIFACT_OPEN_FROM_PARAM, ARTIFACT_OPEN_PARAM, artifactOpenPath, artifactOpenTarget, withArtifactOpenParams, withArtifactOpenVersion, withoutArtifactOpenFrom, withoutArtifactOpenParams } from "./artifactLinks";
export type { ArtifactOpenAddress, ArtifactOpenShown } from "./artifactLinks";
/** The canonical link's page (`/artifacts/<id>`, `/v/<n>`): opens it where the server says, loaded only on its route. */
export { loadArtifactPermalink } from "./artifactOpenEarly";
/** Boot on a canonical link's address: its page, content connection and its one call (`open`) started ahead of `/auth/me`. */
export { artifactPermalinkTargetOf, artifactShortAddressOf, openArtifactEarly, prepareArtifactPermalink } from "./artifactOpenEarly";
export { artifactLinkLeaveServer } from "./artifactLinkLeaveServer";
export type { ArtifactPermalinkProps } from "./ArtifactPermalink";
/** What the canonical link shows until it knows what to show ("Loading Artifact"): the boot shell, the app's boot and the page's own wait. */
export { default as ArtifactLinkLoading } from "./ArtifactLinkLoading";
/** The canonical link's page for a visitor who is not signed in, when the Artifact is public; loaded only on its route. */
export const loadPublicArtifactPage = () => import("./PublicArtifactPage");
export type { PublicArtifactPageProps } from "./PublicArtifactPage";
/** Whether this workspace has Workspace Artifacts on (workspace_artifacts_v0); core reads it to decide what a guest shell offers. */
export { useWorkspaceArtifactsEnabled } from "./useWorkspaceArtifactsEnabled";
/** The open Artifact viewer (which conversation it belongs to); a guest shell reads it to keep that conversation reachable. */
export { openArtifactOverDialog, useArtifactViewerStore } from "./artifactViewerStore";
export type { ArtifactAddressedPlaces } from "./artifactViewerStore";
