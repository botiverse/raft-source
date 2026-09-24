import type { IntlShape } from "react-intl";

export type ChannelFileTypeFilter = "all" | "image" | "video" | "pdf" | "archive" | "other";

export interface ChannelFileLike {
  filename: string;
  mimeType: string;
}

const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z"]);

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

export function getChannelFileType(file: Pick<ChannelFileLike, "filename" | "mimeType">): Exclude<ChannelFileTypeFilter, "all"> {
  const mime = file.mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || extensionOf(file.filename) === ".pdf") return "pdf";
  if (
    mime.includes("zip") ||
    mime.includes("tar") ||
    mime.includes("rar") ||
    mime.includes("7z") ||
    ARCHIVE_EXTENSIONS.has(extensionOf(file.filename))
  ) {
    return "archive";
  }
  return "other";
}

const FILE_SIZE_MESSAGE_IDS = [
  "common.fileSize.bytes",
  "common.fileSize.kb",
  "common.fileSize.mb",
  "common.fileSize.gb",
] as const;

export function formatChannelFileSize(
  sizeBytes: number,
  formatMessage: IntlShape["formatMessage"],
): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return formatMessage({ id: "common.fileSize.zeroBytes" });
  }
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < FILE_SIZE_MESSAGE_IDS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return formatMessage({ id: FILE_SIZE_MESSAGE_IDS[unitIndex] }, { value: formatted });
}
