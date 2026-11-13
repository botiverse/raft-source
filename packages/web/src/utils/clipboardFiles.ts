type ClipboardFileItemLike = {
  kind?: string;
  getAsFile?: () => File | null;
};

type ClipboardFileSource = {
  items?: ArrayLike<ClipboardFileItemLike> | null;
  files?: ArrayLike<File> | null;
} | null | undefined;

function fileDedupeKey(file: File): string {
  // The same clipboard image can surface through both DataTransfer.items and
  // DataTransfer.files with different lastModified values. Treat matching
  // clipboard file metadata as one attachment to avoid double previews.
  return [file.name, file.size, file.type].join("::");
}

export function extractClipboardFiles(source: ClipboardFileSource): File[] {
  if (!source) return [];

  const files: File[] = [];
  const seen = new Set<string>();

  const pushFile = (file: File | null | undefined) => {
    if (!file) return;
    const key = fileDedupeKey(file);
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  const items = source.items ? Array.from(source.items) : [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    pushFile(item.getAsFile?.());
  }

  const fallbackFiles = source.files ? Array.from(source.files) : [];
  for (const file of fallbackFiles) {
    pushFile(file);
  }

  return files;
}

/** Above this a pasted file is passed through as-is rather than copied into memory. */
export const PASTED_FILE_MATERIALIZE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Copy a pasted file's bytes into memory, starting the read at paste time.
 *
 * A clipboard File can be backed by an OS file the browser loses access to
 * after the paste event (Chromium then fails the upload and the preview blob
 * URL with net::ERR_ACCESS_DENIED, and every retry fails the same way). An
 * in-memory copy keeps the bytes for the preview, the upload and its retries.
 * Resolves null when the file cannot be read even now.
 */
export async function materializePastedFile(file: File): Promise<File | null> {
  if (file.size > PASTED_FILE_MATERIALIZE_MAX_BYTES) return file;
  try {
    const bytes = await file.arrayBuffer();
    return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return null;
  }
}

/** Copy each pasted file into memory (materializePastedFile); `unreadable` when any could not be read. */
export async function materializePastedFiles(pasted: readonly File[]): Promise<{ files: File[]; unreadable: boolean }> {
  const copies = await Promise.all(pasted.map((file) => materializePastedFile(file)));
  const files = copies.filter((file): file is File => file !== null);
  return { files, unreadable: files.length < copies.length };
}

/** Can the file's bytes still be read? (A failed upload of an unreadable file looks like a network error.) */
export async function isFileReadable(file: Blob): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}
