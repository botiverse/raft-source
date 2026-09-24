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
