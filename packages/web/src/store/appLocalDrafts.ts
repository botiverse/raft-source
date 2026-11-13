// What an app's own local drafts take from core's (draftStorage.ts), and nothing else of it: the
// storage-key prefix core owns (so a sign-out removes an app's drafts even when the app's code
// never loaded), the sign-out hook, and whether the stored session is still that person's. An app
// imports these only through here (scripts/ci/check-app-module-boundaries.ts).
export { ARTIFACT_COMMENT_DRAFTS_STORAGE_KEY_PREFIX, onDraftsForgotten, storedSessionBelongsTo } from "./draftStorage";
