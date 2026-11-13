import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { showToast } from "../../components/toastBridge";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { artifactErrorCode } from "./artifactApi";
import { readsInOwnServer } from "./artifactOwnServer";
import { artifactSource } from "./artifactSource";
import type { ArtifactFileTarget } from "./artifactSource";

// Saving an Artifact's files on the person's device: one file (the viewer's
// Download, the Files panel's rows), or every file of a version in one zip
// (Download all, #proj-workspace:#239). The bytes come from Raft's own
// API at an address built from the id, the version and the path (never one
// a payload gives), through the API client (its auth and X-Server-Id).

/** Download: bytes from Raft's API, saved through a blob: URL that is revoked right after. */
export async function downloadArtifactFile(file: ArtifactFileTarget): Promise<void> {
  saveBlob(await artifactSource().readBytes(file), file.path.slice(file.path.lastIndexOf("/") + 1));
}

/**
 * Download All (Zip): every file of the version in one zip from Raft's API
 * (`artifactWebPaths.downloadZip`), saved as the server names it, from the
 * title and the version (`Title v3.zip`). Rejects with the server's refusal.
 */
export async function downloadArtifactZip(target: { id: ArtifactFileTarget["id"]; version: number; title: string }): Promise<void> {
  saveBlob(await artifactSource().readZip(target), artifactZipName(target.title, target.version));
}

/** The archive's file name, as the server's Content-Disposition writes it: the title's letters, digits, spaces, dots, dashes and underscores, then the version. */
export function artifactZipName(title: string, version: number): string {
  const safe = title.normalize("NFKD").replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return `${safe || "artifact"} v${version}.zip`;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  // Revoke once the browser has taken the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file that couldn't be downloaded (any refusal, offline): said in a toast, as a refused zip is. */
export function fileDownloadFailed(formatMessage: IntlShape["formatMessage"]): void {
  showToast({ title: formatMessage({ id: "artifacts.download.fileFailed" }), type: "error" });
}

/** What a refused Download All (Zip) says, by the server's code. */
function zipRefusal(code: string | null) {
  switch (code) {
    case "DOWNLOAD_TOO_LARGE": return "artifacts.download.zipTooLarge";
    case "BUSY":
    case "RATE_LIMITED": return "artifacts.download.zipBusy";
    default: return "artifacts.download.zipFailed";
  }
}

/**
 * Downloading the version shown (#proj-workspace:#239): with one file, that
 * file (⋯'s Download This Version); with more, every file in one zip (⋯'s
 * Download All (Zip), the Files panel's too), so an entry's images and pages
 * come with it, as `raft artifact pull` gives an agent. A refused zip says
 * why in a toast (too large: download the files one by one from Files).
 * `null` with no file at all, and for another server's reader: downloads are
 * the Artifact's own server's (readsInOwnServer), so none of them offers one.
 */
export function useArtifactDownload(data: ArtifactViewerData): { all: boolean; download: () => void } | null {
  const { formatMessage } = useIntl();
  const { id, version, title } = data.card;
  const entry = data.files.find((file) => file.entry) ?? data.files[0];
  const entryPath = entry?.path ?? null;
  const all = data.files.length > 1;
  const download = useCallback(() => {
    trackArtifactViewerAction("download");
    if (all) {
      void downloadArtifactZip({ id, version, title }).catch((error: unknown) => {
        showToast({ title: formatMessage({ id: zipRefusal(artifactErrorCode(error)) }), type: "error" });
      });
    } else if (entryPath) {
      void downloadArtifactFile({ id, version, path: entryPath }).catch(() => fileDownloadFailed(formatMessage));
    }
  }, [all, id, version, title, entryPath, formatMessage]);
  const offered = entryPath !== null && readsInOwnServer(data.card);
  return useMemo(() => (offered ? { all, download } : null), [offered, all, download]);
}
