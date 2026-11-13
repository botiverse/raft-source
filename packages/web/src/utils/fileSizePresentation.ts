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

/**
 * A disk's size in decimal units (1 GB = 10^9 bytes), as macOS Finder, disk
 * vendors and `df -H` say it: a Mac's "245.11 GB" disk reads 245.1 GB here,
 * not the 228.3 its bytes make in 1024-based units. Disks only: memory and
 * file sizes keep `formatFileSizeBytes`.
 */
export function formatDiskSizeBytes(
  bytes: number,
  formatMessage: IntlShape["formatMessage"],
): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return formatMessage({ id: "common.fileSize.zeroBytes" });
  }
  if (bytes < 1000) {
    return formatMessage({ id: "common.fileSize.bytes" }, { value: bytes });
  }
  if (bytes < 1000 ** 2) {
    return formatMessage({ id: "common.fileSize.kb" }, { value: (bytes / 1000).toFixed(1) });
  }
  if (bytes < 1000 ** 3) {
    return formatMessage({ id: "common.fileSize.mb" }, { value: (bytes / 1000 ** 2).toFixed(1) });
  }
  return formatMessage({ id: "common.fileSize.gb" }, { value: (bytes / 1000 ** 3).toFixed(1) });
}
