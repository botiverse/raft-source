export function normalizeManagedMcpToolDescription(description: string): string {
  return description
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
