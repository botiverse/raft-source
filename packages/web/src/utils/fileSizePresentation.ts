import type { IntlShape } from "react-intl";

/** Localized byte size for UI metadata (workspace / attachment size rows). */
export function formatFileSizeBytes(
  bytes: number,
  formatMessage: IntlShape["formatMessage"],
): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return formatMessage({ id: "common.fileSize.zeroBytes" });
  }
  if (bytes < 1024) {
    return formatMessage({ id: "common.fileSize.bytes" }, { value: bytes });
  }
  if (bytes < 1024 * 1024) {
    return formatMessage(
      { id: "common.fileSize.kb" },
      { value: (bytes / 1024).toFixed(1) },
    );
  }
  if (bytes < 1024 * 1024 * 1024) {
    return formatMessage(
      { id: "common.fileSize.mb" },
      { value: (bytes / (1024 * 1024)).toFixed(1) },
    );
  }
  return formatMessage(
    { id: "common.fileSize.gb" },
    { value: (bytes / (1024 * 1024 * 1024)).toFixed(1) },
  );
}
