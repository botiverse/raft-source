import type api from "../../src/api/client";
import { resetAttachmentUploadLimitForTests } from "../../src/utils/attachmentUploadLimit";

/**
 * The composer now refuses to attach anything until the server has told it the
 * single-file ceiling, so any test that picks a file must serve
 * `/attachments/upload-capabilities`. A stub that answers every GET with the
 * same member payload leaves the ceiling unknown and every attachment is
 * correctly rejected — which shows up as an unrelated-looking failure.
 *
 * Wrap the existing stub with this instead of teaching each test about the
 * capability route.
 */
export const TEST_UPLOAD_LIMIT_BYTES = 90 * 1024 * 1024;

export function withUploadCapability(
  inner: typeof api.get,
  maxBytes = TEST_UPLOAD_LIMIT_BYTES,
): typeof api.get {
  return (async (url: string, ...rest: unknown[]) => {
    if (url === "/attachments/upload-capabilities") {
      return {
        data: {
          directUploadEnabled: false,
          directUploadThresholdBytes: null,
          sessionExpiresInSeconds: null,
          maxBytes,
        },
      };
    }
    return (inner as (u: string, ...r: unknown[]) => unknown)(url, ...rest);
  }) as typeof api.get;
}

/** Drop the cached ceiling so each test resolves it again. */
export function resetUploadCapability(): void {
  resetAttachmentUploadLimitForTests();
}
