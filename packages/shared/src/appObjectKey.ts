// A first-party app's object key in the platform's app-content bucket: the
// key is the app's own, relative to its prefix `apps/<app id>/`, and whoever
// reads or writes adds that prefix. One rule for every side of the bucket:
// the server's app object storage (packages/server, appObjectStorage.ts
// `checkedKey`, the boundary apps write through) and any reader that binds
// the bucket itself and adds the same fixed prefix (Artifacts' content
// Worker, which reads the keys Raft hands it in a manifest).
//
// A key that could mean anything else is refused: empty, a leading or
// trailing `/`, an empty segment, `.` or `..` anywhere, a backslash, a
// character outside `A-Z a-z 0-9 . _ ~ -`, or longer than S3 allows with the
// prefix. So no key reaches another app's objects or the bucket's root.
// Cases both sides are tested on: testVectors/appObjectKeys.vectors.json.

/** S3's (and R2's) longest key, in UTF-8 bytes; keys here are ASCII. */
export const APP_OBJECT_KEY_MAX_BYTES = 1024;
/** One or more segments of unreserved URL characters, separated by single slashes. */
const KEY = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

/** Why `key` is not an app's own object key under `prefix` (`apps/<app id>/`), or null when it is one. */
export function appObjectKeyProblem(prefix: string, key: string): string | null {
  if (typeof key !== "string" || key.length === 0) return "empty";
  if (key.startsWith("/")) return "leading slash";
  if (key.includes("..")) return "contains ..";
  if (!KEY.test(key)) return "not slash-separated segments of A-Z a-z 0-9 . _ ~ -";
  if (key.split("/").includes(".")) return "a . segment";
  if (new TextEncoder().encode(`${prefix}${key}`).byteLength > APP_OBJECT_KEY_MAX_BYTES)
    return `longer than ${APP_OBJECT_KEY_MAX_BYTES} bytes with the app's prefix`;
  return null;
}
