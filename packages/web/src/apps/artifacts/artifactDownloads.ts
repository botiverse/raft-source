import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { artifactDownloadFileName, artifactSafeFileName } from "@botiverse/raft-shared";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { useToast } from "@botiverse/raft-ui";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { artifactErrorCode } from "./artifactApi";
import { readsInOwnServer } from "./artifactOwnServer";
import { artifactSource } from "./artifactSource";
import type { ArtifactFileTarget } from "./artifactSource";
import { POLITE_ERROR } from "./artifactToasts";

// Saving an Artifact's files on the person's device: one file (the viewer's
// Download, the Files panel's rows), or every file of a version in one zip
// (Download all, #proj-workspace:#239). The bytes come from Raft's own
// API at an address built from the id, the version and the path (never one
// a payload gives), through the API client (its auth and X-Server-Id).
// Saved by the name the server's Content-Disposition gives the same file.

/** The version shown, as a download needs it: its id, number and title, and how many files it has. */
type ShownVersion = Pick<ArtifactViewerData, "card" | "files">;

/**
 * Download: the file at `path` of the version shown, saved as
 * artifactDownloadFileName names it (a version of one file by its title:
 * `周计划.html`; otherwise the file's own name).
 */
export async function downloadArtifactFile(data: ShownVersion, path: string): Promise<void> {
  const file: ArtifactFileTarget = { id: data.card.id, version: data.card.version, path };
  saveBlob(await artifactSource().readBytes(file), artifactFileDownloadName(data, path));
}

/** The name the file at `path` of the version shown is saved as: the server's Content-Disposition for it. */
export function artifactFileDownloadName(data: ShownVersion, path: string): string {
  return artifactDownloadFileName({ title: data.card.title, fileCount: data.files.length, path });
}

/**
 * Download All (Zip): every file of the version in one zip from Raft's API
 * (`artifactWebPaths.downloadZip`), saved as the server names it, from the
 * title and the version (`Title v3.zip`). Rejects with the server's refusal.
 */
export async function downloadArtifactZip(target: { id: ArtifactFileTarget["id"]; version: number; title: string }): Promise<void> {
  saveBlob(await artifactSource().readZip(target), artifactZipName(target.title, target.version));
}

/** The archive's file name, as the server's Content-Disposition writes it (artifactSafeFileName), then the version. */
export function artifactZipName(title: string, version: number): string {
  return `${artifactSafeFileName(title) || "artifact"} v${version}.zip`;
}

/**
 * How long a download's blob: URL is kept after its click. The mobile App's
 * Android web view reads the blob only after the click (Lagoon), so it must
 * outlive a slow read.
 */
const BLOB_URL_REVOKE_DELAY_MS = 60_000;

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  // Revoke once the download has been taken (BLOB_URL_REVOKE_DELAY_MS).
  window.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_DELAY_MS);
}

/** The toasts of the window the download was asked in (useToast: the nearest provider, an object window's own; #337 PR3). */
export type ArtifactToasts = ReturnType<typeof useToast>;

/** A file that couldn't be downloaded (any refusal, offline): said in a toast, as a refused zip is. */
export function fileDownloadFailed(formatMessage: IntlShape["formatMessage"], toast: ArtifactToasts): void {
  toast.error(formatMessage({ id: "artifacts.download.fileFailed" }), POLITE_ERROR);
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
  const toast = useToast();
  const { id, version, title } = data.card;
  const entry = data.files.find((file) => file.entry) ?? data.files[0];
  const entryPath = entry?.path ?? null;
  const all = data.files.length > 1;
  const download = useCallback(() => {
    trackArtifactViewerAction("download");
    if (all) {
      void downloadArtifactZip({ id, version, title }).catch((error: unknown) => {
        toast.error(formatMessage({ id: zipRefusal(artifactErrorCode(error)) }), POLITE_ERROR);
      });
    } else if (entryPath) {
      void downloadArtifactFile(data, entryPath).catch(() => fileDownloadFailed(formatMessage, toast));
    }
  }, [all, data, id, version, title, entryPath, formatMessage, toast]);
  const offered = entryPath !== null && readsInOwnServer(data.card);
  return useMemo(() => (offered ? { all, download } : null), [offered, all, download]);
}
