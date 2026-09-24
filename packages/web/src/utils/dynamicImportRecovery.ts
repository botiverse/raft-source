const DYNAMIC_IMPORT_FAILURE_PREFIX = "slock:dynamic-import-failure:";

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload (?:CSS )?for/i,
  /ChunkLoadError/i,
  /Loading chunk \S+ failed/i,
];

function textFromError(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, error.stack].filter(Boolean).join("\n");
  }
  return String(error);
}

function keySuffixForError(text: string): string {
  const url = text.match(/https?:\/\/[^\s"'<>)]*/)?.[0];
  if (url) return url;
  return text.replace(/\s+/g, " ").slice(0, 160);
}

export function dynamicImportFailureKey(error: unknown): string | null {
  const text = textFromError(error);
  if (!DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return `${DYNAMIC_IMPORT_FAILURE_PREFIX}${keySuffixForError(text)}`;
}

export function isDynamicImportFailure(error: unknown): boolean {
  return dynamicImportFailureKey(error) !== null;
}
