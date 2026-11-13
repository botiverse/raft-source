// Platform entry point: the files of an app's objects (docs/development/
// first-party-apps.md, "Object files"; services/objectFiles.ts). A file is
// bytes and the type core detected
// in them (PNG, JPEG, WebP or GIF, nothing a browser runs), kept for an
// object of the app's registered kind and hung on one of the app's own parts
// by an opaque `<part>:<id>` (`version:<id>`, `comment:<id>`). Core stores
// it under its own prefix of the platform's bucket, bills an upload to the
// server the app names (the uploader's own), serves it at `GET /api/objects/:kind/:id/files/:fileId`
// to whoever can see the object now, and deletes it with what it hangs on.
// The app keeps only the file's id; keys, bytes and the storage handle stay
// core's.
//
// - putObjectFile: store bytes for a part (`parent`), or as an unclaimed
//   draft (`parent: null`), readable only by its uploader, that
//   claimObjectFile later hangs on a part (same object, same uploader), or
//   the hourly sweep deletes after an hour. Core reads the pixel size from
//   the header (refusing more than OBJECT_FILE_MAX_PIXELS before decoding),
//   removes metadata, and answers what it kept; `quota: "monthly"` bills it
//   to `billedTo` (the uploader's own server): that server's total, the
//   uploader's share there (`uploader_quota_exceeded`) and its monthly file
//   upload quota (FileUploadQuotaExceededError); `exempt` is the platform's own.
// - A file hung on a `draft:<id>` part (OBJECT_FILE_DRAFT_PART) is read only
//   by its uploader too; moveObjectFiles hangs a part's files on another part
//   of the same object in the app's transaction (a draft posted).
// - deleteObjectFiles in the app's transaction (a part's files, or every
//   file of an object being deleted), then deleteObjectFileBytes once it
//   committed. A failed byte delete is counted and retried by the sweep.
export {
  claimObjectFile,
  deleteObjectFileBytes,
  deleteObjectFiles,
  moveObjectFiles,
  OBJECT_FILE_DRAFT_PART,
  OBJECT_FILE_MAX_BYTES,
  OBJECT_FILE_MAX_PIXELS,
  OBJECT_FILES_MAX_BYTES_PER_SERVER,
  OBJECT_FILES_MAX_BYTES_PER_UPLOADER,
  OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER,
  OBJECT_FILE_UNCLAIMED_TTL_MS,
  ObjectFileRefusedError,
  putObjectFile,
  objectFilesUsage,
  readObjectFile,
  type DeletedObjectFiles,
  type ObjectFileBilling,
  type ObjectFileObject,
  type ObjectFileRead,
  type ObjectFileRefusalReason,
  type ObjectFileUploaderLimit,
  type PutObjectFile,
  type StoredObjectFile,
} from "../services/objectFiles";
export type { ObjectFileContentType } from "../db/schema";
