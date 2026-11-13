// Platform entry point: an app's object storage. The platform owns one
// app-content bucket and its credentials (APP_STORAGE_R2_*, configured once);
// each first-party app keeps its objects under its own `apps/<id>/` prefix,
// through a handle core builds from the app's registration and hands it
// (FirstPartyApp.receiveObjectStorage, services/appObjectStorage.ts). The
// handle adds the prefix and refuses keys that could leave it; it runs on
// core's storage code (the same pool settings, timeouts, put metrics and
// traces as core's buckets). An app never holds the bucket, its client or its
// credentials, and never reaches core's attachment or CDN buckets. Only the
// types and errors are here: the factory is core's, so an app can't build a
// handle for another app's prefix.
//
// Keys are relative, and an app stores them relative: the handle takes only
// keys under the app's prefix as the app names them (`servers/…`), adds
// `apps/<id>/` itself, and refuses one that could leave the prefix. A full
// key never leaves the handle; a reader that binds the bucket itself (such
// as Artifacts' content Worker) adds the same fixed prefix.
export { AppObjectStorageUnavailableError, InvalidAppObjectKeyError, type AppObjectStorage } from "../services/appObjectStorage";
