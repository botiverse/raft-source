// A first-party app's objects in the platform's one app-content bucket
// (storageService getAppObjectsBucket, APP_STORAGE_R2_*). Core builds each
// app's handle from its registration's id (apps/firstPartyApps.ts) and hands
// it over (FirstPartyApp.receiveObjectStorage); apps import only the types
// and errors, through platform/storage, never this factory
// (scripts/ci/check-app-module-boundaries.ts), so an app can't ask for
// another app's prefix.
//
// The boundary is here: an app names keys relative to its own prefix and the
// handle adds `apps/<id>/`. A key that could mean anything else (empty, a
// leading or trailing `/`, an empty segment, `.` or `..` anywhere, a
// backslash, a character outside `A-Z a-z 0-9 . _ ~ -`, or longer than S3
// allows with the prefix) is refused before any request, so no key reaches
// another app's objects or the bucket's root. The rule is shared
// (appObjectKeyProblem, @botiverse/raft-shared/src/appObjectKey): a reader
// that binds the bucket itself, such as Artifacts' content Worker, checks
// keys with the same function. The handle never exposes the bucket, its
// client or its credentials.
//
// Core's own object files (services/objectFiles.ts: the files of first-party
// objects, served by core) are in the same bucket under `objects/`, outside
// every app's `apps/<id>/`, through a handle of the same kind
// (objectFilesStorage) that only core holds.
import type { Readable } from "node:stream";
import { appObjectKeyProblem } from "@botiverse/raft-shared/src/appObjectKey";
import { getAppObjectsBucket, type S3BucketStorage } from "./storageService";

/** Every app's objects are under `apps/<id>/`. */
const APPS_PREFIX = "apps/";
/** Core's object files (services/objectFiles.ts), beside the apps' prefixes, never under one. */
const OBJECT_FILES_PREFIX = "objects/";
/** An app id as the registry accepts it (apps/firstPartyApps.ts checkRegistrations). */
const APP_ID = /^[a-z][a-z0-9-]*$/;

/** A key an app named that isn't one of its own (see the module comment). */
export class InvalidAppObjectKeyError extends Error {
  constructor(reason: string) {
    super(`invalid app object key: ${reason}`);
    this.name = "InvalidAppObjectKeyError";
  }
}

/** An operation on app object storage while the app-content bucket is not configured. */
export class AppObjectStorageUnavailableError extends Error {
  constructor() {
    super("the app-content bucket is not configured");
    this.name = "AppObjectStorageUnavailableError";
  }
}

/**
 * One app's objects. Keys are the app's own (`servers/…/blobs/…`), relative
 * to its prefix; the handle adds the prefix. Store them relative too: the
 * full key exists only inside this handle (and in a reader that binds the
 * bucket itself and adds the same fixed prefix, such as Artifacts' content
 * Worker).
 */
export interface AppObjectStorage {
  /** Whether the app-content bucket is configured; when it isn't, every operation rejects with AppObjectStorageUnavailableError. */
  readonly configured: boolean;
  /** Store `bytes` at `key`, replacing any object there. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** The object at `key`, or null when there is none (a missing bucket is still an error). */
  get(key: string, signal?: AbortSignal): Promise<Readable | null>;
  delete(key: string): Promise<void>;
  /** A presigned GET for `key`, answered with these headers. A bearer capability: never log it. */
  presignGet(key: string, options: { expiresInSeconds: number; responseContentType?: string; responseContentDisposition?: string }): Promise<string>;
}

function checkedKey(prefix: string, key: string): string {
  const problem = appObjectKeyProblem(prefix, key);
  if (problem !== null) throw new InvalidAppObjectKeyError(problem);
  return `${prefix}${key}`;
}

/**
 * The handle for app `appId`, on the bucket `bucketOf` resolves (the
 * platform's app-content bucket; resolved at each call, so configuration is
 * read on first use, not when core hands the handle over). Throws for an id
 * the registry would refuse.
 */
export function appObjectStorage(appId: string, bucketOf: () => S3BucketStorage | null = getAppObjectsBucket): AppObjectStorage {
  if (!APP_ID.test(appId)) throw new Error(`app object storage: ${JSON.stringify(appId)} is not an app id`);
  return prefixedObjectStorage(`${APPS_PREFIX}${appId}/`, bucketOf);
}

/**
 * Core's handle for object files (services/objectFiles.ts), under `objects/`
 * of the same bucket: the same key rule, outside every app's prefix. Never
 * handed to an app.
 */
export function objectFilesStorage(bucketOf: () => S3BucketStorage | null = getAppObjectsBucket): AppObjectStorage {
  return prefixedObjectStorage(OBJECT_FILES_PREFIX, bucketOf);
}

function prefixedObjectStorage(prefix: string, bucketOf: () => S3BucketStorage | null): AppObjectStorage {
  const bucket = (): S3BucketStorage => {
    const configured = bucketOf();
    if (!configured) throw new AppObjectStorageUnavailableError();
    return configured;
  };
  return Object.freeze({
    get configured() {
      return bucketOf() !== null;
    },
    async put(key: string, bytes: Buffer, contentType: string) {
      const full = checkedKey(prefix, key);
      await bucket().put(full, bytes, contentType);
    },
    async get(key: string, signal?: AbortSignal) {
      const full = checkedKey(prefix, key);
      try {
        return await bucket().get(full, signal);
      } catch (error) {
        // The object only: a wrong bucket (NoSuchBucket, also a 404) stays an error.
        if (error instanceof Error && error.name === "NoSuchKey") return null;
        throw error;
      }
    },
    async delete(key: string) {
      const full = checkedKey(prefix, key);
      await bucket().delete(full);
    },
    async presignGet(key: string, options: { expiresInSeconds: number; responseContentType?: string; responseContentDisposition?: string }) {
      const full = checkedKey(prefix, key);
      return bucket().getPresignedUrl(full, {
        expiresIn: options.expiresInSeconds,
        responseContentType: options.responseContentType,
        responseContentDisposition: options.responseContentDisposition,
      });
    },
  });
}
